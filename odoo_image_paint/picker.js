/**
 * Picker mode: outline every record image, and every image or PDF
 * attachment, on the page and let the user click the one to edit. The
 * outlines live in an overlay that follows the elements as the page scrolls
 * or re-renders; the page itself is not touched.
 *
 * An attachment's URL does not say what it holds, so attachments are only
 * outlined once Odoo has said they are images or PDFs.
 */
(() => {
    const ns = (globalThis.oImagePaint ??= {});

    const MIN_SIZE = 8;
    const RESCAN_FRAMES = 30;
    // Viewers and dialogs cover the page: only what they show can be picked.
    const OVERLAYS = ".o-FileViewer, .o_AttachmentViewer, .modal.show, .modal.d-block";

    function isShown(element) {
        const rect = element.getBoundingClientRect();
        if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
            return false;
        }
        return element.checkVisibility
            ? element.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })
            : true;
    }

    class Picker {
        /**
         * @param {string} origin
         * @param {{pick: function(object): void, end: function(): void}} handlers
         */
        constructor(origin, handlers) {
            this.origin = origin;
            this.handlers = handlers;
            this.rpc = ns.createRpc(origin);
            // Attachment id → what it is (classifyAttachment), or "pending".
            this.attachments = new Map();
            this.targets = [];
            this.boxes = [];
            this.frame = 0;
            this.onKey = (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.stop();
                }
            };
        }

        get pending() {
            return [...this.attachments.values()].includes("pending");
        }

        start() {
            if (!this.collect().length) {
                ns.toast("No image field or attachment on this page.");
                this.handlers.end();
                return;
            }
            const { host, root } = ns.createHost("picker", { passThrough: true });
            this.host = host;
            this.layer = ns.h("div", { class: "o_paint_picker" });
            this.count = ns.h("span");
            this.banner = ns.h(
                "div",
                { class: "o_paint_banner", role: "status" },
                ns.h("strong", {}, "Click the image or PDF to edit"),
                this.count,
                ns.h("button", { type: "button", onclick: () => this.stop() }, "Cancel")
            );
            root.append(this.layer, this.banner);
            this.scan();
            window.addEventListener("keydown", this.onKey, true);
            let frames = 0;
            const loop = () => {
                if (++frames % RESCAN_FRAMES === 0) {
                    this.scan();
                } else {
                    this.position();
                }
                this.frame = requestAnimationFrame(loop);
            };
            this.frame = requestAnimationFrame(loop);
        }

        /** Every candidate in view, in the topmost viewer or dialog if one is open. */
        collect() {
            const found = ns.findTargets(this.origin, this.host ? [this.host] : []).filter(({ element }) => isShown(element));
            const overlay = [...document.querySelectorAll(OVERLAYS)].filter(isShown).at(-1);
            return overlay ? found.filter(({ element }) => overlay.contains(element)) : found;
        }

        scan() {
            const found = this.collect();
            const unknown = [
                ...new Set(found.filter(({ ref }) => ref.kind === "attachment" && !this.attachments.has(ref.id)).map(({ ref }) => ref.id)),
            ];
            if (unknown.length) {
                this.lookup(unknown);
            }
            const targets = [];
            for (const item of found) {
                if (item.ref.kind === "field") {
                    targets.push(item);
                    continue;
                }
                const kind = this.attachments.get(item.ref.id);
                if (!kind || kind === "pending") {
                    continue;
                }
                // An attachment kept as a record's image field is that field.
                const ref = kind.kind === "field" ? kind : { kind: "attachment", id: kind.id, media: kind.media };
                const names = kind.kind === "field" ? [kind.field] : [];
                targets.push({ ...item, ref, names, label: kind.name });
            }
            // A download link only counts when nothing shows that attachment,
            // and once.
            const shown = new Set(targets.filter(({ visual }) => visual).map(({ key }) => key));
            const linked = new Set();
            this.targets = targets.filter(({ visual, key }) => {
                if (visual) {
                    return true;
                }
                if (shown.has(key) || linked.has(key)) {
                    return false;
                }
                linked.add(key);
                return true;
            });
            this.render();
        }

        async lookup(ids) {
            for (const id of ids) {
                this.attachments.set(id, "pending");
            }
            let rows = [];
            try {
                rows = await this.rpc.readAttachments(ids);
            } catch {
                // Unreadable attachments are simply not offered.
            }
            for (const id of ids) {
                this.attachments.set(id, ns.classifyAttachment(rows.find((row) => row.id === id)));
            }
            if (!this.host) {
                return;
            }
            this.scan();
            if (!this.targets.length && !this.pending) {
                this.stop();
                ns.toast("No image or PDF to edit on this page.");
            }
        }

        render() {
            while (this.boxes.length > this.targets.length) {
                this.boxes.pop().remove();
            }
            this.targets.forEach((target, index) => {
                let box = this.boxes[index];
                if (!box) {
                    box = ns.h("div", { class: "o_paint_target", role: "button", tabindex: "0" });
                    box.append(ns.h("span", { class: "o_paint_target_label" }));
                    box.addEventListener("pointerdown", (event) => event.preventDefault());
                    box.addEventListener("click", () => this.pick(Number(box.dataset.index)));
                    box.addEventListener("keydown", (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            this.pick(Number(box.dataset.index));
                        }
                    });
                    this.layer.append(box);
                    this.boxes.push(box);
                }
                const { ref } = target;
                const label =
                    ref.kind === "field"
                        ? `${ref.model} #${ref.id} · ${target.names[0]}`
                        : `${target.label || "Attachment"} · attachment #${ref.id}`;
                box.dataset.index = String(index);
                box.setAttribute("aria-label", `Edit ${label}`);
                box.firstChild.textContent = label;
            });
            const n = this.targets.length;
            this.count.textContent = n ? `${n} found` : this.pending ? "Looking…" : "None found";
            this.position();
        }

        position() {
            this.targets.forEach(({ element }, index) => {
                const rect = element.getBoundingClientRect();
                const style = this.boxes[index].style;
                style.left = `${rect.left}px`;
                style.top = `${rect.top}px`;
                style.width = `${rect.width}px`;
                style.height = `${rect.height}px`;
                style.display = element.isConnected ? "" : "none";
            });
        }

        pick(index) {
            const target = this.targets[index];
            if (!target?.element.isConnected) {
                return;
            }
            this.stop({ picked: true });
            this.handlers.pick(target);
        }

        stop({ picked = false } = {}) {
            cancelAnimationFrame(this.frame);
            window.removeEventListener("keydown", this.onKey, true);
            this.host?.remove();
            this.host = null;
            if (!picked) {
                this.handlers.end();
            }
        }
    }

    ns.Picker = Picker;
})();
