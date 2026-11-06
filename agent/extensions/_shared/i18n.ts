import { join } from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { defineSettings, readSettings } from "./plugin-settings.ts";

/**
 * The language of person-facing text (notifications, widgets, status lines,
 * command and tool labels, renderers, dialogs, overlays): the `omomp-lang`
 * extension's plugin setting `omomp-lang.language` (`en` | `zh`; default `zh`),
 * shared with the omp plugins. Operators change it in
 * `/settings → Plugins → omp-config` or with `omp plugin config`.
 *
 *   1. `OMOMP_LANG` when it is `en` or `zh` (any case);
 *   2. `omomp-lang.language` (machine scope: a project override is not read —
 *      the language belongs to the process, like the environment variable);
 *   3. only when the setting cannot be read, the first non-empty of LC_ALL,
 *      LC_MESSAGES and LANG: Chinese when it starts with `zh`, else English;
 *   4. English.
 *
 * The `omomp-lang` extension exports step 2 into `OMOMP_LANG` for consumers
 * that only read the environment (Pi-compatible plugins, child processes), so
 * steps 1 and 2 agree before and after it runs. Step 2 is read here as well
 * because OMP imports extensions concurrently and binds deferred ones after the
 * first frame: text produced before `omomp-lang` loads still follows the
 * setting. It is read once per process (top-level `await` at module load), so
 * a change applies from the next OMP start.
 *
 * Text sent to the model (prompts, steers, tool descriptions, tool-result
 * content) does not go through here.
 */

type Language = "en" | "zh";

/** The environment variable that names the language explicitly. */
export const LANGUAGE_ENV = "OMOMP_LANG";

const sectionSchema = z.object({ language: z.enum(["en", "zh"]) }).strict();

/** The `omomp-lang` section: owned by the `omomp-lang` extension, read by every consumer. */
const omompLangSection = defineSettings(join(import.meta.dir, "..", "omomp-lang"), sectionSchema);

/** The `omomp-lang` plugin settings, read once at module load and kept for the life of the process. */
export const omompLangSetting = await readSettings(omompLangSection, { kind: "machine" });

/** `en` or `zh` when `value` names one (any case, surrounding space ignored). */
export function parseLanguage(value: string | undefined): Language | null {
	const normalized = value?.trim().toLowerCase();
	return normalized === "en" || normalized === "zh" ? normalized : null;
}

function language(): Language {
	const explicit = parseLanguage(process.env[LANGUAGE_ENV]);
	if (explicit !== null) return explicit;
	if (omompLangSetting.kind === "ok") return omompLangSetting.value.language;
	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const value = process.env[key]?.trim();
		if (value) return value.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

/** The text for the current language; both are written where the text is used, English first. */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
