import { byCodePoint, compareVersions, countChanges, type DatedRelease } from "./changelog.ts";
import type { Upgrade } from "./settle.ts";

export type Entry = { readonly name: string; readonly release: DatedRelease };

export type Day = { readonly date: string; readonly entries: readonly Entry[] };

export function groupDays(entries: readonly Entry[]): Day[] {
	const byDate = new Map<string, Entry[]>();
	for (const entry of entries) {
		const day = byDate.get(entry.release.date);
		if (day === undefined) byDate.set(entry.release.date, [entry]);
		else day.push(entry);
	}
	return [...byDate.entries()]
		.sort(([a], [b]) => byCodePoint(b, a))
		.map(([date, day]) => ({
			date,
			entries: day.sort((a, b) => byCodePoint(a.name, b.name) || compareVersions(b.release.version, a.release.version)),
		}));
}

export const entriesOf = (upgrades: readonly Upgrade[]): Entry[] =>
	upgrades.flatMap((upgrade) => upgrade.releases.map((release) => ({ name: upgrade.name, release })));

export type Digest = {
	readonly components: readonly { readonly name: string; readonly from: string; readonly to: string; readonly changes: number }[];
	readonly dayCount: number;
	readonly changeCount: number;
	readonly categories: ReadonlyMap<string, number>;
};

export function digestOf(upgrades: readonly Upgrade[]): Digest {
	const categories = new Map<string, number>();
	const dates = new Set<string>();
	let changeCount = 0;
	const components = [...upgrades]
		.sort((a, b) => byCodePoint(a.name, b.name))
		.map((upgrade) => {
			let changes = 0;
			for (const release of upgrade.releases) {
				dates.add(release.date);
				const counted = countChanges(release.body);
				changes += counted.count;
				for (const [category, count] of counted.categories) categories.set(category, (categories.get(category) ?? 0) + count);
			}
			changeCount += changes;
			return { name: upgrade.name, from: upgrade.from, to: upgrade.to, changes };
		});
	return { components, dayCount: dates.size, changeCount, categories };
}

const RECENT_DAYS = 3;
const LAST_DAYS = 1;

// @upstream adapted @oh-my-pi/pi-coding-agent@19.1.0 src/utils/changelog.ts#parseChangelogView
// Counts release days rather than entries and answers /omomp-changelog's usage, so the exported host function is not imported.
export function parseView(
	args: string,
): { readonly kind: "days"; readonly count: number } | { readonly kind: "full" } | { readonly kind: "usage" } {
	const trimmed = args.trim().toLowerCase();
	if (!trimmed) return { kind: "days", count: RECENT_DAYS };
	if (trimmed === "full") return { kind: "full" };
	const match = trimmed.match(/^last(?:\s+(\d+))?$/);
	if (!match) return { kind: "usage" };
	if (match[1] === undefined) return { kind: "days", count: LAST_DAYS };
	const count = Number.parseInt(match[1], 10);
	return count < 1 ? { kind: "usage" } : { kind: "days", count };
}
// @upstream-end
