import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { type Outcome, type Platform, runDeletion, supportedPlatform, trashUnavailable } from "./backends.ts";
import { type EvalSession, guardToolCall, newEvalSession, resetEvalSession } from "./guard.ts";
import { type Target, validateTargets } from "./targets.ts";

const DELETE_TOOL = "delete";

const DELETE_DESCRIPTION = [
	"Delete files and directories given as literal paths. This is the way to delete: bash deletion commands (`rm`, `unlink`, `rmdir`, `shred`, `find -delete`, …) and eval deletion APIs (`shutil.rmtree`, `os.remove`, `fs.rmSync`, `Bun.file().delete()`, …) are refused.",
	'Leave `mode` unset: the default `"trash"` moves each path to the system trash, where the user can restore it. `mode: "permanent"` deletes recursively and cannot be undone; set it only when the user explicitly asks for unrecoverable deletion. "Delete", "remove", "clean up" or a request phrased as `rm -rf` is not such a request. Every permanent call asks the user to confirm the listed paths; without that confirmation (declined, or no UI as in subagents and headless runs) nothing is deleted.',
	"Paths are taken literally: no `~`, environment variable or glob expansion; relative paths resolve against the session cwd. List every path explicitly.",
	"Every path is checked before anything is touched; one bad path refuses the whole call. Refused: empty paths, paths starting with `~`, paths that do not exist, the filesystem root, the home directory and its ancestors, the session cwd and its ancestors (also when reached through a symbolic link or another spelling), and paths whose `..`, `.` or trailing `/` passes through a symbolic link. A symbolic link is deleted as the link itself.",
	"The result reports each path: where it was moved, or why it failed.",
].join("\n");

const deleteParams = z.object({
	paths: z.array(z.string()).min(1).describe("Literal paths to delete; absolute, or relative to the session cwd."),
	mode: z
		.enum(["trash", "permanent"])
		.optional()
		.describe(
			'Leave unset: the default "trash" moves paths to the system trash, where the user can restore them. "permanent" deletes recursively and cannot be undone: set it only when the user explicitly asks for unrecoverable deletion; "delete", "remove", "clean up" or a request phrased as `rm -rf` is not such a request.',
		),
});

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

type Consent = "granted" | "declined" | "unavailable";

type AskPermanent = (targets: readonly Target[]) => Promise<Consent>;

const TRASH_HINT = "Leave `mode` unset to move the paths to the system trash instead.";

const text = (value: string, isError: boolean): ToolResult =>
	isError ? { content: [{ type: "text", text: value }], isError: true } : { content: [{ type: "text", text: value }] };

function formatOutcome(outcome: Outcome): string {
	switch (outcome.kind) {
		case "done":
			return `ok     ${outcome.given}: ${outcome.note}`;
		case "failed":
			return `failed ${outcome.given}: ${outcome.error}`;
		default: {
			const unreachable: never = outcome;
			return unreachable;
		}
	}
}

async function runDelete(platform: Platform, rawParams: unknown, cwd: string, askPermanent: AskPermanent): Promise<ToolResult> {
	const parsed = deleteParams.safeParse(rawParams);
	if (!parsed.success) return text(`${DELETE_TOOL}: invalid parameters: ${parsed.error.message}`, true);
	const mode = parsed.data.mode ?? "trash";
	const validation = validateTargets(parsed.data.paths, cwd);
	switch (validation.kind) {
		case "refused":
			return text(
				[
					`${DELETE_TOOL}: nothing was deleted; refused:`,
					...validation.refusals.map((refusal) => `- ${JSON.stringify(refusal.given)}: ${refusal.reason}`),
				].join("\n"),
				true,
			);
		case "ok":
			break;
		default: {
			const unreachable: never = validation;
			return unreachable;
		}
	}
	switch (mode) {
		case "trash": {
			const unavailable = trashUnavailable(platform);
			if (unavailable !== null) return text(`${DELETE_TOOL}: nothing was deleted: ${unavailable}`, true);
			break;
		}
		case "permanent": {
			const consent = await askPermanent(validation.targets);
			switch (consent) {
				case "granted":
					break;
				case "declined":
					return text(`${DELETE_TOOL}: nothing was deleted: the user did not confirm permanent deletion. ${TRASH_HINT}`, true);
				case "unavailable":
					return text(
						`${DELETE_TOOL}: nothing was deleted: permanent deletion needs the user's confirmation, and this session has no UI to ask (a subagent, a headless or print run). ${TRASH_HINT}`,
						true,
					);
				default: {
					const unreachable: never = consent;
					return unreachable;
				}
			}
			break;
		}
		default: {
			const unreachable: never = mode;
			return unreachable;
		}
	}
	const outcomes = await runDeletion(platform, mode, validation.targets);
	const failed = outcomes.filter((outcome) => outcome.kind === "failed").length;
	const summary =
		failed === 0
			? `${DELETE_TOOL} (${mode}): all ${outcomes.length} done`
			: `${DELETE_TOOL} (${mode}): ${failed} of ${outcomes.length} failed; the ok lines took effect, so retry only the failed paths`;
	return text([summary, ...outcomes.map(formatOutcome)].join("\n"), failed > 0);
}

export default function deleteGuard(pi: ExtensionAPI): void {
	const evalSession: EvalSession = newEvalSession();
	pi.on("session_start", () => resetEvalSession(evalSession));
	pi.on("session_switch", () => resetEvalSession(evalSession));
	pi.on("tool_call", async (event) => {
		try {
			return await guardToolCall(event.toolName, event.input, () => pi.getActiveTools().includes(DELETE_TOOL), evalSession);
		} catch (error) {
			pi.logger.warn("delete-guard: guard failed; the call was blocked", { error: errorText(error) });
			return { block: true, reason: `delete-guard: internal error (${errorText(error)}); the call was blocked.` };
		}
	});
	const platform = supportedPlatform(process.platform);
	if (platform === null) return;
	pi.registerTool({
		name: DELETE_TOOL,
		label: tr("Delete", "删除"),
		description: DELETE_DESCRIPTION,
		approval: "write",
		loadMode: "essential",
		parameters: deleteParams,
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const askPermanent: AskPermanent = async (targets) => {
				if (!ctx.hasUI) return "unavailable";
				const confirmed = await ctx.ui.confirm(
					tr("Delete permanently?", "永久删除？"),
					[
						tr(
							"The agent asks to delete these paths recursively. This cannot be undone; they will not go to the trash:",
							"agent 要求递归删除以下路径，不可恢复，不进回收站：",
						),
						...targets.map((target) => `  ${target.operand}`),
					].join("\n"),
					{ signal },
				);
				return confirmed ? "granted" : "declined";
			};
			try {
				return await runDelete(platform, rawParams, ctx.cwd, askPermanent);
			} catch (error) {
				pi.logger.warn("delete: tool failed", { error: errorText(error) });
				return text(`${DELETE_TOOL}: ${errorText(error)}`, true);
			}
		},
	});
}
