import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";

const [mode, target] = process.argv.slice(2);
if (target === undefined || (mode !== "in" && mode !== "out")) {
	process.stderr.write("usage: db.ts <in|out> TARGET\n");
	process.exit(2);
}

if (mode === "in") {
	writeFileSync(target, await Bun.stdin.bytes(), { mode: 0o600 });
	const db = new Database(target);
	db.run("pragma journal_mode=wal");
	const row = db.query("pragma integrity_check").get();
	db.close();
	const integrity = typeof row === "object" && row !== null && "integrity_check" in row ? String(row.integrity_check) : "no result";
	process.stdout.write(`${integrity}\n`);
	process.exit(integrity === "ok" ? 0 : 1);
} else {
	const db = new Database(target, { readonly: true });
	const image = db.serialize();
	db.close();
	process.stdout.write(image);
}
