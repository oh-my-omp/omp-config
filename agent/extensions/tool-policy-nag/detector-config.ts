/**
 * Lane configuration for tool-policy-nag: the `tool-policy-nag` section of
 * omomp.* (the project's `.omp/` copy wins over the agent-dir copy; invalid
 * copies warn and fall through), read at every watched call.
 *
 * `detector` picks how tool-routing violations are caught; `risk` is a third,
 * independent lane that asks whether the call's side effects can be read off
 * the call at all:
 *
 * - `detector: heuristic` — the deterministic string lane (`heuristic.ts`):
 *   parses the command, counts the operations a built-in tool covers and, once
 *   the hits exceed `form.afterHits`, sends `form.prompt`, at most
 *   `form.maxNags` times per context. `form` is required; an `intent` block is ignored, so no
 *   JUDGE request is made and `INTENT-*.md` is not read. OMP's bash
 *   interceptor is overridden off for the session while this detector is set.
 * - `detector: jev` — the intent lane (`intent.ts`): asks OMP's native JUDGE
 *   one `choice` question about what the call is trying to accomplish, worded
 *   by `INTENT-*.md`. `intent` is required; an optional `form` block is the
 *   fallback sender when the intent lane cannot run.
 * - `risk` — the risk lane (`risk.ts`): flags a long chain that both reads and
 *   writes, whose side-effect surface is unreadable. No judge. Missing or
 *   `null` leaves it off.
 * - `pty` — the pty lane (`pty.ts`): refuses, before they run, `bash` and eval
 *   calls that belong in an `exec_command` PTY session. An object (`{}`) turns
 *   it on under either detector; missing or `null` leaves it off.
 *
 *   { "detector": "heuristic",
 *     "form": { "prompt": "…", "afterHits": 3, "maxNags": 3 },
 *     "intent": { "threshold": 0.5 },
 *     "risk": { "minCommands": 4, "minChars": 600, "minPrograms": 3 },
 *     "pty": {} }
 *
 * Nothing is preset in code: without a valid section no lane runs.
 */
import { z } from "@oh-my-pi/pi-coding-agent";
import { defineOmompSection, loadOmompSection } from "../_shared/omomp.ts";
import type { RiskConfig } from "./risk.ts";

/** The deterministic string lane and the text it sends. */
export type FormLane = {
	readonly kind: "heuristic";
	readonly prompt: string;
	/** Violations recorded silently before the first prompt is sent. */
	readonly afterHits: number;
	/** Prompts sent per context before the lane goes quiet. */
	readonly maxNags: number;
};

/** The intent lane: one judged choice question per watched call. */
export type IntentLane = {
	readonly kind: "jev";
	readonly threshold: number;
};

/** The risk lane: deterministic, for calls whose side-effect surface is unreadable. */
export type RiskLane = { readonly kind: "risk" } & RiskConfig;

/** The pty lane: deterministic, blocking; it has no settings. */
export type PtyLane = { readonly kind: "pty" };

/** How tool-routing violations are caught, chosen by `detector`. */
export type ToolLanes =
	| { readonly detector: "heuristic"; readonly form: FormLane }
	| { readonly detector: "jev"; readonly intent: IntentLane; readonly fallback: FormLane | null };

export type Lanes = {
	readonly tool: ToolLanes | null;
	readonly risk: RiskLane | null;
	readonly pty: PtyLane | null;
};
export type LaneWarning = { readonly en: string; readonly zh: string };

const NO_LANES: Lanes = { tool: null, risk: null, pty: null };

const thresholdSchema = z.number().refine((value) => value > 0 && value <= 1, "threshold must be a number in (0, 1]");
const positiveCount = (label: string) =>
	z.number().refine((value) => Number.isInteger(value) && value > 0, `${label} must be a positive integer`);
const intentBlock = z.object({ threshold: thresholdSchema });
const formBlock = z.object({
	prompt: z.string().refine((value) => value.trim().length > 0, "form.prompt must not be empty"),
	afterHits: z.number().refine((value) => Number.isInteger(value) && value >= 0, "form.afterHits must be a non-negative integer"),
	maxNags: positiveCount("form.maxNags"),
});
const riskBlock = z.object({
	minCommands: positiveCount("minCommands"),
	minChars: positiveCount("minChars"),
	minPrograms: positiveCount("minPrograms"),
});
const ptyBlock = z.object({}).strict();

const lanesSchema = z.union([
	z.object({
		detector: z.literal("heuristic"),
		form: formBlock,
		risk: riskBlock.nullable().optional(),
		pty: ptyBlock.nullable().optional(),
	}),
	z.object({
		detector: z.literal("jev"),
		intent: intentBlock,
		form: formBlock.nullable().optional(),
		risk: riskBlock.nullable().optional(),
		pty: ptyBlock.nullable().optional(),
	}),
]);

const omompSection = defineOmompSection(import.meta.dir, lanesSchema);

function formOf(block: z.infer<typeof formBlock>): FormLane {
	return { kind: "heuristic", prompt: block.prompt, afterHits: block.afterHits, maxNags: block.maxNags };
}

function lanesOf(value: z.infer<typeof lanesSchema>): Lanes {
	const risk: RiskLane | null =
		value.risk == null
			? null
			: { kind: "risk", minCommands: value.risk.minCommands, minChars: value.risk.minChars, minPrograms: value.risk.minPrograms };
	const pty: PtyLane | null = value.pty == null ? null : { kind: "pty" };
	switch (value.detector) {
		case "heuristic":
			return { tool: { detector: "heuristic", form: formOf(value.form) }, risk, pty };
		case "jev":
			return {
				tool: {
					detector: "jev",
					intent: { kind: "jev", threshold: value.intent.threshold },
					fallback: value.form == null ? null : formOf(value.form),
				},
				risk,
				pty,
			};
		default: {
			const unreachable: never = value;
			return unreachable;
		}
	}
}

/** Re-read every watched call; the project's omomp section overrides the agent-dir one. */
export function loadLanes(cwd: string): { readonly lanes: Lanes; readonly warnings: readonly LaneWarning[] } {
	const loaded = loadOmompSection(omompSection, cwd);
	const warnings = loaded.skipped.map(({ path, reason }) => ({
		en: `tool-policy-nag: skipped ${path}: ${reason}`,
		zh: `tool-policy-nag：跳过 ${path}：${reason}`,
	}));
	switch (loaded.kind) {
		case "found":
			return { lanes: lanesOf(loaded.value), warnings };
		case "none":
			return { lanes: NO_LANES, warnings };
		default: {
			const unreachable: never = loaded;
			return unreachable;
		}
	}
}
