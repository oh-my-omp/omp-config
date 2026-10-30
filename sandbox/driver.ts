// RPC driver (S5), run inside the sandbox as
//   bun /sandbox/driver.ts SCENARIO_JSON MODEL EVIDENCE_DIR
// One scenario against one model through `omp --mode rpc --no-ui`. The scenario's `init` runs in
// sh (the driver, not the agent) before the session; the prompt is sent once; every tool call is
// recorded; then `finalAssertion` runs in sh and the declared call and reply assertions are
// checked. The driver reads the scenario and never interprets what it means.
//
// Scenario file (JSON):
//   name            [a-z0-9][a-z0-9._-]*; names the evidence files
//   init            sh command, exit 0 required
//   prompt          the user message
//   finalAssertion  sh command; exit 0 passes
//   calls?          { expect?: Matcher[], forbid?: Matcher[] }
//                   expect: matched in order as a subsequence of the tool calls;
//                   forbid: no tool call may match any of them
//   replyIncludes?  literal strings the last assistant reply must contain
//   Matcher         { tool, isError?, inputPattern? (regex over the call's JSON input), resultIncludes? }
//
// Result, one of:
//   pass           every assertion held
//   fail           the session ran and an assertion did not hold
//   untested       omp does not know the model, or every assistant reply failed at the provider
//                  and no tool ran (S3/S4)
//   harness-error  init failed, omp exited before its ready frame for another reason, the prompt
//                  was rejected, the session timed out, omp exited nonzero, or no session file was written
//
// Writes EVIDENCE_DIR/<name>.driver.json, <name>.events.jsonl (every RPC frame, streamed) and
// <name>.session.jsonl (the session file omp reports through get_state). Exit 0 for pass and
// untested, 1 otherwise, 2 for a malformed invocation.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Matcher {
	readonly tool: string;
	readonly isError?: boolean;
	readonly inputPattern?: string;
	readonly resultIncludes?: string;
}

export interface Scenario {
	readonly name: string;
	readonly init: string;
	readonly prompt: string;
	readonly finalAssertion: string;
	readonly expect: readonly Matcher[];
	readonly forbid: readonly Matcher[];
	readonly replyIncludes: readonly string[];
}

interface Call {
	readonly tool: string;
	readonly input: unknown;
	readonly isError: boolean;
	readonly result: string;
}

type Mapping = { readonly [key: string]: unknown };

type Outcome =
	| { readonly kind: "pass" }
	| { readonly kind: "fail"; readonly failures: readonly string[] }
	| { readonly kind: "untested"; readonly reason: string }
	| { readonly kind: "harness-error"; readonly reason: string };

const SESSION_TIMEOUT_MS = 600_000;
const NAME = /^[a-z0-9][a-z0-9._-]*$/;

const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function parseMatcher(value: unknown, where: string): Matcher {
	if (!isMapping(value) || typeof value.tool !== "string") throw new Error(`${where}: a matcher needs a string "tool"`);
	if (value.isError !== undefined && typeof value.isError !== "boolean") throw new Error(`${where}: "isError" must be a boolean`);
	if (value.inputPattern !== undefined && typeof value.inputPattern !== "string")
		throw new Error(`${where}: "inputPattern" must be a string`);
	if (value.resultIncludes !== undefined && typeof value.resultIncludes !== "string")
		throw new Error(`${where}: "resultIncludes" must be a string`);
	if (typeof value.inputPattern === "string") new RegExp(value.inputPattern);
	return {
		tool: value.tool,
		...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
		...(typeof value.inputPattern === "string" ? { inputPattern: value.inputPattern } : {}),
		...(typeof value.resultIncludes === "string" ? { resultIncludes: value.resultIncludes } : {}),
	};
}

function parseMatchers(value: unknown, where: string): Matcher[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
	return value.map((item, index) => parseMatcher(item, `${where}[${index}]`));
}

export function parseScenario(raw: unknown): Scenario {
	if (!isMapping(raw)) throw new Error("the scenario must be a JSON object");
	for (const key of ["name", "init", "prompt", "finalAssertion"] as const) {
		if (typeof raw[key] !== "string") throw new Error(`scenario "${key}" must be a string`);
	}
	const name = String(raw.name);
	if (!NAME.test(name)) throw new Error(`scenario "name" must match ${NAME}`);
	const calls = raw.calls === undefined ? {} : raw.calls;
	if (!isMapping(calls)) throw new Error(`scenario "calls" must be an object`);
	if (raw.replyIncludes !== undefined && !isStringArray(raw.replyIncludes))
		throw new Error(`scenario "replyIncludes" must be a string array`);
	return {
		name,
		init: String(raw.init),
		prompt: String(raw.prompt),
		finalAssertion: String(raw.finalAssertion),
		expect: parseMatchers(calls.expect, "calls.expect"),
		forbid: parseMatchers(calls.forbid, "calls.forbid"),
		replyIncludes: isStringArray(raw.replyIncludes) ? raw.replyIncludes : [],
	};
}

