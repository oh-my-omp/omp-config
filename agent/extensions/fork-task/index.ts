// ============================================================================
// fork_task — native `task` subagents that start from a copy of the caller's
// conversation, or of another agent's named by an item's `from`.
//
// Registers fork_task plus before_subagent_spawn, before_agent_start and
// session_shutdown hooks in main and sub sessions. Reads the source agent's
// persisted session; writes temporary JSONL under the OS temp directory and
// moves it into the caller's artifact store.
// Staging failures are tool errors; spawn preparation failures block the child
// and warn, while shutdown cleanup failures warn without rejecting the hook.
//
// Every item replicates its source's actual model request: the caller's, or
// that of the live agent `from` names. replica.ts captures each session's
// provider-neutral Context through Agent.streamFn; the child reuses that
// system prompt, tool list, message prefix and (on the source's model) its
// request controls, so forks of one source share the provider cache prefix.
// The shared `context`, an `agent` role and the assignment reach the child
// only as its new user message, never as system text. Child tools execute
// against the child's session; an available yield follows the source's tools.
//
// `agent` selects the model binding (`task.agentModelOverrides`, else the
// definition's `model`) and puts that definition's prompt in a <role> block
// of the assignment; without `agent` the child runs the source's model and
// thinking level. Every child is dispatched as internal `fork:self`, so its
// tool surface is the source's, not the named agent's. Forks without `agent`
// share cwd by default, forks with `agent` are isolated by default. No
// inheritance-size or cost gate exists.
//
// The spawn itself is the built-in `task` tool, called with the same batch
// shape, so each child is an ordinary task subagent: Agent Hub row,
// `agent://`/`history://`, idle/park/revive lifecycle, isolation and its
// merge-back. Only the child's starting transcript, model, prompt and tools
// differ:
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
// Relies on omp internals (AgentRegistry, the executor's session-file path and
// hook ordering, session entry types); re-verify after every omp upgrade.
// ============================================================================
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentDefinition,
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
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgTaskAgentModelOverrides, cfgTaskDisabledAgents } from "@oh-my-pi/pi-coding-agent/task/settings";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { applyReplica, captureReplica, observeRequests, type Replica } from "./replica.ts";

const itemSchema = z.object({
	from: z.string().optional(),
	name: z.string().optional(),
	agent: z.string().optional(),
	task: z.string(),
	isolated: z.boolean().optional(),
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

const DESCRIPTION = `Fork a conversation into a native task child that continues it under the source's exact request: its system prompt, tools and message prefix are replicated unchanged, so forks of one source share the provider's cached prefix. \`context\`, an \`agent\` role and \`task\` reach the child only as its new user message, never as system text.
- The source is your conversation, or that of the live agent \`from\` names.
- Omit \`agent\` to run the source's model and thinking/request controls; the default is a shared working directory (\`isolated: false\`).
- Set \`agent\` to run that agent's model binding, with its definition prompt as a role block in the assignment. The child keeps the source's tools, so the agent's tool restrictions do not apply; a different model reuses no cache. The default is \`isolated: true\`.

Children keep native task result delivery, Agent Hub, \`agent://\`/\`history://\`, \`write agent://\` and isolated merge-back. They support idle/park/revive while their originating process and snapshot remain alive; after restart, create a fresh fork rather than cold-reviving one without its snapshot. Use ordinary \`task\` for an independent fresh perspective or when a short brief suffices.

- \`shake\` defaults to false. Explicit \`shake: true\` elides the inherited copy and writes recovery artifacts; it deliberately gives up exact inherited-message prefix reuse. There is no source-token or source-cost check.
- \`isolated\` overrides the default. Concurrent writers must explicitly use isolated workspaces. Plan mode forces shared, read-only children. Isolated children cannot be resumed after completion.
- \`from\` selects another registered agent (running or idle) whose latest request is replicated; a parked source must be woken first. Omit it for your conversation. The child's workspace still derives from the caller, not from the source's isolated checkout.
- Omit \`effort\` unless the user asks; an effort change keeps the replicated prefix.
- Each \`name\` gets a short unique suffix; use the returned id for follow-ups. The child has its own Todo and only owns the assignment, not unfinished work in inherited history.
- Forked workers must run relevant scoped checks and real runtime verification before returning; the parent owns final acceptance.

\`context\` and each item's \`task\` follow the same scoping rules as \`task\`: state target, change and acceptance. Cache reuse requires the same model and compatible request parameters, and remains subject to the provider's cache policy; adding completion tools can invalidate caches on providers without append-only tool support.`;

/**
 * Where the forked transcript and replicated request come from. `caller` is
 * the session calling fork_task; `agent` is another live registered agent
 * named by `from`, whose workspace may differ from the parent's.
 */
type ForkSource =
	| { readonly kind: "caller"; readonly session: AgentSession; readonly file: string; readonly cwd: string }
	| { readonly kind: "agent"; readonly id: string; readonly session: AgentSession; readonly file: string; readonly cwd: string };

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
			const foreign = [...new Set([source.cwd, ...(isolated ? [parentCwd] : [])])];
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
		...workspaceNotice(source, parentCwd, isolated),
		"</system-notice>",
	].join("\n");
};

/** Agent definition every fork is dispatched as; its prompt and tools are replaced by the source's. */
const FORK_AGENT = "fork:self";

