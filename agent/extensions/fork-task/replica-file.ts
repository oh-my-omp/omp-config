import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { Replica } from "./replica.ts";

/**
 * The plain-data part of a replica, written by the parent's spawn hook so a
 * child OMP runs in a subagent worker thread (its own copy of this module)
 * can read it. The borrowed `ask` tool is a live object and stays behind.
 */
export type PortableReplica = Omit<Replica, "ask">;

const replaySchema = z.union([
	z.object({
		kind: z.literal("prefix"),
		response: z.number().optional(),
		notice: z.object({ entryId: z.string(), timestamp: z.number() }),
	}),
	z.object({ kind: z.literal("own") }),
]);

const portableSchema = z.object({
	request: z.object({
		model: z.object({ provider: z.string(), id: z.string() }).passthrough(),
		context: z.object({ systemPrompt: z.unknown(), messages: z.array(z.unknown()), tools: z.array(z.unknown()).optional() }),
		options: z.record(z.string(), z.unknown()),
	}),
	systemPrompt: z.array(z.string()),
	toolNames: z.array(z.string()),
	sourceModel: z.string(),
	replay: replaySchema,
	inheritReasoning: z.boolean(),
});

/** Where the copy for the child whose session file is `childFile` lives; the same path in every thread. */
export function replicaFilePath(root: string, childFile: string): string {
	return path.join(root, "replicas", `${createHash("sha256").update(childFile).digest("hex")}.json`);
}

export async function writeReplicaFile(file: string, replica: Replica): Promise<void> {
	const { ask: _live, ...portable } = replica;
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(portable));
}

/** The copy, or undefined when none was written for this child (not a fork, or its parent has shut down). */
export async function readReplicaFile(file: string): Promise<PortableReplica | undefined> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	const { request, replay, ...rest } = portableSchema.parse(JSON.parse(text));
	return {
		...rest,
		// Written by writeReplicaFile from the source's own request; the schema checks the fields this extension reads.
		request: request as unknown as Replica["request"],
		// JSON drops an undefined `response`; the prefix replay keeps the key.
		replay: replay.kind === "prefix" ? { kind: "prefix", response: replay.response, notice: replay.notice } : replay,
	};
}
