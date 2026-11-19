import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z, type zod } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { errorText } from "./errors.ts";

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
const manifestSchema = z
	.object({ name: z.literal(PLUGIN), omp: z.object({ settings: z.record(z.string(), settingSchema) }) })
	.passthrough();

type ManifestRead =
	| { readonly kind: "ok"; readonly defaults: ReadonlyMap<string, Scalar | undefined> }
	| { readonly kind: "invalid"; readonly reason: string };

let declared: ManifestRead | undefined;

function readManifest(): ManifestRead {
	const path = join(import.meta.dir, "package.json");
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { kind: "invalid", reason: `${path}: ${errorText(error)}` };
	}
	const parsed = manifestSchema.safeParse(json);
	if (!parsed.success)
		return {
			kind: "invalid",
			reason: `${path}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
		};
	return { kind: "ok", defaults: new Map(Object.entries(parsed.data.omp.settings).map(([key, setting]) => [key, setting.default])) };
}

function manifestDefaults(): ManifestRead {
	declared ??= readManifest();
	return declared;
}

export function defineSettings<T>(extensionDir: string, schema: zod.ZodLikeSchema<T>): SettingsSection<T> {
	return { id: basename(extensionDir), schema };
}

type Tree = { [key: string]: Scalar | Tree };

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

export async function readSettings<T>(section: SettingsSection<T>, scope: SettingsScope): Promise<SettingsRead<T>> {
	let stored: Record<string, unknown>;
	try {
		stored = await getPluginSettings(PLUGIN, scope.kind === "project" ? scope.cwd : "/");
	} catch (error) {
		return { kind: "invalid", reason: errorText(error) };
	}
	const manifest = manifestDefaults();
	if (manifest.kind === "invalid") return manifest;
	const prefix = `${section.id}.`;
	const raw: Tree = {};
	for (const [key, fallback] of manifest.defaults) {
		if (!key.startsWith(prefix)) continue;
		const value = Object.hasOwn(stored, key) ? stored[key] : fallback;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
			place(raw, key.slice(prefix.length).split("."), value);
		else if (value !== undefined) return { kind: "invalid", reason: `${key}: expected a string, number or boolean` };
	}
	const parsed = section.schema.safeParse(raw);
	if (parsed.success) return { kind: "ok", value: parsed.data };
	return {
		kind: "invalid",
		reason: parsed.error.issues.map((issue) => `${section.id}.${issue.path.join(".")}: ${issue.message}`).join("; "),
	};
}

export async function writeSetting(key: string, value: Scalar): Promise<void> {
	const manifest = manifestDefaults();
	if (manifest.kind === "invalid") throw new Error(`${PLUGIN}: ${manifest.reason}`);
	if (!manifest.defaults.has(key)) throw new Error(`${PLUGIN}: unknown setting ${key}`);
	await new PluginManager("/").setPluginSetting(PLUGIN, key, value);
}
