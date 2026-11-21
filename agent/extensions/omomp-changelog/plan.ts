import { parseChangelogVersion } from "@oh-my-pi/pi-coding-agent/utils/changelog";
import { type Changes, compareVersions, countChanges, type DatedRelease, isDated, type Release } from "./changelog.ts";
import type { Member } from "./members.ts";

export type Seen = ReadonlyMap<string, string>;

export type ChangelogLoad =
	| { readonly kind: "ok"; readonly releases: readonly Release[] }
	| { readonly kind: "failed"; readonly reason: string };

export type Verdict =
	| { readonly kind: "first-seen" }
	| { readonly kind: "unchanged" }
	| { readonly kind: "older" }
	| { readonly kind: "newer"; readonly from: string; readonly releases: readonly DatedRelease[] }
	| { readonly kind: "unreadable"; readonly reason: string };

export function classify(member: Member, marked: string | undefined, load: () => ChangelogLoad): Verdict {
	const current = parseChangelogVersion(member.version);
	if (current === undefined) return { kind: "unreadable", reason: `version ${member.version} is not X.Y.Z` };
	if (marked === undefined) return { kind: "first-seen" };
	const last = parseChangelogVersion(marked);
	if (last === undefined) return { kind: "first-seen" };
	const order = compareVersions(current, last);
	if (order === 0) return { kind: "unchanged" };
	if (order < 0) return { kind: "older" };
	const loaded = load();
	if (loaded.kind === "failed") return { kind: "unreadable", reason: loaded.reason };
	const inRange = loaded.releases.filter(
		(release) => compareVersions(release.version, last) > 0 && compareVersions(release.version, current) <= 0,
	);
	if (!inRange.some((release) => compareVersions(release.version, current) === 0))
		return { kind: "unreadable", reason: `no section for version ${member.version}` };
	const dated = inRange.filter(isDated);
	const undated = inRange.find((release) => !isDated(release));
	if (undated !== undefined) return { kind: "unreadable", reason: `section ${undated.text} has no YYYY-MM-DD date` };
	return { kind: "newer", from: marked, releases: dated };
}

export type Policy =
	| { readonly kind: "show"; readonly layout: "summary" | "expanded" }
	| { readonly kind: "advance" }
	| { readonly kind: "hold" };

export function policyOf(quiet: boolean, mode: "summary" | "expanded" | "hidden"): Policy {
	if (mode === "hidden") return { kind: "advance" };
	if (quiet) return { kind: "hold" };
	return { kind: "show", layout: mode };
}

export type Upgrade = { readonly name: string; readonly from: string; readonly to: string; readonly releases: readonly DatedRelease[] };

export type Settlement = { readonly seen: Seen; readonly upgrades: readonly Upgrade[] };

export function settle(members: readonly (readonly [Member, Verdict])[], marker: Seen, policy: Policy): Settlement {
	const seen = new Map<string, string>();
	const upgrades: Upgrade[] = [];
	for (const [member, verdict] of members) {
		const before = marker.get(member.name);
		switch (verdict.kind) {
			case "first-seen":
				seen.set(member.name, member.version);
				break;
			case "unchanged":
			case "older":
			case "unreadable":
				if (before !== undefined) seen.set(member.name, before);
				break;
			case "newer":
				switch (policy.kind) {
					case "show":
						upgrades.push({ name: member.name, from: verdict.from, to: member.version, releases: verdict.releases });
						seen.set(member.name, member.version);
						break;
					case "advance":
						seen.set(member.name, member.version);
						break;
					case "hold":
						seen.set(member.name, verdict.from);
						break;
					default: {
						const exhaustive: never = policy;
						return exhaustive;
					}
				}
				break;
			default: {
				const exhaustive: never = verdict;
				return exhaustive;
			}
		}
	}
	return { seen, upgrades };
}

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
		.sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
		.map(([date, day]) => ({
			date,
			entries: day.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : compareVersions(b.release.version, a.release.version))),
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
	let changeCount = 0;
	const components = [...upgrades]
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map((upgrade) => {
			let changes = 0;
			for (const release of upgrade.releases) {
				const counted: Changes = countChanges(release.body);
				changes += counted.count;
				for (const [category, count] of counted.categories) categories.set(category, (categories.get(category) ?? 0) + count);
			}
			changeCount += changes;
			return { name: upgrade.name, from: upgrade.from, to: upgrade.to, changes };
		});
	return { components, dayCount: groupDays(entriesOf(upgrades)).length, changeCount, categories };
}

export type View = { readonly kind: "days"; readonly count: number } | { readonly kind: "full" };

const RECENT_DAYS = 3;
const LAST_DAYS = 1;

// @upstream adapted @oh-my-pi/pi-coding-agent@19.1.0 src/utils/changelog.ts#parseChangelogView
// Counts release days rather than entries and answers /omomp-changelog's usage, so the exported host function is not imported.
export function parseView(args: string): View | { readonly kind: "usage" } {
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
