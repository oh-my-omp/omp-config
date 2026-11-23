import path from "node:path";
import type { AgentMessage, FileOperations, SessionEntry } from "@oh-my-pi/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionCompactingEvent,
	SessionCompactingResult,
} from "@oh-my-pi/pi-coding-agent";
import { createDeltaStream, type DeltaStream } from "./context-delta.ts";

export const COMPACT_REGISTRY_SYMBOL = Symbol.for("omomp.shared.compactRegistry");
export const COMPACT_HANDOFF_REVISION = 2;
export const OMP_SNAPCOMPACT_FILE_LIMIT = 20;

export type CompactExtensionAPI = Pick<ExtensionAPI, "on"> & {
	readonly events?: unknown;
	readonly logger?: { readonly warn?: (message: string, context?: Record<string, unknown>) => void };
};

export interface CompactPluginContext {
	readonly cwd: string;
	readonly branchEntries: readonly SessionEntry[];
	readonly messagesToSummarize: readonly AgentMessage[];
	readonly extensionCtx?: ExtensionContext;
	readonly runtimeFlags?: Readonly<Record<string, unknown>>;
}

export type PostCompactInjectionSpec =
	| {
			readonly source: string;
			readonly delivery: "delta-stream";
			readonly content: string;
	  }
	| {
			readonly source: string;
			readonly delivery: "plugin-managed";
			readonly content?: string;
	  };

export interface StatefulHarnessHandoff<TState> {
	readonly kind: "stateful-handoff";
	readonly pluginId: string;
	captureState(ctx: CompactPluginContext): TState | null;
	renderCompactPromptClaim(state: TState): string;
	renderPostCompactInjection(state: TState): PostCompactInjectionSpec;
}

export interface StatelessNoiseGuard {
	readonly kind: "stateless-noise-guard";
	readonly pluginId: string;
	renderNoiseGuardDirective(ctx: CompactPluginContext): string | null;
}

export type CompactContribution<TState = unknown> = StatefulHarnessHandoff<TState> | StatelessNoiseGuard;

export function defineStatefulHarnessHandoff<TState>(spec: Omit<StatefulHarnessHandoff<TState>, "kind">): StatefulHarnessHandoff<TState> {
	return { kind: "stateful-handoff", ...spec };
}

export function defineStatelessNoiseGuard(spec: Omit<StatelessNoiseGuard, "kind">): StatelessNoiseGuard {
	return { kind: "stateless-noise-guard", ...spec };
}

export interface NormalizedPathResult {
	readonly path: string | null;
	readonly hadQuery: boolean;
	readonly filteredReason: "url-scheme" | "ephemeral-or-external" | null;
}

export interface FileOpsPruneReport {
	readonly totalInputPaths: number;
	readonly strippedQueryCount: number;
	readonly filteredNoiseCount: number;
	readonly keptUniqueCandidateCount: number;
	readonly selectedCount: number;
	readonly repoSourcePathsSelected: readonly string[];
	readonly selectedPaths: readonly string[];
}

export interface CapturedHandoffRecord {
	readonly pluginId: string;
	readonly claim: string;
	readonly injection: PostCompactInjectionSpec;
}

export interface CapturedNoiseGuardRecord {
	readonly pluginId: string;
	readonly directive: string;
}

export interface PreparedCompactHandoff {
	readonly fileOpsPruneReport: FileOpsPruneReport;
	readonly activeHandoffs: readonly CapturedHandoffRecord[];
	readonly inactiveStatefulPluginIds: readonly string[];
	readonly noiseGuards: readonly CapturedNoiseGuardRecord[];
	readonly compactingResult: SessionCompactingResult;
}

