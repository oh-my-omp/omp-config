import { join } from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { type ConfigLoad, defineOmompSection, loadOmompSection } from "./omomp.ts";

/**
 * The language of person-facing text (notifications, widgets, status lines,
 * command and tool labels, renderers, dialogs, overlays): omomp's common
 * discovery, shared with the omp plugins.
 *
 *   1. `OMOMP_LANG` when it is `en` or `zh` (any case);
 *   2. `language` of the `omomp-lang` section of the agent-dir omomp file;
 *   3. the first non-empty of LC_ALL, LC_MESSAGES and LANG: Chinese when it
 *      starts with `zh`, else English;
 *   4. English.
 *
 * The `omomp-lang` extension exports step 2 into `OMOMP_LANG` for consumers
 * that only read the environment (Pi-compatible plugins, child processes), so
 * steps 1 and 2 agree before and after it runs. Step 2 is read here as well
 * because OMP imports extensions concurrently and binds deferred ones after the
 * first frame: text produced before `omomp-lang` loads still follows omomp.yml.
 * The section is agent-global (a project `.omp/` copy is not read): the
 * language belongs to the process, like the environment variable. It is read
 * once per process, so a change applies from the next OMP start.
 *
 * Text sent to the model (prompts, steers, tool descriptions, tool-result
 * content) does not go through here.
 */

export type Language = "en" | "zh";

/** The environment variable that names the language explicitly. */
export const LANGUAGE_ENV = "OMOMP_LANG";

const sectionSchema = z.object({ language: z.enum(["en", "zh"]) }).strict();

/** The `omomp-lang` section: owned by the `omomp-lang` extension, read by every consumer. */
export const omompLangSection = defineOmompSection(join(import.meta.dir, "..", "omomp-lang"), sectionSchema);

export type ConfiguredLanguage = ConfigLoad<z.infer<typeof sectionSchema>>;

let configured: ConfiguredLanguage | undefined;

/** The agent-dir `omomp-lang` section, read on first use and kept for the life of the process. */
export function configuredLanguage(): ConfiguredLanguage {
	configured ??= loadOmompSection(omompLangSection, null);
	return configured;
}

/** `en` or `zh` when `value` names one (any case, surrounding space ignored). */
export function parseLanguage(value: string | undefined): Language | null {
	const normalized = value?.trim().toLowerCase();
	return normalized === "en" || normalized === "zh" ? normalized : null;
}

export function resolveLanguage(env: Readonly<Record<string, string | undefined>>, configuredValue: Language | null): Language {
	const explicit = parseLanguage(env[LANGUAGE_ENV]);
	if (explicit !== null) return explicit;
	if (configuredValue !== null) return configuredValue;
	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const value = env[key]?.trim();
		if (value) return value.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

export function language(): Language {
	const load = configuredLanguage();
	return resolveLanguage(process.env, load.kind === "found" ? load.value.language : null);
}

/** The text for the current language; both are written where the text is used, English first. */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
