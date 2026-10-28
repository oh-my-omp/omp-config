#!/usr/bin/env bash
# plugin-audit.sh — 对比 install-plugins.sh 的历史插件名与本机已装插件。
#
# 扫描范围：仅 install-plugins.sh 这一个脚本，提交范围 BASE..HEAD（含 BASE）。
# BASE 固定为版本号/git-ref 被清理成裸包名之后的第一个提交，早于它的带
# `@version` / `#sha` 的历史不参与，避免把同一插件的旧钉版当成不同插件。
# 归一后直接与 `omp plugin list --json` 对比并给出分类结论，无需再人工跑一遍。
#
# plugins=( … ) 内的未注释条目是必装插件；只含一个源的注释行（如
# `# https://github.com/oh-my-omp/omp-remote-build`）是 HEAD 的可选插件，不算缺失、
# 不进卸载候选，本机已装时归入 [保留]。
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

# 本机依赖表：`omp install` 在 ~/.omp/plugins/package.json 的 dependencies 里记下
# 包名 -> 源。输出 "去 #ref 与 .git 的源<TAB>包名"，供 Git/URL 条目查真实包名。
PKG="$PLUGINS_PKG" bun -e '
  const file = Bun.file(Bun.env.PKG ?? "");
  if (await file.exists()) {
    const deps = (await file.json()).dependencies ?? {};
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === "string") console.log(`${spec.split("#", 1)[0].replace(/\.git$/, "")}\t${name}`);
    }
  }
' > "$tmp/deps"

# 脚本条目 -> 插件包名 key（与 omp plugin list 的 name 对齐）。
# Git/URL 条目按本机依赖表取已装包名；本机未装时回退为 URL 末段 basename。
normalize() {
  local e="$1" name
  e="${e%%#*}"                        # 去 git ref (#sha / #branch)
  case "$e" in
    *://*|git@*|*.git)                # URL / git 源 -> 已装包名，否则 basename
      e="${e%.git}"
      name="$(awk -F '\t' -v src="$e" '$1 == src { print $2; exit }' "$tmp/deps")"
      if [ -n "$name" ]; then e="$name"; else e="${e##*/}"; fi ;;
    @*)                               # scoped 包 @scope/name[@ver]
      local rest="${e#@}"
      case "$rest" in
        */*@*) e="@${rest%@*}" ;;     # @scope/name@ver -> @scope/name
        *)     e="@$rest" ;;
      esac ;;
    *@*) e="${e%@*}" ;;               # name@ver -> name
  esac
  [ -n "$e" ] && printf '%s\n' "$e"
}

# 某个版本脚本的 plugins=( ... ) 块。
block_at() {
  git show "${1}:${SCRIPT}" 2>/dev/null \
    | awk '/plugins=\(/{f=1;next} f&&/^[[:space:]]*\)/{f=0} f{print}' || true
}
# 未注释行里的单引号条目（必装）。
entries_at() { block_at "$1" | grep -v '^[[:space:]]*#' | grep -oE "'[^']+'" | tr -d "'" || true; }
# 只含一个源的注释行（可选），引号可有可无；说明性注释含空格，不匹配。
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
  # grep 的 1 表示空列表；仅忽略这个状态，保留命令或管道的实际错误。
  omp plugin list --json \
    | { grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' || test "$?" -eq 1; } \
    | sed -E 's/.*:[[:space:]]*"([^"]+)".*/\1/' | sort -u
}

optional_keys  > "$tmp/optional"
hist_keys | comm -23 - "$tmp/optional" > "$tmp/hist"   # 历史必装项，扣除当前可选
head_keys      > "$tmp/head"
installed_keys > "$tmp/inst"
comm -23 "$tmp/hist" "$tmp/head" > "$tmp/removed"      # 历史有、当前脚本已移除
comm -23 "$tmp/head" "$tmp/inst" > "$tmp/missing"      # 脚本要、本机缺
comm -12 "$tmp/removed" "$tmp/inst" > "$tmp/uninst"    # 已移除且本机仍装（卸载候选）
comm -23 "$tmp/inst" "$tmp/hist" > "$tmp/unmanaged"    # 本机装、非脚本必装（自装或可选）
comm -12 "$tmp/head" "$tmp/inst" > "$tmp/synced"       # 已同步

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
