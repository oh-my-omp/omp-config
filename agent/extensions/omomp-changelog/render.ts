import { tr } from "../_shared/i18n.ts";
import { nestCategories, orderedCategories } from "./changelog.ts";
import type { Day, Digest } from "./plan.ts";

/** `1 component`, `2 components`; the Chinese text has no plural. */
const plural = (count: number, en: string, enPlural: string, zh: string): string =>
	tr(`${count} ${count === 1 ? en : enPlural}`, `${count} ${zh}`);

/** The first line of both layouts. */
export function headerLine(digest: Digest): string {
	return [
		"omomp",
		plural(digest.components.length, "component", "components", "个组件"),
		plural(digest.dayCount, "release day", "release days", "个发布日"),
		plural(digest.changeCount, "change", "changes", "项变更"),
	].join(" · ");
}

/** The Chinese name of a category the format names; any other category keeps its heading. */
function zhCategory(category: string): string {
	switch (category) {
		case "Breaking Changes":
			return "不兼容变更";
		case "Added":
			return "新增";
		case "Changed":
			return "变更";
		case "Deprecated":
			return "弃用";
		case "Removed":
			return "移除";
		case "Fixed":
			return "修复";
		case "Security":
			return "安全";
		case "Other":
			return "其他";
		default:
			return category;
	}
}

// @upstream adapted @oh-my-pi/pi-coding-agent@18.18.8 src/utils/changelog.ts#categoryLabel
function categoryLabel(category: string, count: number): string {
	if (category === "Breaking Changes") return tr(count === 1 ? "breaking change" : "breaking changes", zhCategory(category));
	return tr(category.toLowerCase(), zhCategory(category));
}
// @upstream-end

/** The `summary` layout: the figures, the category counts with the pointer to the command, then one row per component. */
export function summaryLines(digest: Digest): string[] {
	const breakdown = orderedCategories(digest.categories).map((category) => {
		const count = digest.categories.get(category) ?? 0;
		return `${count} ${categoryLabel(category, count)}`;
	});
	const hint = tr("Use /omomp-changelog for details", "使用 /omomp-changelog 查看详情");
	return [
		headerLine(digest),
		[...breakdown, hint].join(" · "),
		...digest.components.map(
			(component) => `${component.name} ${component.from} → ${component.to}  ${plural(component.changes, "change", "changes", "项变更")}`,
		),
	];
}

/** Markdown of release days as given: `## <date>`, then `### <package> vX.Y.Z` with that release's entries. */
export function daysMarkdown(days: readonly Day[]): string {
	return days
		.map((day) => {
			const releases = day.entries.map((entry) =>
				[`### ${entry.name} v${entry.release.text}`, nestCategories(entry.release.body)].join("\n\n").trimEnd(),
			);
			return [`## ${day.date}`, ...releases].join("\n\n");
		})
		.join("\n\n");
}
