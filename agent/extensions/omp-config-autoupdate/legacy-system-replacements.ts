// One-time conversion of the former omomp system-prompt-replace section.
import { isMapping } from "./merge.ts";

type Match = { readonly literal: string } | { readonly regex: string };
type Rule = Match & { readonly replace: string; readonly target?: "subagents"; readonly mode: "full" };
type Conversion = { readonly kind: "ok"; readonly text: string } | { readonly kind: "invalid"; readonly reason: string };

function scalar(value: string): string {
	if (value.includes("\n")) {
		const suffix = value.endsWith("\n\n") ? "+" : value.endsWith("\n") ? "" : "-";
		const body = value.endsWith("\n") ? value.slice(0, -1) : value;
		const block = `|2${suffix}\n${body
			.split("\n")
			.map((line) => `    ${line}`)
			.join("\n")}\n`;
		try {
			if (Bun.deepEquals(Bun.YAML.parse(`  value: ${block}`), { value })) return block;
		} catch {
			// YAML cannot represent every string as a block; quoted JSON scalars can.
		}
	}
	return `${JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

export function convertLegacySystemReplacements(value: unknown): Conversion {
	if (!isMapping(value) || Object.keys(value).some((key) => key !== "replacements") || !Array.isArray(value.replacements))
		return { kind: "invalid", reason: "section must contain only a replacements array" };
	const rules: Rule[] = [];
	for (const [index, input] of value.replacements.entries()) {
		const invalid = (reason: string): Conversion => ({ kind: "invalid", reason: `replacement ${index + 1}: ${reason}` });
		if (!isMapping(input)) return invalid("rule must be a mapping");
		if (Object.keys(input).some((key) => !["literal", "regex", "replace", "scope"].includes(key))) return invalid("unknown rule key");
		if (Object.hasOwn(input, "literal") === Object.hasOwn(input, "regex")) return invalid("set exactly one of literal or regex");
		const pattern = Object.hasOwn(input, "literal") ? input.literal : input.regex;
		if (typeof pattern !== "string" || pattern.length === 0) return invalid("pattern must be a non-empty string");
		if (typeof input.replace !== "string") return invalid("replace must be a string");
		if (input.scope !== undefined && input.scope !== "all" && input.scope !== "sub") return invalid("scope must be all or sub");
		if (Object.hasOwn(input, "regex")) {
			try {
				new RegExp(pattern);
			} catch {
				return invalid("regex is invalid");
			}
		}
		const match: Match = Object.hasOwn(input, "literal") ? { literal: pattern } : { regex: pattern };
		rules.push({ ...match, replace: input.replace, ...(input.scope === "sub" ? { target: "subagents" as const } : {}), mode: "full" });
	}
	const text =
		rules.length === 0
			? "[]\n"
			: rules
					.map((rule) =>
						Object.entries(rule)
							.map(([key, entry], index) => `${index === 0 ? "- " : "  "}${key}: ${scalar(entry)}`)
							.join(""),
					)
					.join("");
	try {
		if (!Bun.deepEquals(Bun.YAML.parse(text), rules)) return { kind: "invalid", reason: "serialized rules do not round-trip" };
	} catch {
		return { kind: "invalid", reason: "serialized rules do not round-trip" };
	}
	return { kind: "ok", text };
}

export function removeLegacyReplacementSection(text: string, root: Readonly<Record<string, unknown>>): Conversion {
	const lines = text.split(/(?<=\n)/);
	const starts = lines.flatMap((line, index) => (/^system-prompt-replace:[ \t]*(?:#.*)?\r?\n?$/.test(line) ? [index] : []));
	if (starts.length !== 1) return { kind: "invalid", reason: "section is not one direct top-level YAML block" };
	const start = starts[0]!;
	let end = start + 1;
	while (end < lines.length && (/^[ \t]/.test(lines[end]!) || /^[\r\n]*$/.test(lines[end]!))) end++;
	const remaining = [...lines.slice(0, start), ...lines.slice(end)].join("");
	const expected = { ...root };
	delete expected["system-prompt-replace"];
	try {
		const parsed: unknown = Bun.YAML.parse(remaining);
		if (Bun.deepEquals(parsed ?? {}, expected)) return { kind: "ok", text: parsed == null ? `${remaining}{}\n` : remaining };
	} catch {
		// Anchors, flow mappings and other ambiguous layouts must be moved by hand.
	}
	return { kind: "invalid", reason: "removing the section would change other YAML values" };
}
