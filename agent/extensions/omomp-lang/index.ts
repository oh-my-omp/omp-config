/**
 * omomp-lang — exports the UI language chosen in omomp.yml as `OMOMP_LANG`, the
 * environment variable every omp plugin and local extension reads for its
 * person-facing text (`_shared/i18n.ts` documents the whole discovery chain).
 *
 * Section `omomp-lang` of the agent-dir omomp file: `{language: en | zh}`. A
 * project `.omp/` copy is not read: the language belongs to the process.
 *
 * At module load (once per process, before this extension's factory and before
 * the factories of every extension imported in the same batch) it sets
 * `process.env.OMOMP_LANG` to the configured language, unless the launch
 * environment already names one (`OMOMP_LANG=en|zh omp`, or a Tern pane started
 * with the parent's language): an explicit launch value wins, so the
 * environment and omomp.yml never disagree within one process. Without a valid
 * section the environment is left alone and consumers fall back to the locale.
 * Child processes inherit the exported value. A change applies from the next
 * OMP start.
 *
 * Registers `session_start`: the first main session reports invalid or
 * unreadable omomp copies once (log + UI warning). Writes no files; never
 * throws into omp.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { configuredLanguage, LANGUAGE_ENV, parseLanguage, tr } from "../_shared/i18n.ts";
import type { ConfigProblem } from "../_shared/omomp.ts";

type Export =
	| { readonly kind: "exported"; readonly language: string; readonly path: string }
	| { readonly kind: "launch-wins"; readonly launch: string; readonly configured: string; readonly path: string }
	| { readonly kind: "unset" };

function exportConfigured(): { readonly result: Export; readonly problems: readonly ConfigProblem[] } {
	const load = configuredLanguage();
	switch (load.kind) {
		case "none":
			return { result: { kind: "unset" }, problems: load.skipped };
		case "found": {
			const launch = parseLanguage(process.env[LANGUAGE_ENV]);
			if (launch !== null) {
				return {
					result: { kind: "launch-wins", launch, configured: load.value.language, path: load.path },
					problems: load.skipped,
				};
			}
			process.env[LANGUAGE_ENV] = load.value.language;
			return { result: { kind: "exported", language: load.value.language, path: load.path }, problems: load.skipped };
		}
		default: {
			const unreachable: never = load;
			return unreachable;
		}
	}
}

const startup = exportConfigured();

/** Config problems not yet shown; the first main session reports them and empties the list. */
let unreported: readonly ConfigProblem[] = startup.problems;

function reportProblems(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (unreported.length === 0) return;
	const problems = unreported;
	unreported = [];
	const list = problems.map(({ path, reason }) => `${path}: ${reason}`).join("; ");
	pi.logger.warn("omomp-lang: skipped omomp copies", { problems: list });
	if (ctx.hasUI) {
		ctx.ui.notify(tr(`omomp-lang: skipped invalid omomp copies (${list})`, `omomp-lang：已跳过无效的 omomp 配置（${list}）`), "warning");
	}
}

export default function omompLang(pi: ExtensionAPI): void {
	pi.setLabel(tr("UI language", "界面语言"));

	pi.on("session_start", (_event, ctx) => {
		try {
			if (ctx.agent.kind !== "main") return;
			switch (startup.result.kind) {
				case "exported":
					pi.logger.debug("omomp-lang: exported", { language: startup.result.language, path: startup.result.path });
					break;
				case "launch-wins":
					pi.logger.info("omomp-lang: launch environment names the language; omomp.yml value not exported", {
						launch: startup.result.launch,
						configured: startup.result.configured,
						path: startup.result.path,
					});
					break;
				case "unset":
					break;
				default: {
					const unreachable: never = startup.result;
					return unreachable;
				}
			}
			reportProblems(pi, ctx);
		} catch (error) {
			pi.logger.warn("omomp-lang: session_start failed", { error: errorText(error) });
		}
	});
}
