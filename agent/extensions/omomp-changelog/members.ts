import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import type { InstalledPlugin } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import { errorText } from "../_shared/errors.ts";

export type Member = { readonly name: string; readonly version: string; readonly changelogPath: string };

export type Discovery =
	| { readonly kind: "found"; readonly members: readonly Member[] }
	| { readonly kind: "failed"; readonly reason: string };

const packageSchema = z.object({ version: z.string(), omomp: z.unknown() });
const declarationSchema = z.object({ changelog: z.string() });

function readMember(name: string, root: string): Member | undefined {
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	} catch {
		return undefined;
	}
	const pkg = packageSchema.safeParse(json);
	if (!pkg.success) return undefined;
	const declaration = declarationSchema.safeParse(pkg.data.omomp);
	if (!declaration.success) return undefined;
	return { name, version: pkg.data.version, changelogPath: resolve(root, declaration.data.changelog) };
}

export async function discoverMembers(): Promise<Discovery> {
	let plugins: InstalledPlugin[];
	try {
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
