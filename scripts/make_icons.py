#!/usr/bin/env python3
"""Generate the DataTrip logo mark and every application icon from code.

Concept: "D-route". The letter D drawn as one continuous route: the trip starts
at a waypoint (ring) at the bottom-left, climbs the stem, sweeps around the bowl
and arrives just short of where it began. Data + journey in one stroke, a crisp
silhouette that still reads as a D at 16px.

Pipeline (two steps, both run by this script):
  1. Python writes parametric SVG sources (to a temp dir; the macOS master is
     also saved as scripts/icon/app-icon.svg) and the brand marks to
     src/assets/logo-mark.svg and src/assets/logo-mark-mono.svg.
  2. scripts/icon/render.cjs rasterizes every SVG at its exact pixel size with
     headless Chromium (Playwright), which gives high quality anti-aliasing and
     full support for gradients and blur filters. Pillow then packs icon.ico and
     icon.icns from the per-size renders.

Requirements: Python 3 + Pillow, Node with Playwright and its Chromium build.
Set NODE_PATH if Playwright is not resolvable from here (default below matches
the dev container: /opt/node22/lib/node_modules).

Usage:
    python3 scripts/make_icons.py [output_dir]      # default: src-tauri/icons

Size rules:
  * macOS (icon.png, icon.icns): Big Sur grid, an 824px squircle centered on a
    1024 canvas with transparent margin and a soft drop shadow.
  * Windows / Linux (icon.ico, NxN.png, Square*Logo.png, StoreLogo.png): the
    plate fills more of the canvas, as native Windows icons do.
  * 16-32px: no sheen, no shadow, heavier stroke, solid waypoint (no hole).
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = Path(__file__).resolve().parent / "icon"
ASSETS_DIR = ROOT / "src" / "assets"
DEFAULT_NODE_PATH = "/opt/node22/lib/node_modules"

BRAND = "#FF1A3C"

# ---------------------------------------------------------------------------
# Geometry (1024 x 1024 design space)
# ---------------------------------------------------------------------------


def squircle_path(cx: float, cy: float, a: float, n: float = 5.0, steps: int = 720) -> str:
    """Superellipse |x|^n + |y|^n = a^n: the continuous-curvature macOS plate."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = cx + a * math.copysign(abs(c) ** (2 / n), c)
        y = cy + a * math.copysign(abs(s) ** (2 / n), s)
        pts.append(f"{x:.2f} {y:.2f}")
    return "M" + " L".join(pts) + " Z"


class Mark:
    """The D-route mark, drawn inside a box of `size` units centered at (cx, cy).

    Proportions are defined on a 1000-unit reference box and scaled.
    `weight` scales the stroke (heavier for tiny renders).
    """

    def __init__(self, cx: float, cy: float, size: float, weight: float = 1.0):
        k = size / 1000.0
        sw = 172 * weight                  # route stroke width
        node_r = 172 * min(weight, 1.12)   # waypoint outer radius
        hole_r = 70                        # waypoint hole radius
        r = 404                            # bowl radius (to stroke centerline)
        stem_x = -258                      # stem centerline (relative to center)
        top_y = -r - 24                    # top of the route centerline
        bowl_cx = stem_x + 300             # center of the bowl's arc
        bowl_cy = top_y + r
        node_y = bowl_cy + r               # waypoint sits on the baseline
        # Arrival point: on the bowl, a little before the bottom, leaving a gap
        # before the waypoint.
        end_ang = math.radians(78)
        ex = bowl_cx + r * math.cos(end_ang)
        ey = bowl_cy + r * math.sin(end_ang)

        def X(v):
            return cx + v * k

        def Y(v):
            return cy + v * k

        self.k = k
        self.sw = sw * k
        self.node = (X(stem_x), Y(node_y), node_r * k)
        self.hole_r = hole_r * k
        self.route = (
            f"M{X(stem_x):.2f} {Y(node_y):.2f} "
            f"V{Y(top_y):.2f} "
            f"H{X(bowl_cx):.2f} "
            f"A{r * k:.2f} {r * k:.2f} 0 0 1 {X(bowl_cx + r):.2f} {Y(bowl_cy):.2f} "
            f"A{r * k:.2f} {r * k:.2f} 0 0 1 {X(ex):.2f} {Y(ey):.2f}"
        )

    def shapes(self, fill: str, hole: bool = True, extra: str = "") -> str:
        nx, ny, nr = self.node
        return (
            f'<path d="{self.route}" fill="none" stroke="{fill}" stroke-width="{self.sw:.2f}" '
            f'stroke-linecap="round" stroke-linejoin="round" {extra}/>'
            f'<circle cx="{nx:.2f}" cy="{ny:.2f}" r="{nr:.2f}" fill="{fill}" {extra}/>'
        )

    def hole(self, fill: str = "#000") -> str:
        nx, ny, _ = self.node
        return f'<circle cx="{nx:.2f}" cy="{ny:.2f}" r="{self.hole_r:.2f}" fill="{fill}"/>'