export const CORE_HARNESS_PROVIDED_CLAIMS: readonly string[] = [
	"`omp` Core System Prompt, `<project-context>` (`<workstation>`, root `AGENTS.md`/`CLAUDE.md`, git status), tool schemas, and `<skills>` — sent out-of-band on every turn; NEVER restate coding/tool-discipline rules.",
	`\`omp\` Core \`<files>\` — deterministically rendered by \`@oh-my-pi/snapcompact\` from the pruned top-${OMP_SNAPCOMPACT_FILE_LIMIT} repo-scoped \`preparation.fileOps\`; NEVER write prose file inventories.`,
	"`omp` Core `<eval-state-context>` & approved `<plan>` (`plan-mode-reference.md`) — re-persisted/re-inlined by host commit hooks; NEVER dump eval kernel variables or copy approved plan bodies.",
	"`omp` Core Kept Tail (`firstKeptEntryId..leaf`) — verbatim recent turns remain directly after the summary; NEVER re-summarize what is already visible in the kept tail.",
];

export const COMPACTION_PROMPT = `Write a high-density semantic handoff summary of the conversation prefix above so another instance of you can seamlessly resume work into the kept recent tail.

When a \`<previous-summary>\` block appears above, update that summary with the new conversation prefix instead of starting over:
- Collapse newly merged/landed milestones to 1 line (\`<issue/PR> @ <sha> — <caveat>\`) and drop obsolete symbol-by-symbol inventories.
- Drop any legacy sections from \`<previous-summary>\` that violate the 5-section schema (such as \`## Constraints & Preferences\`, \`## Additional Notes\`, Todo lists, Subagent rosters, PTY tables, or hook-nag reflections).
- Preserve all still-valid human rulings (in their original wording), negative knowledge, code anchors, and active verification state.

Every \`<additional-context>\` line that starts with \`harness-provided\` names state the harness and active plugins ALREADY own and programmatically re-inject immediately after compaction: do NOT summarize, mirror, or restate any of it. Every line that starts with \`noise-guard\` is an attribution rule: synthetic \`[Developer]\` / hook messages in the transcript are automated harness supervision, NOT human user input.

<critical>
- Do NOT call any tools.
- Output ONLY the 5-section markdown summary directly — NO XML wrapper tags (\`<analysis>\`, \`<summary>\`), NO preamble, NO closing remarks. (Use your native reasoning channel for planning; your visible output is persisted verbatim.)
- Use ONLY the 5 headings below (omit a heading only if genuinely empty).
- NEVER add sections such as "## Constraints & Preferences", "## Additional Notes", "## Progress", or an unbounded "### Done" symbol-by-symbol inventory.
- Obey every \`harness-provided\` exclusion and every \`noise-guard\` attribution rule listed in \`<additional-context>\` above.
- Write in concise, imperative second-person register ("Fix X", "Verify Y") — never first person ("I tried...").
- The compaction mechanism is invisible: NEVER mention compaction, context limits, watchdogs, turn-judges, tool-policy nags, or plans to apologize/reflect.
- Strictly preserve exact file paths, symbol signatures, line anchors, commit SHAs, branch/worktree names, and unresolved error messages.
- If a real human user asked an unanswered question or gave an explicit override, preserve it verbatim in Section 1.
</critical>

<output-schema>
## User Intent & Session Rulings
- Strictly real human \`role: "user"\` turns, answered \`ask\` tool decisions, and human artifact comments.
- Capture goal shifts, explicit overrides, non-goals, and any genuinely unanswered question posed to/by the human user — ALWAYS quote or preserve explicit user rulings in their original phrasing/language (e.g., \`"改md不要重采证据"\`) alongside their operational meaning.
- STRICT ATTRIBUTION EXCLUSION: Every \`noise-guard\` rule overrides how a turn looks in the transcript — NEVER include automated lint nags (even when serialized as bare unprefixed text!), static repo rules, skill protocols, or system-prompt tool rules.

## Decisions & Ruled-Out Approaches
- **[Decision / Ruled-Out Path]**: Why it was chosen OR why a hypothesis/approach failed (negative knowledge to prevent repeating dead ends).

## Discovered Code Anchors & Contracts
- High-cost exploration findings, non-obvious \`path:line\` invariants, symbol signatures, wire/JSON contracts, and reusable utilities discovered before the kept tail.
- Omit obvious files and omit raw file inventories (covered by host \`<files>\`).

## Landed Milestones & Active Verification State
- Landed milestones: STRICTLY 1 line per merged/landed PR or commit (\`<issue/PR> @ <sha> — <residual caveat if any>\`); drop function-by-function inventories once merged.
- Active uncommitted worktree/branch state (branch name, HEAD SHA, dirty files/intent).
- Verification/evidence pass/fail ledger (exact commands run, what passed vs. failed, and which evidence records are valid vs. invalidated).

## Handoff to Kept Tail
- Concrete immediate next action(s) bridging this compacted prefix into the verbatim kept tail immediately following the summary.
- Unify state across split turns so completed earlier turns never contradict the active in-flight turn in the kept tail.
</output-schema>`;

