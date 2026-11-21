import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TARGETS_FILE = join(import.meta.dir, "recorder-targets.json");
const READY_FILE = join(import.meta.dir, "recorder.ready");
const SINK_POINTER = join(import.meta.dir, ".requests-sink");
const FALLBACK_SINK = "/evidence/interactive.requests.jsonl";
const FIRST_PORT = 9400;

type Mapping = { readonly [key: string]: unknown };
const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

export interface Target {
	readonly provider: string;
	readonly port: number;
	readonly upstream: string;
}

function providersOf(root: Mapping): Mapping {
	if (!isMapping(root.providers)) throw new Error("models.yml has no providers mapping");
	return root.providers;
}

function stripBaseUrl(value: unknown): unknown {
	if (!isMapping(value)) return value;
	const { baseUrl: _baseUrl, ...rest } = value;
	return rest;
}

function withoutBaseUrl(value: unknown): unknown {
	if (!isMapping(value)) return value;
	const { baseUrl: _baseUrl, ...rest } = value;
	const out: Record<string, unknown> = { ...rest };
	if (Array.isArray(value.models)) {
		out.models = value.models.map((entry) => stripBaseUrl(entry));
	}
	if (isMapping(value.modelOverrides)) {
		out.modelOverrides = Object.fromEntries(
			Object.entries(value.modelOverrides).map(([modelId, override]) => [modelId, stripBaseUrl(override)]),
		);
	}
	return out;
}

export function rewriteProviders(original: Mapping): { readonly targets: Target[]; readonly providers: Record<string, unknown> } {
	const targets: Target[] = [];
	const providers: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(original)) {
		if (!isMapping(value)) {
			providers[name] = value;
			continue;
		}
		const byOrigin = new Map<string, Target>();
		const rewriteUrl = (raw: string): string => {
			const upstream = new URL(raw);
			const prefix = upstream.pathname.replace(/\/+$/, "");
			let target = byOrigin.get(upstream.origin);
			if (target === undefined) {
				target = { provider: name, port: FIRST_PORT + targets.length, upstream: upstream.origin };
				targets.push(target);
				byOrigin.set(upstream.origin, target);
			}
			return `http://127.0.0.1:${target.port}${prefix}`;
		};
		let changed = false;
		const next: Record<string, unknown> = { ...value };
		if (isNonEmptyString(value.baseUrl)) {
			next.baseUrl = rewriteUrl(value.baseUrl);
			changed = true;
		}
		if (Array.isArray(value.models)) {
			let modelsChanged = false;
			const rewrittenModels = value.models.map((entry) => {
				if (isMapping(entry) && isNonEmptyString(entry.baseUrl)) {
					modelsChanged = true;
					return { ...entry, baseUrl: rewriteUrl(entry.baseUrl) };
				}
				return entry;
			});
			if (modelsChanged) {
				next.models = rewrittenModels;
				changed = true;
			}
		}
		if (isMapping(value.modelOverrides)) {
			let overridesChanged = false;
			const rewrittenOverrides: Record<string, unknown> = {};
			for (const [modelId, override] of Object.entries(value.modelOverrides)) {
				if (isMapping(override) && isNonEmptyString(override.baseUrl)) {
					overridesChanged = true;
					rewrittenOverrides[modelId] = { ...override, baseUrl: rewriteUrl(override.baseUrl) };
				} else {
					rewrittenOverrides[modelId] = override;
				}
			}
			if (overridesChanged) {
				next.modelOverrides = rewrittenOverrides;
				changed = true;
			}
		}
		providers[name] = changed ? next : value;
	}
	return { targets, providers };
}

export function forwardUrl(target: Target, request: URL): string {
	return `${target.upstream}${request.pathname}${request.search}`;
}

export function rewriteBaseUrls(path: string): Target[] {
	const root = Bun.YAML.parse(readFileSync(path, "utf8"));
	if (!isMapping(root)) throw new Error("models.yml root is not a mapping");
	const original = providersOf(root);
	const { targets, providers } = rewriteProviders(original);
	if (targets.length === 0) {
		writeFileSync(TARGETS_FILE, "[]\n");
		return targets;
	}

	const text = Bun.YAML.stringify({ ...root, providers });
	const check = providersOf(Bun.YAML.parse(text) as Mapping);
	for (const name of Object.keys(original)) {
		if (!Bun.deepEquals(withoutBaseUrl(check[name]), withoutBaseUrl(original[name])))
			throw new Error(`models.yml rewrite changed provider ${name} beyond baseUrl`);
	}
	writeFileSync(path, text);
	writeFileSync(TARGETS_FILE, `${JSON.stringify(targets, null, 2)}\n`);
	return targets;
}

