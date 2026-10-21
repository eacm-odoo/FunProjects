/**
 * PDFs: pages are rendered with pdf.js and edited as images over the page;
 * the copy is the original PDF with, on each edited page, the drawing added
 * on top as one image, and the page's crop box and rotation updated. The
 * PDF's own text and images are never rasterized.
 *
 * A page's document carries in its meta how its canvas relates to the page
 * as first rendered: `matrix` maps a point of the current canvas to the
 * rendered page (crops and quarter turns compose into it), `turns` counts
 * the quarter turns, `cropped` says whether the crop box must change.
 */
(() => {
    const ns = (globalThis.oImagePaint ??= {});

    // Pixels on the longest side of a page as rendered for editing.
    const RENDER_SIDE = 1600;
    const MIN_SCALE = 0.5;
    const MAX_SCALE = 4;
    const IDENTITY = [1, 0, 0, 1, 0, 0];

    let libraries = null;

    /**
     * pdf.js and pdf-lib weigh about 2 MB: the service worker injects them
     * into this tab the first time a PDF is opened.
     */
    function loadLibraries() {
        libraries ??= (async () => {
            if (!globalThis.pdfjsLib || !globalThis.PDFLib) {
                const reply = await chrome.runtime.sendMessage({ type: "load-pdf-libraries" });
                if (!reply?.ok || !globalThis.pdfjsLib || !globalThis.PDFLib) {
                    throw new ns.OdooError(`The PDF tools could not be loaded: ${reply?.error || "no answer"}.`);
                }
            }
            return { pdfjs: globalThis.pdfjsLib, PDFLib: globalThis.PDFLib };
        })().catch((error) => {
            libraries = null;
            throw error;
        });
        return libraries;
    }

    /**
     * Affine maps between canvases, as `[a, b, c, d, e, f]` for
     * x' = a·x + c·y + e and y' = b·x + d·y + f (the canvas convention).
     * `multiply(m, n)` applies n, then m.
     */
    function multiply(m, n) {
        return [
            m[0] * n[0] + m[2] * n[1],
            m[1] * n[0] + m[3] * n[1],
            m[0] * n[2] + m[2] * n[3],
            m[1] * n[2] + m[3] * n[3],
            m[0] * n[4] + m[2] * n[5] + m[4],
            m[1] * n[4] + m[3] * n[5] + m[5],
        ];
    }

    function apply(m, x, y) {
        return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    }

    /**
     * From a canvas rotated a quarter turn (1 clockwise, -1 counterclockwise)
     * back to the canvas it was rotated from, `width` × `height`.
     */
    function rotationMatrix(turns, width, height) {
        return turns > 0 ? [0, -1, 1, 0, 0, height] : [0, 1, -1, 0, width, 0];
    }

    /** From a crop starting at (x, y) back to the canvas it was cut from. */
    function cropMatrix(x, y) {
        return [1, 0, 0, 1, x, y];
    }

    /**
     * From the page as rendered (pdf.js applies the page's /Rotate,
     * clockwise) to the page in its own coordinates, `width` × `height`.
     */
    function unrotateMatrix(rotate, width, height) {
        switch (((rotate % 360) + 360) % 360) {
            case 90:
                return [0, -1, 1, 0, 0, height];
            case 180:
                return [-1, 0, 0, -1, width, height];
            case 270:
                return [0, 1, -1, 0, width, 0];
            default:
                return IDENTITY;
        }
    }

    /** A digital signature covers the bytes; any change voids it. */
    function isSigned(bytes) {
        const text = new TextDecoder("latin1").decode(bytes);
        return /\/ByteRange\s*\[/.test(text) && /\/Type\s*\/Sig\b/.test(text);
    }

    /**
     * Open a PDF for editing. pdf-lib reads it too, now rather than at the
     * first save, so a PDF it cannot write is refused before any work.
     *
     * @param {Uint8Array} bytes
     */
    async function openPdf(bytes) {
        const { pdfjs, PDFLib } = await loadLibraries();
        try {
            await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
        } catch (error) {
            if (error instanceof PDFLib.EncryptedPDFError) {
                throw new ns.OdooError("This PDF is encrypted: the editor cannot write a copy of it.");
            }
            throw new ns.OdooError(`This PDF could not be read: ${error.message}`);
        }
        try {
            // pdf.js takes over the buffer it is given: hand it a copy.
            return await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
        } catch (error) {
            if (error?.name === "PasswordException") {
                throw new ns.OdooError("This PDF is protected by a password.");
            }
            throw new ns.OdooError(`This PDF could not be read: ${error.message}`);
        }
    }

    /**
     * Render a page as the PDF shows it.
     *
     * @param {object} pdf the pdf.js document
     * @param {number} index 0-based
     * @param {{side?: number}} [options] pixels on the longest side
     * @returns {Promise<{canvas: HTMLCanvasElement, info: object}>} `info`
     *      is what the export needs to map the canvas back onto the page
     */
    async function renderPage(pdf, index, { side = RENDER_SIDE } = {}) {
        const page = await pdf.getPage(index + 1);
        const natural = page.getViewport({ scale: 1 });
        let scale = side / Math.max(natural.width, natural.height);
        if (side === RENDER_SIDE) {
            scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
        }
        const viewport = page.getViewport({ scale });
        const canvas = ns.createCanvas(viewport.width, viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport, canvas }).promise;
        page.cleanup();
        return { canvas, info: { view: [...page.view], rotate: page.rotate, width: canvas.width, height: canvas.height } };
    }

    function opaqueBounds(canvas) {
        const { width, height } = canvas;
        const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
        let left = width;
        let top = height;
        let right = -1;
        let bottom = -1;
        for (let y = 0; y < height; y++) {
            const row = y * width * 4;
            for (let x = 0; x < width; x++) {
                if (data[row + x * 4 + 3]) {
                    left = Math.min(left, x);
                    right = Math.max(right, x);
                    top = Math.min(top, y);
                    bottom = Math.max(bottom, y);
                }
            }
        }
        return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
    }

    async function pngBytes(canvas) {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) {
            throw new Error("The browser could not encode the drawing.");
        }
        return new Uint8Array(await blob.arrayBuffer());
    }

    /**
     * Write the copy: the original PDF with each edited page's drawing,
     * crop and rotation applied. Pages are never re-rendered, and the
     * document's metadata is left as it was.
     *
     * @param {Uint8Array} bytes the original PDF
     * @param {{index: number, info: object, doc: object}[]} pages the edited pages
     * @returns {Promise<Uint8Array>}
     */
    async function exportPdf(bytes, pages) {
        const { PDFLib } = await loadLibraries();
        const pdf = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
        for (const { index, info, doc } of pages) {
            const page = pdf.getPage(index);
            const { view, rotate } = info;
            const sideways = (((rotate % 360) + 360) % 360) % 180 !== 0;
            const width = sideways ? info.height : info.width;
            const height = sideways ? info.width : info.height;
            const toPage = multiply(unrotateMatrix(rotate, width, height), doc.meta.matrix || IDENTITY);
            const scaleX = width / (view[2] - view[0]);
            const scaleY = height / (view[3] - view[1]);
            const toPdf = (x, y) => [view[0] + x / scaleX, view[3] - y / scaleY];

            // The drawing, laid back onto the page as the PDF stores it.
            const flat = ns.createCanvas(width, height);
            const ctx = flat.getContext("2d");
            ctx.setTransform(...toPage);
            ctx.drawImage(doc.canvas, 0, 0);
            const box = opaqueBounds(flat);
            if (box) {
                const image = await pdf.embedPng(await pngBytes(ns.cropCanvas(flat, box)));
                const [x, y] = toPdf(box.x, box.y + box.height);
                page.drawImage(image, { x, y, width: box.width / scaleX, height: box.height / scaleY });
            }
            if (doc.meta.cropped) {
                const corners = [
                    [0, 0],
                    [doc.width, 0],
                    [0, doc.height],
                    [doc.width, doc.height],
                ].map(([x, y]) => apply(toPage, x, y));
                const xs = corners.map(([x]) => x);
                const ys = corners.map(([, y]) => y);
                const [left, bottom] = toPdf(Math.min(...xs), Math.max(...ys));
                const [right, top] = toPdf(Math.max(...xs), Math.min(...ys));
                page.setCropBox(left, bottom, right - left, top - bottom);
            }
            const turns = doc.meta.turns || 0;
            if (turns % 4) {
                page.setRotation(PDFLib.degrees((((rotate + turns * 90) % 360) + 360) % 360));
            }
        }
        return pdf.save();
    }

    Object.assign(ns, {
        IDENTITY,
        multiply,
        apply,
        rotationMatrix,
        cropMatrix,
        unrotateMatrix,
        isSigned,
        openPdf,
        renderPage,
        exportPdf,
    });
})();
