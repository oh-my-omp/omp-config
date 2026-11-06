/**
 * Lane configuration for tool-policy-nag: the `tool-policy-nag.*` plugin
 * settings of `omp-config` (`/settings → Plugins → omp-config` or
 * `omp plugin config`; the project's `.omp/plugin-overrides.json` wins over
 * the machine values), read at every watched call. The manifest carries the
 * defaults; an unreadable or invalid value warns and runs no lane.
 *
 * `detector` picks how tool-routing violations are caught; `risk` and `pty`
 * are independent lanes:
 *
 * - `tool-policy-nag.detector: heuristic` — the deterministic string lane
 *   (`heuristic.ts`): reads the commands (from the run's trace when it left
 *   one, else from the text), counts the operations a built-in tool covers
 *   and, once the hits exceed `form.afterHits`, reminds with `form.prompt`,
 *   at most `form.maxNags` times per context. `intent` is ignored, so no
 *   JUDGE request is made and `INTENT-*.md` is not read. OMP's bash
 *   interceptor is overridden off for the session while this detector is set.
 * - `tool-policy-nag.detector: jev` — the intent lane (`intent.ts`): asks
 *   JUDGE (`openJudge`, purpose `tool-policy-nag`) one `choice` question
 *   about what the call is trying to accomplish, worded by `INTENT-*.md`;
 *   `intent.threshold` is the probability at which a judged violation
 *   counts. The same `form.*` settings are the fallback sender when the
 *   intent lane cannot run.
 * - `tool-policy-nag.risk.*` — the risk lane (`risk.ts`), only when
 *   `risk.enabled`: on a traced run, flags a step that failed silently;
 *   without a complete trace, flags a long chain of many programs that
 *   writes, by the `risk.minCommands`/`risk.minChars`/`risk.minPrograms`
 *   thresholds. No judge.
 * - `tool-policy-nag.pty.enabled` — the pty lane (`pty.ts`): refuses, before
 *   they run, `bash` and eval calls that belong in an `exec_command` PTY
 *   session.
 *
 *   tool-policy-nag.detector: heuristic | jev
 *   tool-policy-nag.form.prompt / form.afterHits / form.maxNags
 *   tool-policy-nag.intent.threshold
 *   tool-policy-nag.risk.enabled / risk.minCommands / risk.minChars / risk.minPrograms
 *   tool-policy-nag.pty.enabled
 */
import { z } from "@oh-my-pi/pi-coding-agent";
import { defineSettings, readSettings } from "../_shared/plugin-settings.ts";
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

/** The risk lane: deterministic, for calls whose outcome cannot be read off their result. */
type RiskLane = { readonly kind: "risk" } & RiskConfig;

/** The pty lane: deterministic, blocking; it has no settings of its own. */
type PtyLane = { readonly kind: "pty" };

/** How tool-routing violations are caught, chosen by `detector`. */
type ToolLanes =
	| { readonly detector: "heuristic"; readonly form: FormLane }
	| { readonly detector: "jev"; readonly intent: IntentLane; readonly fallback: FormLane };

export type Lanes = {
	readonly tool: ToolLanes | null;
	readonly risk: RiskLane | null;
	readonly pty: PtyLane | null;
};
export type LaneWarning = { readonly en: string; readonly zh: string };

const NO_LANES: Lanes = { tool: null, risk: null, pty: null };

const positiveCount = (label: string) =>
	z.number().refine((value) => Number.isInteger(value) && value > 0, `${label} must be a positive integer`);

const lanesSchema = z.object({
	detector: z.enum(["heuristic", "jev"]),
	form: z.object({
		prompt: z.string().refine((value) => value.trim().length > 0, "form.prompt must not be empty"),
		afterHits: z.number().refine((value) => Number.isInteger(value) && value >= 0, "form.afterHits must be a non-negative integer"),
		maxNags: positiveCount("form.maxNags"),
	}),
	intent: z.object({
		threshold: z.number().refine((value) => value > 0 && value <= 1, "threshold must be a number in (0, 1]"),
	}),
	risk: z.object({
		enabled: z.boolean(),
		minCommands: positiveCount("risk.minCommands"),
		minChars: positiveCount("risk.minChars"),
		minPrograms: positiveCount("risk.minPrograms"),
	}),
	pty: z.object({ enabled: z.boolean() }),
});

const settingsSection = defineSettings(import.meta.dir, lanesSchema);

function lanesOf(value: z.infer<typeof lanesSchema>): Lanes {
	const risk: RiskLane | null = value.risk.enabled
		? { kind: "risk", minCommands: value.risk.minCommands, minChars: value.risk.minChars, minPrograms: value.risk.minPrograms }
		: null;
	const pty: PtyLane | null = value.pty.enabled ? { kind: "pty" } : null;
	const form: FormLane = { kind: "heuristic", prompt: value.form.prompt, afterHits: value.form.afterHits, maxNags: value.form.maxNags };
	switch (value.detector) {
		case "heuristic":
			return { tool: { detector: "heuristic", form }, risk, pty };
		case "jev":
			return { tool: { detector: "jev", intent: { kind: "jev", threshold: value.intent.threshold }, fallback: form }, risk, pty };
		default: {
			const unreachable: never = value.detector;
			return unreachable;
		}
	}
}

/** Re-read every watched call; the project's plugin-settings override wins. */
export async function loadLanes(cwd: string): Promise<{ readonly lanes: Lanes; readonly warnings: readonly LaneWarning[] }> {
	const loaded = await readSettings(settingsSection, { kind: "project", cwd });
	switch (loaded.kind) {
		case "ok":
			return { lanes: lanesOf(loaded.value), warnings: [] };
		case "invalid":
			return {
				lanes: NO_LANES,
				warnings: [
					{
						en: `tool-policy-nag: invalid settings (${loaded.reason}); no lane runs`,
						zh: `tool-policy-nag：设置无效（${loaded.reason}），所有通道不运行`,
					},
				],
			};
		default: {
			const unreachable: never = loaded;
			return unreachable;
		}
	}
}
