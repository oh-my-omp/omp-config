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

/** A context file that won a depth slot, with the text read for it and its depth below the cwd. */
interface FoundFile {
	readonly file: string;
	readonly depth: number;
	readonly raw: string;
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
		// A missing file is an ordinary answer, not an exception; a FIFO or socket would block a read.
		if (fs.statSync(file, { throwIfNoEntry: false })?.isFile() !== true) return null;
		const content = fs.readFileSync(file, "utf8");
		return content === "" ? null : content;
	} catch {
		// A file that disappears or becomes unreadable contributes nothing.
		return null;
	}
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// @upstream adapted @oh-my-pi/pi-coding-agent@18.17.0 src/discovery/helpers.ts#loadStandaloneContextFiles
/**
 * Visits the directory holding `<name>` from the cwd up to OMP's boundary, nearest first, with its
 * depth below the cwd. The caller decides whether that depth still takes a file, so a slot taken by
 * another provider or an earlier name is never read.
 */
function walk(scope: ContextFileScope, name: StandaloneName, visit: (file: string, depth: number) => void): void {
	const { cwd, home, repoRoot } = scope;
	const cwdIsUnderHome = isWithin(home, cwd);
	const repoIsHome = repoRoot !== null && repoRoot === home;
	const repoIsUnderHome = repoRoot !== null && isWithin(home, repoRoot) && !repoIsHome;
	const scanToHome = repoRoot !== null && cwdIsUnderHome && repoIsUnderHome;
	const boundary = scanToHome ? home : (repoRoot ?? (cwdIsUnderHome ? home : path.parse(cwd).root));
	const includeBoundary = repoRoot === null ? cwdIsUnderHome : boundary !== home || repoIsHome;
	const cwdDepth = cwd.split(path.sep).length;
	let current = cwd;
	for (;;) {
		const atBoundary = current === boundary;
		const atHome = scanToHome && current === home;
		if (!(atHome || (atBoundary && !includeBoundary)) && !path.basename(current).startsWith(".")) {
			visit(path.join(current, name), cwdDepth - current.split(path.sep).length);
		}
		if (atBoundary) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
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
