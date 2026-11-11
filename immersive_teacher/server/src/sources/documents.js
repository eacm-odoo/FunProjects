/**
 * Turns what the user gives, a file or the body of a URL, into a document
 * block that Claude reads along with every question:
 *
 *   PDF            sent as is: Claude reads its text and sees its pages
 *   Word (.docx)   its text
 *   HTML           the readable text of the page (see html_text.js)
 *   other text     as is: Markdown, plain text, CSV, JSON, code...
 *
 * The kind comes from the bytes first (a PDF or a ZIP starts the same way
 * whatever its name says), then from the declared type and the name.
 */

import { docxToText, isZip } from "./docx_text.js";
import { htmlToText } from "./html_text.js";

/** Fewer characters than this is not worth reading: a page drawn by JavaScript, or a scan. */
const MIN_TEXT_CHARS = 40;
const MAX_NAME_LENGTH = 120;
const HTML_NAME_RE = /\.(html?|xhtml)$/i;

export class SourceError extends Error {
    /**
     * @param {string} code stable code, translated for the browser by i18n.js
     * @param {string} message detail for the server log
     * @param {object} [values] fills the translated message
     */
    constructor(code, message, values = {}) {
        super(message);
        this.code = code;
        this.values = values;
    }
}

/** A file name fit to show and to give Claude: no folders, no control characters, not too long. */
export function cleanName(name, fallback = "documento") {
    const base = String(name ?? "").split(/[\\/]/).pop().replace(/[\u0000-\u001F\u007F]/g, "").trim();
    const clean = base || fallback;
    return clean.length > MAX_NAME_LENGTH ? `${clean.slice(0, MAX_NAME_LENGTH - 1)}…` : clean;
}

function charsetOf(contentType) {
    return /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? "")?.[1]?.toLowerCase() ?? null;
}

function decoder(label, options) {
    try {
        return new TextDecoder(label, options);
    } catch {
        return new TextDecoder("utf-8", options); // an unknown charset label
    }
}

function looksLikeHtml(data, mime, name) {
    if (/html/i.test(mime) || HTML_NAME_RE.test(name)) {
        return true;
    }
    const start = data.subarray(0, 1024).toString("latin1").trimStart().toLowerCase();
    return start.startsWith("<!doctype html") || start.startsWith("<html") || /^<\?xml[^>]*>\s*<!doctype html/.test(start);
}

/** HTML says its charset in the Content-Type, or in a <meta> near the top. */
function decodeHtml(data, mime) {
    const head = data.subarray(0, 4096).toString("latin1");
    const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
    return decoder(charsetOf(mime) ?? meta ?? "utf-8").decode(data);
}

/** Plain text in the declared charset, or UTF-8; null when the bytes are not text. */
function decodeText(data, mime) {
    const charset = charsetOf(mime);
    let text;
    try {
        text = decoder(charset ?? "utf-8", { fatal: !charset }).decode(data);
    } catch {
        return null;
    }
    return text.includes("\u0000") ? null : text;
}

/** Claude cites the passages it uses (see turn.js), and the page shows where each fact comes from. */
const CITATIONS = Object.freeze({ enabled: true });

function textBlock(text, title, context) {
    return { type: "document", source: { type: "text", media_type: "text/plain", data: text }, title, context, citations: CITATIONS };
}

/**
 * @param {object} input
 * @param {Buffer} input.data the bytes
 * @param {string} input.name file name, or the URL's last part
 * @param {string} [input.mime] declared type: the browser's file type or the Content-Type
 * @param {string} [input.url] where it was downloaded from, for a URL source
 * @returns {{kind: "pdf"|"docx"|"html"|"text", title: string, block: object, chars: number|null}}
 *   chars is null for a PDF, whose text only Claude reads
 */
export function documentFromBytes({ data, name, mime = "", url = null }) {
    const shownName = cleanName(name);
    const context = url ? `Downloaded from ${url}` : `File uploaded by the user: ${shownName}`;
    if (!data.length) {
        throw new SourceError("source_empty", `${shownName} is empty`, { name: shownName });
    }

    if (data.subarray(0, 1024).includes("%PDF-")) {
        const block = {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") },
            title: shownName,
            context,
            citations: CITATIONS,
        };
        return { kind: "pdf", title: shownName, block, chars: null };
    }

    let kind;
    let title = shownName;
    let text;
    if (isZip(data)) {
        text = docxToText(data);
        if (text === null) {
            throw new SourceError("source_unsupported", `${shownName} is a ZIP archive but not a Word document`, { name: shownName });
        }
        kind = "docx";
    } else if (looksLikeHtml(data, mime, shownName)) {
        const page = htmlToText(decodeHtml(data, mime));
        kind = "html";
        title = cleanName(page.title, shownName);
        text = page.text;
    } else {
        const decoded = decodeText(data, mime);
        if (decoded === null) {
            throw new SourceError("source_unsupported", `${shownName} (${mime || "no type"}) is not text`, { name: shownName });
        }
        kind = "text";
        // Spaces inside the lines stay: they are the indentation of code and the columns of tables.
        text = decoded.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
    }

    if (text.replace(/\s+/g, "").length < MIN_TEXT_CHARS) {
        const code = kind === "html" ? "source_empty_page" : "source_empty";
        throw new SourceError(code, `${shownName}: only ${text.length} characters of text`, { name: title });
    }
    return { kind, title, block: textBlock(text, title, context), chars: text.length };
}
