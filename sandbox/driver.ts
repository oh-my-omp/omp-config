import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AssistantMessage,
	PromptResultEvent,
	SessionState,
	StopReason,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";

const RECORDER_READY = join(import.meta.dir, "recorder.ready");
const SINK_POINTER = join(import.meta.dir, ".requests-sink");

export interface Matcher {
	readonly tool: readonly string[];
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
	readonly tool: ToolExecutionEndEvent["toolName"];
	readonly input: ToolExecutionStartEvent["args"];
	readonly isError: boolean;
	readonly result: string;
}

type Mapping = { readonly [key: string]: unknown };

type Outcome =
	| { readonly kind: "pass" }
	| { readonly kind: "fail"; readonly failures: readonly string[] }
	| { readonly kind: "untested"; readonly reason: string }
	| { readonly kind: "harness-error"; readonly reason: string };

type PromptOutcome =
	| { readonly kind: "result"; readonly status: PromptResultEvent["status"] }
	| { readonly kind: "unrecognized"; readonly status: string }
	| { readonly kind: "rejected"; readonly error: string };

type Reply = Pick<AssistantMessage, "errorMessage"> & {
	readonly stopReason: AssistantMessage["stopReason"] | undefined;
	readonly text: string;
};

type ToolStart = Pick<ToolExecutionStartEvent, "toolCallId" | "args">;

type ToolEnd = Pick<ToolExecutionEndEvent, "toolCallId" | "toolName" | "result" | "isError">;

// Exhaustive tables: the host adding or removing a variant is a compile error here, not a silent drop of frames.
const STOP_REASONS: Record<StopReason, true> = { stop: true, length: true, toolUse: true, error: true, aborted: true };
const PROMPT_STATUSES: Record<PromptResultEvent["status"], true> = { completed: true, aborted: true, error: true };

const SESSION_TIMEOUT_MS = 600_000;
const NAME = /^[a-z0-9][a-z0-9._-]*$/;

const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isStopReason = (value: unknown): value is StopReason => typeof value === "string" && Object.hasOwn(STOP_REASONS, value);
const isPromptStatus = (value: unknown): value is PromptResultEvent["status"] =>
	typeof value === "string" && Object.hasOwn(PROMPT_STATUSES, value);

