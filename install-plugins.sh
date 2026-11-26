#!/usr/bin/env bash
set -euo pipefail

command -v omp >/dev/null 2>&1 || {
  printf '%s\n' 'omp is required on PATH' >&2
  exit 1
}

plugins=(
  'https://github.com/mouriya-s-lab/pi-bansos'
  'https://github.com/oh-my-omp/omp-actual-terminal#release'
  'https://github.com/oh-my-omp/omp-todo-ng#release'
  'https://github.com/oh-my-omp/omp-thinking-translator#release'
  'https://github.com/oh-my-omp/omp-ask-ng#release'
  'https://github.com/oh-my-omp/omp-peers#release'
  'https://github.com/oh-my-omp/omp-sessions#release'
  'https://github.com/oh-my-omp/omp-subagent-ng#release'
  # https://github.com/oh-my-omp/omp-dispatch#release
  # https://github.com/oh-my-omp/omp-playbooks#release
  # https://github.com/oh-my-omp/omp-remote-build#release
)

for plugin in "${plugins[@]}"; do
  omp install "$plugin"
done
