import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { ruleAppliesToAgent } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { cfgTtsr } from "@oh-my-pi/pi-coding-agent/export/ttsr-settings";
import { createContextDelivery } from "../_shared/context-delivery.ts";
import { errorText } from "../_shared/errors.ts";
import { defineStatefulHarnessHandoff, registerCompactHandoff } from "../_shared/omomp-shared/compact-handoff.ts";
import { createDeltaStream, type Delta } from "../_shared/omomp-shared/context-delta.ts";
import { sessionSettings } from "../_shared/settings.ts";
import { type ContextFileScope, contextFileScope, type DeliveredContextFile, loadContextFiles } from "./context-files.ts";
import {
	collectRules,
	matchTarget,
	normalizeWhitespace,
	type RuleCatalog,
	ruleMatches,
	type ScopedRule,
	type UnscopedRule,
} from "./rules.ts";
import { touchedFiles } from "./touched.ts";

function renderContextFiles(files: readonly DeliveredContextFile[]): string[] {
	if (files.length === 0) return [];
	const parts = [
		"MUST follow these context files for all tasks. Paths are relative to the repository root (`~/` is the home directory). They are already in context: NEVER `grep`/`glob` for `AGENTS.md`, `CLAUDE.md` or similar agent/context files.",
	];
	for (const file of files) parts.push(`<context-file path="${escapeAttr(file.displayPath)}">`, file.content, "</context-file>");
	return [parts.join("\n")];
}

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

function promptBlocks(systemPrompt: readonly string[]): { readonly generic: string | undefined; readonly domain: string | undefined } {
	return { generic: blockInner(systemPrompt, "generic-rules"), domain: blockInner(systemPrompt, "domain-rules") };
}

interface PromptView {
	readonly parts: readonly string[];
	readonly normalized: string;
	readonly blocks: { readonly generic: string | undefined; readonly domain: string | undefined };
}

function promptView(previous: PromptView | undefined, systemPrompt: readonly string[]): PromptView {
	if (
		previous !== undefined &&
		previous.parts.length === systemPrompt.length &&
		previous.parts.every((part, i) => part === systemPrompt[i])
	) {
		return previous;
	}
	return { parts: [...systemPrompt], normalized: normalizeWhitespace(systemPrompt.join("\n")), blocks: promptBlocks(systemPrompt) };
}

function rulebookLine(domain: string, name: string): string | undefined {
	const prefix = `- ${name} (`;
	for (let start = 0; start < domain.length; ) {
		if (domain.startsWith(prefix, start)) {
			const end = domain.indexOf("\n", start);
			return end < 0 ? domain.slice(start) : domain.slice(start, end);
		}
		const next = domain.indexOf("\n", start);
		if (next < 0) return undefined;
		start = next + 1;
	}
	return undefined;
}

