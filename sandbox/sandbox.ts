import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	copyAgentDb,
	copyClaude,
	copyExtensionRules,
	copyOmpDir,
	copyRepo,
	IMAGE,
	installOmp,
	installTools,
	PLATFORM,
	setUpTarget,
} from "./content.ts";
import { run as exec, must } from "./docker.ts";
import { parseScenario } from "./driver.ts";
import { ledgerEnd, ledgerInProgress, ledgerStart } from "./ledger.ts";

const HOME = homedir();
const LABEL = "omp-sandbox.run";
const RUN_ID = /^[a-z0-9]+$/;

interface Names {
	readonly run: string;
	readonly container: string;
	readonly target: string;
	readonly network: string;
	readonly out: string;
}

interface BuildOptions {
	readonly target: boolean;
	readonly repo: string;
	readonly plugins: readonly string[];
}

type Command =
	| { readonly kind: "hold"; readonly options: BuildOptions }
	| { readonly kind: "run"; readonly options: BuildOptions; readonly scenario: string; readonly models: readonly string[] }
	| { readonly kind: "matrix"; readonly run: string; readonly scenario: string; readonly models: readonly string[] }
	| { readonly kind: "cache"; readonly run: string }
	| { readonly kind: "down"; readonly run: string }
	| { readonly kind: "prune" };

const USAGE = `usage:
  sandbox.ts hold [--target] [--repo DIR] [--plugin DIR]...
  sandbox.ts run [--target] [--repo DIR] [--plugin DIR]... SCENARIO_JSON MODEL...
  sandbox.ts matrix RUN SCENARIO_JSON MODEL...
  sandbox.ts cache RUN
  sandbox.ts down RUN
  sandbox.ts prune`;

class UsageError extends Error {}
class Interrupted extends Error {}

function namesOf(run: string): Names {
	const container = `omp-sandbox-${run}`;
	return { run, container, target: `${container}-target`, network: `${container}-net`, out: join("/tmp", container) };
}

function parseRunId(value: string | undefined): string {
	if (value === undefined || !RUN_ID.test(value)) throw new UsageError(`RUN must match ${RUN_ID}`);
	return value;
}

function parseCommand(argv: readonly string[]): Command {
	const [verb, ...rest] = argv;
	const positional: string[] = [];
	let target = false;
	let repo = resolve(import.meta.dir, "..");
	const plugins: string[] = [];
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index] ?? "";
		if (arg === "--target") target = true;
		else if (arg === "--repo") {
			const value = rest[++index];
			if (value === undefined) throw new UsageError("--repo needs a directory");
			repo = resolve(value);
		} else if (arg === "--plugin") {
			const value = rest[++index];
			if (value === undefined) throw new UsageError("--plugin needs a directory");
			plugins.push(resolve(value));
		} else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
		else positional.push(arg);
	}
	if (verb !== "hold" && verb !== "run" && plugins.length > 0) throw new UsageError("--plugin is only valid for hold and run");
	const options = { target, repo, plugins };
	switch (verb) {
		case "hold":
			if (positional.length > 0) throw new UsageError("hold takes no positional arguments");
			return { kind: "hold", options };
		case "run": {
			const [scenario, ...models] = positional;
			if (scenario === undefined || models.length === 0) throw new UsageError("run needs SCENARIO_JSON and at least one MODEL");
			return { kind: "run", options, scenario: resolve(scenario), models };
		}
		case "matrix": {
			const [run, scenario, ...models] = positional;
			if (scenario === undefined || models.length === 0) throw new UsageError("matrix needs RUN, SCENARIO_JSON and at least one MODEL");
			return { kind: "matrix", run: parseRunId(run), scenario: resolve(scenario), models };
		}
		case "cache":
			return { kind: "cache", run: parseRunId(positional[0]) };
		case "down":
			return { kind: "down", run: parseRunId(positional[0]) };
		case "prune":
			if (positional.length > 0) throw new UsageError("prune takes no positional arguments");
			return { kind: "prune" };
		default:
			throw new UsageError(verb === undefined ? "missing command" : `unknown command ${verb}`);
	}
}

