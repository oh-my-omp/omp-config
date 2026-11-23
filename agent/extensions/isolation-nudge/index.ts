import { createHash } from "node:crypto";
import {
	type AgentProgress,
	type ExtensionAPI,
	type ExtensionContext,
	type TaskItem,
	type TaskParams,
	z,
	type zod,
} from "@oh-my-pi/pi-coding-agent";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { READ_ONLY_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/task/read-only-policy";

import { errorText } from "../_shared/errors.ts";
import { defineStatelessNoiseGuard, registerCompactHandoff } from "../_shared/omomp-shared/compact-handoff.ts";

const taskItemShape = {
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
} satisfies { [K in keyof TaskItem]?: zod.ZodLikeSchema<TaskItem[K]> };
const taskItemSchema: zod.ZodLikeSchema<TaskItem> = z
	.object(taskItemShape)
	.refine((item) => (item.task === undefined) !== (item.steps === undefined));
const batchShape = { tasks: z.array(taskItemSchema) } satisfies { [K in keyof TaskParams]?: zod.ZodLikeSchema<TaskParams[K]> };
const batchSchema: zod.ZodLikeSchema<Required<Pick<TaskParams, "tasks">>> = z.object(batchShape);

const parseTaskItems = (input: unknown): readonly TaskItem[] | null => {
	const batch = batchSchema.safeParse(input);
	if (batch.success) return batch.data.tasks;
	const flat = taskItemSchema.safeParse(input);
	return flat.success ? [flat.data] : null;
};

type SpawnRecord = Pick<AgentProgress, "index" | "id">;

const spawnShape = { index: z.number(), id: z.string() } satisfies { [K in keyof SpawnRecord]: zod.ZodLikeSchema<SpawnRecord[K]> };
const taskDetailsSchema: zod.ZodLikeSchema<{ readonly progress: readonly SpawnRecord[] }> = z.object({
	progress: z.array(z.object(spawnShape)),
});

const spawnProgress = (details: unknown): readonly SpawnRecord[] => {
	const parsed = taskDetailsSchema.safeParse(details);
	return parsed.success ? parsed.data.progress : [];
};

const isolatedProperty = z.object({ properties: z.object({ isolated: z.object({}) }) });
const isolatedParameterShapes = [isolatedProperty, z.object({ properties: z.object({ tasks: z.object({ items: isolatedProperty }) }) })];

const quoted = (label: string): string => `\`${label}\``;

type Writer = { readonly index: number; readonly label: string; readonly item: TaskItem };

type InFlightCall = { readonly writerIndices: ReadonlySet<number>; readonly labels: readonly string[] };

type SessionState = {
	readonly inFlight: Map<string, InFlightCall>;
	readonly sharedAgentIds: Set<string>;
	readonly remindedPrompts: Set<string>;
};

const freshState = (): SessionState => ({ inFlight: new Map(), sharedAgentIds: new Set(), remindedPrompts: new Set() });

const renderReminder = (unreminded: readonly string[], inFlight: readonly string[], running: readonly string[]): string => {
	const agents = [
		...inFlight.map((label) => `${quoted(label)} (dispatched earlier in this message)`),
		...running.map((id) => `${quoted(id)} (already running)`),
		...unreminded.map(quoted),
	];
	return [
		`Not dispatched — a reminder, not a rule. This call would leave write-capable agents sharing this working directory without isolation: ${agents.join(", ")}. Agents sharing a checkout can overwrite each other's work.`,
		"Re-dispatch the writers with `isolated: true`. For an item that only researches, set `isolated: false` to keep it shared.",
		"Each prompt is reminded once: re-dispatching these same prompts unchanged runs them as written.",
	].join("\n");
};

export default function isolationNudge(pi: ExtensionAPI): void {
	let state = freshState();
	registerCompactHandoff(
		pi,
		defineStatelessNoiseGuard({
			pluginId: "omp-config/isolation-nudge",
			renderNoiseGuardDirective: () =>
				"Single-call `Not dispatched — a reminder, not a rule.` isolation nudges from `isolation-nudge` are ephemeral dispatch reminders — NEVER include them as user constraints or blockers in the summary.",
		}),
	);

	const taskOffersIsolation = (): boolean =>
		pi.getAllTools().some(({ name, parameters }) => {
			if (name !== "task") return false;
			const schema = typeof parameters === "function" ? parameters.toJsonSchema() : parameters;
			return isolatedParameterShapes.some((shape) => shape.safeParse(schema).success);
		});

	const sharedWriters = async (items: readonly TaskItem[], cwd: string): Promise<readonly Writer[]> => {
		if (items.every((item) => item.isolated === true)) return [];
		const { agents } = await discoverAgents(cwd);
		return items.flatMap((item, index) => {
			const name = item.agent?.trim();
			const tools = name ? getAgent(agents, name)?.tools : undefined;
			const readOnly = tools?.every((tool) => READ_ONLY_TOOL_NAMES.has(tool)) === true;
			return item.isolated === true || readOnly ? [] : [{ index, label: item.name ?? `${name || "task"} #${index + 1}`, item }];
		});
	};

	const pruneFinishedAgents = (ctx: ExtensionContext): readonly string[] => {
		const running = new Set((ctx.getAsyncJobSnapshot()?.running ?? []).filter((job) => job.type === "task").map((job) => job.id));
		for (const id of state.sharedAgentIds) if (!running.has(id)) state.sharedAgentIds.delete(id);
		return [...state.sharedAgentIds];
	};

	const onTaskCall = async (toolCallId: string, input: unknown, ctx: ExtensionContext): Promise<string | null> => {
		const items = parseTaskItems(input);
		if (items === null || !taskOffersIsolation()) return null;
		const writers = await sharedWriters(items, ctx.cwd);
		if (writers.length === 0) return null;

		const unreminded = writers
			.filter(({ item }) => item.isolated === undefined)
			.map(({ label, item }) => ({
				label,
				hash: createHash("sha256")
					.update(item.steps?.join("\n") ?? item.task ?? "")
					.digest("hex"),
			}))
			.filter(({ hash }) => !state.remindedPrompts.has(hash));
		const inFlight = [...state.inFlight.values()].flatMap((call) => call.labels);
		const running = pruneFinishedAgents(ctx);
		if (unreminded.length > 0 && writers.length + inFlight.length + running.length >= 2) {
			for (const { hash } of unreminded) state.remindedPrompts.add(hash);
			const labels = unreminded.map(({ label }) => label);
			pi.logger.info("isolation-nudge reminder: blocked shared-checkout dispatch", {
				unreminded: labels,
				inFlightSharedWriters: inFlight,
				runningSharedWriters: running,
			});
			return renderReminder(labels, inFlight, running);
		}
		state.inFlight.set(toolCallId, {
			writerIndices: new Set(writers.map(({ index }) => index)),
			labels: writers.map(({ label }) => label),
		});
		return null;
	};

	pi.on("session_start", () => {
		state = freshState();
	});
	pi.on("session_switch", () => {
		state = freshState();
	});
	pi.on("turn_start", () => {
		state.inFlight.clear();
	});

	// A throwing tool_call handler blocks the tool, so every failure degrades to
	// "no reminder" and the spawn runs exactly as the model wrote it.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "task") return;
		try {
			const reason = await onTaskCall(event.toolCallId, event.input, ctx);
			return reason === null ? undefined : { block: true, reason };
		} catch (error) {
			pi.logger.warn("isolation-nudge skipped a task call", { error: errorText(error) });
			return undefined;
		}
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "task") return;
		try {
			const call = state.inFlight.get(event.toolCallId);
			if (call === undefined) return;
			state.inFlight.delete(event.toolCallId);
			if (event.isError) return;
			for (const spawn of spawnProgress(event.details)) {
				if (call.writerIndices.has(spawn.index)) state.sharedAgentIds.add(spawn.id);
			}
		} catch (error) {
			pi.logger.warn("isolation-nudge could not record a task result", { error: errorText(error) });
		}
	});
}
