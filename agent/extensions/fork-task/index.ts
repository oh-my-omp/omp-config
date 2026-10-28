// ============================================================================
// fork_task — native `task` subagents that start from a copy of the caller's
// conversation, or of another agent's named by an item's `from`.
//
// Registers fork_task plus before_subagent_spawn and session_shutdown hooks in
// main and sub sessions. Reads the source agent's persisted session and the
// `fork-task` section of `omomp.yml` (project `.omp/` first, then the agent
// dir; re-read per call); writes temporary JSONL under the OS temp directory
// and moves it into the caller's artifact store.
// Staging failures and over-cap sources are tool errors; spawn preparation
// failures block the child and warn, while shutdown cleanup failures warn
// without rejecting the hook.
//
// The spawn itself is the built-in `task` tool, called with the same batch
// shape, so each child is an ordinary task subagent: its own agent definition
// (system prompt, model binding, tools), Agent Hub row, `agent://`/`history://`,
// idle/park/revive lifecycle, isolation and its merge-back. Only the child's
// starting transcript differs:
//
//   1. At call time the source's persisted conversation (the caller's, or the
//      registered agent `from` names, resolved like `history://<id>`) is forked
//      into a staging JSONL (inherited cost zeroed, a dangling in-flight tool call
//      paired with a synthetic aborted result, the source's todo list cleared),
//      followed by a fork notice. `shake: true` then runs the same
//      `session.shake("elide")` that `/shake` runs, writing its recovery
//      artifact into the parent's artifact store — the store the whole agent
//      tree shares and the child adopts.
//   2. Source runtime state is removed so the executor, not the copy, decides
//      the child's contract: `session_init` (a copied init makes the persisted
//      roster treat the file as another live generation and fails the spawn),
//      model / thinking / service-tier changes, and the shake helper's own
//      bookkeeping. Removed entries' children are re-parented.
//   3. The header cwd is the parent's (the caller's) cwd for shared children,
//      whatever the source's cwd was (revival reopens the file by path and reads
//      its cwd from there); isolated children get a blank cwd so
//      `SessionManager.open` binds them to the worktree.
//   4. `before_subagent_spawn` fires after the task tool pre-allocates the
//      child id (async dispatch) and before the executor opens
//      `<artifactsDir>/<id>.jsonl`; the staging file is moved there so the
//      executor opens the fork instead of an empty session. Each item gets a
//      unique name, so the allocated id is predictable and matched exactly.
//
//   5. Before anything is staged, every item without `shake: true` measures
//      its source's context with OMP's own measure (a live session's
//      `getContextUsage()`, the same provider-anchored count compaction uses;
//      for a parked source, the newest assistant `contextSnapshot.promptTokens`
//      of its active branch plus the tokenizer count of later messages). Any
//      source over `maxInheritedTokens` (default 120000), or one that cannot
//      be measured, rejects the whole call: each child's first request writes
//      its whole inherited context to the provider cache at full price,
//      because the child's own tools and system prompt come before the copied
//      messages, so siblings share no more than the fixed prefix before the
//      fork point. `shake: true` items are exempt; shake stays opt-in.
//
// Relies on omp internals (AgentRegistry, the executor's session-file path and
// hook ordering, session entry types); re-verify after every omp upgrade.
// ============================================================================
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	type AgentSession,
	createAgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
	type TaskItem,
	z,
} from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { defineOmompSection, loadOmompSection } from "../_shared/omomp.ts";

/** Used when no `omomp.*` copy holds a valid `fork-task` section: the bound is a cost guard, not an optional lane. */
const DEFAULT_MAX_INHERITED_TOKENS = 120_000;

const configSchema = z.object({
	maxInheritedTokens: z.number().refine((value) => Number.isInteger(value) && value > 0, "must be a positive integer"),
});
const omompSection = defineOmompSection(import.meta.dir, configSchema);

