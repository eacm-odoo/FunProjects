/**
 * Shared UI pieces: the styles, the icons, a small element builder, and the
 * shadow-DOM host every overlay lives in, so Odoo's CSS does not reach it
 * and its events do not reach Odoo.
 */
(() => {
    const ns = (globalThis.oImagePaint ??= {});

    // Events that would otherwise bubble out of the overlay into Odoo's
    // handlers: hotkeys, Bootstrap's modal focus trap, dropdowns closing.
    const CONTAINED_EVENTS = [
        "keydown",
        "keyup",
        "keypress",
        "input",
        "change",
        "focusin",
        "focusout",
        "pointerdown",
        "pointerup",
        "mousedown",
        "mouseup",
        "click",
        "dblclick",
        "contextmenu",
        "wheel",
        "touchstart",
        "touchend",
        "paste",
        "copy",
        "cut",
    ];

    const CSS = `
        :host {
            --o-accent: #714b67;
            --o-accent-text: #ffffff;
            --o-text: #1f1f1f;
            --o-muted: #6b6b6b;
            --o-background: #ffffff;
            --o-surface: #f4f2f3;
            --o-stage: #e6e2e5;
            --o-border: #d7d2d5;
            --o-hover: #ebe6e9;
            --o-error: #b42318;
            --o-success: #1e7a46;
            --o-warning: #fff4dc;
            --o-warning-text: #6a4a00;
            color-scheme: light;
        }
        @media (prefers-color-scheme: dark) {
            :host {
                --o-accent: #c193b6;
                --o-accent-text: #1f1a1e;
                --o-text: #ececec;
                --o-muted: #a6a6a6;
                --o-background: #232023;
                --o-surface: #2f2b2e;
                --o-stage: #1a181a;
                --o-border: #4a4448;
                --o-hover: #3a3539;
                --o-error: #ff8a80;
                --o-success: #7fd4a0;
                --o-warning: #3d3220;
                --o-warning-text: #f3d48b;
                color-scheme: dark;
            }
        }
        *, *::before, *::after {
            box-sizing: border-box;
        }
        [hidden] {
            display: none !important;
        }
        button, input, select, textarea {
            font: inherit;
            color: inherit;
        }
        button {
            cursor: pointer;
        }
        button:disabled {
            cursor: default;
            opacity: 0.4;
        }
        :focus-visible {
            outline: 2px solid var(--o-accent);
            outline-offset: 1px;
        }

        .o_paint_icon {
            display: inline-flex;
            width: 20px;
            height: 20px;
        }
        .o_paint_icon svg {
            width: 100%;
            height: 100%;
            fill: none;
            stroke: currentColor;
            stroke-width: 1.8;
            stroke-linecap: round;
            stroke-linejoin: round;
        }

        /* Editor */
        .o_paint_backdrop {
            position: fixed;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
            background: rgba(0, 0, 0, 0.5);
            font: 13px/1.4 system-ui, sans-serif;
            color: var(--o-text);
        }
        .o_paint_editor {
            position: relative;
            display: flex;
            flex-direction: column;
            width: min(1280px, 100%);
            height: 100%;
            overflow: hidden;
            border-radius: 8px;
            background: var(--o-background);
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
            outline: none;
        }
        .o_paint_header {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 12px 10px 16px;
            border-bottom: 1px solid var(--o-border);
        }
        .o_paint_title {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
        }
        .o_paint_title strong {
            font-size: 15px;
        }
        .o_paint_title span {
            margin-left: 8px;
            color: var(--o-muted);
        }
        .o_paint_toolbar,
        .o_paint_options {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 4px;
            padding: 6px 12px;
            border-bottom: 1px solid var(--o-border);
            background: var(--o-surface);
        }
        .o_paint_options {
            gap: 8px 16px;
            min-height: 45px;
            background: var(--o-background);
        }
        .o_paint_separator {
            width: 1px;
            height: 24px;
            margin: 0 6px;
            background: var(--o-border);
        }
        .o_paint_tool {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 34px;
            height: 34px;
            padding: 0;
            border: 1px solid transparent;
            border-radius: 6px;
            background: transparent;
        }
        .o_paint_tool:hover:not(:disabled) {
            background: var(--o-hover);
        }
        .o_paint_tool[aria-pressed="true"] {
            border-color: var(--o-accent);
            background: var(--o-accent);
            color: var(--o-accent-text);
        }
        .o_paint_zoom_label {
            min-width: 56px;
            padding: 4px 6px;
            border: 0;
            border-radius: 6px;
            background: transparent;
            font-variant-numeric: tabular-nums;
        }
        .o_paint_zoom_label:hover {
            background: var(--o-hover);
        }
        .o_paint_group {
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .o_paint_group_label {
            color: var(--o-muted);
        }
        .o_paint_color {
            width: 30px;
            height: 30px;
            padding: 0;
            border: 1px solid var(--o-border);
            border-radius: 6px;
            background: none;
        }
        .o_paint_palette {
            display: inline-grid;
            grid-template-columns: repeat(7, 16px);
            gap: 2px;
        }
        .o_paint_swatch {
            width: 16px;
            height: 14px;
            padding: 0;
            border: 1px solid var(--o-border);
            border-radius: 3px;
        }
        .o_paint_options input[type="range"] {
            width: 120px;
            accent-color: var(--o-accent);
        }
        .o_paint_options input[type="number"] {
            width: 64px;
            padding: 3px 6px;
            border: 1px solid var(--o-border);
            border-radius: 4px;
            background: var(--o-background);
        }
        .o_paint_options input[type="checkbox"] {
            accent-color: var(--o-accent);
        }
        .o_paint_value {
            min-width: 42px;
            color: var(--o-muted);
            font-variant-numeric: tabular-nums;
        }
        .o_paint_segmented {
            display: inline-flex;
            border: 1px solid var(--o-border);
            border-radius: 6px;
            overflow: hidden;
        }
        .o_paint_segmented button {
            padding: 4px 10px;
            border: 0;
            background: transparent;
        }
        .o_paint_segmented button[aria-pressed="true"] {
            background: var(--o-accent);
            color: var(--o-accent-text);
        }
        .o_paint_hint {
            color: var(--o-muted);
        }
        .o_paint_frame {
            position: relative;
            flex: 1;
            min-height: 0;
        }
        .o_paint_stage {
            position: absolute;
            inset: 0;
            display: flex;
            overflow: auto;
            padding: 16px;
            background: var(--o-stage);
            overscroll-behavior: contain;
        }
        .o_paint_canvas_wrap {
            position: relative;
            flex: none;
            margin: auto;
            touch-action: none;
            background-color: #ffffff;
            background-image:
                linear-gradient(45deg, #d6d6d6 25%, transparent 25%),
                linear-gradient(-45deg, #d6d6d6 25%, transparent 25%),
                linear-gradient(45deg, transparent 75%, #d6d6d6 75%),
                linear-gradient(-45deg, transparent 75%, #d6d6d6 75%);
            background-size: 16px 16px;
            background-position: 0 0, 0 8px, 8px -8px, -8px 0;
            box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25);
        }
        .o_paint_canvas_wrap canvas {
            display: block;
            width: 100%;
            height: 100%;
        }
        .o_paint_canvas_wrap.o_paint_pixelated canvas {
            image-rendering: pixelated;
        }
        .o_paint_overlay {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
        }
        .o_paint_text {
            position: absolute;
            min-width: 1ch;
            margin: 0;
            padding: 0;
            border: 0;
            outline: 1px dashed var(--o-accent);
            background: transparent;
            white-space: pre;
            overflow: hidden;
            resize: none;
            field-sizing: content;
        }
        .o_paint_loading {
            margin: auto;
            color: var(--o-muted);
        }
        .o_paint_footer {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px 12px;
            padding: 10px 16px;
            border-top: 1px solid var(--o-border);
        }
        .o_paint_status {
            color: var(--o-muted);
            font-variant-numeric: tabular-nums;
        }
        .o_paint_message {
            flex: 1;
            min-width: 160px;
        }
        .o_paint_message.o_paint_error {
            color: var(--o-error);
        }
        .o_paint_message.o_paint_success {
            color: var(--o-success);
        }
        .o_paint_button {
            padding: 6px 14px;
            border: 1px solid var(--o-border);
            border-radius: 6px;
            background: var(--o-background);
        }
        .o_paint_button:hover:not(:disabled) {
            background: var(--o-hover);
        }
        .o_paint_button.o_paint_primary {
            border-color: var(--o-accent);
            background: var(--o-accent);
            color: var(--o-accent-text);
        }
        .o_paint_button.o_paint_primary:hover:not(:disabled) {
            filter: brightness(1.1);
            background: var(--o-accent);
        }
        .o_paint_close {
            display: inline-flex;
            padding: 6px;
            border: 0;
            border-radius: 6px;
            background: transparent;
        }
        .o_paint_close:hover {
            background: var(--o-hover);
        }

        /* Dialogs inside the editor */
        .o_paint_dialog_layer {
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
            background: rgba(0, 0, 0, 0.4);
        }
        .o_paint_dialog {
            width: min(540px, 100%);
            max-height: 100%;
            overflow: auto;
            padding: 20px;
            border-radius: 8px;
            background: var(--o-background);
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
        }
        .o_paint_dialog h2 {
            margin: 0 0 10px;
            font-size: 16px;
        }
        .o_paint_dialog p {
            margin: 0 0 12px;
        }
        .o_paint_compare {
            display: flex;
            flex-wrap: wrap;
            gap: 16px;
            margin: 4px 0 14px;
        }
        .o_paint_compare figure {
            margin: 0;
        }
        .o_paint_compare figcaption {
            margin-bottom: 4px;
            color: var(--o-muted);
        }
        .o_paint_compare canvas,
        .o_paint_compare .o_paint_empty {
            display: block;
            width: auto;
            max-width: 200px;
            border: 1px solid var(--o-border);
            background-color: #ffffff;
            background-image:
                linear-gradient(45deg, #d6d6d6 25%, transparent 25%),
                linear-gradient(-45deg, #d6d6d6 25%, transparent 25%),
                linear-gradient(45deg, transparent 75%, #d6d6d6 75%),
                linear-gradient(-45deg, transparent 75%, #d6d6d6 75%);
            background-size: 12px 12px;
            background-position: 0 0, 0 6px, 6px -6px, -6px 0;
        }
        .o_paint_compare .o_paint_empty {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 120px;
            height: 120px;
            background: var(--o-surface);
            color: var(--o-muted);
        }
        .o_paint_warning {
            margin: 0 0 12px;
            padding: 8px 10px;
            border-radius: 6px;
            background: var(--o-warning);
            color: var(--o-warning-text);
        }
        .o_paint_dialog_buttons {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 16px;
        }

        /* Picker */
        .o_paint_picker {
            font: 13px/1.4 system-ui, sans-serif;
        }
        .o_paint_target {
            position: fixed;
            border: 2px solid var(--o-accent);
            border-radius: 4px;
            background: rgba(113, 75, 103, 0.14);
            box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.8);
            cursor: pointer;
            pointer-events: auto;
        }
        .o_paint_target:hover {
            background: rgba(113, 75, 103, 0.35);
        }
        .o_paint_target_label {
            position: absolute;
            left: -2px;
            bottom: calc(100% + 2px);
            padding: 1px 6px;
            border-radius: 3px;
            background: var(--o-accent);
            color: var(--o-accent-text);
            white-space: nowrap;
            visibility: hidden;
        }
        .o_paint_target:hover .o_paint_target_label {
            visibility: visible;
        }
        .o_paint_banner,
        .o_paint_toast {
            position: fixed;
            left: 50%;
            display: flex;
            align-items: center;
            gap: 12px;
            max-width: calc(100vw - 32px);
            padding: 8px 8px 8px 16px;
            border-radius: 999px;
            background: #1f1f1f;
            color: #ffffff;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
            font: 13px/1.4 system-ui, sans-serif;
            transform: translateX(-50%);
            pointer-events: auto;
        }
        .o_paint_banner {
            top: 12px;
        }
        .o_paint_banner button {
            padding: 4px 12px;
            border: 0;
            border-radius: 999px;
            background: #ffffff;
            color: #1f1f1f;
        }
        .o_paint_toast {
            bottom: 24px;
            padding: 10px 18px;
        }
    `;

    const ICONS = {
        brush: '<path d="M4 20l1.2-4.6L15.8 4.8a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z"/><path d="M14 6.6l3.4 3.4"/>',
        eraser: '<path d="M9 20h11"/><path d="M5.4 15.6l9.2-9.2a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11.2 20H9.8z"/><path d="M9.4 11.6l5 5"/>',
        line: '<path d="M5 19L19 5"/>',
        rectangle: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
        ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
        fill: '<path d="M4 12l7-7 8 8-7 7z"/><path d="M4 12h15"/><path d="M21.5 18a1.5 1.5 0 0 1-3 0c0-1.2 1.5-3.2 1.5-3.2s1.5 2 1.5 3.2z"/>',
        text: '<path d="M5 7V5h14v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
        eyedropper: '<path d="M13.5 6.5l4 4"/><path d="M15.6 4.4a2.2 2.2 0 0 1 3.1 3.1l-1.9 1.9-3.1-3.1z"/><path d="M14.4 7.6L6 16l-1 3 3-1 8.4-8.4"/>',
        crop: '<path d="M7 3v13a1 1 0 0 0 1 1h13"/><path d="M3 7h13a1 1 0 0 1 1 1v13"/>',
        rotateLeft: '<path d="M4 4v5h5"/><path d="M4.6 9A8 8 0 1 1 6 17.7"/>',
        rotateRight: '<path d="M20 4v5h-5"/><path d="M19.4 9A8 8 0 1 0 18 17.7"/>',
        flipHorizontal: '<path d="M12 3v18"/><path d="M8.5 7.5L3.5 12l5 4.5z"/><path d="M15.5 7.5l5 4.5-5 4.5z"/>',
        flipVertical: '<path d="M3 12h18"/><path d="M7.5 8.5L12 3.5l4.5 5z"/><path d="M7.5 15.5l4.5 5 4.5-5z"/>',
        undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
        redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
        zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/><path d="M11 8v6M8 11h6"/>',
        zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/><path d="M8 11h6"/>',
        fit: '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>',
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
    };

    /**
     * Build an element. Props starting with "on" become listeners, the rest
     * attributes; `false`, `null` and `undefined` are left out, of the props
     * and of the children, which may be nested arrays.
     */
    function h(tag, props = {}, ...children) {
        const el = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value === false || value === null || value === undefined) {
                continue;
            }
            if (key.startsWith("on")) {
                el.addEventListener(key.slice(2), value);
            } else {
                el.setAttribute(key, value === true ? "" : String(value));
            }
        }
        el.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
        return el;
    }

    function icon(name) {
        // Fixed markup from ICONS above, never page data.
        const span = h("span", { class: "o_paint_icon", "aria-hidden": "true" });
        span.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
        return span;
    }

    /**
     * A full-viewport host on top of the page, with a closed shadow root.
     *
     * @param {string} name
     * @param {{passThrough?: boolean}} [options] let clicks reach the page
     *      outside the overlay's own elements
     */
    function createHost(name, { passThrough = false } = {}) {
        const host = document.createElement("div");
        host.setAttribute("data-o-image-paint", name);
        host.style.cssText = [
            "all: initial",
            "position: fixed",
            "inset: 0",
            "z-index: 2147483647",
            `pointer-events: ${passThrough ? "none" : "auto"}`,
        ].join(";");
        const root = host.attachShadow({ mode: "closed" });
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
        for (const type of CONTAINED_EVENTS) {
            host.addEventListener(type, (event) => event.stopPropagation());
        }
        document.documentElement.append(host);
        return { host, root };
    }

    function toast(message) {
        const { host, root } = createHost("toast", { passThrough: true });
        root.append(h("div", { class: "o_paint_toast", role: "status" }, message));
        setTimeout(() => host.remove(), 3500);
    }

    Object.assign(ns, { h, icon, createHost, toast });
})();
