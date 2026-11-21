import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareImages, PRUNED_TABLES, snapshot } from "../sandbox/agentdb.ts";
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

describe("agentdb snapshot", () => {
	test("prunes bulky history and cache tables in memory while preserving auth_credentials and leaving host DB untouched", () => {
		const dir = mkdtempSync(join(tmpdir(), "agentdb-"));
		const path = join(dir, "agent.db");
		try {
			const db = new Database(path);
			db.run("PRAGMA journal_mode=WAL");
			db.run("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, token TEXT NOT NULL)");
			db.query("INSERT INTO auth_credentials (provider, token) VALUES (?, ?)").run("futureppo-pool", "tok-1");
			db.query("INSERT INTO auth_credentials (provider, token) VALUES (?, ?)").run("anthropic", "tok-2");
			const payload = new Uint8Array(256 * 1024);
			for (const table of PRUNED_TABLES) {
				db.run(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, blob BLOB)`);
				db.query(`INSERT INTO "${table}" (blob) VALUES (?)`).run(payload);
			}
			const rawSize = db.serialize().byteLength;
			db.close();

			const image = snapshot(path);
			expect(image.byteLength).toBeLessThan(rawSize / 2);

			const checks = compareImages(image, image);
			const byTable = new Map(checks.map((check) => [check.table, check]));
			expect(byTable.get("auth_credentials")).toEqual({ kind: "equal", table: "auth_credentials", rows: 2 });
			for (const table of PRUNED_TABLES) {
				expect(byTable.get(table)).toEqual({ kind: "equal", table, rows: 0 });
			}

			const host = new Database(path, { readonly: true });
			try {
				for (const table of PRUNED_TABLES) {
					const row = host.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM "${table}"`).get();
					expect(row?.count).toBe(1);
				}
			} finally {
				host.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("handles databases that only have a subset of PRUNED_TABLES", () => {
		withDb(["futureppo-pool"], (path) => {
			const image = snapshot(path);
			expect(compareImages(image, image)).toEqual([{ kind: "equal", table: "auth_credentials", rows: 1 }]);
		});
	});
});