# The mark box is optically centered: the bowl is round (reads smaller) and
# the waypoint adds weight bottom-left, so nudge right and up a touch.
MARK_CX, MARK_CY, MARK_SIZE = 494, 510, 456


def mark_for(plate_a: float, weight: float = 1.0) -> Mark:
    """Mark scaled with the plate (plate half-size 412 is the macOS reference)."""
    s = plate_a / 412.0
    return Mark(512 + (MARK_CX - 512) * s, 512 + (MARK_CY - 512) * s, MARK_SIZE * s, weight)


# ---------------------------------------------------------------------------
# App icon SVG
# ---------------------------------------------------------------------------


def icon_svg(plate_a: float = 412, detail: str = "full", shadow: bool = True) -> str:
    """detail: 'full' (>=128px), 'mid' (48-64px), 'small' (<=32px)."""
    plate = squircle_path(512, 512, plate_a)
    weight = {"full": 1.0, "mid": 1.06, "small": 1.22}[detail]
    m = mark_for(plate_a, weight)
    s = plate_a / 412.0
    top, bottom = 512 - plate_a, 512 + plate_a
    hole = detail != "small"

    d = []
    d.append(
        f"""<defs>
  <linearGradient id="plateFill" gradientUnits="userSpaceOnUse" x1="{512 - 0.45 * plate_a:.1f}" y1="{top:.1f}" x2="{512 + 0.45 * plate_a:.1f}" y2="{bottom:.1f}">
    <stop offset="0" stop-color="#FF6A7C"/>
    <stop offset="0.36" stop-color="#FF2445"/>
    <stop offset="0.68" stop-color="#F0123D"/>
    <stop offset="1" stop-color="#B50D4C"/>
  </linearGradient>
  <radialGradient id="plateGlow" gradientUnits="userSpaceOnUse" cx="{512 - 0.32 * plate_a:.1f}" cy="{top + 0.05 * plate_a:.1f}" r="{1.25 * plate_a:.1f}">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.22"/>
    <stop offset="0.45" stop-color="#FFFFFF" stop-opacity="0.05"/>
    <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="plateDeep" gradientUnits="userSpaceOnUse" cx="{512 + 0.55 * plate_a:.1f}" cy="{bottom:.1f}" r="{1.1 * plate_a:.1f}">
    <stop offset="0" stop-color="#7E0638" stop-opacity="0.45"/>
    <stop offset="1" stop-color="#7E0638" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="sheen" gradientUnits="userSpaceOnUse" x1="0" y1="{top:.1f}" x2="0" y2="{512:.1f}">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.13"/>
    <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="rim" gradientUnits="userSpaceOnUse" x1="0" y1="{top:.1f}" x2="0" y2="{bottom:.1f}">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.55"/>
    <stop offset="0.22" stop-color="#FFFFFF" stop-opacity="0.08"/>
    <stop offset="0.8" stop-color="#FFFFFF" stop-opacity="0"/>
    <stop offset="1" stop-color="#FFFFFF" stop-opacity="0.10"/>
  </linearGradient>
  <linearGradient id="markFill" gradientUnits="userSpaceOnUse" x1="0" y1="{m.node[1] - 0.95 * m.k * 1000:.1f}" x2="0" y2="{m.node[1] + m.node[2]:.1f}">
    <stop offset="0" stop-color="#FFFFFF"/>
    <stop offset="0.6" stop-color="#FFF4F6"/>
    <stop offset="1" stop-color="#FFD9E0"/>
  </linearGradient>
  <clipPath id="plateClip"><path d="{plate}"/></clipPath>
  <mask id="markMask" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
    {m.shapes('#fff')}
    {m.hole('#000') if hole else ''}
  </mask>
  <mask id="markInv" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
    <rect width="1024" height="1024" fill="#fff"/>
    <g transform="translate({-4 * s:.1f} {-14 * s:.1f})">{m.shapes('#000')}{m.hole('#fff') if hole else ''}</g>
  </mask>
  <filter id="plateShadow" x="-20%" y="-20%" width="140%" height="150%" color-interpolation-filters="sRGB">
    <feDropShadow dx="0" dy="{10 * s:.1f}" stdDeviation="{12 * s:.1f}" flood-color="#000" flood-opacity="0.30"/>
    <feDropShadow dx="0" dy="{1.5 * s:.1f}" stdDeviation="{2 * s:.1f}" flood-color="#000" flood-opacity="0.22"/>
  </filter>
  <filter id="markShadow" x="-30%" y="-30%" width="160%" height="170%" color-interpolation-filters="sRGB">
    <feDropShadow dx="0" dy="{16 * s:.1f}" stdDeviation="{20 * s:.1f}" flood-color="#6A0024" flood-opacity="0.42"/>
    <feDropShadow dx="0" dy="{3 * s:.1f}" stdDeviation="{3 * s:.1f}" flood-color="#6A0024" flood-opacity="0.28"/>
  </filter>
  <filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="{14 * s:.1f}"/></filter>
  <filter id="softS" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="{5 * s:.1f}"/></filter>
</defs>"""
    )

    # Plate + drop shadow
    if shadow:
        d.append(f'<path d="{plate}" fill="#B50D4C" filter="url(#plateShadow)"/>')
    d.append(f'<path d="{plate}" fill="url(#plateFill)"/>')

    body = []
    if detail != "small":
        body.append(f'<rect x="0" y="0" width="1024" height="1024" fill="url(#plateDeep)"/>')
        body.append(f'<rect x="0" y="0" width="1024" height="1024" fill="url(#plateGlow)"/>')
    if detail == "full":
        # Glassy specular: a soft curved sheen over the upper half.
        sheen = (
            f"M{512 - plate_a - 10:.1f} {top - 10:.1f} H{512 + plate_a + 10:.1f} "
            f"V{512 - 0.30 * plate_a:.1f} "
            f"C{512 + 0.55 * plate_a:.1f} {512 - 0.02 * plate_a:.1f} {512 - 0.45 * plate_a:.1f} {512 - 0.10 * plate_a:.1f} "
            f"{512 - plate_a - 10:.1f} {512 + 0.12 * plate_a:.1f} Z"
        )
        body.append(f'<path d="{sheen}" fill="url(#sheen)"/>')
        # Inner shadow along the lower edge, soft inner glow along the top.
        body.append(
            f'<path d="{plate}" fill="none" stroke="#5E0026" stroke-opacity="0.35" '
            f'stroke-width="{34 * s:.1f}" filter="url(#soft)" transform="translate(0 {-10 * s:.1f})"/>'
        )
        body.append(
            f'<path d="{plate}" fill="none" stroke="url(#rim)" stroke-opacity="0.6" '
            f'stroke-width="{30 * s:.1f}" filter="url(#soft)" transform="translate(0 {12 * s:.1f})"/>'
        )
    if detail != "small":
        # Crisp glass rim (half the stroke falls outside and is clipped away).
        body.append(f'<path d="{plate}" fill="none" stroke="url(#rim)" stroke-width="{5 * s:.1f}"/>')

    # Mark: soft colored drop shadow, white glass body, subtle top highlight.
    mark_layers = []
    if detail != "small":
        mark_layers.append(
            f'<g filter="url(#markShadow)"><rect width="1024" height="1024" fill="url(#markFill)" mask="url(#markMask)"/></g>'
        )
    else:
        mark_layers.append(f'<rect width="1024" height="1024" fill="#FFFFFF" mask="url(#markMask)"/>')
    if detail == "full":
        # Glass body shading: a soft rose tint pooling along the lower edges of
        # the route (inverse of the mark nudged upward, blurred, kept inside the
        # mark) so the white reads as a raised, rounded glass tube.
        mark_layers.append(
            f'<g mask="url(#markMask)"><g filter="url(#softS)">'
            f'<rect width="1024" height="1024" fill="#FF9FB2" fill-opacity="0.55" mask="url(#markInv)"/></g></g>'
        )
    body.extend(mark_layers)

    d.append(f'<g clip-path="url(#plateClip)">{"".join(body)}</g>')
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'
        + "".join(d)
        + "</svg>"
    )


