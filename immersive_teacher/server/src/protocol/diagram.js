/**
 * Validates the diagram one DRAW line at a time.
 *
 * Each DRAW line is checked on its own: a malformed line, node or edge is
 * dropped with a note in `issues`, and everything else keeps going. The step
 * of every element comes from the caller (the sentence it belongs to), never
 * from Claude.
 */

export const SHAPES = Object.freeze(["sphere", "box", "cylinder", "cone", "capsule"]);
export const PALETTE = Object.freeze([
    "#4C9BE8", "#F5B700", "#3A9D23", "#E8743B", "#9B6ADE", "#2BB3A3", "#E85D75", "#8C99A6",
]);
export const LIMITS = Object.freeze({
    nodes: 12,
    edges: 16,
    idLength: 24,
    label: 28,
    edgeLabel: 20,
    title: 48,
});

const HEX6_RE = /^#[0-9a-f]{6}$/i;
const HEX3_RE = /^#[0-9a-f]{3}$/i;

/** Lowercase, accents removed, anything else becomes "_" (so "Luz solar" -> "luz_solar"). */
export function normalizeId(value) {
    if (typeof value !== "string" && typeof value !== "number") {
        return "";
    }
    return String(value)
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, LIMITS.idLength);
}

export function cleanText(value, maxLength) {
    if (typeof value !== "string") {
        return "";
    }
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function normalizeColor(value) {
    if (typeof value !== "string") {
        return null;
    }
    const color = value.trim();
    if (HEX6_RE.test(color)) {
        return color.toUpperCase();
    }
    if (HEX3_RE.test(color)) {
        const [, r, g, b] = color;
        return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
    }
    return null;
}

/** JSON.parse, retrying on the outermost {...} when the line carries extra text. */
function parseJsonObject(raw) {
    const attempts = [raw];
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start && (start > 0 || end < raw.length - 1)) {
        attempts.push(raw.slice(start, end + 1));
    }
    for (const text of attempts) {
        try {
            const value = JSON.parse(text);
            if (value && typeof value === "object" && !Array.isArray(value)) {
                return value;
            }
        } catch {
            // Try the next form.
        }
    }
    return null;
}

export class DiagramBuilder {
    constructor() {
        /** @type {Map<string, object>} */
        this.nodes = new Map();
        this.edges = [];
        this.edgeKeys = new Set();
    }

    /**
     * Validates one DRAW line and keeps what passes.
     *
     * @param {number} step sentence the elements belong to (1-based)
     * @param {string} raw JSON text of the DRAW line
     * @returns {{nodes: object[], edges: object[], issues: string[]}}
     */
    addStep(step, raw) {
        const accepted = { nodes: [], edges: [], issues: [] };
        const data = parseJsonObject(raw);
        if (!data) {
            accepted.issues.push("not a JSON object");
            return accepted;
        }
        const nodes = Array.isArray(data.nodes) ? data.nodes : [];
        const edges = Array.isArray(data.edges) ? data.edges : [];
        if (data.nodes !== undefined && !Array.isArray(data.nodes)) {
            accepted.issues.push("nodes is not a list");
        }
        if (data.edges !== undefined && !Array.isArray(data.edges)) {
            accepted.issues.push("edges is not a list");
        }

        for (const item of nodes) {
            const result = this.#acceptNode(step, item);
            if (typeof result === "string") {
                accepted.issues.push(result);
            } else {
                accepted.nodes.push(result);
            }
        }
        for (const item of edges) {
            const result = this.#acceptEdge(step, item);
            if (typeof result === "string") {
                accepted.issues.push(result);
            } else {
                accepted.edges.push(result);
            }
        }
        return accepted;
    }

    /** Returns the accepted node, or a string saying why it was dropped. */
    #acceptNode(step, item) {
        if (!item || typeof item !== "object") {
            return "node is not an object";
        }
        const id = normalizeId(item.id);
        if (!id) {
            return `node without a usable id (${JSON.stringify(item.id)})`;
        }
        if (this.nodes.has(id)) {
            return `duplicate node id "${id}"`;
        }
        if (this.nodes.size >= LIMITS.nodes) {
            return `node "${id}" over the limit of ${LIMITS.nodes}`;
        }
        const label = cleanText(item.label, LIMITS.label) || cleanText(String(item.id), LIMITS.label);
        const rawShape = typeof item.shape === "string" ? item.shape.trim().toLowerCase() : "";
        const shape = SHAPES.includes(rawShape) ? rawShape : "box";
        const color = normalizeColor(item.color) ?? PALETTE[this.nodes.size % PALETTE.length];
        const node = { id, label, shape, color, step };
        this.nodes.set(id, node);
        return node;
    }

    /** Returns the accepted edge, or a string saying why it was dropped. */
    #acceptEdge(step, item) {
        if (!item || typeof item !== "object") {
            return "edge is not an object";
        }
        const from = normalizeId(item.from);
        const to = normalizeId(item.to);
        if (!this.nodes.has(from) || !this.nodes.has(to)) {
            return `edge ${from || "?"} -> ${to || "?"} points to a node that does not exist`;
        }
        if (from === to) {
            return `edge ${from} -> ${to} is a loop`;
        }
        const key = `${from}>${to}`;
        if (this.edgeKeys.has(key)) {
            return `duplicate edge ${from} -> ${to}`;
        }
        if (this.edges.length >= LIMITS.edges) {
            return `edge ${from} -> ${to} over the limit of ${LIMITS.edges}`;
        }
        const edge = { from, to, step };
        const label = cleanText(item.label, LIMITS.edgeLabel);
        if (label) {
            edge.label = label;
        }
        this.edges.push(edge);
        this.edgeKeys.add(key);
        return edge;
    }

    /** The whole diagram, or null when no node survived. */
    toJSON(title) {
        if (!this.nodes.size) {
            return null;
        }
        return {
            title: cleanText(title ?? "", LIMITS.title),
            nodes: [...this.nodes.values()],
            edges: [...this.edges],
        };
    }
}
