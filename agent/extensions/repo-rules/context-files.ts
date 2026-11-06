import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { findRepoRoot } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { expandAtImports } from "@oh-my-pi/pi-coding-agent/discovery/at-imports";

/** OMP's `agents-md` and `claude-md` providers, in their registration order: AGENTS.md wins a directory both name. */
const STANDALONE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
type StandaloneName = (typeof STANDALONE_NAMES)[number];

/** Who reads the files: task subagents never receive AGENTS.md (OMP's `excludeAgentsMd`). */
export type Audience = "main" | "sub";

/** Per-cwd facts the walk needs; collected once per cwd. */
export interface ContextFileScope {
	readonly cwd: string;
	readonly home: string;
	readonly repoRoot: string | null;
	/** Directory depths (0 = cwd) where a context file OMP still loads takes the slot first. */
	readonly claimed: ReadonlySet<number>;
}

/** One context file as delivered: a path that does not depend on the checkout, and its expanded text. */
export interface DeliveredContextFile {
	readonly displayPath: string;
	readonly content: string;
}

interface Candidate {
	readonly file: string;
	readonly depth: number;
	readonly name: StandaloneName;
}

/**
 * Depth slots taken by the context files OMP itself still loads. Every remaining context-file
 * provider outranks `agents-md`/`claude-md`, so a file of theirs at a depth shadowed the standalone
 * file there; additive `contextFiles.extra` files never take a slot.
 */
export async function contextFileScope(cwd: string): Promise<ContextFileScope> {
	const [repoRoot, native] = await Promise.all([findRepoRoot(cwd), loadCapability<ContextFile>(contextFileCapability.id, { cwd })]);
	const claimed = new Set<number>();
	for (const file of native.items) {
		if (file.level === "project" && file.additive !== true) claimed.add(Math.max(0, file.depth ?? 0));
	}
	return { cwd: path.resolve(cwd), home: path.resolve(os.homedir()), repoRoot: repoRoot === null ? null : path.resolve(repoRoot), claimed };
}

/** Read fresh on every call: a context file edited mid-session is delivered with its new text. */
function readNonEmpty(file: string): string | null {
	try {
		// A FIFO or socket would block a read until EOF; only regular files are context files.
		if (!fs.statSync(file).isFile()) return null;
		const content = fs.readFileSync(file, "utf8");
		return content === "" ? null : content;
	} catch {
		// A missing or unreadable file contributes nothing.
		return null;
	}
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// @upstream adapted @oh-my-pi/pi-coding-agent@18.17.0 src/discovery/helpers.ts#loadStandaloneContextFiles
/** Standalone context files from the cwd up to OMP's boundary, with their depth below the cwd. */
function walk(scope: ContextFileScope, name: StandaloneName): Candidate[] {
	const { cwd, home, repoRoot } = scope;
	const cwdIsUnderHome = isWithin(home, cwd);
	const repoIsHome = repoRoot !== null && repoRoot === home;
	const repoIsUnderHome = repoRoot !== null && isWithin(home, repoRoot) && !repoIsHome;
	const scanToHome = repoRoot !== null && cwdIsUnderHome && repoIsUnderHome;
	const boundary = scanToHome ? home : (repoRoot ?? (cwdIsUnderHome ? home : path.parse(cwd).root));
	const includeBoundary = repoRoot === null ? cwdIsUnderHome : boundary !== home || repoIsHome;
	const found: Candidate[] = [];
	let current = cwd;
	for (;;) {
		const atBoundary = current === boundary;
		const atHome = scanToHome && current === home;
		if (!(atHome || (atBoundary && !includeBoundary)) && !path.basename(current).startsWith(".")) {
			const file = path.join(current, name);
			if (readNonEmpty(file) !== null) found.push({ file, depth: cwd.split(path.sep).length - current.split(path.sep).length, name });
		}
		if (atBoundary) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return found;
}
// @upstream-end

/** Path relative to the repository root, else `~/…` under the home directory, else absolute; always `/`-separated. */
function displayPath(scope: ContextFileScope, file: string): string {
	const posix = (relative: string): string => relative.split(path.sep).join("/");
	if (scope.repoRoot !== null && isWithin(scope.repoRoot, file)) return posix(path.relative(scope.repoRoot, file));
	if (isWithin(scope.home, file)) return `~/${posix(path.relative(scope.home, file))}`;
	return file;
}

/**
 * The AGENTS.md / CLAUDE.md files OMP's `agents-md` and `claude-md` providers would load, one per
 * depth slot not claimed by another provider, farthest from the cwd first (OMP's order). A subagent
 * skips AGENTS.md, so a directory holding both gives it CLAUDE.md.
 */
export async function loadContextFiles(scope: ContextFileScope, audience: Audience): Promise<DeliveredContextFile[]> {
	const names = STANDALONE_NAMES.filter((name) => audience === "main" || name !== "AGENTS.md");
	const bySlot = new Map<number, Candidate>();
	for (const name of names) {
		for (const candidate of walk(scope, name)) {
			const slot = Math.max(0, candidate.depth);
			if (!scope.claimed.has(slot) && !bySlot.has(slot)) bySlot.set(slot, candidate);
		}
	}
	const ordered = [...bySlot.values()].sort((a, b) => b.depth - a.depth);
	return await Promise.all(
		ordered.map(async (candidate) => {
			const raw = readNonEmpty(candidate.file) ?? "";
			return { displayPath: displayPath(scope, candidate.file), content: await expandAtImports(raw, candidate.file, { home: scope.home }) };
		}),
	);
}
