import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z, type zod } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { errorText } from "./errors.ts";

/**
 * The settings of the omp-config extensions: OMP plugin settings of the local
 * plugin `omp-config`, whose manifest is `package.json` beside this module
 * (`omp.settings`; the updater links this directory with `omp plugin link`).
 * The manifest is the only list of keys, types and defaults; operators edit
 * the values in `/settings → Plugins → omp-config` or `omp plugin config`.
 *
 * Keys are `<extension>.<key>`, nested keys dotted (`tool-policy-nag.form.afterHits`).
 * `readSettings` takes every manifest key under the extension's prefix, uses the
 * stored value or else the manifest default, rebuilds the dotted remainder into
 * an object and parses it with the extension's schema. Stored keys the manifest
 * does not declare are ignored. Values are read through the host on every call.
 *
 * Scopes: `project` merges the project's `.omp/plugin-overrides.json` over the
 * machine values (the host's own rule); `machine` reads with cwd `/`, so only
 * the machine-admin `/.omp/plugin-overrides.json` can override, for settings a
 * project must not change (consent, the language of the process).
 */

export const PLUGIN = "omp-config";

export type SettingsScope = { readonly kind: "project"; readonly cwd: string } | { readonly kind: "machine" };

export type SettingsSection<T> = { readonly id: string; readonly schema: zod.ZodLikeSchema<T> };

export type SettingsRead<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "invalid"; readonly reason: string };

type Scalar = string | number | boolean;

const settingSchema = z.union([
	z.object({ type: z.literal("string"), default: z.string().optional() }).passthrough(),
	z.object({ type: z.literal("number"), default: z.number().optional() }).passthrough(),
	z.object({ type: z.literal("boolean"), default: z.boolean().optional() }).passthrough(),
	z.object({ type: z.literal("enum"), values: z.array(z.string()), default: z.string().optional() }).passthrough(),
]);
const manifestSchema = z.object({ name: z.literal(PLUGIN), omp: z.object({ settings: z.record(z.string(), settingSchema) }) }).passthrough();

/** Manifest key → default (undefined without one); read once per process, the file ships with this module. */
let declared: ReadonlyMap<string, Scalar | undefined> | undefined;

function manifestDefaults(): ReadonlyMap<string, Scalar | undefined> {
	declared ??= new Map(
		Object.entries(manifestSchema.parse(JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"))).omp.settings).map(
			([key, setting]) => [key, setting.default],
		),
	);
	return declared;
}

/** Bind an extension's settings type to its key prefix. `extensionDir` is `import.meta.dir`. */
export function defineSettings<T>(extensionDir: string, schema: zod.ZodLikeSchema<T>): SettingsSection<T> {
	return { id: basename(extensionDir), schema };
}

/** Settings rebuilt from dotted keys: `form.afterHits` → `{ form: { afterHits } }`. */
type Tree = { [key: string]: Scalar | Tree };

/** Set `value` at the dotted `path` of `target`, creating the objects on the way. */
function place(target: Tree, path: readonly string[], value: Scalar): void {
	const [head, ...rest] = path;
	if (head === undefined) return;
	if (rest.length === 0) {
		target[head] = value;
		return;
	}
	const existing = target[head];
	const child: Tree = typeof existing === "object" ? existing : {};
	target[head] = child;
	place(child, rest, value);
}

/** The section's settings: stored values over manifest defaults, parsed with its schema. */
export async function readSettings<T>(section: SettingsSection<T>, scope: SettingsScope): Promise<SettingsRead<T>> {
	let stored: Record<string, unknown>;
	try {
		stored = await getPluginSettings(PLUGIN, scope.kind === "project" ? scope.cwd : "/");
	} catch (error) {
		return { kind: "invalid", reason: errorText(error) };
	}
	const prefix = `${section.id}.`;
	const raw: Tree = {};
	for (const [key, fallback] of manifestDefaults()) {
		if (!key.startsWith(prefix)) continue;
		const value = Object.hasOwn(stored, key) ? stored[key] : fallback;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") place(raw, key.slice(prefix.length).split("."), value);
		else if (value !== undefined) return { kind: "invalid", reason: `${key}: expected a string, number or boolean` };
	}
	const parsed = section.schema.safeParse(raw);
	if (parsed.success) return { kind: "ok", value: parsed.data };
	return {
		kind: "invalid",
		reason: parsed.error.issues.map((issue) => `${section.id}.${issue.path.join(".")}: ${issue.message}`).join("; "),
	};
}

/** Store one machine value (`<extension>.<key>`), as `omp plugin config set` would. */
export async function writeSetting(key: string, value: Scalar): Promise<void> {
	if (!manifestDefaults().has(key)) throw new Error(`${PLUGIN}: unknown setting ${key}`);
	await new PluginManager("/").setPluginSetting(PLUGIN, key, value);
}
