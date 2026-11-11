// ============================================================================
// omomp-changelog — one merged What's New for the omomp members installed on
// this machine, and `/omomp-changelog` to read their history.
//
// MEMBERS. An installed plugin (enabled or not) whose package.json has a
// top-level `omomp` object with a string `changelog` (a path relative to the
// package root; `omp-config` itself is such a plugin through its link). They
// are read from the host's plugin list and each package's own package.json
// at every start; nothing is cached. The version of a member is the one in its
// package.json. Packages without the declaration never show up here.
//
// MARKER. `<agentDir>/omomp-changelog/seen.json` maps each member's package
// name to the version whose changelog was last shown. It is machine state:
// the updater does not manage it and `/sync-omp-config` does not carry it.
// Each member falls into exactly one case at a start:
//   no marker          write the current version, show nothing;
//   equal              nothing (the changelog is not read);
//   current is newer   take the sections in (marker, current], then advance
//                      the marker to the current version;
//   current is older   nothing, marker kept;
//   changelog unreadable, no section for the current version, a section in
//   range without a date, or a version that is not X.Y.Z: the member shows
//   nothing, its marker is kept and a warning names it.
// A marker entry of a package that is no longer a member is deleted.
//
// START. In the main session with a UI, `session_start` shows the sections
// as one widget above the editor and the first message the user sends (not a
// slash command) removes it. `startup.changelogMode` `summary` (default) shows
// the figures, the category counts and one row per component; `expanded` shows
// the sections as Markdown, `## <date>` newest first and `### <package> vX.Y.Z`
// within a day. `hidden` advances the marker without showing; `startup.quiet`
// shows nothing and keeps the marker (hidden wins when both are set). Sessions
// without a UI and subagents neither show nor touch the marker.
//
// COMMAND. `/omomp-changelog [full|last [N]]` prints the latest 3 release days
// (`last`: 1, `last N`: N, `full`: all) of every member's changelog as one
// Markdown message; it reads no marker and writes none.
//
// Language of the widget and command text: `_shared/i18n.ts`; changelog
// entries are shown as written. Failure policy: nothing here throws into omp;
// a failed start logs a warning and shows nothing.
// ============================================================================

import { readFileSync } from "node:fs";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getMarkdownTheme,
	settings,
} from "@oh-my-pi/pi-coding-agent";
import { cfgStartupChangelogMode, cfgStartupQuiet } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { Container, Markdown, Text } from "@oh-my-pi/pi-tui";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { parseReleases } from "./changelog.ts";
import { readMarker, sameMarker, writeMarker } from "./marker.ts";
import { discoverMembers, type Member } from "./members.ts";
import {
	type ChangelogLoad,
	classify,
	digestOf,
	type Entry,
	entriesOf,
	groupDays,
	parseView,
	policyOf,
	type Seen,
	settle,
	type Upgrade,
} from "./plan.ts";
import { daysMarkdown, headerLine, summaryLines } from "./render.ts";

const WIDGET_KEY = "omomp-changelog";
const MESSAGE_TYPE = "omomp-changelog";

function loadChangelog(member: Member): ChangelogLoad {
	let content: string;
	try {
		content = readFileSync(member.changelogPath, "utf8");
	} catch (error) {
		return { kind: "failed", reason: `${member.changelogPath}: ${errorText(error)}` };
	}
	return { kind: "ok", releases: parseReleases(content) };
}

/** The widget: the figures, then the rows or the Markdown. A component, so no line cap applies. */
function showWidget(ctx: ExtensionContext, layout: "summary" | "expanded", upgrades: readonly Upgrade[]): void {
	const digest = digestOf(upgrades);
	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
		const body = new Container();
		switch (layout) {
			case "summary": {
				const [head = "", ...rest] = summaryLines(digest);
				body.addChild(new Text([theme.bold(theme.fg("accent", head)), ...rest].join("\n"), 1, 0));
				break;
			}
			case "expanded":
				body.addChild(new Text(theme.bold(theme.fg("accent", headerLine(digest))), 1, 0));
				body.addChild(new Markdown(daysMarkdown(groupDays(entriesOf(upgrades))), 1, 0, getMarkdownTheme()));
				break;
			default: {
				const exhaustive: never = layout;
				return exhaustive;
			}
		}
		return body;
	});
}

/** Settle every member against the marker, write the marker, and return what to show. */
async function settleStart(
	pi: ExtensionAPI,
): Promise<{ readonly layout: "summary" | "expanded"; readonly upgrades: readonly Upgrade[] } | undefined> {
	const found = await discoverMembers();
	if (found.kind === "failed") {
		pi.logger.warn("omomp-changelog: listing the installed plugins failed", { error: found.reason });
		return undefined;
	}
	const read = readMarker();
	if (read.kind === "invalid") pi.logger.warn("omomp-changelog: the marker is unreadable and is rebuilt", { error: read.reason });
	const before: Seen = read.kind === "ok" ? read.seen : new Map();
	const policy = policyOf(cfgStartupQuiet.get(settings), cfgStartupChangelogMode.get(settings));
	const verdicts = found.members.map((member) => [member, classify(member, before.get(member.name), () => loadChangelog(member))] as const);
	for (const [member, verdict] of verdicts)
		if (verdict.kind === "unreadable") pi.logger.warn(`omomp-changelog: ${member.name}: ${verdict.reason}`);
	const { seen, upgrades } = settle(verdicts, before, policy);
	if (read.kind === "invalid" || !sameMarker(before, seen)) writeMarker(seen);
	return policy.kind === "show" && upgrades.length > 0 ? { layout: policy.layout, upgrades } : undefined;
}

/** `/omomp-changelog`: the latest release days of every member's whole changelog as one Markdown message. */
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
	for (const member of found.members) {
		const loaded = loadChangelog(member);
		if (loaded.kind === "failed") {
			pi.logger.warn(`omomp-changelog: ${member.name}: ${loaded.reason}`);
			skipped.push(tr(`${member.name}: changelog unreadable`, `${member.name}：changelog 读不出`));
			continue;
		}
		for (const release of loaded.releases) {
			if (release.date === null) {
				pi.logger.warn(`omomp-changelog: ${member.name}: section ${release.text} has no YYYY-MM-DD date`);
				continue;
			}
			entries.push({ name: member.name, release: { ...release, date: release.date } });
		}
	}
	const all = groupDays(entries);
	const days = view.kind === "full" ? all : all.slice(0, view.count);
	const markdown = days.length > 0 ? daysMarkdown(days) : tr("No changelog entries found.", "没有找到变更记录。");
	const notes = skipped.map((note) => `- ${note}`);
	pi.sendMessage(
		{
			customType: MESSAGE_TYPE,
			content: [markdown, ...(notes.length > 0 ? ["", ...notes] : [])].join("\n"),
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

	/** True while this session's widget is on screen. */
	let shown = false;

	pi.on("session_start", async (_event, ctx) => {
		try {
			if (ctx.agent.kind !== "main" || !ctx.hasUI) return;
			const start = await settleStart(pi);
			if (start === undefined) return;
			showWidget(ctx, start.layout, start.upgrades);
			shown = true;
		} catch (error) {
			pi.logger.warn("omomp-changelog: start failed", { error: errorText(error) });
		}
	});

	pi.on("input", (event, ctx) => {
		try {
			// A slash command and a message an extension sent are not the user's first message.
			if (!shown || event.source === "extension" || event.text.startsWith("/")) return;
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			shown = false;
		} catch (error) {
			pi.logger.warn("omomp-changelog: removing the widget failed", { error: errorText(error) });
		}
	});
}
