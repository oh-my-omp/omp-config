import { join } from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { LANGUAGE_ENV, type Language, languageFrom, parseLanguage } from "./omomp-shared/i18n.ts";
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
 * Steps 1, 3 and 4 are the shared resolver of `omomp-shared/i18n.ts`
 * (`parseLanguage`, `languageFrom`); only the setting step is local to
 * omp-config, so `language()` composes the three steps itself.
 *
 * Text sent to the model (prompts, steers, tool descriptions, tool-result
 * content) does not go through here.
 */

const sectionSchema = z.object({ language: z.enum(["en", "zh"]) }).strict();

/** The `omomp-lang` section: owned by the `omomp-lang` extension, read by every consumer. */
const omompLangSection = defineSettings(join(import.meta.dir, "..", "omomp-lang"), sectionSchema);

/** The `omomp-lang` plugin settings, read once at module load and kept for the life of the process. */
export const omompLangSetting = await readSettings(omompLangSection, { kind: "machine" });

export { LANGUAGE_ENV };

function language(): Language {
	if (parseLanguage(process.env[LANGUAGE_ENV]) !== undefined) return languageFrom(process.env);
	if (omompLangSetting.kind === "ok") return omompLangSetting.value.language;
	return languageFrom(process.env);
}

/** The text for the current language; both are written where the text is used, English first. */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
