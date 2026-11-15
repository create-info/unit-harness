#!/bin/sh
set -e
cd /w
echo "== node: $(node -v) | libc: $(node -p 'process.report.getReport().header.glibcVersionRuntime || "musl"')"

echo "== A. 检查 postject 产物"
if [ -f build/uh ]; then
  echo "   file: $(file -b build/uh 2>/dev/null | head -c 120)"
  echo "   size: $(du -h build/uh | cut -f1)"
  echo -n "   fuse 字符串仍存在? "; strings build/uh | grep -c "NODE_SEA_FUSE" || true
  echo -n "   run 空调用: "; ./build/uh >/dev/null 2>&1 && echo OK || echo "FAILED exit=$?"
fi

echo "== B. 用 objcopy 方式注入（postject 的替代路径）"
cp "$(command -v node)" build/uh-objcopy
objcopy --add-section NODE_SEA_BLOB=sea-prep.blob \
        --set-section-flags NODE_SEA_BLOB=alloc,readonly \
        build/uh-objcopy 2>&1 | head -3
chmod +x build/uh-objcopy
echo -n "   run 空调用: "; ./build/uh-objcopy >/dev/null 2>&1 && echo OK || echo "FAILED exit=$?"
echo "   RUN:"
UH_PLUGIN_DIR=/w/plugins ./build/uh-objcopy 2>&1 | head -12 || true
