import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { describeFilter } from "../_shared/session-filter.ts";
import { WATCHDOG_FILE_PATTERN, WATCHDOG_FILTER_KEYS, type WatchdogSpec } from "./spec.ts";

type Toggle = "on" | "off";
type ToggleScope = "session" | "global";

type WatchdogCommand =
	| { readonly kind: "list" }
	| { readonly kind: "toggle"; readonly toggle: Toggle; readonly name: string; readonly scope: ToggleScope }
	| { readonly kind: "add"; readonly requirement: string }
	| { readonly kind: "rm"; readonly name: string }
	| { readonly kind: "edit"; readonly rest: string }
	| { readonly kind: "invalid"; readonly reason: string };

function watchdogUsage(): string {
	return tr(
		"usage: /watchdog [list] | on|off <name> [session|global] | add <requirement> | edit <name> [change] | rm <name>",
		"用法：/watchdog [list] | on|off <name> [session|global] | add <requirement> | edit <name> [change] | rm <name>",
	);
}

function parseWatchdogCommand(args: string): WatchdogCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const sub = (tokens[0] ?? "list").toLowerCase();
	const rest = args.trim().slice(sub.length).trim();
	switch (sub) {
		case "list":
			return tokens.length <= 1 ? { kind: "list" } : { kind: "invalid", reason: watchdogUsage() };
		case "add":
			return rest === ""
				? {
						kind: "invalid",
						reason: tr(
							"usage: /watchdog add <requirement> — describe what the watchdog should catch",
							"用法：/watchdog add <requirement> — 描述 watchdog 应捕获的内容",
						),
					}
				: { kind: "add", requirement: rest };
		case "rm":
			return rest === ""
				? { kind: "invalid", reason: tr("usage: /watchdog rm <name>", "用法：/watchdog rm <name>") }
				: { kind: "rm", name: rest };
		case "edit":
			return rest === ""
				? { kind: "invalid", reason: tr("usage: /watchdog edit <name> [change]", "用法：/watchdog edit <name> [change]") }
				: { kind: "edit", rest };
		case "on":
		case "off": {
			const words = tokens.slice(1);
			const last = words.at(-1)?.toLowerCase();
			const scope: ToggleScope = last === "global" ? "global" : "session";
			const nameTokens = last === "global" || last === "session" ? words.slice(0, -1) : words;
			if (nameTokens.length === 0) return { kind: "invalid", reason: watchdogUsage() };
			return { kind: "toggle", toggle: sub, name: nameTokens.join(" "), scope };
		}
		default:
			return { kind: "invalid", reason: watchdogUsage() };
	}
}

function projectRoot(cwd: string): string {
	const home = homedir();
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir || dir === home) return resolve(cwd);
		dir = parent;
	}
}

type CommandResult = { readonly kind: "info" | "error" | "prompt"; readonly text: string };

type Lookup = { readonly kind: "found"; readonly spec: WatchdogSpec } | { readonly kind: "error"; readonly text: string };

export function touchedWatchdogFiles(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	const raw: string[] = [];
	if ((toolName === "write" || toolName === "edit") && typeof input.path === "string") raw.push(input.path);
	if (toolName === "edit" && typeof input.input === "string" && WATCHDOG_MENTION.test(input.input)) {
		for (const m of input.input.matchAll(EDIT_PATH_PATTERN)) {
			const path = m[1] ?? m[2];
			if (path !== undefined) raw.push(path);
		}
	}
	const files = new Set<string>();
	for (const path of raw) {
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) continue;
		const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
		const absolute = resolve(cwd, expanded);
		if (WATCHDOG_FILE_PATTERN.test(basename(absolute))) files.add(absolute);
	}
	if (more.length === 0) return { kind: "found", spec };
	const paths = [spec, ...more].map((s) => `  ${s.filePath}`).join("\n");
	return {
		kind: "error",
		text: tr(
			`watchdog name "${name}" is ambiguous; give each file a unique \`name:\`:\n${paths}`,
			`watchdog 名称“${name}”有歧义；请为每个文件指定唯一的 \`name:\`：\n${paths}`,
		),
	};
}

function readSpecFile(path: string): { readonly kind: "ok"; readonly text: string } | CommandResult {
	try {
		return { kind: "ok", text: readFileSync(path, "utf8") };
	} catch (error) {
		return { kind: "error", text: tr(`cannot read ${path}: ${errorText(error)}`, `无法读取 ${path}：${errorText(error)}`) };
	}
}

