// Bun Worker: reads every session transcript under the sessions root, continuing each file from the byte position
// its cache entry records when the file is still the same one (same inode), so a later run reads only the bytes
// appended since then, and returns hourly spend per model plus one record per subagent transcript. Pure fs/JSON:
// host packages are not importable from a worker.
import * as fs from "node:fs";
import * as path from "node:path";
import type { DispatchRecord, ScannedDispatch, ScanRequest, ScanResult } from "./records.ts";

declare const self: Worker;

const HOUR_MS = 3_600_000;
const CHUNK = 1 << 20;
// 2: `size` became the number of bytes read (the resume position), not the size stat reported before the read.
// 3: entries also record `ino`, so a transcript replaced by a rewrite (temp file and rename) is read again.
const CACHE_VERSION = 3;

/** One transcript's contribution: spend as [provider/model, hour, usd] and, for a subagent, its dispatch record. */
type FileAggregate = {
	/** Bytes read so far; the next scan of this file continues from here. */
	readonly size: number;
	readonly mtimeMs: number;
	/** Inode of the file those bytes came from; a rewrite replaces the file, so the number changes. */
	readonly ino: number;
	readonly spend: readonly (readonly [string, number, number])[];
	readonly dispatch: DispatchRecord | null;
};
type Cache = { readonly version: number; readonly files: Readonly<Record<string, unknown>> };

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
		typeof value.ino === "number" &&
		Array.isArray(value.spend) &&
		value.spend.every(isSpend) &&
		(value.dispatch === null || isDispatch(value.dispatch))
	);
}

