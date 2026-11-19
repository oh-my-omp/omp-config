import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function discoverSpecFiles(pattern: RegExp, extensionDir: string, cwd: string): string[] {
	const home = resolve(homedir());
	const realHome = realpathOr(home);
	const start = resolve(cwd);
	let top = start;
	while (!isBoundary(top, home, realHome)) {
		const parent = dirname(top);
		if (parent === top) {
			top = start;
			break;
		}
		top = parent;
	}
	const dirs = [extensionDir];
	for (let dir = start; ; dir = dirname(dir)) {
		dirs.push(dir, join(dir, ".omp"));
		if (dir === top) break;
	}
	const files: string[] = [];
	const seen = new Set<string>();
	for (const directory of dirs) {
		let names: string[];
		try {
			names = readdirSync(directory);
		} catch {
			continue;
		}
		for (const name of names.filter((name) => pattern.test(name)).sort()) {
			const path = join(directory, name);
			if (seen.has(path)) continue;
			seen.add(path);
			files.push(path);
		}
	}
	return files;
}

function isBoundary(dir: string, home: string, realHome: string): boolean {
	return dir === home || realpathOr(dir) === realHome || existsSync(join(dir, ".git"));
}

function realpathOr(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(raw: string): { readonly fields: Readonly<Record<string, string>>; readonly body: string } | null {
	const match = FRONTMATTER.exec(raw);
	if (!match) return null;
	const fields: Record<string, string> = {};
	for (const line of (match[1] ?? "").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const colon = trimmed.indexOf(":");
		if (colon <= 0) continue;
		fields[trimmed.slice(0, colon).trim().toLowerCase()] = trimmed.slice(colon + 1).trim();
	}
	return { fields, body: raw.slice(match[0].length) };
}

export function unquote(value: string): string {
	return value
		.trim()
		.replace(/^["']|["']$/g, "")
		.trim();
}
