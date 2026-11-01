// Bun Worker: reads every session transcript under the sessions root once, keeps a per-file aggregate cache keyed by
// size and mtime so later runs re-read only new or changed files, and returns hourly spend per model plus one record
// per subagent transcript. Pure fs/JSON: host packages are not importable from a worker.
import * as fs from "node:fs";
import * as path from "node:path";
import type { DispatchRecord, ScanRequest, ScanResult } from "./records.ts";

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

/** Calls `onLine` per line, reading in fixed chunks so a large transcript never becomes one string. */
function forEachLine(file: string, onLine: (line: string) => void): void {
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(CHUNK);
		const decoder = new TextDecoder();
		let carry = "";
		for (;;) {
			const read = fs.readSync(fd, buffer, 0, CHUNK, null);
			if (read === 0) break;
			const lines = (carry + decoder.decode(buffer.subarray(0, read), { stream: true })).split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		}
		carry += decoder.decode();
		if (carry.length > 0) onLine(carry);
	} finally {
		fs.closeSync(fd);
	}
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
	forEachLine(file, (line) => {
		if (line.startsWith('{"type":"message"')) {
			if (!line.includes('"role":"assistant"')) return;
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
		} else if (line.startsWith('{"type":"custom"') && line.includes('"customType":"session_exit"')) {
			exited = true;
		}
	});
	const tuples: [string, number, number][] = [];
	for (const [key, usd] of spend) {
		const [model, hour] = key.split("\t") as [string, string];
		tuples.push([model, Number(hour), usd]);
	}
	const dispatch: DispatchRecord | null =
		agent === undefined ? null : { agent, resolvedModel, models: [...models], fallback, exited, mtimeMs, costByProvider };
	return { size, mtimeMs, spend: tuples, dispatch };
}

function loadCache(cachePath: string): Cache {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(cachePath, "utf8"));
		if (isRecord(value) && value.version === CACHE_VERSION && isRecord(value.files)) {
			// Written only by this worker in this exact shape.
			return value as Cache;
		}
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
	writeCache(request.cachePath, { version: CACHE_VERSION, files });
	const spend: Record<string, Record<string, number>> = {};
	const dispatches: DispatchRecord[] = [];
	for (const aggregate of Object.values(files)) {
		for (const [model, hour, usd] of aggregate.spend) {
			const series = spend[model] ?? {};
			series[String(hour)] = (series[String(hour)] ?? 0) + usd;
			spend[model] = series;
		}
		if (aggregate.dispatch) dispatches.push(aggregate.dispatch);
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
