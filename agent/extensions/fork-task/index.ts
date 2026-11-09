// ============================================================================
// fork_task — native `task` subagents that start from a copy of the caller's
// conversation, or of another agent's named by an item's `from`.
//
// Registers fork_task plus before_subagent_spawn, before_agent_start, session_start
// (main only) and session_shutdown hooks in main and sub sessions, and one BroadcastChannel
// listener per thread (source-channel.ts). Reads the source agent's persisted
// session; writes temporary JSONL under the OS temp directory and moves it
// into the caller's artifact store; writes each child's replica copy under
// `<tmp>/omp-fork-task/replicas/<pid>/`, each isolated subagent's workspace
// start under `<tmp>/omp-fork-task/starts/<pid>/`, a parked session's latest
// request under `<tmp>/omp-fork-task/parked/<pid>/` and a
// `workspace: "source"` child's inherited changes under
// `<tmp>/omp-fork-task/overlays/<pid>/`. Main-session shutdown deletes all four
// of this process's directories (park disposes a sub session too, so a sub
// shutdown never deletes what its fork children still need). Main-session
// startup sweeps the `replicas/`, `overlays/`, `parked/` and `starts/`
// directories of processes that no longer exist (sweep.ts); live processes'
// directories stay. The overlay is consumed at the child's
// first turn (workspace.ts). Inherited changes that do not apply stop the
// child before its first model call; a failed start record only warns.
// Execution failures warn and return tool errors; user aborts reject for host
// cancellation accounting. Spawn preparation failures block the child and warn,
// while park-record, startup-sweep and shutdown cleanup failures warn without
// rejecting.
//
// Every item replicates its source's actual model request: the caller's, or
// that of the agent `from` names, live or parked. replica.ts captures each session's
// provider-neutral Context through Agent.streamFn; the child reuses that
// system prompt, tool list, message prefix and (on the source's model) its
// request controls, so forks of one source share the provider cache prefix.
// The shared `context`, an `agent` role and the assignment reach the child
// only as its new user message, never as system text. Child tools execute
// against the child's session. On the source's model, when the source
// declares `eval`, the child declares the source's tool list byte for byte:
// its own `yield` stays undeclared, introduced by a `before_agent_start` /
// `tool_result` delta reminder (`omp-config/fork-task`) and called from an
// `eval` cell through the bridge; the `tool_result` hook reports that bridged
// call to the session as a `yield` tool execution (`emitExternalEvent`), and a
// tool choice forcing `yield` forces `eval` instead. Otherwise `yield` follows
// the source's tools.
//
// `agent` selects the model binding (`task.agentModelOverrides`, else the
// definition's `model`) and puts that definition's prompt in a <role> block
// of the assignment; without `agent` the child runs the source's model and
// thinking level. Every child is dispatched as internal `fork:self`, so its
// tool surface is the source's, not the named agent's. Forks without `agent`
// share cwd by default, forks with `agent` are isolated by default. No
// inheritance-size or cost gate exists.
// At the maximum dispatch depth (caller `taskDepth` + 1 reaches `task.maxRecursionDepth`) the call returns a tool error before staging.
//
// The spawn itself is the built-in `task` tool, called with the same batch
// shape, so each child is an ordinary task subagent: Agent Hub row,
// `agent://`/`history://`, idle/park/revive lifecycle, isolation and its
// merge-back. Only the child's starting transcript, model, prompt and tools
// differ:
//
//   1. At call time the source's persisted conversation (the caller's, or the
//      registered agent `from` names, resolved like `history://<id>`; a parked
//      agent is read from its closed transcript, not revived) is forked
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
// Relies on omp internals (AgentRegistry, the executor's session-file path and
// hook ordering, session entry types, subagent worker threads); re-verify after
// every omp upgrade. OMP may run a session in a subagent worker thread, which
// loads its own copy of this module. Every child reads its replica from the
// copy file at its first turn, and a thread that hosts no child keeps none of
// it. A `from` source this thread does not host is asked over source-channel.ts,
// and its own thread answers with its latest request; a parked source's kept
// request is a file every thread of the process reads, removed at main-session
// shutdown or swept by a later main session's startup once its process is gone
// (sweep.ts).
// ============================================================================
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type AgentDefinition,
	type AgentSession,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BeforeSubagentSpawnEvent,
	type BeforeSubagentSpawnEventResult,
	createAgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type TaskItem,
	type ToolDefinition,
	type ToolResultEvent,
	z,
} from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgTaskAgentModelOverrides, cfgTaskDisabledAgents, cfgTaskMaxRecursionDepth } from "@oh-my-pi/pi-coding-agent/task/settings";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { callerSession } from "../_shared/caller-session.ts";
import { createDeltaStream, type Delta, type DeltaStream } from "../_shared/context-delta.ts";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import {
	applyReplica,
	captureReplica,
	type ForkNotice,
	liveRequest,
	type OwnYield,
	observedHere,
	observeRequests,
	type ParkedRequest,
	parkedRequest,
	type Replica,
	type SourceRequest,
	sameModel,
} from "./replica.ts";
import { parkedRoot, readReplicaFile, replicaFilePath, replicasRoot, STAGING_ROOT, writeReplicaFile } from "./replica-file.ts";
import { askSource, serveSources } from "./source-channel.ts";
import { sweepDeadProcessDirs } from "./sweep.ts";
import { forkTaskTopics, TOPIC_POINTERS } from "./topics.ts";
import {
	applyOverlay,
	type Inheritance,
	inheritSourceWorkspace,
	overlaysRoot,
	recordStart,
	rejection,
	startsRoot,
	writeOverlay,
} from "./workspace.ts";