const itemSchema = z.object({
	from: z.string().optional(),
	name: z.string().optional(),
	agent: z.string().optional(),
	task: z.string(),
	isolated: z.boolean().optional(),
	shake: z.boolean().optional(),
	effort: z.enum(["lo", "med", "hi"]).optional(),
	tools: z.array(z.string()).optional(),
	outputSchema: z.unknown().optional(),
	schemaMode: z.enum(["permissive", "strict"]).optional(),
});

const paramsSchema = z.object({
	context: z.string(),
	tasks: z.array(itemSchema).min(1),
});

const progressSchema = z.object({ progress: z.array(z.object({ index: z.number(), id: z.string() }).passthrough()) }).passthrough();

const sessionHeaderSchema = z
	.object({ type: z.literal("session"), cwd: z.string(), additionalDirectories: z.array(z.string()).optional() })
	.passthrough();

const sessionEntrySchema = z
	.object({
		type: z.string(),
		id: z.string(),
		parentId: z.string().nullable().optional(),
		customType: z.string().optional(),
		firstKeptEntryId: z.string().optional(),
	})
	.passthrough();
type SessionEntryRecord = z.infer<typeof sessionEntrySchema>;

/** Parent runtime state that must not seed the child's own contract. */
const RUNTIME_STATE_TYPES: Record<string, true> = {
	session_init: true,
	model_change: true,
	thinking_level_change: true,
	service_tier_change: true,
};

const SESSION_EXIT_CUSTOM_TYPE = "session_exit";

const DESCRIPTION = `Spawn subagents exactly like \`task\` — same batch shape, agent types, models, lifecycle, result delivery, \`write agent://\` follow-up, \`agent://\`/\`history://\` — except each child starts with a copy of THIS conversation up to this call (or, with \`from\`, of another agent's conversation), followed by its assignment.

Prefer it over \`task\` for complex work: multi-step implementation, debugging, or design follow-through whose assignment depends on what this conversation already established (requirements, decisions, findings, file contents read so far), where restating that in \`context\`/\`task\` would be long or lossy. Use \`task\` when independence matters — second opinions, reviews, acceptance verifiers — or the needed background is short. A forked child inherits this conversation's reasoning and anchors on it; a fresh \`task\` child does not, so hand it the code, artifacts, and question, not the conclusion.

Recommended per item: keep \`isolated\` at its default \`true\` and pass \`shake: true\`.
- \`isolated\` (default true): the child works in its own workspace and returns a patch; like any isolated task child it is not resumable afterwards. Pass \`isolated: false\` only for research-only children you want to keep messaging after they finish. In plan mode every child shares this workspace, whatever \`isolated\` says.
- \`shake: true\` runs \`/shake\` on the inherited copy before the child starts, cutting its starting context.
- \`effort\`: omit unless the user explicitly asks; the agent's configured binding decides model and effort.
- The child runs its own agent's system prompt and model; it sees the conversation as background and its own assignment as the task. It does not inherit this session's todo list.
- Verification is mandatory for forked workers: the fork notice explicitly requires scoped build/lint/test and real runtime checks before handoff, overriding ordinary task's no-verification default. The parent still owns final acceptance and may verify itself or assign an independent verifier.
- Each item's \`name\` gets a short unique suffix; address the child by the id reported in the result.
- \`from\`: an agent id as in \`agent://<id>\` (running, idle or parked) whose conversation the child copies instead of this one; omit it to fork this conversation. An item with \`from\` MUST set \`agent\`; the child does not inherit the source's agent type or model, and a call with an item missing it is rejected whole. The child is still this session's child: its result, follow-up, and patch come back here, and its workspace derives from this session's checkout, not the source's, so edits the source made in an isolated workspace of its own are not in it unless already merged here. A running source is copied as persisted so far.

\`context\` and each item's \`task\` follow the same rules as \`task\`. The conversation copy is background, so the assignment is a directive — what to do, what is in and out, what siblings handle — not a restatement of it, and still states the target, change, and acceptance.

Cost: each child's first request writes its whole inherited conversation to the provider cache at full price, because the child's own tools and system prompt come before the copied messages. Siblings of one batch share no more than the fixed prefix before the fork point, so a batch of N children over a T-token conversation costs about N × T cache-write tokens; do not fork for batches of similar, independent judgments — use \`task\` with a brief. An item without \`shake: true\` whose source context (OMP's context-usage count, system prompt and tools included) exceeds the configured cap (\`maxInheritedTokens\`, default 120000) rejects the whole call before anything is dispatched; use \`task\` with a self-contained brief, or retry that item with \`shake: true\`.`;

