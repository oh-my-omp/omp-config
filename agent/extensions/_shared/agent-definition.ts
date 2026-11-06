import { readFile } from "node:fs/promises";
import * as os from "node:os";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { parseFrontmatter, unquote } from "./spec-files.ts";

/**
 * Whether the agent definition named `agentName` sets the frontmatter flag
 * `key` (lowercase, e.g. `completionjudge`, `splitcheck`) to `true`. Resolved
 * with the lookup the task tool's spawn preflight uses: `discoverAgents` over
 * `cwd` and the session's extension roots plus the session's own agents, first
 * match wins. The host's parsed `AgentDefinition` drops unknown keys, so the
 * definition's `filePath` is read. Unresolvable or unreadable: false.
 */
export async function declaresFlag(session: AgentSession | undefined, cwd: string, agentName: string, key: string): Promise<boolean> {
	try {
		const { agents } = await discoverAgents(cwd, os.homedir(), session?.effectiveExtensionRoots);
		const filePath = getAgent([...agents, ...(session?.getSessionAgents() ?? [])], agentName)?.filePath;
		if (filePath === undefined) return false;
		const parsed = parseFrontmatter(await readFile(filePath, "utf8"));
		return parsed !== null && unquote(parsed.fields[key] ?? "").toLowerCase() === "true";
	} catch {
		// Unresolvable or unreadable definition: the flag is not set.
		return false;
	}
}
