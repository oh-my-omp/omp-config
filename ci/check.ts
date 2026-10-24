#!/usr/bin/env bun
// omp-config check: install the latest omp in a throwaway HOME, apply this
// repository with its own updater, run one real session per mode (full and
// omp-light) on a free model, and report every fault or warning omp and the
// extensions emit. Design, criteria and coverage: ci/README.md.
//
// Run from anywhere: `bun ci/check.ts`. It writes only under a fresh temp
// directory, which it deletes at the end (CI_KEEP_ROOT=1 keeps it).
// Exit 0: no diagnostics. 1: configuration or environment diagnostics.
// 2: only the free model provider failed, so the configuration is unverified.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const OMP_VERSION = process.env.OMP_VERSION?.trim() || "latest";
const FREE_PROVIDER = "ci-free";
const FREE_MODEL = process.env.CI_FREE_MODEL?.trim() || "nvidia/nemotron-3-ultra-550b-a55b:free";
const FREE_BASE_URL = process.env.CI_FREE_BASE_URL?.trim() || "https://api.kilo.ai/api/gateway";
const INSTALL_TIMEOUT_MS = 600_000;
const SESSION_TIMEOUT_MS = 300_000;
const PROMPT = "Reply with exactly: OK";
const THINKING_LEVELS: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
	auto: true,
	inherit: true,
};

/**
 * Log warnings caused by the CI host or the CI's own model setup, not by the
 * configuration. Each entry names the fact behind it; a warning that matches
 * none is a diagnostic.
 */
const HOST_LOG_WARNINGS: readonly { readonly match: (record: LogRecord) => boolean; readonly reason: string }[] = [
	{
		match: (r) => /model discovery failed/i.test(r.message) && /\/\/(127\.0\.0\.1|localhost)[:/]/.test(String(r.url ?? "")),
		reason: "no local model server (ollama, llama.cpp, LM Studio) on the CI host",
	},
	{
		match: (r) => r.message.startsWith("Failed to acquire power assertion"),
		reason: "no D-Bus system bus on the CI host",
	},
];

type Phase = "install" | "apply" | "full session" | "light session" | "omp log" | "shadow proxy";

/** environment: the CI host or omp install broke; config: the configuration; provider: the free model service. */
type Diagnostic = { readonly kind: "environment" | "config" | "provider"; readonly phase: Phase; readonly text: string };

/** One distinct fault: every diagnostic whose normalized text and kind are the same, with where it showed up. */
type Finding = { readonly hash: string; readonly kind: Diagnostic["kind"]; readonly text: string; readonly phases: Map<Phase, number> };

type ModelRef = { readonly provider: string; readonly id: string };

type LogRecord = { readonly level: string; readonly message: string; readonly [field: string]: unknown };

type ShadowRequest = { readonly provider: string; readonly model: string; readonly status: number };

type ApplyReport = {
	readonly written: readonly string[];
	readonly errors: readonly string[];
	readonly pluginsInstalled: readonly string[];
	readonly pluginsMissing: readonly string[];
};

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== "");
}

function run(command: readonly string[], env: Record<string, string>, cwd: string, timeoutMs: number) {
	const [program, ...args] = command;
	if (program === undefined) throw new Error("run: empty command");
	const result = spawnSync(program, args, {
		env,
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: timeoutMs,
		maxBuffer: 256 * 1024 * 1024,
	});
	const failure = result.error ? result.error.message : undefined;
	return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", failure };
}

// --- environment -------------------------------------------------------------

/** The child environment; HOME and PI_CODING_AGENT_DIR are always set. */
type IsolatedEnv = { readonly HOME: string; readonly PI_CODING_AGENT_DIR: string; readonly [name: string]: string };

