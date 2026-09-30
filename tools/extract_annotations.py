"""One-time import: highlight annotations from an annotated PDF into annotations.json.

site/annotations.json is the source of truth and is edited in the browser (?edit).
This script is only for starting over from a PDF, so it refuses to overwrite an
existing file unless you pass --force. Note ids are renumbered on import, which
breaks shared #note-N links.

Usage: python tools/extract_annotations.py [annotated.pdf] [out.json] [--force]

Each highlight becomes one note: page, highlight rectangles (PDF points,
top-left origin), the passage underneath, the comment text and its lens.
The lens comes from the highlight colour, matched against the colour legend
(FreeText boxes on page 1). A "[Lens name]" or (older files) "MY QUESTION" prefix in the
comment is used as a fallback and stripped from the note text.
"""

import json
import re
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
FORCE = "--force" in sys.argv
ARGS = [a for a in sys.argv[1:] if a != "--force"]
SRC = Path(ARGS[0]) if len(ARGS) > 0 else ROOT / "source" / "second-pass.pdf"
OUT = Path(ARGS[1]) if len(ARGS) > 1 else ROOT / "site" / "annotations.json"


def hex_colour(rgb):
    return "#" + "".join(f"{round(c * 255):02x}" for c in rgb)


def colour_key(rgb):
    return tuple(round(c, 2) for c in rgb)


def read_legend(doc):
    """Lens legend: FreeText boxes like '1  Glossary', plus the page-1 sticky note."""
    lenses, about = {}, ""
    for annot in doc[0].annots():
        kind, content = annot.type[1], annot.info.get("content", "")
        if kind == "FreeText":
            m = re.match(r"\s*(\d+)\s+(.+)", content)
            if m:
                rgb = annot.colors["stroke"]
                lenses[colour_key(rgb)] = {
                    "id": int(m.group(1)),
                    "name": m.group(2).strip(),
                    "colour": hex_colour(rgb),
                }
        elif kind == "Text":
            about = content

    # Short descriptions live in the sticky note: "  1 Glossary   - plain definitions ..."
    descriptions = {int(n): d.strip() for n, d in re.findall(r"^\s*(\d)\s+[^-\n]+-\s+(.+)$", about, re.M)}
    for lens in lenses.values():
        lens["description"] = descriptions.get(lens["id"], "")
        if lens["name"].lower().startswith(("my questions", "questions")):
            lens["name"] = "Questions"
    # The category list is rebuilt from the lenses, so keep only the prose.
    about = re.sub(r"^\s*\d\s+[^-\n]+-\s+.+$\n?", "", about, flags=re.M)
    about = re.sub(r"\n{3,}", "\n\n", about).strip()
    return lenses, about


def passage(page, rects, words):
    """Words whose centre falls inside any highlight rectangle, in reading order."""
    hits = []
    for w in words:
        cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
        if any(r[0] <= cx <= r[2] and r[1] <= cy <= r[3] for r in rects):
            hits.append(w[4])
    text = " ".join(hits)
    return re.sub(r"-\s(?=[a-z])", "", text)  # rejoin words hyphenated across lines


def main():
    if OUT.exists() and not FORCE:
        raise SystemExit(f"{OUT} already exists and is the source of truth. Pass --force to overwrite it.")
    doc = pymupdf.open(SRC)
    lenses, about = read_legend(doc)
    by_name = {l["name"].lower(): l for l in lenses.values()}
    notes = []

    for page in doc:
        words = page.get_text("words")
        for annot in page.annots(types=[pymupdf.PDF_ANNOT_HIGHLIGHT]):
            content = annot.info.get("content", "").strip()
            lens = lenses.get(colour_key(annot.colors["stroke"]))

            m = re.match(r"\[([^\]]+)\]\s*", content)
            if m:
                lens = lens or by_name.get(m.group(1).lower())
                content = content[m.end():]
            elif content.upper().startswith("MY QUESTION"):
                lens = lens or by_name["questions"]
                content = re.sub(r"^MY QUESTION\s*[-–—:]\s*", "", content, flags=re.I)
            if lens is None:
                raise SystemExit(f"p{page.number + 1}: no lens for annotation {content[:60]!r}")

            v = annot.vertices  # 4 points per quad
            rects = []
            for i in range(0, len(v), 4):
                xs, ys = [p[0] for p in v[i:i + 4]], [p[1] for p in v[i:i + 4]]
                rects.append([round(min(xs), 1), round(min(ys), 1), round(max(xs), 1), round(max(ys), 1)])

            notes.append({
                "page": page.number + 1,
                "lens": lens["id"],
                "rects": rects,
                "passage": passage(page, rects, words),
                "text": content,
            })

    # Stable order: page, then top of the highlight, then left edge.
    notes.sort(key=lambda n: (n["page"], n["rects"][0][1], n["rects"][0][0]))
    for i, n in enumerate(notes, 1):
        n["id"] = i

    first = doc[0].rect
    data = {
        "pdf": "paper.pdf",
        "pageSize": [first.width, first.height],
        "pages": doc.page_count,
        "about": about,
        "lenses": sorted(lenses.values(), key=lambda l: l["id"]),
        "notes": notes,
        "nextId": len(notes) + 1,  # ids are never reused, so shared #note-N links stay valid
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1))

    counts = {l["name"]: sum(n["lens"] == l["id"] for n in notes) for l in data["lenses"]}
    print(f"{len(notes)} notes -> {OUT.relative_to(ROOT) if OUT.is_relative_to(ROOT) else OUT}")
    for name, c in counts.items():
        print(f"  {c:3}  {name}")


if __name__ == "__main__":
    main()
