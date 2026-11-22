import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Judge } from "@oh-my-pi/pi-ai";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { type JudgeOpen, openJudge } from "../_shared/judge.ts";
import { textOf } from "../_shared/messages.ts";
import { defineStatelessNoiseGuard, registerCompactHandoff } from "../_shared/omomp-shared/compact-handoff.ts";
import { defineSettings, readSettings } from "../_shared/plugin-settings.ts";

const DETECT_CHAR_LIMIT = 200; // code points of the last paragraph handed to the judge; never more.

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
	const trimmed = body.trim();
	if (trimmed === "") return "";
	const paragraphs = trimmed
		.split(/\n[ \t]*\n/)
		.map((p) => p.trim())
		.filter((p) => p !== "");
	const last = paragraphs[paragraphs.length - 1] ?? trimmed;
	return [...last].slice(0, DETECT_CHAR_LIMIT).join("");
}

async function detectInstruction(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cfg: LangNagConfig,
	sample: string,
	signal: AbortSignal,
): Promise<string | null> {
	let opened: JudgeOpen;
	try {
		opened = openJudge(ctx, "lang-nag");
	} catch (error) {
		if (!signal.aborted) pi.logger.warn("lang-nag: judge unavailable", { error: errorText(error) });
		return null;
	}
	switch (opened.kind) {
		case "ready":
			return judgeInstruction(pi, opened.judge, cfg, sample, signal);
		case "inactive":
			return null;
		default: {
			const exhaustive: never = opened;
			return exhaustive;
		}
	}
}

async function judgeInstruction(
	pi: ExtensionAPI,
	judge: Judge,
	cfg: LangNagConfig,
	sample: string,
	signal: AbortSignal,
): Promise<string | null> {
	try {
		const result = await judge.judge(
			{
				state: { reply: sample },
				questions: {
					language: {
						type: "choice",
						instructions: `Decide whether the REPLY is written mainly in ${cfg.language}. Ignore code, file paths, URLs, and isolated technical terms; judge the prose.`,
						criteria: {
							yes: `The prose is mainly in ${cfg.language}.`,
							no: `The prose is mainly in a language other than ${cfg.language}.`,
						},
					},
				},
			},
			{ signal },
		);
		const answer = result.answers.language;
		if (answer === undefined || answer.type !== "choice") {
			pi.logger.warn("lang-nag: judge returned no choice answer");
			return null;
		}
		return answer.choice === "no" ? cfg.instruction : null;
	} catch (error) {
		if (!signal.aborted) pi.logger.warn("lang-nag: judge failed", { error: errorText(error) });
		return null;
	}
}

type Detection =
	| { readonly kind: "idle" }
	| { readonly kind: "running"; readonly controller: AbortController }
	| { readonly kind: "settled"; readonly instruction: string | null };

const IDLE: Detection = { kind: "idle" };

export default function langNag(pi: ExtensionAPI): void {
	let config: LangNagConfig | null = null;
	let detection: Detection = IDLE;

	const cancelDetection = (): void => {
		switch (detection.kind) {
			case "running":
				detection.controller.abort();
				break;
			case "idle":
			case "settled":
				break;
			default: {
				const exhaustive: never = detection;
				throw new Error(`lang-nag: unexpected detection state ${exhaustive}`);
			}
		}
		detection = IDLE;
	};

	registerCompactHandoff(
		pi,
		defineStatelessNoiseGuard({
			pluginId: "omp-config/lang-nag",
			renderNoiseGuardDirective: () =>
				"`lang-nag` language reminders prepended to user turns are transient per-turn corrections — NEVER record them as task goals or persistent constraints in the summary.",
		}),
	);

	pi.on("session_start", async (_event, ctx) => {
		try {
			cancelDetection();
			config = ctx.agent.kind === "main" ? await loadConfig(pi, ctx.cwd) : null;
			if (ctx.agent.kind !== "main") return;
			if (config) {
				pi.logger.info(`lang-nag: active (language=${config.language})`);
			} else {
				pi.logger.info("lang-nag: inert");
			}
		} catch (error) {
			config = null;
			pi.logger.warn("lang-nag: session start failed", { error: errorText(error) });
		}
	});
	pi.on("session_switch", async (_event, ctx) => {
		try {
			cancelDetection();
			config = ctx.agent.kind === "main" ? await loadConfig(pi, ctx.cwd) : null;
		} catch (error) {
			config = null;
			pi.logger.warn("lang-nag: session switch failed", { error: errorText(error) });
		}
	});
	pi.on("session_branch", (_event, ctx) => {
		if (ctx.agent.kind === "main") cancelDetection();
	});
	pi.on("session_tree", (_event, ctx) => {
		if (ctx.agent.kind === "main") cancelDetection();
	});
	pi.on("session_before_compact", (_event, ctx) => {
		if (ctx.agent.kind === "main") cancelDetection();
	});
	pi.on("session_compact", (_event, ctx) => {
		if (ctx.agent.kind === "main") cancelDetection();
	});

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
			void detectInstruction(pi, ctx, config, sample, controller.signal).then((instruction) => {
				if (detection === running) detection = { kind: "settled", instruction };
			});
		} catch (error) {
			pi.logger.warn("lang-nag: reply detection failed", { error: errorText(error) });
		}
	});

	pi.on("input", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		// Drop any verdict: this turn is consumed by the command, and a stale
		// instruction must not leak into the next genuine user message.
		if (event.text.startsWith("/")) {
			cancelDetection();
			return;
		}
		// Only prepend to genuine user turns, never to synthetic injections
		// (steers/asides from this or other extensions).
		if (event.source === "extension") return;

		const current = detection;
		cancelDetection();
		switch (current.kind) {
			case "settled":
				if (current.instruction !== null && current.instruction !== "") {
					return { text: `${current.instruction}\n\n${event.text}` };
				}
				return;
			case "idle":
			case "running":
				return;
			default: {
				const exhaustive: never = current;
				return exhaustive;
			}
		}
	});
}
