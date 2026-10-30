/**
 * Intent lane of tool-policy-nag: asks a judgment model one `choice` question
 * per watched call — what is this call trying to accomplish, and which built-in
 * tool does that intent belong to — and renders a reminder from the option the
 * model picked.
 *
 * SPEC. `INTENT-*.md` beside this file (`INTENT-policy.md` ships): `---`-fenced
 * YAML with `name`, `enabled` and an `options` map of
 * `{ title, tool, rubric }`; the body is the question's instructions. `rubric`
 * is what the judge reads, `title` names the intent in the reminder and `tool`
 * names what the intent needs instead. A file that does not parse, or whose
 * options are incomplete, is reported and the lane stays silent. The file is
 * read per watched call, so edits apply to the next shell or eval call.
 *
 * VERDICT. `none` never reminds (the shell is the right tool); for an eval call
 * `eval` never reminds either (the eval kernel is the right tool); every other
 * option reminds when its probability reaches the lane's `threshold`. The
 * reminder names the intent and the required tool, then quotes the call.
 *
 * FAILURE. Missing or invalid spec, no judge model, a request that failed on
 * every model `openJudge` resolved for purpose `tool-policy-nag` (`@tool-policy-nag`
 * or the judge role chain, then the `judge` fallback role), or the timeout: no
 * reminder, no `form` fallback; the caller reports the reason once.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Judge, JudgmentState } from "@oh-my-pi/pi-ai";
import { z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import type { WatchedCall } from "../_shared/tool-calls.ts";

const JUDGE_TIMEOUT_MS = 90_000;
const SPEC_NAME = /^INTENT-.*\.md$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** One option: what the judge reads, what the reminder calls it, what it needs. */
export type IntentOption = {
	readonly label: string;
	readonly title: string;
	readonly tool: string;
	readonly rubric: string;
};

export type IntentSpec = {
	readonly path: string;
	readonly instructions: string;
	readonly options: readonly IntentOption[];
};

export type IntentSpecLoad =
	| { readonly kind: "found"; readonly spec: IntentSpec }
	| { readonly kind: "missing" }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly reason: string };

const optionSchema = z.object({
	title: z.string().min(1),
	tool: z.string().min(1),
	rubric: z.string().min(1),
});
const specSchema = z.object({
	name: z.string().optional(),
	enabled: z.boolean().default(true),
	options: z.record(z.string(), optionSchema),
});
const frontmatterSchema = z.record(z.string(), z.unknown());

/** The spec beside this module, read per call; explicit off stays distinct from missing. */
export async function loadIntentSpec(directory: string): Promise<IntentSpecLoad> {
	let names: string[];
	try {
		names = (await readdir(directory)).filter((candidate) => SPEC_NAME.test(candidate)).sort();
	} catch (error) {
		return { kind: "invalid", reason: `cannot list ${directory}: ${errorText(error)}` };
	}
	const name = names[0];
	if (name === undefined) return { kind: "missing" };
	const path = join(directory, name);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		return { kind: "invalid", reason: `cannot read ${path}: ${errorText(error)}` };
	}
	return parseIntentSpec(path, raw);
}

/** Synchronous read kept separate so the caller can report a reason, not throw. */
export function parseIntentSpec(path: string, raw: string): IntentSpecLoad {
	const match = FRONTMATTER.exec(raw);
	if (match === null) return { kind: "invalid", reason: "no `---` frontmatter" };
	const fields = frontmatterSchema.safeParse(Bun.YAML.parse(match[1] ?? ""));
	if (!fields.success) return { kind: "invalid", reason: "frontmatter is not a mapping" };
	const parsed = specSchema.safeParse(fields.data);
	if (!parsed.success) return { kind: "invalid", reason: parsed.error.message };
	if (!parsed.data.enabled) return { kind: "disabled" };
	const options: IntentOption[] = [];
	for (const [label, option] of Object.entries(parsed.data.options)) {
		options.push({ label, title: option.title, tool: option.tool, rubric: option.rubric });
	}
	if (options.length < 2) return { kind: "invalid", reason: "fewer than two options" };
	if (!options.some((option) => option.label === "none")) return { kind: "invalid", reason: "no `none` option" };
	const instructions = raw.slice(match[0].length).trim();
	if (instructions === "") return { kind: "invalid", reason: "empty body" };
	return { kind: "found", spec: { path, instructions, options } };
}

export type IntentVerdict =
	| { readonly kind: "ok"; readonly label: string; readonly probability: number; readonly confidence: number }
	| { readonly kind: "failed"; readonly reason: string };

/** One request, one choice question: the model picks the call's intent. */
export async function judgeIntent(judge: Judge, spec: IntentSpec, call: WatchedCall, signal: AbortSignal): Promise<IntentVerdict> {
	try {
		const criteria: Record<string, string> = {};
		for (const option of spec.options) criteria[option.label] = option.rubric;
		const state: JudgmentState =
			call.kind === "shell" ? { tool: call.tool, command: call.command } : { tool: "eval", language: call.language, code: call.code };
		const result = await judge.judge(
			{ state, questions: { intent: { type: "choice", instructions: spec.instructions, criteria } } },
			{ signal },
		);
		const answer = result.answers.intent;
		if (answer === undefined || answer.type !== "choice") return { kind: "failed", reason: "judge returned no choice answer" };
		const probability = answer.probabilities[answer.choice];
		if (typeof probability !== "number") return { kind: "failed", reason: `no probability for ${answer.choice}` };
		return { kind: "ok", label: answer.choice, probability, confidence: answer.confidence };
	} catch (error) {
		return { kind: "failed", reason: errorText(error) };
	}
}

/** A code fence longer than any backtick run inside `text`. */
export function fenced(text: string, language: string): string {
	let longest = 2;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const marks = "`".repeat(longest + 1);
	return `${marks}${language}\n${text}\n${marks}`;
}

/**
 * Which options remind, per call kind. A shell call that intends anything a
 * built-in tool covers is a violation; an eval call is a violation unless the
 * intent is `eval` itself (the eval kernel is the right tool for it) or `none`.
 */
export function intentViolation(call: WatchedCall, label: string): boolean {
	switch (call.kind) {
		case "shell":
			return label !== "none";
		case "eval":
			return label !== "eval" && label !== "none";
		default: {
			const unreachable: never = call;
			return unreachable;
		}
	}
}

/** The intent, the tool it needs, and the call, quoted back. */
export function intentReminder(call: WatchedCall, option: IntentOption): string {
	const tool = call.kind === "shell" ? call.tool : "eval";
	return [
		`你这次 \`${tool}\` 调用属于「${option.title}」，应该用 ${option.tool}，而不是这样绕出去。`,
		"",
		"这次调用：",
		call.kind === "shell" ? fenced(call.command, "sh") : fenced(call.code, call.language),
	].join("\n");
}

export { JUDGE_TIMEOUT_MS };
