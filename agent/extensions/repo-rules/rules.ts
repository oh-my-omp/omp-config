import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";

/** Rule directories scanned from the cwd up to the repository root (only the cwd outside a repository). */
const PROJECT_RULE_DIRS = [".claude/rules", ".agents/rules", ".pi/rules"] as const;
/** Claude Code's user-level rule directory, scanned in every session. */
const USER_RULE_DIR = path.join(os.homedir(), ".claude", "rules");

/** Placement of a rule that applies everywhere. */
export type UnscopedKind = { readonly kind: "always" } | { readonly kind: "catalog"; readonly description: string };

/** A scanned rule without `paths`, rendered into the system prompt. */
export interface UnscopedRule {
	/** Real path of the rule file. */
	readonly id: string;
	readonly name: string;
	readonly displayPath: string;
	readonly body: string;
	readonly kind: UnscopedKind;
}

/**
 * Where OMP itself puts a native rule (`bucketRules`: alwaysApply before description). When the
 * rule has `paths`, the extension removes it from there and loads it by path instead.
 */
export type NativePlacement =
	| { readonly kind: "always"; readonly content: string }
	| { readonly kind: "rulebook" }
	| { readonly kind: "dropped" };

/** Who discovered a path-scoped rule. Native rules keep OMP's agent scope. */
export type ScopedOrigin =
	| { readonly kind: "scan" }
	| { readonly kind: "native"; readonly agents: readonly string[] | undefined; readonly placement: NativePlacement };

/** A rule with Claude Code `paths` frontmatter: loaded only when a matching file is touched. */
export interface ScopedRule {
	/** Real path of the rule file: identity for deduplication and the loaded marker. */
	readonly id: string;
	readonly name: string;
	readonly body: string;
	readonly patterns: readonly string[];
	readonly globs: readonly Bun.Glob[];
	/** Directory the patterns are relative to. */
	readonly base: string;
	readonly origin: ScopedOrigin;
}

export interface RuleCatalog {
	readonly cwd: string;
	readonly unscoped: readonly UnscopedRule[];
	readonly scoped: readonly ScopedRule[];
}

/** The frontmatter keys this extension reads; their values are checked where they are used. */
const fieldsSchema = z.object({
	paths: z.unknown().optional(),
	alwaysApply: z.unknown().optional(),
	description: z.unknown().optional(),
});
type RuleFields = z.infer<typeof fieldsSchema>;

type Frontmatter =
	| { readonly kind: "absent"; readonly body: string }
	| { readonly kind: "invalid"; readonly body: string }
	| { readonly kind: "valid"; readonly body: string; readonly fields: RuleFields };

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits leading `---` frontmatter; YAML that does not parse to a mapping (or nothing) is invalid. */
function parseFrontmatter(raw: string): Frontmatter {
	const text = raw.replace(/^\uFEFF/, "").trimStart();
	const match = FRONTMATTER.exec(text);
	if (match === null) return { kind: "absent", body: text.trim() };
	const body = text.slice(match[0].length).trim();
	let fields: unknown;
	try {
		fields = Bun.YAML.parse(match[1] ?? "");
	} catch {
		// Claude Code ignores frontmatter that does not parse and loads the rule unconditionally.
		return { kind: "invalid", body };
	}
	if (fields === null || fields === undefined) return { kind: "valid", body, fields: {} };
	const parsed = fieldsSchema.safeParse(fields);
	return parsed.success ? { kind: "valid", body, fields: parsed.data } : { kind: "invalid", body };
}

