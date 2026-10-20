/**
 * What the extension knows about Odoo: which record and field an image on
 * the page comes from, which field really holds it, and the only JSON-RPC
 * calls it may make.
 *
 * The content scripts are classic scripts sharing the extension's isolated
 * world, so each file hangs what it exports on one namespace.
 */
(() => {
    const ns = (globalThis.oImagePaint ??= {});

    const MODEL_RE = /^[a-z_][a-z0-9_]*(\.[a-z0-9_]+)*$/i;
    const FIELD_RE = /^[a-z_][a-z0-9_]*$/i;
    // image.mixin's resized copies are related to image_1920 and write the
    // value through, so saving into image_128 would leave a 128 px copy in
    // image_1920. The avatars are computed from image_* and have no inverse.
    const RESIZED_RE = /^(\w+)_(1024|512|256|128)$/;
    const AVATAR_RE = /^avatar_\d+$/;

    class OdooError extends Error {}

    /**
     * Read the record behind an image URL. 14.0 to 17.0 build
     * `/web/image?model=…&id=…&field=…`, 18.0 and later
     * `/web/image/<model>/<id>/<field>`; other forms (attachments, xml ids)
     * are not record fields.
     *
     * @param {string} src an absolute URL
     * @param {string} origin the tab's origin
     * @returns {{model: string, id: number, field: string}|null}
     */
    function parseImageUrl(src, origin) {
        let url;
        try {
            url = new URL(src);
        } catch {
            return null;
        }
        if (url.origin !== origin) {
            return null;
        }
        let model, id, field;
        if (url.pathname === "/web/image" || url.pathname === "/web/image/") {
            model = url.searchParams.get("model");
            id = url.searchParams.get("id");
            field = url.searchParams.get("field");
        } else {
            const match = url.pathname.match(/^\/web\/image\/([^/]+)\/([^/]+)\/([^/]+)/);
            if (!match) {
                return null;
            }
            try {
                [model, id, field] = match.slice(1).map(decodeURIComponent);
            } catch {
                return null;
            }
        }
        if (!MODEL_RE.test(model || "") || !FIELD_RE.test(field || "") || !/^\d+$/.test(id || "")) {
            return null;
        }
        const recordId = Number(id);
        return recordId > 0 && Number.isSafeInteger(recordId) ? { model, id: recordId, field } : null;
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
     * JSON-RPC through the web client's endpoint, with the session of the
     * tab. Only fields_get, read and write can be called, and write takes
     * one record and one image field.
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
                if (base64 !== false && (typeof base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))) {
                    throw new OdooError("Invalid image data.");
                }
                return call(model, "write", [[id], { [field]: base64 }], { context: {} });
            },
        };
    }

    /**
     * Every element on the page showing a record's image: `<img>` tags and,
     * as in 14.0 kanbans, inline `background-image` styles.
     *
     * @param {string} origin
     * @param {Element[]} [skip] containers to leave out (the extension's own)
     * @returns {{element: Element, image: object, names: string[]}[]}
     */
    function findImages(origin, skip = []) {
        const found = [];
        const add = (element, src) => {
            const image = parseImageUrl(src, origin);
            if (!image || skip.some((root) => root.contains(element))) {
                return;
            }
            const widgetName =
                element.getAttribute("name") || element.closest(".o_field_image")?.getAttribute("name");
            const names = [widgetName, image.field].filter((name, index, all) => name && all.indexOf(name) === index);
            found.push({ element, image, names });
        };
        for (const img of document.images) {
            add(img, img.src);
        }
        for (const element of document.querySelectorAll('[style*="/web/image"]')) {
            const match = getComputedStyle(element).backgroundImage.match(/url\("?(.*?)"?\)/);
            if (match) {
                add(element, match[1]);
            }
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
        for (const { element, image } of findImages(origin)) {
            if (image.model !== model || image.id !== id) {
                continue;
            }
            if (element instanceof HTMLImageElement) {
                element.src = bust(element.src);
            } else {
                const match = getComputedStyle(element).backgroundImage.match(/url\("?(.*?)"?\)/);
                element.style.backgroundImage = `url("${bust(match[1])}")`;
            }
        }
    }

    Object.assign(ns, { OdooError, parseImageUrl, resolveImageField, createRpc, findImages, refreshImages });
})();