/**
 * Replicas by child session file. Child sessions rebind this module's factory
 * in the same process, so the parent's write is visible to the child. Entries
 * live until the parent session shuts down, so a revived child keeps its
 * replicated contract.
 */
const replicas = new Map<string, Replica>();

type PendingFork = {
	/** Exact requested name; the allocated id's last dot-segment. */
	readonly name: string;
	readonly artifactsDir: string;
	readonly staging: string;
	readonly replica: Replica;
	/** Spawn model patterns; undefined leaves the native default. */
	readonly model: string | string[] | undefined;
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

/**
 * Resolve `from` to the source to fork: omitted (or naming the caller) forks
 * the caller; otherwise a live registered non-advisor agent, matched like
 * `history://<id>` (exact, then case-insensitive) after the caller root's
 * persisted roster is loaded, so a parked agent is named as such.
 */
async function resolveSource(from: string | undefined, parent: AgentSession, parentFile: string): Promise<SourceResolution> {
	const caller: ForkSource = { kind: "caller", session: parent, file: parentFile, cwd: parent.sessionManager.getCwd() };
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
	if (!ref.session) {
		return {
			kind: "error",
			message: `agent \`${ref.id}\` is parked; wake it with \`write agent://${ref.id}\`, then fork it while it is live.`,
		};
	}
	// execute flushes after capturing the request, so the transcript holds every replicated message.
	await ref.session.sessionManager.ensureOnDisk();
	const file = ref.session.sessionManager.getSessionFile();
	if (!file) return { kind: "error", message: `agent \`${ref.id}\` has no persisted transcript to fork.` };
	return { kind: "agent", id: ref.id, session: ref.session, file, cwd: ref.session.sessionManager.getCwd() };
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

export default function forkTask(pi: ExtensionAPI): void {
	const pending: PendingFork[] = [];
	/** Child session files of the forks each parent spawned, by parent artifacts dir. */
	const forkChildren = new Map<string, string[]>();

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
			replicas.set(target, entry.replica);
			forkChildren.set(artifactsDir, [...(forkChildren.get(artifactsDir) ?? []), target]);
			return entry.model === undefined ? undefined : { model: entry.model };
		} catch (error) {
			pi.logger.warn("fork_task: preparing the child conversation failed", { error: errorText(error) });
			return { block: true, reason: `fork_task: preparing the child conversation failed: ${errorText(error)}` };
		}
	});

	/** Child sessions whose per-call hook is installed. */
	const cloned = new WeakSet<AgentSession>();

	pi.on("before_agent_start", (_event, ctx) => {
		const session = findCallerSession(ctx);
		if (!session) return;
		try {
			observeRequests(session);
			const file = ctx.sessionManager.getSessionFile();
			const replica = file ? replicas.get(file) : undefined;
			if (!replica && ctx.agent.name === FORK_AGENT) {
				throw new Error("the fork's request snapshot is no longer available in this process; create a fresh fork from the parent");
			}
			if (!replica || cloned.has(session)) return;
			applyReplica(session, replica);
			cloned.add(session);
		} catch (error) {
			const reason = `fork_task: preparing request replication failed: ${errorText(error)}`;
			pi.logger.warn(reason);
			// Do not run a different child contract after replication failed.
			session.agent.addBeforeModelCallHook(() => {
				throw new Error(reason);
			});
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const parentFile = ctx.sessionManager.getSessionFile();
		if (!parentFile) return;
		const artifactsDir = parentFile.slice(0, -".jsonl".length);
		for (const child of forkChildren.get(artifactsDir) ?? []) replicas.delete(child);
		forkChildren.delete(artifactsDir);
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

			const staged: PendingFork[] = [];
			const notes: string[] = [];
			const tasks: TaskItem[] = [];
			const resolveRole = roleResolver(parent);
			try {
				for (const [index, item] of params.tasks.entries()) {
					const source = await resolveSource(item.from, parent, parentFile);
					if (source.kind === "error") throw new Error(source.message);
					const agent = item.agent?.trim() || undefined;
					const role = await resolveRole(agent);
					if (role.kind === "error") throw new Error(role.message);
					const captured = captureReplica(source.session, {
						shake: item.shake === true,
						inheritReasoning: role.kind === "none" && item.effort === undefined,
					});
					if (captured.kind === "unavailable") throw new Error(`cannot replicate the source's request: ${captured.reason}`);
					await source.session.sessionManager.flush();
					const name = `${sanitizeName(item.name) ?? "Fork"}_${randomUUID().slice(0, 4)}`;
					// Without a role the fork continues the source in its workspace unless explicitly isolated.
					const isolated = !planMode && (item.isolated ?? role.kind === "role");
					const { staging, shakeSummary } = await stageFork(ctx, parent, source, item.shake === true, isolated);
					const entry: PendingFork = {
						name,
						artifactsDir,
						staging,
						replica: captured.replica,
						model: role.kind === "role" ? role.model : captured.replica.sourceModel,
					};
					staged.push(entry);
					pending.push(entry);
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
				for (const entry of staged) await discard(entry);
				return fail(`fork_task: staging the conversation fork failed: ${errorText(error)}`);
			}

			// The native task tool requires `context`; it lands only in the child's base prompt, which replication never sends.
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
