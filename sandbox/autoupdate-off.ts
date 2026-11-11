// Container side of the startup auto-update switch. Runs as `bun /sandbox/autoupdate-off.ts`, after
// the /repo updater linked the plugin `omp-config` and moved the copied omomp values into its settings.
// The copied host settings may have the startup auto-update on; left on, the first omp start in the
// sandbox applies the GitHub `release` branch over the working tree under test. This sets the plugin setting
// `omp-config-autoupdate.enabled` to false through `omp plugin config set`, reads it back with
// `omp plugin config get` and prints it; any other value fails the build.
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