function splitEditTarget(runtime: Runtime, rest: string): { readonly name: string; readonly change: string | null } | null {
	const lower = rest.toLowerCase();
	let best = "";
	for (const spec of runtime.roster) {
		const name = spec.name.toLowerCase();
		if (name.length <= best.length || !lower.startsWith(name)) continue;
		if (lower.length === name.length || /\s/.test(lower[name.length] ?? "")) best = name;
	}
	if (best === "") return null;
	const change = rest.slice(best.length).trim();
	return { name: rest.slice(0, best.length), change: change === "" ? null : change };
}

function draftPrompt(runtime: Runtime, command: Extract<WatchdogCommand, { kind: "add" | "edit" }>, ctx: ExtensionContext): CommandResult {
	const model = defaultReviewerModel(ctx);
	const draft: DraftContext = {
		projectDir: join(projectRoot(cwdOf(runtime)), ".omp"),
		globalDir: import.meta.dir,
		existing: runtime.roster,
		defaultModel: model ? `${model.provider}/${model.id}` : null,
	};
	switch (command.kind) {
		case "add":
			return { kind: "prompt", text: buildAddPrompt(command.requirement, draft) };
		case "edit": {
			const target = splitEditTarget(runtime, command.rest);
			if (target === null) {
				return {
					kind: "error",
					text: tr(
						`no watchdog named at the start of "${command.rest}" (see /watchdog list)`,
						`在“${command.rest}”开头没有 watchdog 名称（参见 /watchdog list）`,
					),
				};
			}
			const found = findByName(runtime, target.name);
			if (found.kind === "error") return found;
			const current = readSpecFile(found.spec.filePath);
			if (current.kind !== "ok") return current;
			return { kind: "prompt", text: buildEditPrompt(found.spec, current.text, target.change, draft) };
		}
		default: {
			const unreachable: never = command;
			return unreachable;
		}
	}
}

${WATCHDOG_INTRO}

Settle the file with the user in chat rounds. ${NO_ASK}

