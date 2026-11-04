"""Shared Style 1 (Flat Icon) SVG helpers for the docs/diagrams/auth generators.

Hand-written because fireworks-tech-graph's template generator has no
lifeline / message renderer for sequence diagrams and no decision diamond for
flowcharts. Elements carry the `data-graph-role` attributes the
fireworks-tech-graph validator reads (node, edge, label, container,
decoration, legend), so `validate-svg.sh` checks them like generated output.

No external fonts, @import or scripts: the SVG must render inline on GitHub.
"""

from __future__ import annotations

from html import escape
from pathlib import Path

FONT = (
    "'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', "
    "'Microsoft JhengHei', 'SimHei', sans-serif"
)

# Style 1 palette: semantic arrow colors and tinted node fills.
COLORS = {
    "blue": "#2563eb",
    "red": "#dc2626",
    "green": "#16a34a",
    "purple": "#9333ea",
    "orange": "#ea580c",
    "gray": "#6b7280",
}
TINTS = {
    "blue": ("#eff6ff", "#93c5fd"),
    "red": ("#fef2f2", "#fca5a5"),
    "green": ("#f0fdf4", "#86efac"),
    "purple": ("#faf5ff", "#c4b5fd"),
    "orange": ("#fff7ed", "#fdba74"),
    "teal": ("#f0fdfa", "#5eead4"),
    "gray": ("#f9fafb", "#d1d5db"),
    "white": ("#ffffff", "#d1d5db"),
}

CHAR_W = {12: 6.6, 11: 6.0, 13: 7.2, 14: 7.8, 16: 9.0}


def text_width(text: str, size: int = 12) -> float:
    return len(text) * CHAR_W.get(size, size * 0.55)


def esc(text: str) -> str:
    return escape(text, quote=True)


