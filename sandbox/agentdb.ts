// Host side of the agent.db copy (S2/S3). The snapshot is SQLite's serialization of a read-only
// connection: it is taken inside one read transaction, so it includes WAL frames not yet
// checkpointed into the main file, and it never touches the host disk. The comparison reads both
// images in memory and compares every field of every row; it reports counts and equality, never
// values or digests.
import { Database } from "bun:sqlite";

type Value = string | number | bigint | boolean | Uint8Array | null;

export type TableCheck =
	| { readonly kind: "equal"; readonly table: string; readonly rows: number }
	| { readonly kind: "differ"; readonly table: string; readonly detail: string };

/** A consistent image of `path`, marked as a rollback-journal database so `deserialize` accepts it. */
export function snapshot(path: string): Uint8Array {
	const db = new Database(path, { readonly: true });
	try {
		return asRollbackJournal(db.serialize());
	} finally {
		db.close();
	}
}

/** Header bytes 18 and 19 are the read/write format versions: 2 for WAL, 1 for a rollback journal. */
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

/** Compares every table of two images field by field. */
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