function readTargets(): Target[] {
	const parsed: unknown = JSON.parse(readFileSync(TARGETS_FILE, "utf8"));
	if (!Array.isArray(parsed)) throw new Error(`${TARGETS_FILE} is not an array`);
	return parsed as Target[];
}

export function pruneCredentials(path: string, providers: readonly string[]): { readonly removed: number; readonly kept: string[] } {
	const db = new Database(path, { create: false });
	try {
		const { changes } = db
			.query("DELETE FROM auth_credentials WHERE provider NOT IN (SELECT value FROM json_each(?1))")
			.run(JSON.stringify(providers));
		const kept = db
			.query<{ provider: string }, []>("SELECT DISTINCT provider FROM auth_credentials ORDER BY provider")
			.all()
			.map((row) => row.provider);
		const outside = kept.filter((provider) => !providers.includes(provider));
		if (outside.length > 0) throw new Error(`auth_credentials still holds provider(s) without a recorder target: ${outside.join(", ")}`);
		return { removed: changes, kept };
	} finally {
		db.close();
	}
}

export function pruneConfig(
	text: string,
	providers: readonly string[],
	fileExists: (path: string) => boolean = existsSync,
): { readonly text: string; readonly prunedRoles: string[]; readonly prunedOverrides: string[] } {
	const parsed = Bun.YAML.parse(text);
	if (!isMapping(parsed)) return { text, prunedRoles: [], prunedOverrides: [] };
	const allowed = new Set(providers);
	const keepSelector = (token: string, keptRoles?: ReadonlySet<string>): boolean => {
		const trimmed = token.trim();
		if (trimmed === "") return false;
		const slash = trimmed.indexOf("/");
		const colon = trimmed.lastIndexOf(":");
		const selector = colon > slash && colon >= 0 ? trimmed.slice(0, colon) : trimmed;
		if (keptRoles !== undefined && selector.startsWith("@")) return keptRoles.has(selector.slice(1));
		const sep = selector.indexOf("/");
		return sep < 0 ? true : allowed.has(selector.slice(0, sep));
	};
	const filterSelectorList = (raw: string, keptRoles?: ReadonlySet<string>): string | undefined => {
		const kept = raw
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item !== "" && keepSelector(item, keptRoles));
		return kept.length === 0 ? undefined : kept.join(", ");
	};

	const root: Record<string, unknown> = { ...parsed };
	const prunedRoles: string[] = [];
	const prunedOverrides: string[] = [];
	let keptRoles = new Set<string>();

	if (isMapping(root.modelRoles)) {
		const nextRoles: Record<string, unknown> = { ...root.modelRoles };
		for (const [role, val] of Object.entries(root.modelRoles)) {
			if (typeof val !== "string") continue;
			const filtered = filterSelectorList(val);
			if (filtered === undefined) {
				delete nextRoles[role];
				prunedRoles.push(role);
			} else {
				nextRoles[role] = filtered;
			}
		}
		keptRoles = new Set(Object.keys(nextRoles));
		root.modelRoles = nextRoles;
	}

	if (isMapping(root.task) && isMapping(root.task.agentModelOverrides)) {
		const nextOverrides: Record<string, unknown> = { ...root.task.agentModelOverrides };
		for (const [agent, val] of Object.entries(root.task.agentModelOverrides)) {
			if (typeof val !== "string") continue;
			const filtered = filterSelectorList(val, keptRoles);
			if (filtered === undefined) {
				delete nextOverrides[agent];
				prunedOverrides.push(agent);
			} else {
				nextOverrides[agent] = filtered;
			}
		}
		root.task = { ...root.task, agentModelOverrides: nextOverrides };
	}

	if (isMapping(root.retry) && isMapping(root.retry.fallbackChains)) {
		const nextChains: Record<string, unknown> = { ...root.retry.fallbackChains };
		for (const [chain, list] of Object.entries(root.retry.fallbackChains)) {
			if (!Array.isArray(list)) continue;
			nextChains[chain] = list.filter((item): item is string => typeof item === "string" && keepSelector(item, keptRoles));
		}
		root.retry = { ...root.retry, fallbackChains: nextChains };
	}

	if (isMapping(root.exec) && typeof root.exec.initFile === "string" && !fileExists(root.exec.initFile)) {
		const { initFile: _initFile, ...restExec } = root.exec;
		root.exec = restExec;
	}

	const yaml = Bun.YAML.stringify(root, null, 2);
	return { text: yaml.endsWith("\n") ? yaml : `${yaml}\n`, prunedRoles, prunedOverrides };
}