const itemSchema = z.object({
	from: z.string().optional(),
	name: z.string().optional(),
	agent: z.string().optional(),
	task: z.string(),
	isolated: z.boolean().optional(),
	workspace: z.enum(["caller", "source"]).optional(),
	shake: z.boolean().optional(),
	effort: z.enum(["lo", "med", "hi"]).optional(),
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

/** Rewrite output buffered before each chunk write, so a staged file is never held whole. */
const FLUSH_CHARS = 1 << 18;
/** Bytes read per batch by the staging rewrite. */
const CHUNK_BYTES = 1 << 22;

const DESCRIPTION = `Fork a conversation into a native task child that continues it under the source's exact request: its system prompt, tools and message prefix are replicated unchanged, so forks of one source share the provider's cached prefix. \`context\`, an \`agent\` role and \`task\` reach the child only as its new user message, never as system text.
- The source is your conversation, or that of the agent \`from\` names, live or parked.
- Omit \`agent\` to run the source's model and thinking/request controls; the default is a shared working directory (\`isolated: false\`).
- Set \`agent\` to run that agent's model binding, with its definition prompt as a role block in the assignment. The child keeps the source's tools, so the agent's tool restrictions do not apply; a different model reuses no cache. The default is \`isolated: true\`.

Children keep native task result delivery, Agent Hub, \`agent://\`/\`history://\`, \`write agent://\` and isolated merge-back. They support idle/park/revive while their originating process and snapshot remain alive; after restart, create a fresh fork rather than cold-reviving one without its snapshot. Use ordinary \`task\` for an independent fresh perspective or when a short brief suffices.

- \`shake\` defaults to false. Explicit \`shake: true\` elides the inherited copy and writes recovery artifacts; it deliberately gives up exact inherited-message prefix reuse. There is no source-token or source-cost check.
- \`isolated\` overrides the default. Concurrent writers must explicitly use isolated workspaces. Plan mode forces shared, read-only children. Isolated children cannot be resumed after completion.
- \`from\` selects another registered agent (running, idle or parked, in any thread of this OMP process) whose latest request is replicated; a parked source is forked without waking it. Omit it for your conversation.
- \`workspace\` picks what the child's workspace starts from. \`"caller"\` (default): your checkout only, even when \`from\` names an agent with an isolated workspace. \`"source"\`: an isolated copy of your checkout with the uncommitted changes the \`from\` agent made in its own isolated workspace applied before the child's first turn; they are handed back together with the child's changes. \`"source"\` defaults \`isolated\` to true and needs a stopped \`from\` agent whose run has not handed its changes back; otherwise the call fails before dispatch with \`workspace "source" rejected (<code>)\`, code one of \`child-not-isolated\`, \`source-not-isolated\`, \`source-running\`, \`source-handed-back\`, \`nested-repo\`, \`overlay-conflict\` (conditions: \`xd://fork_task/limits\`).
- Omit \`effort\` unless the user asks; an effort change keeps the replicated prefix.
- Each \`name\` gets a short unique suffix; use the returned id for follow-ups. The child has its own Todo and only owns the assignment, not unfinished work in inherited history.
- Forked workers must run relevant scoped checks and real runtime verification before returning; the parent owns final acceptance.

\`context\` and each item's \`task\` follow the same scoping rules as \`task\`: state target, change and acceptance. Cache reuse requires the same model and compatible request parameters, and remains subject to the provider's cache policy; adding completion tools can invalidate caches on providers without append-only tool support.`;

/**
 * Where the forked transcript and replicated request come from. `caller` is
 * the session calling fork_task; `agent` is another live registered agent
 * named by `from`; `parked` is such an agent without a live session, forked
 * from the request it kept at park and its transcript, without reviving it.
 * The two may run in workspaces other than the parent's.
 */
type ForkSource =
	| { readonly kind: "caller"; readonly request: SourceRequest; readonly file: string; readonly cwd: string }
	| { readonly kind: "agent"; readonly id: string; readonly request: SourceRequest; readonly file: string; readonly cwd: string }
	| { readonly kind: "parked"; readonly id: string; readonly request: SourceRequest; readonly file: string; readonly cwd: string };

function workspaceNotice(source: ForkSource, parentCwd: string, isolated: boolean, inherited: boolean): string[] {
	switch (source.kind) {
		case "caller":
			return [
				isolated
					? `- You run in an isolated copy of the workspace. Paths under \`${parentCwd}\` in the conversation name the parent's checkout: use the same repository-relative paths inside your own working directory, and NEVER read or write under \`${parentCwd}\`.`
					: "- You share the parent's working directory; files may change between your reads.",
			];
		case "agent":
		case "parked": {
			const id = `\`${source.id}\``;
			const foreign = [...new Set([source.cwd, ...(isolated ? [parentCwd] : [])])];
			const lines = [
				isolated
					? "- You run in an isolated copy of the parent's workspace."
					: `- You share the parent's working directory \`${parentCwd}\`; files may change between your reads.`,
				inherited
					? `- Before your first turn, the uncommitted changes ${id} made in its own isolated workspace were applied to yours: continue from them. They are handed back together with your own changes.`
					: `- Your workspace derives from the parent's checkout, not from ${id}'s: changes ${id} made in a workspace of its own are not in yours unless they reached the parent's checkout before this fork.`,
			];
			const named = foreign.filter((p) => isolated || p !== parentCwd);
			if (named.length > 0) {
				const list = named.map((p) => `\`${p}\``).join(" and ");
				lines.push(
					`- Paths under ${list} in the conversation name checkouts other than yours: use the same repository-relative paths inside your own working directory, and NEVER read or write under ${list}.`,
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

const forkNotice = (source: ForkSource, parentCwd: string, isolated: boolean, inherited: boolean): string => {
	const origin =
		source.kind === "caller"
			? "Above: the conversation of the parent agent that spawned you, copied as background. You continue under its system prompt and tools."
			: `Above: the conversation of agent \`${source.id}\`, copied as background. You continue under its system prompt and tools, but \`${source.id}\` is not your parent: the agent that spawned you receives your result.`;
	const owner = source.kind === "caller" ? "the parent" : `\`${source.id}\``;
	const contract =
		"The parent keeps the conversation with the user. A <role> block opening the assignment defines how you work on it. Deliver your result with `yield` when available, otherwise finish with your final report.";
	return [
		`<system-notice cause="fork_task">`,
		`${origin} ${contract}`,
		"- Use it only for the facts, decisions, and constraints it established.",
		`- Your job is the assignment that follows this notice, nothing else. NEVER continue, resume, or complete other work from the conversation; its todo lists and plans belong to ${owner}.`,
		"- Verification is explicitly required for this fork_task assignment: run the relevant scoped build, lint, tests, and real runtime smoke path before handoff. This overrides ordinary task's default to leave verification to the parent. Observe the changed behavior and report commands, outputs, and limitations; do not claim completion while required runtime verification is missing. Read-only roles remain read-only: report evidence from their permitted inspection instead of running execution tools.",
		source.kind === "caller"
			? "- The parent keeps working concurrently."
			: `- The parent and \`${source.id}\` may keep working concurrently.`,
		...workspaceNotice(source, parentCwd, isolated, inherited),
		"</system-notice>",
	].join("\n");
};

/** Agent definition every fork is dispatched as; its prompt and tools are replaced by the source's. */
const FORK_AGENT = "fork:self";

/**
 * The borrowed `ask` tool of each child session file, the one live part of a
 * replica. Every child reads the plain-data copy `replica-file.ts` holds (the
 * same file in every thread) at its first turn, so a replica is never retained
 * for a child this thread does not host; only the tool, which must stay in the
 * parent's thread, outlives that read. Copies live until the main session
 * shuts down — a sub session's park runs the same shutdown event, so a revived
 * child keeps its replicated contract.
 */
const replicaAsks = new Map<string, AgentTool>();

type PendingFork = {
	/** Exact requested name; the allocated id's last dot-segment. */
	readonly name: string;
	readonly artifactsDir: string;
	readonly staging: string;
	readonly replica: Replica;
	/** Spawn model patterns; undefined leaves the native default. */
	readonly model: string | string[] | undefined;
	/** Root-repository changes the child applies before its first turn (`workspace: "source"`). */
	readonly overlay: string | undefined;
};

type StagedFork = {
	readonly staging: string;
	readonly notice: ForkNotice;
	readonly shakeSummary?: string;
};

/** This thread's copy for `childFile`, read on demand, plus the borrowed `ask` it still holds. */
async function portableReplica(childFile: string): Promise<Replica | undefined> {
	const copy = await readReplicaFile(replicaFilePath(childFile));
	if (!copy) return undefined;
	return { ...copy, ask: replicaAsks.get(childFile) };
}

/** Mirrors the task tool's `sanitizeAgentId`, so the requested name is the allocated id. */
function sanitizeName(value: string | undefined): string | undefined {
	const sanitized = value
		?.trim()
		.replace(/[^A-Za-z0-9_-]+/g, "")
		.slice(0, 40);
	return sanitized || undefined;
}

/**
 * A UTF-8 file's lines as byte-sized batches: a rewrite visits every line while
 * holding only one batch, and a multi-byte character split across reads is
 * carried into the next batch.
 */
async function* readLineBatches(handle: fs.FileHandle, bytes = CHUNK_BYTES): AsyncGenerator<string[]> {
	const buffer = Buffer.allocUnsafe(bytes);
	const decoder = new TextDecoder();
	let carry = "";
	for (;;) {
		const { bytesRead } = await handle.read(buffer, 0, bytes, null);
		if (bytesRead === 0) break;
		const text = carry + decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
		const lines = text.split("\n");
		carry = lines.pop() ?? "";
		yield lines;
	}
	carry += decoder.decode();
	if (carry.length > 0) yield [carry];
}

/**
 * Rewrite the staged JSONL: drop parent runtime state and the shake helper's
 * bookkeeping, re-parent what depended on dropped entries, and set the header
 * cwd the child must bind to. One pass, one record at a time: a JSONL session
 * appends an entry after the entries it references, so a dropped entry is
 * known before the rewrite reaches a `parentId` or `firstKeptEntryId` that
 * names it. `preShakeIds` is undefined when no shake ran: nothing was added
 * to drop then.
 */
async function finalizeStaging(
	file: string,
	options: { cwd: string; isolated: boolean; preShakeIds: ReadonlySet<string> | undefined },
): Promise<void> {
	const temp = `${file}.rewrite`;
	const source = await fs.open(file);
	let target: fs.FileHandle;
	try {
		target = await fs.open(temp, "w");
	} catch (error) {
		// The rewrite never starts; release the reader without masking the open failure.
		await source.close().catch(() => {});
		throw error;
	}
	const chunk: string[] = [];
	let chunkLength = 0;
	const flush = async (): Promise<void> => {
		if (chunk.length === 0) return;
		const bytes = Buffer.from(`${chunk.join("\n")}\n`, "utf8");
		chunk.length = 0;
		chunkLength = 0;
		let written = 0;
		// A short write keeps its own cursor; loop so a chunk is never half written.
		while (written < bytes.length) {
			const { bytesWritten } = await target.write(bytes, written, bytes.length - written);
			if (bytesWritten === 0) throw new Error(`fork_task: writing ${temp} made no progress`);
			written += bytesWritten;
		}
	};
	const emit = (line: string): void => {
		chunk.push(line);
		chunkLength += line.length + 1;
	};
	const dropped = new Map<string, string | null>();
	const nextSurviving = new Map<string, string>();
	const survivingParent = (id: string | null): string | null => {
		let current = id;
		while (current !== null && dropped.has(current)) current = dropped.get(current) ?? null;
		return current;
	};
	let headerSeen = false;
	let pendingDropped: string[] = [];
	let failure: unknown;
	try {
		for await (const batch of readLineBatches(source)) {
			for (const line of batch) {
				if (line.length === 0) continue;
				const record: unknown = JSON.parse(line);
				const header = headerSeen ? undefined : sessionHeaderSchema.safeParse(record);
				if (header?.success) {
					headerSeen = true;
					const next = { ...header.data, cwd: options.isolated ? "" : options.cwd };
					if (options.isolated) delete next.additionalDirectories;
					emit(JSON.stringify(next));
					if (chunkLength >= FLUSH_CHARS) await flush();
					continue;
				}
				const parsed = sessionEntrySchema.safeParse(record);
				if (!parsed.success) {
					emit(line);
					if (chunkLength >= FLUSH_CHARS) await flush();
					continue;
				}
				const entry = parsed.data;
				const addedByShake = options.preShakeIds !== undefined && !options.preShakeIds.has(entry.id);
				const drop =
					RUNTIME_STATE_TYPES[entry.type] === true ||
					(addedByShake && entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
				if (drop) {
					dropped.set(entry.id, entry.parentId ?? null);
					pendingDropped.push(entry.id);
					continue;
				}
				// `firstKeptEntryId` may name a dropped entry: move it to the next surviving entry.
				for (const id of pendingDropped) nextSurviving.set(id, entry.id);
				pendingDropped = [];
				const next: SessionEntryRecord = { ...entry };
				if (next.parentId && dropped.has(next.parentId)) next.parentId = survivingParent(next.parentId);
				if (next.firstKeptEntryId && dropped.has(next.firstKeptEntryId)) {
					const replacement = nextSurviving.get(next.firstKeptEntryId);
					if (replacement) next.firstKeptEntryId = replacement;
				}
				emit(JSON.stringify(next));
				if (chunkLength >= FLUSH_CHARS) await flush();
			}
		}
		await flush();
	} catch (error) {
		failure = error;
	}
	// Close both handles whatever happened; a close failure never hides the rewrite's own error.
	for (const handle of [target, source]) {
		try {
			await handle.close();
		} catch (error) {
			if (failure === undefined) failure = error;
		}
	}
	if (failure !== undefined || !headerSeen) {
		await fs.rm(temp, { force: true }).catch(() => {});
		if (failure !== undefined) throw failure;
		throw new Error(`fork_task: ${file} has no session header`);
	}
	await fs.rename(temp, file);
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

/** The timestamp of the last assistant message on the branch, which the latest request produced. */
function lastResponse(manager: SessionManager): number | undefined {
	const branch = manager.getBranchView();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "assistant") return entry.message.timestamp;
	}
	return undefined;
}

async function stageFork(
	ctx: ExtensionContext,
	parent: AgentSession,
	source: ForkSource,
	shake: boolean,
	isolated: boolean,
	inherited: boolean,
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
		// Only a shake adds entries finalizeStaging must leave out; without one, every entry predates it.
		let preShakeIds: ReadonlySet<string> | undefined;
		let notice: ForkNotice;
		try {
			// A parked source's kept request is current only while its transcript still ends at that request's response.
			if (source.kind === "parked" && lastResponse(manager) !== source.request.response) {
				throw new Error(
					`agent \`${source.id}\`'s transcript has moved past the request it kept at park, or is still being written while it parks; retry the fork.`,
				);
			}
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
			const timestamp = Date.now();
			const entryId = manager.appendMessage({
				role: "developer",
				content: forkNotice(source, parentCwd, isolated, inherited),
				attribution: "agent",
				timestamp,
			});
			notice = { entryId, timestamp };
			await manager.flush();
			if (shake) {
				preShakeIds = new Set(manager.getEntries().map((entry) => entry.id));
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
		return { staging, notice, shakeSummary };
	} catch (error) {
		await fs.rm(stagingDir, { recursive: true, force: true });
		throw error;
	}
}

type SourceResolution = { readonly kind: "error"; readonly message: string } | ForkSource;

/**
 * Resolve `from` to the source to fork: omitted (or naming the caller) forks
 * the caller; otherwise a registered non-advisor agent, matched like
 * `history://<id>` (exact, then case-insensitive) after the caller root's
 * persisted roster is loaded. A live source's latest request is captured and
 * then its transcript flushed, so the transcript holds every replicated
 * message: in this thread directly, or by the thread hosting it when that is
 * another one. A parked source stays parked and is forked from the request it
 * kept at park and its closed transcript.
 */
async function resolveSource(from: string | undefined, parent: AgentSession, parentFile: string): Promise<SourceResolution> {
	const requested = from?.trim();
	const caller = async (): Promise<SourceResolution> => {
		const live = liveRequest(parent);
		if (live.kind === "unavailable") return { kind: "error", message: `cannot replicate your own request: ${live.reason}` };
		await parent.sessionManager.flush();
		return { kind: "caller", request: live.source, file: parentFile, cwd: parent.sessionManager.getCwd() };
	};
	if (!requested) return caller();
	const registry = AgentRegistry.global();
	await ensurePersistedRoster(registry, parentFile);
	let ref = registry.get(requested);
	if (ref?.kind === "advisor") ref = undefined;
	const lower = requested.toLowerCase();
	ref ??= registry.list().find((candidate) => candidate.kind !== "advisor" && candidate.id.toLowerCase() === lower);
	if (!ref) return { kind: "error", message: `no agent \`${requested}\` is registered; \`from\` takes an id as in \`agent://<id>\`.` };
	if (ref.session === parent || ref.sessionFile === parentFile) return caller();
	const parked = (id: string, file: string, kept: ParkedRequest): SourceResolution => {
		const { cwd, ...request } = kept;
		return { kind: "parked", id, request: { ...request, ask: undefined }, file, cwd };
	};
	const session = ref.session;
	if (!session) {
		const kept = ref.sessionFile ? await parkedRequest(ref.sessionFile) : undefined;
		if (!ref.sessionFile || !kept) {
			return {
				kind: "error",
				message: `agent \`${ref.id}\` is parked and OMP kept no request of it (it parked in an earlier OMP process, or its last request got no response); wake it with \`write agent://${ref.id}\`, then fork it.`,
			};
		}
		return parked(ref.id, ref.sessionFile, kept);
	}
	if (isLocalAgentSession(session) && observedHere(session)) {
		const live = liveRequest(session);
		if (live.kind === "unavailable") return { kind: "error", message: `cannot replicate the source's request: ${live.reason}` };
		await session.sessionManager.ensureOnDisk();
		await session.sessionManager.flush();
		const file = session.sessionManager.getSessionFile();
		if (!file) return { kind: "error", message: `agent \`${ref.id}\` has no persisted transcript to fork.` };
		return { kind: "agent", id: ref.id, request: live.source, file, cwd: session.sessionManager.getCwd() };
	}
	// Hosted by another thread of this process (a subagent worker, or the main thread seen from a worker).
	const file = ref.sessionFile ?? session.sessionManager.getSessionFile();
	if (!file) return { kind: "error", message: `agent \`${ref.id}\` has no persisted transcript to fork.` };
	const shared = await askSource(file);
	if (!shared) {
		// It may have parked between the registry read and the ask.
		const kept = await parkedRequest(file);
		if (kept) return parked(ref.id, file, kept);
		return { kind: "error", message: `agent \`${ref.id}\` runs in another OMP thread that did not answer for it; retry the fork.` };
	}
	if (shared.kind === "unavailable") return { kind: "error", message: `cannot replicate the source's request: ${shared.reason}` };
	const { cwd, ...request } = shared.source;
	return { kind: "agent", id: ref.id, request: { ...request, ask: undefined }, file, cwd };
}

/** What an item's `agent` contributes: nothing, or a role prompt and model binding. */
type RoleResolution =
	| { readonly kind: "none" }
	| { readonly kind: "role"; readonly block: string; readonly model: string | string[] | undefined }
	| { readonly kind: "error"; readonly message: string };

/** Agent definitions as the task tool discovers them, loaded once per fork_task call. */
function roleResolver(parent: AgentSession): (agent: string | undefined) => Promise<RoleResolution> {
	let definitions: Promise<AgentDefinition[]> | undefined;
	return async (agent) => {
		if (!agent) return { kind: "none" };
		if (agent === FORK_AGENT)
			return { kind: "error", message: `\`${FORK_AGENT}\` is internal; omit \`agent\` to keep the source's model.` };
		if (cfgTaskDisabledAgents.get(parent.settings).includes(agent)) {
			return { kind: "error", message: `agent \`${agent}\` is disabled by \`task.disabledAgents\`.` };
		}
		definitions ??= discoverAgents(parent.sessionManager.getCwd(), os.homedir(), parent.effectiveExtensionRoots).then(({ agents }) => [
			...agents,
			...parent.getSessionAgents(),
		]);
		const definition = getAgent(await definitions, agent);
		if (!definition) return { kind: "error", message: `no agent definition named \`${agent}\`.` };
		const override = cfgTaskAgentModelOverrides.get(parent.settings)[agent];
		return {
			kind: "role",
			block: `<role agent="${agent}">\n${definition.systemPrompt.trim()}\n</role>`,
			model: override ?? definition.model,
		};
	};
}

/**
 * What a `workspace: "source"` item inherits. The child must get an isolated
 * workspace of its own, and the source must be another agent; the rest is
 * decided from the source's registry entry and workspace.
 */
async function sourceInheritance(source: ForkSource, isolated: boolean, callerCwd: string): Promise<Inheritance> {
	if (!isolated) {
		return {
			kind: "rejected",
			code: "child-not-isolated",
			detail: "the child would share your workspace (explicit `isolated: false`, or plan mode); inheriting needs an isolated child.",
		};
	}
	switch (source.kind) {
		case "caller":
			return {
				kind: "rejected",
				code: "source-not-isolated",
				detail: "without `from` the source is your own conversation, which has no isolated workspace of its own; name the agent in `from`.",
			};
		case "agent":
		case "parked": {
			const ref = AgentRegistry.global().get(source.id);
			return inheritSourceWorkspace(
				{
					id: source.id,
					file: source.file,
					cwd: source.cwd,
					running: ref?.status === "running",
					handedBack: ref?.history?.patchPath !== undefined || ref?.history?.branchName !== undefined,
				},
				callerCwd,
			);
		}
		default: {
			const unreachable: never = source;
			return unreachable;
		}
	}
}

/**
 * Per-load runtime state of the fork factory, shared by the hooks and the
 * tool's execute: created fresh by each `forkTask` call so a rebind (a child
 * OMP on the parent's thread, a worker-thread copy) gets its own copy.
 * Module-level functions below receive it as their first argument.
 */
type ForkTaskRuntime = {
	readonly pi: ExtensionAPI;
	readonly warn: (message: string, error: unknown) => void;
	readonly pending: PendingFork[];
	/** Child sessions whose per-call hook is installed, with their own `yield` when the source's tools lack it. */
	readonly cloned: WeakMap<AgentSession, OwnYield | undefined>;
	readonly deltas: DeltaStream;
	/** Subagent transcripts whose workspace start this module copy has handled; dropped when the session ends. */
	readonly started: Set<string>;
};

async function discardPending(rt: ForkTaskRuntime, entry: PendingFork): Promise<void> {
	const index = rt.pending.indexOf(entry);
	if (index !== -1) rt.pending.splice(index, 1);
	await fs.rm(path.dirname(entry.staging), { recursive: true, force: true });
}

/**
 * Move the staged conversation into the parent's artifact store under the
 * pre-allocated spawn key so the executor opens the fork, not an empty
 * session. An existing target blocks the spawn instead of overwriting; any
 * failure blocks the child and warns.
 */
async function beforeSubagentSpawn(
	rt: ForkTaskRuntime,
	event: BeforeSubagentSpawnEvent,
	ctx: ExtensionContext,
): Promise<BeforeSubagentSpawnEventResult | undefined> {
	if (event.invocationKind !== "task" || !event.spawnKey) return;
	const parentFile = ctx.sessionManager.getSessionFile();
	if (!parentFile) return;
	const artifactsDir = parentFile.slice(0, -".jsonl".length);
	const spawnKey = event.spawnKey;
	const segment = spawnKey.slice(spawnKey.lastIndexOf(".") + 1);
	const entry = rt.pending.find((p) => p.artifactsDir === artifactsDir && p.name === segment);
	if (!entry) return;
	const target = path.join(artifactsDir, `${spawnKey}.jsonl`);
	try {
		const occupied = await fs.access(target).then(
			() => true,
			() => false,
		);
		if (occupied) {
			await discardPending(rt, entry);
			return { block: true, reason: `fork_task: ${target} already exists; refusing to overwrite it.` };
		}
		await fs.mkdir(artifactsDir, { recursive: true });
		await moveFile(entry.staging, target);
		await discardPending(rt, entry);
		await writeReplicaFile(replicaFilePath(target), entry.replica);
		// The copy is every thread's source of the replica; only the borrowed tool stays here.
		if (entry.replica.ask) replicaAsks.set(target, entry.replica.ask);
		if (entry.overlay) await writeOverlay(target, entry.overlay);
		return entry.model === undefined ? undefined : { model: entry.model };
	} catch (error) {
		rt.pi.logger.warn("fork_task: preparing the child conversation failed", { error: errorText(error) });
		return { block: true, reason: `fork_task: preparing the child conversation failed: ${errorText(error)}` };
	}
}

/**
 * The reminder that introduces a child's own `yield` while the request runs on
 * the source's model, whose wire tool list leaves it out (replica.ts
 * `wireTools`); none on another model, which declares it.
 */
function yieldDelta(ownYield: OwnYield | undefined, session: AgentSession): Delta {
	const model = session.model;
	if (!ownYield || !model || !sameModel(model, ownYield.sourceModel)) return { kind: "none" };
	const { tool } = ownYield;
	return {
		kind: "text",
		body: [
			`Your \`${tool.name}\` tool is not in your tool list: the list stays the parent's so its prompt cache keeps serving you. Call it from a JavaScript \`eval\` cell, never as a direct tool call: \`await tool.${tool.name}({ data: … })\` (or \`{ error: "…" }\`). The call submits exactly as a direct \`${tool.name}\` call would; a terminal submission ends your run.`,
			"",
			"Description:",
			tool.description,
			"",
			"Parameters (JSON Schema):",
			JSON.stringify(tool.parameters),
		].join("\n"),
	};
}

/**
 * Report a `yield` an `eval` cell ran through the bridge as the tool execution
 * the task executor and session watch for: bridged calls emit no agent-loop
 * events, so without this the run would never see its result. A `yield` the
 * loop runs itself is pending in the agent state and already reported.
 */
function forwardBridgedYield(rt: ForkTaskRuntime, session: AgentSession, event: ToolResultEvent): void {
	if (event.toolName !== "yield" || session.agent.state.pendingToolCalls.has(event.toolCallId)) return;
	try {
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: { content: event.content, details: event.details },
			isError: event.isError,
		});
	} catch (error) {
		rt.warn("fork_task: reporting a yield submitted from eval failed", error);
	}
}

/**
 * In a cloned child: report a bridged `yield`, and re-introduce the child's
 * own `yield` after a tool batch when compaction dropped the reminder mid-turn.
 */
function toolResult(rt: ForkTaskRuntime, event: ToolResultEvent, ctx: ExtensionContext): { additionalContext: string } | undefined {
	const session = callerSession(ctx);
	if (!session || !rt.cloned.has(session)) return;
	const ownYield = rt.cloned.get(session);
	if (ownYield) forwardBridgedYield(rt, session, event);
	return rt.deltas.afterTools(ctx, yieldDelta(ownYield, session));
}

/**
 * Per subagent transcript: record the isolated workspace start, apply a
 * `workspace: "source"` overlay before the first turn (a failed apply blocks
 * the child before its first model call), then install the replicated
 * request. A failed replication also blocks the child rather than running a
 * different contract.
 */
async function beforeAgentStart(
	rt: ForkTaskRuntime,
	_event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
): Promise<BeforeAgentStartEventResult | undefined> {
	const session = callerSession(ctx);
	if (!session) return;
	// A cloned session already holds its replica in the stream hook: never re-read the copy for it.
	if (rt.cloned.has(session)) return rt.deltas.atPrompt(ctx, yieldDelta(rt.cloned.get(session), session));
	const file = ctx.sessionManager.getSessionFile();
	if (ctx.agent.kind === "sub" && file && !rt.started.has(file)) {
		rt.started.add(file);
		const cwd = ctx.sessionManager.getCwd();
		// The start is recorded before an inherited overlay lands, so it matches OMP's own baseline of this run.
		await recordStart(file, cwd, ctx.agent.id).catch((error: unknown) => rt.warn("fork_task: recording the workspace start failed", error));
		let failure: string | undefined;
		try {
			const overlay = await applyOverlay(file, cwd);
			if (overlay.kind === "failed") failure = overlay.message;
		} catch (error) {
			failure = errorText(error);
		}
		if (failure !== undefined) {
			const reason = rejection("overlay-conflict", `the inherited changes did not apply to this workspace: ${failure}`);
			rt.pi.logger.warn(`fork_task: ${reason}`);
			// The assignment assumes the inherited changes; do not run it without them.
			session.agent.addBeforeModelCallHook(() => {
				throw new Error(reason);
			});
			return;
		}
	}
	try {
		observeRequests(session, rt.warn);
		// Every child reads the copy `beforeSubagentSpawn` wrote; this thread does not keep the replica.
		const replica = file ? await portableReplica(file) : undefined;
		if (!replica) {
			if (ctx.agent.name === FORK_AGENT) {
				throw new Error("the fork's request snapshot is no longer available; create a fresh fork from the parent");
			}
			return;
		}
		const ownYield = applyReplica(session, replica);
		rt.cloned.set(session, ownYield);
		return rt.deltas.atPrompt(ctx, yieldDelta(ownYield, session));
	} catch (error) {
		const reason = `fork_task: preparing request replication failed: ${errorText(error)}`;
		rt.pi.logger.warn(reason);
		// Do not run a different child contract after replication failed.
		session.agent.addBeforeModelCallHook(() => {
			throw new Error(reason);
		});
	}
}

/**
 * On main-session startup remove the `replicas/`, `overlays/`, `parked/` and
 * `starts/` directories of processes that no longer exist (the main session of
 * a crashed or killed omp never reached its shutdown). Live processes'
 * directories stay.
 */
async function sessionStart(rt: ForkTaskRuntime, _event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
	if (ctx.agent.kind !== "main") return;
	await sweepDeadProcessDirs(
		[replicasRoot(), overlaysRoot(), parkedRoot(), startsRoot()].map((dir) => path.dirname(dir)),
		rt.warn,
	);
}

/**
 * On main-session shutdown remove this process's replica copies, overlays,
 * parked-source and workspace-start records; on any session shutdown drop the
 * staged conversations of the forks that parent spawned. A sub session's park
 * emits the same event, so it must not drop what its fork children still need.
 */
async function sessionShutdown(rt: ForkTaskRuntime, _event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> {
	if (ctx.agent.kind === "main") {
		// The process's replica copies, overlays, parked sources and workspace starts belong to the agent tree this main session ends.
		for (const root of [replicasRoot(), overlaysRoot(), parkedRoot(), startsRoot()]) {
			await fs
				.rm(root, { recursive: true, force: true })
				.catch((error: unknown) => rt.warn("fork_task: removing per-process records failed", error));
		}
	}
	const parentFile = ctx.sessionManager.getSessionFile();
	if (!parentFile) return;
	// A session that ended no longer needs its start record remembered; a revived one re-checks the record file.
	rt.started.delete(parentFile);
	const artifactsDir = parentFile.slice(0, -".jsonl".length);
	for (const entry of rt.pending.filter((p) => p.artifactsDir === artifactsDir)) {
		try {
			await discardPending(rt, entry);
		} catch (error) {
			rt.pi.logger.warn("fork_task: cleaning up the staged conversation failed", { error: errorText(error) });
		}
	}
}

/**
 * Recursion depth of a live session: one per subagent link up the registry
 * parent chain (the main session has none). Revive derives `taskDepth` the same
 * way (`task/persisted-revive.ts`); `AgentSession` does not expose the field.
 */
function taskDepthOf(session: AgentSession): number {
	const registry = AgentRegistry.global();
	let ref = registry.list().find((candidate) => candidate.session === session);
	let depth = 0;
	const visited = new Set<string>();
	while (ref?.parentId !== undefined && !visited.has(ref.id)) {
		visited.add(ref.id);
		depth++;
		ref = registry.get(ref.parentId);
	}
	return depth;
}

/**
 * Stage each item's fork (resolve the source, capture its request, write the
 * staging JSONL), then dispatch the whole batch through the native `task`
 * tool. A `workspace: "source"` rejection refuses before dispatch; staging or
 * dispatch leftovers are discarded. Failures warn and return a tool error;
 * user aborts re-throw for host cancellation accounting.
 */
async function executeForkTask(
	rt: ForkTaskRuntime,
	toolCallId: string,
	rawParams: unknown,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
	const staged: PendingFork[] = [];
	const discardStaged = async (): Promise<void> => {
		for (const entry of staged) {
			try {
				await discardPending(rt, entry);
			} catch (cleanupError) {
				rt.pi.logger.warn("fork_task: cleaning up the staged conversation failed", { error: errorText(cleanupError) });
			}
		}
	};
	try {
		const params = paramsSchema.parse(rawParams);
		const parent = callerSession(ctx);
		if (!parent) return fail("fork_task: could not resolve the calling session in the agent registry.");
		const maxRecursionDepth = cfgTaskMaxRecursionDepth.get(parent.settings);
		const callerDepth = taskDepthOf(parent);
		// The host's executor strips `task` from a child whose depth reaches the cap (`atMaxDepth`); a fork
		// dispatched here would be that child, so refuse before staging anything.
		if (maxRecursionDepth >= 0 && callerDepth + 1 >= maxRecursionDepth) {
			return fail(
				`fork_task: reached the maximum dispatch depth (current taskDepth ${callerDepth}, task.maxRecursionDepth ${maxRecursionDepth}); a forked child would start at the cap and cannot dispatch subagents.`,
			);
		}
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

		const notes: string[] = [];
		const tasks: TaskItem[] = [];
		const resolveRole = roleResolver(parent);
		/** The first `workspace: "source"` rejection; nothing is dispatched then. */
		let refused: string | undefined;
		try {
			for (const [index, item] of params.tasks.entries()) {
				const source = await resolveSource(item.from, parent, parentFile);
				if (source.kind === "error") throw new Error(source.message);
				const agent = item.agent?.trim() || undefined;
				const role = await resolveRole(agent);
				if (role.kind === "error") throw new Error(role.message);
				const captured = captureReplica(source.request, {
					inheritReasoning: role.kind === "none" && item.effort === undefined,
					caller: parent,
				});
				const name = `${sanitizeName(item.name) ?? "Fork"}_${randomUUID().slice(0, 4)}`;
				// Without a role the fork continues the source in its workspace unless explicitly isolated;
				// inheriting the source's workspace needs an isolated child, so `workspace: "source"` defaults to one.
				const isolated = !planMode && (item.isolated ?? (role.kind === "role" || item.workspace === "source"));
				const inheritance =
					item.workspace === "source" ? await sourceInheritance(source, isolated, parent.sessionManager.getCwd()) : undefined;
				if (inheritance?.kind === "rejected") {
					refused = rejection(inheritance.code, inheritance.detail);
					break;
				}
				const shake = item.shake === true;
				const { staging, notice, shakeSummary } = await stageFork(ctx, parent, source, shake, isolated, inheritance !== undefined);
				const { response, ...capture } = captured;
				const entry: PendingFork = {
					name,
					artifactsDir,
					staging,
					replica: { ...capture, replay: shake ? { kind: "own" } : { kind: "prefix", response, notice } },
					model: role.kind === "role" ? role.model : capture.sourceModel,
					overlay: inheritance?.patch,
				};
				staged.push(entry);
				rt.pending.push(entry);
				if (shakeSummary) notes.push(`${name}: ${shakeSummary}`);
				tasks[index] = {
					name,
					// The replicated system prompt is the source's: role, shared context and assignment form the new user message.
					task: [role.kind === "role" ? role.block : "", params.context.trim(), item.task].filter((part) => part.length > 0).join("\n\n"),
					agent: FORK_AGENT,
					...(planMode ? {} : { isolated }),
					...(item.effort !== undefined ? { effort: item.effort } : {}),
					...(item.outputSchema !== undefined ? { outputSchema: item.outputSchema } : {}),
					...(item.schemaMode !== undefined ? { schemaMode: item.schemaMode } : {}),
				};
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new Error(`staging the conversation fork failed: ${errorText(error)}`, { cause: error });
		}
		if (refused !== undefined) {
			await discardStaged();
			return fail(refused);
		}

		// The native task tool requires `context`; it lands only in the child's base prompt, which replication never sends.
		const result = await taskTool.execute(toolCallId, { context: params.context, tasks }, signal, onUpdate);

		// Items the task tool never scheduled (validation errors) leave nothing staged.
		const parsed = progressSchema.safeParse(result.details);
		const scheduled = new Set(parsed.success ? parsed.data.progress.map((p) => p.index) : []);
		for (const [index, entry] of staged.entries()) {
			if (!scheduled.has(index)) await discardPending(rt, entry);
		}

		if (notes.length === 0) return result;
		return {
			...result,
			content: [...result.content, { type: "text" as const, text: `\n[fork_task] ${notes.join("; ")}` }],
		};
	} catch (error) {
		await discardStaged();
		if (signal?.aborted) throw error;
		rt.pi.logger.warn("fork_task: executing the conversation fork failed", { error: errorText(error) });
		return fail(`fork_task: ${errorText(error)}`);
	}
}

export default function forkTask(pi: ExtensionAPI): void {
	const warn = (message: string, error: unknown) => pi.logger.warn(message, { error: errorText(error) });
	serveSources(warn);
	const rt: ForkTaskRuntime = {
		pi,
		warn,
		pending: [],
		cloned: new WeakMap(),
		deltas: createDeltaStream(pi, "fork-task"),
		started: new Set(),
	};

	pi.on("before_subagent_spawn", beforeSubagentSpawn.bind(null, rt));
	pi.on("before_agent_start", beforeAgentStart.bind(null, rt));
	pi.on("tool_result", toolResult.bind(null, rt));
	pi.on("session_start", sessionStart.bind(null, rt));
	pi.on("session_shutdown", sessionShutdown.bind(null, rt));

	// `docTopics` serves xd://fork_task/<topic>; OMP keeps it on the tool object, though ToolDefinition does not declare it.
	const tool: ToolDefinition<typeof paramsSchema> & { docTopics(): Readonly<Record<string, string>> } = {
		name: "fork_task",
		label: tr("Fork Task", "分叉任务"),
		description: `${DESCRIPTION}\n\n${TOPIC_POINTERS}`,
		loadMode: "essential",
		parameters: paramsSchema,
		docTopics: forkTaskTopics,
		execute: executeForkTask.bind(null, rt),
	};
	pi.registerTool(tool);
}
