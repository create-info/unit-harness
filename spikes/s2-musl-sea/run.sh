#!/bin/sh
set -e
cd /w
echo "== musl node: $(node -v) | libc: $(node -p 'process.report.getReport().header.glibcVersionRuntime || "musl"')"
echo "== 1. sea blob"
node --experimental-sea-config sea-config.json
echo "== 2. postject"
npm i -g --registry=https://registry.npmmirror.com --silent postject >/dev/null 2>&1
echo "== 3. inject into musl node base"
cp "$(command -v node)" build/uh
postject build/uh NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 2>/dev/null
chmod +x build/uh
echo "== 4. size: $(du -h build/uh | cut -f1)"
echo "== 5. RUN"
UH_PLUGIN_DIR=/w/plugins ./build/uh
