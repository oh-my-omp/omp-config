import { Lexer } from "@oh-my-pi/pi-utils/marked";

/** `X.Y.Z`, the only version shape the changelog format and the marker use. */
export type Version = { readonly major: number; readonly minor: number; readonly patch: number };

/** One `## [X.Y.Z] - YYYY-MM-DD` section; `date` is null when the heading carries none. */
export type Release = {
	readonly version: Version;
	readonly text: string;
	readonly date: string | null;
	/** The section below its heading, `###` category headings and list items as written. */
	readonly body: string;
};

/** A release whose heading carries its date, the key releases are merged on. */
export type DatedRelease = Release & { readonly date: string };

export const isDated = (release: Release): release is DatedRelease => release.date !== null;

// @upstream adapted @oh-my-pi/pi-coding-agent@18.18.8 src/utils/changelog.ts#parseChangelogVersion
/** The version `text` names when it is exactly `X.Y.Z`. */
export function parseVersion(text: string): Version | undefined {
	const match = text.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) return undefined;
	return {
		major: Number.parseInt(match[1] ?? "", 10),
		minor: Number.parseInt(match[2] ?? "", 10),
		patch: Number.parseInt(match[3] ?? "", 10),
	};
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.18.8 src/utils/changelog.ts#compareChangelogEntries
/** Negative when `a` is older than `b`, zero when equal, positive when newer. */
export function compareVersions(a: Version, b: Version): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.18.8 src/utils/changelog.ts#parseChangelogContent
/** Every version section of a changelog, newest first as written; `## [Unreleased]` and other `##` headings are not releases. */
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

/** Bucket for list items written above any `###` category heading. */
const UNCATEGORIZED = "Other";

/** The changes of one section: how many, and how many per `###` category. */
export type Changes = { readonly count: number; readonly categories: ReadonlyMap<string, number> };

// @upstream adapted @oh-my-pi/pi-coding-agent@18.18.8 src/utils/changelog.ts#summarizeChangelogEntries
/** Count the top-level list items of a section, per `###` category. */
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
			// A bare marker renders an empty item; it announces no change.
			if (!item.task && item.text.trim() === "") continue;
			categories.set(category, (categories.get(category) ?? 0) + 1);
			count++;
		}
	}
	return { count, categories };
}
// @upstream-end

/** The category order of the host's startup notice; categories it does not name follow, sorted. */
const CATEGORY_ORDER: readonly string[] = ["Breaking Changes", "Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

// @upstream adapted @oh-my-pi/pi-coding-agent@18.18.8 src/utils/changelog.ts#formatStartupChangelogSummary
/** The categories of `counts` in display order: the named ones first, then the rest by name. */
export function orderedCategories(counts: ReadonlyMap<string, number>): string[] {
	return [
		...CATEGORY_ORDER.filter((category) => counts.has(category)),
		...[...counts.keys()].filter((category) => !CATEGORY_ORDER.includes(category)).sort(),
	];
}
// @upstream-end

/** A fenced code block opens or closes at a line starting with three backticks or tildes. */
const FENCE = /^\s*(```|~~~)/;

/** `body` with its `###` category headings one level deeper, so they nest under a `### <package> vX.Y.Z` heading. */
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
