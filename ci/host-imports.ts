import { isBuiltin } from "node:module";
import * as path from "node:path";
import { collectBundledPiEntries } from "../node_modules/@oh-my-pi/pi-coding-agent/scripts/legacy-pi-virtual-module.ts";

const ROOT = path.resolve(import.meta.dir, "..");

const keys = new Set((await collectBundledPiEntries()).map((entry) => entry.key));
const transpiler = new Bun.Transpiler({ loader: "ts" });
const findings: { readonly file: string; readonly specifier: string }[] = [];
for await (const file of new Bun.Glob("agent/**/*.ts").scan({ cwd: ROOT })) {
	const source = await Bun.file(path.join(ROOT, file)).text();
	for (const { path: specifier } of transpiler.scan(source).imports) {
		const exempt =
			specifier.startsWith(".") || specifier.startsWith("/") || specifier === "bun" || specifier.startsWith("bun:") || isBuiltin(specifier);
		if (!exempt && !keys.has(specifier)) findings.push({ file, specifier });
	}
}
findings.sort((a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier));
for (const { file, specifier } of findings) {
	console.error(`${file}: '${specifier}' is not in the omp binary's module table`);
}
if (findings.length > 0) process.exit(1);