/** Splits a comma-separated `paths` string at commas outside `{…}` and `[…]`, so brace alternatives survive. */
function splitPatterns(value: string): string[] {
	const out: string[] = [];
	let braces = 0;
	let brackets = 0;
	let current = "";
	for (const ch of value) {
		if (ch === "{") braces++;
		else if (ch === "}" && braces > 0) braces--;
		else if (ch === "[") brackets++;
		else if (ch === "]" && brackets > 0) brackets--;
		if (ch === "," && braces === 0 && brackets === 0) {
			out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	out.push(current);
	return out;
}

/** Claude Code `paths`: a YAML list or a comma-separated string of globs relative to the rule's base directory. */
function parsePaths(value: unknown): string[] {
	let items: string[];
	if (typeof value === "string") items = splitPatterns(value);
	else if (Array.isArray(value)) items = value.filter((item): item is string => typeof item === "string");
	else items = [];
	const patterns = items.map((item) => item.trim().replace(/^\.\//, "")).filter((item) => item !== "");
	return [...new Set(patterns)];
}

function realpathOr(filePath: string): string {
	try {
		return fs.realpathSync(filePath);
	} catch {
		// A path that cannot be resolved keeps its lexical form.
		return filePath;
	}
}

function repoRoot(cwd: string): string {
	let dir = cwd;
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return cwd;
		dir = parent;
	}
}

interface ScanDir {
	readonly dir: string;
	/** Directory `paths` patterns of rules in `dir` are relative to. */
	readonly base: string;
}

/** cwd first, then each ancestor up to the repository root, then the user-level directory. */
function scanDirs(cwd: string): ScanDir[] {
	const root = repoRoot(cwd);
	const dirs: ScanDir[] = [];
	let dir = cwd;
	for (;;) {
		for (const rel of PROJECT_RULE_DIRS) dirs.push({ dir: path.join(dir, rel), base: dir });
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	dirs.push({ dir: USER_RULE_DIR, base: cwd });
	return dirs;
}

function markdownFiles(dir: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		// Missing or unreadable rule directories contribute no rules.
		return [];
	}
	let out: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		let isDirectory = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				const stat = fs.statSync(full);
				isDirectory = stat.isDirectory();
				isFile = stat.isFile();
			} catch {
				// A dangling symlink contributes no rules.
				continue;
			}
		}
		if (isDirectory) out = out.concat(markdownFiles(full));
		else if (isFile && (entry.name.endsWith(".md") || entry.name.endsWith(".mdc"))) out.push(full);
	}
	return out.sort((a, b) => a.localeCompare(b));
}

function readText(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		// A rule file may disappear or become unreadable after discovery.
		return null;
	}
}

function scopedRule(id: string, name: string, body: string, patterns: string[], base: string, origin: ScopedOrigin): ScopedRule {
	return { id, name, body, patterns, globs: patterns.map((pattern) => new Bun.Glob(pattern)), base, origin };
}

/** Placement of a scanned file: `paths` wins; otherwise the existing alwaysApply/description semantics. */
function classifyScanned(frontmatter: Frontmatter): { readonly kind: "scoped"; readonly patterns: string[] } | UnscopedKind {
	switch (frontmatter.kind) {
		case "absent":
		case "invalid":
			return { kind: "always" };
		case "valid": {
			const patterns = parsePaths(frontmatter.fields.paths);
			if (patterns.length > 0) return { kind: "scoped", patterns };
			const always = frontmatter.fields.alwaysApply;
			if (always === true || always === "true") return { kind: "always" };
			const description = frontmatter.fields.description;
			return { kind: "catalog", description: typeof description === "string" && description !== "" ? description : "(no description)" };
		}
		default: {
			const exhaustive: never = frontmatter;
			throw new Error(`Unexpected frontmatter: ${JSON.stringify(exhaustive)}`);
		}
	}
}

function collectScanned(cwd: string, unscoped: Map<string, UnscopedRule>, scoped: Map<string, ScopedRule>): void {
	const names = new Set<string>();
	for (const { dir, base } of scanDirs(cwd)) {
		for (const filePath of markdownFiles(dir)) {
			const id = realpathOr(filePath);
			const name = path.basename(filePath).replace(/\.mdc?$/, "");
			if (names.has(name) || scoped.has(id)) continue; // nearest directory wins
			const raw = readText(filePath);
			if (raw === null || raw.trim() === "") continue;
			const frontmatter = parseFrontmatter(raw);
			if (frontmatter.body === "") continue;
			names.add(name);
			const placement = classifyScanned(frontmatter);
			if (placement.kind === "scoped") {
				scoped.set(id, scopedRule(id, name, frontmatter.body, placement.patterns, base, { kind: "scan" }));
				continue;
			}
			unscoped.set(name, { id, name, displayPath: path.relative(cwd, filePath) || filePath, body: frontmatter.body, kind: placement });
		}
	}
}

/**
 * Base directory of a native rule. User-level rules match against the cwd (Claude Code's user-rule
 * semantics). A project rule inside a dot directory of the cwd or one of its ancestors (`.omp`,
 * `.claude`, `.cursor`, `.github`, …) matches against that ancestor; a rule under a plugin or
 * extension root's `rules/` matches against that root. Anything else has no defined base.
 */