/** Entries are validated per transcript as the scan uses them, not in a pass over the whole cache. */
function isCache(value: unknown): value is Cache {
	return isRecord(value) && value.version === CACHE_VERSION && isRecord(value.files);
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

/** The worker reads one transcript at a time, so one read buffer serves every file. */
const chunk = Buffer.allocUnsafe(CHUNK);
/** Holds a line that crosses a read boundary; grown when a line is longer and reused for the next one. */
let spill = Buffer.allocUnsafe(CHUNK);
/** One byte, to check that a resume position still ends a line. */
const mark = Buffer.allocUnsafe(1);

/**
 * True when the byte before `position` ends a line, so the bytes after it start a whole entry. A transcript whose
 * last entry was cut short by a crash or an interrupted write fails this check and is read again from its start.
 */
function endsLine(file: string, position: number): boolean {
	if (position < 1) return true;
	const fd = fs.openSync(file, "r");
	try {
		return fs.readSync(fd, mark, 0, 1, position - 1) === 1 && mark[0] === NEWLINE;
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Calls `onLine` for each line `isWanted(head)` accepts, judged on its first HEAD_BYTES bytes, reading from
 * `offset` and returning the position after the last byte read. A rejected line is skipped as raw bytes and never
 * copied or decoded: tool results with images or large outputs run to many MB. A line wholly inside one read is
 * decoded straight from the read buffer; only a line crossing a read boundary is copied, once.
 */
function forEachWantedLine(file: string, offset: number, isWanted: (head: string) => boolean, onLine: (line: string) => void): number {
	const fd = fs.openSync(file, "r");
	try {
		let position = offset;
		/** Bytes of the line in progress held in `spill`; 0 when no line crosses a read boundary. */
		let carried = 0;
		/** Verdict on the line in progress: undefined until its head has been read, then true or false. */
		let wanted: boolean | undefined;
		/** Inside a rejected line, whose bytes are skipped until its newline. */
		let skipping = false;
		const reset = (): void => {
			carried = 0;
			wanted = undefined;
			skipping = false;
		};
		const keep = (view: Buffer, start: number, end: number): void => {
			const length = end - start;
			if (carried + length > spill.length) {
				let size = spill.length * 2;
				while (size < carried + length) size *= 2;
				const grown = Buffer.allocUnsafe(size);
				spill.copy(grown, 0, 0, carried);
				spill = grown;
			}
			view.copy(spill, carried, start, end);
			carried += length;
		};
		/** Judges the carried line; a rejected one drops its bytes and is skipped to its newline. */
		const judge = (): void => {
			wanted = isWanted(spill.toString("utf8", 0, Math.min(carried, HEAD_BYTES)));
			if (wanted) return;
			carried = 0;
			skipping = true;
		};
		for (;;) {
			const read = fs.readSync(fd, chunk, 0, CHUNK, position);
			if (read === 0) break;
			position += read;
			const view = chunk.subarray(0, read);
			let start = 0;
			while (start < read) {
				const newline = view.indexOf(NEWLINE, start);
				const end = newline === -1 ? read : newline;
				const length = end - start;
				if (skipping) {
					if (newline !== -1) {
						// The skipped line ends here; the next one is judged afresh.
						skipping = false;
						wanted = undefined;
					}
				} else if (carried > 0) {
					if (length > 0) {
						keep(view, start, end);
						if (wanted === undefined && carried >= HEAD_BYTES) judge();
					}
					if (newline !== -1) {
						if (wanted === undefined && !skipping) judge();
						if (wanted === true) onLine(spill.toString("utf8", 0, carried));
						reset();
					}
				} else if (length > 0) {
					const whole = newline !== -1;
					if (!whole && length < HEAD_BYTES) {
						keep(view, start, end);
					} else if (isWanted(view.toString("utf8", start, start + Math.min(length, HEAD_BYTES)))) {
						wanted = true;
						if (whole) {
							onLine(view.toString("utf8", start, end));
							reset();
						} else {
							keep(view, start, end);
						}
					} else if (!whole) {
						skipping = true;
					}
				}
				if (newline === -1) break;
				start = newline + 1;
			}
		}
		// A last line without a trailing newline counts like any other.
		if (carried > 0) {
			if (wanted === undefined) judge();
			if (wanted === true) onLine(spill.toString("utf8", 0, carried));
			reset();
		}
		return position;
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

/** One transcript's running aggregate: what a fresh read and a resumed one both build. */
type Aggregate = {
	readonly spend: Map<string, number>;
	readonly models: Set<string>;
	readonly costByProvider: Record<string, number>;
	agent: string | undefined;
	resolvedModel: string;
	fallback: boolean;
	exited: boolean;
};

/** The aggregate a cached entry stands for, ready to continue from its last byte. */
function stateOf(cached: FileAggregate | undefined): Aggregate {
	const dispatch = cached?.dispatch ?? null;
	const spend = new Map<string, number>();
	for (const [model, hour, usd] of cached?.spend ?? []) spend.set(`${model}\t${hour}`, usd);
	return {
		spend,
		models: new Set(dispatch?.models ?? []),
		costByProvider: { ...dispatch?.costByProvider },
		agent: dispatch?.agent,
		resolvedModel: dispatch?.resolvedModel ?? "",
		fallback: dispatch?.fallback ?? false,
		exited: dispatch?.exited ?? false,
	};
}

function charge(state: Aggregate, provider: string, model: string, timestamp: unknown, cost: number): void {
	if (!(cost > 0)) return;
	const at = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
	if (Number.isFinite(at)) {
		const key = `${provider}/${model}\t${Math.floor(at / HOUR_MS)}`;
		state.spend.set(key, (state.spend.get(key) ?? 0) + cost);
	}
	if (state.agent !== undefined) state.costByProvider[provider] = (state.costByProvider[provider] ?? 0) + cost;
}

/** Folds one wanted line into the aggregate. */
function fold(line: string, state: Aggregate): void {
	if (line.startsWith('{"type":"message"')) {
		const entry = parseLine(line);
		const message = entry?.message;
		if (!isRecord(message) || message.role !== "assistant") return;
		const { provider, model } = message;
		if (typeof provider !== "string" || typeof model !== "string") return;
		if (state.agent !== undefined) state.models.add(`${provider}/${model}`);
		charge(state, provider, model, entry?.timestamp, costOf(message.usage));
	} else if (line.startsWith('{"type":"model_usage"')) {
		const entry = parseLine(line);
		if (entry && typeof entry.provider === "string" && typeof entry.model === "string") {
			charge(state, entry.provider, entry.model, entry.timestamp, costOf(entry.usage));
		}
	} else if (line.startsWith('{"type":"session_init"')) {
		const entry = parseLine(line);
		if (entry && typeof entry.agent === "string") state.agent = entry.agent;
		if (entry && typeof entry.resolvedModel === "string") state.resolvedModel = entry.resolvedModel;
	} else if (line.startsWith('{"type":"model_change"')) {
		if (parseLine(line)?.resolvedModelIsFallback === true) state.fallback = true;
	} else if (line.startsWith('{"type":"custom"')) {
		state.exited = true;
	}
}

/**
 * Reads a transcript from `offset` into its aggregate. Resuming from a cached aggregate appends this run's
 * lines to it, so both additions and key order match one full read of the same bytes.
 */
function aggregateFile(file: string, offset: number, mtimeMs: number, ino: number, state: Aggregate): FileAggregate {
	const size = forEachWantedLine(file, offset, isWantedHead, (line) => fold(line, state));
	const spend: [string, number, number][] = [];
	for (const [key, usd] of state.spend) {
		const [model = "", hour] = key.split("\t");
		spend.push([model, Number(hour), usd]);
	}
	const dispatch: DispatchRecord | null =
		state.agent === undefined
			? null
			: {
					agent: state.agent,
					resolvedModel: state.resolvedModel,
					models: [...state.models],
					fallback: state.fallback,
					exited: state.exited,
					mtimeMs,
					costByProvider: state.costByProvider,
				};
	return { size, mtimeMs, ino, spend, dispatch };
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

/** Writes the cache entry by entry, so one string the size of the whole cache is never built. */
function writeCache(cachePath: string, cache: Cache): void {
	fs.mkdirSync(path.dirname(cachePath), { recursive: true });
	const temp = `${cachePath}.${process.pid}.tmp`;
	const fd = fs.openSync(temp, "w");
	try {
		let buffer = `{"version":${CACHE_VERSION},"files":{`;
		let separator = "";
		for (const file in cache.files) {
			buffer += `${separator}${JSON.stringify(file)}:${JSON.stringify(cache.files[file])}`;
			separator = ",";
			if (buffer.length >= 1 << 16) {
				fs.writeSync(fd, buffer);
				buffer = "";
			}
		}
		fs.writeSync(fd, `${buffer}}}`);
	} finally {
		fs.closeSync(fd);
	}
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
		const cached = isFileAggregate(previous[file]) ? previous[file] : undefined;
		if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
			files[file] = cached;
			continue;
		}
		// A transcript that only grew continues from where the last scan stopped, provided that file is still the
		// same one (a rewrite replaces it, so the inode changes) and that point still ends a line; one that shrank,
		// was rewritten, or ended in a cut-off entry is read again from its start.
		try {
			const resumed =
				cached !== undefined && cached.ino === stat.ino && cached.size < stat.size && endsLine(file, cached.size) ? cached : undefined;
			files[file] = aggregateFile(file, resumed?.size ?? 0, stat.mtimeMs, stat.ino, stateOf(resumed));
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
	for (const file of transcripts) {
		const aggregate = files[file];
		if (aggregate === undefined) continue;
		for (const [model, hour, usd] of aggregate.spend) {
			let series = spend[model];
			if (series === undefined) spend[model] = series = {};
			const slot = String(hour);
			series[slot] = (series[slot] ?? 0) + usd;
		}
		// Attaches the path to the record the scan built instead of copying it; the cache was written above.
		if (aggregate.dispatch !== null) dispatches.push(Object.assign(aggregate.dispatch, { file }));
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
