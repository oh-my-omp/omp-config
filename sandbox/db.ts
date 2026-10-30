// Container side of the agent.db copy (S2/S3). Runs as `bun /sandbox/db.ts <in|out> TARGET`.
//   in   Reads a serialized SQLite image from stdin and writes it to TARGET byte for byte, so
//        every page and rowid stays as the host snapshot had it. The image arrives marked as a
//        rollback-journal database (sandbox/agentdb.ts); TARGET is switched back to WAL like the
//        host's. Prints `integrity_check`'s result; exits 1 unless it is "ok".
//   out  Writes TARGET's serialized image to stdout, for the host's field-by-field comparison.
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