# ---------------------------------------------------------------------------
# Brand mark SVGs (src/assets)
# ---------------------------------------------------------------------------


def logo_mark_svg(mono: bool = False) -> str:
    """Square, text-free, transparent mark. The route fills a 64-unit viewBox."""
    m = Mark(29.4, 30.95, 56.0)  # bbox ~5..59 x 2..62, optically centered in 64x64
    if mono:
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">\n'
            "  <title>DataTrip</title>\n"
            '  <mask id="dt-mono-hole" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">\n'
            f"    {m.shapes('#fff')}\n"
            f"    {m.hole('#000')}\n"
            "  </mask>\n"
            '  <rect width="64" height="64" fill="currentColor" mask="url(#dt-mono-hole)"/>\n'
            "</svg>\n"
        )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">\n'
        "  <title>DataTrip</title>\n"
        "  <defs>\n"
        '    <linearGradient id="dt-mark-fill" x1="10" y1="4" x2="50" y2="62" gradientUnits="userSpaceOnUse">\n'
        '      <stop offset="0" stop-color="#FF5A70"/>\n'
        f'      <stop offset="0.45" stop-color="{BRAND}"/>\n'
        '      <stop offset="1" stop-color="#D4083F"/>\n'
        "    </linearGradient>\n"
        '    <linearGradient id="dt-mark-gloss" x1="0" y1="4" x2="0" y2="34" gradientUnits="userSpaceOnUse">\n'
        '      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.45"/>\n'
        '      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>\n'
        "    </linearGradient>\n"
        '    <mask id="dt-mark-hole" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">\n'
        f"      {m.shapes('#fff')}\n"
        f"      {m.hole('#000')}\n"
        "    </mask>\n"
        "  </defs>\n"
        '  <g mask="url(#dt-mark-hole)">\n'
        '    <rect width="64" height="64" fill="url(#dt-mark-fill)"/>\n'
        '    <rect width="64" height="34" fill="url(#dt-mark-gloss)"/>\n'
        "  </g>\n"
        "</svg>\n"
    )


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

