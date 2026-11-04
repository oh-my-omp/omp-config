// Bun Worker: reads every session transcript under the sessions root once, keeps a per-file aggregate cache keyed by
// size and mtime so later runs re-read only new or changed files, and returns hourly spend per model plus one record
// per subagent transcript. Pure fs/JSON: host packages are not importable from a worker.
import * as fs from "node:fs";
import * as path from "node:path";
import type { DispatchRecord, ScannedDispatch, ScanRequest, ScanResult } from "./records.ts";

declare const self: Worker;

const HOUR_MS = 3_600_000;
const CHUNK = 1 << 20;
const CACHE_VERSION = 1;

/** One transcript's contribution: spend as [provider/model, hour, usd] and, for a subagent, its dispatch record. */
type FileAggregate = {
	readonly size: number;
	readonly mtimeMs: number;
	readonly spend: readonly (readonly [string, number, number])[];
	readonly dispatch: DispatchRecord | null;
};
type Cache = { readonly version: number; readonly files: Readonly<Record<string, FileAggregate>> };

type Json = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSpend(value: unknown): value is readonly [string, number, number] {
	return (
		Array.isArray(value) &&
		value.length === 3 &&
		typeof value[0] === "string" &&
		typeof value[1] === "number" &&
		typeof value[2] === "number"
	);
}

function isDispatch(value: unknown): value is DispatchRecord {
	return (
		isRecord(value) &&
		typeof value.agent === "string" &&
		typeof value.resolvedModel === "string" &&
		Array.isArray(value.models) &&
		value.models.every((model) => typeof model === "string") &&
		typeof value.fallback === "boolean" &&
		typeof value.exited === "boolean" &&
		typeof value.mtimeMs === "number" &&
		isRecord(value.costByProvider) &&
		Object.values(value.costByProvider).every((cost) => typeof cost === "number")
	);
}

function isFileAggregate(value: unknown): value is FileAggregate {
	return (
		isRecord(value) &&
		typeof value.size === "number" &&
		typeof value.mtimeMs === "number" &&
		Array.isArray(value.spend) &&
		value.spend.every(isSpend) &&
		(value.dispatch === null || isDispatch(value.dispatch))
	);
}

function isCache(value: unknown): value is Cache {
	return isRecord(value) && value.version === CACHE_VERSION && isRecord(value.files) && Object.values(value.files).every(isFileAggregate);
}

function parseLine(line: string): Json | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isRecord(value) ? value : undefined;
	} catch {
		// A torn or truncated JSONL record is not a usable entry.
		return undefined;
	}
}

function costOf(usage: unknown): number {
	if (!isRecord(usage) || !isRecord(usage.cost)) return 0;
	const total = usage.cost.total;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function listTranscripts(dir: string, out: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		// Removed while walking.
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) listTranscripts(full, out);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
	}
}

/** Bytes of a line inspected before deciding whether it is needed. */
const HEAD_BYTES = 256;
const NEWLINE = 0x0a;

/**
 * Calls `onLine` for each line `isWanted(head)` accepts, judged on its first HEAD_BYTES bytes. A rejected
 * line is skipped as raw bytes and never decoded: tool results with images or large outputs run to many MB,
 * and decoding every line of a large session store is what exhausted memory.
 */
function forEachWantedLine(file: string, isWanted: (head: string) => boolean, onLine: (line: string) => void): void {
	const fd = fs.openSync(file, "r");
	try {
		const chunk = Buffer.alloc(CHUNK);
		let parts: Buffer[] = [];
		let length = 0;
		let wanted: boolean | undefined;
		const endLine = (): void => {
			if (wanted === undefined && length > 0) wanted = isWanted(Buffer.concat(parts, length).toString("utf8"));
			if (wanted === true) onLine(Buffer.concat(parts, length).toString("utf8"));
			parts = [];
			length = 0;
			wanted = undefined;
		};
		for (;;) {
			const read = fs.readSync(fd, chunk, 0, CHUNK, null);
			if (read === 0) break;
			const view = chunk.subarray(0, read);
			for (let start = 0; start < read; ) {
				const newline = view.indexOf(NEWLINE, start);
				const end = newline === -1 ? read : newline;
				if (wanted !== false && end > start) {
					// Copied: `chunk` is reused for the next read.
					parts.push(Buffer.from(view.subarray(start, end)));
					length += end - start;
					if (wanted === undefined && length >= HEAD_BYTES) {
						wanted = isWanted(Buffer.concat(parts, length).subarray(0, HEAD_BYTES).toString("utf8"));
						if (!wanted) {
							parts = [];
							length = 0;
						}
					}
				}
				if (newline === -1) break;
				endLine();
				start = newline + 1;
			}
		}
		endLine();
	} finally {
		fs.closeSync(fd);
	}
}

