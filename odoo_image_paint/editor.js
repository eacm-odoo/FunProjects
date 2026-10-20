/**
 * The editor: a modal over the Odoo page with the canvas, the tools, and
 * the save and revert flows. Both writes go through a confirmation that
 * shows what Odoo holds now next to what will replace it.
 */
(() => {
    const ns = (globalThis.oImagePaint ??= {});

    const MIN_ZOOM = 0.05;
    const MAX_ZOOM = 32;
    const ZOOM_STEPS = [0.05, 0.1, 0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
    const STAGE_PADDING = 32;
    const BLANK_SIZE = 512;
    const THUMB_SIZE = 200;
    const MAX_STORED_SIDE = 1920;
    const PALETTE = [
        "#000000",
        "#7f7f7f",
        "#880015",
        "#ed1c24",
        "#ff7f27",
        "#fff200",
        "#22b14c",
        "#ffffff",
        "#c3c3c3",
        "#00a2e8",
        "#3f48cc",
        "#a349a4",
        "#714b67",
        "#017e84",
    ];
    const TOOLS = [
        { name: "brush", label: "Pencil", key: "b" },
        { name: "eraser", label: "Eraser", key: "e" },
        { name: "line", label: "Line", key: "l" },
        { name: "rectangle", label: "Rectangle", key: "r" },
        { name: "ellipse", label: "Ellipse", key: "o" },
        { name: "fill", label: "Fill", key: "f" },
        { name: "text", label: "Text", key: "t" },
        { name: "eyedropper", label: "Pick a color", key: "i" },
        { name: "crop", label: "Crop", key: "c" },
    ];
    const TOOL_OPTIONS = {
        brush: ["size"],
        eraser: ["size"],
        line: ["size"],
        rectangle: ["size", "style"],
        ellipse: ["size", "style"],
        fill: ["tolerance"],
        text: ["font"],
        eyedropper: ["eyedropper"],
        crop: ["crop"],
    };
    const FORMAT_NAMES = {
        "image/png": "PNG",
        "image/jpeg": "JPEG",
        "image/gif": "GIF",
        "image/webp": "WebP",
        "image/svg+xml": "SVG",
        "image/bmp": "BMP",
        "image/x-icon": "ICO",
    };

    function thumbnail(source) {
        const scale = Math.min(1, THUMB_SIZE / Math.max(source.width, source.height));
        const canvas = ns.createCanvas(source.width * scale, source.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    async function decodeBase64(base64) {
        if (!base64) {
            return null;
        }
        const bytes = ns.base64ToBytes(base64);
        const mime = ns.sniffMime(bytes);
        return mime ? ns.decodeImage(bytes, mime) : null;
    }

    class Editor {
        /**
         * @param {string} origin the tab's origin
         * @param {{image: object, names: string[]}} target what the picker found
         * @param {function(): void} onClose
         */
        constructor(origin, target, onClose) {
            this.origin = origin;
            this.target = target;
            this.onClose = onClose;
            this.rpc = ns.createRpc(origin);
            this.options = { color: "#000000", size: 4, fill: false, tolerance: 15, fontSize: 32, bold: false };
            this.zoom = 1;
            this.toolName = "brush";
            this.previousTool = "brush";
            this.cropRect = null;
            this.drawing = null;
            this.busy = false;
            this.dialogOpen = false;
            this.doc = null;
            this.record = null;
            this.original = null;
            this.odooValue = false;
            this.savedState = null;
            this.hasSaved = false;
        }

        get tool() {
            return this.tools?.[this.toolName];
        }

        /** The canvas differs from what Odoo holds. */
        get dirty() {
            return Boolean(this.doc) && this.doc.state !== this.savedState;
        }

        async open() {
            this.build();
            this.root.focus();
            try {
                await this.load();
            } catch (error) {
                this.stage.replaceChildren(ns.h("div", { class: "o_paint_loading" }, "The image could not be opened."));
                this.say(error.message, "error");
            }
            this.refresh();
        }

        focus() {
            this.root.focus();
        }

        // ---------------------------------------------------------------
        // Loading
        // ---------------------------------------------------------------

        async load() {
            const { model, id } = this.target.image;
            const fields = await this.rpc.fieldsGet(model);
            const { field, label } = ns.resolveImageField(fields, this.target.names);
            const wanted = [field, "display_name"].filter((name) => name in fields);
            const values = await this.rpc.read(model, id, wanted);
            this.record = { model, id, field, label, displayName: values.display_name || `${model} #${id}` };
            this.title.replaceChildren(
                ns.h("strong", {}, this.record.displayName),
                ns.h("span", {}, `${label} · ${model} #${id}`)
            );

            const base64 = values[field] || false;
            let canvas;
            let mime = null;
            if (base64) {
                const bytes = ns.base64ToBytes(base64);
                mime = ns.sniffMime(bytes);
                if (!mime) {
                    throw new ns.OdooError("This field does not hold an image the editor can read.");
                }
                try {
                    canvas = await ns.decodeImage(bytes, mime);
                } catch {
                    throw new ns.OdooError("The browser could not read this image.");
                }
            } else {
                canvas = ns.createCanvas(BLANK_SIZE, BLANK_SIZE);
                this.say("The field is empty: you start from a blank image.");
            }
            this.original = { base64, mime };
            this.originalCanvas = ns.cloneCanvas(canvas);
            this.odooValue = base64;
            this.outputMime = ns.outputMime(mime);

            this.doc = new ns.PaintDocument(canvas);
            this.doc.onChange = () => this.onDocChange();
            this.size = { width: this.doc.width, height: this.doc.height };
            this.savedState = this.doc.state;
            this.tools = ns.createTools(this);
            this.mount();
            this.useTool("brush", { force: true });
            this.setZoom(this.fitZoom());
        }

        async readCurrent() {
            const { model, id, field } = this.record;
            const values = await this.rpc.read(model, id, [field]);
            return values[field] || false;
        }

        // ---------------------------------------------------------------
        // Building the UI
        // ---------------------------------------------------------------

        build() {
            const { h, icon } = ns;
            const { host, root } = ns.createHost("editor");
            this.host = host;

            const { model, id } = this.target.image;
            this.title = h("div", { class: "o_paint_title" }, h("strong", {}, `${model} #${id}`));
            const header = h(
                "header",
                { class: "o_paint_header" },
                this.title,
                h(
                    "button",
                    { type: "button", class: "o_paint_close", title: "Close (Esc)", "aria-label": "Close", onclick: () => this.close() },
                    icon("close")
                )
            );

            const action = (iconName, label, handler) =>
                h("button", { type: "button", class: "o_paint_tool", title: label, "aria-label": label, onclick: handler }, icon(iconName));
            const separator = () => h("span", { class: "o_paint_separator", "aria-hidden": "true" });
            this.toolButtons = {};
            for (const { name, label, key } of TOOLS) {
                this.toolButtons[name] = h(
                    "button",
                    {
                        type: "button",
                        class: "o_paint_tool",
                        title: `${label} (${key.toUpperCase()})`,
                        "aria-label": label,
                        "aria-pressed": "false",
                        onclick: () => this.useTool(name),
                    },
                    icon(name)
                );
            }
            this.transformButtons = [
                action("rotateLeft", "Rotate left", () => this.transform((canvas) => ns.rotateCanvas(canvas, -1))),
                action("rotateRight", "Rotate right", () => this.transform((canvas) => ns.rotateCanvas(canvas, 1))),
                action("flipHorizontal", "Flip horizontally", () => this.transform((canvas) => ns.flipCanvas(canvas, true))),
                action("flipVertical", "Flip vertically", () => this.transform((canvas) => ns.flipCanvas(canvas, false))),
            ];
            this.undoButton = action("undo", "Undo (Ctrl+Z)", () => this.undo());
            this.redoButton = action("redo", "Redo (Ctrl+Y)", () => this.redo());
            this.zoomLabel = h(
                "button",
                { type: "button", class: "o_paint_zoom_label", title: "Actual size (1)", onclick: () => this.setZoom(1) },
                "100%"
            );
            this.zoomButtons = [
                action("zoomOut", "Zoom out (-)", () => this.zoomStep(-1)),
                this.zoomLabel,
                action("zoomIn", "Zoom in (+)", () => this.zoomStep(1)),
                action("fit", "Fit (0)", () => this.setZoom(this.fitZoom())),
            ];
            const toolbar = h(
                "div",
                { class: "o_paint_toolbar", role: "toolbar", "aria-label": "Tools" },
                Object.values(this.toolButtons),
                separator(),
                this.transformButtons,
                separator(),
                this.undoButton,
                this.redoButton,
                separator(),
                this.zoomButtons
            );

            this.colorInput = h("input", {
                type: "color",
                class: "o_paint_color",
                title: "Color",
                "aria-label": "Color",
                value: this.options.color,
                oninput: (event) => this.setColor(event.target.value),
            });
            const swatches = PALETTE.map((color) => {
                const swatch = h("button", {
                    type: "button",
                    class: "o_paint_swatch",
                    title: color,
                    "aria-label": color,
                    onclick: () => this.setColor(color),
                });
                swatch.style.background = color;
                return swatch;
            });
            const group = (label, ...controls) =>
                h("label", { class: "o_paint_group" }, h("span", { class: "o_paint_group_label" }, label), controls);

            this.sizeInput = h("input", {
                type: "range",
                min: "1",
                max: "100",
                oninput: (event) => this.setOption("size", Number(event.target.value)),
            });
            this.sizeValue = h("span", { class: "o_paint_value" });
            this.styleButtons = {
                outline: h("button", { type: "button", onclick: () => this.setOption("fill", false) }, "Outline"),
                filled: h("button", { type: "button", onclick: () => this.setOption("fill", true) }, "Filled"),
            };
            this.toleranceInput = h("input", {
                type: "range",
                min: "0",
                max: "100",
                oninput: (event) => this.setOption("tolerance", Number(event.target.value)),
            });
            this.toleranceValue = h("span", { class: "o_paint_value" });
            this.fontSizeInput = h("input", {
                type: "number",
                min: "6",
                max: "500",
                onchange: (event) => {
                    const value = Math.round(Number(event.target.value));
                    this.setOption("fontSize", Math.min(500, Math.max(6, value || this.options.fontSize)));
                },
            });
            this.boldInput = h("input", {
                type: "checkbox",
                onchange: (event) => this.setOption("bold", event.target.checked),
            });
            this.cropButton = h(
                "button",
                { type: "button", class: "o_paint_button o_paint_primary", onclick: () => this.applyCrop() },
                "Crop"
            );
            this.optionGroups = {
                size: group("Size", this.sizeInput, this.sizeValue),
                style: h(
                    "div",
                    { class: "o_paint_group" },
                    h("div", { class: "o_paint_segmented", role: "group", "aria-label": "Shape style" }, Object.values(this.styleButtons))
                ),
                tolerance: group("Tolerance", this.toleranceInput, this.toleranceValue),
                font: h(
                    "div",
                    { class: "o_paint_group" },
                    group("Font size", this.fontSizeInput),
                    group("Bold", this.boldInput),
                    h("span", { class: "o_paint_hint" }, "Click to place the text, Enter to finish.")
                ),
                eyedropper: h("span", { class: "o_paint_hint" }, "Click the image to take its color."),
                crop: h(
                    "div",
                    { class: "o_paint_group" },
                    h("span", { class: "o_paint_hint" }, "Drag over the area to keep."),
                    this.cropButton
                ),
            };
            this.colorGroup = h(
                "div",
                { class: "o_paint_group" },
                this.colorInput,
                h("div", { class: "o_paint_palette" }, swatches)
            );
            const options = h("div", { class: "o_paint_options" }, this.colorGroup, Object.values(this.optionGroups));

            this.stage = h("div", { class: "o_paint_stage" }, h("div", { class: "o_paint_loading" }, "Loading the image…"));
            this.overlay = h("canvas", { class: "o_paint_overlay", "aria-hidden": "true" });
            this.overlayCtx = this.overlay.getContext("2d");
            const frame = h("div", { class: "o_paint_frame" }, this.stage, this.overlay);

            this.status = h("span", { class: "o_paint_status" });
            this.message = h("span", { class: "o_paint_message", role: "status", "aria-live": "polite" });
            this.revertButton = h(
                "button",
                {
                    type: "button",
                    class: "o_paint_button",
                    title: "Put back in Odoo the image the field had when you opened the editor",
                    onclick: () => this.revert(),
                },
                "Revert"
            );
            this.closeButton = h("button", { type: "button", class: "o_paint_button", onclick: () => this.close() }, "Close");
            this.saveButton = h(
                "button",
                { type: "button", class: "o_paint_button o_paint_primary", title: "Save to Odoo (Ctrl+S)", onclick: () => this.save() },
                "Save to Odoo"
            );
            const footer = h(
                "footer",
                { class: "o_paint_footer" },
                this.status,
                this.message,
                this.revertButton,
                this.closeButton,
                this.saveButton
            );

            this.dialogLayer = h("div", { class: "o_paint_dialog_layer", hidden: true });
            this.root = h(
                "div",
                {
                    class: "o_paint_editor",
                    role: "dialog",
                    "aria-modal": "true",
                    "aria-label": "Image editor",
                    tabindex: "-1",
                    onkeydown: (event) => this.onKey(event),
                },
                header,
                toolbar,
                options,
                frame,
                footer,
                this.dialogLayer
            );
            const backdrop = h("div", { class: "o_paint_backdrop" }, this.root);
            // Clicking around the editor must not move the focus out of it.
            backdrop.addEventListener("mousedown", (event) => {
                if (event.target === backdrop) {
                    event.preventDefault();
                }
            });
            root.append(backdrop);

            // Keys typed while the focus is somewhere on the page still belong
            // to the editor, not to Odoo's hotkeys.
            this.keyGuard = (event) => {
                if (event.composedPath().includes(this.host)) {
                    return;
                }
                event.stopImmediatePropagation();
                // Only real key presses, not events a page script dispatches.
                if (event.type === "keydown" && event.isTrusted) {
                    this.root.focus();
                    this.onKey(event);
                }
            };
            this.focusGuard = (event) => {
                if (!event.composedPath().includes(this.host)) {
                    this.root.focus();
                }
            };
            for (const type of ["keydown", "keyup", "keypress"]) {
                window.addEventListener(type, this.keyGuard, true);
            }
            window.addEventListener("focusin", this.focusGuard, true);
            this.resizeObserver = new ResizeObserver(() => this.resizeOverlay());
            this.resizeObserver.observe(frame);
            this.refresh();
        }

        mount() {
            this.wrap = ns.h("div", { class: "o_paint_canvas_wrap" }, this.doc.canvas);
            this.wrap.addEventListener("pointerdown", (event) => this.onPointerDown(event));
            this.wrap.addEventListener("pointermove", (event) => this.onPointerMove(event));
            this.wrap.addEventListener("pointerup", (event) => this.onPointerUp(event));
            this.wrap.addEventListener("pointercancel", (event) => this.onPointerUp(event));
            this.wrap.addEventListener("pointerleave", () => {
                if (this.drawing === null) {
                    this.tool.leave?.();
                }
            });
            // Keeps the focus (and the text box's) where it is.
            this.wrap.addEventListener("mousedown", (event) => event.preventDefault());
            this.stage.replaceChildren(this.wrap);
            this.stage.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
            this.stage.addEventListener("scroll", () => this.redrawOverlay());
        }

        destroy() {
            for (const type of ["keydown", "keyup", "keypress"]) {
                window.removeEventListener(type, this.keyGuard, true);
            }
            window.removeEventListener("focusin", this.focusGuard, true);
            this.resizeObserver.disconnect();
            this.host.remove();
            this.onClose();
        }

        // ---------------------------------------------------------------
        // State shown in the UI
        // ---------------------------------------------------------------

        say(text, kind) {
            this.message.textContent = text || "";
            this.message.classList.toggle("o_paint_error", kind === "error");
            this.message.classList.toggle("o_paint_success", kind === "success");
        }

        get formatLabel() {
            const output = FORMAT_NAMES[this.outputMime];
            const source = FORMAT_NAMES[this.original?.mime];
            if (!source) {
                return `new ${output}`;
            }
            return source === output ? output : `${source}, saved as ${output}`;
        }

        refresh() {
            const ready = Boolean(this.doc) && !this.busy;
            for (const [name, button] of Object.entries(this.toolButtons)) {
                button.setAttribute("aria-pressed", String(Boolean(this.doc) && name === this.toolName));
                button.disabled = !ready;
            }
            for (const button of [...this.transformButtons, ...this.zoomButtons]) {
                button.disabled = !ready;
            }
            this.undoButton.disabled = !ready || !this.doc.canUndo;
            this.redoButton.disabled = !ready || !this.doc.canRedo;
            this.saveButton.disabled = !ready || !this.dirty;
            this.revertButton.disabled = !ready || !this.hasSaved;
            this.closeButton.disabled = this.busy;
            this.status.textContent = this.doc ? `${this.doc.width} × ${this.doc.height} px · ${this.formatLabel}` : "";
            this.refreshOptions();
        }

        refreshOptions() {
            const shown = new Set(this.doc ? TOOL_OPTIONS[this.toolName] : []);
            for (const [name, group] of Object.entries(this.optionGroups)) {
                group.hidden = !shown.has(name);
            }
            this.colorGroup.hidden = !this.doc;
            const { color, size, fill, tolerance, fontSize, bold } = this.options;
            this.colorInput.value = color;
            this.sizeInput.value = String(size);
            this.sizeValue.textContent = `${size} px`;
            this.styleButtons.outline.setAttribute("aria-pressed", String(!fill));
            this.styleButtons.filled.setAttribute("aria-pressed", String(fill));
            this.toleranceInput.value = String(tolerance);
            this.toleranceValue.textContent = `${tolerance}%`;
            this.fontSizeInput.value = String(fontSize);
            this.boldInput.checked = bold;
            this.cropButton.disabled = !this.cropRect || this.busy;
            this.styleTextBox();
        }

        setColor(color) {
            this.options.color = color.toLowerCase();
            this.refreshOptions();
        }

        setOption(name, value) {
            this.options[name] = value;
            this.refreshOptions();
        }

        onDocChange() {
            if (this.doc.width !== this.size.width || this.doc.height !== this.size.height) {
                this.size = { width: this.doc.width, height: this.doc.height };
                this.setZoom(Math.min(this.zoom, this.fitZoom()));
            }
            this.refresh();
        }

        // ---------------------------------------------------------------
        // Tools
        // ---------------------------------------------------------------

        useTool(name, { force = false } = {}) {
            if (!this.doc || !this.tools[name] || (name === this.toolName && !force)) {
                return;
            }
            this.finishTool();
            if (this.toolName !== "eyedropper" && this.toolName !== name) {
                this.previousTool = this.toolName;
            }
            this.toolName = name;
            this.wrap.style.cursor = this.tool.cursor;
            this.clearOverlay();
            this.refresh();
        }

        /** Commit or drop whatever the tool has in progress. */
        finishTool() {
            this.drawing = null;
            this.tool?.cancel?.();
        }

        transform(change) {
            if (!this.doc || this.busy) {
                return;
            }
            this.finishTool();
            this.doc.replace(change(this.doc.canvas));
        }

        applyCrop() {
            const rect = this.cropRect;
            if (!rect || this.busy) {
                return;
            }
            this.finishTool();
            this.doc.replace(ns.cropCanvas(this.doc.canvas, rect));
        }

        undo() {
            if (this.doc && !this.busy) {
                this.finishTool();
                this.doc.undo();
            }
        }

        redo() {
            if (this.doc && !this.busy) {
                this.finishTool();
                this.doc.redo();
            }
        }

        /** Called by the text tool: a textarea over the canvas to type into. */
        openTextBox(at, { commit, cancel }) {
            const textarea = ns.h("textarea", { class: "o_paint_text", rows: "1", spellcheck: "false", "aria-label": "Text" });
            textarea.dataset.x = String(at.x);
            textarea.dataset.y = String(at.y);
            textarea.addEventListener("keydown", (event) => {
                // Letters typed here are text, not tool shortcuts.
                event.stopPropagation();
                if (event.key === "Escape") {
                    event.preventDefault();
                    cancel();
                    this.root.focus();
                } else if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    commit();
                    this.root.focus();
                }
            });
            this.wrap.append(textarea);
            this.styleTextBox();
            requestAnimationFrame(() => textarea.focus());
            return textarea;
        }

        styleTextBox() {
            const textarea = this.wrap?.querySelector(".o_paint_text");
            if (!textarea) {
                return;
            }
            const { fontSize, bold, color } = this.options;
            textarea.style.left = `${Number(textarea.dataset.x) * this.zoom}px`;
            textarea.style.top = `${Number(textarea.dataset.y) * this.zoom}px`;
            textarea.style.font = `${bold ? "bold " : ""}${fontSize * this.zoom}px/${ns.LINE_HEIGHT} ${ns.TEXT_FONT}`;
            textarea.style.color = color;
            textarea.style.caretColor = color;
        }

        // ---------------------------------------------------------------
        // Pointer, wheel and keyboard
        // ---------------------------------------------------------------

        toImage(point) {
            const rect = this.doc.canvas.getBoundingClientRect();
            return {
                x: ((point.clientX - rect.left) * this.doc.width) / rect.width,
                y: ((point.clientY - rect.top) * this.doc.height) / rect.height,
            };
        }

        onPointerDown(event) {
            if (event.button !== 0 || this.busy || this.dialogOpen || this.drawing !== null) {
                return;
            }
            event.preventDefault();
            this.wrap.setPointerCapture(event.pointerId);
            this.drawing = event.pointerId;
            this.tool.down(this.toImage(event), event);
        }

        onPointerMove(event) {
            if (this.dialogOpen || (this.drawing !== null && event.pointerId !== this.drawing)) {
                return;
            }
            const coalesced = this.drawing !== null && this.tool.coalesced ? event.getCoalescedEvents?.() || [] : [];
            for (const each of coalesced.length ? coalesced : [event]) {
                this.tool.move?.(this.toImage(each), each);
            }
        }

        onPointerUp(event) {
            if (event.pointerId !== this.drawing) {
                return;
            }
            this.drawing = null;
            this.tool.up?.(this.toImage(event), event);
        }

        onWheel(event) {
            if (!(event.ctrlKey || event.metaKey) || !this.doc) {
                return;
            }
            event.preventDefault();
            this.setZoom(this.zoom * Math.exp(-event.deltaY * 0.002), event);
        }

        onKey(event) {
            if (this.dialogOpen) {
                return;
            }
            const target = event.composedPath()[0];
            const editing = target instanceof HTMLInputElement && target.type === "number";
            if (editing && event.key !== "Escape") {
                return;
            }
            const ctrl = event.ctrlKey || event.metaKey;
            const key = event.key.toLowerCase();
            let handled = true;
            if (ctrl && key === "z") {
                if (event.shiftKey) {
                    this.redo();
                } else {
                    this.undo();
                }
            } else if (ctrl && key === "y") {
                this.redo();
            } else if (ctrl && key === "s") {
                this.save();
            } else if (ctrl || event.altKey) {
                handled = false;
            } else if (key === "escape") {
                this.escape();
            } else if (key === "enter" && this.toolName === "crop" && this.cropRect) {
                this.applyCrop();
            } else if (!this.doc) {
                handled = false;
            } else if (key === "+" || key === "=") {
                this.zoomStep(1);
            } else if (key === "-") {
                this.zoomStep(-1);
            } else if (key === "0") {
                this.setZoom(this.fitZoom());
            } else if (key === "1") {
                this.setZoom(1);
            } else if (key === "[" || key === "]") {
                this.setOption("size", Math.min(100, Math.max(1, this.options.size + (key === "]" ? 1 : -1))));
            } else {
                const tool = TOOLS.find((each) => each.key === key);
                if (tool) {
                    this.useTool(tool.name);
                } else {
                    handled = false;
                }
            }
            if (handled) {
                event.preventDefault();
            }
        }

        escape() {
            if (this.toolName === "crop" && this.cropRect) {
                this.finishTool();
            } else {
                this.close();
            }
        }

        // ---------------------------------------------------------------
        // Zoom and the overlay
        // ---------------------------------------------------------------

        fitZoom() {
            if (!this.doc) {
                return 1;
            }
            const width = Math.max(1, this.stage.clientWidth - STAGE_PADDING);
            const height = Math.max(1, this.stage.clientHeight - STAGE_PADDING);
            const fit = Math.min(width / this.doc.width, height / this.doc.height);
            // Small images grow by whole steps, so their pixels stay square.
            return fit >= 1 ? Math.min(Math.floor(fit), 8) : Math.max(MIN_ZOOM, fit);
        }

        zoomStep(direction) {
            const epsilon = 1e-6;
            const next =
                direction > 0
                    ? ZOOM_STEPS.find((step) => step > this.zoom + epsilon)
                    : ZOOM_STEPS.findLast((step) => step < this.zoom - epsilon);
            this.setZoom(next ?? this.zoom);
        }

        /** @param {{clientX: number, clientY: number}} [anchor] the point that stays put */
        setZoom(zoom, anchor) {
            if (!this.doc) {
                return;
            }
            const stageRect = this.stage.getBoundingClientRect();
            const point = anchor || {
                clientX: stageRect.left + stageRect.width / 2,
                clientY: stageRect.top + stageRect.height / 2,
            };
            const before = this.toImage(point);
            this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
            this.wrap.style.width = `${this.doc.width * this.zoom}px`;
            this.wrap.style.height = `${this.doc.height * this.zoom}px`;
            this.wrap.classList.toggle("o_paint_pixelated", this.zoom >= 2);
            const rect = this.doc.canvas.getBoundingClientRect();
            if (Number.isFinite(before.x) && Number.isFinite(before.y)) {
                this.stage.scrollLeft += rect.left + before.x * this.zoom - point.clientX;
                this.stage.scrollTop += rect.top + before.y * this.zoom - point.clientY;
            }
            this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
            this.styleTextBox();
            this.redrawOverlay();
        }

        resizeOverlay() {
            const ratio = window.devicePixelRatio || 1;
            const frame = this.overlay.parentElement;
            this.overlay.width = Math.max(1, Math.round(frame.clientWidth * ratio));
            this.overlay.height = Math.max(1, Math.round(frame.clientHeight * ratio));
            this.redrawOverlay();
        }

        /**
         * Clear the overlay and set it up to draw in image coordinates. It
         * covers the visible stage at screen resolution, so outlines stay one
         * screen pixel wide at any zoom.
         */
        clearOverlay() {
            const ctx = this.overlayCtx;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
            if (!this.doc) {
                return;
            }
            const frame = this.overlay.getBoundingClientRect();
            const canvas = this.doc.canvas.getBoundingClientRect();
            if (!frame.width || !canvas.width) {
                return;
            }
            const ratio = this.overlay.width / frame.width;
            const scale = (canvas.width / this.doc.width) * ratio;
            ctx.setTransform(scale, 0, 0, scale, (canvas.left - frame.left) * ratio, (canvas.top - frame.top) * ratio);
        }

        redrawOverlay() {
            if (this.tool?.redraw) {
                this.tool.redraw();
            } else {
                this.clearOverlay();
            }
        }

        // ---------------------------------------------------------------
        // Dialogs
        // ---------------------------------------------------------------

        /** @returns {Promise<boolean>} whether the user confirmed */
        dialog({ title, body, confirmLabel, cancelLabel = "Cancel" }) {
            const { h } = ns;
            return new Promise((resolve) => {
                const finish = (confirmed) => {
                    this.dialogLayer.hidden = true;
                    this.dialogLayer.replaceChildren();
                    this.dialogOpen = false;
                    this.root.focus();
                    resolve(confirmed);
                };
                const confirm = h(
                    "button",
                    { type: "button", class: "o_paint_button o_paint_primary", onclick: () => finish(true) },
                    confirmLabel
                );
                const box = h(
                    "div",
                    {
                        class: "o_paint_dialog",
                        role: "alertdialog",
                        "aria-modal": "true",
                        "aria-labelledby": "o_paint_dialog_title",
                        onkeydown: (event) => {
                            if (event.key === "Escape") {
                                // Not also an Escape for the editor behind.
                                event.preventDefault();
                                event.stopPropagation();
                                finish(false);
                            }
                        },
                    },
                    h("h2", { id: "o_paint_dialog_title" }, title),
                    body,
                    h(
                        "div",
                        { class: "o_paint_dialog_buttons" },
                        h("button", { type: "button", class: "o_paint_button", onclick: () => finish(false) }, cancelLabel),
                        confirm
                    )
                );
                this.dialogLayer.replaceChildren(box);
                this.dialogLayer.hidden = false;
                this.dialogOpen = true;
                confirm.focus();
            });
        }

        compare(...items) {
            const { h } = ns;
            return h(
                "div",
                { class: "o_paint_compare" },
                items.map(([caption, canvas]) =>
                    h(
                        "figure",
                        {},
                        h("figcaption", {}, caption),
                        canvas ? thumbnail(canvas) : h("div", { class: "o_paint_empty" }, "Empty")
                    )
                )
            );
        }

        async currentCanvas(base64) {
            try {
                return await decodeBase64(base64);
            } catch {
                return null;
            }
        }

        // ---------------------------------------------------------------
        // Writing to Odoo
        // ---------------------------------------------------------------

        /** Run an Odoo round trip with the UI locked, and report how it went. */
        async run(message, task) {
            this.busy = true;
            this.say(message);
            this.refresh();
            try {
                const result = await task();
                this.say(result?.text, result?.kind);
            } catch (error) {
                this.say(error.message, "error");
            } finally {
                this.busy = false;
                this.refresh();
            }
        }

        async save() {
            if (!this.dirty || this.busy || this.dialogOpen) {
                return;
            }
            this.finishTool();
            const { model, id, field, label, displayName } = this.record;
            await this.run("Checking the image in Odoo…", async () => {
                const current = await this.readCurrent();
                const base64 = await ns.encodeCanvas(this.doc.canvas, this.outputMime);
                this.say("");
                const state = this.doc.state;
                const { h } = ns;
                const warnings = [];
                if (current !== this.odooValue) {
                    warnings.push("Someone changed this image in Odoo after you opened it here. Saving replaces their version.");
                }
                if (this.original.mime === "image/svg+xml") {
                    warnings.push("The original is an SVG drawing. It will be saved as a PNG bitmap.");
                } else if (this.original.mime === "image/gif") {
                    warnings.push("If the original GIF was animated, only its first frame is kept.");
                }
                if (field.endsWith("_1920") && Math.max(this.doc.width, this.doc.height) > MAX_STORED_SIDE) {
                    warnings.push(`Odoo will scale the image down to fit ${MAX_STORED_SIDE} × ${MAX_STORED_SIDE} px.`);
                }
                const confirmed = await this.dialog({
                    title: "Save the image to Odoo?",
                    body: [
                        h("p", {}, `This replaces the ${label} of ${displayName} (${model} #${id}).`),
                        this.compare(["Now in Odoo", await this.currentCanvas(current)], ["New", this.doc.canvas]),
                        warnings.map((text) => h("p", { class: "o_paint_warning" }, text)),
                        h(
                            "p",
                            { class: "o_paint_hint" },
                            "Odoo keeps no copy of the image it holds now. Revert can put the original back only while this editor stays open."
                        ),
                    ],
                    confirmLabel: "Save",
                });
                if (!confirmed) {
                    return null;
                }
                this.say("Saving…");
                await this.rpc.write(model, id, field, base64);
                this.savedState = state;
                this.hasSaved = true;
                this.odooValue = await this.readCurrent();
                ns.refreshImages(this.origin, this.record);
                return { text: "Saved in Odoo.", kind: "success" };
            });
        }

        async revert() {
            if (!this.hasSaved || this.busy || this.dialogOpen) {
                return;
            }
            this.finishTool();
            const { model, id, field } = this.record;
            await this.run("Checking the image in Odoo…", async () => {
                const current = await this.readCurrent();
                this.say("");
                const { h } = ns;
                const confirmed = await this.dialog({
                    title: "Put the original image back?",
                    body: [
                        h("p", {}, "Odoo gets back the image this field had when you opened the editor."),
                        this.compare(
                            ["Now in Odoo", await this.currentCanvas(current)],
                            ["Original", this.original.base64 ? this.originalCanvas : null]
                        ),
                        current !== this.odooValue &&
                            h(
                                "p",
                                { class: "o_paint_warning" },
                                "Someone changed this image in Odoo after your last save. Reverting replaces their version."
                            ),
                    ],
                    confirmLabel: "Revert",
                });
                if (!confirmed) {
                    return null;
                }
                this.say("Reverting…");
                await this.rpc.write(model, id, field, this.original.base64);
                this.hasSaved = false;
                this.doc.replace(this.originalCanvas);
                this.savedState = this.doc.state;
                this.odooValue = await this.readCurrent();
                ns.refreshImages(this.origin, this.record);
                return { text: "The original image is back in Odoo.", kind: "success" };
            });
        }

        async close() {
            if (this.busy || this.dialogOpen) {
                return;
            }
            this.finishTool();
            if (this.dirty) {
                const confirmed = await this.dialog({
                    title: "Discard your changes?",
                    body: ns.h(
                        "p",
                        {},
                        this.hasSaved
                            ? "Your last save stays in Odoo; what you changed since then is lost."
                            : "The image in Odoo stays as it is."
                    ),
                    confirmLabel: "Discard",
                    cancelLabel: "Keep editing",
                });
                if (!confirmed) {
                    return;
                }
            }
            this.destroy();
        }
    }

    ns.Editor = Editor;
})();
