/**
 * omomp-lang — exports the UI language chosen in the `omomp-lang.language`
 * plugin setting (`omp-config`; `/settings → Plugins → omp-config` or
 * `omp plugin config`) as `OMOMP_LANG`, the environment variable every omp
 * plugin and local extension reads for its person-facing text
 * (`_shared/i18n.ts` documents the whole discovery chain). A project override
 * is not read: the language belongs to the process.
 *
 * At module load (once per process, before this extension's factory and before
 * the factories of every extension imported in the same batch) it sets
 * `process.env.OMOMP_LANG` to the configured language, unless the launch
 * environment already names one (`OMOMP_LANG=en|zh omp`, or a Tern pane started
 * with the parent's language): an explicit launch value wins, so the
 * environment and the setting never disagree within one process. An
 * unreadable or invalid setting leaves the environment alone and consumers
 * fall back to the locale. Child processes inherit the exported value. A
 * change applies from the next OMP start.
 *
 * Registers `session_start`: the first main session reports an invalid
 * setting once (log + UI warning). Writes no files; never throws into omp.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { LANGUAGE_ENV, omompLangSetting, parseLanguage, tr } from "../_shared/i18n.ts";

type Export =
	| { readonly kind: "exported"; readonly language: string }
	| { readonly kind: "launch-wins"; readonly launch: string; readonly configured: string }
	| { readonly kind: "invalid"; readonly reason: string };

function exportConfigured(): Export {
	switch (omompLangSetting.kind) {
		case "invalid":
			return { kind: "invalid", reason: omompLangSetting.reason };
		case "ok": {
			const launch = parseLanguage(process.env[LANGUAGE_ENV]);
			if (launch !== null) {
				return { kind: "launch-wins", launch, configured: omompLangSetting.value.language };
			}
			process.env[LANGUAGE_ENV] = omompLangSetting.value.language;
			return { kind: "exported", language: omompLangSetting.value.language };
		}
		default: {
			const unreachable: never = omompLangSetting;
			return unreachable;
		}
	}
}

const startup = exportConfigured();

/** Whether the first main session still has to report an invalid setting. */
let unreported = startup.kind === "invalid";

function reportInvalid(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): void {
	if (!unreported) return;
	unreported = false;
	pi.logger.warn("omomp-lang: invalid omomp-lang.language setting", { reason });
	if (ctx.hasUI) {
		ctx.ui.notify(
			tr(`omomp-lang: invalid setting omomp-lang.language (${reason})`, `omomp-lang：设置 omomp-lang.language 无效（${reason}）`),
			"warning",
		);
	}
}

export default function omompLang(pi: ExtensionAPI): void {
	pi.setLabel(tr("UI language", "界面语言"));

	pi.on("session_start", (_event, ctx) => {
		try {
			if (ctx.agent.kind !== "main") return;
			switch (startup.kind) {
				case "exported":
					pi.logger.debug("omomp-lang: exported", { language: startup.language });
					break;
				case "launch-wins":
					pi.logger.info("omomp-lang: launch environment names the language; the setting is not exported", {
						launch: startup.launch,
						configured: startup.configured,
					});
					break;
				case "invalid":
					reportInvalid(pi, ctx, startup.reason);
					break;
				default: {
					const unreachable: never = startup;
					return unreachable;
				}
			}
		} catch (error) {
			pi.logger.warn("omomp-lang: session_start failed", { error: errorText(error) });
		}
	});
}