async function startRecorder(container: string, home: string): Promise<void> {
	await must(["docker", "exec", container, "bun", "/sandbox/recorder.ts", "setup", join(home, ".omp", "agent", "models.yml")]);
	await must(["docker", "exec", "-d", container, "sh", "-c", "exec bun /sandbox/recorder.ts serve >/evidence/recorder.log 2>&1"]);
	const deadline = Date.now() + 15_000;
	while ((await exec(["docker", "exec", container, "test", "-f", "/sandbox/recorder.ready"])).code !== 0) {
		if (Date.now() > deadline)
			throw new Error("the model request recorder did not become ready within 15s (container /evidence/recorder.log)");
		await Bun.sleep(250);
	}
}

async function build(names: Names, options: BuildOptions, signal: AbortSignal): Promise<void> {
	const step = async <T>(title: string, action: () => Promise<T>): Promise<T> => {
		if (signal.aborted) throw new Interrupted("interrupted");
		console.log(`· ${title}`);
		return action();
	};
	const labels = ["--label", `${LABEL}=${names.run}`];
	await step(`pull ${IMAGE}`, () => must(["docker", "pull", "-q", "--platform", PLATFORM, IMAGE]));
	if (options.target) {
		await step(`network ${names.network}`, () => must(["docker", "network", "create", ...labels, names.network]));
	}
	await step(`container ${names.container}`, () =>
		must([
			"docker",
			"run",
			"-d",
			"--init",
			"--name",
			names.container,
			...labels,
			...(options.target ? ["--network", names.network] : []),
			"--platform",
			PLATFORM,
			"-e",
			`HOME=${HOME}`,
			"-e",
			`BUN_INSTALL=${HOME}/.bun`,
			"-e",
			`PATH=${HOME}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
			"-e",
			"TERM=xterm-256color",
			"-e",
			"LANG=C.UTF-8",
			IMAGE,
			"sleep",
			"infinity",
		]),
	);
	await step("directories and driver", async () => {
		await must([
			"docker",
			"exec",
			names.container,
			"mkdir",
			"-p",
			join(HOME, ".omp", "agent", "sessions"),
			join(HOME, ".claude"),
			"/repo",
			"/work",
			"/evidence",
			"/scenarios",
		]);
		await must(["docker", "cp", `${import.meta.dir}/.`, `${names.container}:/sandbox`]);
	});
	await step("apt packages", () => installTools(names.container));
	await step("~/.omp/agent and ~/.omp/plugins", () => copyOmpDir(names.container, HOME));
	await step("model request recorder", () => startRecorder(names.container, HOME));
	const tables = await step("agent.db", () => copyAgentDb(names.container, HOME));
	const differ = tables.filter((check) => check.kind === "differ");
	for (const check of tables)
		console.log(
			check.kind === "equal" ? `  ${check.table}: ${check.rows} rows, every field equal` : `  ${check.table}: DIFFERS (${check.detail})`,
		);
	if (differ.length > 0) throw new Error(`agent.db copy differs from the host snapshot in ${differ.length} table(s)`);
	await step("credentials outside the recorder", () => pruneCredentials(names.container, HOME));
	const claude = await step("~/.claude", () => copyClaude(names.container, HOME));
	console.log(`  ${claude.length === 0 ? "nothing to copy" : claude.join(", ")}`);
	const ruleRoots = await step("rules/ of extension roots outside ~/.omp", () => copyExtensionRules(names.container, HOME));
	console.log(`  ${ruleRoots.length === 0 ? "nothing to copy" : ruleRoots.join(", ")}`);
	const files = await step(`working tree ${options.repo} -> /repo`, () => copyRepo(names.container, options.repo));
	console.log(`  ${files} files`);
	const installed = await step("plugins, latest omp, updater apply from /repo, auto-update off", () =>
		installOmp(names.container, HOME, options.plugins),
	);
	console.log(`  ${installed.autoupdate}`);
	console.log(`  ${installed.version}`);
	if (installed.linked.length > 0) console.log(`  linked plugins: ${installed.linked.join(", ")}`);
	await step("config outside the recorder", () => pruneSandboxConfig(names.container, HOME));
	if (options.target)
		await step(`ssh target ${names.target}`, () => setUpTarget(names.container, HOME, names.target, labels, names.network));
}

async function pruneCredentials(container: string, home: string): Promise<void> {
	const out = await must([
		"docker",
		"exec",
		container,
		"bun",
		"/sandbox/recorder.ts",
		"prune-credentials",
		join(home, ".omp", "agent", "agent.db"),
	]);
	console.log(`  ${out.trim()}`);
}

async function pruneSandboxConfig(container: string, home: string): Promise<void> {
	const out = await must([
		"docker",
		"exec",
		container,
		"bun",
		"/sandbox/recorder.ts",
		"prune-config",
		join(home, ".omp", "agent", "config.yml"),
	]);
	console.log(`  ${out.trim()}`);
}

async function teardown(names: Names): Promise<{ readonly clean: boolean; readonly evidence: string }> {
	const removed: string[] = [];
	try {
		const filter = `label=${LABEL}=${names.run}`;
		const containers = (await must(["docker", "ps", "-aq", "--filter", filter])).split("\n").filter((id) => id !== "");
		if (containers.length > 0) {
			await must(["docker", "rm", "-f", ...containers]);
			removed.push(`docker rm -f（${containers.length} 个容器，exit 0）`);
		}
		const networks = (await must(["docker", "network", "ls", "-q", "--filter", filter])).split("\n").filter((id) => id !== "");
		if (networks.length > 0) {
			await must(["docker", "network", "rm", ...networks]);
			removed.push(`docker network rm（${networks.length} 个网络，exit 0）`);
		}
		const left = (await must(["docker", "ps", "-a", "--filter", `name=${names.container}`, "--format", "{{.Names}}"])).trim();
		const leftNetworks = (await must(["docker", "network", "ls", "--filter", `name=${names.container}`, "--format", "{{.Name}}"])).trim();
		console.log(`--- docker ps -a --filter name=${names.container}\n${left}`);
		console.log(`--- docker network ls --filter name=${names.container}\n${leftNetworks}`);
		const clean = left === "" && leftNetworks === "";
		const at = new Date().toISOString();
		const evidence = clean
			? `${removed.join("；") || "没有需要删除的资源"}；${at} \`docker ps -a\`、\`docker network ls\` 按 \`name=${names.container}\` 过滤均为空`
			: `${removed.join("；")}；${at} 仍有残留：${[left, leftNetworks].filter((x) => x !== "").join(", ")}`;
		return { clean, evidence };
	} catch (error) {
		const failure = `${new Date().toISOString()} 清理未确认：${error instanceof Error ? error.message : String(error)}`;
		console.error(failure);
		return { clean: false, evidence: [...removed, failure].join("；") };
	}
}

interface ModelResult {
	readonly model: string;
	readonly kind: string;
}

async function matrix(names: Names, scenarioPath: string, models: readonly string[]): Promise<number> {
	const scenario = parseScenario(JSON.parse(readFileSync(scenarioPath, "utf8")));
	const inContainer = `/scenarios/${basename(scenarioPath)}`;
	await must(["docker", "cp", scenarioPath, `${names.container}:${inContainer}`]);
	const results: ModelResult[] = [];
	for (const model of models) {
		const slug = model.replaceAll("/", "_");
		const hostDir = join(names.out, "evidence", slug);
		mkdirSync(hostDir, { recursive: true });
		const driven = await exec(["docker", "exec", names.container, "bun", "/sandbox/driver.ts", inContainer, model, `/evidence/${slug}`]);
		process.stdout.write(driven.stdout);
		if (driven.stderr.trim() !== "") process.stderr.write(driven.stderr);
		for (const suffix of ["driver.json", "events.jsonl", "session.jsonl", "requests.jsonl"]) {
			const file = `/evidence/${slug}/${scenario.name}.${suffix}`;
			if ((await exec(["docker", "exec", names.container, "test", "-f", file])).code === 0) {
				await must(["docker", "cp", `${names.container}:${file}`, join(hostDir, `${scenario.name}.${suffix}`)]);
			}
		}
		results.push({ model, kind: resultKind(join(hostDir, `${scenario.name}.driver.json`)) });
	}
	console.log(`evidence: ${join(names.out, "evidence")}`);
	for (const result of results) console.log(`  ${result.kind.padEnd(13)} ${result.model}`);
	return results.every((result) => result.kind === "pass") ? 0 : 1;
}

function resultKind(driverJson: string): string {
	try {
		const parsed: unknown = JSON.parse(readFileSync(driverJson, "utf8"));
		if (typeof parsed === "object" && parsed !== null && "result" in parsed) {
			const result: unknown = parsed.result;
			if (typeof result === "object" && result !== null && "kind" in result && typeof result.kind === "string") return result.kind;
		}
		return "harness-error";
	} catch {
		return "harness-error";
	}
}

async function exportCache(names: Names): Promise<boolean> {
	const inContainer = "/evidence/cache.json";
	const exported = await exec([
		"docker",
		"exec",
		names.container,
		"bun",
		"/sandbox/cache.ts",
		join(HOME, ".omp", "agent", "sessions"),
		inContainer,
	]);
	process.stdout.write(exported.stdout);
	const hostFile = join(names.out, "cache.json");
	const copied = exported.code === 0 ? await exec(["docker", "cp", `${names.container}:${inContainer}`, hostFile]) : exported;
	if (copied.code !== 0) {
		console.error(`cache export failed (exit ${copied.code}): ${copied.stderr.trim()}`);
		return false;
	}
	console.log(`cache: ${hostFile}`);
	return true;
}

async function exportEvidence(names: Names): Promise<void> {
	const evidenceDir = join(names.out, "evidence");
	mkdirSync(evidenceDir, { recursive: true });
	for (const file of ["interactive.requests.jsonl", "recorder.log"]) {
		const src = `/evidence/${file}`;
		if ((await exec(["docker", "exec", names.container, "test", "-f", src])).code === 0) {
			const copied = await exec(["docker", "cp", `${names.container}:${src}`, join(evidenceDir, file)]);
			if (copied.code !== 0) console.error(`evidence export failed (${file}): ${copied.stderr.trim()}`);
		}
	}
	const containerLogs = join(HOME, ".omp", "logs");
	if ((await exec(["docker", "exec", names.container, "test", "-d", containerLogs])).code === 0) {
		const logsDir = join(evidenceDir, "logs");
		mkdirSync(logsDir, { recursive: true });
		const copied = await exec(["docker", "cp", `${names.container}:${containerLogs}/.`, logsDir]);
		if (copied.code !== 0) console.error(`evidence export failed (logs): ${copied.stderr.trim()}`);
	}
}

async function withSandbox(
	options: BuildOptions,
	purpose: string,
	middle: (names: Names, signal: AbortSignal) => Promise<number>,
): Promise<number> {
	const names = namesOf(`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(names.out, { recursive: true });
	const pluginsNote = options.plugins.length > 0 ? `；插件 ${options.plugins.join(", ")}` : "";
	ledgerStart(
		names.run,
		new Date().toISOString(),
		`${purpose}；工作树 ${options.repo}${pluginsNote}${options.target ? "；含 ssh 目标机" : ""}`,
	);
	const controller = new AbortController();
	const stop = (): void => controller.abort();
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	process.on("SIGHUP", stop);
	let code = 1;
	try {
		await build(names, options, controller.signal);
		code = await middle(names, controller.signal);
		await exportCache(names);
		await exportEvidence(names);
	} catch (error) {
		console.error(`sandbox ${names.container}: ${error instanceof Error ? error.message : String(error)}`);
		code = 1;
	} finally {
		const { clean, evidence } = await teardown(names);
		ledgerEnd(names.run, clean ? "已完成、已清理" : "清理失败", evidence);
		if (!clean) code = 1;
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		process.off("SIGHUP", stop);
	}
	return code;
}

async function hold(names: Names, signal: AbortSignal): Promise<number> {
	console.log(`ready: ${names.container}  (run ${names.run})
  interactive:  docker exec -it -w /work ${names.container} omp --model <provider>/<model>
  batch:        bun ${join(import.meta.dir, "sandbox.ts")} matrix ${names.run} SCENARIO_JSON MODEL...
  evidence:     ${join(names.out, "evidence")}
  cache:        bun ${join(import.meta.dir, "sandbox.ts")} cache ${names.run}   (also exported before teardown)
  stop:         Ctrl-C or SIGTERM to this process, then let it finish removing the sandbox (a few seconds; never SIGKILL)`);
	const { promise, resolve: stopped } = Promise.withResolvers<void>();
	if (signal.aborted) stopped();
	else signal.addEventListener("abort", () => stopped(), { once: true });
	const keepAlive = setInterval(() => {}, 60_000);
	try {
		await promise;
	} finally {
		clearInterval(keepAlive);
	}
	return 0;
}

async function prune(): Promise<number> {
	const running = new Set(
		(await must(["docker", "ps", "--filter", `label=${LABEL}`, "--filter", "status=running", "--format", `{{.Label "${LABEL}"}}`]))
			.split("\n")
			.map((line) => line.trim())
			.filter((id) => RUN_ID.test(id)),
	);
	const candidates = new Set<string>();
	for (const argv of [
		["docker", "ps", "-a", "--filter", `label=${LABEL}`, "--format", `{{.Label "${LABEL}"}}`],
		["docker", "network", "ls", "--filter", `label=${LABEL}`, "--format", `{{.Label "${LABEL}"}}`],
	]) {
		for (const line of (await must(argv)).split("\n")) {
			const id = line.trim();
			if (RUN_ID.test(id)) candidates.add(id);
		}
	}
	for (const id of ledgerInProgress()) {
		if (RUN_ID.test(id)) candidates.add(id);
	}
	const stale = [...candidates].filter((id) => !running.has(id)).sort();
	if (stale.length === 0) {
		console.log("prune: nothing to clean");
		return 0;
	}
	let ok = true;
	for (const run of stale) {
		const { clean, evidence } = await teardown(namesOf(run));
		ledgerEnd(run, clean ? "已清理（prune）" : "清理失败", evidence);
		if (!clean) ok = false;
	}
	console.log(`prune: cleaned ${stale.length} run(s) (${running.size} running untouched)`);
	return ok ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
	let command: Command;
	try {
		command = parseCommand(argv);
	} catch (error) {
		console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
		return 2;
	}
	switch (command.kind) {
		case "hold":
			return withSandbox(command.options, "hold（交互）", hold);
		case "run": {
			const { scenario, models } = command;
			return withSandbox(command.options, `run ${basename(scenario)}：${models.join(", ")}`, (names) => matrix(names, scenario, models));
		}
		case "matrix":
			return matrix(namesOf(command.run), command.scenario, command.models);
		case "cache":
			return (await exportCache(namesOf(command.run))) ? 0 : 1;
		case "down": {
			const names = namesOf(command.run);
			const { clean, evidence } = await teardown(names);
			ledgerEnd(names.run, clean ? "已清理（down）" : "清理失败", evidence);
			return clean ? 0 : 1;
		}
		case "prune":
			return prune();
		default: {
			const unreachable: never = command;
			return unreachable;
		}
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
