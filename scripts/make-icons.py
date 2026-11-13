"""
用 unitai.site 的品牌图标重新生成桌面端的全套图标。

站上的图标是白底五边形 + 六边形，之前桌面端用的是另一套（深色方块 + 绿勾），
两边不一致。这里以站上的 icon-512 为准，一次生成 Tauri 需要的全部尺寸。

icns 没有现成工具可用（没装 tauri CLI / icnsutil），按容器格式手写：
ICNS 支持直接嵌 PNG，块类型见下。
"""
import struct
import sys
from pathlib import Path
from PIL import Image

SRC = Path("/home/yanguogx10/Applications/ai-workplace/frontend/public/icon-512.png")
OUT = Path("/home/yanguogx10/Applications/unit-harness/src-tauri/icons")
OUT.mkdir(parents=True, exist_ok=True)

src = Image.open(SRC).convert("RGBA")
print("source:", src.size, src.mode)


def png_at(size: int) -> bytes:
    """按目标尺寸缩放并编码成 PNG 字节（用 LANCZOS，小尺寸下锯齿最轻）"""
    im = src.resize((size, size), Image.LANCZOS)
    tmp = OUT / f".tmp-{size}.png"
    im.save(tmp, format="PNG", optimize=True)
    data = tmp.read_bytes()
    tmp.unlink()
    return data


# --- Tauri 直接读的那几个 ---
for name, size in [
    ("32x32.png", 32),
    ("128x128.png", 128),
    ("128x128@2x.png", 256),
    ("icon.png", 512),
]:
    (OUT / name).write_bytes(png_at(size))
    print(f"  wrote {name} ({size}px)")

# --- Windows .ico：多尺寸打包 ---
src.save(OUT / "icon.ico", format="ICO",
         sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("  wrote icon.ico")

# --- macOS .icns：容器头 + 若干 PNG 块 ---
# 块类型到像素的对应（苹果定义的 PNG-capable 类型）
ICNS_BLOCKS = [
    (b"icp4", 16),
    (b"icp5", 32),
    (b"icp6", 64),
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic09", 512),
    (b"ic10", 1024),
    (b"ic11", 32),    # 16pt @2x
    (b"ic12", 64),    # 32pt @2x
    (b"ic13", 256),   # 128pt @2x
    (b"ic14", 512),   # 256pt @2x
]

chunks = b""
for tag, size in ICNS_BLOCKS:
    data = png_at(size)
    chunks += tag + struct.pack(">I", len(data) + 8) + data
icns = b"icns" + struct.pack(">I", len(chunks) + 8) + chunks
(OUT / "icon.icns").write_bytes(icns)
print(f"  wrote icon.icns ({len(icns)} bytes, {len(ICNS_BLOCKS)} blocks)")

# --- 验收：读回来确认不是空壳 ---
ok = True
for f, expect in [("icon.png", 512), ("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]:
    p = OUT / f
    im = Image.open(p)
    if im.size != (expect, expect):
        print(f"  FAIL {f}: {im.size} != {expect}")
        ok = False
ico = Image.open(OUT / "icon.ico")
print("  ico sizes:", sorted(ico.info.get("sizes", [])))
head = (OUT / "icon.icns").read_bytes()[:8]
print("  icns header:", head[:4], "declared len:", struct.unpack(">I", head[4:8])[0],
      "actual:", (OUT / "icon.icns").stat().st_size)
sys.exit(0 if ok else 1)
