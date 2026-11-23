import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { openJudge } from "../_shared/judge.ts";
import { textOf } from "../_shared/messages.ts";
import { defineStatelessNoiseGuard, registerCompactHandoff } from "../_shared/omomp-shared/compact-handoff.ts";
import { defineSettings, readSettings } from "../_shared/plugin-settings.ts";

const DETECT_CHAR_LIMIT = 200;
const FENCED_BLOCK = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;

const configSchema = z.object({
	language: z.string().min(1),
	instruction: z.string().min(1),
});

const settingsSection = defineSettings(import.meta.dir, configSchema);

type LangNagConfig = z.infer<typeof configSchema>;

async function loadConfig(pi: ExtensionAPI, cwd: string): Promise<LangNagConfig | null> {
	const result = await readSettings(settingsSection, { kind: "project", cwd });
	switch (result.kind) {
		case "ok":
			return result.value;
		case "invalid":
			pi.logger.warn(`lang-nag: invalid settings (${result.reason}); inert`);
			return null;
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

function terminalReplyText(messages: readonly AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message === undefined || message.role !== "assistant") continue;
		return message.stopReason === "stop" ? textOf(message.content) : "";
	}
	return "";
}

function lastParagraphSample(body: string): string {
	const last = body
		.replace(FENCED_BLOCK, "")
		.split(/\n[ \t]*\n/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph !== "")
		.at(-1);
	return last === undefined ? "" : [...last].slice(0, DETECT_CHAR_LIMIT).join("");
}

async function replyMismatches(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	language: string,
	sample: string,
	signal: AbortSignal,
): Promise<boolean> {
	try {
		const opened = openJudge(ctx, "lang-nag");
		switch (opened.kind) {
			case "inactive":
				return false;
			case "ready":
				break;
			default: {
				const exhaustive: never = opened;
				return exhaustive;
			}
		}
		const result = await opened.judge.judge(
			{
				state: { reply: sample },
				questions: {
					language: {
						type: "choice",
						instructions: `Decide whether \`reply\` is written mainly in ${language}. Ignore code, file paths, URLs, and isolated technical terms; judge the prose.`,
						criteria: {
							yes: `The prose is mainly in ${language}.`,
							no: `The prose is mainly in a language other than ${language}.`,
						},
					},
				},
			},
			{ signal },
		);
		const answer = result.answers.language;
		if (answer?.type !== "choice") {
			pi.logger.warn("lang-nag: judge returned no choice answer");
			return false;
		}
		return answer.choice === "no";
	} catch (error) {
		if (!signal.aborted) pi.logger.warn("lang-nag: judge failed", { error: errorText(error) });
		return false;
	}
}

type Detection =
	| { readonly kind: "idle" }
	| { readonly kind: "running"; readonly controller: AbortController }
	| { readonly kind: "mismatch" };

const IDLE: Detection = { kind: "idle" };
const MISMATCH: Detection = { kind: "mismatch" };

export default function langNag(pi: ExtensionAPI): void {
	let config: LangNagConfig | null = null;
	let detection: Detection = IDLE;

	const cancelDetection = (): void => {
		switch (detection.kind) {
			case "running":
				detection.controller.abort();
				break;
			case "idle":
			case "mismatch":
				break;
			default: {
				const exhaustive: never = detection;
				throw new Error(`lang-nag: unexpected detection state ${exhaustive}`);
			}
		}
		detection = IDLE;
	};

	const reload = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		cancelDetection();
		config = null;
		if (ctx.agent.kind !== "main") return;
		try {
			config = await loadConfig(pi, ctx.cwd);
			pi.logger.info(config ? `lang-nag: active (language=${config.language})` : "lang-nag: inert");
		} catch (error) {
			pi.logger.warn("lang-nag: settings load failed", { error: errorText(error) });
		}
	};

	const cancelOnMain = (_event: unknown, ctx: ExtensionContext): void => {
		if (ctx.agent.kind === "main") cancelDetection();
	};

	registerCompactHandoff(
		pi,
		defineStatelessNoiseGuard({
			pluginId: "omp-config/lang-nag",
			renderNoiseGuardDirective: () =>
				"`lang-nag` language reminders prepended to user turns are transient per-turn corrections — NEVER record them as task goals or persistent constraints in the summary.",
		}),
	);

	pi.on("session_start", reload);
	pi.on("session_switch", reload);
	pi.on("session_branch", cancelOnMain);
	pi.on("session_tree", cancelOnMain);
	pi.on("session_before_compact", cancelOnMain);
	pi.on("session_compact", cancelOnMain);

	pi.on("agent_end", (event, ctx) => {
		try {
			if (ctx.agent.kind !== "main" || config === null) return;
			if (event.willContinue === true && event.awaitingAsyncWork !== true) return;
			cancelDetection();
			const sample = lastParagraphSample(terminalReplyText(event.messages));
			if (sample === "") return;
			const controller = new AbortController();
			const running: Detection = { kind: "running", controller };
			detection = running;
			void replyMismatches(pi, ctx, config.language, sample, controller.signal).then((mismatch) => {
				if (detection === running) detection = mismatch ? MISMATCH : IDLE;
			});
		} catch (error) {
			pi.logger.warn("lang-nag: reply detection failed", { error: errorText(error) });
		}
	});

	pi.on("input", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		if (event.text.startsWith("/")) {
			cancelDetection();
			return;
		}
		if (event.source === "extension") return;
		const current = detection;
		cancelDetection();
		if (current.kind === "mismatch" && config !== null) {
			return { text: `${config.instruction}\n\n${event.text}` };
		}
	});
}
