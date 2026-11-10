/**
 * Odoo AI: the support assistant of odoo.com/help, asked before Claude when
 * the user turns it on. Its answer comes from Odoo's own documentation; the
 * teacher then explains it out loud, with a diagram.
 *
 * The help page's chat calls one JSON-RPC route, and so does this adapter:
 *
 *     POST /help/generate_text
 *     params  {conversation_history: [{role: "user", parts: [{text}]}, {role: "model", parts}, ...]}
 *     result  {parts: [{text, thoughtSignature}], grounding: [{retrievedContext: {uri, title, text}}]}
 *
 * The history is in Gemini's format. A model turn goes back with its parts as
 * they came, thought signature included, so the follow-up questions keep
 * their context. The text is markdown; the grounding lists the pages of the
 * documentation the answer used.
 *
 * It is an internal route of odoo.com, without a public contract: it can
 * change or start refusing clients that are not its page. Each question costs
 * Odoo a model call, so this is for personal use and demos.
 */

import { setTimeout as sleep } from "node:timers/promises";

export const ODOO_AI_URL = "https://www.odoo.com/help/generate_text";
/** The help page's own limit for one question. */
export const MAX_PROMPT_CHARS = 500;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_LINKS = 8;
const MAX_TITLE_CHARS = 120;
const USER_AGENT = "ImmersiveTeacher/0.1 (asks Odoo AI when its user turns it on)";

export class OdooAiError extends Error {
    /** @param {"odoo_ai_failed"|"odoo_ai_timeout"|"odoo_ai_empty"} code */
    constructor(code, message) {
        super(message);
        this.name = "OdooAiError";
        this.code = code;
    }
}

/** The parts of a model turn worth sending back: their text and Gemini's thought signature. */
function cleanParts(parts) {
    return parts
        .filter((part) => typeof part?.text === "string")
        .map((part) => (typeof part.thoughtSignature === "string"
            ? { text: part.text, thoughtSignature: part.thoughtSignature }
            : { text: part.text }));
}

/** The documentation pages behind an answer: http(s) only, each once. */
function linksOf(grounding) {
    const links = [];
    for (const item of Array.isArray(grounding) ? grounding : []) {
        const { uri, title } = item?.retrievedContext ?? {};
        let url;
        try {
            url = new URL(uri);
        } catch {
            continue;
        }
        if (!["http:", "https:"].includes(url.protocol) || links.some((link) => link.uri === url.href)) {
            continue;
        }
        const name = typeof title === "string" && title.trim() ? title.replace(/\s+/g, " ").trim() : url.hostname;
        links.push({ title: name.slice(0, MAX_TITLE_CHARS), uri: url.href });
        if (links.length === MAX_LINKS) {
            break;
        }
    }
    return links;
}

