import { isBuiltin } from "node:module";
import * as path from "node:path";
import { collectBundledPiEntries } from "../node_modules/@oh-my-pi/pi-coding-agent/scripts/legacy-pi-virtual-module.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const ROOT_CODING_AGENT = "@oh-my-pi/pi-coding-agent";
// Only symbols with no non-shim bundled subpath in omp 19.1.0 (`@oh-my-pi/omptype/zod`
// and `@oh-my-pi/pi-coding-agent/sdk` are absent from `collectBundledPiEntries()`).
const ALLOWED_ROOT_CODING_AGENT_VALUES = new Set(["z", "createAgentSession"]);

const keys = new Set((await collectBundledPiEntries()).map((entry) => entry.key));
const transpiler = new Bun.Transpiler({ loader: "ts" });
const ROOT_IMPORT_RE = /\b(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+["']@oh-my-pi\/pi-coding-agent["']/g;

function valueImportsFromCodingAgentRoot(source: string): string[] {
	const names: string[] = [];
	for (const match of source.matchAll(ROOT_IMPORT_RE)) {
		const clause = match[1]?.trim() ?? "";
		const braceStart = clause.indexOf("{");
		const braceEnd = clause.lastIndexOf("}");
		if (braceStart === -1 || braceEnd === -1) {
			names.push(clause || "*");
			continue;
		}
		const inside = clause.slice(braceStart + 1, braceEnd);
		for (const rawItem of inside.split(",")) {
			const item = rawItem.trim();
			if (!item || item.startsWith("type ")) continue;
			const local = item.split(/\s+as\s+/)[0]?.trim();
			if (local) names.push(local);
		}
	}
	return names;
}

const findings: { readonly file: string; readonly specifier: string; readonly reason: string }[] = [];
for await (const file of new Bun.Glob("agent/**/*.ts").scan({ cwd: ROOT })) {
	const source = await Bun.file(path.join(ROOT, file)).text();
	for (const { path: specifier } of transpiler.scan(source).imports) {
		const exempt =
			specifier.startsWith(".") || specifier.startsWith("/") || specifier === "bun" || specifier.startsWith("bun:") || isBuiltin(specifier);
		if (!exempt && !keys.has(specifier)) {
			findings.push({ file, specifier, reason: `'${specifier}' is not in the omp binary's module table` });
		}
		if (specifier === ROOT_CODING_AGENT) {
			for (const name of valueImportsFromCodingAgentRoot(source)) {
				if (!ALLOWED_ROOT_CODING_AGENT_VALUES.has(name)) {
					findings.push({
						file,
						specifier: `${specifier}#${name}`,
						reason: `'${name}' must be imported from a bundled subpath instead of '${ROOT_CODING_AGENT}' root`,
					});
				}
			}
		}
	}
}
findings.sort((a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier));
for (const { file, reason } of findings) {
	console.error(`${file}: ${reason}`);
}
if (findings.length > 0) process.exit(1);
