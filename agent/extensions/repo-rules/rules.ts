import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";

const PROJECT_RULE_DIRS = [".claude/rules", ".agents/rules", ".pi/rules"] as const;
const USER_RULE_DIR = path.join(os.homedir(), ".claude", "rules");

type UnscopedKind =
	| { readonly kind: "always"; readonly normalizedBody: string }
	| { readonly kind: "catalog"; readonly description: string };

export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export interface UnscopedRule {
	readonly id: string;
	readonly name: string;
	readonly displayPath: string;
	readonly body: string;
	readonly kind: UnscopedKind;
}

type NativePlacement = { readonly kind: "always"; readonly content: string } | { readonly kind: "rulebook" } | { readonly kind: "dropped" };

type ScopedOrigin =
	| { readonly kind: "scan" }
	| { readonly kind: "native"; readonly agents: string[] | undefined; readonly placement: NativePlacement };

type PathGlob = { readonly kind: "relative"; readonly glob: Bun.Glob } | { readonly kind: "absolute"; readonly glob: Bun.Glob };

export interface ScopedRule {
	readonly id: string;
	readonly name: string;
	readonly body: string;
	readonly patterns: readonly string[];
	readonly globs: readonly PathGlob[];
	readonly base: string;
	readonly realBase: string;
	readonly origin: ScopedOrigin;
}

export interface RuleCatalog {
	readonly cwd: string;
	readonly unscoped: readonly UnscopedRule[];
	readonly scoped: readonly ScopedRule[];
}

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

function parseFrontmatter(raw: string): Frontmatter {
	const text = raw.replace(/^\uFEFF/, "").trimStart();
	const match = FRONTMATTER.exec(text);
	if (match === null) return { kind: "absent", body: text.trim() };
	const body = text.slice(match[0].length).trim();
	let fields: unknown;
	try {
		fields = Bun.YAML.parse(match[1] ?? "");
	} catch {
		return { kind: "invalid", body };
	}
	if (fields === null || fields === undefined) return { kind: "valid", body, fields: {} };
	const parsed = fieldsSchema.safeParse(fields);
	return parsed.success ? { kind: "valid", body, fields: parsed.data } : { kind: "invalid", body };
}

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
	readonly base: string;
}

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

function markdownFiles(dir: string, visited = new Set<string>()): string[] {
	let realDir: string;
	try {
		realDir = fs.realpathSync(dir);
	} catch {
		return [];
	}
	if (visited.has(realDir)) return [];
	visited.add(realDir);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
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
				continue;
			}
		}
		if (isDirectory) out = out.concat(markdownFiles(full, visited));
		else if (isFile && (entry.name.endsWith(".md") || entry.name.endsWith(".mdc"))) out.push(full);
	}
	return out.sort((a, b) => a.localeCompare(b));
}

function readText(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

function compilePattern(pattern: string): PathGlob {
	if (pattern.startsWith("~/"))
		return { kind: "absolute", glob: new Bun.Glob(path.posix.join(os.homedir().split(path.sep).join("/"), pattern.slice(2))) };
	if (path.isAbsolute(pattern)) return { kind: "absolute", glob: new Bun.Glob(pattern.split(path.sep).join("/")) };
	return { kind: "relative", glob: new Bun.Glob(pattern) };
}

function scopedRule(id: string, name: string, body: string, patterns: string[], base: string, origin: ScopedOrigin): ScopedRule {
	return { id, name, body, patterns, globs: patterns.map(compilePattern), base, realBase: realpathOr(base), origin };
}

function classifyScanned(frontmatter: Frontmatter): { readonly kind: "scoped"; readonly patterns: string[] } | UnscopedKind {
	switch (frontmatter.kind) {
		case "absent":
		case "invalid":
			return { kind: "always", normalizedBody: normalizeWhitespace(frontmatter.body) };
		case "valid": {
			const patterns = parsePaths(frontmatter.fields.paths);
			if (patterns.length > 0) return { kind: "scoped", patterns };
			const always = frontmatter.fields.alwaysApply;
			if (always === true || always === "true") return { kind: "always", normalizedBody: normalizeWhitespace(frontmatter.body) };
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

function nativeDefersToPaths(rule: Rule): boolean {
	if (rule._source.provider === BUILTIN_DEFAULTS_PROVIDER_ID) return false;
	return !((rule.condition?.length ?? 0) > 0 || (rule.astCondition?.length ?? 0) > 0 || rule.question !== undefined);
}

interface NativeCollection {
	readonly placed: ReadonlySet<string>;
	readonly unbased: readonly string[];
}

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

function relativeInside(base: string, file: string): string | null {
	const rel = path.relative(base, file);
	if (rel === "" || path.isAbsolute(rel)) return null;
	if (rel.split(path.sep)[0] === "..") return null;
	return rel.split(path.sep).join("/");
}

export interface MatchTarget {
	readonly file: string;
	readonly real: string;
}

export function matchTarget(file: string): MatchTarget {
	return { file, real: realpathOr(file) };
}

export function ruleMatches(rule: ScopedRule, target: MatchTarget): boolean {
	if (matchesInside(rule, rule.base, target.file)) return true;
	if (rule.realBase === rule.base && target.real === target.file) return false;
	return matchesInside(rule, rule.realBase, target.real);
}

function matchesInside(rule: ScopedRule, base: string, target: string): boolean {
	let relative: string | null = null;
	let relativeKnown = false;
	let absolute: string | undefined;
	for (const { kind, glob } of rule.globs) {
		switch (kind) {
			case "relative":
				if (!relativeKnown) {
					relative = relativeInside(base, target);
					relativeKnown = true;
				}
				if (relative !== null && glob.match(relative)) return true;
				break;
			case "absolute":
				absolute ??= target.split(path.sep).join("/");
				if (glob.match(absolute)) return true;
				break;
			default: {
				const exhaustive: never = kind;
				throw new Error(`Unexpected pattern kind: ${String(exhaustive)}`);
			}
		}
	}
	return false;
}
