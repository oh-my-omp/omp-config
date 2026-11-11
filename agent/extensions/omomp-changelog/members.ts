import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import type { InstalledPlugin } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import { errorText } from "../_shared/errors.ts";

/** An installed package that declares `omomp.changelog`; `version` is the one in its package.json, not the registry's record. */
export type Member = { readonly name: string; readonly version: string; readonly changelogPath: string };

export type Discovery =
	| { readonly kind: "found"; readonly members: readonly Member[] }
	| { readonly kind: "failed"; readonly reason: string };

const packageSchema = z.object({ version: z.string(), omomp: z.unknown() });
const declarationSchema = z.object({ changelog: z.string() });

/** The member a plugin's package.json declares, or undefined for a package without a well-formed `omomp.changelog`. */
function readMember(name: string, root: string): Member | undefined {
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	} catch {
		// A package without a readable package.json declares nothing.
		return undefined;
	}
	const pkg = packageSchema.safeParse(json);
	if (!pkg.success) return undefined;
	const declaration = declarationSchema.safeParse(pkg.data.omomp);
	if (!declaration.success) return undefined;
	return { name, version: pkg.data.version, changelogPath: resolve(root, declaration.data.changelog) };
}

/** The installed members, enabled or not, read from the host's plugin list and each package's own package.json; nothing is cached. */
export async function discoverMembers(): Promise<Discovery> {
	let plugins: InstalledPlugin[];
	try {
		// Plugin enablement does not matter here, so the project does not matter either.
		plugins = await new PluginManager("/").list();
	} catch (error) {
		return { kind: "failed", reason: errorText(error) };
	}
	const members: Member[] = [];
	for (const plugin of plugins) {
		const member = readMember(plugin.name, plugin.path);
		if (member !== undefined) members.push(member);
	}
	return { kind: "found", members };
}