function contextLine(kind: "harness-provided" | "noise-guard", source: string, text: string): string {
	return `${kind} [${source}] ${text.replace(/\s+/g, " ").trim()}`;
}

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const QUERY_STRING_RE = /\?.*$/;
const JQ_SUFFIX_RE = /:jq:[\s\S]*$/i;
const LINE_RANGE_RE = /:\d+(?:-\d+)?$/;
const EXCLUDED_PATH_PATTERNS: readonly RegExp[] = [
	/^\/(?:private\/)?tmp(?:\/|$)/,
	/^\/var\/folders(?:\/|$)/,
	/(?:^|\/)\.claude(?:\/|$)/,
	/(?:^|\/)\.local\/state\/ghc(?:\/|$)/,
	/(?:^|\/)\.omp(?:\/|$)/,
];

export function normalizeFilePath(rawPath: string, cwd?: string): NormalizedPathResult {
	const trimmed = rawPath.trim();
	if (!trimmed) return { path: null, hadQuery: false, filteredReason: "ephemeral-or-external" };
	if (URL_SCHEME_RE.test(trimmed)) {
		return { path: null, hadQuery: trimmed.includes("?") || JQ_SUFFIX_RE.test(trimmed), filteredReason: "url-scheme" };
	}
	const hadQuery = QUERY_STRING_RE.test(trimmed) || JQ_SUFFIX_RE.test(trimmed);
	let clean = trimmed.replace(QUERY_STRING_RE, "").replace(JQ_SUFFIX_RE, "").replace(LINE_RANGE_RE, "");
	for (const re of EXCLUDED_PATH_PATTERNS) {
		if (re.test(clean)) return { path: null, hadQuery, filteredReason: "ephemeral-or-external" };
	}
	if (cwd && path.isAbsolute(clean)) {
		const rel = path.relative(cwd, clean);
		if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) clean = rel;
	}
	return { path: clean.replace(/^\.\//, ""), hadQuery, filteredReason: null };
}

interface CandidateFileOp {
	readonly path: string;
	readonly wasRead: boolean;
	readonly wasEdited: boolean;
	readonly wasWritten: boolean;
	readonly recencyIndex: number;
	readonly isRepoRelative: boolean;
	readonly isDotPath: boolean;
}

function tierOf(op: CandidateFileOp): number {
	const isModified = op.wasEdited || op.wasWritten;
	if (isModified && op.isRepoRelative && !op.isDotPath) return 0;
	if (isModified && op.isRepoRelative && op.isDotPath) return 1;
	if (!isModified && op.isRepoRelative && !op.isDotPath) return 2;
	if (!isModified && op.isRepoRelative && op.isDotPath) return 3;
	return isModified ? 4 : 5;
}

function buildRecencyMap(messages: readonly AgentMessage[], cwd?: string): Map<string, number> {
	const recency = new Map<string, number>();
	let tick = 0;
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (typeof block !== "object" || block === null || block.type !== "toolCall") continue;
			if (block.name !== "read" && block.name !== "edit" && block.name !== "write") continue;
			const args = block.arguments as Record<string, unknown> | undefined;
			const rawPath = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : undefined;
			if (!rawPath) continue;
			const norm = normalizeFilePath(rawPath, cwd);
			if (norm.path) {
				tick += 1;
				recency.set(norm.path, tick);
			}
		}
	}
	return recency;
}

