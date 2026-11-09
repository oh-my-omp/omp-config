// fork_task's call instructions kept out of its description, served by its `docTopics()` as
// xd://fork_task/<topic> and pointed to by the last lines of that description.
// Checked against: agent/extensions/fork-task/index.ts, replica.ts, source-channel.ts and workspace.ts; pi-coding-agent@18.17.0
// src/task/index.ts, src/task/settings.ts, src/task/discovery.ts, src/task/isolation-runner.ts, src/task/worktree.ts, src/eval/js/tool-bridge.ts, src/thread/subagent-worker.ts.

interface Topic {
	readonly name: string;
	readonly when: string;
	readonly body: string;
}

const TOPICS: readonly Topic[] = [
	{
		name: "limits",
		when: "before using `from` or `workspace`, or when `fork_task` refuses to start",
		body: `# Prerequisites, unsupported fields, source errors and workspace inheritance

- Requires background jobs (\`async.enabled\`), the native \`task\` tool, batch mode and a persisted session; a missing prerequisite is named in the error.
- At \`task.maxRecursionDepth\`: when the caller's \`taskDepth\` + 1 reaches the cap, \`fork_task\` returns a tool error before staging anything; the child would have no \`task\` tool to replicate.
- No inherited-size or cost limit exists: no item checks the inherited token count or the source's cost.
- Not fork fields: \`solutionSpace\`, \`sourceSession\`, \`model\`, \`tools\`.
- Source errors before dispatch name an unregistered source, a parked source OMP kept no request for (it parked in an earlier process, or its last request got no response; wake it with \`write agent://<id>\`, then fork) or whose transcript moved past that request, a source in another thread that did not answer (retry), a source that has sent no request in this process, an unknown, disabled or internal \`agent\`, or a source with no persisted transcript.
- A \`source\` fork's inherited changes are applied before the child's first turn, after OMP captured the child's baseline, and handed back together with the child's changes (\`task.isolation.merge\`); the source's workspace is only read, and the source keeps it. Refusals happen before dispatch, create no child, and start with \`workspace "source" rejected (<code>)\`:

  | code | condition |
  |---|---|
  | \`child-not-isolated\` | the child would share a workspace: explicit \`isolated: false\`, or plan mode |
  | \`source-not-isolated\` | \`from\` omitted (the source is you), or the source has no isolated workspace of its own |
  | \`source-running\` | the source is still running; fork it once it stopped (idle, parked, or stopped by an error or a runtime limit) |
  | \`source-handed-back\` | the source's run already handed its changes back (merged into your checkout, or committed to its task branch) |
  | \`nested-repo\` | the source changed a nested repository inside its workspace |
  | \`overlay-conflict\` | the source's changes cannot be read (its run started before this OMP process or before fork_task loaded), or do not apply to your checkout. If your checkout changes after the check so they no longer apply to the child's copy, the child stops before its first model call with the same code |
- In isolated children, absolute paths from the copied conversation point to another checkout: use the same repository-relative paths in the child's own checkout.
- Results, follow-up, \`wait\` and \`proc://\` work as for \`task\`: see \`tool://task/results\` and \`tool://task/follow-up\`.
- Children replay an in-process request snapshot. Same-process idle/park follow-ups are supported; cold revival after restart fails before provider dispatch when that snapshot is gone. Create a fresh fork rather than silently changing the child's contract.
`,
	},
	{
		name: "batch",
		when: "before forking many items built from a template, or in waves",
		body: `# Templated batch forks from eval

- From an eval cell, \`await tool.fork_task(...)\` dispatches the same forks as a direct call; send later waves from later cells.
- The call returns once the forks are spawned; their results arrive in your conversation, not in the cell.
`,
	},
];

/** The pointer lines that end fork_task's description. */
export const TOPIC_POINTERS = [
	"Topics — read the one a call needs before making it:",
	...TOPICS.map((topic) => `- \`xd://fork_task/${topic.name}\` — ${topic.when}`),
].join("\n");

/** fork_task's `docTopics()`: topic name → body. */
export function forkTaskTopics(): Readonly<Record<string, string>> {
	return Object.fromEntries(TOPICS.map((topic) => [topic.name, topic.body]));
}