/** Entry kinds the aggregate needs; assistant messages name their role within the first bytes. */
function isWantedHead(head: string): boolean {
	return (
		(head.startsWith('{"type":"message"') && head.includes('"message":{"role":"assistant"')) ||
		head.startsWith('{"type":"model_usage"') ||
		head.startsWith('{"type":"session_init"') ||
		head.startsWith('{"type":"model_change"') ||
		head.startsWith('{"type":"custom","customType":"session_exit"')
	);
}

function aggregateFile(file: string, size: number, mtimeMs: number): FileAggregate {
	const spend = new Map<string, number>();
	const models = new Set<string>();
	const costByProvider: Record<string, number> = {};
	let agent: string | undefined;
	let resolvedModel = "";
	let fallback = false;
	let exited = false;
	const charge = (provider: string, model: string, timestamp: unknown, cost: number): void => {
		if (!(cost > 0)) return;
		const at = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
		if (Number.isFinite(at)) {
			const key = `${provider}/${model}\t${Math.floor(at / HOUR_MS)}`;
			spend.set(key, (spend.get(key) ?? 0) + cost);
		}
		if (agent !== undefined) costByProvider[provider] = (costByProvider[provider] ?? 0) + cost;
	};
	forEachWantedLine(file, isWantedHead, (line) => {
		if (line.startsWith('{"type":"message"')) {
			const entry = parseLine(line);
			const message = entry?.message;
			if (!isRecord(message) || message.role !== "assistant") return;
			const { provider, model } = message;
			if (typeof provider !== "string" || typeof model !== "string") return;
			if (agent !== undefined) models.add(`${provider}/${model}`);
			charge(provider, model, entry?.timestamp, costOf(message.usage));
		} else if (line.startsWith('{"type":"model_usage"')) {
			const entry = parseLine(line);
			if (entry && typeof entry.provider === "string" && typeof entry.model === "string") {
				charge(entry.provider, entry.model, entry.timestamp, costOf(entry.usage));
			}
		} else if (line.startsWith('{"type":"session_init"')) {
			const entry = parseLine(line);
			if (entry && typeof entry.agent === "string") agent = entry.agent;
			if (entry && typeof entry.resolvedModel === "string") resolvedModel = entry.resolvedModel;
		} else if (line.startsWith('{"type":"model_change"')) {
			if (parseLine(line)?.resolvedModelIsFallback === true) fallback = true;
		} else if (line.startsWith('{"type":"custom"')) {
			exited = true;
		}
	});
	const tuples: [string, number, number][] = [];
	for (const [key, usd] of spend) {
		const [model = "", hour] = key.split("\t");
		tuples.push([model, Number(hour), usd]);
	}
	const dispatch: DispatchRecord | null =
		agent === undefined ? null : { agent, resolvedModel, models: [...models], fallback, exited, mtimeMs, costByProvider };
	return { size, mtimeMs, spend: tuples, dispatch };
}

function loadCache(cachePath: string): Cache {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(cachePath, "utf8"));
		if (isCache(value)) return value;
	} catch {
		// Missing or unreadable cache: every transcript is parsed.
	}
	return { version: CACHE_VERSION, files: {} };
}

function writeCache(cachePath: string, cache: Cache): void {
	fs.mkdirSync(path.dirname(cachePath), { recursive: true });
	const temp = `${cachePath}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(cache));
	fs.renameSync(temp, cachePath);
}

function scan(request: ScanRequest): ScanResult {
	const previous = loadCache(request.cachePath).files;
	const files: Record<string, FileAggregate> = {};
	const transcripts: string[] = [];
	listTranscripts(request.sessionsRoot, transcripts);
	let parsed = 0;
	for (const file of transcripts) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			// Removed between listing and stat.
			continue;
		}
		const cached = previous[file];
		if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
			files[file] = cached;
			continue;
		}
		try {
			files[file] = aggregateFile(file, stat.size, stat.mtimeMs);
			parsed++;
		} catch {
			// Unreadable transcript: left out of this run and retried next time.
		}
	}
	// A rescan that read nothing new and lost no file leaves the cache as it was.
	if (parsed > 0 || Object.keys(previous).length !== Object.keys(files).length) {
		writeCache(request.cachePath, { version: CACHE_VERSION, files });
	}
	const spend: Record<string, Record<string, number>> = {};
	const dispatches: ScannedDispatch[] = [];
	for (const [file, aggregate] of Object.entries(files)) {
		for (const [model, hour, usd] of aggregate.spend) {
			const series = spend[model] ?? {};
			series[String(hour)] = (series[String(hour)] ?? 0) + usd;
			spend[model] = series;
		}
		if (aggregate.dispatch) dispatches.push({ ...aggregate.dispatch, file });
	}
	return { kind: "done", spend, dispatches, files: transcripts.length, parsed };
}

self.onmessage = (event: MessageEvent<ScanRequest>) => {
	let result: ScanResult;
	try {
		result = scan(event.data);
	} catch (error) {
		result = { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
	}
	postMessage(result);
};
