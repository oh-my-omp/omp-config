import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySnapshot } from "../agent/extensions/omp-config-autoupdate/omp-config-update.ts";

describe("omp-config-update migrations", () => {
	test("migrates tools.xdevDocs to tools.commandDocs and cleans up thinking-translator.json and deprecated extension dirs", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-config-mig-"));
		const source = join(root, "source");
		const agentDir = join(root, "agent");
		try {
			mkdirSync(join(source, "agent"), { recursive: true });
			writeFileSync(join(source, "agent", "config.yml"), "tools:\n  commandDocs: inline\n");

			mkdirSync(join(agentDir, "extensions", "task-tool-trim"), { recursive: true });
			mkdirSync(join(agentDir, "extensions", "fork-task"), { recursive: true });
			writeFileSync(join(agentDir, "config.yml"), "tools:\n  xdevDocs: catalog\n");
			writeFileSync(join(agentDir, "thinking-translator.json"), '{"enabled":true}\n');
			writeFileSync(join(agentDir, "extensions", "task-tool-trim", "index.ts"), "export default () => {};\n");

			const report = await applySnapshot({ source, agentDir, previousCommit: undefined, check: false, plugins: false });
			expect(report.errors).toEqual([]);
			expect(report.notes.some((note) => note.includes("migrated tools.xdevDocs to tools.commandDocs"))).toBe(true);

			const updatedConfig = Bun.YAML.parse(readFileSync(join(agentDir, "config.yml"), "utf8")) as {
				tools?: Record<string, unknown>;
			};
			expect(updatedConfig.tools?.xdevDocs).toBeUndefined();
			expect(updatedConfig.tools?.commandDocs).toBeDefined();

			expect(existsSync(join(agentDir, "thinking-translator.json"))).toBe(false);
			expect(existsSync(join(agentDir, "extensions", "task-tool-trim"))).toBe(false);
			expect(existsSync(join(agentDir, "extensions", "fork-task"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
