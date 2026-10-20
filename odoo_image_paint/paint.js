/**
 * The image being edited, its undo history, and the drawing tools.
 *
 * Tools draw straight onto the document's canvas and then commit the box
 * they touched; the history keeps the pixels of that box before and after,
 * so a stroke costs its own area, not the whole image. Rotations, flips and
 * crops replace the whole frame.
 */
(() => {
    const ns = (globalThis.oImagePaint ??= {});

    const HISTORY_LIMIT = 60;
    const HISTORY_BUDGET = 256 * 2 ** 20;
    // Shared with the textarea the text tool types into, so both line up.
    const LINE_HEIGHT = 1.2;
    const TEXT_FONT = "Arial, Helvetica, sans-serif";

    class History {
        constructor() {
            this.done = [];
            this.undone = [];
        }
        get top() {
            return this.done.at(-1) ?? null;
        }
        push(entry) {
            this.undone = [];
            this.done.push(entry);
            let bytes = this.done.reduce((sum, item) => sum + item.bytes, 0);
            while (this.done.length > 1 && (this.done.length > HISTORY_LIMIT || bytes > HISTORY_BUDGET)) {
                bytes -= this.done.shift().bytes;
            }
        }
        undo() {
            const entry = this.done.pop();
            if (entry) {
                entry.undo();
                this.undone.push(entry);
            }
            return Boolean(entry);
        }
        redo() {
            const entry = this.undone.pop();
            if (entry) {
                entry.redo();
                this.done.push(entry);
            }
            return Boolean(entry);
        }
    }

    class PaintDocument {
        /** @param {HTMLCanvasElement} source the decoded image */
        constructor(source) {
            this.canvas = ns.createCanvas(source.width, source.height);
            this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
            this.base = ns.createCanvas(source.width, source.height);
            this.baseCtx = this.base.getContext("2d", { willReadFrequently: true });
            this.history = new History();
            this.onChange = () => {};
            this.setFrame(source);
        }
        get width() {
            return this.canvas.width;
        }
        get height() {
            return this.canvas.height;
        }
        /** The current history entry: equal values mean equal pixels. */
        get state() {
            return this.history.top;
        }
        get canUndo() {
            return this.history.done.length > 0;
        }
        get canRedo() {
            return this.history.undone.length > 0;
        }
        setFrame(source) {
            for (const [canvas, ctx] of [
                [this.canvas, this.ctx],
                [this.base, this.baseCtx],
            ]) {
                canvas.width = source.width;
                canvas.height = source.height;
                ctx.drawImage(source, 0, 0);
            }
        }
        /** Record what a tool drew inside `rect` on the canvas. */
        commit(rect) {
            const x = Math.max(0, Math.floor(rect.x));
            const y = Math.max(0, Math.floor(rect.y));
            const width = Math.min(this.width, Math.ceil(rect.x + rect.width)) - x;
            const height = Math.min(this.height, Math.ceil(rect.y + rect.height)) - y;
            if (width <= 0 || height <= 0) {
                return;
            }
            const before = this.baseCtx.getImageData(x, y, width, height);
            const after = this.ctx.getImageData(x, y, width, height);
            this.baseCtx.putImageData(after, x, y);
            const put = (data) => {
                this.ctx.putImageData(data, x, y);
                this.baseCtx.putImageData(data, x, y);
            };
            this.history.push({ undo: () => put(before), redo: () => put(after), bytes: width * height * 8 });
            this.onChange();
        }
        /** Swap in a new whole frame, possibly of another size. */
        replace(canvas) {
            const before = ns.cloneCanvas(this.canvas);
            this.setFrame(canvas);
            this.history.push({
                undo: () => this.setFrame(before),
                redo: () => this.setFrame(canvas),
                bytes: (before.width * before.height + canvas.width * canvas.height) * 4,
            });
            this.onChange();
        }
        undo() {
            if (this.history.undo()) {
                this.onChange();
            }
        }
        redo() {
            if (this.history.redo()) {
                this.onChange();
            }
        }
    }

    function hexToRgba(hex) {
        const value = parseInt(hex.slice(1), 16);
        return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255];
    }

    function rgbToHex(r, g, b) {
        return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    }

    function boxOf(a, b, pad) {
        return {
            x: Math.min(a.x, b.x) - pad,
            y: Math.min(a.y, b.y) - pad,
            width: Math.abs(a.x - b.x) + 2 * pad,
            height: Math.abs(a.y - b.y) + 2 * pad,
        };
    }

    /** Shift keeps lines at multiples of 45° and boxes square. */
    function constrain(start, end, kind, shiftKey) {
        if (!shiftKey) {
            return end;
        }
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        if (kind === "line") {
            const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const length = Math.hypot(dx, dy);
            return {
                x: Math.round(start.x + length * Math.cos(angle)),
                y: Math.round(start.y + length * Math.sin(angle)),
            };
        }
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        return { x: start.x + side * (Math.sign(dx) || 1), y: start.y + side * (Math.sign(dy) || 1) };
    }

    function applyStyle(ctx, options) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = options.size;
        ctx.strokeStyle = options.color;
        ctx.fillStyle = options.color;
    }

    /** The brush outline under the pointer, readable on any background. */
    function drawBrushCursor(editor, p, size) {
        const ctx = editor.overlayCtx;
        editor.clearOverlay();
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(size / 2, 0.5), 0, 2 * Math.PI);
        ctx.lineWidth = 3 / editor.zoom;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
        ctx.stroke();
        ctx.lineWidth = 1 / editor.zoom;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
        ctx.stroke();
        ctx.restore();
    }

    function freehandTool(editor, erase) {
        let last = null;
        let box = null;
        const extend = (p) => {
            box.left = Math.min(box.left, p.x);
            box.top = Math.min(box.top, p.y);
            box.right = Math.max(box.right, p.x);
            box.bottom = Math.max(box.bottom, p.y);
        };
        const finish = () => {
            if (!last) {
                return;
            }
            editor.doc.ctx.restore();
            const pad = editor.options.size / 2 + 2;
            editor.doc.commit({
                x: box.left - pad,
                y: box.top - pad,
                width: box.right - box.left + 2 * pad,
                height: box.bottom - box.top + 2 * pad,
            });
            last = null;
        };
        return {
            cursor: "crosshair",
            coalesced: true,
            down(p) {
                const ctx = editor.doc.ctx;
                ctx.save();
                applyStyle(ctx, editor.options);
                ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
                ctx.beginPath();
                ctx.arc(p.x, p.y, editor.options.size / 2, 0, 2 * Math.PI);
                ctx.fill();
                last = p;
                box = { left: p.x, top: p.y, right: p.x, bottom: p.y };
                drawBrushCursor(editor, p, editor.options.size);
            },
            move(p) {
                if (last) {
                    const ctx = editor.doc.ctx;
                    ctx.beginPath();
                    ctx.moveTo(last.x, last.y);
                    ctx.lineTo(p.x, p.y);
                    ctx.stroke();
                    last = p;
                    extend(p);
                }
                drawBrushCursor(editor, p, editor.options.size);
            },
            up: finish,
            cancel: finish,
            leave() {
                editor.clearOverlay();
            },
        };
    }

    function shapeTool(editor, kind) {
        let start = null;
        const round = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
        const draw = (ctx, a, b) => {
            const { size, fill } = editor.options;
            ctx.save();
            applyStyle(ctx, editor.options);
            ctx.beginPath();
            if (kind === "line") {
                const offset = size % 2 ? 0.5 : 0;
                ctx.moveTo(a.x + offset, a.y + offset);
                ctx.lineTo(b.x + offset, b.y + offset);
                ctx.stroke();
            } else {
                const x = Math.min(a.x, b.x);
                const y = Math.min(a.y, b.y);
                const width = Math.abs(a.x - b.x);
                const height = Math.abs(a.y - b.y);
                if (kind === "rectangle") {
                    ctx.lineJoin = "miter";
                    const offset = !fill && size % 2 ? 0.5 : 0;
                    ctx.rect(x + offset, y + offset, width, height);
                } else {
                    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, 2 * Math.PI);
                }
                if (fill) {
                    ctx.fill();
                } else {
                    ctx.stroke();
                }
            }
            ctx.restore();
        };
        return {
            cursor: "crosshair",
            down(p) {
                start = round(p);
            },
            move(p, event) {
                if (!start) {
                    return;
                }
                editor.clearOverlay();
                draw(editor.overlayCtx, start, constrain(start, round(p), kind, event.shiftKey));
            },
            up(p, event) {
                if (!start) {
                    return;
                }
                const end = constrain(start, round(p), kind, event.shiftKey);
                editor.clearOverlay();
                if (end.x !== start.x || end.y !== start.y) {
                    draw(editor.doc.ctx, start, end);
                    editor.doc.commit(boxOf(start, end, editor.options.size + 2));
                }
                start = null;
            },
            cancel() {
                start = null;
                editor.clearOverlay();
            },
        };
    }

    function fillTool(editor) {
        return {
            cursor: "crosshair",
            down(p) {
                const { doc, options } = editor;
                const imageData = doc.ctx.getImageData(0, 0, doc.width, doc.height);
                const box = ns.floodFill(
                    imageData,
                    Math.floor(p.x),
                    Math.floor(p.y),
                    hexToRgba(options.color),
                    options.tolerance
                );
                if (box) {
                    doc.ctx.putImageData(imageData, 0, 0, box.x, box.y, box.width, box.height);
                    doc.commit(box);
                }
            },
        };
    }

    function eyedropperTool(editor) {
        return {
            cursor: "crosshair",
            down(p) {
                const x = Math.min(editor.doc.width - 1, Math.max(0, Math.floor(p.x)));
                const y = Math.min(editor.doc.height - 1, Math.max(0, Math.floor(p.y)));
                const [r, g, b, a] = editor.doc.ctx.getImageData(x, y, 1, 1).data;
                if (a > 0) {
                    editor.setColor(rgbToHex(r, g, b));
                }
                editor.useTool(editor.previousTool);
            },
        };
    }

    function textTool(editor) {
        let box = null;
        const font = () => {
            const { fontSize, bold } = editor.options;
            return `${bold ? "bold " : ""}${fontSize}px ${TEXT_FONT}`;
        };
        const finish = () => {
            if (!box) {
                return;
            }
            const { textarea, at } = box;
            box = null;
            const lines = textarea.value.split("\n");
            textarea.remove();
            if (!textarea.value.trim()) {
                return;
            }
            const { fontSize, color } = editor.options;
            const ctx = editor.doc.ctx;
            ctx.save();
            ctx.font = font();
            ctx.fillStyle = color;
            ctx.textBaseline = "top";
            // The textarea puts half the leading above each line.
            const leading = ((LINE_HEIGHT - 1) / 2) * fontSize;
            let width = 0;
            lines.forEach((line, i) => {
                ctx.fillText(line, at.x, at.y + i * LINE_HEIGHT * fontSize + leading);
                width = Math.max(width, ctx.measureText(line).width);
            });
            ctx.restore();
            editor.doc.commit({
                x: at.x - fontSize,
                y: at.y - fontSize,
                width: width + 2 * fontSize,
                height: lines.length * LINE_HEIGHT * fontSize + 2 * fontSize,
            });
        };
        const cancel = () => {
            box?.textarea.remove();
            box = null;
        };
        return {
            cursor: "text",
            down(p) {
                if (box) {
                    finish();
                    return;
                }
                const at = { x: Math.round(p.x), y: Math.round(p.y) };
                box = { at, textarea: editor.openTextBox(at, { commit: finish, cancel }) };
            },
            cancel: finish,
            get busy() {
                return Boolean(box);
            },
        };
    }

    function cropTool(editor) {
        let start = null;
        const clamp = (p) => ({
            x: Math.min(editor.doc.width, Math.max(0, Math.round(p.x))),
            y: Math.min(editor.doc.height, Math.max(0, Math.round(p.y))),
        });
        const draw = () => {
            editor.clearOverlay();
            const rect = editor.cropRect;
            if (!rect) {
                return;
            }
            const ctx = editor.overlayCtx;
            ctx.save();
            ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
            ctx.fillRect(0, 0, editor.doc.width, editor.doc.height);
            ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
            ctx.lineWidth = 1 / editor.zoom;
            ctx.setLineDash([4 / editor.zoom, 4 / editor.zoom]);
            ctx.strokeStyle = "#ffffff";
            ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
            ctx.lineDashOffset = 4 / editor.zoom;
            ctx.strokeStyle = "#000000";
            ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
            ctx.restore();
        };
        return {
            cursor: "crosshair",
            down(p) {
                start = clamp(p);
                editor.cropRect = null;
                draw();
            },
            move(p) {
                if (!start) {
                    return;
                }
                const end = clamp(p);
                editor.cropRect = boxOf(start, end, 0);
                draw();
            },
            up() {
                start = null;
                const rect = editor.cropRect;
                if (rect && (rect.width < 1 || rect.height < 1)) {
                    editor.cropRect = null;
                    draw();
                }
                editor.refreshOptions();
            },
            cancel() {
                start = null;
                editor.cropRect = null;
                editor.clearOverlay();
                editor.refreshOptions();
            },
            redraw: draw,
        };
    }

    /** @returns {Object<string, object>} the tools, by name */
    function createTools(editor) {
        return {
            brush: freehandTool(editor, false),
            eraser: freehandTool(editor, true),
            line: shapeTool(editor, "line"),
            rectangle: shapeTool(editor, "rectangle"),
            ellipse: shapeTool(editor, "ellipse"),
            fill: fillTool(editor),
            text: textTool(editor),
            eyedropper: eyedropperTool(editor),
            crop: cropTool(editor),
        };
    }

    Object.assign(ns, { History, PaintDocument, createTools, LINE_HEIGHT, TEXT_FONT });
})();