1. Draft. Fill every setting below: take a value from the requirement when it states or clearly implies one, otherwise keep the default. Reply with, in this order:
   - ${EXPECTED_BEHAVIOUR}
   - A settings table with every setting: value, source (\`requirement\` or \`default\`), and a one-line effect, so the user can change any setting by name.
   - The full file content and its absolute path.
   - One closing line asking which settings to change, or for confirmation to write it.
   Write nothing to disk in this round.
2. Revise. When the user names changes, apply them and reply again in the shape of step 1, marking the changed values. A reply that only changes settings is not a confirmation.
3. Write. Only after the user explicitly confirms the latest draft, create the file with \`write\`. Never overwrite an existing file; if the path exists, choose another label and say so. ${WRITE_STATUS} End with one short paragraph on what happens from now on and how to switch it off (\`/watchdog off <name>\` for this session, \`/watchdog off <name> global\` for good).

async function runCommand(runtime: Runtime, command: WatchdogCommand, ctx: ExtensionContext): Promise<CommandResult> {
	refresh(runtime);
	switch (command.kind) {
		case "list":
			return runtime.roster.length === 0
				? { kind: "info", text: tr("no WATCHDOG-*.md files found", "未找到 WATCHDOG-*.md 文件") }
				: { kind: "info", text: runtime.roster.map((spec) => describe(runtime, spec, tr)).join("\n") };
		case "invalid":
			return { kind: "error", text: command.reason };
		case "toggle":
			return toggle(runtime, command);
		case "add":
		case "edit":
			return draftPrompt(runtime, command, ctx);
		case "rm":
			return remove(runtime, command.name, ctx);
		default: {
			const unreachable: never = command;
			return unreachable;
		}
	}
}

type Completion = { readonly value: string; readonly label: string; readonly description: string };

function subcommandCompletions(): Completion[] {
	return [
		{ value: "list", label: tr("list", "列表"), description: tr("all watchdog files and their state", "所有 watchdog 文件及其状态") },
		{ value: "on ", label: tr("on", "开启"), description: tr("switch a watchdog on", "开启 watchdog") },
		{ value: "off ", label: tr("off", "关闭"), description: tr("switch a watchdog off", "关闭 watchdog") },
		{
			value: "add ",
			label: tr("add", "添加"),
			description: tr("draft a new watchdog with the model from a requirement", "根据需求让模型起草新的 watchdog"),
		},
		{ value: "edit ", label: tr("edit", "编辑"), description: tr("revise a watchdog with the model", "让模型修改 watchdog") },
		{ value: "rm ", label: tr("rm", "删除"), description: tr("delete a watchdog file (asks first)", "删除 watchdog 文件（先询问）") },
	];
}

function toggleCompletions(runtime: Runtime, spec: WatchdogSpec, sub: Toggle, lower: string): Completion[] {
	const targeted = targetsHere(runtime, spec);
	const now = !targeted
		? tr("not for this session", "不适用于本会话")
		: effectiveEnabled(runtime, spec)
			? tr("now ON", "当前开启")
			: tr("now OFF", "当前关闭");
	const scopes: readonly ToggleScope[] = targeted ? ["session", "global"] : ["global"];
	const items: Completion[] = [];
	for (const scope of scopes) {
		const value = `${sub} ${spec.name} ${scope}`;
		if (!value.toLowerCase().startsWith(lower)) continue;
		const where =
			scope === "session"
				? tr("this session only", "仅本会话")
				: tr(`writes enabled: ${sub === "on"} to the file`, `向文件写入 enabled: ${sub === "on"}`);
		items.push({
			value,
			label: `${spec.name} ${scope === "session" ? tr("session", "会话") : tr("global", "全局")}`,
			description: `${where} · ${now}`,
		});
	}
	return items;
}

function completions(runtime: Runtime, prefix: string): Completion[] | null {
	const lower = prefix.toLowerCase();
	if (!/\s/.test(prefix)) return subcommandCompletions().filter((s) => s.value.startsWith(lower));
	const sub = lower.split(/\s+/)[0];
	if (sub !== "on" && sub !== "off" && sub !== "edit" && sub !== "rm") return null;
	refresh(runtime);
	const items: Completion[] = [];
	const seen = new Set<string>();
	for (const spec of runtime.roster) {
		const key = spec.name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		switch (sub) {
			case "on":
			case "off":
				items.push(...toggleCompletions(runtime, spec, sub, lower));
				break;
			case "edit":
			case "rm": {
				const value = sub === "edit" ? `edit ${spec.name} ` : `rm ${spec.name}`;
				if (value.toLowerCase().startsWith(lower)) items.push({ value, label: spec.name, description: spec.filePath });
				break;
			}
			default: {
				const unreachable: never = sub;
				return unreachable;
			}
		}
	}
	return items;
}

function report(pi: ExtensionAPI, ctx: ExtensionContext, command: WatchdogCommand, result: CommandResult): void {
	switch (result.kind) {
		case "prompt":
			pi.sendUserMessage(result.text, ctx.isIdle() ? { attribution: "agent" } : { deliverAs: "followUp", attribution: "agent" });
			return;
		case "info":
		case "error":
			if (command.kind === "toggle" || command.kind === "rm") pi.logger.info(`watchdog command: ${result.text}`);
			ctx.ui.notify(result.text, result.kind);
			return;
		default: {
			const unreachable: never = result.kind;
			throw new Error(`unknown command result ${String(unreachable)}`);
		}
	}
}

export function registerCommand(runtime: Runtime): void {
	runtime.pi.registerCommand("watchdog", {
		description: tr(
			"List, add, edit, remove or switch watchdogs: /watchdog [list] | add <requirement> | edit <name> [change] | rm <name> | on|off <name> [session|global]",
			"列出、添加、编辑、删除或切换 watchdog：/watchdog [list] | add <requirement> | edit <name> [change] | rm <name> | on|off <name> [session|global]",
		),
		getArgumentCompletions: (prefix) => {
			try {
				return completions(runtime, prefix);
			} catch (error) {
				runtime.pi.logger.warn("watchdog completions failed", { error: errorText(error) });
				return null;
			}
		},
		handler: async (args, ctx) => {
			try {
				const session = ensureActive(runtime, ctx);
				const command = parseWatchdogCommand(args);
				const result = await runCommand(runtime, command, ctx);
				report(runtime.pi, ctx, command, result);
				if (session && (command.kind === "toggle" || command.kind === "rm")) logActive(runtime, session);
			} catch (error) {
				runtime.pi.logger.warn("watchdog command failed", { error: errorText(error) });
			}
		},
	});
}
