import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import type { Seen } from "./plan.ts";

/** Machine-owned state: the version of each member whose changelog was last shown. Not a managed file; the updater and `/sync-omp-config` leave it alone. */
export const markerPath = (): string => join(getAgentDir(), "omomp-changelog", "seen.json");

const markerSchema = z.record(z.string(), z.string());

export type MarkerRead = { readonly kind: "ok"; readonly seen: Seen } | { readonly kind: "invalid"; readonly reason: string };

/** No file is an empty marker; a file that is not an object of version strings is invalid. */
export function readMarker(): MarkerRead {
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

/** Replace the marker, names sorted; written to a temporary file first so a reader never sees half of it. */
export function writeMarker(seen: Seen): void {
	const file = markerPath();
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	const sorted = Object.fromEntries([...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	writeFileSync(temp, `${JSON.stringify(sorted, null, 2)}\n`);
	renameSync(temp, file);
}

/** True when two markers hold the same entries, so an unchanged start writes nothing. */
export function sameMarker(a: Seen, b: Seen): boolean {
	if (a.size !== b.size) return false;
	for (const [name, version] of a) if (b.get(name) !== version) return false;
	return true;
}
