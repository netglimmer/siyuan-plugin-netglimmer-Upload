#!/usr/bin/env python3
"""生成插件图标 icon.png（思源集市卡片用的那张）。

为什么自己画、不用 AI 出图：这个图标要在 64px 的卡片缩略图里仍然读得出「文档 + 上传」，
而且必须可复现、可改（改颜色/改几何就是改几个常量）。机器上没有 PIL / cairosvg / rsvg-convert /
ImageMagick，所以这里用零依赖实现：多边形扫描线光栅化（纵向 4 次采样 + 横向精确覆盖）
+ zlib 手写 PNG 编码。产物是确定的：同样的脚本永远得到同样的字节。

用法：python3 tools/make-icon.py            # 写 icon.png + 预览
     python3 tools/make-icon.py --check   # 只校验现有 icon.png 的规格（打包前自检用）
"""
import os
import struct
import sys
import zlib

S = 512              # 画布边长（正方形，思源按等比缩放显示）
SUB = 4              # 每个像素行的纵向采样数


# ---------- 颜色与几何工具 ----------
def hexc(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def lerp(a, b, t):
    return a + (b - a) * t


def grad(c0, c1, y0, y1, y):
    """竖直线性渐变（y 在 [y0,y1] 之外按端点截断）。"""
    t = 0.0 if y1 == y0 else max(0.0, min(1.0, (y - y0) / (y1 - y0)))
    return tuple(lerp(c0[i], c1[i], t) for i in range(3))


def rounded_rect(x, y, w, h, r, seg=10):
    """圆角矩形 → 多边形（每角 seg 段圆弧）。"""
    pts = []
    corners = [(x + w - r, y + r, -90, 0), (x + w - r, y + h - r, 0, 90),
               (x + r, y + h - r, 90, 180), (x + r, y + r, 180, 270)]
    import math
    for cx, cy, a0, a1 in corners:
        for i in range(seg + 1):
            a = math.radians(lerp(a0, a1, i / seg))
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def circle(cx, cy, r, seg=72):
    import math
    return [(cx + r * math.cos(2 * math.pi * i / seg),
             cy + r * math.sin(2 * math.pi * i / seg)) for i in range(seg)]


def star4(cx, cy, R, waist=0.30, seg=14):
    """四角星（glimmer）：四个尖角之间用二次贝塞尔收成凹弧，比直线版更像「闪光」。"""
    tips = [(cx, cy - R), (cx + R, cy), (cx, cy + R), (cx - R, cy)]
    pts = []
    for i in range(4):
        p0 = tips[i]
        p1 = tips[(i + 1) % 4]
        pts.append(p0)
        # 控制点放在两尖角夹角的内缩处
        ctrl = (cx + (p0[0] - cx + p1[0] - cx) * waist,
                cy + (p0[1] - cy + p1[1] - cy) * waist)
        for j in range(1, seg + 1):
            t = j / seg
            mt = 1 - t
            pts.append((mt * mt * p0[0] + 2 * mt * t * ctrl[0] + t * t * p1[0],
                        mt * mt * p0[1] + 2 * mt * t * ctrl[1] + t * t * p1[1]))
    return pts


# ---------- 光栅化 ----------
class Canvas:
    def __init__(self, n=S):
        self.n = n
        self.buf = [[(0.0, 0.0, 0.0, 0.0)] * n for _ in range(n)]

    def fill(self, poly, color, alpha=1.0, shade=None):
        """扫描线填充。color 可以是 (r,g,b)，shade(y) 返回逐行颜色（画渐变用）。"""
        n = self.n
        ys = [p[1] for p in poly]
        y0 = max(0, int(min(ys)))
        y1 = min(n - 1, int(max(ys)) + 1)
        edges = list(zip(poly, poly[1:] + poly[:1]))
        for py in range(y0, y1 + 1):
            cov = {}
            for k in range(SUB):
                sy = py + (k + 0.5) / SUB
                xs = []
                for (ax, ay), (bx, by) in edges:
                    if (ay <= sy < by) or (by <= sy < ay):
                        xs.append(ax + (sy - ay) * (bx - ax) / (by - ay))
                xs.sort()
                w = 1.0 / SUB * alpha
                for i in range(0, len(xs) - 1, 2):
                    xa, xb = xs[i], xs[i + 1]
                    c0, c1 = int(xa), int(xb)
                    if c0 == c1:
                        cov[c0] = cov.get(c0, 0.0) + (xb - xa) * w
                    else:
                        cov[c0] = cov.get(c0, 0.0) + (c0 + 1 - xa) * w
                        for c in range(c0 + 1, c1):
                            cov[c] = cov.get(c, 0.0) + w
                        if c1 < n:
                            cov[c1] = cov.get(c1, 0.0) + (xb - c1) * w
            row = self.buf[py]
            for c, a in cov.items():
                if a <= 0.0 or c < 0 or c >= n:
                    continue
                a = min(1.0, a)
                rgb = shade(sy if shade is not None else 0) if shade else color
                cr, cg, cb = rgb
                dr, dg, db, da = row[c]
                na = a + da * (1 - a)
                if na <= 0:
                    continue
                row[c] = ((cr * a + dr * da * (1 - a)) / na,
                          (cg * a + dg * da * (1 - a)) / na,
                          (cb * a + db * da * (1 - a)) / na, na)

    def to_rgba(self):
        out = bytearray()
        for row in self.buf:
            for r, g, b, a in row:
                out += bytes((max(0, min(255, round(r))),
                              max(0, min(255, round(g))),
                              max(0, min(255, round(b))),
                              max(0, min(255, round(a * 255)))))
        return bytes(out)


def shade_at(y_fn):
    return lambda _sy: y_fn


def write_png(path, canvas, bg=None, scale=1):
    n = canvas.n
    px = [[(0, 0, 0, 255)] * n for _ in range(n)]
    for y in range(n):
        for x in range(n):
            r, g, b, a = canvas.buf[y][x]
            if bg is not None:
                r = r * a + bg[0] * (1 - a)
                g = g * a + bg[1] * (1 - a)
                b = b * a + bg[2] * (1 - a)
                a = 1.0
            px[y][x] = (round(r), round(g), round(b), round(a * 255))
    if scale > 1:
        m = n // scale
        small = []
        for y in range(m):
            row = []
            for x in range(m):
                rs = gs = bs = asum = 0
                for dy in range(scale):
                    for dx in range(scale):
                        p = px[y * scale + dy][x * scale + dx]
                        rs += p[0]; gs += p[1]; bs += p[2]; asum += p[3]
                cnt = scale * scale
                row.append((rs // cnt, gs // cnt, bs // cnt, asum // cnt))
            small.append(row)
        px, n = small, m
    raw = b"".join(b"\x00" + bytes(v for p in row for v in p) for row in px)
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


# ---------- 图标本体 ----------
VIOLET_TOP = hexc("8B7CF6")     # 底板渐变上端
VIOLET_BOT = hexc("5A3FC7")     # 底板渐变下端
DOC = hexc("FFFFFF")            # 文档
DOG_EAR = hexc("E4DDFB")        # 折角
LINE = hexc("C4B5F5")           # 文档里的文字行
ARROW_BG = DOC                  # 上传圆徽底
ARROW = hexc("6446D2")          # 上传箭头
GLIMMER = hexc("FFE9A8")        # 闪光（暖白，压得住紫底）


def draw():
    c = Canvas()
    # 1) 圆角方形底板：思源集市里图标是方形卡片，圆角留白更接近系统图标观感
    c.fill(rounded_rect(8, 8, S - 16, S - 16, 116),
           (0, 0, 0), shade=lambda y: grad(VIOLET_TOP, VIOLET_BOT, 8, S - 8, y))
    # 2) 文档（左上、留出右下角给上传圆徽）：右上角折角
    doc = [(150, 112), (286, 112), (362, 188), (362, 346), (336, 372),
           (136, 372), (110, 346), (110, 138)]
    c.fill(doc, DOC)
    # 折角（dog-ear）：右上切出来的那个三角，浅紫表示「纸背面」
    c.fill([(286, 112), (362, 188), (286, 188)], DOG_EAR)
    # 3) 文档里的三行文字（长短错落，表示正文；右端收在上传圆徽之外，避免被白底切掉）
    for (x0, y0, x1, y1) in [(140, 224, 300, 244), (140, 266, 306, 286), (140, 308, 268, 328)]:
        c.fill(rounded_rect(x0, y0, x1 - x0, y1 - y0, 10, seg=6), LINE)
    # 4) 上传圆徽压在文档右下角：白色圆底 + 紫色上箭头（对应插件在思源里用的 iconUpload）
    cx, cy, R = 364, 356, 88
    c.fill(circle(cx, cy, R + 8), DOC)
    c.fill(circle(cx, cy, R), ARROW_BG)
    aw = 22   # 箭头杆半宽
    c.fill([(cx, cy - 62), (cx + 52, cy - 8), (cx + aw, cy - 8),
            (cx + aw, cy + 60), (cx - aw, cy + 60), (cx - aw, cy - 8),
            (cx - 52, cy - 8)], ARROW)
    # 5) glimmer：一大一小两颗四角星，点出「发布出去了 / 净亮」
    c.fill(star4(420, 132, 46, waist=0.26), GLIMMER)
    c.fill(star4(84, 434, 26, waist=0.26), GLIMMER)
    return c


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if "--check" in sys.argv:
        p = os.path.join(root, "icon.png")
        d = open(p, "rb").read()
        assert d[:8] == b"\x89PNG\r\n\x1a\n", "icon.png 不是 PNG"
        w, h = struct.unpack(">II", d[16:24])
        assert (w, h) == (S, S), f"icon.png 应为 {S}x{S} 正方形，实际 {w}x{h}"
        assert d[25] == 6, "icon.png 必须是 RGBA（带透明通道）"
        print(f"ICON CHECK OK: {w}x{h} RGBA, {len(d)} 字节")
        return

    c = draw()
    out = os.path.join(root, "icon.png")
    size = write_png(out, c)
    print(f"wrote {out} ({size} 字节)")
    # 预览：集市卡片是方形缩略图，浅色/深色主题下各看一次，再缩到 64px 看小图是否还读得清
    prev = os.path.join(root, "tools", "preview")
    os.makedirs(prev, exist_ok=True)
    write_png(os.path.join(prev, "icon-light.png"), c, bg=hexc("F5F5F8"))
    write_png(os.path.join(prev, "icon-dark.png"), c, bg=hexc("1E1F22"))
    write_png(os.path.join(prev, "icon-64-light.png"), c, bg=hexc("F5F5F8"), scale=8)
    write_png(os.path.join(prev, "icon-64-dark.png"), c, bg=hexc("1E1F22"), scale=8)
    print("wrote previews ->", prev)


main()
