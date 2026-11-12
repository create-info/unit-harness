#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
echo "using node: $($NODE_BIN -v) at $NODE_BIN"

echo "== 1. bundle host.cjs -> 单文件 CJS"
npx --yes esbuild@0.24.0 host.cjs --bundle --platform=node --format=cjs \
  --target=node22 --outfile=build/uh.bundle.cjs --log-level=warning

echo "== 2. 生成 SEA blob"
$NODE_BIN --experimental-sea-config sea-config.json

echo "== 3. 复制 node 基座并注入 blob"
cp "$NODE_BIN" build/uh
npx --yes postject@1.0.0-alpha.6 build/uh NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 2>/dev/null

chmod +x build/uh
echo "== done: build/uh ($(du -h build/uh | cut -f1))"
