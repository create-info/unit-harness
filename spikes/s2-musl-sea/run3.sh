#!/bin/sh
set -e
cd /w
echo "== node: $(node -v) (musl)"

echo "== A. objcopy 产物是否真的加载了 SEA blob？"
if [ -f build/uh-objcopy ]; then
  echo -n "   --version   : "; ./build/uh-objcopy --version 2>&1 | head -1
  echo -n "   我们的版本? : "; ./build/uh-objcopy --version 2>&1 | grep -q "0.1.0" && echo "YES (blob loaded)" || echo "NO (blob not loaded; running bare node)"
  echo "   readelf 段:"
  readelf -S build/uh-objcopy 2>/dev/null | grep -i "sea\|NODE_SEA" | head -3 || echo "     (none)"
fi

echo "== B. postject 产物：fuse 残留数（应被替换为 0）"
if [ -f build/uh ]; then
  echo -n "   fuse count: "; strings build/uh | grep -c "NODE_SEA_FUSE" || true
  echo -n "   exit code : "; ./build/uh --version >/dev/null 2>&1; echo $?
fi

echo "== C. 可行性判定"
echo "   musl SEA: NOT USABLE yet (postject=segv, objcopy=blob ignored)"