export function prunePreparationFileOpsInPlace(
	fileOps: FileOperations,
	messages: readonly AgentMessage[],
	cwd?: string,
	limit: number = OMP_SNAPCOMPACT_FILE_LIMIT,
): FileOpsPruneReport {
	const recencyMap = buildRecencyMap(messages, cwd);
	const totalInputPaths = fileOps.read.size + fileOps.edited.size + fileOps.written.size;
	let strippedQueryCount = 0;
	let filteredNoiseCount = 0;
	let fallbackTick = 0;
	const candidates = new Map<string, CandidateFileOp>();

	const ingest = (raw: string, kind: "read" | "edited" | "written") => {
		const norm = normalizeFilePath(raw, cwd);
		if (norm.hadQuery) strippedQueryCount += 1;
		if (norm.path === null) {
			filteredNoiseCount += 1;
			return;
		}
		fallbackTick += 1;
		const p = norm.path;
		const existing = candidates.get(p);
		const msgTick = recencyMap.get(p);
		const recencyIndex = msgTick !== undefined ? 1_000_000 + msgTick : fallbackTick;
		candidates.set(p, {
			path: p,
			wasRead: (existing?.wasRead ?? false) || kind === "read",
			wasEdited: (existing?.wasEdited ?? false) || kind === "edited",
			wasWritten: (existing?.wasWritten ?? false) || kind === "written",
			recencyIndex: existing ? Math.max(existing.recencyIndex, recencyIndex) : recencyIndex,
			isRepoRelative: !path.isAbsolute(p),
			isDotPath: p.startsWith("."),
		});
	};

	for (const p of fileOps.read) ingest(p, "read");
	for (const p of fileOps.edited) ingest(p, "edited");
	for (const p of fileOps.written) ingest(p, "written");

	const ranked = [...candidates.values()].sort(
		(a, b) => tierOf(a) - tierOf(b) || b.recencyIndex - a.recencyIndex || a.path.localeCompare(b.path),
	);
	const selected = ranked.slice(0, limit);

	fileOps.read.clear();
	fileOps.edited.clear();
	fileOps.written.clear();
	for (const item of selected) {
		if (item.wasRead) fileOps.read.add(item.path);
		if (item.wasEdited) fileOps.edited.add(item.path);
		if (item.wasWritten) fileOps.written.add(item.path);
	}

	const selectedPaths = selected.map((s) => s.path);
	return {
		totalInputPaths,
		strippedQueryCount,
		filteredNoiseCount,
		keptUniqueCandidateCount: ranked.length,
		selectedCount: selected.length,
		repoSourcePathsSelected: selectedPaths.filter((p) => !path.isAbsolute(p) && !p.startsWith(".")),
		selectedPaths,
	};
}

// Never splice before or inside an Anthropic native compaction fold (`session-context.ts:735-739`);
// splitting `compactionSummary` from its directly following retained assistant + toolResult turn breaks signed thinking.
export function computeSafePostCompactInsertIndex(messages: readonly AgentMessage[]): number {
	const idx = messages.findLastIndex((m) => m.role === "compactionSummary");
	if (idx < 0) return 0;
	let insertAt = idx + 1;
	const summaryMsg = messages[idx];
	const payload =
		typeof summaryMsg === "object" && summaryMsg !== null && "providerPayload" in summaryMsg
			? (summaryMsg as { readonly providerPayload?: { readonly type?: string } }).providerPayload
			: undefined;
	if (payload?.type === "anthropicCompaction") {
		if (messages[insertAt]?.role === "assistant") insertAt += 1;
		while (messages[insertAt]?.role === "toolResult") insertAt += 1;
	}
	return insertAt;
}

