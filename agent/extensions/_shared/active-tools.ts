import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Sets the session's active tools to `names`, listed in registration order
 * (`pi.getAllTools()`), so the tool list OMP builds is the same however the
 * set was reached. Names the registry does not know yet keep their given order
 * at the end; OMP resolves or drops them.
 */
export function applyActiveTools(pi: ExtensionAPI, names: Iterable<string>): Promise<void> {
	const pending = new Set(names);
	const ordered: string[] = [];
	for (const { name } of pi.getAllTools()) if (pending.delete(name)) ordered.push(name);
	return pi.setActiveTools([...ordered, ...pending]);
}
