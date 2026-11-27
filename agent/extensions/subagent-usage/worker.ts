// Pure fs/JSON: host packages are not importable from a worker; type imports are erased.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { CustomEntry, ModelChangeEntry, ModelUsageEntry, SessionInitEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { HOUR_MS, modelKey } from "./keys.ts";
import type { DispatchRecord, ScannedDispatch, ScanRequest, ScanResult } from "./records.ts";

declare const self: Worker;

const CHUNK = 1 << 20;
const CACHE_VERSION = 4;

type FileAggregate = {
	readonly size: number;
	readonly mtimeMs: number;
	readonly ino: number;
	readonly tail: string;
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
		typeof value.tail === "string" &&
		Array.isArray(value.spend) &&
		value.spend.every(isSpend) &&
		(value.dispatch === null || isDispatch(value.dispatch))
	);
}

function isCache(value: unknown): value is Cache {
	return isRecord(value) && value.version === CACHE_VERSION && isRecord(value.files);
}

type WantedEntry = SessionMessageEntry | ModelUsageEntry | SessionInitEntry | ModelChangeEntry | CustomEntry;

function parseEntry(line: string): WantedEntry | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || typeof value.type !== "string") return undefined;
	switch (value.type) {
		case "message":
			// SAFETY: isWantedHead admits only lines starting `{"type":"message"` with `"message":{"role":"assistant"`; fold type-checks every other field it reads.
			return value as unknown as SessionMessageEntry;
		case "model_usage":
			// SAFETY: fold type-checks provider, model, timestamp and usage cost before using them.
			return value as unknown as ModelUsageEntry;
		case "session_init":
			// SAFETY: fold type-checks agent and resolvedModel before using them.
			return value as unknown as SessionInitEntry;
		case "model_change":
			// SAFETY: fold reads only resolvedModelIsFallback, compared with `=== true`.
			return value as unknown as ModelChangeEntry;
		case "custom":
			// SAFETY: customType is checked here and fold reads no other field of a custom entry.
			return value.customType === "session_exit" ? (value as unknown as CustomEntry) : undefined;
		default:
			return undefined;
	}
}

function costOf(usage: Usage | undefined): number {
	const total = usage?.cost?.total;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function listTranscripts(dir: string, out: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) listTranscripts(full, out);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
	}
}

const HEAD_BYTES = 256;
const NEWLINE = 0x0a;

const chunk = Buffer.allocUnsafe(CHUNK);
let spill = Buffer.allocUnsafe(CHUNK);
const TAIL_BYTES = 256;
const tail = Buffer.allocUnsafe(TAIL_BYTES);

function tailMark(file: string, position: number): string {
	const start = Math.max(0, position - TAIL_BYTES);
	const length = position - start;
	if (length === 0) return "";
	const fd = fs.openSync(file, "r");
	try {
		if (fs.readSync(fd, tail, 0, length, start) !== length) return "";
	} finally {
		fs.closeSync(fd);
	}
	if (tail[length - 1] !== NEWLINE) return "";
	return Bun.hash(tail.subarray(0, length)).toString(16);
}

type LineState = "start" | "undecided" | "wanted" | "skipping";

function forEachWantedLine(file: string, offset: number, isWanted: (head: string) => boolean, onLine: (line: string) => void): number {
	const fd = fs.openSync(file, "r");
	try {
		let position = offset;
		let state: LineState = "start";
		let carried = 0;
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
		const finish = (emit: boolean): LineState => {
			if (emit) onLine(spill.toString("utf8", 0, carried));
			carried = 0;
			return "start";
		};
		const step = (view: Buffer, start: number, end: number, whole: boolean): LineState => {
			switch (state) {
				case "skipping":
					return whole ? "start" : "skipping";
				case "wanted":
					keep(view, start, end);
					return whole ? finish(true) : "wanted";
				case "undecided":
					keep(view, start, end);
					if (!whole && carried < HEAD_BYTES) return "undecided";
					if (isWanted(spill.toString("utf8", 0, Math.min(carried, HEAD_BYTES)))) return whole ? finish(true) : "wanted";
					carried = 0;
					return whole ? "start" : "skipping";
				case "start": {
					const length = end - start;
					if (!whole && length < HEAD_BYTES) {
						keep(view, start, end);
						return "undecided";
					}
					if (!isWanted(view.toString("utf8", start, start + Math.min(length, HEAD_BYTES)))) return whole ? "start" : "skipping";
					if (whole) {
						onLine(view.toString("utf8", start, end));
						return "start";
					}
					keep(view, start, end);
					return "wanted";
				}
				default: {
					const never: never = state;
					return never;
				}
			}
		};
		for (;;) {
			const read = fs.readSync(fd, chunk, 0, CHUNK, position);
			if (read === 0) break;
			position += read;
			const view = chunk.subarray(0, read);
			let start = 0;
			while (start < read) {
				const newline = view.indexOf(NEWLINE, start);
				state = step(view, start, newline === -1 ? read : newline, newline !== -1);
				if (newline === -1) break;
				start = newline + 1;
			}
		}
		step(chunk, 0, 0, true);
		return position;
	} finally {
		fs.closeSync(fd);
	}
}

