#!/usr/bin/env bash
# 共享模块一致性校验（v1.9.4）
# 微信云函数需每个目录自带 questionTypes.js/knowledgeBook.js 副本，
# 本脚本在打包前校验各副本与前端基准一致，防止"改一处漏一处"导致判分口径分裂。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$ROOT/miniprogram/utils"
FAILED=0

# check <文件名> <基准云函数目录> <待比对云函数目录...>
check() {
  local file="$1"; local ref="$2"; shift 2
  local src="$ROOT/cloudfunctions/$ref/$file"
  [ -f "$src" ] || { echo "基准缺失: $src"; FAILED=1; return 1; }
  for d in "$@"; do
    local dst="$ROOT/cloudfunctions/$d/$file"
    [ -f "$dst" ] || { echo "  ✗ $d/$file 缺失"; FAILED=1; continue; }
    if cmp -s "$src" "$dst"; then
      echo "  ✓ $d/$file"
    else
      echo "  ✗ $d/$file 与基准($ref)不一致"
      FAILED=1
    fi
  done
}

# questionTypes.js / knowledgeBook.js：以前端 utils 为基准，校验是否需同步到云函数
checkFrontend() {
  local file="$1"; shift
  local src="$BASE/$file"
  [ -f "$src" ] || { echo "基准缺失: $src"; FAILED=1; return 1; }
  for d in "$@"; do
    local dst="$ROOT/cloudfunctions/$d/$file"
    [ -f "$dst" ] || { echo "  ✗ $d/$file 缺失"; FAILED=1; continue; }
    if cmp -s "$src" "$dst"; then echo "  ✓ $d/$file"; else echo "  ✗ $d/$file 与前端基准不一致"; FAILED=1; fi
  done
}

echo "== questionTypes.js (基准:前端) =="
checkFrontend questionTypes.js recognize composeTask submitAnswer importQuestions feedback
echo "== knowledgeBook.js (基准:前端) =="
checkFrontend knowledgeBook.js recognize
echo "== contentCheck.js (基准:recognize) =="
check contentCheck.js recognize login submitAnswer importQuestions
echo "== badges.js (基准:前端) =="
checkFrontend badges.js submitAnswer login
echo "== farmData.js (基准:前端) =="
checkFrontend farmData.js farm

if [ "$FAILED" -ne 0 ]; then
  echo "【共享模块不一致】请从 miniprogram/utils/ 复制到对应云函数目录后重试打包。" >&2
  exit 1
fi
echo "所有共享模块一致 ✓"
exit 0
