---
name: omp-llm-tests-use-futureppo-pool
description: "LLM/omp/judge tests must run on the futureppo-pool provider (unlimited quota), never anthropic or other metered models"
condition: ["--model\\s+(?!futureppo-pool/)[\\w.-]+/[\\w.:-]+", "--model=(?!futureppo-pool/)[\\w.-]+/"]
scope: ["tool:exec_command", "tool:bash", "tool:task", "tool:write", "tool:edit"]
---

Any test that drives an LLM — `omp` PTY/e2e runs, probes, judge calls, acceptance commands written into issues, and instructions you give subagents — must use the `futureppo-pool` provider. It has unlimited quota. Write `--model futureppo-pool/<model>` (check `omp models` for the exact id). Do not pick `anthropic/…`, `opencode-go/…`, `openai-codex/…` or any other metered model for testing, and do not copy a model from an earlier issue's acceptance table if it is not futureppo-pool. If a test command or subagent brief already names another model, change it to futureppo-pool before you run it.