type ErasedContribution =
	| {
			readonly kind: "stateful-handoff";
			readonly pluginId: string;
			readonly evaluate: (ctx: CompactPluginContext) => CapturedHandoffRecord | null;
	  }
	| {
			readonly kind: "stateless-noise-guard";
			readonly pluginId: string;
			readonly evaluate: (ctx: CompactPluginContext) => CapturedNoiseGuardRecord | null;
	  };

function eraseContribution<TState>(contribution: CompactContribution<TState>): ErasedContribution {
	if (contribution.kind === "stateful-handoff") {
		return {
			kind: "stateful-handoff",
			pluginId: contribution.pluginId,
			evaluate(ctx) {
				const state = contribution.captureState(ctx);
				if (state === null) return null;
				return {
					pluginId: contribution.pluginId,
					claim: contribution.renderCompactPromptClaim(state).trim(),
					injection: contribution.renderPostCompactInjection(state),
				};
			},
		};
	}
	return {
		kind: "stateless-noise-guard",
		pluginId: contribution.pluginId,
		evaluate(ctx) {
			const directive = contribution.renderNoiseGuardDirective(ctx);
			if (!directive || directive.trim().length === 0) return null;
			return { pluginId: contribution.pluginId, directive: directive.trim() };
		},
	};
}

type BarrierKind = "auto" | "manual";

interface SessionCompactionState {
	barrier: BarrierKind | null;
	deferredCallbacks: Map<string, () => void>;
	fileOpsPruneCount: number;
	prepared?: PreparedCompactHandoff;
	armedCompactionId?: string;
	pendingDeltaHandoffs: CapturedHandoffRecord[];
}

interface CompactHandoffStore {
	readonly contributions: Map<string, ErasedContribution>;
	readonly deltaStreams: Map<string, DeltaStream>;
	readonly attachedEvents: WeakMap<object, Set<string>>;
	readonly prunedPreparations: WeakSet<object>;
	readonly sessionStates: WeakMap<object, SessionCompactionState>;
	readonly runtimeFlagsBySession: WeakMap<object, Readonly<Record<string, unknown>>>;
}

function createStore(): CompactHandoffStore {
	return {
		contributions: new Map(),
		deltaStreams: new Map(),
		attachedEvents: new WeakMap(),
		prunedPreparations: new WeakSet(),
		sessionStates: new WeakMap(),
		runtimeFlagsBySession: new WeakMap(),
	};
}

const EMPTY_PRUNE_REPORT: FileOpsPruneReport = {
	totalInputPaths: 0,
	strippedQueryCount: 0,
	filteredNoiseCount: 0,
	keptUniqueCandidateCount: 0,
	selectedCount: 0,
	repoSourcePathsSelected: [],
	selectedPaths: [],
};