class Svg:
    def __init__(self, width: int, height: int, title: str, subtitle: str = "") -> None:
        self.width = width
        self.height = height
        self.parts: list[str] = []
        self.title = title
        self.subtitle = subtitle

    # ---- primitives -------------------------------------------------------

    def add(self, s: str) -> None:
        self.parts.append(s)

    def text(self, x: float, y: float, s: str, size: int = 12, color: str = "#111827",
             anchor: str = "middle", weight: int = 400, role: str | None = None,
             italic: bool = False) -> None:
        r = f' data-graph-role="{role}"' if role else ""
        st = ' font-style="italic"' if italic else ""
        self.add(
            f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{color}" '
            f'text-anchor="{anchor}" font-weight="{weight}"{st}{r}>{esc(s)}</text>'
        )

    def node(self, nid: str, x: float, y: float, w: float, h: float, label: str,
             sub: str | list[str] = "", tint: str = "white", rx: int = 8) -> None:
        fill, stroke = TINTS[tint]
        subs = [sub] if isinstance(sub, str) else sub
        subs = [s for s in subs if s]
        self.add(f'<g id="{nid}" data-graph-role="node" data-node-id="{nid}">')
        self.add(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" ry="{rx}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>'
        )
        n = 1 + len(subs)
        line_h = 15
        top = y + h / 2 - (n - 1) * line_h / 2 + 5
        self.text(x + w / 2, top, label, size=14, weight=600)
        for i, s in enumerate(subs):
            self.text(x + w / 2, top + (i + 1) * line_h, s, size=11, color="#6b7280")
        self.add("</g>")

    def diamond(self, nid: str, cx: float, cy: float, w: float, h: float, label: str,
                sub: str = "", tint: str = "orange") -> None:
        fill, stroke = TINTS[tint]
        pts = f"{cx},{cy - h / 2} {cx + w / 2},{cy} {cx},{cy + h / 2} {cx - w / 2},{cy}"
        self.add(
            f'<g id="{nid}" data-graph-role="node" data-node-id="{nid}" '
            f'data-graph-bounds="{cx - w / 2} {cy - h / 2} {cx + w / 2} {cy + h / 2}">'
        )
        self.add(f'<polygon points="{pts}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        if sub:
            self.text(cx, cy - 2, label, size=13, weight=600)
            self.text(cx, cy + 13, sub, size=11, color="#6b7280")
        else:
            self.text(cx, cy + 5, label, size=13, weight=600)
        self.add("</g>")

    def edge(self, eid: str, pts: list[tuple[float, float]], color: str = "blue",
             dashed: bool = False, label: str = "", label_at: tuple[float, float] | None = None,
             label_anchor: str = "middle", width: float = 1.6) -> None:
        c = COLORS[color]
        d = "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in pts)
        dash = ' stroke-dasharray="6 4"' if dashed else ""
        self.add(
            f'<path id="{eid}" data-graph-role="edge" data-edge-id="{eid}" d="{d}" fill="none" '
            f'stroke="{c}" stroke-width="{width}"{dash} marker-end="url(#arrow-{color})"/>'
        )
        if label and label_at:
            tw = text_width(label, 11) * 0.92
            lx = {"middle": label_at[0] - tw / 2, "start": label_at[0], "end": label_at[0] - tw}[label_anchor]
            self.add(
                f'<rect data-graph-role="decoration" x="{lx - 3:.1f}" y="{label_at[1] - 11:.1f}" '
                f'width="{tw + 6:.1f}" height="14" fill="#ffffff" fill-opacity="0.9"/>'
            )
            self.text(label_at[0], label_at[1], label, size=11, color=c, anchor=label_anchor, role="label")

    def note(self, x: float, y: float, w: float, lines: list[str], tint: str = "orange",
             nid: str = "") -> float:
        fill, stroke = TINTS[tint]
        h = 10 + 15 * len(lines)
        idattr = f' id="{nid}"' if nid else ""
        self.add(f'<g{idattr} data-graph-role="label" data-graph-bounds="{x} {y} {x + w} {y + h}">')
        self.add(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="4" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="1"/>'
        )
        for i, s in enumerate(lines):
            self.text(x + 8, y + 18 + 15 * i, s, size=11, color="#374151", anchor="start")
        self.add("</g>")
        return h

    def frame(self, fid: str, x: float, y: float, w: float, h: float, tag: str, cond: str) -> None:
        self.add(
            f'<rect id="{fid}" data-graph-role="container" x="{x}" y="{y}" width="{w}" height="{h}" '
            f'rx="4" fill="none" stroke="#9ca3af" stroke-width="1" stroke-dasharray="4 3"/>'
        )
        tw = text_width(tag, 11) + 14
        self.add(f'<g data-graph-role="decoration">')
        self.add(
            f'<path d="M {x} {y} H {x + tw} V {y + 14} L {x + tw - 6} {y + 20} H {x} Z" '
            f'fill="#f3f4f6" stroke="#9ca3af" stroke-width="1"/>'
        )
        self.add("</g>")
        self.text(x + 6, y + 14, tag, size=11, weight=600, color="#374151", anchor="start", role="label")
        self.text(x + tw + 8, y + 14, cond, size=11, color="#374151", anchor="start", role="label",
                  italic=True)

    def legend(self, x: float, y: float, items: list[tuple[str, bool, str]], gap: int = 40) -> None:
        """Horizontal legend row: (color, dashed, label)."""
        self.add(f'<g id="legend" data-graph-role="legend">')
        cx = x
        for color, dashed, label in items:
            c = COLORS[color]
            dash = ' stroke-dasharray="6 4"' if dashed else ""
            self.add(
                f'<line x1="{cx}" y1="{y}" x2="{cx + 30}" y2="{y}" stroke="{c}" stroke-width="1.6"'
                f'{dash} marker-end="url(#arrow-{color})"/>'
            )
            self.add(
                f'<text x="{cx + 38}" y="{y + 4}" font-size="12" fill="#6b7280" '
                f'text-anchor="start">{esc(label)}</text>'
            )
            cx += 38 + text_width(label, 12) * 0.9 + gap
        self.add("</g>")

    # ---- output -----------------------------------------------------------

    def render(self) -> str:
        markers = "".join(
            f'<marker id="arrow-{name}" markerWidth="10" markerHeight="7" refX="9" refY="3.5" '
            f'orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="{c}"/></marker>'
            for name, c in COLORS.items()
        )
        head = [
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.width} {self.height}" '
            f'width="{self.width}" height="{self.height}" data-quality-profile="standard">',
            f"<style>text {{ font-family: {FONT}; }}</style>",
            f"<defs>{markers}</defs>",
            f'<rect data-graph-role="background" width="{self.width}" height="{self.height}" fill="#ffffff"/>',
            f'<text x="{self.width / 2}" y="34" font-size="18" font-weight="600" fill="#111827" '
            f'text-anchor="middle" data-graph-role="label">{esc(self.title)}</text>',
        ]
        if self.subtitle:
            head.append(
                f'<text x="{self.width / 2}" y="54" font-size="12" fill="#6b7280" '
                f'text-anchor="middle" data-graph-role="label">{esc(self.subtitle)}</text>'
            )
        return "\n".join(head + self.parts + ["</svg>"]) + "\n"

    def write(self, path: Path) -> None:
        path.write_text(self.render(), encoding="utf-8")


