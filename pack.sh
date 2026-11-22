#!/usr/bin/env bash
# 智学打卡小程序打包脚本
# 用法：bash pack.sh [版本号]
#   - 不带参数：读取项目根目录 VERSION 文件内容作为版本号
#   - 带参数：使用传入的版本号（同时写回 VERSION 文件）
# 产物：/workspace/智学打卡小程序_v<版本号>_<日期>.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION_FILE="$ROOT/VERSION"
OUT_DIR="/workspace"
DATE="$(date +%Y%m%d)"

# 确定版本号
if [ "$#" -ge 1 ] && [ -n "$1" ]; then
  VERSION="$1"
  printf '%s\n' "$VERSION" > "$VERSION_FILE"
else
  VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
fi

if [ -z "$VERSION" ]; then
  echo "错误：版本号为空，请检查 VERSION 文件或传入版本号" >&2
  exit 1
fi

NAME="智学打卡小程序_v${VERSION}_${DATE}"
ZIP_PATH="$OUT_DIR/${NAME}.zip"

# 打包（排除 .git / node_modules / 上传密钥 / CI脚本 / 系统文件）
# 重要：private.key 含敏感凭证，绝不能打进小程序包！
cd "$OUT_DIR"
rm -f "$ZIP_PATH"
zip -r -q "$ZIP_PATH" "$(basename "$ROOT")" \
  -x "*.git/*" "*/.git/*" "*.git" "*/node_modules/*" "*.DS_Store" \
     "*/private.key" "*/ci-upload.js" "*/package.json" "*/package-lock.json" \
     "*/*.zip"

echo "版本：$VERSION"
echo "产物：$ZIP_PATH"
echo "大小：$(du -h "$ZIP_PATH" | cut -f1)"
