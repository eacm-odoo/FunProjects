# Third-party libraries

Loaded into the tab only when a PDF is opened, as content scripts in the
extension's isolated world.

| File | Source | License |
| --- | --- | --- |
| `pdf.min.js` | `pdfjs-dist@6.4.299`, `legacy/build/pdf.min.mjs` | Apache-2.0, `LICENSE-pdfjs.txt` |
| `pdf.worker.min.js` | `pdfjs-dist@6.4.299`, `legacy/build/pdf.worker.min.mjs` | Apache-2.0, `LICENSE-pdfjs.txt` |
| `pdf-lib.min.js` | `pdf-lib@1.17.1`, `dist/pdf-lib.min.js`, unchanged | MIT, `LICENSE-pdf-lib.md` |

pdf.js only ships ES modules, and content scripts are classic scripts, so the
two pdf.js files were rebuilt with esbuild 0.28.2:

```sh
esbuild legacy/build/pdf.min.mjs --format=iife --global-name=pdfjsLib --minify --outfile=pdf.min.js
esbuild legacy/build/pdf.worker.min.mjs --format=iife --minify --outfile=pdf.worker.min.js
```

The worker file sets `globalThis.pdfjsWorker` itself, and pdf.js then runs it
in the same thread instead of starting a Web Worker, which a content script
could not do from the extension's origin. `import.meta` is empty in that
build: it only serves Node and the WebAssembly decoders, so JPEG 2000 images
inside a PDF may not show in the editor (they stay untouched in the saved
copy).

The legacy build is used for the Chrome versions the manifest allows
(`minimum_chrome_version`).
