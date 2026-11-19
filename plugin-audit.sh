#!/usr/bin/env bash
set -euo pipefail

BASE="5974c4fa2f237b951befa935d45d8cd8efd5d30e"
SCRIPT="install-plugins.sh"
PLUGINS_PKG="$HOME/.omp/plugins/package.json"

command -v omp >/dev/null 2>&1 || { printf '%s\n' 'omp 不在 PATH' >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { printf '%s\n' 'bun 不在 PATH' >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  printf '%s\n' '需在 omp-config 仓库内运行' >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
git cat-file -e "${BASE}^{commit}" 2>/dev/null || {
  printf '%s\n' "基准提交 ${BASE} 不存在" >&2; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

PKG="$PLUGINS_PKG" bun -e '
  const file = Bun.file(Bun.env.PKG ?? "");
  if (await file.exists()) {
    const deps = (await file.json()).dependencies ?? {};
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === "string") console.log(`${spec.split("#", 1)[0].replace(/\.git$/, "")}\t${name}`);
    }
  }
' > "$tmp/deps"

normalize() {
  local e="$1" name
  e="${e%%#*}"
  case "$e" in
    *://*|git@*|*.git)
      e="${e%.git}"
      name="$(awk -F '\t' -v src="$e" '$1 == src { print $2; exit }' "$tmp/deps")"
      if [ -n "$name" ]; then e="$name"; else e="${e##*/}"; fi ;;
    @*)
      local rest="${e#@}"
      case "$rest" in
        */*@*) e="@${rest%@*}" ;;
        *)     e="@$rest" ;;
      esac ;;
    *@*) e="${e%@*}" ;;
  esac
  [ -n "$e" ] && printf '%s\n' "$e"
}

block_at() {
  git show "${1}:${SCRIPT}" 2>/dev/null \
    | awk '/plugins=\(/{f=1;next} f&&/^[[:space:]]*\)/{f=0} f{print}' || true
}
entries_at() { block_at "$1" | grep -v '^[[:space:]]*#' | grep -oE "'[^']+'" | tr -d "'" || true; }
optional_at() {
  block_at "$1" | sed -nE "s/^[[:space:]]*#[[:space:]]*'?([^'[:space:]]+)'?[[:space:]]*$/\\1/p"
}

norm_stream() { while IFS= read -r e; do [ -n "$e" ] && normalize "$e"; done; }

hist_keys() {
  {
    entries_at "$BASE"
    for c in $(git rev-list "${BASE}..HEAD" -- "$SCRIPT"); do entries_at "$c"; done
  } | norm_stream | sort -u
}
head_keys() { entries_at HEAD | norm_stream | sort -u; }
optional_keys() { optional_at HEAD | norm_stream | sort -u; }
installed_keys() {
  omp plugin list --json \
    | { grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' || test "$?" -eq 1; } \
    | sed -E 's/.*:[[:space:]]*"([^"]+)".*/\1/' | sort -u
}

optional_keys  > "$tmp/optional"
hist_keys | comm -23 - "$tmp/optional" > "$tmp/hist"
head_keys      > "$tmp/head"
installed_keys > "$tmp/inst"
comm -23 "$tmp/hist" "$tmp/head" > "$tmp/removed"
comm -23 "$tmp/head" "$tmp/inst" > "$tmp/missing"
comm -12 "$tmp/removed" "$tmp/inst" > "$tmp/uninst"
comm -23 "$tmp/inst" "$tmp/hist" > "$tmp/unmanaged"
comm -12 "$tmp/head" "$tmp/inst" > "$tmp/synced"

section() { printf '\n== %s ==\n' "$1"; if [ -s "$2" ]; then cat "$2"; else printf '(无)\n'; fi; }

printf '基准提交: %s\n' "$BASE"
printf '脚本: %s\n' "$SCRIPT"
section '已安装（omp plugin list）' "$tmp/inst"
section '脚本当前列表（HEAD）' "$tmp/head"
section '脚本当前可选（HEAD 注释条目）' "$tmp/optional"
section '[安装] 脚本要求但本机缺失 -> 跑 ./install-plugins.sh' "$tmp/missing"
section '[卸载候选] 历史存在过、当前已移除、本机仍装 -> 询问用户后 omp plugin uninstall <name>' "$tmp/uninst"
section '[仅供参考] 历史存在过、当前脚本已移除（全部）' "$tmp/removed"
section '[保留] 本机安装、非脚本必装（用户自装或当前可选插件，勿动）' "$tmp/unmanaged"
section '[已同步] 脚本与本机一致' "$tmp/synced"