/** The body of `response` as text, refused past `maxBytes`. */
async function readCapped(response, maxBytes) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        size += value.length;
        if (size > maxBytes) {
            await reader.cancel();
            throw new OdooAiError("odoo_ai_failed", `answer larger than ${maxBytes} bytes`);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/**
 * The previous questions and answers, in Gemini's format, for the follow-ups.
 * Keeps the last `maxTurns` of them, like the history sent to Claude.
 */
export class OdooHistory {
    constructor(maxTurns) {
        this.maxTurns = maxTurns;
        /** @type {{role: "user"|"model", parts: object[]}[][]} one pair per turn */
        this.turns = [];
    }

    get entries() {
        return this.turns.flat();
    }

    /** @param {{role: string, parts: object[]}[]} exchange the question and its answer */
    add(exchange) {
        if (!this.maxTurns) {
            return;
        }
        this.turns.push(exchange);
        this.turns = this.turns.slice(-this.maxTurns);
    }
}

export class OdooAi {
    /**
     * @param {object} [options]
     * @param {string} [options.url]
     * @param {number} [options.timeoutMs] for the whole call, the answer included
     * @param {typeof fetch} [options.fetch]
     */
    constructor({ url = ODOO_AI_URL, timeoutMs = 30_000, fetch = globalThis.fetch } = {}) {
        this.name = "odoo";
        this.url = url;
        this.timeoutMs = timeoutMs;
        this.fetch = fetch;
        this.requests = 0;
    }

    /**
     * @param {string} question cut to MAX_PROMPT_CHARS
     * @param {{history?: object[], signal?: AbortSignal}} [options] `history` from OdooHistory.entries
     * @returns {Promise<{text: string, links: {title: string, uri: string}[], exchange: object[]}>}
     *   `exchange` is the question and the answer, for OdooHistory.add()
     */
    async ask(question, { history = [], signal } = {}) {
        const asked = { role: "user", parts: [{ text: question.slice(0, MAX_PROMPT_CHARS) }] };
        this.requests += 1;
        const body = {
            jsonrpc: "2.0",
            method: "call",
            id: this.requests,
            params: { conversation_history: [...history, asked] },
        };
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

        let raw;
        try {
            const response = await this.fetch(this.url, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
                body: JSON.stringify(body),
                signal: combined,
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new OdooAiError("odoo_ai_failed", `HTTP ${response.status}`);
            }
            raw = await readCapped(response, MAX_RESPONSE_BYTES);
        } catch (error) {
            if (signal?.aborted) {
                throw error; // the turn was cancelled: not an Odoo AI failure
            }
            if (timeout.aborted) {
                throw new OdooAiError("odoo_ai_timeout", `no answer after ${this.timeoutMs / 1000} s`);
            }
            if (error instanceof OdooAiError) {
                throw error;
            }
            // fetch says only "fetch failed"; the reason (ECONNREFUSED, ENOTFOUND...) is in its cause.
            throw new OdooAiError("odoo_ai_failed", `${error.message}: ${error.cause?.code ?? error.cause?.message ?? "no details"}`);
        }

        let payload;
        try {
            payload = JSON.parse(raw);
        } catch {
            throw new OdooAiError("odoo_ai_failed", `the answer is not JSON: ${JSON.stringify(raw.slice(0, 80))}`);
        }
        if (payload?.error) {
            const { message, data } = payload.error;
            throw new OdooAiError("odoo_ai_failed", `JSON-RPC error: ${data?.message ?? message ?? "unknown"}`);
        }
        const parts = Array.isArray(payload?.result?.parts) ? cleanParts(payload.result.parts) : null;
        if (!parts) {
            throw new OdooAiError("odoo_ai_failed", "the answer has no parts");
        }
        const text = parts.map((part) => part.text).join("").trim();
        if (!text) {
            throw new OdooAiError("odoo_ai_empty", "the answer has no text");
        }
        return { text, links: linksOf(payload.result.grounding), exchange: [asked, { role: "model", parts }] };
    }
}

const FAKE_ANSWERS = {
    es: (question) => [
        `Respuesta de prueba de Odoo AI para: "${question}"`,
        "",
        "1. Abre la aplicación **Inventario**.",
        "2. Ve a **Configuración ‣ Ajustes** y activa la opción que necesitas.",
        "3. Guarda y prueba con un producto.",
    ].join("\n"),
    en: (question) => [
        `Odoo AI test answer for: "${question}"`,
        "",
        "1. Open the **Inventory** app.",
        "2. Go to **Configuration ‣ Settings** and turn on the option you need.",
        "3. Save and try it with a product.",
    ].join("\n"),
};

/** A canned answer after a short wait: to try the flow without calling odoo.com. */
export class FakeOdooAi {
    constructor({ delayMs = 800 } = {}) {
        this.name = "fake";
        this.url = "fake";
        this.delayMs = delayMs;
    }

    async ask(question, { signal, language = "es" } = {}) {
        if (this.delayMs) {
            await sleep(this.delayMs, undefined, { signal });
        }
        signal?.throwIfAborted();
        const asked = { role: "user", parts: [{ text: question.slice(0, MAX_PROMPT_CHARS) }] };
        const text = (FAKE_ANSWERS[language] ?? FAKE_ANSWERS.es)(question);
        return {
            text,
            links: [{ title: "Odoo documentation", uri: "https://www.odoo.com/documentation/" }],
            exchange: [asked, { role: "model", parts: [{ text }] }],
        };
    }
}

/** @param {{mode: "on"|"off"|"fake", url: string}} config @returns {OdooAi|FakeOdooAi|null} */
export function createOdooAi({ mode, url }) {
    if (mode === "on") {
        return new OdooAi({ url });
    }
    return mode === "fake" ? new FakeOdooAi() : null;
}