class Sequence:
    """Lifeline sequence diagram on top of Svg.

    participants: list of (id, label, sublabel, tint). Rows advance top to
    bottom; each message, note or frame edge takes one or more rows.
    """

    def __init__(self, svg: Svg, participants: list[tuple[str, str, str, str]],
                 left: float = 40, top: float = 76, box_w: float = 150, box_h: float = 52,
                 gap: float = 0) -> None:
        self.svg = svg
        self.box_w = box_w
        self.box_h = box_h
        n = len(participants)
        span = svg.width - 2 * left
        step = span / n
        self.x: dict[str, float] = {}
        self.participants = participants
        for i, (pid, label, sub, tint) in enumerate(participants):
            cx = left + step * i + step / 2
            self.x[pid] = cx
        self.top = top
        self.y = top + box_h + 34  # first row baseline

    def heads(self, bottom: float) -> None:
        # Lifelines go first so messages, notes and frames draw over them.
        for i, (pid, label, sub, tint) in enumerate(self.participants):
            cx = self.x[pid]
            self.svg.parts.insert(
                i,
                f'<line data-graph-role="decoration" x1="{cx}" y1="{self.top + self.box_h}" '
                f'x2="{cx}" y2="{bottom}" stroke="#d1d5db" stroke-width="1.2" stroke-dasharray="5 5"/>'
            )
        for pid, label, sub, tint in self.participants:
            cx = self.x[pid]
            self.svg.node(pid, cx - self.box_w / 2, self.top, self.box_w, self.box_h, label, sub, tint)

    def msg(self, eid: str, src: str, dst: str, label: str, color: str = "blue",
            dashed: bool = False, step: float = 40) -> None:
        x1, x2 = self.x[src], self.x[dst]
        y = self.y
        direction = 1 if x2 > x1 else -1
        start = x1 + 4 * direction
        end = x2 - 4 * direction
        mid = (x1 + x2) / 2
        self.svg.edge(eid, [(start, y), (end, y)], color=color, dashed=dashed,
                      label=label, label_at=(mid, y - 7))
        self.y += step

    def note(self, over: str | tuple[str, str], lines: list[str], tint: str = "orange",
             width: float | None = None, nid: str = "") -> None:
        if isinstance(over, tuple):
            a, b = sorted((self.x[over[0]], self.x[over[1]]))
            w = max(b - a + 120, max(text_width(t, 11) for t in lines) + 16)
            x0, x1 = (a + b) / 2 - w / 2, (a + b) / 2 + w / 2
        else:
            w = width or max(text_width(s, 11) for s in lines) + 16
            x0, x1 = self.x[over] - w / 2, self.x[over] + w / 2
        y0 = self.y - 22
        h = self.svg.note(x0, y0, x1 - x0, lines, tint=tint, nid=nid)
        self.y = y0 + h + 38

    def frame_open(self) -> float:
        start = self.y - 26
        self.y += 18
        return start

    def frame_close(self, fid: str, start: float, tag: str, cond: str,
                    x0: float | None = None, x1: float | None = None) -> None:
        end = self.y - 22
        x0 = x0 if x0 is not None else 24
        x1 = x1 if x1 is not None else self.svg.width - 24
        self.svg.frame(fid, x0, start, x1 - x0, end - start, tag, cond)
        self.y += 12