function nativeBase(rule: Rule, cwd: string): string | null {
	if (rule._source.level !== "project") return cwd;
	let dir = cwd;
	for (;;) {
		const rel = path.relative(dir, rule.path);
		const first = rel.split(path.sep)[0] ?? "";
		if (rel !== "" && !path.isAbsolute(rel) && first !== ".." && first.startsWith(".")) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (let dir = path.dirname(rule.path); dir !== path.dirname(dir); dir = path.dirname(dir)) {
		if (path.basename(dir) === "rules") return path.dirname(dir);
	}
	return null;
}

/** Native rules `paths` can scope: all but OMP's bundled defaults and TTSR rules, which OMP triggers itself. */
function nativeDefersToPaths(rule: Rule): boolean {
	if (rule._source.provider === BUILTIN_DEFAULTS_PROVIDER_ID) return false;
	return !((rule.condition?.length ?? 0) > 0 || (rule.astCondition?.length ?? 0) > 0 || rule.question !== undefined);
}

interface NativeCollection {
	/** Real paths of rule files OMP places itself; the scan does not render them again. */
	readonly placed: ReadonlySet<string>;
	/** Path-scoped rule files skipped for lack of a base directory. */
	readonly unbased: readonly string[];
}

/**
 * Native rules re-read from disk for the `paths` field OMP does not parse. A file the scan already
 * holds as path-scoped keeps its scanned base but takes OMP's agent scope and placement, or leaves
 * the path-scoped set when OMP triggers it itself (TTSR).
 */
async function collectNative(cwd: string, scoped: Map<string, ScopedRule>): Promise<NativeCollection> {
	const placed = new Set<string>();
	const unbased: string[] = [];
	const result = await loadCapability<Rule>(ruleCapability.id, { cwd });
	for (const rule of result.items) {
		const id = realpathOr(rule.path);
		const defers = nativeDefersToPaths(rule);
		const placement: NativePlacement =
			rule.alwaysApply === true
				? { kind: "always", content: rule.content }
				: rule.description !== undefined && rule.description !== ""
					? { kind: "rulebook" }
					: { kind: "dropped" };
		const origin: ScopedOrigin = { kind: "native", agents: rule.agents, placement };
		if (!defers || placement.kind !== "dropped") placed.add(id);
		const scanned = scoped.get(id);
		if (scanned !== undefined) {
			if (defers) scoped.set(id, { ...scanned, name: rule.name, origin });
			else scoped.delete(id);
			continue;
		}
		if (!defers) continue;
		const raw = readText(rule.path);
		if (raw === null) continue;
		const frontmatter = parseFrontmatter(raw);
		if (frontmatter.kind !== "valid") continue;
		const patterns = parsePaths(frontmatter.fields.paths);
		if (patterns.length === 0 || rule.content.trim() === "") continue;
		const base = nativeBase(rule, cwd);
		if (base === null) {
			unbased.push(rule.path);
			continue;
		}
		scoped.set(id, scopedRule(id, rule.name, rule.content.trim(), patterns, base, origin));
	}
	return { placed, unbased };
}

/** Collects every rule for `cwd`. `unbased` lists native path-scoped rules skipped for lack of a base directory. */
export async function collectRules(cwd: string): Promise<{ readonly catalog: RuleCatalog; readonly unbased: readonly string[] }> {
	const unscoped = new Map<string, UnscopedRule>();
	const scoped = new Map<string, ScopedRule>();
	collectScanned(cwd, unscoped, scoped);
	const { placed, unbased } = await collectNative(cwd, scoped);
	const catalog: RuleCatalog = {
		cwd,
		unscoped: [...unscoped.values()].filter((rule) => !placed.has(rule.id)).sort((a, b) => a.name.localeCompare(b.name)),
		scoped: [...scoped.values()].sort((a, b) => a.name.localeCompare(b.name)),
	};
	return { catalog, unbased };
}

/** Normalised `/`-separated path of `file` relative to `base`, or null when `file` is not inside `base`. */
function relativeInside(base: string, file: string): string | null {
	const rel = path.relative(base, file);
	if (rel === "" || path.isAbsolute(rel)) return null;
	if (rel.split(path.sep)[0] === "..") return null;
	return rel.split(path.sep).join("/");
}

/** Whether a touched absolute file matches the rule, lexically or with both paths resolved through symlinks. */
export function ruleMatches(rule: ScopedRule, file: string): boolean {
	const pairs: Array<readonly [string, string]> = [[rule.base, file]];
	const realBase = realpathOr(rule.base);
	const realFile = realpathOr(file);
	if (realBase !== rule.base || realFile !== file) pairs.push([realBase, realFile]);
	for (const [base, target] of pairs) {
		const rel = relativeInside(base, target);
		if (rel !== null && rule.globs.some((glob) => glob.match(rel))) return true;
	}
	return false;
}
