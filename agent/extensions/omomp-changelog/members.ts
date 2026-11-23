import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import type { InstalledPlugin } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import { errorText } from "../_shared/errors.ts";

export type Member = { readonly name: string; readonly version: string; readonly changelogPath: string };

type Discovered =
	| { readonly kind: "member"; readonly member: Member }
	| { readonly kind: "broken"; readonly name: string; readonly reason: string };

type Candidate = Discovered | { readonly kind: "other" };

const NO_PROJECT_OVERRIDES = "/";

const packageSchema = z.object({ omomp: z.unknown() });
const memberSchema = z.object({ version: z.string(), omomp: z.object({ changelog: z.string() }) });

function readCandidate(name: string, root: string): Candidate {
	const file = join(root, "package.json");
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { kind: "broken", name, reason: `${file}: ${errorText(error)}` };
	}
	const pkg = packageSchema.safeParse(json);
	if (!pkg.success || pkg.data.omomp === undefined) return { kind: "other" };
	const declared = memberSchema.safeParse(json);
	if (!declared.success) return { kind: "broken", name, reason: `${file}: expected a string version and omomp.changelog` };
	return {
		kind: "member",
		member: { name, version: declared.data.version, changelogPath: resolve(root, declared.data.omomp.changelog) },
	};
}

export async function discoverMembers(): Promise<
	{ readonly kind: "found"; readonly members: readonly Discovered[] } | { readonly kind: "failed"; readonly reason: string }
> {
	let plugins: InstalledPlugin[];
	try {
		plugins = await new PluginManager(NO_PROJECT_OVERRIDES).list();
	} catch (error) {
		return { kind: "failed", reason: errorText(error) };
	}
	const members: Discovered[] = [];
	for (const plugin of plugins) {
		const candidate = readCandidate(plugin.name, plugin.path);
		if (candidate.kind !== "other") members.push(candidate);
	}
	return { kind: "found", members };
}
