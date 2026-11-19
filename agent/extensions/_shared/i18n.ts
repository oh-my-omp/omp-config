import { join } from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { LANGUAGE_ENV, type Language, languageFrom, parseLanguage } from "./omomp-shared/i18n.ts";
import { defineSettings, readSettings } from "./plugin-settings.ts";

const sectionSchema = z.object({ language: z.enum(["en", "zh"]) }).strict();

const omompLangSection = defineSettings(join(import.meta.dir, "..", "omomp-lang"), sectionSchema);

export const omompLangSetting = await readSettings(omompLangSection, { kind: "machine" });

export { LANGUAGE_ENV };

function language(): Language {
	if (parseLanguage(process.env[LANGUAGE_ENV]) !== undefined) return languageFrom(process.env);
	if (omompLangSetting.kind === "ok") return omompLangSetting.value.language;
	return languageFrom(process.env);
}

export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
