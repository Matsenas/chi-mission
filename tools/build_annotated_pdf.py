"""Build site/paper-annotated.pdf from the original paper and site/annotations.json.

Usage: python tools/build_annotated_pdf.py

Each note becomes a highlight in its lens colour with the note as its comment,
prefixed with "[Lens name]" so tools/extract_annotations.py can read it back.
Page 1 carries the colour
legend and the about text as a sticky note. Runs on every deploy, so the
download always matches the notes on the site.
"""

import json
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
ANNOTATOR = "Andrius Matsenas"


def rgb(hex_colour):
    return tuple(int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5))


def main():
    data = json.loads((SITE / "annotations.json").read_text())
    lenses = {l["id"]: l for l in data["lenses"]}
    doc = pymupdf.open(SITE / data["pdf"])

    for n in data["notes"]:
        lens = lenses[n["lens"]]
        page = doc[n["page"] - 1]
        annot = page.add_highlight_annot([pymupdf.Rect(r) for r in n["rects"]])
        annot.set_colors(stroke=rgb(lens["colour"]))
        annot.set_info(title=ANNOTATOR, subject=lens["name"], content=f"[{lens['name']}]\n{n['text']}")
        annot.update()

    # Colour legend across the top margin of page 1.
    first = doc[0]
    x, y = 36, 8
    for lens in data["lenses"]:
        label = f"{lens['id']}  {lens['name']}"
        width = pymupdf.get_text_length(label, fontname="helv", fontsize=7) + 10
        if x + width > first.rect.width - 36:
            x, y = 36, y + 13
        annot = first.add_freetext_annot(
            pymupdf.Rect(x, y, x + width, y + 11), label, fontsize=7, fontname="helv",
            text_color=(0, 0, 0), fill_color=rgb(lens["colour"]),
        )
        annot.set_info(title=ANNOTATOR)
        annot.update()
        # Record the lens colour as the annotation colour too, which the importer reads.
        doc.xref_set_key(annot.xref, "C", "[{} {} {}]".format(*(f"{c:.3f}" for c in rgb(lens["colour"]))))
        x += width + 4

    if data.get("about"):
        note = first.add_text_annot((573, 35), data["about"], icon="Note")
        note.set_info(title=ANNOTATOR)
        note.update()

    out = SITE / "paper-annotated.pdf"
    doc.save(out, garbage=3, deflate=True)
    print(f"{len(data['notes'])} notes -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
