import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgStartupChangelogMode, cfgStartupQuiet } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { type JSXNode, jsx } from "@oh-my-pi/pi-tui";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { isDated, parseReleases } from "./changelog.ts";
import { digestOf, type Entry, entriesOf, groupDays, parseView } from "./days.ts";
import { readMarker, type Seen, sameMarker, writeMarker } from "./marker.ts";
import { discoverMembers, type Member } from "./members.ts";
import { daysMarkdown, headerLine, summaryLines } from "./render.ts";
import { type ChangelogLoad, classify, type Layout, policyOf, settle, type Upgrade } from "./settle.ts";

const WIDGET_KEY = "omomp-changelog";
const MESSAGE_TYPE = "omomp-changelog";

type StartDisplay = { readonly layout: Layout; readonly upgrades: readonly Upgrade[] };

function loadChangelog(member: Member): ChangelogLoad {
	let content: string;
	try {
		content = readFileSync(member.changelogPath, "utf8");
	} catch (error) {
		return { kind: "failed", reason: `${member.changelogPath}: ${errorText(error)}` };
	}
	return { kind: "ok", releases: parseReleases(content) };
}

function widgetBody(layout: Layout, upgrades: readonly Upgrade[]): JSXNode {
	switch (layout) {
		case "summary":
			return jsx("text", { text: summaryLines(digestOf(upgrades)).join("\n"), wrap: "word" });
		case "expanded":
			return jsx("md", { text: daysMarkdown(groupDays(entriesOf(upgrades))) });
		default: {
			const exhaustive: never = layout;
			return exhaustive;
		}
	}
}

function showWidget(ctx: ExtensionContext, { layout, upgrades }: StartDisplay): void {
	const header = headerLine(digestOf(upgrades));
	ctx.ui.setWidget(WIDGET_KEY, () =>
		jsx("col", { children: [jsx("text", { spans: [{ t: header, s: "accent strong" }], wrap: "word" }), widgetBody(layout, upgrades)] }),
	);
}

async function settleStart(pi: ExtensionAPI): Promise<StartDisplay | undefined> {
	const found = await discoverMembers();
	if (found.kind === "failed") {
		pi.logger.warn("omomp-changelog: listing the installed plugins failed", { error: found.reason });
		return undefined;
	}
	const read = readMarker();
	if (read.kind === "invalid") pi.logger.warn("omomp-changelog: the marker is unreadable and is rebuilt", { error: read.reason });
	const before: Seen = read.kind === "ok" ? read.seen : new Map();
	const policy = policyOf(cfgStartupQuiet.get(settings), cfgStartupChangelogMode.get(settings));
	const verdicts = found.members.map((discovered) => {
		if (discovered.kind === "broken") return [discovered.name, { kind: "unreadable", reason: discovered.reason }] as const;
		const { member } = discovered;
		return [member.name, classify(member, before.get(member.name), () => loadChangelog(member))] as const;
	});
	for (const [name, verdict] of verdicts) if (verdict.kind === "unreadable") pi.logger.warn(`omomp-changelog: ${name}: ${verdict.reason}`);
	const { seen, upgrades } = settle(verdicts, before, policy);
	if (read.kind === "invalid" || !sameMarker(before, seen)) {
		const written = writeMarker(seen);
		if (written.kind === "failed") pi.logger.warn("omomp-changelog: writing the marker failed", { error: written.reason });
	}
	return policy.kind === "show" && upgrades.length > 0 ? { layout: policy.layout, upgrades } : undefined;
}

async function showHistory(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const view = parseView(args);
	if (view.kind === "usage") {
		ctx.ui.notify(tr("Usage: /omomp-changelog [full|last [N]]", "用法：/omomp-changelog [full|last [N]]"), "warning");
		return;
	}
	const found = await discoverMembers();
	if (found.kind === "failed") {
		pi.logger.warn("omomp-changelog: listing the installed plugins failed", { error: found.reason });
		ctx.ui.notify(
			tr(`omomp-changelog: listing the installed plugins failed: ${found.reason}`, `omomp-changelog：读取已装插件失败：${found.reason}`),
			"warning",
		);
		return;
	}
	const entries: Entry[] = [];
	const skipped: string[] = [];
	for (const discovered of found.members) {
		if (discovered.kind === "broken") {
			pi.logger.warn(`omomp-changelog: ${discovered.name}: ${discovered.reason}`);
			skipped.push(tr(`${discovered.name}: omomp declaration unreadable`, `${discovered.name}：omomp 声明读不出`));
			continue;
		}
		const { member } = discovered;
		const loaded = loadChangelog(member);
		if (loaded.kind === "failed") {
			pi.logger.warn(`omomp-changelog: ${member.name}: ${loaded.reason}`);
			skipped.push(tr(`${member.name}: changelog unreadable`, `${member.name}：changelog 读不出`));
			continue;
		}
		for (const release of loaded.releases) {
			if (!isDated(release)) {
				pi.logger.warn(`omomp-changelog: ${member.name}: section ${release.text} has no YYYY-MM-DD date`);
				continue;
			}
			entries.push({ name: member.name, release });
		}
	}
	const all = groupDays(entries);
	const days = view.kind === "full" ? all : all.slice(0, view.count);
	const markdown = days.length > 0 ? daysMarkdown(days) : tr("No changelog entries found.", "没有找到变更记录。");
	const notes = skipped.map((note) => `- ${note}`);
	pi.sendMessage(
		{
			customType: MESSAGE_TYPE,
			content: [markdown, ...(notes.length > 0 ? ["", "---", "", ...notes] : [])].join("\n"),
			display: true,
			attribution: "agent",
		},
		{ triggerTurn: false },
	);
}

export default function omompChangelog(pi: ExtensionAPI): void {
	pi.registerCommand("omomp-changelog", {
		description: tr(
			"Changelog of the installed omomp components: /omomp-changelog [full|last [N]] (default: the latest 3 release days)",
			"已装 omomp 组件的变更记录：/omomp-changelog [full|last [N]]（默认最近 3 个发布日）",
		),
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim().toLowerCase();
			const matches = ["full", "last"].filter((value) => value.startsWith(typed)).map((value) => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			try {
				await showHistory(pi, ctx, args);
			} catch (error) {
				pi.logger.warn("omomp-changelog: command failed", { error: errorText(error) });
			}
		},
	});

	let shown = false;

	pi.on("session_start", async (_event, ctx) => {
		try {
			if (ctx.agent.kind !== "main" || !ctx.hasUI) return;
			const start = await settleStart(pi);
			if (start === undefined) return;
			showWidget(ctx, start);
			shown = true;
		} catch (error) {
			pi.logger.warn("omomp-changelog: start failed", { error: errorText(error) });
		}
	});

	pi.on("input", (event, ctx) => {
		try {
			if (!shown || event.source === "extension" || event.text.startsWith("/")) return;
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			shown = false;
		} catch (error) {
			pi.logger.warn("omomp-changelog: removing the widget failed", { error: errorText(error) });
		}
	});
}