function renderUnscoped(rules: readonly UnscopedRule[], prompt: string): string[] {
	let always: UnscopedRule[] | undefined;
	let listed: { readonly rule: UnscopedRule; readonly description: string }[] | undefined;
	for (const rule of rules) {
		switch (rule.kind.kind) {
			case "always":
				if (prompt.includes(rule.kind.normalizedBody)) break;
				if (always === undefined) always = [];
				always.push(rule);
				break;
			case "catalog":
				if (prompt.includes(`rule://${rule.name}`)) break;
				if (listed === undefined) listed = [];
				listed.push({ rule, description: rule.kind.description });
				break;
			default: {
				const exhaustive: never = rule.kind;
				throw new Error(`Unexpected rule kind: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	if (always === undefined && listed === undefined) return [];
	const parts = [
		"Rule files discovered outside OMP's native rule directories; they apply in this session like the rules of the system prompt.",
	];
	for (const rule of always ?? []) {
		parts.push(`<rule path="${escapeAttr(rule.displayPath)}">`, rule.body, "</rule>");
	}
	if (listed !== undefined) {
		parts.push("Read these with the `read` tool when they become relevant:");
		for (const { rule, description } of listed) parts.push(`- ${rule.name}: ${description} — \`${rule.displayPath}\``);
	}
	return [parts.join("\n")];
}

function renderNativeScopes(
	rules: readonly ScopedRule[],
	blocks: { readonly generic: string | undefined; readonly domain: string | undefined },
): string[] {
	const parts: string[] = [];
	for (const rule of rules) {
		if (rule.origin.kind !== "native") continue;
		const placement = rule.origin.placement;
		let original: string | undefined;
		switch (placement.kind) {
			case "always":
				original = blocks.generic?.includes(`${placement.content}\n`) === true ? placement.content : undefined;
				break;
			case "rulebook":
				original = blocks.domain === undefined ? undefined : rulebookLine(blocks.domain, rule.name);
				break;
			case "dropped":
				break;
			default: {
				const exhaustive: never = placement;
				throw new Error(`Unexpected native placement: ${JSON.stringify(exhaustive)}`);
			}
		}
		if (original === undefined) continue;
		parts.push(
			`<rule-scope name="${escapeAttr(rule.name)}" path="${escapeAttr(rule.id)}" paths="${escapeAttr(rule.patterns.join(", "))}">`,
			"<original>",
			original,
			"</original>",
			"</rule-scope>",
		);
	}
	if (parts.length === 0) return [];
	parts.unshift(
		"These passages of the system prompt's `<generic-rules>` and `<domain-rules>` blocks apply only while you work with files their `paths` match; when a tool call touches such a file, the rule arrives after that call:",
	);
	return [parts.join("\n")];
}

function rulesDelta(
	catalog: RuleCatalog,
	files: readonly DeliveredContextFile[],
	scoped: readonly ScopedRule[],
	prompt: PromptView,
): Delta {
	const sections = renderContextFiles(files);
	if (catalog.unscoped.length > 0) sections.push(...renderUnscoped(catalog.unscoped, prompt.normalized));
	if (scoped.some((rule) => rule.origin.kind === "native")) sections.push(...renderNativeScopes(scoped, prompt.blocks));
	return sections.length === 0 ? { kind: "none" } : { kind: "text", body: sections.join("\n\n") };
}

function activeScoped(catalog: RuleCatalog, ctx: ExtensionContext): readonly ScopedRule[] {
	const scoped = catalog.scoped;
	if (!scoped.some((rule) => rule.origin.kind === "native")) return scoped;
	const settings = sessionSettings(ctx);
	const disabled = new Set(settings === undefined ? [] : cfgTtsr.get(settings).disabledRules);
	return scoped.filter((rule) => {
		switch (rule.origin.kind) {
			case "scan":
				return true;
			case "native":
				if (settings === undefined || disabled.has(rule.name)) return false;
				return ruleAppliesToAgent({ agents: rule.origin.agents }, ctx.agent.name);
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

function pathScopedContext(
	rules: RuleCatalog,
	scoped: readonly ScopedRule[],
	event: ToolResultEvent,
	ctx: ExtensionContext,
	claimDeliveries: (ctx: ExtensionContext, markers: readonly string[]) => boolean[],
): string | undefined {
	if (rules.scoped.length === 0) return undefined;
	const files = touchedFiles(event, ctx.cwd);
	if (files.length === 0) return undefined;
	const targets = files.map(matchTarget);
	const matched = scoped.filter((rule) => targets.some((target) => ruleMatches(rule, target)));
	const claims = claimDeliveries(ctx, matched.map(marker));
	const fresh = matched.filter((_, i) => claims[i]);
	return fresh.length === 0 ? undefined : renderRules(fresh, files);
}

export default function repoRules(pi: ExtensionAPI): void {
	let catalog: RuleCatalog | null = null;
	let scope: ContextFileScope | null = null;
	let view: PromptView | undefined;
	const claimDeliveries = createContextDelivery(pi);
	const deltas = createDeltaStream("omp-config/repo-rules");
	registerCompactHandoff(
		pi,
		defineStatefulHarnessHandoff({
			pluginId: "omp-config/repo-rules",
			captureState: () => ({
				scopedCount: catalog?.scoped.length ?? 0,
				unscopedCount: catalog?.unscoped.length ?? 0,
			}),
			renderCompactPromptClaim: () =>
				'Non-root `AGENTS.md`/`CLAUDE.md`, unscoped rule files, and `<path-scoped-rules>` are automatically re-delivered post-compaction by `repo-rules` (`createDeltaStream("repo-rules")` + `createContextDelivery`) — NEVER restate `AGENTS.md`, `CLAUDE.md`, or `<path-scoped-rules>` in the summary.',
			renderPostCompactInjection: () => ({
				source: "repo-rules",
				delivery: "plugin-managed",
			}),
		}),
	);
	pi.on("turn_start", () => {
		deltas.turnStarted();
		view = undefined;
	});

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
		if (event.reason === "revive") return;
		try {
			const [rules, files] = await Promise.all([rulesFor(ctx), contextFilesFor(ctx)]);
			const prompt = promptView(view, event.systemPrompt);
			view = prompt;
			return deltas.atPrompt(ctx, rulesDelta(rules, files, activeScoped(rules, ctx), prompt));
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
		let scoped: readonly ScopedRule[];
		try {
			scoped = activeScoped(rules, ctx);
		} catch (error) {
			pi.logger.warn("repo-rules: cannot deliver rules", { error: errorText(error) });
			return;
		}
		const parts: string[] = [];
		try {
			const prompt = promptView(view, ctx.getSystemPrompt());
			view = prompt;
			const delta = deltas.afterTools(ctx, rulesDelta(rules, files, scoped, prompt));
			if (delta !== undefined) parts.push(delta.additionalContext);
		} catch (error) {
			pi.logger.warn("repo-rules: cannot deliver rules", { error: errorText(error) });
		}
		try {
			const pathScoped = pathScopedContext(rules, scoped, event, ctx, claimDeliveries);
			if (pathScoped !== undefined) parts.push(pathScoped);
		} catch (error) {
			pi.logger.warn("repo-rules: failed to load path-scoped rules", { error: errorText(error) });
		}
		return parts.length === 0 ? undefined : { additionalContext: parts.join("\n\n") };
	});
}
