/** @odoo-module **/

/* Transports.
 *
 * The netcode talks to this interface and nothing else, which is the whole
 * point: the loopback below runs a host and a guest in one page with a latency
 * slider, and that is where netcode bugs are cheap to find. The bus-backed
 * transport slots in behind the same three methods.
 *
 *   send(type, payload)   -- to the peer
 *   onMessage(handler)    -- handler(type, payload)
 *   close()
 */

class BaseTransport {
    constructor() {
        this._handlers = new Set();
    }

    onMessage(handler) {
        this._handlers.add(handler);
        return () => this._handlers.delete(handler);
    }

    _deliver(type, payload) {
        for (const handler of this._handlers) {
            handler(type, payload);
        }
    }

    send() {
        throw new Error("not implemented");
    }

    close() {
        this._handlers.clear();
    }
}

/**
 * Two endpoints wired to each other in the same page, with a link model on top.
 *
 * The defaults are a clean link; give it latency, jitter and loss to reproduce
 * what a real one does. Messages are delivered out of order when jitter says so,
 * on purpose: the receivers have to cope with that anyway.
 */
export class LoopbackLink {
    constructor({ latencyMs = 0, jitterMs = 0, lossRate = 0 } = {}) {
        this.latencyMs = latencyMs;
        this.jitterMs = jitterMs;
        this.lossRate = lossRate;
        this.sent = 0;
        this.dropped = 0;
        this._timers = new Set();
        this.a = new LoopbackTransport(this, "a");
        this.b = new LoopbackTransport(this, "b");
    }

    /** Change the link characteristics while it is running. */
    configure({ latencyMs, jitterMs, lossRate }) {
        if (latencyMs !== undefined) {
            this.latencyMs = latencyMs;
        }
        if (jitterMs !== undefined) {
            this.jitterMs = jitterMs;
        }
        if (lossRate !== undefined) {
            this.lossRate = lossRate;
        }
    }

    _transmit(from, type, payload) {
        this.sent++;
        if (this.lossRate > 0 && Math.random() < this.lossRate) {
            this.dropped++;
            return;
        }
        const target = from === this.a ? this.b : this.a;
        const delay = Math.max(0, this.latencyMs + (Math.random() * 2 - 1) * this.jitterMs);
        // Structured clone by hand: a real link cannot pass object identity, and
        // sharing one would hide bugs where a peer mutates what it "sent".
        const copy = JSON.parse(JSON.stringify(payload));
        const timer = setTimeout(() => {
            this._timers.delete(timer);
            target._deliver(type, copy);
        }, delay);
        this._timers.add(timer);
    }

    close() {
        for (const timer of this._timers) {
            clearTimeout(timer);
        }
        this._timers.clear();
        this.a.close();
        this.b.close();
    }
}

export class LoopbackTransport extends BaseTransport {
    constructor(link, name) {
        super();
        this.link = link;
        this.name = name;
    }

    send(type, payload) {
        this.link._transmit(this, type, payload);
    }
}
