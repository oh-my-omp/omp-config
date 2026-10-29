// ============================================================================
// user-prompt-inject — show chosen subagents what the human actually asked.
//
// WHY THIS EXISTS. A mentor or discussant only knows what its advisee tells
// it, so it can only echo the advisee's framing back. This extension renders a
// `PROMPT-INJECT-*.md` template with the root main session's user prompts and
// hands it to the targeted subagents on every model call. OMP has no native
// way to do this: `before_subagent_spawn` can only reroute the model or block,
// and `before_agent_start` does not fire when an idle or parked subagent is
// woken by an IRC message (`write agent://<id>`).
//
// FILE FORMAT. `PROMPT-INJECT-<label>.md`, discovered like `WATCHDOG-*.md`:
//   - user level:  <extension dir>/PROMPT-INJECT-*.md (beside this index.ts)
//   - repo level:  <dir>/PROMPT-INJECT-*.md and <dir>/.omp/PROMPT-INJECT-*.md,
//                  walking from cwd up to the git root.
// Frontmatter (between `---` fences), one `key: value` per line. Only whole-line
// `#` comments are skipped; text after a value is part of the value.
//   target:  mentor:default, discuss:steady
//   name:    user-goal
//   enabled: true
// `target` is required (agent names, or `*` for every subagent). `name`
// defaults to the file label. `enabled` defaults to true; when present, only
// true/yes/on/1 (case-insensitive, quotes allowed) keep the file enabled.
// Body = template. `user_prompt` is the root session's user prompts in
// chronological order (0 = first):
//   {{user_prompt[0]}}    first prompt;   {{user_prompt[-1]}} latest;
//   {{user_prompt[-3]}}   third from the latest;
//   {{user_prompt[3:e]}}  slice, end-exclusive, `e` = end; bounds may be negative.
// A scalar out of range renders empty; slice bounds clamp. A slice renders each
// element as `<user_prompt index="N">…</user_prompt>` (N = 0-based position),
// one per line block. `{{ask_answers}}` renders every decision the user made in
// the root session's `ask` calls, oldest first, each call as
// `<ask_answer index="N">question → answer…</ask_answer>` (one line per
// answered question; a cancelled or refused ask is left out); it renders
// empty when there are none. Any other `{{user_prompt…}}` / `{{ask_answers…}}`
// form makes the file invalid (skipped with a warning). Each prompt is the
// message's text blocks joined by newlines and trimmed; text-empty messages
// are dropped and take no index. Prompt text is never re-expanded.
//
// SOURCE. The root is found by walking `ctx.agent.parentId` through the
// process agent registry to the `kind: "main"` ref. Its prompts are the user
// messages on the root session's current branch (`getBranch()` keeps
// pre-compaction entries) with `attribution: "user"` and not `synthetic`;
// its ask answers are the `ask` tool results on that branch
// (`_shared/ask-answers.ts`). Attribution is set by whoever sends the message,
// so extensions that inject user-role messages must send them with
// `attribution: "agent"`.
//
// RUNTIME. Files are read at session start, so edits apply to the next spawned
// subagent. On every `context` event (each model call, including IRC wakes) a
// targeted subagent gets one request-only developer message, placed first,
// holding every matching rendered template as
// `<user-prompt-inject name=…>…</user-prompt-inject>`. Nothing is written to the
// session. Main sessions are never targeted.
//
// FAILURE POLICY. Malformed files, a missing root, or a disposed root session
// degrade to "no injection" plus a warning; the model call is never blocked.
// ============================================================================

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { DeveloperMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { askAnswers, formatAskAnswers } from "../_shared/ask-answers.ts";
import { errorText } from "../_shared/errors.ts";
import { textOf } from "../_shared/messages.ts";
import { discoverSpecFiles, parseFrontmatter, unquote } from "../_shared/spec-files.ts";

const FILE_PATTERN = /^PROMPT-INJECT-.+\.md$/i;
/** Any `{{ user_prompt … }}` or `{{ ask_answers … }}` occurrence; the inner text is parsed separately. */
const PLACEHOLDER_PATTERN = /\{\{\s*((?:user_prompt|ask_answers)\b[^}]*?)\s*\}\}/g;
const SCALAR_PATTERN = /^user_prompt\[\s*(-?\d+)\s*\]$/;
const SLICE_PATTERN = /^user_prompt\[\s*(-?\d+)\s*:\s*(-?\d+|e)\s*\]$/;
const ANSWERS_EXPR = "ask_answers";

type SliceEnd = { readonly kind: "end" } | { readonly kind: "index"; readonly value: number };

type Segment =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "scalar"; readonly index: number }
	| { readonly kind: "slice"; readonly start: number; readonly end: SliceEnd }
	| { readonly kind: "answers" };

