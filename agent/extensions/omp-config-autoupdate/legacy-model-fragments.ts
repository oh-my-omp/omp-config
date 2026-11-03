// One-time host migration from the former APPEND_SYSTEM_MODEL.md block format.
// Keep its YAML/regex validation here: the extension no longer reads that format.
import { isMapping } from "./merge.ts";

type MatchField = "model" | "provider";
interface Constraint {
	readonly field: MatchField;
	readonly source: string;
}

type Header =
	| { readonly kind: "ok"; readonly constraints: readonly Constraint[] }
	| { readonly kind: "invalid"; readonly reason: string };

type ParsedFragments =
	| { readonly kind: "ok"; readonly fragments: readonly string[] }
	| { readonly kind: "invalid"; readonly reason: string };

function parseHeader(text: string): Header {
	let data: unknown;
	try {
		data = Bun.YAML.parse(text);
	} catch (error) {
		return { kind: "invalid", reason: `invalid YAML header: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!isMapping(data)) return { kind: "invalid", reason: "header must set `model` and/or `provider`" };
	const constraints: Constraint[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (key !== "model" && key !== "provider") {
			return { kind: "invalid", reason: `unknown header key \`${key}\` (allowed: model, provider)` };
		}
		if (typeof value !== "string" || value.trim() === "") {
			return { kind: "invalid", reason: `\`${key}\` must be a non-empty regex string` };
		}
		try {
			new RegExp(value);
		} catch (error) {
			return { kind: "invalid", reason: `\`${key}\` is not a valid regex: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (value !== value.trim() || /[\r\n]/.test(value)) {
			return { kind: "invalid", reason: `\`${key}\` cannot be preserved in single-line fragment frontmatter` };
		}
		constraints.push({ field: key, source: value });
	}
	if (constraints.length === 0) return { kind: "invalid", reason: "header must set `model` and/or `provider`" };
	return { kind: "ok", constraints };
}

export function parseLegacyModelFragments(source: string): ParsedFragments {
	const segments: { start: number; lines: string[] }[] = [{ start: 1, lines: [] }];
	source
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/)
		.forEach((line, index) => {
			if (/^---[ \t]*$/.test(line)) segments.push({ start: index + 2, lines: [] });
			else segments[segments.length - 1]!.lines.push(line);
		});
	const [preamble, ...rest] = segments;
	if (preamble!.lines.some((line) => line.trim() !== "")) {
		return { kind: "invalid", reason: "line 1: content before the first `---` header" };
	}
	if (rest.length % 2 !== 0) {
		return {
			kind: "invalid",
			reason: `line ${rest[rest.length - 1]!.start - 1}: \`---\` opens a header that is never closed (a body cannot contain a bare \`---\` line)`,
		};
	}
	const fragments: string[] = [];
	for (let i = 0; i < rest.length; i += 2) {
		const line = rest[i]!.start - 1;
		const header = parseHeader(rest[i]!.lines.join("\n"));
		if (header.kind === "invalid") return { kind: "invalid", reason: `line ${line}: ${header.reason}` };
		const body = rest[i + 1]!.lines.join("\n").trim();
		if (body === "") return { kind: "invalid", reason: `line ${line}: block has an empty body` };
		// The fragment reader strips one outer quote pair without decoding escapes.
		const fields = header.constraints.map(({ field, source: pattern }) => `${field}: "${pattern}"`);
		fragments.push(["---", "target: *", ...fields, "---", body, ""].join("\n"));
	}
	return { kind: "ok", fragments };
}
