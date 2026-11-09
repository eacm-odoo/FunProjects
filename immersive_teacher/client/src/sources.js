/**
 * The documents and pages the teacher answers from, on the browser's side.
 *
 * Each source gets an id here and goes to the server, which reads it and
 * answers source_added or source_error (see server/src/session.js). The
 * browser keeps the file or the URL: a new connection is a new session on
 * the server, without sources, so they go again after a reconnect.
 *
 *     addFile(file) / addUrl(url)   null when it went, or why it did not
 *     remove(id)
 *     onChange(fn)                  fn() after any change, to redraw
 */

import { language, t } from "./i18n.js";

function megabytes(bytes) {
    return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);
}

/** The host and path of a URL, to show it until the page's title arrives. */
function shortUrl(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, "");
    } catch {
        return url;
    }
}

export class SourceManager {
    /** @param {import("./net/connection.js").Connection} connection */
    constructor(connection) {
        this.connection = connection;
        this.limits = { maxCount: 0, maxBytes: 0, maxTokens: 0 };
        /**
         * @type {Map<string, {id: string, origin: "file"|"url", name: string, title: string, file: File|null,
         *   url: string|null, state: "loading"|"ready"|"error", kind: string|null, tokens: number, error: string,
         *   sentOn: WebSocket|null}>}
         */
        this.entries = new Map();
        this.listeners = new Set();
        this.counter = 0;
        connection.on("source_added", (event) => this.#onAdded(event));
        connection.on("source_error", (event) => this.#onError(event));
    }

    /** Whether the server takes sources (MAX_SOURCES above 0). */
    get enabled() {
        return this.limits.maxCount > 0;
    }

    get all() {
        return [...this.entries.values()];
    }

    /** The sources the teacher can use now. */
    get ready() {
        return this.all.filter((entry) => entry.state === "ready");
    }

    /** @param {{maxCount: number, maxBytes: number, maxTokens: number}} limits from the server's hello */
    setLimits(limits) {
        this.limits = { ...this.limits, ...limits };
        this.#changed();
    }

    /** @returns {string|null} why the file was not added */
    addFile(file) {
        const problem = this.#problemAdding();
        if (problem) {
            return problem;
        }
        if (file.size > this.limits.maxBytes) {
            return t("sources.tooBig", { name: file.name, size: megabytes(file.size), max: megabytes(this.limits.maxBytes) });
        }
        void this.#send(this.#create("file", file.name, { file }));
        return null;
    }

    /** @returns {string|null} why the URL was not added */
    addUrl(url) {
        const problem = this.#problemAdding();
        if (problem) {
            return problem;
        }
        void this.#send(this.#create("url", shortUrl(url), { url }));
        return null;
    }

    remove(id) {
        if (this.entries.delete(id)) {
            this.connection.send({ type: "source_remove", id });
            this.#changed();
        }
    }

    /** After a (re)connection: the server's new session has no sources, so they all go again. */
    resend() {
        for (const entry of this.entries.values()) {
            if (entry.state !== "error" && entry.sentOn !== this.connection.socket) {
                entry.state = "loading";
                void this.#send(entry);
            }
        }
        this.#changed();
    }

    /** Calls `listener()` after every change; returns the function that stops it. */
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    #problemAdding() {
        const active = this.all.filter((entry) => entry.state !== "error").length;
        return active >= this.limits.maxCount ? t("sources.full", { max: this.limits.maxCount }) : null;
    }

    #create(origin, name, extra) {
        this.counter += 1;
        const entry = {
            id: `s${Date.now().toString(36)}${this.counter}`,
            origin,
            name,
            title: name,
            file: null,
            url: null,
            ...extra,
            state: "loading",
            kind: null,
            tokens: 0,
            error: "",
            sentOn: null,
        };
        this.entries.set(entry.id, entry);
        this.#changed();
        return entry;
    }

    /** Sends one source; when offline it waits for the next connection's resend(). */
    async #send(entry) {
        if (entry.origin === "url") {
            if (this.connection.send({ type: "source_url", id: entry.id, url: entry.url, language: language() })) {
                entry.sentOn = this.connection.socket;
            }
            return;
        }
        let data;
        try {
            data = await entry.file.arrayBuffer();
        } catch (error) {
            // The file changed or went away on disk since it was picked.
            this.#onError({ id: entry.id, message: `${entry.name}: ${error.message}` });
            return;
        }
        if (this.entries.get(entry.id) !== entry) {
            return; // removed while it was being read
        }
        // The announcement and its bytes go together, so nothing gets between them.
        const message = { type: "source_file", id: entry.id, name: entry.file.name, mime: entry.file.type, language: language() };
        if (this.connection.send(message) && this.connection.sendBinary(data)) {
            entry.sentOn = this.connection.socket;
        }
    }

    #onAdded({ id, source }) {
        const entry = this.entries.get(id);
        if (!entry) {
            this.connection.send({ type: "source_remove", id }); // removed while the server read it
            return;
        }
        Object.assign(entry, { state: "ready", kind: source.kind, tokens: source.tokens, title: source.title, error: "" });
        if (source.url) {
            entry.url = source.url;
        }
        this.#changed();
    }

    #onError({ id, message }) {
        const entry = this.entries.get(id);
        if (entry) {
            Object.assign(entry, { state: "error", error: message });
            this.#changed();
        }
    }

    #changed() {
        for (const listener of this.listeners) {
            listener();
        }
    }
}
