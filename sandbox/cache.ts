// Prompt-cache export, run inside the sandbox as
//   bun /sandbox/cache.ts SESSIONS_DIR OUT_JSON
// Reads every `*.jsonl` under SESSIONS_DIR (main sessions and the subagent transcripts nested in
// their directories) and records each model call the transcripts carry: an assistant `message`
// entry is a turn of the agent loop, a `model_usage` entry an auxiliary call tagged with its
// `purpose`. Per call it keeps only the provider, model, stop reason, timestamp and token counts;
// no message text leaves the file. Token counts follow omp's normalized usage, where `input`
// excludes cached tokens, so a call's prompt is input + cacheRead + cacheWrite and its hit rate
// is cacheRead / prompt (null for a call with no prompt tokens, such as a provider error).
//
// Writes OUT_JSON ({ sessionsDir, exportedAt, skipped, calls, byTranscript, byModel }) and prints
// the two totals tables as Markdown. `skipped` counts lines that are not JSON objects (a torn last
// line of a session still being written). Exit 0 on success (also with no sessions), 2 for a
// malformed invocation, 1 when SESSIONS_DIR cannot be read.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Mapping = { readonly [key: string]: unknown };

type Source = { readonly kind: "turn" } | { readonly kind: "aux"; readonly purpose: string };

interface Tokens {
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
}

interface Call extends Tokens {
	readonly transcript: string;
	readonly line: number;
	readonly at: string;
	readonly source: Source;
	readonly provider: string;
	readonly model: string;
	readonly stopReason: string;
	readonly hitRate: number | null;
}

interface Totals extends Tokens {
	readonly key: string;
	readonly calls: number;
	readonly callsWithRead: number;
	readonly hitRate: number | null;
}

const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

function hitRate(tokens: Tokens): number | null {
	const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	return prompt === 0 ? null : tokens.cacheRead / prompt;
}

/** One transcript line → a call, or null when the line records no model call. */
function callOf(entry: Mapping, transcript: string, line: number): Call | null {
	let source: Source;
	let carrier: Mapping;
	if (entry.type === "message" && isMapping(entry.message) && entry.message.role === "assistant") {
		source = { kind: "turn" };
		carrier = entry.message;
	} else if (entry.type === "model_usage") {
		source = { kind: "aux", purpose: text(entry.purpose) || "unknown" };
		carrier = entry;
	} else return null;
	const usage = carrier.usage;
	if (!isMapping(usage)) return null;
	const tokens: Tokens = {
		input: count(usage.input),
		cacheRead: count(usage.cacheRead),
		cacheWrite: count(usage.cacheWrite),
		output: count(usage.output),
	};
	return {
		transcript,
		line,
		at: text(entry.timestamp),
		source,
		provider: text(carrier.provider),
		model: text(carrier.model),
		stopReason: text(carrier.stopReason),
		...tokens,
		hitRate: hitRate(tokens),
	};
}

function readCalls(dir: string): { readonly calls: Call[]; readonly skipped: number } {
	const calls: Call[] = [];
	let skipped = 0;
	const transcripts = readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((path) => path.endsWith(".jsonl"))
		.sort();
	for (const transcript of transcripts) {
		const lines = readFileSync(join(dir, transcript), "utf8").split("\n");
		for (const [index, raw] of lines.entries()) {
			if (raw.trim() === "") continue;
			let entry: unknown;
			try {
				entry = JSON.parse(raw);
			} catch {
				// A torn last line of a session that is still being written.
				skipped++;
				continue;
			}
			if (!isMapping(entry)) {
				skipped++;
				continue;
			}
			const call = callOf(entry, transcript, index + 1);
			if (call !== null) calls.push(call);
		}
	}
	return { calls, skipped };
}

function totalsBy(calls: readonly Call[], keyOf: (call: Call) => string): Totals[] {
	const groups = new Map<string, Call[]>();
	for (const call of calls) {
		const group = groups.get(keyOf(call));
		if (group === undefined) groups.set(keyOf(call), [call]);
		else group.push(call);
	}
	return [...groups].map(([key, group]) => {
		const tokens: Tokens = {
			input: group.reduce((sum, call) => sum + call.input, 0),
			cacheRead: group.reduce((sum, call) => sum + call.cacheRead, 0),
			cacheWrite: group.reduce((sum, call) => sum + call.cacheWrite, 0),
			output: group.reduce((sum, call) => sum + call.output, 0),
		};
		return {
			key,
			calls: group.length,
			callsWithRead: group.filter((call) => call.cacheRead > 0).length,
			...tokens,
			hitRate: hitRate(tokens),
		};
	});
}

function table(title: string, rows: readonly Totals[]): string {
	return [
		`### ${title}`,
		"",
		"| | calls | calls with cache read | input | cacheRead | cacheWrite | output | hit rate |",
		"|---|---:|---:|---:|---:|---:|---:|---:|",
		...rows.map(
			(row) =>
				`| ${row.key} | ${row.calls} | ${row.callsWithRead} | ${row.input} | ${row.cacheRead} | ${row.cacheWrite} | ${row.output} | ${row.hitRate === null ? "—" : `${(row.hitRate * 100).toFixed(1)}%`} |`,
		),
		"",
	].join("\n");
}

function main(argv: readonly string[]): number {
	const [sessionsDir, out] = argv;
	if (sessionsDir === undefined || out === undefined || argv.length !== 2) {
		console.error("usage: bun cache.ts SESSIONS_DIR OUT_JSON");
		return 2;
	}
	let read: { readonly calls: Call[]; readonly skipped: number };
	try {
		read = readCalls(sessionsDir);
	} catch (error) {
		console.error(`cache: cannot read ${sessionsDir}: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const byTranscript = totalsBy(read.calls, (call) => call.transcript);
	const byModel = totalsBy(read.calls, (call) => `${call.provider}/${call.model}`);
	writeFileSync(
		out,
		`${JSON.stringify({ sessionsDir, exportedAt: new Date().toISOString(), skipped: read.skipped, calls: read.calls, byTranscript, byModel }, null, 2)}\n`,
	);
	console.log(`${read.calls.length} model calls in ${byTranscript.length} transcripts (${read.skipped} lines skipped)\n`);
	console.log(table("By transcript", byTranscript));
	console.log(table("By model", byModel));
	return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
