// Attribution is set by whoever sends the message,
// so extensions that inject user-role messages must send them with
// `attribution: "agent"`.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { DeveloperMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { askAnswers, formatAskAnswers } from "../_shared/ask-answers.ts";
import { errorText } from "../_shared/errors.ts";
import { type MessageContent, textOf } from "../_shared/messages.ts";
import { discoverSpecFiles, parseFrontmatter, unquote } from "../_shared/spec-files.ts";
import { type BranchNeed, createTranscriptReader, type PromptSource, type TranscriptReader } from "./transcript.ts";

const FILE_PATTERN = /^PROMPT-INJECT-.+\.md$/i;
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

type MissingRoot = { readonly kind: "missing"; readonly reason: string };

type RootPrompts = { readonly kind: "ok"; readonly prompts: PromptSource; readonly answers: readonly string[] } | MissingRoot;

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

function clampBound(bound: number, length: number): number {
	const n = bound < 0 ? length + bound : bound;
	return Math.min(Math.max(n, 0), length);
}

function renderSegment(segment: Segment, root: { readonly prompts: PromptSource; readonly answers: readonly string[] }): string {
	const { prompts } = root;
	switch (segment.kind) {
		case "text":
			return segment.text;
		case "scalar": {
			const i = segment.index < 0 ? prompts.length + segment.index : segment.index;
			return i >= 0 && i < prompts.length ? prompts.at(i) : "";
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
			for (let i = start; i < end; i++) parts.push(`<user_prompt index="${i}">\n${prompts.at(i)}\n</user_prompt>`);
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

function renderSpec(spec: InjectSpec, root: { readonly prompts: PromptSource; readonly answers: readonly string[] }): string {
	const body = spec.segments.map((s) => renderSegment(s, root)).join("");
	const name = spec.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	return `<user-prompt-inject name="${name}">\n${body}\n</user-prompt-inject>`;
}

function rootPrompts(ctx: ExtensionContext, need: BranchNeed, reader: TranscriptReader): RootPrompts {
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
			if (isLocalAgentSession(ref.session)) return livePrompts(ref.session.sessionManager.getBranch(), need);
			const file = ref.session.sessionManager.getSessionFile();
			if (!file) return { kind: "missing", reason: "root session on another thread has no persisted transcript" };
			const branch = reader.read(file, need);
			return { kind: "ok", prompts: branch.prompts, answers: need.answers ? branch.answers() : [] };
		}
		id = ref.parentId;
	}
	return { kind: "missing", reason: "no main ancestor" };
}

function livePrompts(branch: readonly SessionEntry[], need: BranchNeed): RootPrompts {
	const prompts: MessageContent[] = [];
	const answers: string[] = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			if (!need.answers) continue;
			const answered = askAnswers(message);
			if (answered !== null) answers.push(formatAskAnswers(answered));
			continue;
		}
		if (!need.prompts) continue;
		if (message.role !== "user" || message.attribution !== "user" || message.synthetic === true) continue;
		if (textOf(message.content, "\n").trim() === "") continue;
		prompts.push(message.content);
	}
	return {
		kind: "ok",
		prompts: {
			length: prompts.length,
			at: (index) => {
				const content = prompts[index];
				return content === undefined ? "" : textOf(content, "\n").trim();
			},
		},
		answers,
	};
}

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

function needOf(specs: readonly InjectSpec[]): BranchNeed {
	let prompts = false;
	let answers = false;
	for (const spec of specs) {
		for (const segment of spec.segments) {
			if (segment.kind === "answers") answers = true;
			else if (segment.kind !== "text") prompts = true;
		}
	}
	return { prompts, answers };
}

export default function userPromptInject(pi: ExtensionAPI): void {
	let active: InjectSpec[] = [];
	let need: BranchNeed = { prompts: false, answers: false };
	const reader = createTranscriptReader();
	let warnedReason: string | null = null;

	pi.on("session_start", (_event, ctx) => {
		active = [];
		need = { prompts: false, answers: false };
		warnedReason = null;
		reader.reset();
		try {
			if (ctx.agent.kind !== "sub") return;
			const found: InjectSpec[] = [];
			for (const path of discoverSpecFiles(FILE_PATTERN, import.meta.dir, ctx.cwd)) {
				const parsed = parseSpecFile(path);
				switch (parsed.kind) {
					case "ok":
						if (targets(parsed.spec, ctx.agent.name)) found.push(parsed.spec);
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
			active = found;
			need = needOf(found);
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
			const root = rootPrompts(ctx, need, reader);
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
		} finally {
			reader.release();
		}
	});
}
