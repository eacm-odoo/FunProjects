/**
 * Splits Claude's streamed answer into items, one per line.
 *
 * The answer format is one item per line, each starting with a marker:
 *
 *     TITLE: short topic title
 *     SAY: one spoken sentence
 *     DRAW: {"nodes":[...],"edges":[...]}
 *
 * Text arrives in arbitrary chunks, so the parser keeps the unfinished tail
 * and only emits complete lines. It is lenient on purpose: markdown bullets or
 * bold around a marker are ignored, and a line with no marker is treated as
 * speech (split into sentences), so a reply that ignores the format still
 * gets spoken, just without a diagram.
 *
 * Now and then an answer slips into tool-call markup instead of the markers:
 *
 *     SAY: Una frase.</parameter>
 *     <parameter name="DRAW">{"nodes":[...]}</parameter>
 *
 * `<parameter name="X">` counts as the marker X (an unmarked item, so the
 * turn's log notes it), and the other tags are dropped: they are never said,
 * and a line carrying a diagram's JSON is never spoken.
 */

const MARKER_RE = /^(TITLE|SAY|DRAW)\s*\**\s*:\s*\**\s*(.*)$/i;
// <parameter name="SAY">, <SAY>: a marker written as a tag.
const TAG_MARKER_RE = /^<\s*(?:(?:parameter|param|field|item)\s+name\s*=\s*["']?)?(TITLE|SAY|DRAW)["']?\s*>\s*(.*)$/i;
// Any other tag, open or closing: </parameter>, <invoke name="x">, </function_calls>.
const TAG_RE = /<\/?[a-z_][\w:.-]*(?:\s[^<>]*)?\/?>/gi;
// Where a diagram's JSON starts in a line that lost its marker.
const DRAW_JSON_RE = /\{\s*"(?:nodes|edges)"\s*:/;
const LEADING_NOISE_RE = /^[\s>*\-#_]+/;
const FENCE_RE = /^`{3,}/;
// Split after . ! ? or an ellipsis when the next word starts a new sentence.
const SENTENCE_SPLIT_RE = /(?<=[.!?…])\s+(?=[¿¡"«(\p{Lu}\p{N}])/u;

export function splitSentences(text) {
    return text
        .split(SENTENCE_SPLIT_RE)
        .map((part) => part.trim())
        .filter(Boolean);
}

function stripInlineMarkdown(text) {
    return text.replace(TAG_RE, " ").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Parses one complete line into zero or more items.
 *
 * @param {string} line
 * @returns {Array<{kind: "title"|"say"|"draw", text: string, marked: boolean}>}
 */
export function parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed || FENCE_RE.test(trimmed)) {
        return [];
    }
    const unbulleted = trimmed.replace(LEADING_NOISE_RE, "");
    const marker = MARKER_RE.exec(unbulleted);
    const match = marker ?? TAG_MARKER_RE.exec(unbulleted);
    if (match) {
        const kind = match[1].toLowerCase();
        const body = match[2].trim();
        // DRAW carries JSON, which must not lose its characters (the diagram
        // reads the outermost {...}, so a closing tag after it does no harm).
        const text = kind === "draw" ? body : stripInlineMarkdown(body);
        return text ? [{ kind, text, marked: Boolean(marker) }] : [];
    }
    // A diagram's JSON that lost its marker; never speak it.
    const json = DRAW_JSON_RE.exec(trimmed);
    if (json || trimmed.startsWith("{")) {
        return [{ kind: "draw", text: trimmed.slice(json?.index ?? 0), marked: false }];
    }
    // No marker: keep it as speech so the answer is still heard (a line of tags only says nothing).
    return splitSentences(stripInlineMarkdown(unbulleted)).map((text) => ({ kind: "say", text, marked: false }));
}

export class LineParser {
    constructor() {
        this.buffer = "";
    }

    /**
     * Feeds a chunk of streamed text and returns the items of every line it
     * completed.
     */
    push(chunk) {
        this.buffer += chunk;
        const items = [];
        let newline = this.buffer.indexOf("\n");
        while (newline !== -1) {
            items.push(...parseLine(this.buffer.slice(0, newline)));
            this.buffer = this.buffer.slice(newline + 1);
            newline = this.buffer.indexOf("\n");
        }
        return items;
    }

    /**
     * Flushes the last line. Call it only when the stream ended normally: a
     * line cut by max_tokens is incomplete and should be dropped instead.
     */
    end() {
        const rest = this.buffer;
        this.buffer = "";
        return parseLine(rest);
    }

    /** Drops the unfinished tail, returning it for logging. */
    discard() {
        const rest = this.buffer;
        this.buffer = "";
        return rest;
    }
}
