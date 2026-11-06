import { randomUUID } from "node:crypto";
import { z } from "@oh-my-pi/pi-coding-agent";
import { type SharedSource, shareSource } from "./replica.ts";
import { parsePortableSource } from "./replica-file.ts";

/**
 * Cross-thread access to live fork sources. OMP may host a session in a
 * subagent worker thread, which loads its own copy of this extension; a
 * session's requests are observed only in its own thread, the source of truth
 * for them. A thread forking a source it does not host asks every thread of
 * the process over a BroadcastChannel; the hosting thread answers with the
 * latest request after flushing the transcript, the others stay silent.
 */
const CHANNEL = "omp-fork-task/source";

/** How long the asker waits; the owning thread answers after one transcript flush. */
const ANSWER_TIMEOUT_MS = 5000;

const messageSchema = z.union([
	z.object({ kind: z.literal("ask"), id: z.string(), file: z.string() }),
	// `answer` is the JSON text of a SharedSource: requests carry provider schemas structured clone may reject.
	z.object({ kind: z.literal("answer"), id: z.string(), answer: z.string() }),
]);

const answerSchema = z.union([
	z.object({ kind: z.literal("ready"), source: z.unknown() }),
	z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);

let server: BroadcastChannel | undefined;

/** Answer asks for this thread's live sources; once per thread, kept for the thread's life without holding it open. */
export function serveSources(warn: (message: string, error: unknown) => void): void {
	if (server) return;
	const channel = new BroadcastChannel(CHANNEL);
	channel.unref();
	channel.onmessage = (event) => {
		const message = messageSchema.safeParse(event.data);
		if (!message.success || message.data.kind !== "ask") return;
		const { id, file } = message.data;
		shareSource(file).then(
			(answer) => {
				if (answer) channel.postMessage({ kind: "answer", id, answer: JSON.stringify(answer) });
			},
			(error: unknown) => {
				warn("fork_task: answering another thread for a fork source failed", error);
				channel.postMessage({
					kind: "answer",
					id,
					answer: JSON.stringify({ kind: "unavailable", reason: `its thread failed to share it: ${String(error)}` }),
				});
			},
		);
	};
	server = channel;
}

/** The live source whose transcript is `file`, from the thread hosting it; undefined when no thread answered in time. */
export async function askSource(file: string): Promise<SharedSource | undefined> {
	const id = randomUUID();
	const channel = new BroadcastChannel(CHANNEL);
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	const timer = setTimeout(() => resolve(undefined), ANSWER_TIMEOUT_MS);
	channel.onmessage = (event) => {
		const message = messageSchema.safeParse(event.data);
		if (!message.success || message.data.kind !== "answer" || message.data.id !== id) return;
		resolve(message.data.answer);
	};
	try {
		channel.postMessage({ kind: "ask", id, file });
		const text = await promise;
		if (text === undefined) return undefined;
		const answer = answerSchema.parse(JSON.parse(text));
		return answer.kind === "ready" ? { kind: "ready", source: parsePortableSource(answer.source) } : answer;
	} finally {
		clearTimeout(timer);
		channel.close();
	}
}
