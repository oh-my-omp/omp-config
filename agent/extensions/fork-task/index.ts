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
// An item has one of two meanings:
//   - With `agent`: hand the conversation to that agent. It continues from the
//     investigation another agent already did, usually on a cheaper model, so
//     it runs under its own agent definition (system prompt, model binding,
//     tools); no cache reuse is expected across a model change.
//   - Without `agent`: fork the caller itself through internal `fork:self`.
//     Pin the model in before_subagent_spawn; self.ts captures the caller's
//     actual provider-neutral Context through Agent.streamFn and reuses its
//     system, tools, message prefix and request controls in the child. Child
//     tools execute against the child's session; an available yield follows
//     the caller's tools. Assignments are new user messages, never system text.
//     Self forks share cwd by default. No inheritance-size or cost gate exists.
//
// The spawn itself is the built-in `task` tool, called with the same batch
// shape, so each child is an ordinary task subagent: Agent Hub row,
// `agent://`/`history://`, idle/park/revive lifecycle, isolation and its
// merge-back. Only the child's starting transcript (and, for a self fork, its
// model, prompt and tools) differs:
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
import { applySelf, captureSelf, observeRequests, type SelfFork } from "./self.ts";

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

const DESCRIPTION = `Fork a conversation into a native task child, with two meanings selected by each item's \`agent\`:
- Omit \`agent\` to fork yourself: the child uses your current model and thinking/request controls, system prompt and tools. It reuses your actual request prefix and prompt-cache key; \`context\` and \`task\` follow the inherited conversation as new messages, not system-prompt additions. An available \`yield\` tool follows your tools. The default is a shared working directory (\`isolated: false\`).
- Set \`agent\` to hand the conversation to that agent under its own model, system prompt and tools. Use this when an investigating agent has already established the facts and a cheaper worker should continue from them; cross-model cache reuse is not expected. The default is \`isolated: true\`.

Both modes keep native task result delivery, Agent Hub, \`agent://\`/\`history://\`, \`write agent://\` and isolated merge-back. Self forks support idle/park/revive while their originating process and snapshot remain alive; after restart, create a fresh self fork rather than cold-reviving one without its snapshot. Use ordinary \`task\` for an independent fresh perspective or when a short brief suffices.

- \`shake\` defaults to false. Explicit \`shake: true\` elides the inherited copy and writes recovery artifacts; it deliberately gives up exact inherited-message prefix reuse. There is no source-token or source-cost check.
- \`isolated\` overrides the mode's default. Concurrent writers must explicitly use isolated workspaces. Plan mode forces shared, read-only children. Isolated children cannot be resumed after completion.
- \`from\` selects another registered agent's persisted conversation (running, idle or parked), and requires an explicit \`agent\`. Omit it for the caller's conversation. The child's workspace still derives from the caller, not from the source's isolated checkout.
- Omit \`effort\` unless the user asks. Self forks inherit caller request controls unless effort is explicitly overridden. Self forks preserve the caller's tool surface; use an explicit \`agent\` to import additional eval \`tools\`.
- Each \`name\` gets a short unique suffix; use the returned id for follow-ups. The child has its own Todo and only owns the assignment, not unfinished work in inherited history.
- Forked workers must run relevant scoped checks and real runtime verification before returning; read-only roles remain read-only. The parent owns final acceptance.

\`context\` and each item's \`task\` follow the same scoping rules as \`task\`: state target, change and acceptance. Cache reuse requires the same model and compatible request parameters, and remains subject to the provider's cache policy; adding completion tools can invalidate caches on providers without append-only tool support.`;

/**
 * Where the forked transcript comes from. `caller` is the session calling
 * fork_task; `agent` is another registered agent named by `from`, whose
 * workspace (`cwd`, unknown when neither its live session nor its header
 * records one) may differ from the parent's.
 */
type ForkSource =
	| { readonly kind: "caller"; readonly file: string; readonly cwd: string }
	| { readonly kind: "agent"; readonly id: string; readonly file: string; readonly cwd: string | undefined };

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