type TargetSet = { readonly kind: "all" } | { readonly kind: "names"; readonly names: ReadonlySet<string> };

type InjectSpec = {
	readonly name: string;
	readonly targets: TargetSet;
	readonly segments: readonly Segment[];
	readonly filePath: string;
};

type SpecParse =
	| { readonly kind: "ok"; readonly spec: InjectSpec }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly reason: string };

/** The root session's human prompts and, separately, the ask answers given there; both oldest first. */
type RootPrompts =
	| { readonly kind: "ok"; readonly prompts: readonly string[]; readonly answers: readonly string[] }
	| { readonly kind: "missing"; readonly reason: string };

// --- discovery + parsing ----------------------------------------------------

/**
 * `target` value → target set. Agent names contain `:` (`mentor:default`), so
 * the value is split on commas only; `[a, b]` brackets are accepted.
 */
function parseTargets(value: string): TargetSet | null {
	let s = value.trim();
	if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
	const items = s
		.split(",")
		.map((x) => unquote(x).toLowerCase())
		.filter((x) => x !== "");
	if (items.length === 0) return null;
	if (items.includes("*")) return { kind: "all" };
	return { kind: "names", names: new Set(items) };
}

type TemplateParse = { readonly kind: "ok"; readonly segments: readonly Segment[] } | { readonly kind: "invalid"; readonly reason: string };

function parseTemplate(body: string): TemplateParse {
	const segments: Segment[] = [];
	let last = 0;
	for (const m of body.matchAll(PLACEHOLDER_PATTERN)) {
		const at = m.index ?? 0;
		if (at > last) segments.push({ kind: "text", text: body.slice(last, at) });
		const expr = (m[1] ?? "").replace(/\s+/g, "");
		const scalar = expr.match(SCALAR_PATTERN);
		const slice = expr.match(SLICE_PATTERN);
		if (scalar) {
			segments.push({ kind: "scalar", index: Number(scalar[1]) });
		} else if (slice) {
			const end: SliceEnd = slice[2] === "e" ? { kind: "end" } : { kind: "index", value: Number(slice[2]) };
			segments.push({ kind: "slice", start: Number(slice[1]), end });
		} else if (expr === ANSWERS_EXPR) {
			segments.push({ kind: "answers" });
		} else {
			return {
				kind: "invalid",
				reason: `unsupported placeholder "${m[0]}" (use user_prompt[i], user_prompt[a:b] where b may be e, or ask_answers)`,
			};
		}
		last = at + m[0].length;
	}
	if (last < body.length) segments.push({ kind: "text", text: body.slice(last) });
	return { kind: "ok", segments };
}

function parseSpecFile(path: string): SpecParse {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { kind: "invalid", reason: `unreadable: ${String(error)}` };
	}
	const parsed = parseFrontmatter(raw);
	if (!parsed) return { kind: "invalid", reason: "missing frontmatter" };
	const { fields, body } = parsed;
	if (fields.enabled !== undefined && !/^(true|yes|on|1)$/i.test(unquote(fields.enabled))) return { kind: "disabled" };
	const targets = fields.target ? parseTargets(fields.target) : null;
	if (!targets) return { kind: "invalid", reason: "missing target" };
	const template = body.trim();
	if (template === "") return { kind: "invalid", reason: "empty body" };
	const segments = parseTemplate(template);
	switch (segments.kind) {
		case "invalid":
			return segments;
		case "ok": {
			const label = basename(path)
				.replace(/^PROMPT-INJECT-/i, "")
				.replace(/\.md$/i, "");
			return {
				kind: "ok",
				spec: {
					name: fields.name ? unquote(fields.name) : label,
					targets,
					segments: segments.segments,
					filePath: path,
				},
			};
		}
		default: {
			const unreachable: never = segments;
			return unreachable;
		}
	}
}

// --- rendering ----------------------------------------------------------------

/** Python-style index normalisation for slice bounds: negative counts from the end, then clamp to [0, length]. */
function clampBound(bound: number, length: number): number {
	const n = bound < 0 ? length + bound : bound;
	return Math.min(Math.max(n, 0), length);
}

function renderSegment(segment: Segment, root: { readonly prompts: readonly string[]; readonly answers: readonly string[] }): string {
	const { prompts } = root;
	switch (segment.kind) {
		case "text":
			return segment.text;
		case "scalar": {
			const i = segment.index < 0 ? prompts.length + segment.index : segment.index;
			return prompts[i] ?? "";
		}
		case "slice": {
			const start = clampBound(segment.start, prompts.length);
			let end: number;
			switch (segment.end.kind) {
				case "end":
					end = prompts.length;
					break;
				case "index":
					end = clampBound(segment.end.value, prompts.length);
					break;
				default: {
					const unreachable: never = segment.end;
					return unreachable;
				}
			}
			const parts: string[] = [];
			for (let i = start; i < end; i++) parts.push(`<user_prompt index="${i}">\n${prompts[i]}\n</user_prompt>`);
			return parts.join("\n");
		}
		case "answers":
			return root.answers.map((answer, i) => `<ask_answer index="${i}">\n${answer}\n</ask_answer>`).join("\n");
		default: {
			const unreachable: never = segment;
			return unreachable;
		}
	}
}

