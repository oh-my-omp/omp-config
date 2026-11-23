import { Lexer } from "@oh-my-pi/pi-utils/marked";

type Version = { readonly major: number; readonly minor: number; readonly patch: number };

export type Release = {
	readonly version: Version;
	readonly text: string;
	readonly date: string | null;
	readonly body: string;
};

export type DatedRelease = Release & { readonly date: string };

export const isDated = (release: Release): release is DatedRelease => release.date !== null;

export const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// @upstream adapted @oh-my-pi/pi-coding-agent@19.1.1 src/utils/changelog.ts#compareChangelogEntries
// Compares parsed versions instead of changelog entries; the host function is not exported.
export function compareVersions(a: Version, b: Version): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@19.1.1 src/utils/changelog.ts#parseChangelogContent
// Also keeps the release date and drops the heading from the body; the host function is not exported.
export function parseReleases(content: string): Release[] {
	const releases: Release[] = [];
	let current: { version: Version; date: string | null; lines: string[] } | null = null;
	const finish = (): void => {
		if (current === null) return;
		const { version, date, lines } = current;
		releases.push({ version, text: `${version.major}.${version.minor}.${version.patch}`, date, body: lines.join("\n").trim() });
	};
	for (const line of content.split("\n")) {
		if (line.startsWith("## ")) {
			finish();
			const match = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
			if (match) {
				const date = /\d{4}-\d{2}-\d{2}/.exec(line.slice((match.index ?? 0) + match[0].length))?.[0] ?? null;
				current = {
					version: {
						major: Number.parseInt(match[1] ?? "", 10),
						minor: Number.parseInt(match[2] ?? "", 10),
						patch: Number.parseInt(match[3] ?? "", 10),
					},
					date,
					lines: [],
				};
			} else {
				current = null;
			}
		} else if (current !== null) {
			current.lines.push(line);
		}
	}
	finish();
	return releases;
}
// @upstream-end

type Changes = { readonly count: number; readonly categories: ReadonlyMap<string, number> };

// @upstream adapted @oh-my-pi/pi-coding-agent@19.1.1 src/utils/changelog.ts#summarizeChangelogEntries
// Counts one release body per call; the host function is not exported.
const UNCATEGORIZED = "Other";

export function countChanges(body: string): Changes {
	const categories = new Map<string, number>();
	let count = 0;
	let category = UNCATEGORIZED;
	for (const token of Lexer.lex(body)) {
		if (token.type === "heading" && token.depth === 3) {
			const name = token.text.trim();
			category = name === "" ? UNCATEGORIZED : name;
			continue;
		}
		if (token.type !== "list") continue;
		for (const item of token.items) {
			if (!item.task && item.text.trim() === "") continue;
			categories.set(category, (categories.get(category) ?? 0) + 1);
			count++;
		}
	}
	return { count, categories };
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@19.1.1 src/utils/changelog.ts#formatStartupChangelogSummary
// Only the category ordering: importing the whole function would replace the What's New summary format.
const CATEGORY_ORDER: readonly string[] = ["Breaking Changes", "Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

export function orderedCategories(counts: ReadonlyMap<string, number>): string[] {
	return [
		...CATEGORY_ORDER.filter((category) => counts.has(category)),
		...[...counts.keys()].filter((category) => !CATEGORY_ORDER.includes(category)).sort(),
	];
}
// @upstream-end

const FENCE = /^\s*(```|~~~)/;

export function nestCategories(body: string): string {
	let fenced = false;
	return body
		.split("\n")
		.map((line) => {
			if (FENCE.test(line)) fenced = !fenced;
			return !fenced && /^###\s/.test(line) ? `#${line}` : line;
		})
		.join("\n");
}
