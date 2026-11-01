// Observed per-dispatch USD from subagent transcripts under the given session directories.
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";

/** One agent's first model: the only model whose dispatches count. */
export type Target = {
	readonly agent: string;
	readonly provider: string;
	readonly modelId: string;
	/** Thinking level the binding or definition fixes; undefined matches any. */
	readonly thinking: string | undefined;
};

export type SampleScan = {
	/** USD per eligible dispatch, newest first, keyed by agent name. */
	readonly costs: ReadonlyMap<string, readonly number[]>;
	/** Transcripts whose head was read. */
	readonly inspected: number;
};

/** The estimator's window: the newest eligible dispatches per agent across the pooled sessions. */
export const MAX_SAMPLES_PER_AGENT = 20;
/** A transcript without `session_exit` counts as settled once untouched this long. */
const SETTLED_MS = 30 * 60 * 1000;
const HEAD_CHUNK = 16 * 1024;
/** `session_init` follows the title, header, model and thinking entries; a head without it is not a dispatch. */
const HEAD_LINES = 8;
const HEAD_BATCH = 32;

const sessionInitSchema = z.object({ type: z.literal("session_init"), agent: z.string(), resolvedModel: z.string().optional() });
const costSchema = z.object({ cost: z.object({ total: z.number() }).optional() }).optional();
const assistantSchema = z.object({
	type: z.literal("message"),
	message: z.object({ role: z.literal("assistant"), provider: z.string(), model: z.string(), usage: costSchema }),
});
const modelUsageSchema = z.object({ type: z.literal("model_usage"), provider: z.string(), usage: costSchema });
const modelChangeSchema = z.object({ type: z.literal("model_change"), resolvedModelIsFallback: z.boolean().optional() });

type Candidate = { readonly file: string; readonly mtimeMs: number };
type Head = { readonly agent: string; readonly resolvedModel: string | undefined };

function parseLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		// A torn or truncated JSONL record is not a usable entry.
		return undefined;
	}
}

/** Subagent transcripts live in each main session's artifact directory, nested per spawning agent. */
async function listTranscripts(dir: string, depth: number, out: Candidate[]): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		// A session directory or worktree bucket that does not exist has no transcripts.
		return;
	}
	await Promise.all(
		entries.map(async (entry) => {
			if (entry.name.startsWith(".")) return;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) return listTranscripts(full, depth + 1, out);
			// depth 0 holds main sessions, which are not dispatches.
			if (depth === 0 || !entry.isFile() || !entry.name.endsWith(".jsonl")) return;
			try {
				out.push({ file: full, mtimeMs: (await fs.stat(full)).mtimeMs });
			} catch {
				// Removed between readdir and stat.
			}
		}),
	);
}

/** Reads only as far as the `session_init` line: in chunks, since an assignment can make that line long. */
async function readHead(file: string): Promise<Head | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file);
	} catch {
		// Removed or unreadable transcripts are skipped.
		return undefined;
	}
	try {
		const chunks: Buffer[] = [];
		for (let offset = 0; ; ) {
			const buffer = Buffer.alloc(HEAD_CHUNK);
			const { bytesRead } = await handle.read(buffer, 0, HEAD_CHUNK, offset);
			if (bytesRead === 0) return undefined;
			chunks.push(buffer.subarray(0, bytesRead));
			offset += bytesRead;
			// The last element may be a partial line; only newline-terminated lines are judged.
			const lines = Buffer.concat(chunks).toString("utf8").split("\n").slice(0, -1);
			for (const [index, line] of lines.entries()) {
				if (line.startsWith('{"type":"session_init"')) {
					const parsed = sessionInitSchema.safeParse(parseLine(line));
					return parsed.success ? { agent: parsed.data.agent, resolvedModel: parsed.data.resolvedModel } : undefined;
				}
				if (index >= HEAD_LINES) return undefined;
			}
		}
	} catch {
		// A read error mid-file leaves the transcript unusable.
		return undefined;
	} finally {
		await handle.close();
	}
}

/** Thinking suffix of a resolved selector such as `openai-codex/gpt-5.6-sol:high@route`. */
function thinkingOf(resolvedModel: string): string | undefined {
	return /:(off|minimal|low|medium|high|xhigh|max)(?:@|$)/.exec(resolvedModel)?.[1];
}

/**
 * USD one finished dispatch spent on the target's provider, or undefined when the transcript is
 * still live, never answered, or served any request on another model (a fallback).
 */
async function dispatchCost(candidate: Candidate, target: Target, now: number): Promise<number | undefined> {
	let text: string;
	try {
		text = await fs.readFile(candidate.file, "utf8");
	} catch {
		return undefined;
	}
	const modelKey = `${target.provider}/${target.modelId}`;
	let cost = 0;
	let answered = false;
	let exited = false;
	for (const line of text.split("\n")) {
		if (line.startsWith('{"type":"message"')) {
			if (!line.includes('"role":"assistant"')) continue;
			const parsed = assistantSchema.safeParse(parseLine(line));
			if (!parsed.success) continue;
			const message = parsed.data.message;
			if (`${message.provider}/${message.model}` !== modelKey) return undefined;
			answered = true;
			cost += message.usage?.cost?.total ?? 0;
		} else if (line.startsWith('{"type":"model_usage"')) {
			const parsed = modelUsageSchema.safeParse(parseLine(line));
			if (parsed.success && parsed.data.provider === target.provider) cost += parsed.data.usage?.cost?.total ?? 0;
		} else if (line.startsWith('{"type":"model_change"')) {
			const parsed = modelChangeSchema.safeParse(parseLine(line));
			if (parsed.success && parsed.data.resolvedModelIsFallback === true) return undefined;
		} else if (line.startsWith('{"type":"custom"') && line.includes('"customType":"session_exit"')) {
			exited = true;
		}
	}
	if (!answered) return undefined;
	if (!exited && now - candidate.mtimeMs < SETTLED_MS) return undefined;
	return cost;
}

/**
 * Newest-first scan over every subagent transcript of the pooled directories, stopping once each
 * target holds MAX_SAMPLES_PER_AGENT eligible dispatches or the transcripts run out.
 */
export async function collectSamples(dirs: readonly string[], targets: readonly Target[], now: number): Promise<SampleScan> {
	const candidates: Candidate[] = [];
	await Promise.all(dirs.map((dir) => listTranscripts(dir, 0, candidates)));
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const byAgent = new Map(targets.map((target) => [target.agent, target]));
	const costs = new Map<string, number[]>(targets.map((target) => [target.agent, []]));
	let openAgents = targets.length;
	let inspected = 0;
	for (let start = 0; start < candidates.length && openAgents > 0; start += HEAD_BATCH) {
		const batch = candidates.slice(start, start + HEAD_BATCH);
		const heads = await Promise.all(batch.map((candidate) => readHead(candidate.file)));
		inspected += batch.length;
		for (const [index, head] of heads.entries()) {
			const candidate = batch[index];
			if (!head || !candidate) continue;
			const target = byAgent.get(head.agent);
			const list = costs.get(head.agent);
			if (!target || !list || list.length >= MAX_SAMPLES_PER_AGENT) continue;
			if (target.thinking !== undefined && (!head.resolvedModel || thinkingOf(head.resolvedModel) !== target.thinking)) continue;
			const cost = await dispatchCost(candidate, target, now);
			if (cost === undefined) continue;
			list.push(cost);
			if (list.length === MAX_SAMPLES_PER_AGENT) openAgents--;
		}
	}
	return { costs, inspected };
}
