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
 */

const MARKER_RE = /^(TITLE|SAY|DRAW)\s*\**\s*:\s*\**\s*(.*)$/i;
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
    return text.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
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
    const match = MARKER_RE.exec(unbulleted);
    if (match) {
        const kind = match[1].toLowerCase();
        const body = match[2].trim();
        if (!body) {
            return [];
        }
        // DRAW carries JSON, which must not lose its characters.
        const text = kind === "draw" ? body : stripInlineMarkdown(body);
        return text ? [{ kind, text, marked: true }] : [];
    }
    // A bare JSON object is a DRAW that lost its marker; never speak it.
    if (trimmed.startsWith("{")) {
        return [{ kind: "draw", text: trimmed, marked: false }];
    }
    // No marker: keep it as speech so the answer is still heard.
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
