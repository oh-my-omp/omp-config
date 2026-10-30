// ============================================================================
// delete-guard — deletion goes through one tool that takes literal paths.
//
// DELETE TOOL. Registers `delete` (approval `write`, top-level) on macOS and
// Linux; on any other platform (Windows included) no tool is registered.
// Parameters: `paths` (non-empty string array) and `mode` (`"trash"`, the
// default, or `"permanent"`). Paths are literal: no `~`, environment variable
// or glob expansion; a relative path is resolved against the session cwd.
//
// Every path is validated before any is touched; one refusal refuses the whole
// call and changes nothing. Refused: an empty or blank path, a path starting
// with `~`, a path that does not exist, the filesystem root, the home
// directory and its ancestors, the session cwd and its ancestors. Protected
// directories are compared by file identity (`dev:ino`), so case variants,
// firmlinks, bind mounts and symbolic links of them match too; the path, what
// its text reaches through links, and the link's target are all checked. A
// protected directory that no longer exists (a removed cwd) is compared by its
// spelling. A path whose `..`, `.` or trailing `/` passes through a symbolic
// link reaches a different file than its normalized form and is refused. A
// link that passes (dangling links included) is deleted as the link itself.
//
// `trash` moves each path to the platform trash, restorable from the file
// manager: macOS runs `/usr/bin/trash -v <path>` with the path as argv, never
// through a shell (missing binary: the call fails before touching anything and
// points to `permanent`); Linux follows the freedesktop.org Trash spec itself
// (home trash `$XDG_DATA_HOME/Trash` or `~/.local/share/Trash` when the path is
// on the same device, otherwise, on the mount really holding the path, its
// parent's links resolved, `$topdir/.Trash/$uid`, falling back to
// `$topdir/.Trash-$uid` when that cannot be created), writing `files/<name>`
// and `info/<name>.trashinfo`; a name taken in either is never overwritten.
// A failed move is reported; it never falls back to permanent deletion.
// `permanent` deletes recursively. Paths run in order and the result reports
// each one; a failure on one path, a backend that throws included, leaves the
// earlier ones as they are.
//
// Main and sub sessions, full and light mode. Writes and deletes only the
// requested paths and the trash entries for them; no extension config files.
// Tool failures are returned to the agent and logged; nothing escapes into omp.
// ============================================================================
import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { type Outcome, type Platform, runDeletion, supportedPlatform, trashUnavailable } from "./backends.ts";
import { validateTargets } from "./targets.ts";

const DELETE_TOOL = "delete";

const DELETE_DESCRIPTION = [
	"Delete files and directories given as literal paths.",
	'Default `mode: "trash"` moves each path to the system trash, where the user can restore it; `mode: "permanent"` deletes recursively and cannot be undone.',
	"Paths are taken literally: no `~`, environment variable or glob expansion; relative paths resolve against the session cwd. List every path explicitly.",
	"Every path is checked before anything is touched; one bad path refuses the whole call. Refused: empty paths, paths starting with `~`, paths that do not exist, the filesystem root, the home directory and its ancestors, the session cwd and its ancestors (also when reached through a symbolic link or another spelling), and paths whose `..`, `.` or trailing `/` passes through a symbolic link. A symbolic link is deleted as the link itself.",
	"The result reports each path: where it was moved, or why it failed.",
].join("\n");

const deleteParams = z.object({
	paths: z.array(z.string()).min(1).describe("Literal paths to delete; absolute, or relative to the session cwd."),
	mode: z.enum(["trash", "permanent"]).optional().describe('"trash" (default): move to the system trash. "permanent": delete recursively.'),
});

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

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

async function runDelete(platform: Platform, rawParams: unknown, cwd: string): Promise<ToolResult> {
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
	if (mode === "trash") {
		const unavailable = trashUnavailable(platform);
		if (unavailable !== null) return text(`${DELETE_TOOL}: nothing was deleted: ${unavailable}`, true);
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
	const platform = supportedPlatform(process.platform);
	if (platform === null) return;
	pi.registerTool({
		name: DELETE_TOOL,
		label: tr("Delete", "删除"),
		description: DELETE_DESCRIPTION,
		approval: "write",
		loadMode: "essential",
		parameters: deleteParams,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			try {
				return await runDelete(platform, rawParams, ctx.cwd);
			} catch (error) {
				pi.logger.warn("delete: tool failed", { error: errorText(error) });
				return text(`${DELETE_TOOL}: ${errorText(error)}`, true);
			}
		},
	});
}