# Variants: name -> (plate half-size in the 1024 design space, detail, shadow)
VARIANTS = {
    "mac-full": (412, "full", True),    # macOS Big Sur grid, >=128px
    "mac-mid": (412, "mid", True),      # macOS 64px
    "mac-small": (430, "small", False),  # macOS 16/32px: slightly larger plate, no shadow
    "win-full": (476, "full", True),    # Windows/Linux, >=128px
    "win-mid": (494, "mid", False),     # Windows/Linux 44-107px
    "win-small": (504, "small", False),  # Windows/Linux <=32px: nearly full bleed
}


def variant_for(platform: str, px: int) -> str:
    if px <= 32:
        return f"{platform}-small"
    if px < 128 and not (platform == "win" and px >= 107):
        return f"{platform}-mid"
    return f"{platform}-full"


# ICNS element types (PNG payloads) -> pixel size. Pillow's writer omits the
# 16px/32px @1x slots, so the container is written by hand to keep the
# hand-tuned small renders.
ICNS_TYPES = [
    (b"icp4", 16), (b"icp5", 32), (b"icp6", 64), (b"ic07", 128), (b"ic08", 256),
    (b"ic09", 512), (b"ic10", 1024), (b"ic11", 32), (b"ic12", 64), (b"ic13", 256),
    (b"ic14", 512),
]