function shell(command: string): { code: number | null; out: string } {
	const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
	return { code: result.status, out: `${result.stdout}${result.stderr}`.trim() };
}

function textOf(value: unknown): string {
	if (!isMapping(value) || !Array.isArray(value.content)) return "";
	return value.content.flatMap((part) => (isMapping(part) && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

function matches(call: Call, matcher: Matcher): boolean {
	if (call.tool !== matcher.tool) return false;
	if (matcher.isError !== undefined && call.isError !== matcher.isError) return false;
	if (matcher.inputPattern !== undefined && !new RegExp(matcher.inputPattern).test(JSON.stringify(call.input) ?? "")) return false;
	if (matcher.resultIncludes !== undefined && !call.result.includes(matcher.resultIncludes)) return false;
	return true;
}

/** The assertion failures of a finished session; empty means pass. */
function assertionFailures(scenario: Scenario, calls: readonly Call[], finalCode: number | null, lastReply: string): string[] {
	const failures: string[] = [];
	if (finalCode !== 0) failures.push(`finalAssertion exited ${finalCode}`);
	let from = 0;
	for (const [index, matcher] of scenario.expect.entries()) {
		const found = calls.findIndex((call, at) => at >= from && matches(call, matcher));
		if (found < 0) {
			failures.push(`calls.expect[${index}] (${JSON.stringify(matcher)}) not found after call ${from}`);
			break;
		}
		from = found + 1;
	}
	for (const [index, matcher] of scenario.forbid.entries()) {
		const found = calls.findIndex((call) => matches(call, matcher));
		if (found >= 0) failures.push(`calls.forbid[${index}] (${JSON.stringify(matcher)}) matched call ${found + 1}`);
	}
	for (const literal of scenario.replyIncludes) {
		if (!lastReply.includes(literal)) failures.push(`last reply lacks ${JSON.stringify(literal)}`);
	}
	return failures;
}

interface Session {
	readonly ready: boolean;
	readonly promptStatus: string | null;
	readonly sessionFile: string | null;
	readonly calls: readonly Call[];
	readonly replies: readonly Mapping[];
	readonly timedOut: boolean;
	readonly exitCode: number;
	readonly stderr: string;
}

async function runSession(model: string, prompt: string, cwd: string, eventsPath: string): Promise<Session> {
	const proc = Bun.spawn(["omp", "--mode", "rpc", "--no-ui", "--model", model], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const stderr = new Response(proc.stderr).text();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, SESSION_TIMEOUT_MS);
	// Frames stream to disk as they arrive: a long session's deltas do not fit in memory.
	const sink = Bun.file(eventsPath).writer();
	const started = new Map<string, unknown>();
	const calls: Call[] = [];
	const replies: Mapping[] = [];
	let ready = false;
	let promptStatus: string | null = null;
	let sessionFile: string | null = null;
	const send = (frame: Mapping): void => {
		proc.stdin.write(`${JSON.stringify(frame)}\n`);
		proc.stdin.flush();
	};
	const handle = (line: string): void => {
		sink.write(`${line}\n`);
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			// Not an RPC frame; kept in the events file only.
			return;
		}
		if (!isMapping(frame)) return;
		if (!ready && frame.type === "ready") {
			ready = true;
			send({ id: "prompt", type: "prompt", message: prompt });
		} else if (frame.type === "tool_execution_start" && typeof frame.toolCallId === "string") {
			started.set(frame.toolCallId, frame.args);
		} else if (frame.type === "tool_execution_end" && typeof frame.toolCallId === "string" && typeof frame.toolName === "string") {
			calls.push({
				tool: frame.toolName,
				input: started.get(frame.toolCallId) ?? null,
				isError: frame.isError === true,
				result: textOf(frame.result),
			});
		} else if (frame.type === "message_end" && isMapping(frame.message) && frame.message.role === "assistant") {
			replies.push(frame.message);
		} else if (
			promptStatus === null &&
			frame.id === "prompt" &&
			(frame.type === "prompt_result" || (frame.type === "response" && frame.success === false))
		) {
			promptStatus = frame.type === "prompt_result" ? String(frame.status) : `rejected: ${String(frame.error)}`;
			send({ id: "state", type: "get_state" });
		} else if (frame.id === "state" && frame.type === "response") {
			if (isMapping(frame.data) && typeof frame.data.sessionFile === "string") sessionFile = frame.data.sessionFile;
			proc.stdin.end();
		}
	};
	let buffer = "";
	const decoder = new TextDecoder();
	for await (const chunk of proc.stdout) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line !== "") handle(line);
		}
	}
	if (buffer.trim() !== "") handle(buffer.trim());
	const exitCode = await proc.exited;
	clearTimeout(timer);
	await sink.end();
	return { ready, promptStatus, sessionFile, calls, replies, timedOut, exitCode, stderr: (await stderr).trim() };
}

