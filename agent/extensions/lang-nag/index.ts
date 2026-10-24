// ============================================================================
// lang-nag — watches the MAIN session's assistant replies and, when the reply
// is not written in the configured language, prepends a tiny pre-written
// instruction (e.g. "说中文") to the front of the NEXT user message so the model
// self-corrects on its own next turn.
//
// What gets classified. Only the assistant's REPLY BODY — the `type: "text"`
// content blocks of the messages `agent_end` delivers. Thinking and tool calls
// (`toolCall`) are never treated as reply text. From that body we take the LAST
// paragraph (blank-line separated) and
// hand the judge the first 200 code points of it — the natural-language
// sign-off, not the whole turn.
//
// Cancellation. Detection starts at `agent_end` and overlaps with the user
// reading and typing. The next genuine user message only takes a verdict that
// has already settled; if detection is still running when the message is sent,
// the judgment is aborted and the message goes out unchanged.
//
// Detection is one choice question on the sample's language, asked through OMP's
// JUDGE role chain (`_shared/judge.ts`, scope `any`): `modelRoles.judge`, then
// `retry.fallbackChains.judge`, native, local or prompted chat. Config (target
// language + the literal instruction string) is the `lang-nag` section of
// omomp.*: the project's `.omp/` copy first, then the agent-dir copy.
//
// Scope is the main session only, mirroring tool-policy-nag: subagents run
// short decomposed slices where a language nag is noise. A judgment failure
// (every chain candidate failed), no judge candidate, an unanswered question, or a missing config all degrade
// to "no nag" — the extension never blocks or corrupts a turn.
// Registers session_start/switch/branch/tree/compact, agent_end, and input
// hooks. Reads only the config above; writes no files and sends no extra turns.
// ============================================================================

import type { Judge } from "@oh-my-pi/pi-ai";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { type JudgeOpen, openJudge } from "../_shared/judge.ts";
import { lastAssistantText } from "../_shared/messages.ts";
import { defineOmompSection, loadOmompSection } from "../_shared/omomp.ts";

const DETECT_CHAR_LIMIT = 200; // code points of the last paragraph handed to the judge; never more.

const configSchema = z.object({
	/** Target language name the reply is expected to be in, passed verbatim to the judge (e.g. "中文", "English"). */
	language: z.string().min(1),
	/** Literal instruction prepended to the next user message on a mismatch (e.g. "说中文", "say English"). */
	instruction: z.string().min(1),
});

const omompSection = defineOmompSection(import.meta.dir, configSchema);

type LangNagConfig = z.infer<typeof configSchema>;

// Project `.omp/omomp.*` wins over the agent-dir copy; a missing or invalid
// section leaves the extension inert.
function loadConfig(cwd: string): LangNagConfig | null {
	const result = loadOmompSection(omompSection, cwd);
	switch (result.kind) {
		case "found":
			return result.value;
		case "none":
			return null;
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

// The judge sees the reply's last blank-line-separated paragraph, capped at
// DETECT_CHAR_LIMIT code points from its start.
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

// Resolves to the instruction to prepend, or null (in-target / undetermined /
// no judge / aborted). Never rejects, so it is safe to hold as a floating promise.
async function detectInstruction(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cfg: LangNagConfig,
	sample: string,
	signal: AbortSignal,
): Promise<string | null> {
	let opened: JudgeOpen;
	try {
		opened = openJudge(ctx, "lang-nag", "any");
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

// One choice question on the sample's language; answer "no" means nag.
// Never rejects; a failed or unanswered judgment is no nag.
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

// --- extension registration -------------------------------------------------

// Detection for the latest terminal reply: nothing armed, still running (abortable),
// or settled with the instruction to prepend (null = no nag).
type Detection =
	| { readonly kind: "idle" }
	| { readonly kind: "running"; readonly controller: AbortController }
	| { readonly kind: "settled"; readonly instruction: string | null };

const IDLE: Detection = { kind: "idle" };

export default function langNag(pi: ExtensionAPI): void {
	let config: LangNagConfig | null = null;
	let detection: Detection = IDLE;

	// Drops the current detection, aborting it if it is still running.
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

	pi.on("session_start", (_event, ctx) => {
		try {
			cancelDetection();
			config = ctx.agent.kind === "main" ? loadConfig(ctx.cwd) : null;
			if (ctx.agent.kind !== "main") return;
			if (config) {
				pi.logger.info(`lang-nag: active (language=${config.language})`);
			} else {
				pi.logger.info("lang-nag: no lang-nag section in omomp.* found — inert");
			}
		} catch (error) {
			config = null;
			pi.logger.warn("lang-nag: session start failed", { error: errorText(error) });
		}
	});
	// Switching sessions re-reads cwd-local config.
	pi.on("session_switch", (_event, ctx) => {
		try {
			cancelDetection();
			config = ctx.agent.kind === "main" ? loadConfig(ctx.cwd) : null;
		} catch (error) {
			config = null;
			pi.logger.warn("lang-nag: session switch failed", { error: errorText(error) });
		}
	});
	// Boundaries that swap the working context invalidate any in-flight verdict.
	pi.on("session_branch", (_event, ctx) => {
		if (ctx.agent.kind === "main") cancelDetection();
	});
	pi.on("session_tree", (_event, ctx) => {
		if (ctx.agent.kind === "main") cancelDetection();
	});
	pi.on("session_compact", (_event, ctx) => {
		if (ctx.agent.kind === "main") cancelDetection();
	});

	pi.on("agent_end", (event, ctx) => {
		try {
			if (ctx.agent.kind !== "main" || config === null) return;
			// An auto-scheduled continuation is not a user-visible terminal reply.
			if (event.willContinue === true) return;
			// A newer terminal reply supersedes any verdict still pending for an older one.
			cancelDetection();
			const sample = lastParagraphSample(lastAssistantText(event.messages));
			if (sample === "") return;
			const controller = new AbortController();
			const running: Detection = { kind: "running", controller };
			detection = running;
			// Runs while the user reads/types; only a verdict that settles before the
			// next input is used.
			void detectInstruction(pi, ctx, config, sample, controller.signal).then((instruction) => {
				if (detection === running) detection = { kind: "settled", instruction };
			});
		} catch (error) {
			pi.logger.warn("lang-nag: reply detection failed", { error: errorText(error) });
		}
	});

	pi.on("input", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		// Slash-command invocations are harness UI, not natural language — never nag.
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