function guarded<T>(pi: CompactExtensionAPI, hookName: string, run: () => T): T | undefined {
	try {
		return run();
	} catch (error) {
		pi.logger?.warn?.(`compact-handoff ${hookName} hook failed`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export class SharedCompactCoordinator {
	readonly revision: number = COMPACT_HANDOFF_REVISION;
	readonly store: CompactHandoffStore;

	constructor(store: CompactHandoffStore) {
		this.store = store;
	}

	register<TState>(contribution: CompactContribution<TState>): void {
		this.store.contributions.set(contribution.pluginId, eraseContribution(contribution));
	}

	registerStrict<TState>(contribution: CompactContribution<TState>): void {
		if (this.store.contributions.has(contribution.pluginId)) {
			throw new Error(`Duplicate CompactContribution registration for pluginId="${contribution.pluginId}"`);
		}
		this.register(contribution);
	}

	resetForTest(): void {
		this.store.contributions.clear();
		this.store.deltaStreams.clear();
	}

	listPluginIds(): readonly string[] {
		return [...this.store.contributions.keys()];
	}

	setRuntimeFlags(sessionManager: object, flags: Readonly<Record<string, unknown>>): void {
		this.store.runtimeFlagsBySession.set(sessionManager, flags);
	}

	getLastPrepared(sessionManager: object): PreparedCompactHandoff | undefined {
		return this.store.sessionStates.get(sessionManager)?.prepared;
	}

	getFileOpsPruneCount(sessionManager: object): number {
		return this.store.sessionStates.get(sessionManager)?.fileOpsPruneCount ?? 0;
	}

	isCompacting(sessionManager: object): boolean {
		return (this.store.sessionStates.get(sessionManager)?.barrier ?? null) !== null;
	}

	enterCompactionBarrier(sessionManager: object, signal?: AbortSignal, kind: BarrierKind = "manual"): void {
		const st = this.#getSessionState(sessionManager);
		if (st.barrier !== "auto") st.barrier = kind;
		if (!signal) return;
		if (signal.aborted) {
			this.releaseCompactionBarrier(sessionManager);
			return;
		}
		signal.addEventListener("abort", () => this.releaseCompactionBarrier(sessionManager), { once: true });
	}

	deferDuringCompaction(sessionManager: object, key: string, fn: () => void): boolean {
		const st = this.#getSessionState(sessionManager);
		if (st.barrier === null) {
			fn();
			return false;
		}
		st.deferredCallbacks.set(key, fn);
		return true;
	}

	releaseCompactionBarrier(sessionManager: object): number {
		const st = this.store.sessionStates.get(sessionManager);
		if (!st) return 0;
		st.barrier = null;
		if (st.deferredCallbacks.size === 0) return 0;
		const queued = [...st.deferredCallbacks.values()];
		st.deferredCallbacks.clear();
		for (const fn of queued) fn();
		return queued.length;
	}

	#getSessionState(sessionManager: object): SessionCompactionState {
		let state = this.store.sessionStates.get(sessionManager);
		if (!state) {
			state = {
				barrier: null,
				deferredCallbacks: new Map(),
				fileOpsPruneCount: 0,
				pendingDeltaHandoffs: [],
			};
			this.store.sessionStates.set(sessionManager, state);
		}
		return state;
	}

	#getDeltaStream(source: string): DeltaStream {
		let stream = this.store.deltaStreams.get(source);
		if (!stream) {
			stream = createDeltaStream(source);
			this.store.deltaStreams.set(source, stream);
		}
		return stream;
	}

	handleAutoCompactionStart(ctx: ExtensionContext): void {
		this.enterCompactionBarrier(ctx.sessionManager, undefined, "auto");
	}

	handleBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): undefined {
		this.enterCompactionBarrier(ctx.sessionManager, event.signal);
		const st = this.#getSessionState(ctx.sessionManager);
		const prefixMessages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];

		let fileOpsPruneReport: FileOpsPruneReport;
		if (!this.store.prunedPreparations.has(event.preparation)) {
			this.store.prunedPreparations.add(event.preparation);
			fileOpsPruneReport = prunePreparationFileOpsInPlace(event.preparation.fileOps, prefixMessages, ctx.cwd);
			st.fileOpsPruneCount += 1;
		} else {
			fileOpsPruneReport = st.prepared?.fileOpsPruneReport ?? EMPTY_PRUNE_REPORT;
		}

		st.prepared = this.prepareSnapshot(
			{
				cwd: ctx.cwd,
				branchEntries: event.branchEntries,
				messagesToSummarize: prefixMessages,
				extensionCtx: ctx,
				runtimeFlags: this.store.runtimeFlagsBySession.get(ctx.sessionManager),
			},
			fileOpsPruneReport,
		);
		return undefined;
	}

	handleCompacting(event: SessionCompactingEvent, ctx: ExtensionContext): SessionCompactingResult {
		this.enterCompactionBarrier(ctx.sessionManager);
		const st = this.#getSessionState(ctx.sessionManager);
		if (!st.prepared) {
			st.prepared = this.prepareSnapshot(
				{
					cwd: ctx.cwd,
					branchEntries: ctx.sessionManager.getEntries(),
					messagesToSummarize: event.messages,
					extensionCtx: ctx,
					runtimeFlags: this.store.runtimeFlagsBySession.get(ctx.sessionManager),
				},
				EMPTY_PRUNE_REPORT,
			);
		}
		return st.prepared.compactingResult;
	}

	handleSessionCompact(event: SessionCompactEvent, ctx: ExtensionContext): void {
		const st = this.store.sessionStates.get(ctx.sessionManager);
		if (st?.prepared && st.armedCompactionId !== event.compactionEntry.id) {
			st.armedCompactionId = event.compactionEntry.id;
			st.pendingDeltaHandoffs = st.prepared.activeHandoffs.filter((handoff) => handoff.injection.delivery === "delta-stream");
		}
		this.releaseCompactionBarrier(ctx.sessionManager);
	}

	handleAutoCompactionEnd(ctx: ExtensionContext): void {
		this.releaseCompactionBarrier(ctx.sessionManager);
	}

	handleAgentStart(ctx: ExtensionContext): void {
		if (this.store.sessionStates.get(ctx.sessionManager)?.barrier === "manual") {
			this.releaseCompactionBarrier(ctx.sessionManager);
		}
	}

	handleBeforeAgentStart(ctx: ExtensionContext) {
		const st = this.store.sessionStates.get(ctx.sessionManager);
		if (!st || st.pendingDeltaHandoffs.length === 0) return undefined;
		const pending = st.pendingDeltaHandoffs;
		st.pendingDeltaHandoffs = [];
		const deliveredBlocks: string[] = [];
		for (const handoff of pending) {
			if (handoff.injection.delivery !== "delta-stream") continue;
			const stream = this.#getDeltaStream(handoff.injection.source);
			stream.turnStarted();
			const res = stream.atPrompt(ctx, { kind: "text", body: handoff.injection.content });
			if (res) deliveredBlocks.push(res.message.content);
		}
		if (deliveredBlocks.length === 0) return undefined;
		return {
			message: {
				customType: "omomp.shared.compact-handoff",
				content: deliveredBlocks.join("\n\n"),
				display: false,
				attribution: "agent" as const,
			},
		};
	}

	attachToHost(pi: CompactExtensionAPI, hostKey?: object): void {
		const key = hostKey ?? (typeof pi.events === "object" && pi.events !== null ? pi.events : pi);
		const attached = this.store.attachedEvents.get(key) ?? new Set<string>();
		this.store.attachedEvents.set(key, attached);
		const claim = (event: string): boolean => {
			if (attached.has(event)) return false;
			attached.add(event);
			return true;
		};

		if (claim("auto_compaction_start")) {
			pi.on("auto_compaction_start", (_event, ctx) =>
				guarded(pi, "auto_compaction_start", () => getSharedCompactCoordinator().handleAutoCompactionStart(ctx)),
			);
		}
		if (claim("session_before_compact")) {
			pi.on("session_before_compact", (event, ctx) =>
				guarded(pi, "session_before_compact", () => getSharedCompactCoordinator().handleBeforeCompact(event, ctx)),
			);
		}
		if (claim("session.compacting")) {
			pi.on("session.compacting", (event, ctx) =>
				guarded(pi, "session.compacting", () => getSharedCompactCoordinator().handleCompacting(event, ctx)),
			);
		}
		if (claim("session_compact")) {
			pi.on("session_compact", (event, ctx) =>
				guarded(pi, "session_compact", () => getSharedCompactCoordinator().handleSessionCompact(event, ctx)),
			);
		}
		if (claim("auto_compaction_end")) {
			pi.on("auto_compaction_end", (_event, ctx) =>
				guarded(pi, "auto_compaction_end", () => getSharedCompactCoordinator().handleAutoCompactionEnd(ctx)),
			);
		}
		if (claim("agent_start")) {
			pi.on("agent_start", (_event, ctx) => guarded(pi, "agent_start", () => getSharedCompactCoordinator().handleAgentStart(ctx)));
		}
		if (claim("before_agent_start")) {
			pi.on("before_agent_start", (_event, ctx) =>
				guarded(pi, "before_agent_start", () => getSharedCompactCoordinator().handleBeforeAgentStart(ctx)),
			);
		}
	}

	prepareSnapshot(ctx: CompactPluginContext, fileOpsPruneReport: FileOpsPruneReport): PreparedCompactHandoff {
		const activeHandoffs: CapturedHandoffRecord[] = [];
		const inactiveStatefulPluginIds: string[] = [];
		const noiseGuards: CapturedNoiseGuardRecord[] = [];

		for (const entry of this.store.contributions.values()) {
			if (entry.kind === "stateful-handoff") {
				const captured = entry.evaluate(ctx);
				if (captured === null) {
					inactiveStatefulPluginIds.push(entry.pluginId);
				} else {
					activeHandoffs.push(captured);
				}
			} else {
				const guard = entry.evaluate(ctx);
				if (guard !== null) noiseGuards.push(guard);
			}
		}

		const context = [
			...CORE_HARNESS_PROVIDED_CLAIMS.map((claim) => contextLine("harness-provided", "omp-core", claim)),
			...activeHandoffs.map((handoff) => contextLine("harness-provided", handoff.pluginId, handoff.claim)),
			...noiseGuards.map((guard) => contextLine("noise-guard", guard.pluginId, guard.directive)),
		];

		return {
			fileOpsPruneReport,
			activeHandoffs,
			inactiveStatefulPluginIds,
			noiseGuards,
			compactingResult: { prompt: COMPACTION_PROMPT, context },
		};
	}
}