def write_icns(path: Path, pngs: dict[int, Path]) -> None:
    body = b""
    for ostype, px in ICNS_TYPES:
        data = pngs[px].read_bytes()
        body += ostype + (len(data) + 8).to_bytes(4, "big") + data
    path.write_bytes(b"icns" + (len(body) + 8).to_bytes(4, "big") + body)


def render(jobs: list[dict], build_dir: Path) -> None:
    env = dict(os.environ)
    env.setdefault("NODE_PATH", DEFAULT_NODE_PATH)
    node = shutil.which("node") or "/opt/node22/bin/node"
    jobs_file = build_dir / "jobs.json"
    jobs_file.write_text(json.dumps(jobs, indent=1))
    subprocess.run([node, str(ICON_DIR / "render.cjs"), str(jobs_file)], env=env, check=True)


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "src-tauri" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="datatrip-icons-") as tmp:
        build(out, Path(tmp))
    print(f"Wrote icons to {out}")


def build(out: Path, BUILD_DIR: Path) -> None:
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Vector sources.
    (ASSETS_DIR / "logo-mark.svg").write_text(logo_mark_svg())
    (ASSETS_DIR / "logo-mark-mono.svg").write_text(logo_mark_svg(mono=True))
    for name, (a, detail, shadow) in VARIANTS.items():
        (BUILD_DIR / f"{name}.svg").write_text(icon_svg(a, detail, shadow))
    # The master source, kept next to the renderer for reference / design tools.
    (ICON_DIR / "app-icon.svg").write_text(icon_svg(*VARIANTS["mac-full"]))

    # 2. Rasterize every size needed, each from vectors at its native size.
    mac_sizes = [16, 32, 64, 128, 256, 512, 1024]
    win_sizes = [16, 24, 30, 32, 44, 48, 50, 64, 71, 89, 107, 128, 142, 150, 256, 284, 310]
    jobs = []
    for px in mac_sizes:
        jobs.append({"in": str(BUILD_DIR / f"{variant_for('mac', px)}.svg"),
                     "out": str(BUILD_DIR / f"mac-{px}.png"), "width": px, "height": px})
    for px in win_sizes:
        jobs.append({"in": str(BUILD_DIR / f"{variant_for('win', px)}.svg"),
                     "out": str(BUILD_DIR / f"win-{px}.png"), "width": px, "height": px})
    render(jobs, BUILD_DIR)

    def mac(px: int) -> Image.Image:
        return Image.open(BUILD_DIR / f"mac-{px}.png").convert("RGBA")

    def win(px: int) -> Image.Image:
        return Image.open(BUILD_DIR / f"win-{px}.png").convert("RGBA")

    # 3. Assemble outputs.
    mac(1024).save(out / "icon.png")
    for name, px in [("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128), ("128x128@2x.png", 256)]:
        win(px).save(out / name)
    for px in [30, 44, 71, 89, 107, 142, 150, 284, 310]:
        win(px).save(out / f"Square{px}x{px}Logo.png")
    win(50).save(out / "StoreLogo.png")

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico = [win(px) for px in ico_sizes]
    ico[-1].save(out / "icon.ico", format="ICO", sizes=[(p, p) for p in ico_sizes], append_images=ico[:-1])

    write_icns(out / "icon.icns", {px: BUILD_DIR / f"mac-{px}.png" for px in mac_sizes})


if __name__ == "__main__":
    main()
