// fork_task's call instructions kept out of its description, served by its `docTopics()` as
// xd://fork_task/<topic> and pointed to by the last lines of that description.
// Checked against: agent/extensions/fork-task/index.ts and replica.ts; pi-coding-agent@18.13.2
// src/task/index.ts, src/task/settings.ts, src/task/discovery.ts, src/eval/js/tool-bridge.ts.

interface Topic {
	readonly name: string;
	readonly when: string;
	readonly body: string;
}

const TOPICS: readonly Topic[] = [
	{
		name: "limits",
		when: "before using `from`, before forking a templated batch from eval, or when `fork_task` refuses to start",
		body: `# Prerequisites, unsupported fields, source errors and eval batches

- Requires background jobs (\`async.enabled\`), the native \`task\` tool, batch mode and a persisted session; a missing prerequisite is named in the error.
- Every child replicates the source's latest request (system prompt, tools, message prefix); \`context\`, an \`agent\` role and \`task\` arrive as its new user message. Omit \`agent\` to keep the source's model (shared cwd by default); name \`agent\` to run that agent's model binding with its prompt as a \`<role>\` block (isolated by default). The named agent's tool restrictions do not apply: the child has the source's tools. \`shake\` is opt-in, and no inherited-size/cost limit exists.
- Not available here: \`solutionSpace\`, \`sourceSession\`, \`model\` and \`tools\` are not fork fields; \`effort\` is ignored (\`task.enableEffort: false\`); \`outputSchema\`/\`schemaMode\` are ignored (\`task.structured: false\`).
- \`from\` resolves a registered id exactly, then case-insensitively; advisors cannot be sources. An empty value or your own id selects your conversation. Errors before dispatch name an unregistered source, a parked source (wake it with \`write agent://<id>\`, then fork), a source that has sent no request in this process, an unknown, disabled or internal \`agent\`, or a source with no persisted transcript.
- In isolated children, absolute paths from the copied conversation point to another checkout: use the same repository-relative paths in the child's own checkout.
- Plan mode: every child shares your workspace whatever \`isolated\` says.
- Results, follow-up, \`wait\` and \`proc://\` work as for \`task\`: see \`tool://task/results\` and \`tool://task/follow-up\`.
- Templated batch: from an eval cell, \`await tool.fork_task({context, tasks: items.map(...)})\` dispatches the same forks; it returns once they are spawned and their results arrive in your conversation, not in the cell.
- Children replay an in-process request snapshot. Same-process idle/park follow-ups are supported; cold revival after restart fails before provider dispatch when that snapshot is gone. Create a fresh fork rather than silently changing the child's contract.
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