/**
 * Where the forked transcript comes from. `caller` is the session calling
 * fork_task; `agent` is another registered agent named by `from`, whose
 * workspace (`cwd`, unknown when neither its live session nor its header
 * records one) may differ from the parent's.
 */
type ForkSource =
	| { readonly kind: "caller"; readonly file: string; readonly cwd: string }
	| {
			readonly kind: "agent";
			readonly id: string;
			readonly file: string;
			readonly cwd: string | undefined;
			/** Live session of a running or idle agent; null when parked. */
			readonly session: AgentSession | null;
	  };

/** A source's context size in OMP's context-usage measure, or why it has none. */
type SourceSize = { readonly kind: "measured"; readonly tokens: number } | { readonly kind: "unmeasured"; readonly reason: string };

function workspaceNotice(source: ForkSource, parentCwd: string, isolated: boolean): string[] {
	switch (source.kind) {
		case "caller":
			return [
				isolated
					? `- You run in an isolated copy of the workspace. Paths under \`${parentCwd}\` in the conversation name the parent's checkout: use the same repository-relative paths inside your own working directory, and NEVER read or write under \`${parentCwd}\`.`
					: "- You share the parent's working directory; files may change between your reads.",
			];
		case "agent": {
			const id = `\`${source.id}\``;
			const foreign = [...new Set([source.cwd, isolated ? parentCwd : undefined])].filter((p): p is string => p !== undefined);
			const lines = [
				isolated
					? "- You run in an isolated copy of the parent's workspace."
					: `- You share the parent's working directory \`${parentCwd}\`; files may change between your reads.`,
				`- Your workspace derives from the parent's checkout, not from ${id}'s: changes ${id} made in a workspace of its own are not in yours unless they reached the parent's checkout before this fork.`,
			];
			const named = foreign.filter((p) => isolated || p !== parentCwd);
			if (named.length > 0) {
				const list = named.map((p) => `\`${p}\``).join(" and ");
				lines.push(
					`- Paths under ${list} in the conversation name checkouts other than yours: use the same repository-relative paths inside your own working directory, and NEVER read or write under ${list}.`,
				);
			}
			if (source.cwd === undefined) {
				lines.push(
					`- Other absolute paths in the conversation may name ${id}'s workspace: map them to repository-relative paths in yours.`,
				);
			}
			return lines;
		}
		default: {
			const unreachable: never = source;
			return unreachable;
		}
	}
}

const forkNotice = (source: ForkSource, parentCwd: string, isolated: boolean): string => {
	const origin =
		source.kind === "caller"
			? "Above: the conversation of the parent agent that spawned you, copied as background."
			: `Above: the conversation of agent \`${source.id}\`, copied as background. \`${source.id}\` is not your parent: the agent that spawned you receives your result.`;
	const owner = source.kind === "caller" ? "the parent" : `\`${source.id}\``;
	return [
		`<system-notice cause="fork_task">`,
		`${origin} It ran under its own role, tools, and rules; yours are the ones in your system prompt.`,
		"- Use it only for the facts, decisions, and constraints it established.",
		`- Your job is the assignment that follows this notice, nothing else. NEVER continue, resume, or complete other work from the conversation; its todo lists and plans belong to ${owner}.`,
		"- Verification is explicitly required for this fork_task assignment: run the relevant scoped build, lint, tests, and real runtime smoke path before handoff. This overrides ordinary task's default to leave verification to the parent. Observe the changed behavior and report commands, outputs, and limitations; do not claim completion while required runtime verification is missing. Read-only roles remain read-only: report evidence from their permitted inspection instead of running execution tools.",
		source.kind === "caller"
			? "- The parent keeps working concurrently."
			: `- The parent and \`${source.id}\` may keep working concurrently.`,
		...workspaceNotice(source, parentCwd, isolated),
		"</system-notice>",
	].join("\n");
};

