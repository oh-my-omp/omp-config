import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSpecFiles } from "../agent/extensions/_shared/spec-files.ts";

const marker = /^SPEC-.+\.md$/;

function spec(dir: string, name: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, "---\nenabled: true\n---\nx\n");
	return file;
}

describe("discoverSpecFiles walk boundary", () => {
	test("gitless cwd outside HOME scans only cwd and its .omp", () => {
		const outside = mkdtempSync(join(tmpdir(), "omp-spec-outside-"));
		const cwd = join(outside, "work");
		mkdirSync(cwd, { recursive: true });
		spec(outside, "SPEC-ancestor.md");
		spec(join(outside, ".omp"), "SPEC-ancestor-omp.md");
		const own = spec(cwd, "SPEC-own.md");
		const ownOmp = spec(join(cwd, ".omp"), "SPEC-own-omp.md");
		const got = discoverSpecFiles(marker, join(outside, "no-ext"), cwd);
		expect(got.sort()).toEqual([own, ownOmp].sort());
	});

	test("a git root bounds the walk, inclusive", () => {
		const outside = mkdtempSync(join(tmpdir(), "omp-spec-repo-"));
		const repo = join(outside, "repo");
		const cwd = join(repo, "sub", "deep");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(repo, ".git"), "gitdir: elsewhere\n");
		const atRoot = spec(repo, "SPEC-repo.md");
		const above = spec(outside, "SPEC-above-repo.md");
		const got = discoverSpecFiles(marker, join(outside, "no-ext"), cwd);
		expect(got).toContain(atRoot);
		expect(got).not.toContain(above);
	});

	test("the extension directory is always scanned", () => {
		const outside = mkdtempSync(join(tmpdir(), "omp-spec-ext-"));
		const extDir = join(outside, "ext");
		const cwd = join(outside, "work");
		mkdirSync(cwd, { recursive: true });
		const fromExt = spec(extDir, "SPEC-ext.md");
		expect(discoverSpecFiles(marker, extDir, cwd)).toContain(fromExt);
	});

	// homedir() is fixed at process start, so a fake HOME runs in a subprocess.
	test("gitless cwd inside HOME walks up to HOME, inclusive", () => {
		const outside = mkdtempSync(join(tmpdir(), "omp-spec-home-"));
		const home = join(outside, "home");
		const cwd = join(home, "work");
		mkdirSync(cwd, { recursive: true });
		spec(home, "SPEC-home.md");
		spec(outside, "SPEC-above.md");
		const module = join(import.meta.dir, "..", "agent", "extensions", "_shared", "spec-files.ts");
		const code = `import { discoverSpecFiles } from ${JSON.stringify(module)};
const got = discoverSpecFiles(/^SPEC-.+\\.md$/, "/nonexistent-ext", process.cwd());
const ok = got.some((f) => f.endsWith("/home/SPEC-home.md")) && !got.some((f) => f.endsWith("/SPEC-above.md"));
console.log(ok ? "ok" : JSON.stringify(got));
process.exit(ok ? 0 : 1);`;
		const out = execFileSync(process.execPath, ["-e", code], {
			cwd,
			env: { ...process.env, HOME: home },
			encoding: "utf8",
		});
		expect(out.trim()).toBe("ok");
	});
});