function renderSpec(spec: InjectSpec, root: { readonly prompts: readonly string[]; readonly answers: readonly string[] }): string {
	const body = spec.segments.map((s) => renderSegment(s, root)).join("");
	const name = spec.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	return `<user-prompt-inject name="${name}">\n${body}\n</user-prompt-inject>`;
}

// --- root prompt source -------------------------------------------------------

/** Walk the spawn tree from this subagent to the root main session and read its user prompts. */
function rootPrompts(ctx: ExtensionContext): RootPrompts {
	const registry = AgentRegistry.global();
	const visited = new Set<string>();
	let id = ctx.agent.parentId;
	while (id !== undefined) {
		if (visited.has(id)) return { kind: "missing", reason: `parent cycle at ${id}` };
		visited.add(id);
		const ref = registry.get(id);
		if (!ref) return { kind: "missing", reason: `ancestor ${id} not in registry` };
		if (ref.kind === "main") {
			if (!ref.session) return { kind: "missing", reason: `root ${id} has no live session` };
			const prompts: string[] = [];
			const answers: string[] = [];
			for (const entry of ref.session.sessionManager.getBranch()) {
				if (entry.type !== "message") continue;
				const message = entry.message;
				if (message.role === "toolResult") {
					const answered = askAnswers(message);
					if (answered !== null) answers.push(formatAskAnswers(answered));
					continue;
				}
				if (message.role !== "user" || message.attribution !== "user" || message.synthetic === true) continue;
				const text = textOf(message.content, "\n").trim();
				if (text !== "") prompts.push(text);
			}
			return { kind: "ok", prompts, answers };
		}
		id = ref.parentId;
	}
	return { kind: "missing", reason: "no main ancestor" };
}

// --- extension --------------------------------------------------------------

function targets(spec: InjectSpec, agentName: string): boolean {
	switch (spec.targets.kind) {
		case "all":
			return true;
		case "names":
			return spec.targets.names.has(agentName);
		default: {
			const unreachable: never = spec.targets;
			return unreachable;
		}
	}
}

export default function userPromptInject(pi: ExtensionAPI): void {
	/** Specs targeting this session; empty for main sessions and non-targets. */
	let active: InjectSpec[] = [];
	/** Last root-resolution failure already logged, so a broken chain warns once per reason. */
	let warnedReason: string | null = null;

	pi.on("session_start", (_event, ctx) => {
		active = [];
		warnedReason = null;
		try {
			if (ctx.agent.kind !== "sub") return;
			for (const path of discoverSpecFiles(FILE_PATTERN, import.meta.dir, ctx.cwd)) {
				const parsed = parseSpecFile(path);
				switch (parsed.kind) {
					case "ok":
						if (targets(parsed.spec, ctx.agent.name)) active.push(parsed.spec);
						break;
					case "disabled":
						break;
					case "invalid":
						pi.logger.warn(`user-prompt-inject: skipping ${path}: ${parsed.reason}`);
						break;
					default: {
						const unreachable: never = parsed;
						return unreachable;
					}
				}
			}
			if (active.length > 0) {
				pi.logger.info(`user-prompt-inject: ${ctx.agent.name} (${ctx.agent.id}) ← ${active.map((s) => s.name).join(", ")}`);
			}
		} catch (error) {
			pi.logger.warn("user-prompt-inject: session_start failed", { error: errorText(error) });
		}
	});

	pi.on("context", (event, ctx) => {
		try {
			if (active.length === 0) return;
			const root = rootPrompts(ctx);
			switch (root.kind) {
				case "missing":
					if (warnedReason !== root.reason) {
						warnedReason = root.reason;
						pi.logger.warn(`user-prompt-inject: ${ctx.agent.id}: ${root.reason}; not injecting`);
					}
					return;
				case "ok":
					break;
				default: {
					const unreachable: never = root;
					return unreachable;
				}
			}
			const text = active.map((spec) => renderSpec(spec, root)).join("\n\n");
			const message: DeveloperMessage = {
				role: "developer",
				content: [{ type: "text", text }],
				attribution: "agent",
				timestamp: event.messages[0]?.timestamp ?? Date.now(),
			};
			return { messages: [message, ...event.messages] };
		} catch (error) {
			pi.logger.warn("user-prompt-inject: context failed", { error: errorText(error) });
		}
	});
}
