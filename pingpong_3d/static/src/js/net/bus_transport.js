/** @odoo-module **/

/* The real transport: peer messages over Odoo's bus.
 *
 * Outbound goes through one relay route, which rebuilds each payload from a
 * whitelist before pushing it to the other player's private inbox. Inbound
 * arrives as `pp_msg` notifications, which the component feeds back in here.
 *
 * `rpc` is injected rather than imported so this file, like the rest of `net/`,
 * stays loadable outside a browser and interchangeable with the loopback link.
 */

/* Types where only the newest message matters, so at most one is ever in flight.
 *
 * This is what keeps latency bounded. A snapshot describes the world *now*; a
 * paddle batch carries its own recent history. Queueing either one behind a
 * slow request makes it arrive stale, which is worse than not arriving at all,
 * and the queue then grows without limit -- the game gets further behind the
 * longer you play. Dropping the superseded message instead means the send rate
 * adapts to whatever the server can absorb, all by itself.
 *
 * Everything else -- hits, claims, points, clock probes -- is an event that
 * happened once and cannot be replaced by a later one, so it always goes.
 */
const COALESCED = new Set(["st", "in"]);

export class BusTransport {
    /**
     * @param {object} options
     * @param {(route: string, params: object) => Promise} options.rpc
     * @param {string} options.playerToken
     * @param {string} [options.url]
     */
    constructor({ rpc, playerToken, url = "/pingpong/online/relay" }) {
        this.rpc = rpc;
        this.playerToken = playerToken;
        this.url = url;
        this.closed = false;

        this.sent = 0;
        this.failed = 0;
        this.superseded = 0;
        this.inFlight = 0;
        this.peakInFlight = 0;

        this._handlers = new Set();
        this._pending = new Map();      // type -> newest payload not yet sent
        this._busy = new Set();         // types with a request outstanding
        /* Round trip of just the HTTP leg. The peer RTT that ClockSync reports
           is two of these plus two bus deliveries, so the gap between the two
           numbers is what the bus costs. */
        this._httpSamples = [];
    }

    /** Median HTTP round trip over the recent window, in ms. */
    get httpRtt() {
        if (!this._httpSamples.length) {
            return 0;
        }
        const sorted = [...this._httpSamples].sort((a, b) => a - b);
        return Math.round(sorted[Math.floor(sorted.length / 2)]);
    }

    onMessage(handler) {
        this._handlers.add(handler);
        return () => this._handlers.delete(handler);
    }

    send(type, payload) {
        if (this.closed) {
            return;
        }
        if (!COALESCED.has(type)) {
            this._post(type, payload);
            return;
        }
        if (this._pending.has(type)) {
            this.superseded++;          // the one we are replacing never went
        }
        this._pending.set(type, payload);
        this._drain(type);
    }

    _drain(type) {
        if (this.closed || this._busy.has(type) || !this._pending.has(type)) {
            return;
        }
        const payload = this._pending.get(type);
        this._pending.delete(type);
        this._busy.add(type);
        this._post(type, payload).then(() => {
            this._busy.delete(type);
            this._drain(type);          // send whatever piled up meanwhile
        });
    }

    _post(type, payload) {
        this.sent++;
        this.inFlight++;
        this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
        const started = performance.now();
        // Fire and forget. A lost message is a lost message: the netcode is
        // built for that, and awaiting each one would serialise the stream
        // behind the slowest round trip.
        return this.rpc(this.url, { player_token: this.playerToken, t: type, p: payload })
            .catch(() => {
                this.failed++;
            })
            .finally(() => {
                this.inFlight--;
                this._httpSamples.push(performance.now() - started);
                if (this._httpSamples.length > 40) {
                    this._httpSamples.shift();
                }
            });
    }

    /** Called by the component for every `pp_msg` notification. */
    receive(message) {
        if (this.closed || !message || !message.t) {
            return;
        }
        for (const handler of this._handlers) {
            handler(message.t, message.p || {});
        }
    }

    close() {
        this.closed = true;
        this._handlers.clear();
        this._pending.clear();
        this._busy.clear();
    }
}
