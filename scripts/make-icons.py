"""
用 unitai.site 自己的品牌图标生成桌面端全套图标。

源用站上的 icon-512.png（512×512，透明底）。有个教训值得写下来：
同一个站上有三个"logo"，长得像但不是一回事——

  icon-512.png   512px，五圆点 **带连线** + 立体六边形   ← 桌面图标用这个
  logo-mark.png   96px，同样带连线，但只有 96px
  logo-tile.png   96px，同上，外加一块白色圆角底

前两次都用了 96px 那两个，等于把 logo 放大 6 倍，结果线条发糊。真源是 icon-512，
不需要放大，也不需要锐化。

图形在 512 画布里偏上偏左（bbox 14,71 - 500,441），所以按 alpha 收紧后放进正方形
画布居中，留 8% 边距——不裁的话四周空白会让图标在 dock 里显得小一圈。

icns 没有现成工具可用（没装 tauri CLI / icnsutil），按容器格式手写：
ICNS 支持直接嵌 PNG 块。
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

# 按 alpha 收紧。阈值 24 而不是 0：全透明之外还要排掉极淡的边缘残留，
# 否则 bbox 会被抗锯齿光晕撑大。
alpha = src.split()[3]
bbox = alpha.point(lambda v: 255 if v > 24 else 0).getbbox()
if not bbox:
    sys.exit("source image is fully transparent")
print("tight bbox:", bbox, "->", (bbox[2] - bbox[0], bbox[3] - bbox[1]))

crop = src.crop(bbox)
w, h = crop.size
side = int(round(max(w, h) / 0.84))        # 图形占 84%，四周各 8% 边距
square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
square.paste(crop, ((side - w) // 2, (side - h) // 2), crop)
print("square canvas:", square.size)


def render(size: int) -> Image.Image:
    """源 512，往下缩是主力路径。不做锐化：源本身够清晰，锐化只会让边缘出白边。"""
    return square.resize((size, size), Image.LANCZOS)


def png_at(size: int) -> bytes:
    tmp = OUT / f".tmp-{size}.png"
    render(size).save(tmp, format="PNG", optimize=True)
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
render(256).save(
    OUT / "icon.ico", format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("  wrote icon.ico")

# --- macOS .icns：容器头 + 若干 PNG 块 ---
ICNS_BLOCKS = [
    (b"icp4", 16),
    (b"icp5", 32),
    (b"icp6", 64),
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic09", 512),
    (b"ic11", 32),
    (b"ic12", 64),
    (b"ic13", 256),
    (b"ic14", 512),
]

chunks = b""
for tag, size in ICNS_BLOCKS:
    data = png_at(size)
    chunks += tag + struct.pack(">I", len(data) + 8) + data
icns = b"icns" + struct.pack(">I", len(chunks) + 8) + chunks
(OUT / "icon.icns").write_bytes(icns)
print(f"  wrote icon.icns ({len(icns)} bytes, {len(ICNS_BLOCKS)} blocks)")

# 透明底分别放在白底和深色底上看一遍——dock 里是深色，文件管理器里可能是浅色
for bg, name in [((255, 255, 255, 255), "/tmp/icon-preview-white.png"),
                 ((28, 30, 34, 255), "/tmp/icon-preview-dark.png")]:
    canvas = Image.new("RGBA", (384, 384), bg)
    big = render(384)
    canvas.paste(big, (0, 0), big)
    canvas.convert("RGB").save(name)
print("  previews: /tmp/icon-preview-white.png, /tmp/icon-preview-dark.png")

# --- 验收：读回来确认不是空壳 ---
ok = True
for f, expect in [("icon.png", 512), ("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]:
    im = Image.open(OUT / f)
    if im.size != (expect, expect):
        print(f"  FAIL {f}: {im.size} != {expect}")
        ok = False
    if im.mode != "RGBA":
        print(f"  WARN {f}: mode {im.mode} (expected RGBA — a flattened icon loses its transparency)")
ico = Image.open(OUT / "icon.ico")
print("  ico sizes:", sorted(ico.info.get("sizes", [])))
head = (OUT / "icon.icns").read_bytes()[:8]
print("  icns header:", head[:4], "declared:", struct.unpack(">I", head[4:8])[0],
      "actual:", (OUT / "icon.icns").stat().st_size)
sys.exit(0 if ok else 1)
