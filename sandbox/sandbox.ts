// omp test sandbox (#71): a throwaway Linux container on the local OrbStack with the latest omp,
// a copy of this machine's ~/.omp configuration and credentials, and the omp-config working tree
// under test. Commands (`bun sandbox/sandbox.ts …`):
//   hold [--target] [--repo DIR]                          build a sandbox, keep it until SIGINT/SIGTERM, then remove it
//   run  [--target] [--repo DIR] SCENARIO_JSON MODEL...   build, run the scenario for each model, remove
//   matrix RUN SCENARIO_JSON MODEL...                     run a scenario inside a held sandbox
//   down RUN                                              remove a run whose holder was killed without cleanup
// Behavior, contracts and failure policy: sandbox/README.md.
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { copyAgentDb, copyClaude, copyOmpDir, copyRepo, IMAGE, installOmp, installTools, PLATFORM, setUpTarget } from "./content.ts";
import { run as exec, must } from "./docker.ts";
import { parseScenario } from "./driver.ts";
import { ledgerEnd, ledgerStart } from "./ledger.ts";

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
}

type Command =
	| { readonly kind: "hold"; readonly options: BuildOptions }
	| { readonly kind: "run"; readonly options: BuildOptions; readonly scenario: string; readonly models: readonly string[] }
	| { readonly kind: "matrix"; readonly run: string; readonly scenario: string; readonly models: readonly string[] }
	| { readonly kind: "down"; readonly run: string };

const USAGE = `usage:
  sandbox.ts hold [--target] [--repo DIR]
  sandbox.ts run [--target] [--repo DIR] SCENARIO_JSON MODEL...
  sandbox.ts matrix RUN SCENARIO_JSON MODEL...
  sandbox.ts down RUN`;

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
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index] ?? "";
		if (arg === "--target") target = true;
		else if (arg === "--repo") {
			const value = rest[++index];
			if (value === undefined) throw new UsageError("--repo needs a directory");
			repo = resolve(value);
		} else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
		else positional.push(arg);
	}
	const options = { target, repo };
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
		case "down":
			return { kind: "down", run: parseRunId(positional[0]) };
		default:
			throw new UsageError(verb === undefined ? "missing command" : `unknown command ${verb}`);
	}
}

