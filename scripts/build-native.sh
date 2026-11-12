#!/usr/bin/env bash
# 编译 landlock helper 并安装到 ~/.uh/bin（P1 的隔离能力来自它）
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=native/landlock-helper/build
mkdir -p "$OUT"
CC="${CC:-cc}"
"$CC" -O2 -Wall -Wextra -o "$OUT/landlock-helper" native/landlock-helper/landlock-helper.c
echo "built $OUT/landlock-helper"

# 安装到用户目录，供 uh 直接发现
DEST="$HOME/.uh/bin"
mkdir -p "$DEST"
cp "$OUT/landlock-helper" "$DEST/landlock-helper"
chmod +x "$DEST/landlock-helper"
echo "installed $DEST/landlock-helper"

if "$DEST/landlock-helper" --probe >/dev/null 2>&1; then
  echo "landlock abi: $("$DEST/landlock-helper" --probe)"
else
  echo "WARN: landlock not supported by this kernel" >&2
fi
