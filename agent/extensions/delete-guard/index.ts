// ============================================================================
// delete-guard — deletion goes through one tool that takes literal paths, and
// agent-issued shell deletion commands are blocked before they run.
//
// GUARD. A `tool_call` hook judges every `bash` call: the loop's own calls,
// writes to `xd://bash`, and the nested `bash` event omp emits for such a write
// with the same call id (each event is judged; either one blocking stops the
// call). The command text is parsed once (`posix-parse.ts`, fail closed:
// unparsable text is blocked) and every command it runs is classified in the
// posix dialect (`posix.ts`), because the bash tool runs in the embedded brush
// shell on every platform: commands in `$(…)`, backticks, `<(…)`, unquoted
// here-document bodies, literal `sh|bash|zsh|dash|ksh -c` scripts, quoted
// here-documents read by a shell, and literal `eval`, `trap` and `alias`
// bodies, up to 8 nested levels. Blocked:
//   - deletion commands, whatever their arguments: `rm`, `unlink`, `rmdir`,
//     `shred` (name lowercased, basename of a path, quotes and backslashes
//     removed), also behind `sudo`, `doas`, `command`, `builtin`, `exec`,
//     `env`, `nice`, `nohup`, `time`, `timeout`, `stdbuf`, `busybox`, `xargs`
//     (their options skipped by table; an unknown option is read both with and
//     without a value), `find -delete` and `find -exec|-execdir|-ok|-okdir`;
//   - non-literal commands: a command name from an expansion, substitution,
//     glob or brace pattern; a non-literal nested shell, `eval`, `trap` or
//     `alias` script; a shell argument from an expansion (`bash "$FLAGS"`, it
//     may be `-c` or `-s`); `env -S`; a shell reading its script from stdin
//     other than a quoted here-document (pipe, here-string, unquoted
//     here-document, nothing). Literal script files (`bash x.sh`, `sh < x.sh`,
//     `source`), `-n` (syntax check, undone by `+n`) and `--version`/`--help`
//     run nothing the text shows and pass. An unknown long shell option is read
//     both with and without a value. Here-document bodies on any descriptor
//     are scanned for substitutions, and inside double quotes `'` does not
//     quote (`"${x:-'$(…)'}"` runs the substitution).
// Words that are only arguments pass (`echo rm -rf /`, `git rm`).
//
// Nested Windows shells (any platform; reached from brush on Windows):
// `powershell|pwsh` (`.exe`, any path) with `-Command`/`-c` or a positional
// script is classified in the PowerShell dialect (`powershell.ts`):
// `Remove-Item` and its aliases `rm`, `ri`, `del`, `erase`, `rd`, `rmdir`,
// `[System.IO.File]::Delete`, `[IO.Directory]::Delete` and any `.Delete(`
// call are deletions; `& $cmd`, `Invoke-Expression`/`iex`,
// `-EncodedCommand` and a script read from stdin are non-literal; `-File`
// runs a script file and passes. The command after `=` (`$x=Remove-Item`),
// `return`/`throw`/`exit`, `&` or `.` is classified like any other, and a
// control block's `}` ends its statement. `cmd` (`.exe`) with `/c` or `/k` is
// classified in the cmd dialect (`cmd.ts`): `del`, `erase`, `rd`, `rmdir`
// (also in `for … do`, `if …` and `(…)` blocks) are deletions, a command name
// with `%VAR%`/`!VAR!` is non-literal, `cmd` without `/c`/`/k` reads stdin
// and is non-literal. Case never matters; scripts nest across dialects.
//
// The block reason names the rule and the command; it points to `delete` when
// the session's active tools include it, otherwise it says the session cannot
// delete. No switch, no config, independent of `tools.approvalMode` and
// `bashInterceptor`.
//
// EVAL. The same hook judges `eval` cells by their text, before they run:
//   - py (`eval-py.ts`, own tokenizer; an untokenizable cell is blocked):
//     deletion APIs — the names `rmtree`, `removedirs`, `unlink`, `rmdir`
//     wherever code names them (not in strings or comments), and `os.remove`
//     on `os` or an `os` alias or import; shell handoffs — `os.system`,
//     `os.popen`, `subprocess.getoutput|getstatusoutput`,
//     `asyncio.create_subprocess_shell`, any call whose `shell=` is not literally `False`/`None`, and the
//     kernel's `!cmd`, `x = !cmd` and `%%bash` body: the literal command is
//     classified as a system-shell script (posix on macOS and Linux, cmd on
//     Windows; `%%bash` stays posix); launches without a shell — `subprocess`
//     `run|call|check_call|check_output|Popen`, `asyncio.create_subprocess_exec`
//     — classify a literal argv (argv[0] non-literal → blocked); the
//     `tool.bash({"command": …})` bridge. `%time`/`%timeit` arguments,
//     `%%capture`/`%%timeit` bodies, f-string placeholders and expressions nested in their format specs are judged as
//     Python. `%run`/`%load` run script files (not covered).
//   - js (`eval-js.ts`, omp's own Babel parser with the kernel's options):
//     deletion APIs — `rmSync`, `unlinkSync`, `rmdirSync`, `unlink`, `rmdir`
//     wherever named, `rm` on an fs / fs.promises binding (also `fs.promises` via a bound `fs`) or `require`, and
//     `.delete()` on `Bun.file(…)` or a name bound to it; child_process
//     `exec|execSync` strings as system-shell scripts (cmd on Windows),
//     `spawn|spawnSync|execFile|execFileSync` as argv (a script when the
//     options may start a shell: `shell` not literally false/null/undefined,
//     or options not spelled out), `Bun.spawn|spawnSync` argv, `Bun.$`
//     templates (posix, brush), the `tool.bash({command})` bridge and
//     `tool.write` to `xd://bash`.
// A command that is not a literal string (f-string or template with
// placeholders, variable, concatenation) is blocked as non-literal. Names are
// matched in the cell's text only: a generic name (`remove`, `run`, `exec`,
// `spawn`, `rm`) aliased in an earlier cell, `getattr`-style access, and
// `os.exec*`/`os.spawn*`/`pty.spawn` are not covered. A definition whose body
// calls a deletion API is blocked even if this cell does not call it.
//
// Not covered: `exec_command`, and aliases or functions the bash tool sources
// from the user's shell rc.
//
// DELETE TOOL. Registers `delete` (approval `write`, top-level) on macOS,
// Linux and Windows; on any other platform no tool is registered.
// Parameters: `paths` (non-empty string array) and `mode` (`"trash"`, the
// default, or `"permanent"`). The tool text tells the agent to leave `mode`
// unset and to set `"permanent"` only when the user explicitly asks for
// unrecoverable deletion. Paths are literal: no `~`, environment variable
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
// On Windows a bare drive (`C:`) is refused, roots are the drive root (`C:\`,
// `C:/`, `\` and `/` resolve to it), a UNC share root (`\\server\share`) and
// `\\?\C:\`; spellings are compared case-folded with `\` separators; the home
// directory is `USERPROFILE`.
//
// `trash` moves each path to the platform trash, restorable from the file
// manager: macOS runs `/usr/bin/trash -v <path>` with the path as argv, never
// through a shell (missing binary: the call fails before touching anything and
// says `permanent` is only for an explicit request for unrecoverable deletion);
// Linux follows the freedesktop.org Trash spec itself
// (home trash `$XDG_DATA_HOME/Trash` or `~/.local/share/Trash` when the path is
// on the same device, otherwise, on the mount really holding the path, its
// parent's links resolved, `$topdir/.Trash/$uid`, falling back to
// `$topdir/.Trash-$uid` when any step there fails), writing `files/<name>`
// and `info/<name>.trashinfo`; a name taken in either is never overwritten.
// Windows runs `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
// (absolute path, never a bare name) with a fixed script calling
// `Microsoft.VisualBasic.FileIO.FileSystem` `DeleteFile`/`DeleteDirectory`
// with `SendToRecycleBin`; the path is passed in an environment variable,
// never in the script text. UNC paths, non-fixed drives (no Recycle Bin) and
// symbolic links or junctions fail with the same note about `permanent`.
// A failed move is reported; it never falls back to permanent deletion.
// `permanent` deletes recursively, and only after the user confirms it: once
// every path has passed validation and before anything is touched, the tool
// asks through `ctx.ui.confirm`, listing the resolved paths, on every call
// (no session-wide grant). A declined, cancelled or aborted dialog, or a
// session without UI (`ctx.hasUI` false: subagents, `--no-ui` RPC, print
// mode), deletes nothing and returns an error telling the agent to leave
// `mode` unset. Paths run in order and the result reports each one; a failure
// on one path, a backend that throws included, leaves the earlier ones as
// they are.
//
// Main and sub sessions, full and light mode (permanent needs a UI, so a
// subagent can only move to the trash). The tool writes and deletes only
// the requested paths and the trash entries for them; no extension config
// files. Tool failures are returned to the agent and logged. A guard failure is
// logged with `pi.logger.warn` and blocks the call; nothing escapes into omp.
// ============================================================================
import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { type Outcome, type Platform, runDeletion, supportedPlatform, trashUnavailable } from "./backends.ts";
import { guardToolCall } from "./guard.ts";
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

/** The user's answer to one permanent call; `unavailable` when the session has no UI to ask. */
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
	pi.on("tool_call", async (event) => {
		try {
			return await guardToolCall(event.toolName, event.input, () => pi.getActiveTools().includes(DELETE_TOOL));
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