function parseMatcher(value: unknown, where: string): Matcher {
	if (!isMapping(value) || !(typeof value.tool === "string" || (isStringArray(value.tool) && value.tool.length > 0)))
		throw new Error(`${where}: a matcher needs "tool", a string or a non-empty list of strings`);
	if (value.isError !== undefined && typeof value.isError !== "boolean") throw new Error(`${where}: "isError" must be a boolean`);
	if (value.inputPattern !== undefined && typeof value.inputPattern !== "string")
		throw new Error(`${where}: "inputPattern" must be a string`);
	if (value.resultIncludes !== undefined && typeof value.resultIncludes !== "string")
		throw new Error(`${where}: "resultIncludes" must be a string`);
	if (typeof value.inputPattern === "string") new RegExp(value.inputPattern);
	return {
		tool: typeof value.tool === "string" ? [value.tool] : value.tool,
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

function shell(command: string, cwd: string): { code: number | null; out: string } {
	const result = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8" });
	return { code: result.status, out: `${result.stdout}${result.stderr}`.trim() };
}

function textOf(value: unknown): string {
	if (!isMapping(value) || !Array.isArray(value.content)) return "";
	return value.content.flatMap((part) => (isMapping(part) && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

function matches(call: Call, matcher: Matcher): boolean {
	if (!matcher.tool.includes(call.tool)) return false;
	if (matcher.isError !== undefined && call.isError !== matcher.isError) return false;
	if (matcher.inputPattern !== undefined && !new RegExp(matcher.inputPattern).test(JSON.stringify(call.input) ?? "")) return false;
	if (matcher.resultIncludes !== undefined && !call.result.includes(matcher.resultIncludes)) return false;
	return true;
}

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
	readonly prompt: PromptOutcome | null;
	readonly sessionFile: string | null;
	readonly calls: readonly Call[];
	readonly replies: readonly Reply[];
	readonly timedOut: boolean;
	readonly exitCode: number;
	readonly stderr: string;
}

function promptStatusText(outcome: PromptOutcome): string {
	switch (outcome.kind) {
		case "result":
		case "unrecognized":
			return outcome.status;
		case "rejected":
			return `rejected: ${outcome.error}`;
	}
}

function replyOf(message: Mapping): Reply | undefined {
	if (message.role !== "assistant") return undefined;
	return {
		stopReason: isStopReason(message.stopReason) ? message.stopReason : undefined,
		errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
		text: textOf(message),
	};
}

function toolStartOf(frame: Mapping): ToolStart | undefined {
	if (frame.type !== "tool_execution_start" || typeof frame.toolCallId !== "string") return undefined;
	return { toolCallId: frame.toolCallId, args: frame.args };
}

function toolEndOf(frame: Mapping): ToolEnd | undefined {
	if (frame.type !== "tool_execution_end" || typeof frame.toolCallId !== "string" || typeof frame.toolName !== "string") return undefined;
	return { toolCallId: frame.toolCallId, toolName: frame.toolName, result: frame.result, isError: frame.isError === true };
}

function promptOutcomeOf(frame: Mapping): PromptOutcome | undefined {
	if (frame.type === "prompt_result")
		return isPromptStatus(frame.status) ? { kind: "result", status: frame.status } : { kind: "unrecognized", status: String(frame.status) };
	if (frame.type === "response" && frame.success === false) return { kind: "rejected", error: String(frame.error) };
	return undefined;
}

function sessionFileOf(data: unknown): Pick<SessionState, "sessionFile"> {
	return { sessionFile: isMapping(data) && typeof data.sessionFile === "string" ? data.sessionFile : undefined };
}

async function runSession(model: string, prompt: string, cwd: string, eventsPath: string): Promise<Session> {
	const proc = Bun.spawn(["omp", "--mode", "rpc", "--no-ui", "--model", model], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const stderr = new Response(proc.stderr).text();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, SESSION_TIMEOUT_MS);
	const sink = Bun.file(eventsPath).writer();
	const started = new Map<string, ToolStart["args"]>();
	const dispatched = new Map<string, Call | null>();
	const replies: Reply[] = [];
	let ready = false;
	let outcome: PromptOutcome | null = null;
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
			return;
		}
		if (!isMapping(frame)) return;
		if (!ready && frame.type === "ready") {
			ready = true;
			send({ id: "prompt", type: "prompt", message: prompt });
		} else if (frame.type === "tool_execution_start") {
			const start = toolStartOf(frame);
			if (start !== undefined) {
				started.set(start.toolCallId, start.args);
				dispatched.set(start.toolCallId, null);
			}
		} else if (frame.type === "tool_execution_end") {
			const end = toolEndOf(frame);
			if (end !== undefined) {
				dispatched.set(end.toolCallId, {
					tool: end.toolName,
					input: started.get(end.toolCallId) ?? null,
					isError: end.isError === true,
					result: textOf(end.result),
				});
			}
		} else if (frame.type === "message_end" && isMapping(frame.message)) {
			const reply = replyOf(frame.message);
			if (reply !== undefined) replies.push(reply);
		} else if (outcome === null && frame.id === "prompt") {
			const next = promptOutcomeOf(frame);
			if (next !== undefined) {
				outcome = next;
				send({ id: "state", type: "get_state" });
			}
		} else if (frame.id === "state" && frame.type === "response") {
			sessionFile = sessionFileOf(frame.data).sessionFile ?? null;
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
	return {
		ready,
		prompt: outcome,
		sessionFile,
		calls: [...dispatched.values()].filter((call): call is Call => call !== null),
		replies,
		timedOut,
		exitCode,
		stderr: (await stderr).trim(),
	};
}

function classify(model: string, session: Session, failures: readonly string[]): Outcome {
	if (!session.ready) {
		if (session.stderr.startsWith(`Model "${model}" not found`))
			return { kind: "untested", reason: `model not available: ${session.stderr.split("\n")[0]}` };
		return { kind: "harness-error", reason: `omp exited ${session.exitCode} before its ready frame` };
	}
	if (session.timedOut) return { kind: "harness-error", reason: `no prompt result within ${SESSION_TIMEOUT_MS / 1000}s` };
	if (session.prompt === null) return { kind: "harness-error", reason: `omp exited ${session.exitCode} before the prompt result` };
	if (session.prompt.kind === "rejected") return { kind: "harness-error", reason: `prompt ${promptStatusText(session.prompt)}` };
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

	const cwd = join("/runs", model.replaceAll("/", "_"), `${scenario.name}-${Date.now()}`);
	mkdirSync(cwd, { recursive: true });
	const init = shell(scenario.init, cwd);
	if (init.code !== 0) return write({ kind: "harness-error", reason: `init exited ${init.code}: ${init.out}` }, { cwd });
	if (!existsSync(RECORDER_READY))
		return write(
			{ kind: "harness-error", reason: "the model request recorder is not running (/sandbox/recorder.ready is missing)" },
			{ cwd },
		);
	writeFileSync(evidence("requests.jsonl"), "");
	writeFileSync(SINK_POINTER, evidence("requests.jsonl"));
	const session = await runSession(model, scenario.prompt, cwd, evidence("events.jsonl")).finally(() => writeFileSync(SINK_POINTER, ""));
	const finalState = shell(scenario.finalAssertion, cwd);
	const lastReply = session.replies.at(-1)?.text ?? "";
	const outcome = classify(model, session, assertionFailures(scenario, session.calls, finalState.code, lastReply));
	if (session.sessionFile !== null && existsSync(session.sessionFile)) copyFileSync(session.sessionFile, evidence("session.jsonl"));
	return write(outcome, {
		cwd,
		finalAssertion: { command: scenario.finalAssertion, exit: finalState.code, output: finalState.out },
		toolSequence: session.calls.map((call) => `${call.tool}${call.isError ? "(error)" : ""}`),
		calls: session.calls.map((call) => ({ ...call, result: call.result.slice(0, 400) })),
		promptStatus: session.prompt === null ? null : promptStatusText(session.prompt),
		sessionFile: session.sessionFile,
		timedOut: session.timedOut,
		exitCode: session.exitCode,
		stderr: session.stderr.slice(0, 2000),
		lastReply: lastReply.slice(0, 1000),
	});
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
