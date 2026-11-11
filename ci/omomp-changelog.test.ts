import { describe, expect, test } from "bun:test";
import { countChanges, nestCategories, parseReleases } from "../agent/extensions/omomp-changelog/changelog.ts";
import type { Member } from "../agent/extensions/omomp-changelog/members.ts";
import {
	type ChangelogLoad,
	classify,
	digestOf,
	entriesOf,
	groupDays,
	parseView,
	policyOf,
	settle,
	type Upgrade,
	type Verdict,
} from "../agent/extensions/omomp-changelog/plan.ts";

import { daysMarkdown, summaryLines } from "../agent/extensions/omomp-changelog/render.ts";

// `tr` reads the variable at each call, not at import.
process.env.OMOMP_LANG = "en";

const member = (name: string, version: string): Member => ({ name, version, changelogPath: `/x/${name}/CHANGELOG.md` });

const log = (...sections: string[]): string => ["# Changelog", "", "## [Unreleased]", "", ...sections].join("\n");

const loaded = (content: string): ChangelogLoad => ({ kind: "ok", releases: parseReleases(content) });

const FX_A = log(
	"## [0.3.0] - 2026-11-12",
	"",
	"### Changed",
	"",
	"- c1",
	"",
	"## [0.2.0] - 2026-11-11",
	"",
	"### Added",
	"",
	"- a1",
	"",
	"### Fixed",
	"",
	"- f1",
	"",
	"## [0.1.0] - 2026-11-09",
	"",
	"### Added",
	"",
	"- first",
);

describe("parseReleases", () => {
	test("reads versions and dates, skips Unreleased, keeps a missing date as null", () => {
		const releases = parseReleases(log("## [0.2.0] - 2026-11-11", "", "- x", "", "## 0.1.0", "", "- y"));
		expect(releases.map((release) => [release.text, release.date])).toEqual([
			["0.2.0", "2026-11-11"],
			["0.1.0", null],
		]);
		expect(releases[0]?.body).toBe("- x");
	});
});

describe("countChanges", () => {
	test("counts top-level items per category, not nested ones or fenced lines", () => {
		const counted = countChanges(
			["### Added", "", "- one", "  - nested", "- two", "", "### Fixed", "", "- three", "", "```", "- not a change", "```"].join("\n"),
		);
		expect(counted.count).toBe(3);
		expect([...counted.categories]).toEqual([
			["Added", 2],
			["Fixed", 1],
		]);
	});

	test("items above any heading count as Other", () => {
		expect([...countChanges("- loose").categories]).toEqual([["Other", 1]]);
	});
});

describe("classify", () => {
	const neverRead = (): ChangelogLoad => {
		throw new Error("changelog must not be read");
	};

	test("no marker, an unparseable marker and an unparseable version", () => {
		expect(classify(member("a", "0.1.0"), undefined, neverRead).kind).toBe("first-seen");
		expect(classify(member("a", "0.1.0"), "garbage", neverRead).kind).toBe("first-seen");
		expect(classify(member("a", "1.0.0-beta.1"), "0.1.0", neverRead).kind).toBe("unreadable");
	});

	test("equal versions do not read the changelog; a lower one is older", () => {
		expect(classify(member("a", "0.3.0"), "0.3.0", neverRead).kind).toBe("unchanged");
		expect(classify(member("a", "0.1.0"), "0.3.0", neverRead).kind).toBe("older");
	});

	test("a newer version takes exactly the sections in (marker, current]", () => {
		const verdict = classify(member("a", "0.2.0"), "0.1.0", () => loaded(FX_A));
		expect(verdict.kind === "newer" && verdict.releases.map((release) => release.text)).toEqual(["0.2.0"]);
		const both = classify(member("a", "0.3.0"), "0.1.0", () => loaded(FX_A));
		expect(both.kind === "newer" && both.releases.map((release) => release.text)).toEqual(["0.3.0", "0.2.0"]);
	});

	test("a missing section for the current version, an undated section and an unreadable file are unreadable", () => {
		expect(classify(member("a", "0.4.0"), "0.3.0", () => loaded(FX_A)).kind).toBe("unreadable");
		expect(classify(member("a", "0.2.0"), "0.1.0", () => loaded(log("## [0.2.0]", "", "- x"))).kind).toBe("unreadable");
		expect(classify(member("a", "0.2.0"), "0.1.0", () => ({ kind: "failed", reason: "ENOENT" })).kind).toBe("unreadable");
	});
});

