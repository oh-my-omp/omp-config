// delete-guard `delete` tool: the refusal set holds for literal and resolved
// paths and refuses the whole batch; trash follows the freedesktop layout on
// Linux; permanent removes non-empty directories.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { runDeletion } from "../agent/extensions/delete-guard/backends.ts";
import { validateTargets } from "../agent/extensions/delete-guard/targets.ts";

let root: string;
let cwd: string;
let keep: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "dg-tool-")));
	cwd = path.join(root, "work", "cwd");
	mkdirSync(cwd, { recursive: true });
	keep = path.join(root, "keep.txt");
	writeFileSync(keep, "k");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const refusedPaths = (paths: string[]): string[] => {
	const result = validateTargets(paths, cwd);
	return result.kind === "refused" ? result.refusals.map((refusal) => refusal.given) : [];
};

describe("validateTargets", () => {
	test.each([
		["/", "filesystem root"],
		[homedir(), "home directory"],
		[".", "session cwd"],
		["..", "ancestor of the session cwd"],
		["~/x", "`~`"],
		["", "empty"],
		["   ", "empty"],
		["nope", "does not exist"],
	])("refuses %p together with a valid path and names it (%s)", (bad, reason) => {
		const result = validateTargets([keep, bad], cwd);
		expect(result.kind).toBe("refused");
		if (result.kind !== "refused") return;
		expect(result.refusals).toHaveLength(1);
		expect(result.refusals[0]?.given).toBe(bad);
		expect(result.refusals[0]?.reason).toContain(reason);
	});

	test("refuses a symbolic link whose target is an ancestor of the cwd", () => {
		const link = path.join(root, "up");
		symlinkSync(path.join(cwd, ".."), link);
		expect(refusedPaths([`${link}/.`])).toEqual([`${link}/.`]);
		expect(refusedPaths([link])).toEqual([link]);
	});

	test("refuses the cwd reached through a symbolic link to it", () => {
		const link = path.join(root, "here");
		symlinkSync(cwd, link);
		expect(refusedPaths([link])).toEqual([link]);
	});

	test.skipIf(path.dirname(homedir()) === path.parse(homedir()).root)("refuses an ancestor of the home directory", () => {
		const result = validateTargets([path.dirname(homedir())], cwd);
		expect(result.kind === "refused" && result.refusals[0]?.reason).toContain("ancestor of the home directory");
	});

	test("refuses the cwd spelled with different case on a case-insensitive volume", () => {
		const variant = cwd.toUpperCase();
		if (!existsSync(variant)) return;
		expect(refusedPaths([variant])).toEqual([variant]);
	});

	test("accepts a dangling symbolic link as the link itself", () => {
		const link = path.join(root, "dangling");
		symlinkSync(path.join(root, "gone"), link);
		expect(validateTargets([link], cwd)).toEqual({ kind: "ok", targets: [{ given: link, operand: link }] });
	});

	test("refuses a path whose `..` or trailing slash passes through a symbolic link", () => {
		mkdirSync(path.join(root, "real", "x"), { recursive: true });
		mkdirSync(path.join(root, "x"));
		symlinkSync(path.join(root, "real", "x"), path.join(root, "link"));
		const dotdot = `${path.join(root, "link")}/../x`;
		const slash = `${path.join(root, "link")}/`;
		expect(refusedPaths([dotdot])).toEqual([dotdot]);
		expect(refusedPaths([slash])).toEqual([slash]);
		expect(validateTargets([path.join(root, "link")], cwd).kind).toBe("ok");
	});

	test("takes `$HOME` and globs as literal file names", () => {
		const dollar = path.join(root, "$HOME");
		writeFileSync(dollar, "x");
		const ok = validateTargets([dollar], cwd);
		expect(ok).toEqual({ kind: "ok", targets: [{ given: dollar, operand: dollar }] });
		expect(refusedPaths([path.join(root, "*.txt")])).toEqual([path.join(root, "*.txt")]);
	});

	test("resolves relative paths against the cwd", () => {
		writeFileSync(path.join(cwd, "rel.txt"), "r");
		expect(validateTargets(["rel.txt"], cwd)).toEqual({ kind: "ok", targets: [{ given: "rel.txt", operand: path.join(cwd, "rel.txt") }] });
	});
});

describe("runDeletion", () => {
	test("permanent removes a non-empty directory", async () => {
		const dir = path.join(root, "p", "q");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "f"), "f");
		const outcomes = await runDeletion(process.platform === "darwin" ? "darwin" : "linux", "permanent", [
			{ given: "p", operand: path.join(root, "p") },
		]);
		expect(outcomes.map((outcome) => outcome.kind)).toEqual(["done"]);
		expect(existsSync(path.join(root, "p"))).toBe(false);
		expect(existsSync(keep)).toBe(true);
	});

	test.skipIf(process.platform !== "linux")("trash on Linux writes files/ and info/ per the freedesktop spec", async () => {
		const previous = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = path.join(root, "data");
		try {
			const dir = path.join(root, "d");
			mkdirSync(dir);
			writeFileSync(path.join(dir, "f"), "f");
			const a = path.join(root, "a.txt");
			writeFileSync(a, "a");
			const outcomes = await runDeletion("linux", "trash", [
				{ given: "a.txt", operand: a },
				{ given: "d", operand: dir },
			]);
			expect(outcomes.map((outcome) => outcome.kind)).toEqual(["done", "done"]);
			const trash = path.join(root, "data", "Trash");
			expect(readFileSync(path.join(trash, "files", "a.txt"), "utf8")).toBe("a");
			expect(existsSync(path.join(trash, "files", "d", "f"))).toBe(true);
			expect(existsSync(a)).toBe(false);
			const info = readFileSync(path.join(trash, "info", "a.txt.trashinfo"), "utf8");
			expect(info).toMatch(new RegExp(`^\\[Trash Info\\]\\nPath=${a}\\nDeletionDate=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\n$`));

			writeFileSync(a, "second");
			const again = await runDeletion("linux", "trash", [{ given: "a.txt", operand: a }]);
			expect(again.map((outcome) => outcome.kind)).toEqual(["done"]);
			expect(readFileSync(path.join(trash, "files", "a.txt.2"), "utf8")).toBe("second");
			expect(existsSync(path.join(trash, "info", "a.txt.2.trashinfo"))).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = previous;
		}
	});
});
