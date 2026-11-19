import { createHash } from "node:crypto";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";

import { errorText } from "../_shared/errors.ts";

const isWriter = (agent: string | undefined): boolean => agent === undefined || /^task(?::|$)/.test(agent) || /^m\d+$/.test(agent);

type TaskItem = {
	readonly text: string;
	readonly name: string | undefined;
	readonly agent: string | undefined;
	readonly isolated: boolean | undefined;
};

const taskItemSchema = z
	.object({
		task: z
			.string()
			.refine((task) => task.trim() !== "")
			.optional(),
		steps: z
			.array(z.string())
			.min(1)
			.refine((steps) => steps.every((step) => step.trim() !== ""))
			.optional(),
		name: z.string().optional(),
		agent: z.string().optional(),
		isolated: z.boolean().optional(),
	})
	.passthrough()
	.refine((item) => (item.task === undefined) !== (item.steps === undefined))
	.transform(
		(item): TaskItem => ({
			text: item.steps?.join("\n") ?? item.task ?? "",
			name: item.name,
			agent: item.agent,
			isolated: item.isolated,
		}),
	);
const batchSchema = z.object({ tasks: z.array(taskItemSchema) }).passthrough();

const parseTaskItems = (input: unknown): readonly TaskItem[] | null => {
	const batch = batchSchema.safeParse(input);
	if (batch.success) return batch.data.tasks;
	const flat = taskItemSchema.safeParse(input);
	return flat.success ? [flat.data] : null;
};

const taskDetailsSchema = z.object({ progress: z.array(z.object({ index: z.number(), id: z.string() }).passthrough()) }).passthrough();

const spawnProgress = (details: unknown): readonly { readonly index: number; readonly id: string }[] => {
	const parsed = taskDetailsSchema.safeParse(details);
	return parsed.success ? parsed.data.progress : [];
};

const promptHash = (item: TaskItem): string => createHash("sha256").update(item.text).digest("hex");

const itemLabel = (item: TaskItem, index: number): string => `\`${item.name ?? `item ${index + 1}`}\``;

const renderReminder = (unreminded: readonly string[], sameMessageIds: readonly string[], runningIds: readonly string[]): string => {
	const agents = [
		...sameMessageIds.map((id) => `\`${id}\` (dispatched in this message)`),
		...runningIds.map((id) => `\`${id}\` (already running)`),
		...unreminded,
	];
	return [
		`Not dispatched — a reminder, not a rule. This call would leave write-capable agents sharing this working directory without isolation: ${agents.join(", ")}. Agents sharing a checkout can overwrite each other's work.`,
		"Re-dispatch the writers with `isolated: true`. For an item that only researches, set `isolated: false` to keep it shared.",
		"Each prompt is reminded once: re-dispatching these same prompts unchanged runs them as written.",
	].join("\n");
};

type SessionState = {
	readonly sharedAgentIds: Set<string>;
	readonly sameMessageShared: string[];
	readonly pending: Map<string, ReadonlySet<number>>;
	readonly remindedPrompts: Set<string>;
};

export default function isolationNudge(pi: ExtensionAPI): void {
	const sessions = new Map<string, SessionState>();

	const stateOf = (ctx: ExtensionContext): SessionState => {
		const key = ctx.sessionManager.getSessionFile() ?? ctx.cwd;
		const existing = sessions.get(key);
		if (existing !== undefined) return existing;
		const fresh: SessionState = {
			sharedAgentIds: new Set(),
			sameMessageShared: [],
			pending: new Map(),
			remindedPrompts: new Set(),
		};
		sessions.set(key, fresh);
		return fresh;
	};

	const runningSharedIds = (ctx: ExtensionContext, sharedAgentIds: Set<string>): string[] => {
		const running = new Set((ctx.getAsyncJobSnapshot()?.running ?? []).filter((job) => job.type === "task").map((job) => job.id));
		for (const id of sharedAgentIds) if (!running.has(id)) sharedAgentIds.delete(id);
		return [...sharedAgentIds];
	};

	const isolationAvailable = (): boolean =>
		pi.getAllTools().some((tool) => tool.name === "task" && tool.description.includes("`isolated`"));

	const onTaskCall = (toolCallId: string, input: unknown, ctx: ExtensionContext): string | null => {
		const items = parseTaskItems(input);
		if (items === null) return null;
		const state = stateOf(ctx);

		const shared = new Set<number>();
		const unreminded: { readonly label: string; readonly hash: string }[] = [];
		items.forEach((item, index) => {
			if (item.isolated === true || !isWriter(item.agent)) return;
			shared.add(index);
			if (item.isolated !== undefined) return;
			const hash = promptHash(item);
			if (!state.remindedPrompts.has(hash)) unreminded.push({ label: itemLabel(item, index), hash });
		});
		if (shared.size === 0) return null;

		const sameMessageIds = state.sameMessageShared;
		const runningIds = runningSharedIds(ctx, state.sharedAgentIds);
		if (shared.size + sameMessageIds.length + runningIds.length >= 2 && unreminded.length > 0 && isolationAvailable()) {
			for (const { hash } of unreminded) state.remindedPrompts.add(hash);
			const labels = unreminded.map(({ label }) => label);
			pi.logger.info("isolation-nudge reminder: blocked shared-checkout dispatch", {
				unreminded: labels,
				sameMessageSharedWriters: sameMessageIds,
				runningSharedWriters: runningIds,
			});
			return renderReminder(labels, sameMessageIds, runningIds);
		}
		for (const index of shared) state.sameMessageShared.push(itemLabel(items[index]!, index));
		state.pending.set(toolCallId, shared);
		return null;
	};

	pi.on("assistant_message", (_event, ctx) => {
		try {
			stateOf(ctx).sameMessageShared.length = 0;
		} catch (error) {
			pi.logger.warn("isolation-nudge could not reset same-message writers", { error: errorText(error) });
		}
	});

	// A throwing tool_call handler blocks the tool, so every failure degrades to
	// "no reminder" and the spawn runs exactly as the model wrote it.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "task") return;
		try {
			const reason = onTaskCall(event.toolCallId, event.input, ctx);
			return reason === null ? undefined : { block: true, reason };
		} catch (error) {
			pi.logger.warn("isolation-nudge skipped a task call", { error: errorText(error) });
			return undefined;
		}
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "task") return;
		try {
			const state = stateOf(ctx);
			const shared = state.pending.get(event.toolCallId);
			if (shared === undefined) return;
			state.pending.delete(event.toolCallId);
			if (event.isError) return;
			for (const spawn of spawnProgress(event.details)) {
				if (shared.has(spawn.index)) state.sharedAgentIds.add(spawn.id);
			}
		} catch (error) {
			pi.logger.warn("isolation-nudge could not record a task result", { error: errorText(error) });
		}
	});
}