type PendingFork = {
	/** Exact requested name; the allocated id's last dot-segment. */
	readonly name: string;
	readonly artifactsDir: string;
	readonly staging: string;
};

type StagedFork = {
	readonly staging: string;
	readonly shakeSummary?: string;
};

const STAGING_ROOT = path.join(os.tmpdir(), "omp-fork-task");

/** Mirrors the task tool's `sanitizeAgentId`, so the requested name is the allocated id. */
function sanitizeName(value: string | undefined): string | undefined {
	const sanitized = value
		?.trim()
		.replace(/[^A-Za-z0-9_-]+/g, "")
		.slice(0, 40);
	return sanitized || undefined;
}

function findCallerSession(ctx: ExtensionContext): AgentSession | undefined {
	const file = ctx.sessionManager.getSessionFile();
	for (const ref of AgentRegistry.global().list()) {
		const session = ref.session;
		if (!session) continue;
		if (session.sessionManager === ctx.sessionManager) return session;
		if (file && session.sessionManager.getSessionFile() === file) return session;
	}
	return undefined;
}

/**
 * Rewrite the staged JSONL: drop parent runtime state and the shake helper's
 * bookkeeping, re-parent what depended on dropped entries, and set the header
 * cwd the child must bind to.
 */
async function finalizeStaging(file: string, options: { cwd: string; isolated: boolean; preShakeIds: ReadonlySet<string> }): Promise<void> {
	const lines = (await fs.readFile(file, "utf8")).split("\n").filter((line) => line.length > 0);
	const records = lines.map<unknown>((line) => JSON.parse(line));

	const dropped = new Map<string, string | null>();
	const entries: Array<SessionEntryRecord | undefined> = records.map((record) => {
		const parsed = sessionEntrySchema.safeParse(record);
		return parsed.success ? parsed.data : undefined;
	});
	for (const entry of entries) {
		if (!entry) continue;
		const addedByShake = !options.preShakeIds.has(entry.id);
		const drop =
			RUNTIME_STATE_TYPES[entry.type] === true ||
			(addedByShake && entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		if (drop) dropped.set(entry.id, entry.parentId ?? null);
	}
	const survivingParent = (id: string | null): string | null => {
		let current = id;
		while (current !== null && dropped.has(current)) current = dropped.get(current) ?? null;
		return current;
	};
	// `firstKeptEntryId` may name a dropped entry: move it to the next surviving entry.
	const nextSurviving = new Map<string, string>();
	let pendingDropped: string[] = [];
	for (const entry of entries) {
		if (!entry) continue;
		if (dropped.has(entry.id)) {
			pendingDropped.push(entry.id);
			continue;
		}
		for (const id of pendingDropped) nextSurviving.set(id, entry.id);
		pendingDropped = [];
	}

	let headerSeen = false;
	const output: string[] = [];
	for (const [index, record] of records.entries()) {
		const header = headerSeen ? undefined : sessionHeaderSchema.safeParse(record);
		if (header?.success) {
			headerSeen = true;
			const next = { ...header.data, cwd: options.isolated ? "" : options.cwd };
			if (options.isolated) delete next.additionalDirectories;
			output.push(JSON.stringify(next));
			continue;
		}
		const entry = entries[index];
		if (!entry) {
			output.push(lines[index]!);
			continue;
		}
		if (dropped.has(entry.id)) continue;
		const next: SessionEntryRecord = { ...entry };
		if (next.parentId && dropped.has(next.parentId)) next.parentId = survivingParent(next.parentId);
		if (next.firstKeptEntryId && dropped.has(next.firstKeptEntryId)) {
			const replacement = nextSurviving.get(next.firstKeptEntryId);
			if (replacement) next.firstKeptEntryId = replacement;
		}
		output.push(JSON.stringify(next));
	}
	if (!headerSeen) throw new Error(`fork_task: ${file} has no session header`);
	await fs.writeFile(file, `${output.join("\n")}\n`);
}

async function moveFile(from: string, to: string): Promise<void> {
	try {
		await fs.rename(from, to);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
		await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
		await fs.rm(from, { force: true });
	}
}

async function stageFork(
	ctx: ExtensionContext,
	parent: AgentSession,
	source: ForkSource,
	shake: boolean,
	isolated: boolean,
): Promise<StagedFork> {
	const parentCwd = parent.sessionManager.getCwd();
	const stagingDir = path.join(STAGING_ROOT, randomUUID());
	const staging = path.join(stagingDir, "fork.jsonl");
	await fs.mkdir(stagingDir, { recursive: true });
	try {
		const manager = await SessionManager.forkFrom(source.file, parentCwd, stagingDir, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			sessionFile: staging,
			resetInheritedCost: true,
			repairInterruptedTail: true,
		});
		let shakeSummary: string | undefined;
		let preShakeIds: ReadonlySet<string>;
		try {
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
			manager.appendMessage({
				role: "developer",
				content: forkNotice(source, parentCwd, isolated),
				attribution: "agent",
				timestamp: Date.now(),
			});
			await manager.flush();
			preShakeIds = new Set(manager.getEntries().map((entry) => entry.id));
			if (shake) {
				// Recovery artifacts go to the store the child will adopt, so the
				// `artifact://` ids written into the transcript resolve for it.
				const parentArtifacts = parent.sessionManager.getArtifactManager();
				if (parentArtifacts) manager.adoptArtifactManager(parentArtifacts);
				const { session: shaker } = await createAgentSession({
					cwd: parentCwd,
					sessionManager: manager,
					model: parent.model ?? ctx.model,
					modelRegistry: ctx.modelRegistry,
					toolNames: [],
					restrictToolNames: true,
					enableMCP: false,
					enableLsp: false,
					disableExtensionDiscovery: true,
					systemPrompt: [],
					hasUI: false,
					// A main-kind session's dispose tears down the global
					// AgentLifecycleManager; keep the helper out of the shared registry.
					taskDepth: 1,
					agentRegistry: new AgentRegistry(),
					agentId: `fork-shake-${path.basename(stagingDir)}`,
				});
				try {
					const result = await shaker.shake("elide");
					shakeSummary = `shake freed ~${result.tokensFreed} tokens (${result.toolResultsDropped} tool results, ${result.blocksDropped} blocks)`;
				} finally {
					await shaker.dispose();
				}
			}
		} finally {
			await manager.close();
		}
		await finalizeStaging(staging, { cwd: parentCwd, isolated, preShakeIds });
		return { staging, shakeSummary };
	} catch (error) {
		await fs.rm(stagingDir, { recursive: true, force: true });
		throw error;
	}
}