function sinkPath(): string {
	try {
		const named = readFileSync(SINK_POINTER, "utf8").trim();
		if (named !== "") return named;
	} catch {}
	return FALLBACK_SINK;
}

export function toolNamesOf(body: unknown): string[] {
	if (!isMapping(body) || !Array.isArray(body.tools)) return [];
	const names: string[] = [];
	for (const tool of body.tools) {
		if (!isMapping(tool)) continue;
		if (typeof tool.name === "string") names.push(tool.name);
		else if (isMapping(tool.function) && typeof tool.function.name === "string") names.push(tool.function.name);
	}
	return names;
}

function serve(targets: readonly Target[]): void {
	let seq = 0;
	for (const target of targets) {
		Bun.serve({
			hostname: "127.0.0.1",
			port: target.port,
			async fetch(request) {
				const url = new URL(request.url);
				const bytes = new Uint8Array(await request.arrayBuffer());
				const text = new TextDecoder().decode(bytes);
				let body: unknown = text;
				if (text !== "") {
					try {
						body = JSON.parse(text);
					} catch {}
				}
				const record = { seq: ++seq, provider: target.provider, tools: toolNamesOf(body), body };
				try {
					appendFileSync(sinkPath(), `${JSON.stringify(record)}\n`);
				} catch (error) {
					return new Response(`recorder could not write evidence: ${String(error)}`, { status: 500 });
				}
				const headers = new Headers(request.headers);
				headers.delete("host");
				headers.delete("content-length");
				let upstream: Response;
				try {
					upstream = await fetch(forwardUrl(target, url), {
						method: request.method,
						headers,
						body: request.method === "GET" || request.method === "HEAD" ? undefined : bytes,
					});
				} catch (error) {
					return new Response(`recorder upstream unreachable: ${String(error)}`, { status: 502 });
				}
				const responseHeaders = new Headers(upstream.headers);
				for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) responseHeaders.delete(name);
				return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
			},
		});
	}
	writeFileSync(READY_FILE, `${targets.length} listener(s)\n`);
}

function main(argv: readonly string[]): void {
	const [command, arg] = argv;
	if (command === "setup" && arg !== undefined) {
		const targets = rewriteBaseUrls(arg);
		console.log(`recorder: ${targets.length} provider(s) on ports ${targets.map((t) => t.port).join(", ") || "none"}`);
		return;
	}
	if (command === "serve") {
		const targets = readTargets();
		serve(targets);
		console.log(`recorder: serving ${targets.length} provider(s)`);
		return;
	}
	if (command === "prune-credentials" && arg !== undefined) {
		const { removed, kept } = pruneCredentials(
			arg,
			readTargets().map((target) => target.provider),
		);
		console.log(`recorder: removed ${removed} auth_credentials row(s); kept provider(s) ${kept.join(", ") || "none"}`);
		return;
	}
	if (command === "prune-config" && arg !== undefined) {
		if (!existsSync(arg)) {
			console.log("recorder: pruned 0 role(s), 0 agent override(s)");
			return;
		}
		const { text, prunedRoles, prunedOverrides } = pruneConfig(
			readFileSync(arg, "utf8"),
			readTargets().map((target) => target.provider),
		);
		writeFileSync(arg, text);
		console.log(`recorder: pruned ${prunedRoles.length} role(s), ${prunedOverrides.length} agent override(s)`);
		return;
	}
	throw new Error("usage: recorder.ts setup MODELS_YML | serve | prune-credentials AGENT_DB | prune-config CONFIG_YML");
}

if (import.meta.main) main(process.argv.slice(2));
