// Model-request recorder (#146), run inside the sandbox:
//   bun /sandbox/recorder.ts setup MODELS_YML     (once, before any omp session)
//   bun /sandbox/recorder.ts serve                (long-running; one listener per provider)
//
// `setup` gives every provider that declares a `baseUrl` a loopback URL (`http://127.0.0.1:<9400+i>`)
// followed by the provider's baseUrl path (`/v1` and the like), so clients send the same request
// paths as to the upstream, and writes the mapping to /sandbox/recorder-targets.json. Nothing else
// changes: the rewritten document is re-parsed and
// every provider must equal its original in all fields except `baseUrl`, so `apiKey` and the rest
// keep their values. Comments are not kept (the file exists only inside the container).
//
// `serve` listens on each target port. For every request it appends one line to the evidence file
// named by /sandbox/.requests-sink (falling back to /evidence/interactive.requests.jsonl):
//   {"seq","provider","tools","body"}
// `tools` lists each body `tools[]` entry's `name`, else `function.name`; `[]` when absent.
// Credentials are never recorded, only the body. The request is then forwarded to the recorded
// upstream with method, path, query, headers and body unchanged (`host` and `content-length` are
// left to fetch), and the response is streamed back.
//
// /sandbox/recorder.ready is written after every listener is bound; sandbox.ts waits for it.
//
// `prune-credentials AGENT_DB` removes, from the container's copy of agent.db, every auth_credentials
// row whose provider has no recorder target: such a provider's requests would bypass the recorder.
// It then checks that every remaining row's provider has a target, and prints counts and provider
// names only.
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

/** A provider mapping without its `baseUrl`, to compare everything else. */
function withoutBaseUrl(value: unknown): unknown {
	if (!isMapping(value)) return value;
	const { baseUrl: _baseUrl, ...rest } = value;
	return rest;
}

/**
 * Pure part of `rewriteBaseUrls`. The rewritten `baseUrl` keeps the original path (`/v1` and the
 * like), because the client appends its request paths to it. The target keeps only the upstream
 * origin, because `serve` appends the request path, which already carries that prefix.
 */
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

/** The URL `serve` forwards a request to: the upstream origin plus the request's path and query. */
export function forwardUrl(target: Target, request: URL): string {
	return `${target.upstream}${request.pathname}${request.search}`;
}

/**
 * Rewrites each provider's `baseUrl` in `path` to its recorder port and writes the targets file.
 * Throws, leaving `path` untouched, unless the re-parsed result matches the original everywhere
 * except `baseUrl`.
 */
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

/**
 * Deletes the auth_credentials rows whose provider is not in `providers` (the recorded ones) from
 * the database at `path`, then throws unless every remaining row's provider is in `providers`.
 */
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
	} catch {
		// No driver has named a sink: the fallback applies.
	}
	return FALLBACK_SINK;
}

/** `tools` of a request body: each entry's `name`, else `function.name`. */
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
					} catch {
						// Not JSON: recorded as sent.
					}
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