type SourceResolution = { readonly kind: "error"; readonly message: string } | ForkSource;

/** Session-header cwd of a transcript file, when it records a non-empty one. */
async function headerCwd(file: string): Promise<string | undefined> {
	for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
		if (line.length === 0) continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			// A malformed line is skipped, as the session loader does.
			continue;
		}
		const header = sessionHeaderSchema.safeParse(record);
		if (header.success) return header.data.cwd || undefined;
	}
	return undefined;
}

/**
 * Resolve `from` to the transcript to fork: omitted (or naming the caller)
 * forks the caller; otherwise a registered non-advisor agent, matched like
 * `history://<id>` (exact, then case-insensitive) after the caller root's
 * persisted roster is loaded, so parked agents of a resumed session resolve.
 */
async function resolveSource(from: string | undefined, parent: AgentSession, parentFile: string): Promise<SourceResolution> {
	const caller: ForkSource = { kind: "caller", file: parentFile, cwd: parent.sessionManager.getCwd() };
	const requested = from?.trim();
	if (!requested) return caller;
	const registry = AgentRegistry.global();
	await ensurePersistedRoster(registry, parentFile);
	let ref = registry.get(requested);
	if (ref?.kind === "advisor") ref = undefined;
	const lower = requested.toLowerCase();
	ref ??= registry.list().find((candidate) => candidate.kind !== "advisor" && candidate.id.toLowerCase() === lower);
	if (!ref) return { kind: "error", message: `no agent \`${requested}\` is registered; \`from\` takes an id as in \`agent://<id>\`.` };
	if (ref.session === parent || ref.sessionFile === parentFile) return caller;
	if (ref.session) {
		await ref.session.sessionManager.ensureOnDisk();
		await ref.session.sessionManager.flush();
	}
	const file = ref.session?.sessionManager.getSessionFile() ?? ref.sessionFile;
	if (!file) return { kind: "error", message: `agent \`${ref.id}\` has no persisted transcript to fork.` };
	const cwd = ref.session?.sessionManager.getCwd() ?? (await headerCwd(file));
	return { kind: "agent", id: ref.id, file, cwd, session: ref.session };
}

