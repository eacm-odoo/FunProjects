/**
 * Sources: documents and public pages the teacher answers from.
 *
 * Each connection keeps its own list (SourceList). A source is read once,
 * when it is added: a file arrives from the browser and a URL is downloaded
 * here. Then it becomes a document block that goes at the start of every
 * request, with cache_control on the last one. The documents are the same
 * prefix question after question, so Claude reads them from the cache at a
 * tenth of the price.
 *
 * Limits, from the config: how many sources, the size of each file, and the
 * tokens of all of them together. Tokens are counted with Claude's
 * count_tokens when the source is added, so a document that does not fit is
 * refused right away, not at the first question.
 */

import { SourceError, documentFromBytes, cleanName } from "./documents.js";
import { FetchError, fetchUrl, parsePublicUrl } from "./fetch_url.js";

export { SourceError } from "./documents.js";
export { FetchError } from "./fetch_url.js";

/** Claude takes at most 32 MB per request; base64 PDFs count a third more than the file. */
export const MAX_PAYLOAD_CHARS = 24 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function isSourceId(value) {
    return typeof value === "string" && ID_RE.test(value);
}

function payloadOf(block) {
    return block.source.data.length;
}

export class SourceList {
    /** @param {{maxCount: number, maxTokens: number}} limits */
    constructor({ maxCount, maxTokens }) {
        this.maxCount = maxCount;
        this.maxTokens = maxTokens;
        /** @type {{id: string, kind: string, origin: "file"|"url", name: string, title: string, url: string|null, tokens: number, block: object}[]} */
        this.items = [];
    }

    get tokens() {
        return this.items.reduce((sum, item) => sum + item.tokens, 0);
    }

    get payload() {
        return this.items.reduce((sum, item) => sum + payloadOf(item.block), 0);
    }

    has(id) {
        return this.items.some((item) => item.id === id);
    }

    /** Throws a SourceError when `item` does not fit next to the sources already here. */
    checkFits(item) {
        if (this.items.length >= this.maxCount) {
            throw new SourceError("source_limit", `already ${this.items.length} sources`, { max: this.maxCount });
        }
        if (this.tokens + item.tokens > this.maxTokens) {
            const left = Math.max(0, this.maxTokens - this.tokens);
            throw new SourceError("source_too_long", `${item.tokens} tokens, ${left} left`, {
                name: item.title, tokens: item.tokens, max: this.maxTokens, left,
            });
        }
        if (this.payload + payloadOf(item.block) > MAX_PAYLOAD_CHARS) {
            throw new SourceError("source_total_too_large", "the request would pass 32 MB", {
                max: Math.floor(MAX_PAYLOAD_CHARS * 0.75 / 1024 / 1024),
            });
        }
    }

    add(item) {
        this.checkFits(item);
        this.items.push(item);
    }

    remove(id) {
        const before = this.items.length;
        this.items = this.items.filter((item) => item.id !== id);
        return this.items.length !== before;
    }

    /**
     * The document blocks for a request. The last one carries the cache
     * breakpoint; the stored blocks are left untouched.
     */
    blocks() {
        return this.items.map((item, index) => (
            index === this.items.length - 1 ? { ...item.block, cache_control: { type: "ephemeral" } } : item.block
        ));
    }

    /** What the browser shows for each source. */
    describe() {
        return this.items.map(({ id, kind, origin, name, title, url, tokens }) => ({ id, kind, origin, name, title, url, tokens }));
    }
}

/** The host and the last part of a URL's path: the name of a page without a title. */
function nameOfUrl(url) {
    let last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    try {
        last = decodeURIComponent(last);
    } catch {
        // A stray % in the path: keep it as it is.
    }
    return cleanName(last ? `${url.hostname}/…/${last}` : url.hostname);
}

/**
 * Reads one source into a document, without counting its tokens yet.
 *
 * @param {{file: {name: string, mime: string, data: Buffer}} | {url: string}} input
 * @param {{maxBytes: number, signal?: AbortSignal, isAllowed?: (address: string) => boolean}} options
 */
export async function readSource(input, { maxBytes, signal, isAllowed }) {
    if ("file" in input) {
        const { name, mime, data } = input.file;
        if (data.length > maxBytes) {
            throw new SourceError("source_too_large", `${data.length} bytes`, { name: cleanName(name), max: Math.round(maxBytes / 1024 / 1024) });
        }
        return { origin: "file", name: cleanName(name), url: null, ...documentFromBytes({ data, name, mime }) };
    }
    const url = parsePublicUrl(input.url);
    let page;
    try {
        page = await fetchUrl(url.href, { maxBytes, signal, isAllowed });
    } catch (error) {
        if (error instanceof FetchError && error.code === "url_too_large") {
            throw new SourceError("source_too_large", error.message, { name: nameOfUrl(url), max: Math.round(maxBytes / 1024 / 1024) });
        }
        throw error;
    }
    const finalUrl = new URL(page.url);
    const name = nameOfUrl(finalUrl);
    const document = documentFromBytes({ data: page.body, name, mime: page.contentType, url: page.url });
    return { origin: "url", name, url: page.url, ...document };
}

/**
 * Tokens of one document block, as Claude counts them (a few more than the
 * document alone: the question it is wrapped with).
 */
export async function countSourceTokens(llm, block, signal) {
    return llm.countTokens({
        messages: [{ role: "user", content: [block, { type: "text", text: "?" }] }],
        signal,
    });
}