function isolatedEnv(root: string): IsolatedEnv {
	const home = join(root, "home");
	const bunInstall = join(root, "bun");
	for (const dir of [home, join(root, "tmp"), join(root, "work")]) mkdirSync(dir, { recursive: true });
	return {
		HOME: home,
		PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
		BUN_INSTALL: bunInstall,
		PATH: [join(bunInstall, "bin"), dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
		TMPDIR: join(root, "tmp"),
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		LANG: "C.UTF-8",
		TERM: "dumb",
		NO_COLOR: "1",
		OMP_SKIP_SETUP: "1",
	};
}

// --- model routing -------------------------------------------------------------

function parseSelector(raw: string): ModelRef | undefined {
	const selector = raw.trim();
	const colon = selector.lastIndexOf(":");
	const bare = colon > 0 && THINKING_LEVELS[selector.slice(colon + 1)] ? selector.slice(0, colon) : selector;
	const slash = bare.indexOf("/");
	return slash > 0 ? { provider: bare.slice(0, slash), id: bare.slice(slash + 1) } : undefined;
}

function readJson(rel: string): Mapping {
	const value: unknown = JSON.parse(readFileSync(join(REPO, rel), "utf8"));
	return isMapping(value) ? value : {};
}

/** Every provider-qualified model the managed configuration names. */
function configuredModels(): ModelRef[] {
	const selectors: string[] = [];
	const config: unknown = Bun.YAML.parse(readFileSync(join(REPO, "agent/config.yml"), "utf8"));
	const overrides =
		isMapping(config) && isMapping(config.task) && isMapping(config.task.agentModelOverrides) ? config.task.agentModelOverrides : {};
	for (const chain of Object.values(overrides)) if (typeof chain === "string") selectors.push(...chain.split(","));
	const translators = readJson("agent/thinking-translator.json").translatorModels;
	for (const translator of Array.isArray(translators) ? translators : []) {
		if (isMapping(translator) && typeof translator.provider === "string" && typeof translator.id === "string")
			selectors.push(`${translator.provider}/${translator.id}`);
	}
	const refs = new Map<string, ModelRef>();
	for (const selector of selectors) {
		const ref = parseSelector(selector);
		if (ref) refs.set(`${ref.provider}/${ref.id}`, ref);
	}
	return [...refs.values()];
}

function modelEntry(id: string): Mapping {
	return {
		id,
		name: id,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
	};
}

/**
 * models.yml for the throwaway agent dir: the free model as `ci-free`, and
 * every configured model shadowed onto the local proxy, which forwards the
 * request to the free model. CI holds no paid credentials, so without the
 * shadow a configured helper model would report itself unavailable.
 */
function modelsYaml(shadows: readonly ModelRef[], proxyPort: number): string {
	const providers: Mapping = {
		[FREE_PROVIDER]: {
			baseUrl: FREE_BASE_URL,
			api: "openai-completions",
			auth: "none",
			authHeader: false,
			models: [modelEntry(FREE_MODEL)],
		},
	};
	const byProvider = Map.groupBy(shadows, (ref) => ref.provider);
	for (const [provider, refs] of byProvider) {
		providers[provider] = {
			baseUrl: `http://127.0.0.1:${proxyPort}/${provider}/v1`,
			api: "openai-completions",
			auth: "none",
			authHeader: false,
			models: refs.map((ref) => modelEntry(ref.id)),
		};
	}
	return Bun.YAML.stringify({ providers }, null, 2);
}

function startShadowProxy(requests: ShadowRequest[]) {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const provider = /^\/([^/]+)\/v1\/chat\/completions$/.exec(new URL(request.url).pathname)?.[1];
			if (request.method !== "POST" || provider === undefined)
				return new Response("not served by the omp-config CI shadow proxy", { status: 404 });
			const body: unknown = await request.json();
			if (!isMapping(body)) return new Response("request body is not a JSON object", { status: 400 });
			const requested = String(body.model);
			const upstream = await fetch(`${FREE_BASE_URL}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", accept: request.headers.get("accept") ?? "text/event-stream" },
				body: JSON.stringify({ ...body, model: FREE_MODEL }),
			});
			requests.push({ provider, model: requested, status: upstream.status });
			return new Response(upstream.body, {
				status: upstream.status,
				headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
			});
		},
	});
}

// --- phases --------------------------------------------------------------------

function installOmp(env: Record<string, string>, cwd: string, out: Diagnostic[]): string | undefined {
	const install = run(["bun", "install", "-g", `@oh-my-pi/pi-coding-agent@${OMP_VERSION}`], env, cwd, INSTALL_TIMEOUT_MS);
	if (install.code !== 0) {
		out.push({
			kind: "environment",
			phase: "install",
			text: `bun install -g @oh-my-pi/pi-coding-agent@${OMP_VERSION} exited ${install.code}: ${install.failure ?? install.stderr.trim()}`,
		});
		return undefined;
	}
	const version = run(["omp", "--version"], env, cwd, 60_000);
	if (version.code !== 0) {
		out.push({
			kind: "environment",
			phase: "install",
			text: `omp --version exited ${version.code}: ${version.failure ?? version.stderr.trim()}`,
		});
		return undefined;
	}
	return version.stdout.trim();
}

function applyConfig(env: IsolatedEnv, cwd: string, out: Diagnostic[]): ApplyReport | undefined {
	const apply = run(
		[
			"bun",
			join(REPO, "agent/extensions/omp-config-autoupdate/omp-config-update.ts"),
			"apply",
			"--source",
			REPO,
			"--agent-dir",
			env.PI_CODING_AGENT_DIR,
			"--json",
		],
		env,
		cwd,
		INSTALL_TIMEOUT_MS,
	);
	for (const line of lines(apply.stderr)) out.push({ kind: "config", phase: "apply", text: line });
	const last = lines(apply.stdout).at(-1);
	let parsed: unknown;
	try {
		parsed = last === undefined ? undefined : JSON.parse(last);
	} catch {
		// Not JSON: reported below as a missing report.
		parsed = undefined;
	}
	const report = isApplyReport(parsed) ? parsed : undefined;
	if (!report) {
		out.push({
			kind: "config",
			phase: "apply",
			text: `updater exited ${apply.code} without a JSON report${apply.failure ? `: ${apply.failure}` : ""}`,
		});
		return undefined;
	}
	for (const error of report.errors) out.push({ kind: "config", phase: "apply", text: error });
	for (const spec of report.pluginsMissing) out.push({ kind: "config", phase: "apply", text: `plugin not installed: ${spec}` });
	if (apply.code !== 0 && report.errors.length === 0) out.push({ kind: "config", phase: "apply", text: `updater exited ${apply.code}` });
	return report;
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The fields of the updater's `--json` report this check reads. */
function isApplyReport(value: unknown): value is ApplyReport {
	return (
		isMapping(value) &&
		isStringArray(value.written) &&
		isStringArray(value.errors) &&
		isStringArray(value.pluginsInstalled) &&
		isStringArray(value.pluginsMissing)
	);
}

/** Text of a free-model service failure: transport errors, timeouts, rate limits, 5xx. */
const PROVIDER_FAILURE =
	/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network|rate limit|\b(?:408|429|5\d\d)\b/i;

function isProviderFailure(message: Mapping): boolean {
	const status = message.errorStatus;
	if (typeof status === "number" && (status === 408 || status === 429 || status >= 500)) return true;
	return PROVIDER_FAILURE.test(String(message.errorMessage ?? ""));
}

/** One RPC session: wait for ready, send one prompt, keep stdin open until prompt_result, then drain. */
async function runSession(
	phase: Phase,
	command: readonly string[],
	env: Record<string, string>,
	cwd: string,
	out: Diagnostic[],
): Promise<void> {
	const proc = Bun.spawn([...command], { env, cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const stderr = new Response(proc.stderr).text();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, SESSION_TIMEOUT_MS);
	const events: Mapping[] = [];
	let promptSent = false;
	let promptDone = false;
	let buffer = "";
	const decoder = new TextDecoder();
	const handle = (line: string): void => {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			out.push({ kind: "config", phase, text: `non-JSON line on the RPC stdout: ${line}` });
			return;
		}
		if (!isMapping(event)) return;
		events.push(event);
		if (!promptSent && event.type === "ready") {
			proc.stdin.write(`${JSON.stringify({ id: "ci", type: "prompt", message: PROMPT })}\n`);
			proc.stdin.flush();
			promptSent = true;
			return;
		}
		const rejected = event.type === "response" && event.id === "ci" && event.success === false;
		if (!promptDone && (rejected || (event.type === "prompt_result" && event.id === "ci"))) {
			promptDone = true;
			proc.stdin.end();
		}
	};
	for await (const chunk of proc.stdout) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line !== "") handle(line);
		}
	}
	if (buffer.trim() !== "") handle(buffer.trim());
	const code = await proc.exited;
	clearTimeout(timer);

	for (const line of lines(await stderr)) out.push({ kind: "config", phase, text: line });
	if (timedOut) out.push({ kind: "config", phase, text: `session did not finish within ${SESSION_TIMEOUT_MS / 1000} s` });
	if (!promptSent) out.push({ kind: "config", phase, text: "omp exited before the RPC ready frame" });
	const replies = events.flatMap((event) =>
		event.type === "message_end" && isMapping(event.message) && event.message.role === "assistant" ? [event.message] : [],
	);
	const failedReplies = replies.filter((reply) => reply.stopReason === "error" || reply.stopReason === "aborted");
	// A prompt that ended badly because the free model failed says nothing about the configuration.
	const fallout = failedReplies.length > 0 && failedReplies.every(isProviderFailure) ? "provider" : "config";
	for (const event of events) {
		if (event.type === "extension_error")
			out.push({ kind: "config", phase, text: `extension_error in ${event.extensionPath} during ${event.event}: ${event.error}` });
		if (event.type === "response" && event.id === "ci" && event.success === false)
			out.push({ kind: "config", phase, text: `prompt rejected: ${event.error}` });
		if (event.type === "prompt_result" && event.id === "ci" && event.status !== "completed")
			out.push({ kind: fallout, phase, text: `prompt ended with status ${event.status}` });
	}
	for (const reply of failedReplies) {
		const text = `${reply.provider}/${reply.model} reply ${reply.stopReason}${reply.errorStatus ? ` (HTTP ${reply.errorStatus})` : ""}: ${reply.errorMessage}`;
		out.push({ kind: isProviderFailure(reply) ? "provider" : "config", phase, text });
	}
	for (const reply of replies) {
		if (!failedReplies.includes(reply) && (reply.provider !== FREE_PROVIDER || reply.model !== FREE_MODEL)) {
			out.push({ kind: "config", phase, text: `reply came from ${reply.provider}/${reply.model}, not ${FREE_PROVIDER}/${FREE_MODEL}` });
		}
	}
	if (promptSent && !timedOut && replies.length === 0) out.push({ kind: "config", phase, text: "no assistant reply" });
	if (code !== 0 && !timedOut) out.push({ kind: fallout, phase, text: `omp exited ${code}` });
}

function readLogs(home: string, out: Diagnostic[], ignored: string[]): void {
	const dir = join(home, ".omp", "logs");
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)
		.filter((file) => file.endsWith(".log"))
		.sort()) {
		for (const line of lines(readFileSync(join(dir, name), "utf8"))) {
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isMapping(record) || typeof record.message !== "string" || (record.level !== "warn" && record.level !== "error")) continue;
			const entry = record as LogRecord;
			const { timestamp: _t, pid: _p, level, message, ...context } = entry;
			// A `{path, error}` record is rendered the way omp prints the same fault on stderr, so both dedupe to one finding.
			const keys = Object.keys(context);
			const text =
				keys.length === 2 && typeof context.path === "string" && typeof context.error === "string"
					? `${message} ${context.path}: ${context.error}`
					: `${message}${keys.length ? ` ${JSON.stringify(context)}` : ""}`;
			const host = level === "warn" ? HOST_LOG_WARNINGS.find((rule) => rule.match(entry)) : undefined;
			if (host) ignored.push(`${text} — ${host.reason}`);
			// A record whose own error is a free-model service failure is the provider's, not the configuration's.
			else
				out.push({
					kind: PROVIDER_FAILURE.test(`${entry.error ?? ""} ${entry.errorMessage ?? ""}`) ? "provider" : "config",
					phase: "omp log",
					text,
				});
		}
	}
}

// --- report --------------------------------------------------------------------

/** Rewrites run-specific parts (temp dirs, module cache-busters) so one fault reads, and hashes, the same in every source and run. */
function normalizer(root: string, home: string): (text: string) => string {
	// Real paths first: on macOS /private/var/… contains /var/… and must be replaced before it.
	const prefixes: [string, string][] = [
		[realpathSync(home), "~"],
		[home, "~"],
		[realpathSync(root), "<tmp>"],
		[root, "<tmp>"],
	];
	return (text) => prefixes.reduce((current, [path, label]) => current.replaceAll(path, label), text).replace(/\?mtime=\d+/g, "");
}

function findings(diagnostics: readonly Diagnostic[], normalize: (text: string) => string): Finding[] {
	const byHash = new Map<string, Finding>();
	for (const d of diagnostics) {
		const text = normalize(d.text);
		const hash = createHash("sha256").update(`${d.kind}\0${text}`).digest("hex").slice(0, 12);
		const finding = byHash.get(hash) ?? { hash, kind: d.kind, text, phases: new Map<Phase, number>() };
		finding.phases.set(d.phase, (finding.phases.get(d.phase) ?? 0) + 1);
		byHash.set(hash, finding);
	}
	// omp cuts long stderr lines with "…"; a cut line is the same fault as the one full text it is a prefix of.
	// A cut inside an absolute path leaves a fragment normalization cannot rewrite, so compare up to where that path began.
	for (const cut of [...byHash.values()].filter((f) => f.text.endsWith("…"))) {
		const prefix = cut.text.slice(0, -1).replace(/\/[^\s'"]*$/, "");
		const candidates = [...byHash.values()].filter((f) => f !== cut && f.kind === cut.kind && f.text.startsWith(prefix));
		const full = candidates[0];
		if (candidates.length !== 1 || full === undefined) continue;
		for (const [phase, count] of cut.phases) full.phases.set(phase, (full.phases.get(phase) ?? 0) + count);
		byHash.delete(cut.hash);
	}
	return [...byHash.values()];
}

function report(
	facts: readonly string[],
	diagnostics: readonly Diagnostic[],
	ignored: readonly string[],
	normalize: (text: string) => string,
): number {
	const failed = diagnostics.some((d) => d.kind !== "provider");
	const providerOnly = !failed && diagnostics.length > 0;
	const verdict = failed
		? "FAIL: configuration or environment diagnostics"
		: providerOnly
			? "FAIL: free model provider unavailable; configuration not verified"
			: "PASS: no diagnostics";
	const distinct = findings(diagnostics, normalize);
	const ignoredCounts = new Map<string, number>();
	for (const text of ignored.map(normalize)) ignoredCounts.set(text, (ignoredCounts.get(text) ?? 0) + 1);
	const code = (text: string): string => `\`${text.replaceAll("`", "'")}\``;
	const markdown = [
		"# omp-config check",
		"",
		...facts.map((fact) => `- ${fact}`),
		"",
		`## ${verdict}`,
		"",
		...(distinct.length
			? distinct.map(
					(f) =>
						`- \`${f.hash}\` **${f.kind}** — ${[...f.phases].map(([phase, count]) => `${phase} ×${count}`).join(", ")}: ${code(f.text)}`,
				)
			: ["- none"]),
		...(ignoredCounts.size
			? [
					"",
					"## Host-environment log warnings (not counted)",
					"",
					...[...ignoredCounts].map(([text, count]) => `- ×${count} ${code(text)}`),
				]
			: []),
		"",
	].join("\n");
	process.stdout.write(markdown);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
	if (process.env.GITHUB_ACTIONS === "true") {
		for (const f of distinct)
			process.stdout.write(
				`::error title=${f.hash} (${f.kind})::${f.text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`,
			);
	}
	return failed ? 1 : providerOnly ? 2 : 0;
}

async function main(): Promise<number> {
	const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "omp-config-check-"));
	const env = isolatedEnv(root);
	const normalize = normalizer(root, env.HOME);
	const work = join(root, "work");
	const diagnostics: Diagnostic[] = [];
	const ignored: string[] = [];
	const facts: string[] = [`requested omp: ${OMP_VERSION}`, `free model: ${FREE_PROVIDER}/${FREE_MODEL} at ${FREE_BASE_URL}`];
	const shadowRequests: ShadowRequest[] = [];
	const proxy = startShadowProxy(shadowRequests);
	try {
		const version = installOmp(env, work, diagnostics);
		if (version === undefined) return report(facts, diagnostics, ignored, normalize);
		facts.push(`installed: ${version}`);
		const applied = applyConfig(env, work, diagnostics);
		// A failed apply wrote nothing (the updater installs plugins before any write), so
		// there is no applied config to run a session on: report the apply diagnostics.
		if (applied === undefined || applied.errors.length > 0) return report(facts, diagnostics, ignored, normalize);
		facts.push(`updater wrote ${applied.written.length} entries; plugins installed: ${applied.pluginsInstalled.join(", ") || "none"}`);
		const shadows = configuredModels();
		facts.push(`configured models shadowed onto the free model: ${shadows.map((ref) => `${ref.provider}/${ref.id}`).join(", ")}`);
		writeFileSync(join(env.PI_CODING_AGENT_DIR, "models.yml"), modelsYaml(shadows, proxy.port ?? 0));
		// modelRoles and skills are machine-local fields the updater never writes. A
		// machine sets them; CI binds every role to the free model, so role-driven
		// background work (titles, advisor) stays on it, and turns skills off: the
		// installed plugins' skills would otherwise be compressed in the background by
		// that free model on every run, since the throwaway HOME has no compression cache.
		const model = `${FREE_PROVIDER}/${FREE_MODEL}`;
		const configPath = join(env.PI_CODING_AGENT_DIR, "config.yml");
		const config: unknown = Bun.YAML.parse(readFileSync(configPath, "utf8"));
		const roles = Object.fromEntries(
			["default", "smol", "slow", "plan", "commit", "tiny", "memory", "task", "advisor"].map((role) => [role, model]),
		);
		writeFileSync(
			configPath,
			Bun.YAML.stringify({ ...(isMapping(config) ? config : {}), modelRoles: roles, skills: { enabled: false } }, null, 2),
		);
		const rpc = ["--mode", "rpc", "--no-ui", "--no-session", "--model", model];
		await runSession("full session", ["omp", ...rpc], env, work, diagnostics);
		await runSession("light session", ["omp-light", ...rpc], env, work, diagnostics);
		readLogs(env.HOME, diagnostics, ignored);
		for (const request of shadowRequests)
			if (request.status >= 400)
				diagnostics.push({
					kind: "provider",
					phase: "shadow proxy",
					text: `${request.provider}/${request.model} → HTTP ${request.status}`,
				});
		facts.push(`shadowed models requested: ${shadowRequests.map((r) => `${r.provider}/${r.model}`).join(", ") || "none"}`);
		return report(facts, diagnostics, ignored, normalize);
	} finally {
		proxy.stop(true);
		if (process.env.CI_KEEP_ROOT === "1") process.stderr.write(`kept ${root}\n`);
		else rmSync(root, { recursive: true, force: true });
	}
}

process.exitCode = await main();