/** OMP's context-usage count of a source: its live session's own, or read from a parked source's persisted active branch. */
async function measureSource(source: ForkSource, parent: AgentSession, ctx: ExtensionContext): Promise<SourceSize> {
	switch (source.kind) {
		case "caller":
			return liveSize(parent);
		case "agent":
			return source.session ? liveSize(source.session) : await persistedSize(source.file, new Tokenizer(parent.model ?? ctx.model));
		default: {
			const unreachable: never = source;
			return unreachable;
		}
	}
}

function liveSize(session: AgentSession): SourceSize {
	const usage = session.getContextUsage();
	return usage ? { kind: "measured", tokens: usage.tokens } : { kind: "unmeasured", reason: "the session reports no context usage" };
}

/**
 * A parked source has no live stats tracker. Mirror its anchor: the newest
 * assistant provider snapshot of the active context (after the latest
 * compaction, as `buildSessionContext` returns it), less the history rewrites
 * recorded against it, plus the tokenizer count of the messages after it.
 * The live tracker's non-message delta (current system prompt and tools
 * against the snapshot's) has no parked counterpart: a parked source has no
 * current system prompt or tools, and the child sends its own anyway, so the
 * snapshot's own non-message part stands as recorded.
 */
async function persistedSize(file: string, tokenizer: Tokenizer): Promise<SourceSize> {
	const manager = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true, throwIfMissing: true });
	try {
		const { messages } = manager.buildSessionContext();
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message?.role !== "assistant" || !message.contextSnapshot) continue;
			const snapshot = message.contextSnapshot;
			const base = Math.max(0, snapshot.promptTokens - (snapshot.historyRewriteTokensRemoved ?? 0));
			return { kind: "measured", tokens: base + tokenizer.countMessages(messages.slice(index + 1)) };
		}
		return { kind: "unmeasured", reason: "its transcript records no provider context snapshot" };
	} finally {
		await manager.close();
	}
}

function sourceLabel(source: ForkSource): string {
	switch (source.kind) {
		case "caller":
			return "this conversation";
		case "agent":
			return `from \`${source.id}\``;
		default: {
			const unreachable: never = source;
			return unreachable;
		}
	}
}

type ItemParams = z.infer<typeof itemSchema>;

type Preflight = { readonly kind: "ok"; readonly sources: readonly ForkSource[] } | { readonly kind: "rejected"; readonly message: string };

/**
 * Resolve every item's source and measure each one an item without
 * `shake: true` would copy whole, before anything is staged. One source file
 * is measured once per call.
 */
