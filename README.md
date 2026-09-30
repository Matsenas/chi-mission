# chi-mission

A reader's edition of *AI-Mediated Feedback Improves Student Revisions: A Randomized Trial with FeedbackWriter in a Large Undergraduate Course* (Lu et al., CHI ’26), with 131 margin notes in eight lenses.

- **Left:** the original PDF, rendered with pdf.js. Text stays selectable.
- **Right:** margin notes aligned to their passages. Tap a note to expand it.
- **Overview map** (desktop, left of the pages): a mini column of the whole paper, with one coloured bar per note placed in its page and column, and a grey box for what's on screen. Click or drag to move, hover a bar to preview its note, click a bar to open it.
- **Lens chips** filter the notes. Double-click (or long-press on touch) shows one lens only.
- **Notes switch** (or `N`) hides every note for a clean read.
- **Mobile:** dots in the page margin open notes in a bottom sheet with previous/next.
- **Deep links:** `#note-42` opens note 42. Each note has a "Copy link" button.
- **Keyboard:** `J`/`K` step through notes, `N` hides or shows notes, `M` switches light and dark mode (remembered per browser), `Esc` closes.

## Layout

```
site/                     # everything that gets published
  index.html, style.css, app.js
  annotations.json        # generated, do not edit by hand
  paper.pdf               # the original, un-annotated paper
  vendor/pdfjs/           # pdf.js 4.10.38 (Apache-2.0)
source/second-pass.pdf    # the annotated PDF: the source of truth for notes
tools/extract_annotations.py
```

## Updating the notes

Edit the annotations in `source/second-pass.pdf` (any PDF editor), then regenerate the data:

```sh
pip install pymupdf
python tools/extract_annotations.py
```

The script reads every highlight: page, position, the passage underneath and the comment. The lens comes from the highlight colour, matched against the colour legend on page 1. A `[Lens name]` or `MY QUESTION -` prefix in the comment is the fallback and gets stripped from the displayed text.

## Run locally

```sh
cd site && python3 -m http.server 8000
```

Then open http://localhost:8000. It needs a server rather than `file://`, since pdf.js loads the PDF and its worker over HTTP.

## Deploy

`.github/workflows/pages.yml` publishes `site/` to GitHub Pages on every push to `main` that touches it. One-time setup: **Settings → Pages → Source: GitHub Actions**. GitHub Pages on a private repository needs a paid plan, and the published site is public either way.
