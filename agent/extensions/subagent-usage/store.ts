// Machine-owned calibration state: written only on this machine, from its own data, after consent.
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, z } from "@oh-my-pi/pi-coding-agent";

/** Calibration result (state); kept until `/subagent-usage reset`. */
export function calibrationPath(): string {
	return path.join(getAgentDir(), "subagent-usage", "calibration.json");
}

/** Per-transcript aggregate cache of the scan worker (rebuildable). */
export function scanCachePath(): string {
	return path.join(getAgentDir(), "cache", "subagent-usage", "transcripts.json");
}

const priorSchema = z.object({ usd: z.number(), n: z.number() });
const quotaConstantSchema = z.object({ usdPer100: z.number(), hours: z.number(), days: z.number() });

const calibrationSchema = z.object({
	schema: z.literal(1),
	/** Per-dispatch USD from this machine's finished subagent dispatches; computed on enable and on `recalibrate`. */
	dispatch: z.object({
		generatedAt: z.number(),
		/** Pooled within-group SD of ln(USD per dispatch); null without enough local groups. */
		sigma: z.number().nullable(),
		/** `agent|provider/model|thinking` -> mean USD. */
		byAgent: z.record(z.string(), priorSchema),
		/** `provider/model|thinking` -> mean USD. */
		byModel: z.record(z.string(), priorSchema),
	}),
	/** USD of local spend per 100% of one account's limit, over a trailing window; refreshed daily. */
	quota: z.object({
		generatedAt: z.number(),
		sinceMs: z.number(),
		/** `provider|accountKey|limitId|windowId` -> constant. */
		constants: z.record(z.string(), quotaConstantSchema),
		/** Same key -> why no constant could be derived. */
		missing: z.record(z.string(), z.string()),
	}),
});

export type Calibration = z.infer<typeof calibrationSchema>;
export type Prior = z.infer<typeof priorSchema>;

export type StoredCalibration =
	| { readonly kind: "none" }
	| { readonly kind: "invalid"; readonly reason: string }
	| { readonly kind: "ready"; readonly calibration: Calibration };

export function readCalibration(): StoredCalibration {
	let text: string;
	try {
		text = fs.readFileSync(calibrationPath(), "utf8");
	} catch {
		// Not calibrated on this machine yet.
		return { kind: "none" };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { kind: "invalid", reason: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	const parsed = calibrationSchema.safeParse(raw);
	return parsed.success ? { kind: "ready", calibration: parsed.data } : { kind: "invalid", reason: parsed.error.message };
}

export function writeCalibration(calibration: Calibration): void {
	const file = calibrationPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(calibration, null, 1)}\n`);
	fs.renameSync(temp, file);
}

/** Deletes the calibration and the scan cache; `/subagent-usage reset` only. */
export function deleteStoredData(): void {
	fs.rmSync(path.dirname(calibrationPath()), { recursive: true, force: true });
	fs.rmSync(path.dirname(scanCachePath()), { recursive: true, force: true });
}
