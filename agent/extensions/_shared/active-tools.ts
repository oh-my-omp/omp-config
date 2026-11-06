import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Sets the session's active tools to `names` in canonical order (contract
 * §D4.1 of oh-my-omp/omp-config#158), so the list OMP builds depends only on
 * the tool set, never on the order extensions registered in. Built-in tools
 * from `pi.getAllTools()` come first, in that registry order; every other
 * requested name (extension, SDK, MCP, or unknown to the registry) follows,
 * sorted by plain string comparison and deduplicated. OMP resolves or drops
 * unknown names. Calls `pi.setActiveTools` once.
 */
export function applyActiveTools(pi: ExtensionAPI, names: Iterable<string>): Promise<void> {
	const rest = new Set(names);
	const builtins: string[] = [];
	for (const { name, sourceInfo } of pi.getAllTools()) {
		if (sourceInfo.source === "builtin" && rest.delete(name)) builtins.push(name);
	}
	const others = [...rest].sort(compareStrings);
	return pi.setActiveTools([...builtins, ...others]);
}

function compareStrings(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
