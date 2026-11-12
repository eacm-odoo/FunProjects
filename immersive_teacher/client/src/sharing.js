/**
 * Links to shared explorations: "?share=<id>" on this same page opens what
 * someone explored (see the server's shares.js).
 *
 *     shareUrl(id, location)     the link to share `id`
 *     shareIdFrom(value)         the id in ?share=, or null when it is not one
 *     new ShareRequests(conn)    asks the server for a link and waits for its answer
 *
 * Pure logic, no DOM: it runs under node:test.
 */

const SHARE_ID_RE = /^[A-Za-z0-9_-]{12}$/;
/** The server answers in a few milliseconds; past this, something went wrong on the way. */
const SHARE_TIMEOUT_MS = 15000;

export function shareUrl(id, { origin, pathname }) {
    const url = new URL(pathname, origin);
    url.searchParams.set("share", id);
    return url.href;
}

export function shareIdFrom(value) {
    return typeof value === "string" && SHARE_ID_RE.test(value) ? value : null;
}

export class ShareError extends Error {}

/** Each `share` request gets its own number, and its answer (shared, share_error) settles it. */
export class ShareRequests {
    /**
     * @param {{send: (message: object) => boolean}} connection
     * @param {{timeoutMs?: number, timeoutMessage?: () => string}} [options]
     */
    constructor(connection, { timeoutMs = SHARE_TIMEOUT_MS, timeoutMessage = () => "" } = {}) {
        this.connection = connection;
        this.timeoutMs = timeoutMs;
        this.timeoutMessage = timeoutMessage;
        this.count = 0;
        /** @type {Map<number, {resolve: Function, reject: Function, timer: number}>} */
        this.pending = new Map();
    }

    /**
     * Sends `share` with what Exploration.shareOf() returned.
     * @returns {Promise<string>} the share's id; rejects with a ShareError whose message the page shows
     */
    request(payload) {
        const req = ++this.count;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.#settle(req, null, this.timeoutMessage()), this.timeoutMs);
            this.pending.set(req, { resolve, reject, timer });
            if (!this.connection.send({ type: "share", req, ...payload })) {
                this.#settle(req, null, this.timeoutMessage());
            }
        });
    }

    /** The server's `shared` or `share_error` for a request; false when it answers none of them. */
    answer(event) {
        if (!this.pending.has(event.req)) {
            return false;
        }
        this.#settle(event.req, event.type === "shared" ? event.id : null, event.message);
        return true;
    }

    #settle(req, id, message) {
        const waiting = this.pending.get(req);
        if (!waiting) {
            return;
        }
        this.pending.delete(req);
        clearTimeout(waiting.timer);
        if (id) {
            waiting.resolve(id);
        } else {
            waiting.reject(new ShareError(message ?? ""));
        }
    }
}
