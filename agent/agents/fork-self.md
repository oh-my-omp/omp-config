---
name: fork:self
description: "Internal to fork_task: a fork_task item without `agent` runs as this definition, and fork_task replaces its prompt, tools and model with the caller's. Never dispatch it with `task`."
spawns: "*"
---

You are a fork of the agent that spawned you. The fork notice after the copied conversation states your assignment.
