import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { errorText } from "../_shared/errors.ts";

export function calibrationPath(): string {
	return path.join(getAgentDir(), "subagent-usage", "calibration.json");
}

export function scanCachePath(): string {
	return path.join(getAgentDir(), "cache", "subagent-usage", "transcripts.json");
}

const priorSchema = z.object({ usd: z.number(), n: z.number() });
const quotaConstantSchema = z.object({ usdPer100: z.number(), hours: z.number(), days: z.number() });

const calibrationSchema = z.object({
	schema: z.literal(1),
	dispatch: z.object({
		generatedAt: z.number(),
		sigma: z.number().nullable(),
		byAgent: z.record(z.string(), priorSchema),
		byModel: z.record(z.string(), priorSchema),
	}),
	quota: z.object({
		generatedAt: z.number(),
		sinceMs: z.number(),
		constants: z.record(z.string(), quotaConstantSchema),
		missing: z.record(z.string(), z.string()),
	}),
});

export type Calibration = z.infer<typeof calibrationSchema>;
export type Prior = z.infer<typeof priorSchema>;

type StoredCalibration =
	| { readonly kind: "none" }
	| { readonly kind: "invalid"; readonly reason: string }
	| { readonly kind: "ready"; readonly calibration: Calibration };

export function readCalibration(): StoredCalibration {
	let text: string;
	try {
		text = fs.readFileSync(calibrationPath(), "utf8");
	} catch {
		return { kind: "none" };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { kind: "invalid", reason: `not JSON: ${errorText(error)}` };
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

export function deleteStoredData(): void {
	fs.rmSync(path.dirname(calibrationPath()), { recursive: true, force: true });
	fs.rmSync(path.dirname(scanCachePath()), { recursive: true, force: true });
}