function classify(model: string, session: Session, failures: readonly string[]): Outcome {
	if (!session.ready) {
		// omp's own refusal of a model id it does not know: the model is unavailable here (S4).
		if (session.stderr.startsWith(`Model "${model}" not found`))
			return { kind: "untested", reason: `model not available: ${session.stderr.split("\n")[0]}` };
		return { kind: "harness-error", reason: `omp exited ${session.exitCode} before its ready frame` };
	}
	if (session.timedOut) return { kind: "harness-error", reason: `no prompt result within ${SESSION_TIMEOUT_MS / 1000}s` };
	if (session.promptStatus === null) return { kind: "harness-error", reason: `omp exited ${session.exitCode} before the prompt result` };
	if (session.promptStatus.startsWith("rejected:")) return { kind: "harness-error", reason: `prompt ${session.promptStatus}` };
	if (session.exitCode !== 0) return { kind: "harness-error", reason: `omp exited ${session.exitCode}` };
	const failed = session.replies.filter((reply) => reply.stopReason === "error" || reply.stopReason === "aborted");
	if (session.replies.length > 0 && failed.length === session.replies.length && session.calls.length === 0) {
		return { kind: "untested", reason: failed.map((reply) => String(reply.errorMessage ?? reply.stopReason)).join(" | ") };
	}
	if (session.sessionFile === null || !existsSync(session.sessionFile))
		return { kind: "harness-error", reason: "omp reported no session file" };
	return failures.length === 0 ? { kind: "pass" } : { kind: "fail", failures };
}

async function main(argv: readonly string[]): Promise<number> {
	const [scenarioPath, model, evidenceDir] = argv;
	if (scenarioPath === undefined || model === undefined || evidenceDir === undefined) {
		process.stderr.write("usage: driver.ts SCENARIO_JSON MODEL EVIDENCE_DIR\n");
		return 2;
	}
	const scenario = parseScenario(JSON.parse(readFileSync(scenarioPath, "utf8")));
	mkdirSync(evidenceDir, { recursive: true });
	const evidence = (suffix: string): string => join(evidenceDir, `${scenario.name}.${suffix}`);
	const write = (outcome: Outcome, details: Mapping): number => {
		writeFileSync(evidence("driver.json"), `${JSON.stringify({ scenario: scenario.name, model, result: outcome, ...details }, null, 2)}\n`);
		const why = outcome.kind === "fail" ? outcome.failures.join("; ") : outcome.kind === "pass" ? "" : outcome.reason;
		console.log(`${outcome.kind} ${model} ${scenario.name}${why === "" ? "" : ` :: ${why}`}`);
		return outcome.kind === "pass" || outcome.kind === "untested" ? 0 : 1;
	};

	const init = shell(scenario.init);
	if (init.code !== 0) return write({ kind: "harness-error", reason: `init exited ${init.code}: ${init.out}` }, {});

	const cwd = join("/runs", model.replaceAll("/", "_"), `${scenario.name}-${Date.now()}`);
	mkdirSync(cwd, { recursive: true });
	const session = await runSession(model, scenario.prompt, cwd, evidence("events.jsonl"));
	const finalState = shell(scenario.finalAssertion);
	const lastReply = textOf(session.replies.at(-1));
	const outcome = classify(model, session, assertionFailures(scenario, session.calls, finalState.code, lastReply));
	if (session.sessionFile !== null && existsSync(session.sessionFile)) copyFileSync(session.sessionFile, evidence("session.jsonl"));
	return write(outcome, {
		cwd,
		finalAssertion: { command: scenario.finalAssertion, exit: finalState.code, output: finalState.out },
		toolSequence: session.calls.map((call) => `${call.tool}${call.isError ? "(error)" : ""}`),
		calls: session.calls.map((call) => ({ ...call, result: call.result.slice(0, 400) })),
		promptStatus: session.promptStatus,
		sessionFile: session.sessionFile,
		timedOut: session.timedOut,
		exitCode: session.exitCode,
		stderr: session.stderr.slice(0, 2000),
		lastReply: lastReply.slice(0, 1000),
	});
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