async function preflight(
	items: readonly ItemParams[],
	parent: AgentSession,
	parentFile: string,
	ctx: ExtensionContext,
	cap: number,
): Promise<Preflight> {
	const sources: ForkSource[] = [];
	for (const item of items) {
		const source = await resolveSource(item.from, parent, parentFile);
		if (source.kind === "error") return { kind: "rejected", message: `fork_task: ${source.message} Nothing was dispatched.` };
		sources.push(source);
	}
	const sizes = new Map<string, Promise<SourceSize>>();
	const offending: string[] = [];
	for (const [index, item] of items.entries()) {
		const source = sources[index];
		if (!source || item.shake === true) continue;
		let size = sizes.get(source.file);
		if (!size) {
			size = measureSource(source, parent, ctx).catch((error: unknown): SourceSize => ({ kind: "unmeasured", reason: errorText(error) }));
			sizes.set(source.file, size);
		}
		const measured = await size;
		const label = `#${index} (${item.name ?? "unnamed"}, ${sourceLabel(source)})`;
		switch (measured.kind) {
			case "measured":
				if (measured.tokens > cap) offending.push(`${label}: ${measured.tokens} tokens`);
				break;
			case "unmeasured":
				offending.push(`${label}: size unknown (${measured.reason})`);
				break;
			default: {
				const unreachable: never = measured;
				return unreachable;
			}
		}
	}
	if (offending.length === 0) return { kind: "ok", sources };
	return {
		kind: "rejected",
		message:
			`fork_task: inherited context over the cap of ${cap} tokens (\`maxInheritedTokens\`, omomp.yml section \`fork-task\`; ` +
			`OMP's context-usage count of the source, its system prompt and tools included): ${offending.join("; ")}. Nothing was dispatched. ` +
			"Each child's first request would write that whole context to the provider cache at full price, and siblings share only the prefix before the fork point. " +
			"Use `task` with a self-contained brief instead, or retry those items with `shake: true`.",
	};
}

