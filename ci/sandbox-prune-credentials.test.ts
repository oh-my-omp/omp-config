import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneCredentials } from "../sandbox/recorder.ts";

function withDb(rows: readonly string[], run: (path: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "prune-"));
	const path = join(dir, "agent.db");
	try {
		const db = new Database(path);
		db.run("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL)");
		for (const provider of rows) db.query("INSERT INTO auth_credentials (provider) VALUES (?)").run(provider);
		db.close();
		run(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function providersLeft(path: string): string[] {
	const db = new Database(path, { readonly: true });
	try {
		return db
			.query<{ provider: string }, []>("SELECT provider FROM auth_credentials ORDER BY id")
			.all()
			.map((row) => row.provider);
	} finally {
		db.close();
	}
}

describe("pruneCredentials", () => {
	test("deletes rows of providers without a recorder target and keeps the others", () => {
		withDb(["anthropic", "futureppo-pool", "devin", "futureppo-pool", "futureppo-jev"], (path) => {
			const result = pruneCredentials(path, ["futureppo", "futureppo-pool", "futureppo-jev"]);
			expect(result).toEqual({ removed: 2, kept: ["futureppo-jev", "futureppo-pool"] });
			expect(providersLeft(path)).toEqual(["futureppo-pool", "futureppo-pool", "futureppo-jev"]);
		});
	});

	test("with no targets every row goes", () => {
		withDb(["anthropic"], (path) => {
			expect(pruneCredentials(path, [])).toEqual({ removed: 1, kept: [] });
			expect(providersLeft(path)).toEqual([]);
		});
	});

	test("fails on a database without the table instead of creating one", () => {
		const dir = mkdtempSync(join(tmpdir(), "prune-"));
		try {
			const path = join(dir, "empty.db");
			new Database(path).close();
			expect(() => pruneCredentials(path, ["futureppo-pool"])).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
