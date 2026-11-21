import { readFile } from "node:fs/promises";
import * as os from "node:os";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";

export async function declaresFlag(session: AgentSession | undefined, cwd: string, agentName: string, key: string): Promise<boolean> {
	try {
		const { agents } = await discoverAgents(cwd, os.homedir(), session?.effectiveExtensionRoots);
		const filePath = getAgent([...agents, ...(session?.getSessionAgents() ?? [])], agentName)?.filePath;
		if (filePath === undefined) return false;
		const { frontmatter } = parseFrontmatter(await readFile(filePath, "utf8"), { source: filePath, level: "fatal" });
		return frontmatter[key] === true;
	} catch {
		return false;
	}
}
