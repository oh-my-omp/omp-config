import { Database } from "bun:sqlite";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TARGETS_FILE = join(import.meta.dir, "recorder-targets.json");
const READY_FILE = join(import.meta.dir, "recorder.ready");
const SINK_POINTER = join(import.meta.dir, ".requests-sink");
const FALLBACK_SINK = "/evidence/interactive.requests.jsonl";
const FIRST_PORT = 9400;

type Mapping = { readonly [key: string]: unknown };
const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);

export interface Target {
	readonly provider: string;
	readonly port: number;
	readonly upstream: string;
}

function providersOf(root: Mapping): Mapping {
	if (!isMapping(root.providers)) throw new Error("models.yml has no providers mapping");
	return root.providers;
}

function withoutBaseUrl(value: unknown): unknown {
	if (!isMapping(value)) return value;
	const { baseUrl: _baseUrl, ...rest } = value;
	return rest;
}

export function rewriteProviders(original: Mapping): { readonly targets: Target[]; readonly providers: Record<string, unknown> } {
	const targets: Target[] = [];
	const providers: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(original)) {
		if (isMapping(value) && typeof value.baseUrl === "string" && value.baseUrl !== "") {
			const port = FIRST_PORT + targets.length;
			const upstream = new URL(value.baseUrl);
			const prefix = upstream.pathname.replace(/\/+$/, "");
			targets.push({ provider: name, port, upstream: upstream.origin });
			providers[name] = { ...value, baseUrl: `http://127.0.0.1:${port}${prefix}` };
		} else {
			providers[name] = value;
		}
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
	throw new Error("usage: recorder.ts setup MODELS_YML | serve | prune-credentials AGENT_DB");
}

if (import.meta.main) main(process.argv.slice(2));