/** Creates network, sandbox and optional target, checking `signal` between steps. */
async function build(names: Names, options: BuildOptions, signal: AbortSignal): Promise<void> {
	const step = async <T>(title: string, action: () => Promise<T>): Promise<T> => {
		if (signal.aborted) throw new Interrupted("interrupted");
		console.log(`· ${title}`);
		return action();
	};
	const labels = ["--label", `${LABEL}=${names.run}`];
	await step(`pull ${IMAGE}`, () => must(["docker", "pull", "-q", "--platform", PLATFORM, IMAGE]));
	await step(`network ${names.network}`, () => must(["docker", "network", "create", ...labels, names.network]));
	await step(`container ${names.container}`, () =>
		must([
			"docker",
			"run",
			"-d",
			"--init",
			"--name",
			names.container,
			...labels,
			"--network",
			names.network,
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
			join(HOME, ".omp"),
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
	const tables = await step("agent.db", () => copyAgentDb(names.container, HOME));
	const differ = tables.filter((check) => check.kind === "differ");
	for (const check of tables)
		console.log(
			check.kind === "equal" ? `  ${check.table}: ${check.rows} rows, every field equal` : `  ${check.table}: DIFFERS (${check.detail})`,
		);
	if (differ.length > 0) throw new Error(`agent.db copy differs from the host snapshot in ${differ.length} table(s)`);
	const claude = await step("~/.claude", () => copyClaude(names.container, HOME));
	console.log(`  ${claude.length === 0 ? "nothing to copy" : claude.join(", ")}`);
	const files = await step(`working tree ${options.repo} -> /repo`, () => copyRepo(names.container, options.repo));
	console.log(`  ${files} files`);
	const installed = await step("plugins, latest omp, auto-update off, updater apply from /repo", () => installOmp(names.container, HOME));
	console.log(`  ${installed.autoupdate}`);
	console.log(`  ${installed.version}`);
	if (options.target)
		await step(`ssh target ${names.target}`, () => setUpTarget(names.container, HOME, names.target, labels, names.network));
}

/** Removes every resource labelled with the run, then confirms the filtered listings are empty. */
async function teardown(names: Names): Promise<{ readonly clean: boolean; readonly evidence: string }> {
	const filter = `label=${LABEL}=${names.run}`;
	const containers = (await must(["docker", "ps", "-aq", "--filter", filter])).split("\n").filter((id) => id !== "");
	const removed: string[] = [];
	if (containers.length > 0) {
		const result = await exec(["docker", "rm", "-f", ...containers]);
		removed.push(`docker rm -f（${containers.length} 个容器，exit ${result.code}）`);
	}
	const networks = (await must(["docker", "network", "ls", "-q", "--filter", filter])).split("\n").filter((id) => id !== "");
	if (networks.length > 0) {
		const result = await exec(["docker", "network", "rm", ...networks]);
		removed.push(`docker network rm（${networks.length} 个网络，exit ${result.code}）`);
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
}

interface ModelResult {
	readonly model: string;
	readonly kind: string;
}

/** Runs the scenario for each model and copies only the driver's three evidence files per model to the host. */
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
		for (const suffix of ["driver.json", "events.jsonl", "session.jsonl"]) {
			const file = `/evidence/${slug}/${scenario.name}.${suffix}`;
			if ((await exec(["docker", "exec", names.container, "test", "-f", file])).code === 0) {
				await must(["docker", "cp", `${names.container}:${file}`, join(hostDir, `${scenario.name}.${suffix}`)]);
			}
		}
		results.push({ model, kind: resultKind(join(hostDir, `${scenario.name}.driver.json`)) });
	}
	console.log(`evidence: ${join(names.out, "evidence")}`);
	for (const result of results) console.log(`  ${result.kind.padEnd(13)} ${result.model}`);
	return results.every((result) => result.kind === "pass" || result.kind === "untested") ? 0 : 1;
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
		// No driver.json: the driver crashed before writing it.
		return "harness-error";
	}
}

/** hold and run: ledger row, build, the middle step, and teardown in `finally`. */
async function withSandbox(
	options: BuildOptions,
	purpose: string,
	middle: (names: Names, signal: AbortSignal) => Promise<number>,
): Promise<number> {
	const names = namesOf(Date.now().toString(36));
	mkdirSync(names.out, { recursive: true });
	ledgerStart(names.run, new Date().toISOString(), `${purpose}；工作树 ${options.repo}${options.target ? "；含 ssh 目标机" : ""}`);
	const controller = new AbortController();
	const stop = (): void => controller.abort();
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	let code = 1;
	try {
		await build(names, options, controller.signal);
		code = await middle(names, controller.signal);
	} catch (error) {
		console.error(`sandbox ${names.container}: ${error instanceof Error ? error.message : String(error)}`);
		code = 1;
	} finally {
		const { clean, evidence } = await teardown(names);
		ledgerEnd(names.run, clean ? "已完成、已清理" : "清理失败", evidence);
		if (!clean) code = 1;
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
	return code;
}

async function hold(names: Names, signal: AbortSignal): Promise<number> {
	console.log(`ready: ${names.container}  (run ${names.run})
  interactive:  docker exec -it -w /work ${names.container} omp --model <provider>/<model>
  batch:        bun ${join(import.meta.dir, "sandbox.ts")} matrix ${names.run} SCENARIO_JSON MODEL...
  evidence:     ${join(names.out, "evidence")}
  stop:         Ctrl-C or SIGTERM to this process, then let it finish removing the sandbox (a few seconds; never SIGKILL)`);
	const { promise, resolve: stopped } = Promise.withResolvers<void>();
	if (signal.aborted) stopped();
	else signal.addEventListener("abort", () => stopped(), { once: true });
	await promise;
	return 0;
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
		case "down": {
			const names = namesOf(command.run);
			const { clean, evidence } = await teardown(names);
			ledgerEnd(names.run, clean ? "已清理（down）" : "清理失败", evidence);
			return clean ? 0 : 1;
		}
		default: {
			const unreachable: never = command;
			return unreachable;
		}
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
