/**
 * WebSocket to the backend, reconnecting on its own.
 *
 * Events from the server are JSON objects with a `type`; `on(type, handler)`
 * subscribes to one type, `on("*", handler)` to all of them. Binary messages
 * carry speech and go to `onBinary` handlers.
 */

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

export class Connection {
    constructor(url = Connection.defaultUrl()) {
        this.url = url;
        this.socket = null;
        this.attempt = 0;
        /** @type {Map<string, Set<Function>>} */
        this.handlers = new Map();
        this.statusHandlers = new Set();
        this.binaryHandlers = new Set();
    }

    static defaultUrl() {
        const scheme = window.location.protocol === "https:" ? "wss" : "ws";
        return `${scheme}://${window.location.host}/ws`;
    }

    get isOpen() {
        return this.socket?.readyState === WebSocket.OPEN;
    }

    connect() {
        this.#setStatus("connecting");
        const socket = new WebSocket(this.url);
        socket.binaryType = "arraybuffer";
        this.socket = socket;
        socket.addEventListener("open", () => {
            this.attempt = 0;
            this.#setStatus("open");
        });
        socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") {
                for (const handler of this.binaryHandlers) {
                    handler(event.data);
                }
                return;
            }
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                console.warn("Server message that is not JSON ignored");
                return;
            }
            this.#dispatch(message);
        });
        socket.addEventListener("close", () => {
            if (this.socket !== socket) {
                return;
            }
            this.#setStatus("closed");
            const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
            this.attempt += 1;
            setTimeout(() => this.connect(), delay);
        });
    }

    /** Sends one JSON message; returns false when the socket is not open. */
    send(message) {
        if (!this.isOpen) {
            return false;
        }
        this.socket.send(JSON.stringify(message));
        return true;
    }

    /** Sends one binary message (a recording); returns false when the socket is not open. */
    sendBinary(data) {
        if (!this.isOpen) {
            return false;
        }
        this.socket.send(data);
        return true;
    }

    /** `handler(arrayBuffer)` for every binary message (speech frames). */
    onBinary(handler) {
        this.binaryHandlers.add(handler);
        return () => this.binaryHandlers.delete(handler);
    }

    on(type, handler) {
        if (!this.handlers.has(type)) {
            this.handlers.set(type, new Set());
        }
        this.handlers.get(type).add(handler);
        return () => this.handlers.get(type).delete(handler);
    }

    /** `handler(status)` with status "connecting" | "open" | "closed". */
    onStatus(handler) {
        this.statusHandlers.add(handler);
        return () => this.statusHandlers.delete(handler);
    }

    #setStatus(status) {
        for (const handler of this.statusHandlers) {
            handler(status);
        }
    }

    #dispatch(message) {
        for (const handler of this.handlers.get(message.type) ?? []) {
            handler(message);
        }
        for (const handler of this.handlers.get("*") ?? []) {
            handler(message);
        }
    }
}
