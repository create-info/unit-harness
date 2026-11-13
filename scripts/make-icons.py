"""
用 unitai.site 自己的品牌 mark 生成桌面端全套图标。

之前桌面端用的是另一套标记（深色圆角方块 + 绿勾），和站上的五边形网络图标不一致。
这里以站上 header 实际使用的 logo-mark.png 为准。

两条实测结论决定了实现方式：

1) 站上只有 96px 的 PNG，其中真实图形只占 77×77（四周约 20px 透明留白）。
   必须按 alpha 收紧后再放大，否则留白跟着一起放大，图标在 dock 里会显得小一圈。
2) 不要试图按几何重画。五个圆点和连线是连通的，连通域只会返回一整块，无法
   反推圆心；按"标准五边形"硬解方程会得到互相重叠的圆。直接用原图放大更忠实。

放大后的细线会发虚，所以 128px 以上过一遍轻微 unsharp，半径小、强度低，避免出白边。

icns 没有现成工具可用（没装 tauri CLI / icnsutil），按容器格式手写：ICNS 支持直接嵌 PNG 块。
"""
import struct
import sys
from pathlib import Path

from PIL import Image, ImageFilter

SRC = Path("/home/yanguogx10/Applications/ai-workplace/frontend/public/logo-mark.png")
OUT = Path("/home/yanguogx10/Applications/unit-harness/src-tauri/icons")
OUT.mkdir(parents=True, exist_ok=True)

src = Image.open(SRC).convert("RGBA")
print("source:", src.size)

# 按 alpha 收紧到真实图形边界。阈值 150 而不是 0：alpha>0 会把极淡的抗锯齿像素
# 也算进 bbox，四周白白多出 20px。
alpha = src.split()[3]
bbox = alpha.point(lambda v: 255 if v > 150 else 0).getbbox()
if not bbox:
    sys.exit("source image is fully transparent")
print("tight bbox:", bbox)

crop = src.crop(bbox)
w, h = crop.size
side = int(max(w, h) * 1.10)          # 留 5% 边距，图标不顶边
square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
square.paste(crop, ((side - w) // 2, (side - h) // 2), crop)
print("square canvas:", square.size)


def render(size: int) -> Image.Image:
    """直接从正方形源缩到目标尺寸，不经过中间放大——少一次重采样就少一次糊"""
    im = square.resize((size, size), Image.LANCZOS)
    if size >= 128:
        im = im.filter(ImageFilter.UnsharpMask(radius=0.8, percent=55, threshold=0))
    return im


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

# 白底预览，方便肉眼确认
white = Image.new("RGBA", (384, 384), (255, 255, 255, 255))
big = render(384)
white.paste(big, (0, 0), big)
white.convert("RGB").save("/tmp/icon-preview-white.png")
print("  preview: /tmp/icon-preview-white.png")

# --- 验收：读回来确认不是空壳 ---
ok = True
for f, expect in [("icon.png", 512), ("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]:
    im = Image.open(OUT / f)
    if im.size != (expect, expect):
        print(f"  FAIL {f}: {im.size} != {expect}")
        ok = False
ico = Image.open(OUT / "icon.ico")
print("  ico sizes:", sorted(ico.info.get("sizes", [])))
head = (OUT / "icon.icns").read_bytes()[:8]
print("  icns header:", head[:4], "declared:", struct.unpack(">I", head[4:8])[0],
      "actual:", (OUT / "icon.icns").stat().st_size)
sys.exit(0 if ok else 1)