const forkNotice = (source: ForkSource, parentCwd: string, isolated: boolean, self: boolean): string => {
	const origin =
		source.kind === "caller"
			? "Above: the conversation of the parent agent that spawned you, copied as background."
			: `Above: the conversation of agent \`${source.id}\`, copied as background. \`${source.id}\` is not your parent: the agent that spawned you receives your result.`;
	const owner = source.kind === "caller" ? "the parent" : `\`${source.id}\``;
	const contract = self
		? "You are a fork of the parent: the same model, system prompt and tools. The parent keeps the conversation with the user. Deliver your result with `yield` when available, otherwise finish with your final report."
		: "It ran under its own role, tools, and rules; yours are the ones in your system prompt.";
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

/** Agent definition a self fork is dispatched as; its prompt and tools are replaced by the caller's. */
const SELF_AGENT = "fork:self";

/**
 * Self forks by child session file. Child sessions rebind this module's
 * factory in the same process, so the parent's write is visible to the child.
 * Entries live until the parent session shuts down, so a revived child keeps
 * its clone contract.
 */
const selfForks = new Map<string, SelfFork>();

type PendingFork = {
	/** Exact requested name; the allocated id's last dot-segment. */
	readonly name: string;
	readonly artifactsDir: string;
	readonly staging: string;
	/** Set for an item without `agent`. */
	readonly self?: SelfFork;
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
	self: boolean,
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
				content: forkNotice(source, parentCwd, isolated, self),
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
	return { kind: "agent", id: ref.id, file, cwd };
}

export default function forkTask(pi: ExtensionAPI): void {
	const pending: PendingFork[] = [];
	/** Child session files of the self forks each parent spawned, by parent artifacts dir. */
	const selfChildren = new Map<string, string[]>();

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
			if (!entry.self) return undefined;
			selfForks.set(target, entry.self);
			selfChildren.set(artifactsDir, [...(selfChildren.get(artifactsDir) ?? []), target]);
			return { model: entry.self.model };
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
			const spec = file ? selfForks.get(file) : undefined;
			if (!spec && ctx.agent.name === SELF_AGENT) {
				throw new Error("the self-fork request snapshot is no longer available in this process; create a fresh fork from the parent");
			}
			if (!spec || cloned.has(session)) return;
			applySelf(session, spec);
			cloned.add(session);
		} catch (error) {
			const reason = `fork_task: preparing self-fork request replication failed: ${errorText(error)}`;
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
		for (const child of selfChildren.get(artifactsDir) ?? []) selfForks.delete(child);
		selfChildren.delete(artifactsDir);
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
			if (params.tasks.some((item) => !item.agent?.trim() && (item.tools?.length ?? 0) > 0)) {
				return fail(
					"fork_task: a self fork preserves the caller's tools; set an explicit agent to import additional eval tools. Nothing was dispatched.",
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

			const staged: PendingFork[] = [];
			const notes: string[] = [];
			const tasks: TaskItem[] = [];
			try {
				for (const [index, item] of params.tasks.entries()) {
					const source = await resolveSource(item.from, parent, parentFile);
					if (source.kind === "error") throw new Error(source.message);
					const agent = item.agent?.trim() || undefined;
					let self: SelfFork | undefined;
					if (!agent) {
						const captured = captureSelf(parent, item.shake === true, item.effort !== undefined);
						if (captured.kind === "unavailable") throw new Error(captured.reason);
						self = captured.fork;
					}
					const name = `${sanitizeName(item.name) ?? "Fork"}_${randomUUID().slice(0, 4)}`;
					// A self fork shares the caller's workspace unless explicitly isolated.
					const isolated = !planMode && (item.isolated ?? !self);
					const { staging, shakeSummary } = await stageFork(ctx, parent, source, item.shake === true, isolated, self !== undefined);
					const entry: PendingFork = { name, artifactsDir, staging, ...(self ? { self } : {}) };
					staged.push(entry);
					pending.push(entry);
					if (shakeSummary) notes.push(`${name}: ${shakeSummary}`);
					tasks[index] = {
						name,
						// A self fork's prompt is the caller's, so the shared context rides on the assignment.
						task: self && params.context.trim() ? `${params.context}\n\n${item.task}` : item.task,
						agent: agent ?? SELF_AGENT,
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
