import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { errorText } from "../_shared/errors.ts";
import { byCodePoint } from "./changelog.ts";

export type Seen = ReadonlyMap<string, string>;

const markerPath = (): string => join(getAgentDir(), "omomp-changelog", "seen.json");

const markerSchema = z.record(z.string(), z.string());

export function readMarker(): { readonly kind: "ok"; readonly seen: Seen } | { readonly kind: "invalid"; readonly reason: string } {
	const file = markerPath();
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "ok", seen: new Map() };
		return { kind: "invalid", reason: `${file}: ${errorText(error)}` };
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		return { kind: "invalid", reason: `${file}: ${errorText(error)}` };
	}
	const parsed = markerSchema.safeParse(json);
	if (!parsed.success) return { kind: "invalid", reason: `${file}: expected an object of version strings` };
	return { kind: "ok", seen: new Map(Object.entries(parsed.data)) };
}

export function writeMarker(seen: Seen): { readonly kind: "written" } | { readonly kind: "failed"; readonly reason: string } {
	const file = markerPath();
	const temp = `${file}.${process.pid}.tmp`;
	const sorted = Object.fromEntries([...seen].sort(([a], [b]) => byCodePoint(a, b)));
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(temp, `${JSON.stringify(sorted, null, 2)}\n`);
		renameSync(temp, file);
		return { kind: "written" };
	} catch (error) {
		const reason = `${file}: ${errorText(error)}`;
		try {
			rmSync(temp, { force: true });
		} catch (cleanup) {
			return { kind: "failed", reason: `${reason}; ${temp} is left behind: ${errorText(cleanup)}` };
		}
		return { kind: "failed", reason };
	}
}

export function sameMarker(a: Seen, b: Seen): boolean {
	if (a.size !== b.size) return false;
	for (const [name, version] of a) if (b.get(name) !== version) return false;
	return true;
}
