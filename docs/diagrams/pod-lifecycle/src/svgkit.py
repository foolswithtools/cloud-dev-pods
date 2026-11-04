"""Tiny SVG helper shared by the pod-lifecycle diagram generators.

Style 1 (Flat Icon) tokens from fireworks-tech-graph. Pure standard library;
each generator imports this module from its own directory.
"""

from __future__ import annotations

from xml.sax.saxutils import escape

FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif"

COLORS = {
    "blue": "#2563eb",
    "green": "#16a34a",
    "purple": "#9333ea",
    "red": "#dc2626",
    "orange": "#ea580c",
    "gray": "#6b7280",
}
TEXT = "#111827"
TEXT2 = "#6b7280"


def esc(s: str) -> str:
    return escape(s, {'"': "&quot;"})


def text_width(s: str, size: float = 12) -> float:
    return len(s) * size * 0.56


class Svg:
    def __init__(self, width: int, height: int, title: str, subtitle: str = ""):
        self.w, self.h = width, height
        self.body: list[str] = []
        self.overlay: list[str] = []
        self.title, self.subtitle = title, subtitle

    # -- primitives -------------------------------------------------------
    def add(self, s: str) -> None:
        self.body.append(s)

    def text(self, x, y, s, size=12, color=TEXT2, anchor="start", weight=400, layer=None, italic=False):
        style = ' font-style="italic"' if italic else ""
        line = (f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{color}" '
                f'text-anchor="{anchor}" font-weight="{weight}"{style}>{esc(s)}</text>')
        (layer if layer is not None else self.body).append(line)

    def label(self, x, y, lines, anchor="start", color=TEXT2, size=12, bg=True):
        """Edge label: one or more lines, optional white backing rect, drawn on top."""
        if isinstance(lines, str):
            lines = [lines]
        lh = size + 3
        wmax = max(text_width(s, size) for s in lines)
        if anchor == "start":
            x0 = x
        elif anchor == "end":
            x0 = x - wmax
        else:
            x0 = x - wmax / 2
        top = y - size
        if bg:
            self.overlay.append(
                f'<rect data-graph-role="label" x="{x0 - 3:.1f}" y="{top - 2:.1f}" '
                f'width="{wmax + 6:.1f}" height="{lh * len(lines) + 2:.1f}" fill="#ffffff" fill-opacity="0.95"/>')
        for i, s in enumerate(lines):
            self.text(x, y + i * lh, s, size=size, color=color, anchor=anchor, layer=self.overlay)

    def node(self, x, y, w, h, title, subs=(), fill="#ffffff", stroke="#d1d5db", dashed=False,
             title_color=TEXT, size=14):
        dash = ' stroke-dasharray="6,4"' if dashed else ""
        self.add(f'<rect data-graph-role="node" x="{x}" y="{y}" width="{w}" height="{h}" rx="8" ry="8" '
                 f'fill="{fill}" stroke="{stroke}" stroke-width="1.5"{dash}/>')
        block = size + 4 + (len(subs) * 15)
        ty = y + (h - block) / 2 + size
        self.text(x + w / 2, ty, title, size=size, color=title_color, anchor="middle", weight=600)
        for i, s in enumerate(subs):
            self.text(x + w / 2, ty + 18 + i * 15, s, size=11.5, color=TEXT2, anchor="middle")

    def diamond(self, cx, cy, w, h, lines, fill="#fff7ed", stroke="#ea580c"):
        pts = f"{cx},{cy - h / 2} {cx + w / 2},{cy} {cx},{cy + h / 2} {cx - w / 2},{cy}"
        self.add(f'<polygon data-graph-role="node" points="{pts}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        lh = 14
        y0 = cy - (len(lines) - 1) * lh / 2 + 4
        for i, s in enumerate(lines):
            self.text(cx, y0 + i * lh, s, size=12, color=TEXT, anchor="middle", weight=600)

    def arrow(self, pts, color="blue", dashed=False, width=1.6):
        c = COLORS[color]
        d = "M " + " L ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        dash = ' stroke-dasharray="6,4"' if dashed else ""
        self.add(f'<path data-graph-role="edge" d="{d}" fill="none" stroke="{c}" stroke-width="{width}"{dash} '
                 f'marker-end="url(#arrow-{color})"/>')

    def frame(self, x, y, w, h, tag, note="", color="#64748b", note_x=None):
        """Sequence-diagram alt/opt/loop frame (container role)."""
        self.add(f'<rect data-graph-role="container" x="{x}" y="{y}" width="{w}" height="{h}" rx="4" '
                 f'fill="none" stroke="{color}" stroke-width="1.2" stroke-dasharray="5,3"/>')
        tw = text_width(tag, 11) + 16
        self.add(f'<path data-graph-role="container" d="M {x},{y} L {x + tw},{y} L {x + tw},{y + 12} '
                 f'L {x + tw - 8},{y + 20} L {x},{y + 20} Z" fill="#f1f5f9" stroke="{color}" stroke-width="1"/>')
        self.text(x + 7, y + 14, tag, size=11, color="#334155", weight=700)
        if note:
            self.text(max(x + tw + 8, note_x or 0), y + 14, note, size=11.5, color="#334155", italic=True)

    def divider(self, x, y, w, note, color="#64748b", note_x=None):
        self.add(f'<line data-graph-role="container" x1="{x}" y1="{y}" x2="{x + w}" y2="{y}" '
                 f'stroke="{color}" stroke-width="1" stroke-dasharray="5,3"/>')
        self.text(max(x + 8, note_x or 0), y + 14, note, size=11.5, color="#334155", italic=True)

    def legend(self, x, y, items, gap=34):
        """items: (kind, color, label); kind in arrow|dashed|box|dashedbox."""
        g = [f'<g data-graph-role="legend" transform="translate({x},{y})">']
        cx = 0
        for kind, color, text in items:
            if kind in ("arrow", "dashed"):
                dash = ' stroke-dasharray="6,4"' if kind == "dashed" else ""
                g.append(f'<line x1="{cx}" y1="0" x2="{cx + 30}" y2="0" stroke="{COLORS[color]}" '
                         f'stroke-width="1.6"{dash} marker-end="url(#arrow-{color})"/>')
            else:
                fill, stroke = color
                dash = ' stroke-dasharray="5,3"' if kind == "dashedbox" else ""
                g.append(f'<rect x="{cx}" y="-8" width="30" height="16" rx="4" fill="{fill}" '
                         f'stroke="{stroke}" stroke-width="1.4"{dash}/>')
            g.append(f'<text x="{cx + 38}" y="4" font-size="12" fill="{TEXT2}">{esc(text)}</text>')
            cx += 38 + text_width(text, 12) + gap
        g.append("</g>")
        self.overlay.append("\n".join(g))

    # -- output -----------------------------------------------------------
    def render(self) -> str:
        out = [
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" '
            f'width="{self.w}" height="{self.h}">',
            f"<style>text {{ font-family: {FONT}; }}</style>",
            "<defs>",
        ]
        for name, c in COLORS.items():
            out.append(f'<marker id="arrow-{name}" markerWidth="10" markerHeight="7" refX="9" refY="3.5" '
                       f'orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="{c}"/></marker>')
        out.append("</defs>")
        out.append(f'<rect data-graph-role="background" width="{self.w}" height="{self.h}" fill="#ffffff"/>')
        out.append(f'<text x="40" y="40" font-size="20" font-weight="600" fill="{TEXT}">{esc(self.title)}</text>')
        if self.subtitle:
            out.append(f'<text x="40" y="62" font-size="13" fill="{TEXT2}">{esc(self.subtitle)}</text>')
        out.extend(self.body)
        out.extend(self.overlay)
        out.append("</svg>")
        return "\n".join(out) + "\n"

    def write(self, path) -> None:
        path.write_text(self.render(), encoding="utf-8")