export default function forkTask(pi: ExtensionAPI): void {
	const pending: PendingFork[] = [];
	/** The configured cap; every invalid copy the loader passed over is logged. */
	const inheritedTokenCap = (cwd: string): number => {
		const loaded = loadOmompSection(omompSection, cwd);
		for (const problem of loaded.skipped) {
			pi.logger.warn("fork_task: skipped an invalid fork-task section", { path: problem.path, reason: problem.reason });
		}
		switch (loaded.kind) {
			case "found":
				return loaded.value.maxInheritedTokens;
			case "none":
				return DEFAULT_MAX_INHERITED_TOKENS;
			default: {
				const unreachable: never = loaded;
				return unreachable;
			}
		}
	};

	const discard = async (entry: PendingFork): Promise<void> => {
		const index = pending.indexOf(entry);
		if (index !== -1) pending.splice(index, 1);
		await fs.rm(path.dirname(entry.staging), { recursive: true, force: true });
	};

	pi.on("before_subagent_spawn", async (event, ctx) => {
		if (event.invocationKind !== "task" || !event.spawnKey) return;
		const parentFile = ctx.sessionManager.getSessionFile();
		if (!parentFile) return;
		const artifactsDir = parentFile.slice(0, -".jsonl".length);
		const spawnKey = event.spawnKey;
		const segment = spawnKey.slice(spawnKey.lastIndexOf(".") + 1);
		const entry = pending.find((p) => p.artifactsDir === artifactsDir && p.name === segment);
		if (!entry) return;
		const target = path.join(artifactsDir, `${spawnKey}.jsonl`);
		try {
			const occupied = await fs.access(target).then(
				() => true,
				() => false,
			);
			if (occupied) {
				await discard(entry);
				return { block: true, reason: `fork_task: ${target} already exists; refusing to overwrite it.` };
			}
			await fs.mkdir(artifactsDir, { recursive: true });
			await moveFile(entry.staging, target);
			await discard(entry);
			return undefined;
		} catch (error) {
			pi.logger.warn("fork_task: preparing the child conversation failed", { error: errorText(error) });
			return { block: true, reason: `fork_task: preparing the child conversation failed: ${errorText(error)}` };
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const parentFile = ctx.sessionManager.getSessionFile();
		if (!parentFile) return;
		const artifactsDir = parentFile.slice(0, -".jsonl".length);
		for (const entry of pending.filter((p) => p.artifactsDir === artifactsDir)) {
			try {
				await discard(entry);
			} catch (error) {
				pi.logger.warn("fork_task: cleaning up the staged conversation failed", { error: errorText(error) });
			}
		}
	});

	pi.registerTool({
		name: "fork_task",
		label: tr("Fork Task", "分叉任务"),
		description: DESCRIPTION,
		loadMode: "essential",
		parameters: paramsSchema,
		async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
			const params = paramsSchema.parse(rawParams);
			const missingAgent = params.tasks.flatMap((item, index) =>
				item.from?.trim() && !item.agent?.trim() ? [`#${index} (${item.name ?? "unnamed"})`] : [],
			);
			if (missingAgent.length > 0) {
				return fail(
					`fork_task: items with \`from\` must name \`agent\` explicitly; missing on ${missingAgent.join(", ")}. Nothing was dispatched.`,
				);
			}

			const parent = findCallerSession(ctx);
			if (!parent) return fail("fork_task: could not resolve the calling session in the agent registry.");
			const taskTool = parent.getToolByName("task");
			if (!taskTool) return fail("fork_task: the `task` tool is unavailable in this session (recursion depth or settings).");
			// Only async dispatch pre-allocates the child id before the spawn hook;
			// sync dispatch reports the bare label, which misses nested id prefixes.
			if (!parent.asyncJobManager || cfgAsyncEnabled.get(parent.settings) !== true) {
				return fail("fork_task: requires background jobs (`async.enabled: true`).");
			}
			await parent.sessionManager.ensureOnDisk();
			await parent.sessionManager.flush();
			const parentFile = parent.sessionManager.getSessionFile();
			if (!parentFile) return fail("fork_task: forking needs a persisted session.");
			const artifactsDir = parentFile.slice(0, -".jsonl".length);
			const planMode = parent.getPlanModeState()?.enabled === true;

			const checked = await preflight(params.tasks, parent, parentFile, ctx, inheritedTokenCap(ctx.cwd));
			if (checked.kind === "rejected") return fail(checked.message);

			const staged: PendingFork[] = [];
			const notes: string[] = [];
			const tasks: TaskItem[] = [];
			try {
				for (const [index, item] of params.tasks.entries()) {
					const source = checked.sources[index];
					if (!source) throw new Error(`item #${index} has no resolved source.`);
					const name = `${sanitizeName(item.name) ?? "Fork"}_${randomUUID().slice(0, 4)}`;
					const isolated = !planMode && (item.isolated ?? true);
					const { staging, shakeSummary } = await stageFork(ctx, parent, source, item.shake === true, isolated);
					const entry: PendingFork = { name, artifactsDir, staging };
					staged.push(entry);
					pending.push(entry);
					if (shakeSummary) notes.push(`${name}: ${shakeSummary}`);
					tasks[index] = {
						name,
						task: item.task,
						...(item.agent !== undefined ? { agent: item.agent } : {}),
						...(planMode ? {} : { isolated }),
						...(item.effort !== undefined ? { effort: item.effort } : {}),
						...(item.tools !== undefined ? { tools: item.tools } : {}),
						...(item.outputSchema !== undefined ? { outputSchema: item.outputSchema } : {}),
						...(item.schemaMode !== undefined ? { schemaMode: item.schemaMode } : {}),
					};
				}
			} catch (error) {
				for (const entry of staged) await discard(entry);
				return fail(`fork_task: staging the conversation fork failed: ${errorText(error)}`);
			}

			const result = await taskTool
				.execute(toolCallId, { context: params.context, tasks }, signal, onUpdate)
				.catch(async (error: unknown) => {
					for (const entry of staged) await discard(entry);
					throw error;
				});

			// Items the task tool never scheduled (validation errors) leave nothing staged.
			const parsed = progressSchema.safeParse(result.details);
			const scheduled = new Set(parsed.success ? parsed.data.progress.map((p) => p.index) : []);
			for (const [index, entry] of staged.entries()) {
				if (!scheduled.has(index)) await discard(entry);
			}

			if (notes.length === 0) return result;
			return {
				...result,
				content: [...result.content, { type: "text" as const, text: `\n[fork_task] ${notes.join("; ")}` }],
			};
		},
	});
}
