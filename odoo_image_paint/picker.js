/**
 * Picker mode: outline every record image on the page and let the user
 * click the one to edit. The outlines live in an overlay that follows the
 * images as the page scrolls or re-renders; the page itself is not touched.
 */
(() => {
    const ns = (globalThis.oImagePaint ??= {});

    const MIN_SIZE = 8;
    const RESCAN_FRAMES = 30;

    function isShown(element) {
        const rect = element.getBoundingClientRect();
        if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
            return false;
        }
        return element.checkVisibility ? element.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true }) : true;
    }

    class Picker {
        /**
         * @param {string} origin
         * @param {{pick: function(object): void, end: function(): void}} handlers
         */
        constructor(origin, handlers) {
            this.origin = origin;
            this.handlers = handlers;
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

        start() {
            this.scan();
            if (!this.targets.length) {
                ns.toast("No image field of a record on this page.");
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
                ns.h("strong", {}, "Click the image to edit"),
                this.count,
                ns.h("button", { type: "button", onclick: () => this.stop() }, "Cancel")
            );
            root.append(this.layer, this.banner);
            this.render();
            window.addEventListener("keydown", this.onKey, true);
            let frames = 0;
            const loop = () => {
                if (++frames % RESCAN_FRAMES === 0) {
                    this.scan();
                    this.render();
                } else {
                    this.position();
                }
                this.frame = requestAnimationFrame(loop);
            };
            this.frame = requestAnimationFrame(loop);
        }

        scan() {
            const skip = this.host ? [this.host] : [];
            this.targets = ns.findImages(this.origin, skip).filter(({ element }) => isShown(element));
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
                const { model, id } = target.image;
                const label = `${model} #${id} · ${target.names[0]}`;
                box.dataset.index = String(index);
                box.setAttribute("aria-label", `Edit ${label}`);
                box.firstChild.textContent = label;
            });
            const n = this.targets.length;
            this.count.textContent = n === 1 ? "1 image" : `${n} images`;
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