function isRevisionedCoordinator(value: unknown): value is SharedCompactCoordinator {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "revision") === "number" &&
		typeof Reflect.get(value, "store") === "object"
	);
}

export function getSharedCompactCoordinator(): SharedCompactCoordinator {
	const existing: unknown = Reflect.get(globalThis, COMPACT_REGISTRY_SYMBOL);
	const current = isRevisionedCoordinator(existing) ? existing : undefined;
	if (current && current.revision >= COMPACT_HANDOFF_REVISION) return current;
	const coordinator = new SharedCompactCoordinator(current?.store ?? createStore());
	Reflect.set(globalThis, COMPACT_REGISTRY_SYMBOL, coordinator);
	return coordinator;
}

export function registerCompactHandoff<TState>(
	pi: CompactExtensionAPI,
	contribution: CompactContribution<TState>,
	hostKey?: object,
): SharedCompactCoordinator {
	const coordinator = getSharedCompactCoordinator();
	coordinator.register(contribution);
	coordinator.attachToHost(pi, hostKey);
	return coordinator;
}

export const registerCompactContribution = registerCompactHandoff;

export function isCompacting(sessionManager: object): boolean {
	return getSharedCompactCoordinator().isCompacting(sessionManager);
}

export function enterCompactionBarrier(sessionManager: object, signal?: AbortSignal): void {
	getSharedCompactCoordinator().enterCompactionBarrier(sessionManager, signal);
}

export function deferDuringCompaction(sessionManager: object, key: string, fn: () => void): boolean {
	return getSharedCompactCoordinator().deferDuringCompaction(sessionManager, key, fn);
}

export function releaseCompactionBarrier(sessionManager: object): number {
	return getSharedCompactCoordinator().releaseCompactionBarrier(sessionManager);
}
