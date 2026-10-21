/**
 * What the extension knows about Odoo: which record field or attachment an
 * image (or a PDF) on the page comes from, which field really holds it, and
 * the only JSON-RPC calls it may make.
 *
 * The content scripts are classic scripts sharing the extension's isolated
 * world, so each file hangs what it exports on one namespace.
 */
(() => {
    const ns = (globalThis.oImagePaint ??= {});

    const MODEL_RE = /^[a-z_][a-z0-9_]*(\.[a-z0-9_]+)*$/i;
    const FIELD_RE = /^[a-z_][a-z0-9_]*$/i;
    const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
    const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
    // image.mixin's resized copies are related to image_1920 and write the
    // value through, so saving into image_128 would leave a 128 px copy in
    // image_1920. The avatars are computed from image_* and have no inverse.
    const RESIZED_RE = /^(\w+)_(1024|512|256|128)$/;
    const AVATAR_RE = /^avatar_\d+$/;
    // Every version previews PDFs in Odoo's own pdf.js viewer, in an iframe.
    const PDF_VIEWER_PATH = "/web/static/lib/pdfjs/web/viewer.html";
    // What Chrome can decode; TIFF, for one, it cannot.
    const IMAGE_MIMES = new Set([
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/svg+xml",
        "image/x-icon",
        "image/vnd.microsoft.icon",
    ]);
    const ATTACHMENT_FIELDS = ["name", "mimetype", "type", "res_model", "res_id", "res_field"];

    class OdooError extends Error {}

    const isRecordId = (value) => /^\d+$/.test(value || "") && Number(value) > 0 && Number.isSafeInteger(Number(value));

    /**
     * Read what an Odoo URL points to:
     * - a record's image field: `/web/image?model=…&id=…&field=…` (14.0 to
     *   17.0) or `/web/image/<model>/<id>/<field>` (18.0 and later);
     * - an attachment: `/web/image/<id>…`, `/web/content/<id>…`,
     *   `/web/content?id=…` (14.0), `/web/image/ir.attachment/<id>/<field>`,
     *   or a PDF shown in Odoo's pdf.js viewer.
     * Xml ids, static files and binary fields of other models are left out.
     *
     * @param {string} src an absolute URL
     * @param {string} origin the tab's origin
     * @returns {{kind: "field", model: string, id: number, field: string}
     *      |{kind: "attachment", id: number}|null}
     */
    function parseUrl(src, origin, depth = 0) {
        let url;
        try {
            url = new URL(src);
        } catch {
            return null;
        }
        if (url.origin !== origin) {
            return null;
        }
        if (url.pathname === PDF_VIEWER_PATH) {
            const file = url.searchParams.get("file");
            return file && depth === 0 ? parseUrl(new URL(file, url).href, origin, 1) : null;
        }
        const route = url.pathname.match(/^\/web\/(image|content)(?:\/(.*))?$/);
        if (!route) {
            return null;
        }
        const build = (model, id, field) => {
            if (!isRecordId(id)) {
                return null;
            }
            if (model === "ir.attachment") {
                return { kind: "attachment", id: Number(id) };
            }
            // A /web/content link to another model is a file download, not an image.
            if (route[1] !== "image" || !MODEL_RE.test(model || "") || !FIELD_RE.test(field || "")) {
                return null;
            }
            return { kind: "field", model, id: Number(id), field };
        };
        let segments;
        try {
            segments = (route[2] || "").split("/").filter(Boolean).map(decodeURIComponent);
        } catch {
            return null;
        }
        if (!segments.length) {
            const params = url.searchParams;
            return build(params.get("model") || "ir.attachment", params.get("id"), params.get("field"));
        }
        const attachment = segments[0].match(/^(\d+)(-[^/]*)?$/);
        if (attachment) {
            return build("ir.attachment", attachment[1]);
        }
        if (segments.length >= 3) {
            return build(segments[0], segments[1], segments[2]);
        }
        return null;
    }

    /**
     * Pick the field to edit and write among the ones naming an image: the
     * widget's own field first (the URL often shows its `preview_image`),
     * then the URL's, moved back to the full-size image they derive from.
     *
     * @param {object} fields fields_get of the model
     * @param {string[]} names candidate field names, best first
     * @returns {{field: string, label: string}}
     */
    function resolveImageField(fields, names) {
        const shown = names.find((name) => fields[name]?.type === "binary");
        if (!shown) {
            throw new OdooError("This image is not an image field of the record.");
        }
        let field = shown;
        const resized = shown.match(RESIZED_RE);
        // Avatars first: avatar_1920 exists too, but is computed as well.
        if (AVATAR_RE.test(shown)) {
            if (fields.image_1920?.type === "binary") {
                field = "image_1920";
            }
        } else if (resized && fields[`${resized[1]}_1920`]?.type === "binary") {
            field = `${resized[1]}_1920`;
        }
        if (fields[field].readonly) {
            throw new OdooError(`The field "${fields[field].string}" is read-only.`);
        }
        return { field, label: fields[field].string || field };
    }

    /**
     * What can be done with an attachment, from its read values: edit it as
     * an image or a PDF (into a copy), edit it as the record field it stores
     * (`res_field`), or nothing.
     *
     * @returns {{kind: "attachment", id: number, media: "image"|"pdf", name: string}
     *      |{kind: "field", model: string, id: number, field: string}|null}
     */
    function classifyAttachment(row) {
        if (!row || row.type !== "binary") {
            return null;
        }
        if (row.res_field) {
            return MODEL_RE.test(row.res_model || "") && row.res_id > 0 && FIELD_RE.test(row.res_field)
                ? { kind: "field", model: row.res_model, id: row.res_id, field: row.res_field }
                : null;
        }
        const mime = (row.mimetype || "").toLowerCase();
        const media = mime === "application/pdf" ? "pdf" : IMAGE_MIMES.has(mime) ? "image" : null;
        return media && { kind: "attachment", id: row.id, media, name: row.name || "" };
    }

    /**
     * The name of the edited copy: "photo.jpg" gives "photo (edited).jpg".
     * When the copy changes format, its extension follows.
     *
     * @param {string} name the original's name
     * @param {string} extension the copy's usual extension, without the dot
     */
    function copyName(name, extension) {
        const [, stem, current] = (name || "").match(/^(.*?)(?:\.([^./\\]+))?$/);
        const same = (current || "").toLowerCase();
        const keep = same === extension || (extension === "jpg" && same === "jpeg");
        return `${stem || "file"} (edited).${keep ? current : extension}`;
    }

    /**
     * JSON-RPC through the web client's endpoint, with the session of the
     * tab. Only these calls exist: fields_get, read and write of one image
     * field of one record; read of attachments; create of one attachment and
     * write of its content.
     *
     * Requests use an absolute URL on the tab's origin, as Chrome reported
     * it, so a `<base href>` in the page cannot send them elsewhere.
     *
     * @param {string} origin
     */
    function createRpc(origin) {
        const call = async (model, method, args, kwargs) => {
            if (location.origin !== origin) {
                throw new OdooError("This tab is no longer on the site the editor was opened from.");
            }
            let reply;
            try {
                const response = await fetch(new URL(`/web/dataset/call_kw/${model}/${method}`, origin), {
                    method: "POST",
                    credentials: "same-origin",
                    redirect: "error",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        method: "call",
                        id: Date.now(),
                        params: { model, method, args, kwargs },
                    }),
                });
                if (!response.ok) {
                    throw new OdooError(`Odoo answered HTTP ${response.status}.`);
                }
                reply = await response.json();
            } catch (error) {
                throw error instanceof OdooError ? error : new OdooError(`Odoo did not answer: ${error.message}`);
            }
            if (reply.error) {
                throw new OdooError(reply.error.data?.message || reply.error.message || "Odoo returned an error.");
            }
            return reply.result;
        };
        const checkTarget = (model, id, field) => {
            if (!MODEL_RE.test(model) || !FIELD_RE.test(field) || !(Number.isSafeInteger(id) && id > 0)) {
                throw new OdooError("Invalid record.");
            }
        };
        const checkContent = (base64, mimetype) => {
            if (typeof base64 !== "string" || !base64 || !BASE64_RE.test(base64)) {
                throw new OdooError("Invalid file data.");
            }
            if (!MIME_RE.test(mimetype || "")) {
                throw new OdooError("Invalid file type.");
            }
        };
        return {
            fieldsGet(model) {
                checkTarget(model, 1, "id");
                return call(model, "fields_get", [], { attributes: ["type", "string", "readonly"], context: {} });
            },
            async read(model, id, fields) {
                checkTarget(model, id, "id");
                const [values] = await call(model, "read", [[id], fields], { context: {} });
                if (!values) {
                    throw new OdooError("The record no longer exists.");
                }
                return values;
            },
            write(model, id, field, base64) {
                checkTarget(model, id, field);
                if (base64 !== false && (typeof base64 !== "string" || !BASE64_RE.test(base64))) {
                    throw new OdooError("Invalid image data.");
                }
                return call(model, "write", [[id], { [field]: base64 }], { context: {} });
            },
            /** Metadata only, for the picker to tell images and PDFs apart. */
            readAttachments(ids) {
                if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
                    throw new OdooError("Invalid attachment.");
                }
                return call("ir.attachment", "read", [ids, ATTACHMENT_FIELDS], { context: {} });
            },
            async readAttachment(id) {
                checkTarget("ir.attachment", id, "id");
                const [values] = await call("ir.attachment", "read", [[id], [...ATTACHMENT_FIELDS, "res_name", "datas"]], {
                    context: {},
                });
                if (!values) {
                    throw new OdooError("The attachment no longer exists.");
                }
                return values;
            },
            /** A new attachment, next to the original: the original is never written. */
            createAttachment({ name, datas, mimetype, res_model, res_id }) {
                checkContent(datas, mimetype);
                if (typeof name !== "string" || !name || name.length > 1024) {
                    throw new OdooError("Invalid file name.");
                }
                const values = { name, datas, mimetype };
                if (res_model) {
                    if (!MODEL_RE.test(res_model) || !(Number.isSafeInteger(res_id) && res_id >= 0)) {
                        throw new OdooError("Invalid record.");
                    }
                    Object.assign(values, { res_model, res_id });
                }
                return call("ir.attachment", "create", [values], { context: {} });
            },
            /** Only ever called on the copy this editor created. */
            writeAttachment(id, { datas, mimetype }) {
                checkTarget("ir.attachment", id, "id");
                checkContent(datas, mimetype);
                return call("ir.attachment", "write", [[id], { datas, mimetype }], { context: {} });
            },
        };
    }

    /**
     * Every element on the page pointing at a record image or an attachment:
     * `<img>` tags, inline `background-image` styles (14.0 kanbans and
     * chatter), iframes (the PDF viewer) and download links.
     *
     * @param {string} origin
     * @param {Element[]} [skip] containers to leave out (the extension's own)
     * @returns {{element: Element, ref: object, names: string[], visual: boolean}[]}
     */
    function findTargets(origin, skip = []) {
        const found = [];
        // An element can carry the same URL twice (14.0 chatter: href and background).
        const seen = new Map();
        const add = (element, src, visual) => {
            const ref = parseUrl(src, origin);
            if (!ref || skip.some((root) => root.contains(element))) {
                return;
            }
            const key = ref.kind === "field" ? `${ref.model}/${ref.id}/${ref.field}` : `attachment/${ref.id}`;
            const keys = seen.get(element) ?? new Set();
            if (keys.has(key)) {
                return;
            }
            seen.set(element, keys.add(key));
            let names = [];
            if (ref.kind === "field") {
                const widgetName =
                    element.getAttribute("name") || element.closest(".o_field_image")?.getAttribute("name");
                names = [widgetName, ref.field].filter((name, index, all) => name && all.indexOf(name) === index);
            }
            found.push({ element, ref, names, visual, key });
        };
        for (const img of document.images) {
            add(img, img.src, true);
        }
        for (const element of document.querySelectorAll('[style*="/web/"]')) {
            const match = getComputedStyle(element).backgroundImage.match(/url\("?(.*?)"?\)/);
            if (match) {
                add(element, match[1], true);
            }
        }
        for (const frame of document.querySelectorAll("iframe[src]")) {
            add(frame, frame.src, true);
        }
        for (const link of document.querySelectorAll('a[href*="/web/content"], a[href*="/web/image"]')) {
            add(link, link.href, false);
        }
        return found;
    }

    /**
     * Point the page's copies of a record's image at fresh URLs, so the
     * browser fetches what was just saved instead of its cached copy.
     *
     * @param {string} origin
     * @param {{model: string, id: number}} record
     */
    function refreshImages(origin, { model, id }) {
        const bust = (src) => {
            const url = new URL(src);
            url.searchParams.set("unique", String(Date.now()));
            return url.href;
        };
        for (const { element, ref } of findTargets(origin)) {
            if (ref.kind !== "field" || ref.model !== model || ref.id !== id) {
                continue;
            }
            if (element instanceof HTMLImageElement) {
                element.src = bust(element.src);
            } else if (!(element instanceof HTMLAnchorElement) && !(element instanceof HTMLIFrameElement)) {
                const match = getComputedStyle(element).backgroundImage.match(/url\("?(.*?)"?\)/);
                element.style.backgroundImage = `url("${bust(match[1])}")`;
            }
        }
    }

    Object.assign(ns, {
        OdooError,
        parseUrl,
        resolveImageField,
        classifyAttachment,
        copyName,
        createRpc,
        findTargets,
        refreshImages,
    });
})();
