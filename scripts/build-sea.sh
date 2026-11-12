#!/usr/bin/env bash
# 构建单文件 SEA 产物。必须用 CJS 入口（Node 22 限制，见 spikes/RESULTS.md#S1）。
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_BIN="${NODE_BIN:-$(command -v node)}"

[[ -f dist/uh.cjs ]] || node scripts/build.mjs

cat > build/sea-config.json <<'JSON'
{
  "main": "dist/uh.cjs",
  "output": "build/sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useCodeCache": false,
  "useSnapshot": false
}
JSON
mkdir -p build

"$NODE_BIN" --experimental-sea-config build/sea-config.json

TARGET="${TARGET:-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)}"
OUT="build/uh-${TARGET}"
cp "$NODE_BIN" "$OUT"
npx --yes postject@1.0.0-alpha.6 "$OUT" NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 2>/dev/null
chmod +x "$OUT"

echo "built $OUT ($(du -h "$OUT" | cut -f1))"
echo "smoke test:"
"$OUT" --version
