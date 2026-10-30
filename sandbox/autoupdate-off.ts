// Container side of the startup auto-update switch. Runs as `bun /sandbox/autoupdate-off.ts AGENT_DIR`.
// The copied omomp file carries the host's machine-local `omp-config-autoupdate` section; left on,
// the first omp start in the sandbox applies GitHub `main` over the working tree under test. This
// writes `omp-config-autoupdate: { enabled: false }` into the container's agent-dir omomp file
// (creating `omomp.yml` when there is none), keeps every other section, reads the section back and
// prints it. A `.toml` file or several omomp files fail: the switch could not be set reliably.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SECTION = "omp-config-autoupdate";
const [agentDir] = process.argv.slice(2);
if (agentDir === undefined) {
	process.stderr.write("usage: autoupdate-off.ts AGENT_DIR\n");
	process.exit(2);
}

const present = ["yml", "yaml", "json", "toml"].map((ext) => join(agentDir, `omomp.${ext}`)).filter((path) => existsSync(path));
if (present.length > 1) {
	process.stderr.write(`several omomp files: ${present.join(", ")}\n`);
	process.exit(1);
}
const path = present[0] ?? join(agentDir, "omomp.yml");
if (path.endsWith(".toml")) {
	process.stderr.write(`${path}: TOML cannot be rewritten here\n`);
	process.exit(1);
}
const json = path.endsWith(".json");

/** The omomp root is a map of section id → section; anything else (empty file, list) starts from an empty map. */
const sectionsOf = (text: string | null): Record<string, unknown> => {
	const parsed: unknown = text === null ? null : json ? JSON.parse(text) : Bun.YAML.parse(text);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {};
};

const root = sectionsOf(existsSync(path) ? readFileSync(path, "utf8") : null);
root[SECTION] = { enabled: false };
writeFileSync(path, json ? `${JSON.stringify(root, null, 2)}\n` : Bun.YAML.stringify(root, null, 2), { mode: 0o600 });

const written = sectionsOf(readFileSync(path, "utf8"))[SECTION];
process.stdout.write(`${path}: ${SECTION} ${JSON.stringify(written)}\n`);
const off = typeof written === "object" && written !== null && "enabled" in written && written.enabled === false;
process.exit(off ? 0 : 1);
