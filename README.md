# CBZ Compiler

Merge, order and export comic pages and CBZ archives. Runs entirely in the browser, offline, with no server, account or network requests. Pages are never uploaded; your original files are only read.

## Use it

Open the published site (or serve this folder: `python3 -m http.server`, then open `http://localhost:8000`). ES modules need http(s); opening `index.html` from disk will not work.

1. **Add** images, folders or `.cbz`/`.zip` files (button, or drag and drop). Mixed sources are fine.
2. **Review the structure** the app detects for each source. Pick another preset or one of your own rules if it guessed wrong.
3. **Arrange** pages: drag rows (or whole group headers), Alt+↑/↓, *Sort…*, or *Order from list…* (paste file names).
4. **Export** a CBZ, or extract the pages as image files.

Everything that changes the order can be undone (Ctrl+Z / Ctrl+Y). Bulk operations (sort, text order, structure change) show a preview first and change nothing until you apply them.

## How it keeps things safe

- Removing a page only removes it from the project. Source files are never modified or deleted.
- Files that are not imported (non-images, unsupported formats, system files, files skipped by a rule, files already in the project) are listed with the reason. Nothing is dropped silently.
- Uncertain order (alphabetical guesses, unknown layouts) is flagged until you confirm it, and export asks for acknowledgement.
- Reading order and archive structure are separate. Export never re-sorts pages. Default file names carry a page number (`0007_page.jpg`) and folders can be numbered (`01 - Chapter 1`), so readers that sort by name show your order. The app checks this with plain and natural sorting and warns when a layout would reorder pages.
- After building, the CBZ is re-opened and its entry names and order are compared with the plan before the file is saved.

## Structure presets and rules

Eight presets (flat, chapter folders, nested chapters, numbered chapters, numbered pages, mixed, multiple CBZ, universal) plus custom rules. Universal import finds every image at any depth and orders by path, flagging the order as a guess. Rules are JSON (`schema: "cbz-compiler-rule"`), validated on import with specific error messages; see *Rules…* in the app to create, edit, export and import them. Output templates use `{index} {file} {name} {ext} {group} {source} {dir}`.

## Browser support and limits

- Needs `DecompressionStream('deflate-raw')`: Chrome/Edge 103+, Firefox 113+, Safari 16.4+.
- Chromium browsers can pick the save location and extraction folder directly (the system asks before replacing a file). Other browsers download the CBZ (existing files are never replaced; the browser adds a number) and extraction is delivered as one ZIP.
- Input: CBZ/ZIP only (not CBR/RAR/7z). Password-protected entries are reported and skipped.
- Output has no fixed size limit: ZIP64 records are written automatically past 65,535 pages or 4 GB (a single page must be under 4 GB). Chromium browsers stream the CBZ to disk; other browsers build it in memory first, which can fail for multi-gigabyte archives.
- The project is not saved between page loads (browsers cannot keep access to your files). Custom rules are saved in the browser's local storage.

## Develop

No build step and no dependencies.

```
npm test                      # core logic tests (Node 20+)
node tests/e2e/mkfx.mjs DIR   # create fixtures; see tests/e2e/*.mjs for the browser checks (need playwright)
```

Layout: `js/` holds the engine (`zip`, `importer`, `structure`, `rules`, `model`, `ordering`, `textorder`, `validate`, `export`), `js/ui/` the interface. Engine modules do not touch the DOM.

Deploy: push to `main`; `.github/workflows/pages.yml` runs the tests and publishes to GitHub Pages (set *Settings → Pages → Source* to *GitHub Actions*). Bump `VERSION` in `sw.js` when you change cached files.
