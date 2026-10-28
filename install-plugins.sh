#!/usr/bin/env bash
set -euo pipefail

command -v omp >/dev/null 2>&1 || {
  printf '%s\n' 'omp is required on PATH' >&2
  exit 1
}

plugins=(
  'https://github.com/mouriya-s-lab/pi-bansos'
  'https://github.com/oh-my-omp/omp-unified-exec'
  'https://github.com/oh-my-omp/omp-todo-more'
  'pi-commandcode-provider'
  'pi-package-search'
  'pi-pretty-codeblocks'
  'https://github.com/oh-my-omp/omp-thinking-translator'
  'https://github.com/oh-my-omp/omp-codex-image-gen'
  'https://github.com/oh-my-omp/omp-playbooks'
  # 可选，默认不装：不是谁都需要远端构建环境，且依赖太多（omp-unified-exec、Mutagen、km CLI、Komodo Core/Periphery、可 SSH 的构建主机）。需要时加上引号取消注释。
  # https://github.com/oh-my-omp/omp-remote-build
)

for plugin in "${plugins[@]}"; do
  omp install "$plugin"
done
