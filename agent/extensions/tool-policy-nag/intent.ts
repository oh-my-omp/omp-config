import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Judge, JudgmentState } from "@oh-my-pi/pi-ai";
import { z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import type { WatchedCall } from "../_shared/tool-calls.ts";
import { quotedCall } from "./call-quote.ts";

export const JUDGE_TIMEOUT_MS = 90_000;
const SPEC_NAME = /^INTENT-.*\.md$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

type IntentOption = {
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

type IntentSpecLoad =
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

export async function loadIntentSpec(directory: string): Promise<IntentSpecLoad> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		return { kind: "invalid", reason: `cannot list ${directory}: ${errorText(error)}` };
	}
	let name: string | undefined;
	for (const candidate of names) {
		if (!SPEC_NAME.test(candidate)) continue;
		if (name === undefined || candidate < name) name = candidate;
	}
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

function parseIntentSpec(path: string, raw: string): IntentSpecLoad {
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

type IntentVerdict =
	| { readonly kind: "ok"; readonly label: string; readonly probability: number; readonly confidence: number }
	| { readonly kind: "failed"; readonly reason: string };

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

export function intentReminder(call: WatchedCall, option: IntentOption): string {
	const tool = call.kind === "shell" ? call.tool : "eval";
	return [
		`你这次 \`${tool}\` 调用属于「${option.title}」，应该用 ${option.tool}，而不是这样绕出去。`,
		"",
		call.kind === "shell" ? quotedCall(call.command, "sh") : quotedCall(call.code, call.language),
	].join("\n");
}