describe("settle", () => {
	const a = member("a", "0.3.0");
	const b = member("b", "0.1.1");
	const newer = (m: Member, from: string): Verdict =>
		classify(m, from, () => loaded(m === a ? FX_A : log("## [0.1.1] - 2026-11-11", "", "- f")));
	const marker = new Map([
		["a", "0.1.0"],
		["b", "0.1.0"],
		["gone", "9.9.9"],
	]);
	const verdicts = [
		[a, newer(a, "0.1.0")],
		[b, newer(b, "0.1.0")],
	] as const;

	test("show advances every shown member and drops entries of packages that are no longer members", () => {
		const settled = settle(verdicts, marker, policyOf(false, "summary"));
		expect([...settled.seen]).toEqual([
			["a", "0.3.0"],
			["b", "0.1.1"],
		]);
		expect(settled.upgrades.map((upgrade) => upgrade.name)).toEqual(["a", "b"]);
	});

	test("quiet keeps the marker and shows nothing; hidden advances without showing, also with quiet", () => {
		const quiet = settle(verdicts, marker, policyOf(true, "summary"));
		expect(quiet.seen.get("a")).toBe("0.1.0");
		expect(quiet.upgrades).toEqual([]);
		for (const hiddenQuiet of [true, false]) {
			const hidden = settle(verdicts, marker, policyOf(hiddenQuiet, "hidden"));
			expect(hidden.seen.get("a")).toBe("0.3.0");
			expect(hidden.upgrades).toEqual([]);
		}
	});

	test("first-seen is written under quiet; older and unreadable members keep their marker", () => {
		const fresh = member("c", "0.1.0");
		const old = member("d", "0.1.0");
		const broken = member("e", "0.5.0");
		const settled = settle(
			[
				[fresh, classify(fresh, undefined, () => loaded(""))],
				[old, classify(old, "0.2.0", () => loaded(""))],
				[broken, classify(broken, "0.4.0", () => loaded(FX_A))],
			],
			new Map([
				["d", "0.2.0"],
				["e", "0.4.0"],
			]),
			policyOf(true, "summary"),
		);
		expect([...settled.seen]).toEqual([
			["c", "0.1.0"],
			["d", "0.2.0"],
			["e", "0.4.0"],
		]);
	});
});

describe("merged days", () => {
	const fxB = log("## [0.1.1] - 2026-11-11", "", "### Fixed", "", "- b1");

	/** The upgrade of `name` from `from` to its current version, as a start would take it. */
	function upgrade(name: string, to: string, from: string, content: string): Upgrade {
		const verdict = classify(member(name, to), from, () => loaded(content));
		if (verdict.kind !== "newer") throw new Error(`unexpected ${verdict.kind}`);
		return { name, from, to, releases: verdict.releases };
	}
	const upgrades = [upgrade("fx-b", "0.1.1", "0.1.0", fxB), upgrade("fx-a", "0.2.0", "0.1.0", FX_A)];

	test("the summary lists figures, ordered categories and one row per component", () => {
		expect(summaryLines(digestOf(upgrades))).toEqual([
			"omomp · 2 components · 1 release day · 3 changes",
			"1 added · 2 fixed · Use /omomp-changelog for details",
			"fx-a 0.1.0 → 0.2.0  2 changes",
			"fx-b 0.1.0 → 0.1.1  1 change",
		]);
	});

	test("days run newest first, packages by name within a day, and category headings nest under the component", () => {
		const days = groupDays(entriesOf([...upgrades, upgrade("fx-a", "0.3.0", "0.2.0", FX_A)]));
		expect(days.map((day) => [day.date, day.entries.map((entry) => `${entry.name}@${entry.release.text}`)])).toEqual([
			["2026-11-12", ["fx-a@0.3.0"]],
			["2026-11-11", ["fx-a@0.2.0", "fx-b@0.1.1"]],
		]);
		const markdown = daysMarkdown(days);
		expect(markdown.indexOf("## 2026-11-12")).toBeLessThan(markdown.indexOf("## 2026-11-11"));
		expect(markdown).toContain("### fx-a v0.3.0\n\n#### Changed\n\n- c1");
	});
});

describe("parseView", () => {
	test("defaults, last, full, and everything else is usage", () => {
		expect(parseView("")).toEqual({ kind: "days", count: 3 });
		expect(parseView(" LAST ")).toEqual({ kind: "days", count: 1 });
		expect(parseView("last 2")).toEqual({ kind: "days", count: 2 });
		expect(parseView("full")).toEqual({ kind: "full" });
		for (const bad of ["bogus", "last 0", "last x", "full 2"]) expect(parseView(bad)).toEqual({ kind: "usage" });
	});
});

describe("nestCategories", () => {
	test("leaves headings inside code fences alone", () => {
		expect(nestCategories(["### Added", "```", "### not a heading", "```"].join("\n"))).toBe(
			["#### Added", "```", "### not a heading", "```"].join("\n"),
		);
	});
});
