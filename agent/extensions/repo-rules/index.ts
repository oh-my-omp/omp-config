/**
 * repo-rules: load the rule files OMP's native discovery skips, and give every rule source Claude
 * Code's path-specific rules.
 *
 * Unscoped rules. OMP loads `.omp/rules`, `.agent(s)/rules`, `.cursor/rules`, `.windsurf/rules`,
 * `.clinerules` and `.github/instructions`, but not `.claude/rules` or `.pi/rules`, and drops a rule
 * file that has neither `alwaysApply` nor `description`. This extension scans `.claude/rules`,
 * `.agents/rules` and `.pi/rules` from the cwd up to the repository root (the cwd alone outside a
 * repository) plus the user-level `~/.claude/rules` in every session, and appends what it finds to
 * the system prompt on every `before_agent_start`: a file without frontmatter, with frontmatter
 * that does not parse, or with `alwaysApply: true` injects its body; other frontmatter files are
 * listed by name, `description` and path. A file OMP already places itself (alwaysApply, rulebook
 * entry or TTSR) is skipped, as is a body already in the incoming prompt and a listing whose
 * `rule://<name>` the prompt already has.
 *
 * Path-scoped rules. A rule whose frontmatter has Claude Code's `paths` (a YAML list or a
 * comma-separated string of globs) is loaded only when a file it matches is touched: a successful
 * `read`, `write` or `edit`, or a `bash` command that is a plain `cat`/`head`/`tail` of one file.
 * Sources are the scanned files above and every rule OMP discovers (`loadCapability`): project and
 * user `.omp`/`.agents` rules, cursor/windsurf/cline/GitHub rules, and plugin and extension-root
 * `rules/` directories (such as `~/.claude` listed in `config.yml` `extensions`). OMP itself ignores
 * `paths`, so a native rule that has it is taken over: its alwaysApply body is removed from the
 * `<generic-rules>` block or its rulebook line from the `<domain-rules>` block of the system prompt,
 * and it still obeys `ttsr.disabledRules` and its `agents` scope. TTSR rules (`condition`,
 * `astCondition`, `question`) and OMP's bundled rules keep OMP's own triggering. Patterns are
 * relative to the cwd for user-level rules, to the directory holding the rule's dot directory
 * (`.claude`, `.omp`, …) for project rules, and to the plugin or extension root for rules in its
 * `rules/`. A pattern starting with `/` or `~/` matches the absolute path instead (beyond Claude
 * Code, which never matches such a pattern).
 *
 * A matching rule is delivered as the `tool_result` `additionalContext` (a developer message after
 * the tool batch), once per context: a rule whose marker is already in the session's current context
 * (`buildSessionContext`, so compaction, resume and branch moves are honoured) or that an earlier call
 * of the same turn delivered is not repeated.
 *
 * Registers `session_start`, `before_agent_start`, `turn_start` and `tool_result` for main and sub
 * sessions. Reads rule files only; writes no files. Rules are collected per cwd and re-collected
 * when the session cwd changes. Missing or unreadable rule files are skipped; unexpected hook
 * failures are logged as warnings without interrupting the session.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ruleAppliesToAgent } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { cfgTtsr } from "@oh-my-pi/pi-coding-agent/export/ttsr-settings";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { errorText } from "../_shared/errors.ts";
import { textOf } from "../_shared/messages.ts";
import { sessionSettings } from "../_shared/settings.ts";
import { collectRules, type RuleCatalog, ruleMatches, type ScopedRule, type UnscopedRule } from "./rules.ts";
import { touchedFiles } from "./touched.ts";

function buildSection(rules: readonly UnscopedRule[], systemPrompt: readonly string[]): string {
	const prompt = systemPrompt.join("\n").replace(/\s+/g, " ").trim();
	const always: UnscopedRule[] = [];
	const catalog: UnscopedRule[] = [];
	for (const rule of rules) {
		switch (rule.kind.kind) {
			case "always":
				if (prompt.includes(rule.body.replace(/\s+/g, " ").trim())) continue; // already injected natively
				always.push(rule);
				break;
			case "catalog":
				if (!prompt.includes(`rule://${rule.name}`)) catalog.push(rule);
				break;
			default: {
				const exhaustive: never = rule.kind;
				throw new Error(`Unexpected rule kind: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	if (always.length === 0 && catalog.length === 0) return "";

	const parts = ["<repo-level-rules>", "Rule files discovered outside OMP's native rule directories."];
	for (const rule of always) {
		parts.push(`<rule path="${rule.displayPath}">`, rule.body, "</rule>");
	}
	if (catalog.length > 0) {
		parts.push("Read these with the `read` tool when they become relevant:");
		for (const rule of catalog) {
			const description = rule.kind.kind === "catalog" ? rule.kind.description : "";
			parts.push(`- ${rule.name}: ${description} — \`${rule.displayPath}\``);
		}
	}
	parts.push("</repo-level-rules>");
	return parts.join("\n");
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

/** Rewrites the inner text of the first `<tag>\n…</tag>` block of `part`; a block left blank is removed. */
function rewriteBlock(part: string, tag: string, rewrite: (inner: string) => string): string {
	const open = `<${tag}>\n`;
	const close = `</${tag}>`;
	const start = part.indexOf(open);
	if (start === -1) return part;
	const end = part.indexOf(close, start);
	if (end === -1) return part;
	const inner = part.slice(start + open.length, end);
	const next = rewrite(inner);
	if (next === inner) return part;
	if (next.trim() === "") return part.slice(0, start) + part.slice(end + close.length).replace(/^\n/, "");
	return part.slice(0, start) + open + next + part.slice(end);
}

