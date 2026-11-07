import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Files named like `pattern` (e.g. `TURN-JUDGE-*.md`), from the extension's
 * own directory first, then from every directory between `cwd` and the first
 * of: a directory holding `.git`, or the home directory (both inclusive), each
 * with its `.omp` subdirectory. Reaching the filesystem root without meeting
 * either boundary scans only `cwd` and its `.omp`. Names are sorted within a
 * directory; a path is listed once; an unreadable directory contributes nothing.
 */
export function discoverSpecFiles(pattern: RegExp, extensionDir: string, cwd: string): string[] {
	const home = resolve(homedir());
	const realHome = realpathOr(home);
	const start = resolve(cwd);
	// Boundary by lexical and real path: `homedir()` can name the same directory
	// through a symlink that `cwd` does not share (`/tmp` → `/private/tmp`).
	let top = start;
	while (!isBoundary(top, home, realHome)) {
		const parent = dirname(top);
		if (parent === top) {
			// Neither a git root nor the home directory bounds the walk: only `cwd`.
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
			// Absent or unreadable: nothing to discover here.
			continue;
		}
		for (const name of names.sort()) {
			if (!pattern.test(name)) continue;
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

/** The real path of an existing path; an unresolvable one keeps its lexical form. */
function realpathOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * `---`-fenced frontmatter: one `key: value` per line, keys lowercased, blank
 * and whole-line `#` lines skipped, text after a value kept as part of it.
 * Null when the text does not start with frontmatter.
 */
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

/** A frontmatter value without one pair of surrounding quotes. */
export function unquote(value: string): string {
	return value
		.trim()
		.replace(/^["']|["']$/g, "")
		.trim();
}
