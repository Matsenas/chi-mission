# chi-mission

A reader's edition of *AI-Mediated Feedback Improves Student Revisions: A Randomized Trial with FeedbackWriter in a Large Undergraduate Course* (Lu et al., CHI ’26), with 131 margin notes in eight lenses.

- **Left:** the original PDF, rendered with pdf.js. Text stays selectable.
- **Right:** margin notes aligned to their passages. Tap a note to expand it.
- **Overview map** (desktop, left of the pages): a mini column of the whole paper, with one coloured bar per note placed in its page and column, and a grey box for what's on screen. Click or drag to move, hover a bar to preview its note, click a bar to open it.
- **Lens chips** filter the notes. Double-click (or long-press on touch) shows one lens only.
- **Download menu:** the paper on its own, or with every note as a highlight and comment.
- **Mobile:** dots in the page margin open notes in a bottom sheet with previous/next.
- **Deep links:** `#note-42` opens note 42. Each note has a "Copy link" button.
- **Keyboard:** `J`/`K` step through notes, `N` hides or shows notes, `M` switches light and dark mode (remembered per browser), `Esc` closes. `S` is for the author: sign in or out of edit mode.

## Layout

```
site/                     # everything that gets published
  index.html, style.css, app.js, theme.js
  edit.js, edit.css       # author-only editing, loaded only with ?edit
  annotations.json        # THE SOURCE OF TRUTH for notes
  paper.pdf               # the original, un-annotated paper
  vendor/pdfjs/           # pdf.js 4.10.38 (Apache-2.0)
tools/build_annotated_pdf.py   # builds site/paper-annotated.pdf on every deploy
tools/extract_annotations.py   # one-time import from an annotated PDF
source/second-pass.pdf         # the PDF the notes were first imported from
```

## Editing notes

Press `S` anywhere on the site, or open it with `?edit` (for example `https://matsenas.github.io/chi-mission/?edit`), on a laptop or desktop. In edit mode, `S` signs in (or retries after a failed connection) and, once connected, signs out and returns to the public view. The status next to the info button shows where you are.

- **Add:** select a passage in the paper, click **+ Note**, pick a lens, write, then **Save** (⌘/Ctrl+Enter).
- **Edit or delete:** open a note in the margin and use **Edit** or **Delete**. Deleting shows an **Undo**. In the editor, **Re-anchor** moves a note to a different passage.
- **Publish:** changes are kept in your browser until you click **Publish**, which commits `site/annotations.json` to `main`. The site and the annotated PDF redeploy in about a minute.

Note ids are never reused, so `#note-N` links keep pointing at the same note.

The About dialog's text is the `about` field in `site/annotations.json`. Edit it there: a blank line starts a new paragraph and `[text](https://…)` makes a link. The same text, with the category list, becomes the sticky note on page 1 of the annotated PDF.

### The GitHub token

Edit mode needs a fine-grained personal access token:

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
2. **Repository access:** Only select repositories → `Matsenas/chi-mission`.
3. **Repository permissions:** Contents → **Read and write**. Leave everything else at No access.
4. Pick an expiry (90 days is sensible) and generate.

How it stays safe:

- The app only accepts fine-grained tokens (`github_pat_…`) that can write to this repository, and rejects classic tokens, which reach all your repositories.
- The token is kept in the browser tab's session storage and is gone when the tab closes, unless you tick **Remember on this device**. It is never in the URL, the page source or the repository. It is only sent to `api.github.com`.
- The page's Content Security Policy blocks connections to anywhere except this site and `api.github.com`, and blocks inline and third-party scripts. pdf.js is served from this site, and note text is always inserted as plain text.
- Edit mode refuses to run inside a frame.
- If a device is lost or the token leaks: delete it on GitHub (Settings → Developer settings → Fine-grained tokens). The most it can do is change files in this one repository, and every change is a commit you can revert.

## Rebuilding from a PDF

`tools/extract_annotations.py` imports highlights from an annotated PDF. It refuses to overwrite `site/annotations.json` unless you pass `--force`, because that file is now edited in the browser and the import renumbers every note.

## Run locally

```sh
cd site && python3 -m http.server 8000
```

Then open http://localhost:8000. To try the annotated download locally, first run `python tools/build_annotated_pdf.py` (needs `pip install pymupdf`). It needs a server rather than `file://`, since pdf.js loads the PDF and its worker over HTTP.

## Deploy

`.github/workflows/pages.yml` builds the annotated PDF and publishes `site/` to GitHub Pages on every push to `main` that touches it, including each Publish from edit mode. One-time setup: **Settings → Pages → Source: GitHub Actions**. GitHub Pages on a private repository needs a paid plan, and the published site is public either way.