function isWantedHead(head: string): boolean {
	return (
		(head.startsWith('{"type":"message"') && head.includes('"message":{"role":"assistant"')) ||
		head.startsWith('{"type":"model_usage"') ||
		head.startsWith('{"type":"session_init"') ||
		head.startsWith('{"type":"model_change"') ||
		head.startsWith('{"type":"custom","customType":"session_exit"')
	);
}

type Aggregate = {
	readonly spend: Map<string, number>;
	readonly models: Set<string>;
	readonly costByProvider: Record<string, number>;
	agent: string | undefined;
	resolvedModel: string;
	fallback: boolean;
	exited: boolean;
};

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
		const key = `${modelKey({ provider, id: model })}\t${Math.floor(at / HOUR_MS)}`;
		state.spend.set(key, (state.spend.get(key) ?? 0) + cost);
	}
	if (state.agent !== undefined) state.costByProvider[provider] = (state.costByProvider[provider] ?? 0) + cost;
}

function fold(line: string, state: Aggregate): void {
	const entry = parseEntry(line);
	if (entry === undefined) return;
	switch (entry.type) {
		case "message": {
			const { message } = entry;
			if (message.role !== "assistant") return;
			const { provider, model } = message;
			if (typeof provider !== "string" || typeof model !== "string") return;
			if (state.agent !== undefined) state.models.add(modelKey({ provider, id: model }));
			charge(state, provider, model, entry.timestamp, costOf(message.usage));
			return;
		}
		case "model_usage":
			if (typeof entry.provider === "string" && typeof entry.model === "string") {
				charge(state, entry.provider, entry.model, entry.timestamp, costOf(entry.usage));
			}
			return;
		case "session_init":
			if (typeof entry.agent === "string") state.agent = entry.agent;
			if (typeof entry.resolvedModel === "string") state.resolvedModel = entry.resolvedModel;
			return;
		case "model_change":
			if (entry.resolvedModelIsFallback === true) state.fallback = true;
			return;
		case "custom":
			state.exited = true;
			return;
	}
}

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
	return { size, mtimeMs, ino, tail: tailMark(file, size), spend, dispatch };
}

function loadCache(cachePath: string): Cache {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(cachePath, "utf8"));
		if (isCache(value)) return value;
	} catch {}
	return { version: CACHE_VERSION, files: {} };
}

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
			continue;
		}
		const cached = isFileAggregate(previous[file]) ? previous[file] : undefined;
		if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
			files[file] = cached;
			continue;
		}
		try {
			let resumed: FileAggregate | undefined;
			if (cached !== undefined && cached.ino === stat.ino && cached.size < stat.size) {
				const mark = tailMark(file, cached.size);
				if (mark !== "" && mark === cached.tail) resumed = cached;
			}
			files[file] = aggregateFile(file, resumed?.size ?? 0, stat.mtimeMs, stat.ino, stateOf(resumed));
			parsed++;
		} catch {}
	}
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
		if (aggregate.dispatch !== null) dispatches.push({ ...aggregate.dispatch, file });
	}
	return { kind: "done", spend, dispatches, files: transcripts.length, parsed };
}

self.onmessage = (event: MessageEvent<ScanRequest>) => {
	let result: ScanResult;
	try {
		result = scan(event.data);
	} catch (error) {
		result = { kind: "failed", reason: errorText(error) };
	}
	postMessage(result);
};
