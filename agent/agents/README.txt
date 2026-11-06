SUBAGENT PITFALLS
=================

The *.md files here are custom agent definitions. Every item below was observed on
this machine, not inferred from docs. Harness references: omp://task-agent-discovery.md,
omp://tools/task.md, omp://tools/wait.md

This file is .txt on purpose. See item 13.
Simplified Chinese version: README.zh-CN.txt (same items, kept in step with this file).


1. No `spawns` key means the child holds a `task` tool that can never spawn anything
-------------------------------------------------------------------------------------
With neither `tools` nor `spawns` in the frontmatter, the child session gets an empty
spawn policy while `task` stays in its tool list. Every call is then refused at
preflight:

    Cannot spawn 'mentor:default'. Allowed: none (spawns disabled for this agent)

A missing `spawns` only defaults to "*" when the `tools` list itself contains `task`
(backward-compat behaviour, omp://task-agent-discovery.md, "Agent definition shape").
Declare neither and you get a dead tool. Prompt wording cannot work around this.


2. Prefer an explicit allowlist over `spawns: "*"`
---------------------------------------------------
The two forms differ in what an omitted `agent` field resolves to:

    spawns: "*"        -> omitted `agent` resolves to the bundled `task`
    spawns: a, b, c    -> omitted `agent` resolves to the first listed name

The bundled `task` sits in `task.disabledAgents` in config.yml (along with `scout`,
`sonic`, `reviewer`, `security-reviewer`), so "*" plus an omitted field is a hard
preflight failure. An explicit list closes that trap for free — but choose the first
entry deliberately, because it is the silent default. `task-high.md`, the only
worker that spawns other workers, lists `task:mid` (the default worker tier) first;
`task-free.md`, `task-low.md`, and `task-mid.md` list only `mentor:default`.


3. Names in `task.disabledAgents` fail even when allowlisted
-------------------------------------------------------------
Currently disabled: task, scout, sonic, reviewer, security-reviewer. Listing one in
`spawns` does not revive it. Ordinary `task` calls must name `agent` explicitly;
relying on the default walks into item 2. `fork_task` is different: every child
runs as internal `fork:self`, and `agent` only picks a model binding and a role.


4. Recursion depth 2: grandchildren are leaves
-----------------------------------------------
`task.maxRecursionDepth` defaults to 2. A worker spawned by the main agent sits at
depth 1; that worker's own child sits at depth 2, which is the cap — its `task` tool
is *stripped* and its spawn policy cleared.

Consequence: an agent at depth 1 can fan out one level, but whatever it hands out must
be directly executable, never "decompose this further". A plan that needs three live
levels has to start one level shallower. A worker spawned at depth 2 also cannot reach
its own `mentor:default`.

Observed: a depth-2 `task:free` child had no `task` tool in its tool list.


5. Every child must deliver through `yield`; with only `yield`, prose is lost
------------------------------------------------------------------------------
`config.yml` sets `task.structured: true`, so every task child has the `yield` tool and
must finish through it: the `yield` payload is the result its parent receives. Every
definition here declares the same `output` schema, `{ report: string }`; without it a
structured run accepts any object and each child picks its own shape. On OMP 18.16 a
child without structured mode gets no `yield` at all, so do not turn the setting off
while these definitions require `yield`.

`mentor-default.md` declares `tools: []`, so `yield` is its only tool. Observed failure
chain when it answered in prose instead:

    writes the full answer as plain prose, no tool call
      -> harness injects "Last turn had no tool call -> session idle"
      -> the forced follow-up `yield` carries nothing
      -> job ends `failed (exit 1)` + "Subagent called yield with null data."

and `agent://<id>` held no answer at all. Its Dialogue section therefore requires the
opening answer in the `yield` payload and forbids ending a turn with text only.


6. `agent://` and `history://` are not the same thing
------------------------------------------------------
    agent://<id>            the consumption channel; the `yield` payload lands here
    history://<id>          the full transcript, showing how it actually proceeded
    agent://<id>/field      pull one field (path segments, `/items/0`) out of a structured result

A failed job can leave a perfectly good transcript behind an empty artifact (item 5).
When debugging a failed child, read `history://` first; job status alone misleads.


7. Job ids expire, agent ids do not
------------------------------------
Job rows are process-local and disappear roughly five minutes after settling. After
that the agent id is the only handle: `write agent://<id>`, `agent://<id>`, `history://<id>`.


8. A child stays reachable after it yields
-------------------------------------------
Yielding moves a child to idle, and later to parked, but a `write agent://<id>` message
wakes it with its context intact; it answers with a new `yield`, which reaches the
sender as a fresh task result. That is how discussants and mentors do multiple rounds. Spawning a
fresh one to continue the same topic throws away everything it read and pays for it
again.


9. Plan mode silently rewrites the child
-----------------------------------------
While the parent is in plan mode, children are wrapped read-only: tools cut to
read/grep/glob/web_search, spawns cleared, prewalk cleared. When debugging a spawn
problem, confirm you are not in plan mode first, or you are measuring the wrapper
rather than the agent definition.


10. Editing an agent file needs no restart
-------------------------------------------
Settings are reloaded and agents rediscovered before each dispatch, so an edit here
takes effect on the next spawn. Already-running children keep the prompt they started
with; there is no hot reload for a live agent.


11. Names are case-sensitive and first-wins
--------------------------------------------
Project `.omp/agents` overrides user `~/.omp/agent/agents`, custom overrides bundled,
and within one directory files are read in lexicographic filename order with duplicate
names dropped. `Task` and `task` are two different agents.


12. One broken definition does not take the others down
--------------------------------------------------------
A frontmatter failure in a custom agent file is logged as a warning and the file is
skipped. Only bundled parsing is fatal. So a file you broke presents as "that agent
mysteriously does not exist" rather than as a parse error — check ~/.omp/logs for the
warning instead of expecting a failure at the call site.


13. Do not leave a non-agent .md in this directory
---------------------------------------------------
Every .md here is parsed as an agent-definition candidate. A plain note produces, on
every discovery pass:

    warn "Failed to read agent file"
    AgentParsingError: Failed to parse agent: Invalid agent field: .../<file>.md

Observed twice per single spawn. Harmless per item 12, but it is permanent log noise
on every dispatch. Keep notes as .txt — non-markdown files are never scanned.


14. `completionJudge: true` opts the agent into completion judging
------------------------------------------------------------------
The `task-completion-judge` extension intercepts terminal structured `yield`
calls only from subagents whose definition file declares `completionJudge: true`
in its frontmatter. Unknown frontmatter keys are ignored by the host, so the
key is safe to add. Without it the subagent's yields pass unjudged. The shipped
`task-free`, `task-mid` and `task-low` declare it; `task:high` does not.
