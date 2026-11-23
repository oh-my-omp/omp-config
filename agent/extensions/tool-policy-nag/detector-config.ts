import { z } from "@oh-my-pi/pi-coding-agent";
import { defineSettings, readSettings } from "../_shared/plugin-settings.ts";
import type { RiskConfig } from "./risk.ts";

export type FormLane = {
	readonly kind: "heuristic";
	readonly prompt: string;
	readonly afterHits: number;
	readonly maxNags: number;
};

export type IntentLane = {
	readonly kind: "jev";
	readonly threshold: number;
};

type RiskLane = { readonly kind: "risk" } & RiskConfig;

type PtyLane = { readonly kind: "pty" };

type ToolLanes =
	| { readonly detector: "heuristic"; readonly form: FormLane }
	| { readonly detector: "jev"; readonly intent: IntentLane; readonly fallback: FormLane };

export type Lanes = {
	readonly tool: ToolLanes | null;
	readonly risk: RiskLane | null;
	readonly pty: PtyLane | null;
};
export type LaneWarning = { readonly en: string; readonly zh: string };

export type LoadedLanes = { readonly lanes: Lanes; readonly warnings: readonly LaneWarning[] };

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

export async function loadLanes(cwd: string): Promise<LoadedLanes> {
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
