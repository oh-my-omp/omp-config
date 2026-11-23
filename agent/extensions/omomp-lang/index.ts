import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { LANGUAGE_ENV, omompLangSetting, tr } from "../_shared/i18n.ts";
import { type Language, parseLanguage } from "../_shared/omomp-shared/i18n.ts";

type Startup =
	| { readonly kind: "exported"; readonly language: Language }
	| { readonly kind: "launch-wins"; readonly launch: Language; readonly configured: Language }
	| { readonly kind: "invalid"; readonly reason: string };

function decideStartup(): Startup {
	switch (omompLangSetting.kind) {
		case "invalid":
			return { kind: "invalid", reason: omompLangSetting.reason };
		case "ok": {
			const configured = omompLangSetting.value.language;
			const launch = parseLanguage(process.env[LANGUAGE_ENV]);
			if (launch === undefined || launch === configured) return { kind: "exported", language: configured };
			return { kind: "launch-wins", launch, configured };
		}
		default: {
			const unreachable: never = omompLangSetting;
			return unreachable;
		}
	}
}

const startup = decideStartup();
if (startup.kind === "exported") process.env[LANGUAGE_ENV] = startup.language;

let reported = false;

function reportInvalid(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): void {
	if (reported) return;
	reported = true;
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
