/**
 * repo-rules: deliver the working directory's AGENTS.md / CLAUDE.md, load the rule files OMP's
 * native discovery skips, and give every rule source Claude Code's path-specific rules. The system
 * prompt stays as OMP built it; what this extension adds reaches the model as messages.
 *
 * Context files. `config.yml` disables OMP's `agents-md` and `claude-md` providers, which render
 * AGENTS.md / CLAUDE.md into the system prompt under their absolute paths, so the prompt changed
 * whenever the session moved into a worktree. This extension delivers the same files: the
 * providers' walk from the cwd up to the repository root (past it to below the home directory
 * when the repository sits under home), one file per directory with AGENTS.md before CLAUDE.md,
 * none in a directory where a context file OMP still loads (`.omp`, `.claude`, `.agents`, …)
 * takes the slot, `@path` imports expanded, farthest from the cwd first. Each is written with its
 * path relative to the repository root, `~/…` under the home directory, absolute otherwise, so a
 * checkout and its worktrees produce the same bytes. Subagents (`ctx.agent.kind` `sub`) skip
 * AGENTS.md as OMP's task subagents do. Files are re-read at every delivery point; the occupied
 * slots are collected per cwd.
 *
 * Unscoped rules. OMP loads `.omp/rules`, `.agent(s)/rules`, `.cursor/rules`, `.windsurf/rules`,
 * `.clinerules` and `.github/instructions`, but not `.claude/rules` or `.pi/rules`, and drops a rule
 * file that has neither `alwaysApply` nor `description`. This extension scans `.claude/rules`,
 * `.agents/rules` and `.pi/rules` from the cwd up to the repository root (the cwd alone outside a
 * repository) plus the user-level `~/.claude/rules` in every session: a file without frontmatter,
 * with frontmatter that does not parse, or with `alwaysApply: true` contributes its body; other
 * frontmatter files are listed by name, `description` and path. A file OMP already places itself
 * (alwaysApply, rulebook entry or TTSR) is skipped, as is a body already in OMP's system prompt and
 * a listing whose `rule://<name>` that prompt already has.
 *
 * Path-scoped rules. A rule whose frontmatter has Claude Code's `paths` (a YAML list or a
 * comma-separated string of globs) is loaded only when a file it matches is touched: a successful
 * `read`, `write` or `edit`, or a `bash` command that is a plain `cat`/`head`/`tail` of one file.
 * Sources are the scanned files above and every rule OMP discovers (`loadCapability`): project and
 * user `.omp`/`.agents` rules, cursor/windsurf/cline/GitHub rules, and plugin and extension-root
 * `rules/` directories (such as `~/.claude` listed in `config.yml` `extensions`). OMP itself ignores
 * `paths`, so a native rule that has it is taken over: its alwaysApply body in the `<generic-rules>`
 * block or its rulebook line in the `<domain-rules>` block stays in the system prompt, the delta
 * below quotes it as limited to its `paths`, and it still obeys `ttsr.disabledRules` and its
 * `agents` scope. TTSR rules (`condition`, `astCondition`, `question`) and OMP's bundled rules keep
 * OMP's own triggering. Patterns are relative to the cwd for user-level rules, to the directory
 * holding the rule's dot directory (`.claude`, `.omp`, …) for project rules, and to the plugin or
 * extension root for rules in its `rules/`. A pattern starting with `/` or `~/` matches the absolute
 * path instead (beyond Claude Code, which never matches such a pattern).
 *
 * Delta. One delta of `_shared/context-delta.ts` with source `omp-config/repo-rules`, computed from
 * OMP's system prompt (`event.systemPrompt` at a prompt, `ctx.getSystemPrompt()` after a tool call)
 * and the collected files: the context files, then the unscoped rule bodies and listings above,
 * then each taken-over native rule found in that prompt, quoted with its `paths`. It is delivered at every `before_agent_start`
 * (except a revive's, whose result OMP discards) and after every tool call, only when it differs
 * from the source's effective delta in the current context; with nothing to add it supersedes an
 * earlier one with a retraction.
 *
 * Path-scoped delivery. A matching rule is delivered as the `tool_result` `additionalContext` (a
 * developer message after the tool batch, after the delta when both are due), once per context: a
 * rule whose marker is already in the session's current model context (the host's active-leaf
 * projection, so compaction, resume and branch moves are honoured) or that an earlier call of the
 * same turn delivered is not repeated.
 *
 * Registers `session_start`, `before_agent_start`, `turn_start` and `tool_result` for main and sub
 * sessions. Reads context and rule files only; writes no files. Rules are collected per cwd and
 * re-collected when the session cwd changes. Missing or unreadable files are skipped; unexpected
 * hook failures are logged as warnings without interrupting the session.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { ruleAppliesToAgent } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { cfgTtsr } from "@oh-my-pi/pi-coding-agent/export/ttsr-settings";
import { createContextDelivery } from "../_shared/context-delivery.ts";
import { createDeltaStream, type Delta } from "../_shared/context-delta.ts";
import { errorText } from "../_shared/errors.ts";
import { sessionSettings } from "../_shared/settings.ts";
import { type ContextFileScope, contextFileScope, type DeliveredContextFile, loadContextFiles } from "./context-files.ts";
import { collectRules, type RuleCatalog, ruleMatches, type ScopedRule, type UnscopedRule } from "./rules.ts";
import { touchedFiles } from "./touched.ts";

/** The working directory's AGENTS.md / CLAUDE.md, in place of OMP's `<repo-rules>` block of the system prompt. */
function renderContextFiles(files: readonly DeliveredContextFile[]): string[] {
	if (files.length === 0) return [];
	const parts = [
		"MUST follow these context files for all tasks. Paths are relative to the repository root (`~/` is the home directory). They are already in context: NEVER `grep`/`glob` for `AGENTS.md`, `CLAUDE.md` or similar agent/context files.",
	];
	for (const file of files) parts.push(`<context-file path="${escapeAttr(file.displayPath)}">`, file.content, "</context-file>");
	return [parts.join("\n")];
}