/**
 * Removes native path-scoped rules from where OMP put them, as SYSTEM_TEMPLATE.md renders it: the
 * rulebook line (`- <name> (<globs>): <description>`) in `<domain-rules>`, and the alwaysApply body
 * (`{{content}}` plus a newline) in `<generic-rules>`. A block left empty is removed.
 */
function removeNativePlacements(prompt: readonly string[], rules: readonly ScopedRule[]): string[] | null {
	const names: string[] = [];
	const contents: string[] = [];
	for (const rule of rules) {
		if (rule.origin.kind !== "native") continue;
		const placement = rule.origin.placement;
		switch (placement.kind) {
			case "rulebook":
				names.push(rule.name);
				break;
			case "always":
				contents.push(placement.content);
				break;
			case "dropped":
				break;
			default: {
				const exhaustive: never = placement;
				throw new Error(`Unexpected native placement: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	if (names.length === 0 && contents.length === 0) return null;
	const listed = (line: string): boolean => names.some((name) => line.startsWith(`- ${name} (`));
	const out = prompt.map((part) => {
		const withoutRulebook = rewriteBlock(part, "domain-rules", (inner) =>
			inner
				.split("\n")
				.filter((line) => !listed(line))
				.join("\n"),
		);
		return rewriteBlock(withoutRulebook, "generic-rules", (inner) =>
			contents.reduce((text, content) => text.replace(`${content}\n`, ""), inner),
		);
	});
	return out.some((part, index) => part !== prompt[index]) ? out : null;
}

function escapeAttr(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Text that identifies a delivered rule in the context; followed by the `paths` attribute. */
function marker(rule: ScopedRule): string {
	return `<path-scoped-rule path="${escapeAttr(rule.id)}" `;
}

/** Developer-message text of the messages OMP would send to the model now. */
function contextDeveloperText(ctx: ExtensionContext): string {
	const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	const texts: string[] = [];
	for (const message of messages) {
		if ("role" in message && message.role === "developer") texts.push(textOf(message.content, "\n"));
	}
	return texts.join("\n");
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

export default function repoRules(pi: ExtensionAPI): void {
	let catalog: RuleCatalog | null = null;
	/** Rules delivered by earlier calls of the current turn, before their developer message is persisted. */
	const deliveredThisTurn = new Set<string>();

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
		try {
			const rules = await rulesFor(ctx);
			const prompt = removeNativePlacements(event.systemPrompt, activeScoped(rules, ctx)) ?? event.systemPrompt;
			const section = buildSection(rules.unscoped, prompt);
			if (section === "" && prompt === event.systemPrompt) return;
			return { systemPrompt: section === "" ? prompt : [...prompt, section] };
		} catch (error) {
			pi.logger.warn("repo-rules: failed to inject rules", { error: errorText(error) });
		}
	});

	pi.on("turn_start", () => {
		deliveredThisTurn.clear();
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			const rules = await rulesFor(ctx);
			if (rules.scoped.length === 0) return;
			const files = touchedFiles(event, ctx.cwd);
			if (files.length === 0) return;
			const matched = activeScoped(rules, ctx).filter(
				(rule) => !deliveredThisTurn.has(rule.id) && files.some((file) => ruleMatches(rule, file)),
			);
			if (matched.length === 0) return;
			const delivered = contextDeveloperText(ctx);
			const fresh = matched.filter((rule) => !delivered.includes(marker(rule)));
			if (fresh.length === 0) return;
			for (const rule of fresh) deliveredThisTurn.add(rule.id);
			return { additionalContext: renderRules(fresh, files) };
		} catch (error) {
			pi.logger.warn("repo-rules: failed to load path-scoped rules", { error: errorText(error) });
		}
	});
}
