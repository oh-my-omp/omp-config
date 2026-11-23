import { parseChangelogVersion } from "@oh-my-pi/pi-coding-agent/utils/changelog";
import { compareVersions, type DatedRelease, isDated, type Release } from "./changelog.ts";
import type { Seen } from "./marker.ts";
import type { Member } from "./members.ts";

export type ChangelogLoad =
	| { readonly kind: "ok"; readonly releases: readonly Release[] }
	| { readonly kind: "failed"; readonly reason: string };

type Verdict =
	| { readonly kind: "first-seen"; readonly version: string }
	| { readonly kind: "unchanged" }
	| { readonly kind: "older" }
	| { readonly kind: "newer"; readonly from: string; readonly to: string; readonly releases: readonly DatedRelease[] }
	| { readonly kind: "unreadable"; readonly reason: string };

export function classify(member: Member, marked: string | undefined, load: () => ChangelogLoad): Verdict {
	const current = parseChangelogVersion(member.version);
	if (current === undefined) return { kind: "unreadable", reason: `version ${member.version} is not X.Y.Z` };
	const last = parseChangelogVersion(marked);
	if (marked === undefined || last === undefined) return { kind: "first-seen", version: member.version };
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
	const undated = inRange.find((release) => !isDated(release));
	if (undated !== undefined) return { kind: "unreadable", reason: `section ${undated.text} has no YYYY-MM-DD date` };
	return { kind: "newer", from: marked, to: member.version, releases: inRange.filter(isDated) };
}

export type Layout = "summary" | "expanded";

type Policy = { readonly kind: "show"; readonly layout: Layout } | { readonly kind: "advance" } | { readonly kind: "hold" };

export function policyOf(quiet: boolean, mode: Layout | "hidden"): Policy {
	if (mode === "hidden") return { kind: "advance" };
	if (quiet) return { kind: "hold" };
	return { kind: "show", layout: mode };
}

export type Upgrade = { readonly name: string; readonly from: string; readonly to: string; readonly releases: readonly DatedRelease[] };

export function settle(
	verdicts: readonly (readonly [string, Verdict])[],
	marker: Seen,
	policy: Policy,
): { readonly seen: Seen; readonly upgrades: readonly Upgrade[] } {
	const seen = new Map<string, string>();
	const upgrades: Upgrade[] = [];
	for (const [name, verdict] of verdicts) {
		const before = marker.get(name);
		switch (verdict.kind) {
			case "first-seen":
				seen.set(name, verdict.version);
				break;
			case "unchanged":
			case "older":
			case "unreadable":
				if (before !== undefined) seen.set(name, before);
				break;
			case "newer":
				switch (policy.kind) {
					case "show":
						upgrades.push({ name, from: verdict.from, to: verdict.to, releases: verdict.releases });
						seen.set(name, verdict.to);
						break;
					case "advance":
						seen.set(name, verdict.to);
						break;
					case "hold":
						seen.set(name, verdict.from);
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
