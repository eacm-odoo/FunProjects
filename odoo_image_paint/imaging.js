/**
 * Pixels in and out: decode the field's bytes onto a canvas, encode the
 * canvas back for Odoo, and the whole-image operations (fill, rotate,
 * flip, crop).
 */
(() => {
    const ns = (globalThis.oImagePaint ??= {});

    const JPEG_QUALITY = 0.92;
    const SVG_FALLBACK_SIZE = 512;

    function base64ToBytes(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function bytesToBase64(bytes) {
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    /**
     * The image type, from the bytes rather than from what Odoo says, as the
     * web client does with its "magic word".
     *
     * @param {Uint8Array} bytes
     * @returns {string|null} a MIME type
     */
    function sniffMime(bytes) {
        const startsWith = (...signature) => signature.every((byte, i) => bytes[i] === byte);
        if (startsWith(0xff, 0xd8, 0xff)) {
            return "image/jpeg";
        }
        if (startsWith(0x89, 0x50, 0x4e, 0x47)) {
            return "image/png";
        }
        if (startsWith(0x47, 0x49, 0x46, 0x38)) {
            return "image/gif";
        }
        if (startsWith(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
            return "image/webp";
        }
        if (startsWith(0x42, 0x4d)) {
            return "image/bmp";
        }
        if (startsWith(0x00, 0x00, 0x01, 0x00)) {
            return "image/x-icon";
        }
        const head = new TextDecoder().decode(bytes.subarray(0, 1024));
        // PDF readers accept the header anywhere in the first kilobyte.
        if (head.includes("%PDF-")) {
            return "application/pdf";
        }
        const text = head.replace(/^\uFEFF/, "").trimStart();
        if (text.startsWith("<") && /<svg[\s>]/i.test(text)) {
            return "image/svg+xml";
        }
        return null;
    }

    /**
     * What a source type is saved as. Odoo 19 stores WEBP without resizing
     * it, and 14.0 to 16.0 turn anything but PNG, JPEG, GIF and ICO into
     * PNG, so only JPEG keeps its format.
     */
    function outputMime(sourceMime) {
        return sourceMime === "image/jpeg" ? "image/jpeg" : "image/png";
    }

    /**
     * What a copy of an attachment is saved as: its own format when the
     * browser can write it, PNG otherwise (GIF, BMP, ICO, SVG).
     */
    function attachmentOutputMime(sourceMime) {
        return ["image/png", "image/jpeg", "image/webp"].includes(sourceMime) ? sourceMime : "image/png";
    }

    const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/pdf": "pdf" };

    function createCanvas(width, height) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
        return canvas;
    }

    function cloneCanvas(source) {
        const canvas = createCanvas(source.width, source.height);
        canvas.getContext("2d").drawImage(source, 0, 0);
        return canvas;
    }

    /**
     * @param {Uint8Array} bytes
     * @param {string} mime
     * @returns {Promise<HTMLCanvasElement>}
     */
    async function decodeImage(bytes, mime) {
        const blob = new Blob([bytes], { type: mime });
        if (mime !== "image/svg+xml") {
            const bitmap = await createImageBitmap(blob);
            const canvas = createCanvas(bitmap.width, bitmap.height);
            canvas.getContext("2d").drawImage(bitmap, 0, 0);
            bitmap.close();
            return canvas;
        }
        // createImageBitmap does not take SVG; an <img> does.
        const url = URL.createObjectURL(blob);
        try {
            const img = new Image();
            img.src = url;
            await img.decode();
            const width = img.naturalWidth || SVG_FALLBACK_SIZE;
            const height = img.naturalHeight || SVG_FALLBACK_SIZE;
            const canvas = createCanvas(width, height);
            canvas.getContext("2d").drawImage(img, 0, 0, width, height);
            return canvas;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {string} mime image/png, image/jpeg or image/webp
     * @returns {Promise<string>} base64
     */
    async function encodeCanvas(canvas, mime) {
        let source = canvas;
        if (mime === "image/jpeg") {
            // JPEG has no alpha: erased areas would turn black.
            source = createCanvas(canvas.width, canvas.height);
            const ctx = source.getContext("2d");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, source.width, source.height);
            ctx.drawImage(canvas, 0, 0);
        }
        const blob = await new Promise((resolve) => source.toBlob(resolve, mime, JPEG_QUALITY));
        if (!blob) {
            throw new Error("The browser could not encode the image.");
        }
        return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    }

    /**
     * Fill the area of similar color around (x, y), in place.
     *
     * @param {ImageData} imageData
     * @param {number} x
     * @param {number} y
     * @param {number[]} color [r, g, b, a]
     * @param {number} tolerance 0 to 100
     * @returns {{x: number, y: number, width: number, height: number, mask: Uint8Array}|null}
     *      the box that changed and which pixels did (one byte per pixel of
     *      the image), or null when nothing did
     */
    function floodFill(imageData, x, y, color, tolerance) {
        const { width, height, data } = imageData;
        if (x < 0 || y < 0 || x >= width || y >= height) {
            return null;
        }
        const start = (y * width + x) * 4;
        const target = data.slice(start, start + 4);
        if (target.every((value, i) => value === color[i])) {
            return null;
        }
        const limit = Math.round((tolerance * 255) / 100);
        // Transparent pixels have no meaningful color: compare alpha only.
        const matches =
            target[3] === 0
                ? (i) => data[i + 3] <= limit
                : (i) =>
                      Math.abs(data[i] - target[0]) <= limit &&
                      Math.abs(data[i + 1] - target[1]) <= limit &&
                      Math.abs(data[i + 2] - target[2]) <= limit &&
                      Math.abs(data[i + 3] - target[3]) <= limit;
        const done = new Uint8Array(width * height);
        const fillable = (p) => !done[p] && matches(p * 4);
        const box = { left: x, top: y, right: x, bottom: y };
        const stack = [y * width + x];
        while (stack.length) {
            const p = stack.pop();
            if (!fillable(p)) {
                continue;
            }
            const row = Math.floor(p / width);
            const rowStart = row * width;
            let left = p - rowStart;
            let right = left;
            while (left > 0 && fillable(rowStart + left - 1)) {
                left--;
            }
            while (right < width - 1 && fillable(rowStart + right + 1)) {
                right++;
            }
            let upOpen = false;
            let downOpen = false;
            for (let column = left; column <= right; column++) {
                const q = rowStart + column;
                done[q] = 1;
                data.set(color, q * 4);
                if (row > 0) {
                    const up = q - width;
                    const open = fillable(up);
                    if (open && !upOpen) {
                        stack.push(up);
                    }
                    upOpen = open;
                }
                if (row < height - 1) {
                    const down = q + width;
                    const open = fillable(down);
                    if (open && !downOpen) {
                        stack.push(down);
                    }
                    downOpen = open;
                }
            }
            box.left = Math.min(box.left, left);
            box.right = Math.max(box.right, right);
            box.top = Math.min(box.top, row);
            box.bottom = Math.max(box.bottom, row);
        }
        return {
            x: box.left,
            y: box.top,
            width: box.right - box.left + 1,
            height: box.bottom - box.top + 1,
            mask: done,
        };
    }

    /** @param {number} turns quarter turns clockwise, 1 or -1 */
    function rotateCanvas(source, turns) {
        const canvas = createCanvas(source.height, source.width);
        const ctx = canvas.getContext("2d");
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((turns * Math.PI) / 2);
        ctx.drawImage(source, -source.width / 2, -source.height / 2);
        return canvas;
    }

    function flipCanvas(source, horizontal) {
        const canvas = createCanvas(source.width, source.height);
        const ctx = canvas.getContext("2d");
        if (horizontal) {
            ctx.translate(canvas.width, 0);
            ctx.scale(-1, 1);
        } else {
            ctx.translate(0, canvas.height);
            ctx.scale(1, -1);
        }
        ctx.drawImage(source, 0, 0);
        return canvas;
    }

    function cropCanvas(source, { x, y, width, height }) {
        const canvas = createCanvas(width, height);
        canvas.getContext("2d").drawImage(source, x, y, width, height, 0, 0, width, height);
        return canvas;
    }

    Object.assign(ns, {
        base64ToBytes,
        bytesToBase64,
        sniffMime,
        outputMime,
        attachmentOutputMime,
        EXTENSIONS,
        createCanvas,
        cloneCanvas,
        decodeImage,
        encodeCanvas,
        floodFill,
        rotateCanvas,
        flipCanvas,
        cropCanvas,
    });
})();