/** Inner text of the first `<tag>\n…</tag>` block among the parts of OMP's system prompt. */
function blockInner(systemPrompt: readonly string[], tag: string): string | undefined {
	const open = `<${tag}>\n`;
	const close = `</${tag}>`;
	for (const part of systemPrompt) {
		const start = part.indexOf(open);
		if (start === -1) continue;
		const end = part.indexOf(close, start);
		if (end !== -1) return part.slice(start + open.length, end);
	}
	return undefined;
}

/** Scanned rules the system prompt does not hold yet: bodies to follow, and a catalog to read on demand. */
function renderUnscoped(rules: readonly UnscopedRule[], systemPrompt: readonly string[]): string[] {
	const prompt = systemPrompt.join("\n").replace(/\s+/g, " ").trim();
	const always: UnscopedRule[] = [];
	const listed: { readonly rule: UnscopedRule; readonly description: string }[] = [];
	for (const rule of rules) {
		switch (rule.kind.kind) {
			case "always":
				if (!prompt.includes(rule.body.replace(/\s+/g, " ").trim())) always.push(rule);
				break;
			case "catalog":
				if (!prompt.includes(`rule://${rule.name}`)) listed.push({ rule, description: rule.kind.description });
				break;
			default: {
				const exhaustive: never = rule.kind;
				throw new Error(`Unexpected rule kind: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	if (always.length === 0 && listed.length === 0) return [];
	const parts = [
		"Rule files discovered outside OMP's native rule directories; they apply in this session like the rules of the system prompt.",
	];
	for (const rule of always) {
		parts.push(`<rule path="${escapeAttr(rule.displayPath)}">`, rule.body, "</rule>");
	}
	if (listed.length > 0) {
		parts.push("Read these with the `read` tool when they become relevant:");
		for (const { rule, description } of listed) parts.push(`- ${rule.name}: ${description} — \`${rule.displayPath}\``);
	}
	return [parts.join("\n")];
}

/**
 * Native path-scoped rules as OMP placed them, per SYSTEM_TEMPLATE.md: the alwaysApply body
 * (`{{content}}` plus a newline) in `<generic-rules>`, or the rulebook line
 * (`- <name> (<globs>): <description>`) in `<domain-rules>`. Each one found is quoted with the paths
 * it is limited to.
 */
function renderNativeScopes(rules: readonly ScopedRule[], systemPrompt: readonly string[]): string[] {
	const generic = blockInner(systemPrompt, "generic-rules");
	const domain = blockInner(systemPrompt, "domain-rules")?.split("\n");
	const scopes: string[] = [];
	for (const rule of rules) {
		if (rule.origin.kind !== "native") continue;
		const placement = rule.origin.placement;
		let original: string | undefined;
		switch (placement.kind) {
			case "always":
				original = generic?.includes(`${placement.content}\n`) === true ? placement.content : undefined;
				break;
			case "rulebook":
				original = domain?.find((line) => line.startsWith(`- ${rule.name} (`));
				break;
			case "dropped":
				break;
			default: {
				const exhaustive: never = placement;
				throw new Error(`Unexpected native placement: ${JSON.stringify(exhaustive)}`);
			}
		}
		if (original === undefined) continue;
		scopes.push(
			`<rule-scope name="${escapeAttr(rule.name)}" path="${escapeAttr(rule.id)}" paths="${escapeAttr(rule.patterns.join(", "))}">`,
			"<original>",
			original,
			"</original>",
			"</rule-scope>",
		);
	}
	if (scopes.length === 0) return [];
	return [
		[
			"These passages of the system prompt's `<generic-rules>` and `<domain-rules>` blocks apply only while you work with files their `paths` match; when a tool call touches such a file, the rule arrives after that call:",
			...scopes,
		].join("\n"),
	];
}

/** What this extension adds to `systemPrompt`, OMP's base prompt as handed to the hook. */
function rulesDelta(
	catalog: RuleCatalog,
	files: readonly DeliveredContextFile[],
	ctx: ExtensionContext,
	systemPrompt: readonly string[],
): Delta {
	const sections = [
		...renderContextFiles(files),
		...renderUnscoped(catalog.unscoped, systemPrompt),
		...renderNativeScopes(activeScoped(catalog, ctx), systemPrompt),
	];
	return sections.length === 0 ? { kind: "none" } : { kind: "text", body: sections.join("\n\n") };
}

/** Path-scoped rules that apply to this session's agent; native rules need the session's settings. */
function activeScoped(catalog: RuleCatalog, ctx: ExtensionContext): ScopedRule[] {
	const settings = sessionSettings(ctx);
	const disabled = new Set(settings === undefined ? [] : cfgTtsr.get(settings).disabledRules);
	return catalog.scoped.filter((rule) => {
		switch (rule.origin.kind) {
			case "scan":
				return true;
			case "native":
				if (settings === undefined || disabled.has(rule.name)) return false;
				return ruleAppliesToAgent({ agents: rule.origin.agents === undefined ? undefined : [...rule.origin.agents] }, ctx.agent.name);
			default: {
				const exhaustive: never = rule.origin;
				throw new Error(`Unexpected rule origin: ${JSON.stringify(exhaustive)}`);
			}
		}
	});
}

function escapeAttr(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Text that identifies a delivered rule in the context; followed by the `paths` attribute. */
function marker(rule: ScopedRule): string {
	return `<path-scoped-rule path="${escapeAttr(rule.id)}" `;
}

function renderRules(rules: readonly ScopedRule[], files: readonly string[]): string {
	const parts = [
		"<path-scoped-rules>",
		`Rules whose \`paths\` match a file this call touched (${files.join(", ")}). Follow them whenever you work with files they match.`,
	];
	for (const rule of rules) {
		parts.push(`${marker(rule)}paths="${escapeAttr(rule.patterns.join(", "))}">`, rule.body, "</path-scoped-rule>");
	}
	parts.push("</path-scoped-rules>");
	return parts.join("\n");
}

/** The `paths` rules a tool call's touched files bring in that the context does not hold yet. */
function pathScopedContext(
	rules: RuleCatalog,
	event: ToolResultEvent,
	ctx: ExtensionContext,
	claimDeliveries: (ctx: ExtensionContext, markers: readonly string[]) => boolean[],
): string | undefined {
	if (rules.scoped.length === 0) return undefined;
	const files = touchedFiles(event, ctx.cwd);
	if (files.length === 0) return undefined;
	const matched = activeScoped(rules, ctx).filter((rule) => files.some((file) => ruleMatches(rule, file)));
	const claims = claimDeliveries(ctx, matched.map(marker));
	const fresh = matched.filter((_, i) => claims[i]);
	return fresh.length === 0 ? undefined : renderRules(fresh, files);
}

export default function repoRules(pi: ExtensionAPI): void {
	let catalog: RuleCatalog | null = null;
	let scope: ContextFileScope | null = null;
	const claimDeliveries = createContextDelivery(pi);
	const deltas = createDeltaStream(pi, "repo-rules");

	/** Context files read fresh at each delivery point; the depth slots OMP keeps are collected once per cwd. */
	const contextFilesFor = async (ctx: ExtensionContext): Promise<DeliveredContextFile[]> => {
		if (scope?.cwd !== path.resolve(ctx.cwd)) scope = await contextFileScope(ctx.cwd);
		return await loadContextFiles(scope, ctx.agent.kind);
	};

	const rulesFor = async (ctx: ExtensionContext): Promise<RuleCatalog> => {
		if (catalog?.cwd === ctx.cwd) return catalog;
		const collected = await collectRules(ctx.cwd);
		catalog = collected.catalog;
		const { unscoped, scoped } = collected.catalog;
		if (unscoped.length + scoped.length > 0) {
			pi.logger.info(`repo-rules: ${unscoped.length} unscoped and ${scoped.length} path-scoped rule file(s) for ${ctx.cwd}`);
		}
		if (collected.unbased.length > 0) {
			pi.logger.warn("repo-rules: path-scoped rules without a base directory are not loaded", { files: collected.unbased });
		}
		return collected.catalog;
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			await rulesFor(ctx);
		} catch (error) {
			pi.logger.warn("repo-rules: failed to collect rules", { error: errorText(error) });
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// OMP discards the result of a revive.
		if (event.reason === "revive") return;
		try {
			const [rules, files] = await Promise.all([rulesFor(ctx), contextFilesFor(ctx)]);
			return deltas.atPrompt(ctx, rulesDelta(rules, files, ctx, event.systemPrompt));
		} catch (error) {
			pi.logger.warn("repo-rules: cannot deliver rules", { error: errorText(error) });
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		let rules: RuleCatalog;
		let files: DeliveredContextFile[];
		try {
			[rules, files] = await Promise.all([rulesFor(ctx), contextFilesFor(ctx)]);
		} catch (error) {
			pi.logger.warn("repo-rules: failed to collect rules", { error: errorText(error) });
			return;
		}
		const parts: string[] = [];
		try {
			const delta = deltas.afterTools(ctx, rulesDelta(rules, files, ctx, ctx.getSystemPrompt()));
			if (delta !== undefined) parts.push(delta.additionalContext);
		} catch (error) {
			pi.logger.warn("repo-rules: cannot deliver rules", { error: errorText(error) });
		}
		try {
			const scoped = pathScopedContext(rules, event, ctx, claimDeliveries);
			if (scoped !== undefined) parts.push(scoped);
		} catch (error) {
			pi.logger.warn("repo-rules: failed to load path-scoped rules", { error: errorText(error) });
		}
		return parts.length === 0 ? undefined : { additionalContext: parts.join("\n\n") };
	});
}
