import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { PortableSource, Replica } from "./replica.ts";

/** Root of everything fork_task writes outside the session store: staging JSONL, replica copies, parked requests, workspace starts, overlays. */
export const STAGING_ROOT = path.join(os.tmpdir(), "omp-fork-task");

/**
 * The plain-data part of a replica: the parent's spawn hook writes it, and the
 * child's first turn reads it, in whichever thread OMP hosts the child. The
 * borrowed `ask` tool is a live object and stays in the spawning thread.
 */
export type PortableReplica = Omit<Replica, "ask">;

const requestSchema = z.object({
	model: z.object({ provider: z.string(), id: z.string() }).passthrough(),
	context: z.object({ systemPrompt: z.unknown(), messages: z.array(z.unknown()), tools: z.array(z.unknown()).optional() }),
	options: z.record(z.string(), z.unknown()),
});

const replaySchema = z.union([
	z.object({
		kind: z.literal("prefix"),
		response: z.number().optional(),
		notice: z.object({ entryId: z.string(), timestamp: z.number() }),
	}),
	z.object({ kind: z.literal("own") }),
]);

const portableSchema = z.object({
	request: requestSchema,
	systemPrompt: z.array(z.string()),
	toolNames: z.array(z.string()),
	sourceModel: z.string(),
	replay: replaySchema,
	inheritReasoning: z.boolean(),
});

const thinkingLevels: readonly string[] = Object.values(ThinkingLevel);

function isThinkingLevel(value: string): value is ThinkingLevel {
	return thinkingLevels.includes(value);
}

const portableSourceSchema = z.object({
	request: requestSchema,
	response: z.number().optional(),
	systemPrompt: z.array(z.string()),
	toolNames: z.array(z.string()),
	thinkingLevel: z.string().optional(),
	cwd: z.string(),
});

/** This OMP process's replica-copy directory, shared by its main and worker threads. */
export function replicasRoot(): string {
	return path.join(STAGING_ROOT, "replicas", String(process.pid));
}

/** Where the copy for the child whose session file is `childFile` lives; the same path in every thread. */
export function replicaFilePath(childFile: string): string {
	return path.join(replicasRoot(), `${createHash("sha256").update(childFile).digest("hex")}.json`);
}

export async function writeReplicaFile(file: string, replica: Replica): Promise<void> {
	const { ask: _live, ...portable } = replica;
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(portable));
}

/** The copy, or undefined when none was written for this child (not a fork, or the main session has shut down). */
export async function readReplicaFile(file: string): Promise<PortableReplica | undefined> {
	const text = await readOptional(file);
	if (text === undefined) return undefined;
	const { request, replay, ...rest } = portableSchema.parse(JSON.parse(text));
	return {
		...rest,
		// Written by writeReplicaFile from the source's own request; the schema checks the fields this extension reads.
		request: request as unknown as Replica["request"],
		// JSON drops an undefined `response`; the prefix replay keeps the key.
		replay: replay.kind === "prefix" ? { kind: "prefix", response: replay.response, notice: replay.notice } : replay,
	};
}

/** This OMP process's parked-request directory, shared by its main and worker threads. */
export function parkedRoot(): string {
	return path.join(STAGING_ROOT, "parked", String(process.pid));
}

/** Where the request a session kept at park is written, by its session file; the same path in every thread. */
export function parkedFilePath(sessionFile: string): string {
	return path.join(parkedRoot(), `${createHash("sha256").update(sessionFile).digest("hex")}.json`);
}

/** Parse a source request another thread serialized with JSON. */
export function parsePortableSource(value: unknown): PortableSource {
	const { request, response, thinkingLevel, ...rest } = portableSourceSchema.parse(value);
	if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) throw new Error(`unknown thinking level \`${thinkingLevel}\``);
	return {
		...rest,
		// Serialized by replica.ts from the source's own request; the schema checks the fields this extension reads.
		request: request as unknown as PortableSource["request"],
		response,
		thinkingLevel,
	};
}

export async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}
