---
tool: eval
name: tools
title: Defining tools in a cell for subagents
when: before giving subagents a fixed procedure, a shared store, or a guarded action they would otherwise improvise, or before passing `tools` to `agent()`, `workpool()` or a `task` item
upstream: pi-coding-agent@18.18.0 src/task/eval-tools.ts, src/eval/py/prelude.py#_tool_schema, src/eval/js/shared/prelude.txt#registerTool, src/prompts/tools/eval-helpers.md, src/prompts/tools/eval-agents.md, src/prompts/tools/task.md
---
# Defining tools in a cell for subagents

A function you define in a cell becomes a tool a subagent can call. The child sees only its name, description and parameter schema; each call runs the function in your kernel, against your variables. Use it to hand children a ready-made step instead of instructions they must follow by hand:

| Purpose | Tool does |
|---|---|
| Template step | One fixed procedure behind one call: write a record in the exact format, run the check command with the right flags, look up an id. The child supplies only the varying values. |
| Guard a weak model | Parameters it cannot get wrong (`Literal`/`enum`, required fields), validation that raises a message saying how to fix the call, invariants the child cannot skip. |
| Shared state | Caches, dedup sets, scores or results accumulated across children in one kernel; you read them as data afterwards instead of parsing child prose. |

## Define

Python, schema inferred from the signature, description from the docstring:

```python
from typing import Literal

findings = []

@tool
def report(path: str, line: int, severity: Literal["low", "high"], note: str = "") -> str:
    """Record one finding. line is 1-based."""
    if line < 1:
        raise ValueError("line is 1-based; resend with line >= 1")
    findings.append({"path": path, "line": line, "severity": severity, "note": note})
    return f"recorded {len(findings)}"
```

- `@tool(name=…, description=…)` overrides the function name and docstring. Names match `[A-Za-z_][A-Za-z0-9_]{0,63}`.
- Annotations map to the schema: `str`, `int`, `float`, `bool`, `list[T]`, `dict[str, T]`, `Literal[…]` (enum), `T | None`. Unannotated or other types accept anything. A parameter without a default is required; a JSON-able default is shown. The schema allows no other arguments; positional-only parameters fail the definition; `*args`/`**kwargs` are not exposed.

JavaScript, the function receives one object of arguments:

```js
tool(function report({ path, line }) { /* … */ return "recorded"; }, {
  description: "Record one finding. line is 1-based.",
  parameters: { type: "object", properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 } },
    required: ["path", "line"], additionalProperties: false },
});
```

Always pass `parameters` in JS: without it the child sees an object with no properties and guesses the arguments.

`tool.defined()` lists the defined names; `tool.undefine(name)` removes one. A name defined in both the Python and the JS kernel fails every spawn that requests it.

## Hand to children

- `agent(prompt, tools=["report"])` / JS `agent(prompt, { tools: ["report"] })`, `workpool(agent, tools=[…])`, or `tools: […]` on a `task` item.
- Each name must be defined when the child is spawned; otherwise the spawn fails and lists the defined names. Not available in plan mode.
- Say in the prompt when the child must use the tool and what a result or error means; besides that, the child knows only the description and the schema.

## Calls and results

- The function runs in your kernel with its working directory, files and state, also for an `isolated` child: it does not run in the child's worktree. Calls are served while your cell is blocked in the child's `.wait()`.
- A string return reaches the child as is; any other value as JSON. A raised exception returns its message to the child as a tool error; your kernel keeps running, so raise with the correction you want the child to make.
- The schema is fixed when the child starts; the body is looked up by name on each call, so redefining the function changes what running children get, and undefining it makes their calls fail.
- Resetting the kernel, or a JS cell timeout (which resets the JS VM), removes every tool of that kernel; calls from running children then fail. After your session ends, calls report the tool unavailable.
