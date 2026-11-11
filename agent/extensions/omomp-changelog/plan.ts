import { type Changes, compareVersions, countChanges, type DatedRelease, isDated, parseVersion, type Release } from "./changelog.ts";
import type { Member } from "./members.ts";

/** The versions last seen, by package name. */
export type Seen = ReadonlyMap<string, string>;

/** What reading one member's changelog yields. */
export type ChangelogLoad =
	| { readonly kind: "ok"; readonly releases: readonly Release[] }
	| { readonly kind: "failed"; readonly reason: string };

/** The one case a member falls into at a start. */
export type Verdict =
	| { readonly kind: "first-seen" }
	| { readonly kind: "unchanged" }
	| { readonly kind: "older" }
	| { readonly kind: "newer"; readonly from: string; readonly releases: readonly DatedRelease[] }
	| { readonly kind: "unreadable"; readonly reason: string };

/**
 * Classify `member` against the version last seen for it. `load` reads its changelog and is called only when
 * the current version is newer than the marker. Releases in (marker, current] are returned newest first.
 */
export function classify(member: Member, marked: string | undefined, load: () => ChangelogLoad): Verdict {
	const current = parseVersion(member.version);
	if (current === undefined) return { kind: "unreadable", reason: `version ${member.version} is not X.Y.Z` };
	if (marked === undefined) return { kind: "first-seen" };
	const last = parseVersion(marked);
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

/** What a start does with the releases a member gained. */
export type Policy =
	| { readonly kind: "show"; readonly layout: "summary" | "expanded" }
	| { readonly kind: "advance" }
	| { readonly kind: "hold" };

/** `startup.changelogMode` hidden marks the releases seen without showing them; `startup.quiet` otherwise shows nothing and keeps them unseen. */
export function policyOf(quiet: boolean, mode: "summary" | "expanded" | "hidden"): Policy {
	if (mode === "hidden") return { kind: "advance" };
	if (quiet) return { kind: "hold" };
	return { kind: "show", layout: mode };
}

/** A member that gained releases and shows them. */
export type Upgrade = { readonly name: string; readonly from: string; readonly to: string; readonly releases: readonly DatedRelease[] };

export type Settlement = { readonly seen: Seen; readonly upgrades: readonly Upgrade[] };

/**
 * The marker after a start and the upgrades it shows. Only current members keep an entry, so an uninstalled
 * package, or one that stopped declaring `omomp`, drops out. A member that cannot be read keeps what it had.
 */
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

/** One release of one package, the unit merged by date. */
export type Entry = { readonly name: string; readonly release: DatedRelease };

/** The releases of one release day, packages by name, a package's versions newest first. */
export type Day = { readonly date: string; readonly entries: readonly Entry[] };

/** Group by release date, newest day first. */
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

/** The figures of the startup summary. */
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

/** How much history `/omomp-changelog` shows: the latest `count` release days, or all. */
export type View = { readonly kind: "days"; readonly count: number } | { readonly kind: "full" };

/** The default window and the `last` default, in release days. */
const RECENT_DAYS = 3;
const LAST_DAYS = 1;

// @upstream adapted @oh-my-pi/pi-coding-agent@18.18.8 src/utils/changelog.ts#parseChangelogView
/** The view `args` name, or `usage` when they are not `full` or `last [N]`. */
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
