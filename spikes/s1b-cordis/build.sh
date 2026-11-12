#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
echo "using node: $($NODE_BIN -v)"

echo "== bundle (ESM source -> CJS, cordis inlined)"
npx --yes esbuild@0.24.0 host.mjs --bundle --platform=node --format=cjs \
  --target=node22 --outfile=build/uh.bundle.cjs --log-level=warning \
  --define:import.meta.url='"file:///sea"'

echo "== sea blob"
$NODE_BIN --experimental-sea-config sea-config.json

echo "== inject"
cp "$NODE_BIN" build/uh
npx --yes postject@1.0.0-alpha.6 build/uh NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 2>/dev/null
chmod +x build/uh
echo "== done ($(du -h build/uh | cut -f1))"
