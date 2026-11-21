import { Database } from "bun:sqlite";

type Value = string | number | bigint | boolean | Uint8Array | null;

export type TableCheck =
	| { readonly kind: "equal"; readonly table: string; readonly rows: number }
	| { readonly kind: "differ"; readonly table: string; readonly detail: string };

export const PRUNED_TABLES = [
	"cache",
	"client_usage",
	"command_usage",
	"model_perf",
	"model_usage",
	"usage_cost_history",
	"usage_history",
] as const;

export function snapshot(path: string): Uint8Array {
	const db = new Database(path, { readonly: true });
	let raw: Uint8Array;
	try {
		raw = db.serialize();
	} finally {
		db.close();
	}
	const mem = Database.deserialize(asRollbackJournal(raw));
	try {
		const existing = new Set(tables(mem));
		let pruned = false;
		for (const table of PRUNED_TABLES) {
			if (!existing.has(table)) continue;
			mem.run(`DELETE FROM "${table.replaceAll('"', '""')}"`);
			pruned = true;
		}
		if (pruned) mem.run("VACUUM");
		return asRollbackJournal(mem.serialize());
	} finally {
		mem.close();
	}
}

export function asRollbackJournal(image: Uint8Array): Uint8Array {
	const copy = new Uint8Array(image);
	copy[18] = 1;
	copy[19] = 1;
	return copy;
}

function tables(db: Database): string[] {
	return db
		.query("select name from sqlite_master where type = 'table' order by name")
		.values()
		.map((row) => String(row[0]));
}

function rowsOf(db: Database, table: string): Value[][] {
	const quoted = `"${table.replaceAll('"', '""')}"`;
	const width = db.query(`select * from ${quoted} limit 0`).columnNames.length;
	const order = Array.from({ length: width }, (_, index) => index + 1).join(", ");
	return db
		.query(`select * from ${quoted}${width > 0 ? ` order by ${order}` : ""}`)
		.safeIntegers(true)
		.values() as Value[][]; // bun:sqlite types rows as unknown[]; SQLite yields only these storage classes.
}

function sameValue(a: Value | undefined, b: Value | undefined): boolean {
	if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((byte, index) => byte === b[index]);
	return a === b;
}

export function compareImages(host: Uint8Array, container: Uint8Array): TableCheck[] {
	const left = Database.deserialize(asRollbackJournal(host), true);
	const right = Database.deserialize(asRollbackJournal(container), true);
	try {
		const names = tables(left);
		const otherNames = tables(right);
		const checks: TableCheck[] = otherNames
			.filter((name) => !names.includes(name))
			.map((name) => ({ kind: "differ", table: name, detail: "table exists only in the container copy" }));
		for (const table of names) {
			if (!otherNames.includes(table)) {
				checks.push({ kind: "differ", table, detail: "table missing from the container copy" });
				continue;
			}
			const a = rowsOf(left, table);
			const b = rowsOf(right, table);
			if (a.length !== b.length) {
				checks.push({ kind: "differ", table, detail: `${a.length} rows on the host, ${b.length} in the container` });
				continue;
			}
			const firstDiff = a.findIndex((row, index) => {
				const other = b[index];
				return other === undefined || row.length !== other.length || row.some((value, column) => !sameValue(value, other[column]));
			});
			checks.push(
				firstDiff < 0
					? { kind: "equal", table, rows: a.length }
					: { kind: "differ", table, detail: `row ${firstDiff + 1} (sorted) differs` },
			);
		}
		return checks;
	} finally {
		left.close();
		right.close();
	}
}
