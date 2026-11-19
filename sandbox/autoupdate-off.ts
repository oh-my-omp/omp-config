import { spawnSync } from "node:child_process";

const KEY = "omp-config-autoupdate.enabled";

function omp(args: readonly string[]): string {
	const result = spawnSync("omp", args, { encoding: "utf8" });
	if (result.error !== undefined || result.status !== 0) {
		process.stderr.write(`omp ${args.join(" ")}: ${result.error?.message ?? (result.stderr || result.stdout).trim()}\n`);
		process.exit(1);
	}
	return result.stdout;
}

omp(["plugin", "config", "set", "omp-config", KEY, "false"]);
const read: unknown = JSON.parse(omp(["plugin", "config", "get", "omp-config", KEY, "--json"]));
const value = typeof read === "object" && read !== null ? Object.entries(read).find(([key]) => key === KEY)?.[1] : undefined;
process.stdout.write(`plugin omp-config: ${KEY} ${JSON.stringify(value)}\n`);
process.exit(value === false ? 0 : 1);
