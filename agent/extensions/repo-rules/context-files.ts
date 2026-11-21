import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { findRepoRoot } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { expandAtImports } from "@oh-my-pi/pi-coding-agent/discovery/at-imports";

const STANDALONE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
type StandaloneName = (typeof STANDALONE_NAMES)[number];

export type Audience = "main" | "sub";

export interface ContextFileScope {
	readonly cwd: string;
	readonly home: string;
	readonly repoRoot: string | null;
	readonly claimed: ReadonlySet<number>;
}

export interface DeliveredContextFile {
	readonly displayPath: string;
	readonly content: string;
}

interface FoundFile {
	readonly file: string;
	readonly depth: number;
	readonly raw: string;
}

export async function contextFileScope(cwd: string): Promise<ContextFileScope> {
	const [repoRoot, native] = await Promise.all([findRepoRoot(cwd), loadCapability<ContextFile>(contextFileCapability.id, { cwd })]);
	const claimed = new Set<number>();
	for (const file of native.items) {
		if (file.level === "project" && file.additive !== true) claimed.add(Math.max(0, file.depth ?? 0));
	}
	return { cwd: path.resolve(cwd), home: path.resolve(os.homedir()), repoRoot: repoRoot === null ? null : path.resolve(repoRoot), claimed };
}

function readNonEmpty(file: string): string | null {
	try {
		// A FIFO or socket would block a read.
		if (fs.statSync(file, { throwIfNoEntry: false })?.isFile() !== true) return null;
		const content = fs.readFileSync(file, "utf8");
		return content === "" ? null : content;
	} catch {
		return null;
	}
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isWithin(parent: string, child: string): boolean {
	const relative = process.platform === "win32" ? path.relative(parent.toLowerCase(), child.toLowerCase()) : path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function walk(scope: ContextFileScope, name: StandaloneName, visit: (file: string, depth: number) => void): void {
	const { cwd, home, repoRoot } = scope;
	const cwdIsUnderHome = isWithin(home, cwd);
	const repoIsHome = repoRoot !== null && samePath(repoRoot, home);
	const repoIsUnderHome = repoRoot !== null && isWithin(home, repoRoot) && !repoIsHome;
	const scanToHome = repoRoot !== null && cwdIsUnderHome && repoIsUnderHome;
	const boundary = scanToHome ? home : (repoRoot ?? (cwdIsUnderHome ? home : path.parse(cwd).root));
	const includeBoundary = repoRoot === null ? cwdIsUnderHome : !samePath(boundary, home) || repoIsHome;
	const cwdDepth = cwd.split(path.sep).length;
	let current = cwd;
	for (;;) {
		const atBoundary = samePath(current, boundary);
		const atHome = scanToHome && samePath(current, home);
		if (!(atHome || (atBoundary && !includeBoundary)) && !path.basename(current).startsWith(".")) {
			visit(path.join(current, name), cwdDepth - current.split(path.sep).length);
		}
		if (atBoundary) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
}

function displayPath(scope: ContextFileScope, file: string): string {
	const posix = (relative: string): string => relative.split(path.sep).join("/");
	if (scope.repoRoot !== null && isWithin(scope.repoRoot, file)) return posix(path.relative(scope.repoRoot, file));
	if (isWithin(scope.home, file)) return `~/${posix(path.relative(scope.home, file))}`;
	return file;
}

export async function loadContextFiles(scope: ContextFileScope, audience: Audience): Promise<DeliveredContextFile[]> {
	const names = STANDALONE_NAMES.filter((name) => audience === "main" || name !== "AGENTS.md");
	const bySlot = new Map<number, FoundFile>();
	for (const name of names) {
		walk(scope, name, (file, depth) => {
			const slot = Math.max(0, depth);
			if (scope.claimed.has(slot) || bySlot.has(slot)) return;
			const raw = readNonEmpty(file);
			if (raw !== null) bySlot.set(slot, { file, depth, raw });
		});
	}
	const ordered = [...bySlot.values()].sort((a, b) => b.depth - a.depth);
	return await Promise.all(
		ordered.map(async (found) => ({
			displayPath: displayPath(scope, found.file),
			content: await expandAtImports(found.raw, found.file, { home: scope.home }),
		})),
	);
}
