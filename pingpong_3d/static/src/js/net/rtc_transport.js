/** @odoo-module **/

/* Peer-to-peer transport, and the wrapper that upgrades to it.
 *
 * Measured on a one-worker Odoo.sh build: the bus delivers a message in ~30 ms
 * when idle and ~380 ms while a match is running, with a healthy client at
 * 59 fps and an HTTP leg of 89 ms. The cost is the delivery itself -- every
 * message is an HTTP request, a row, a COMMIT, a NOTIFY and an ORM query in one
 * cooperative process shared with the whole instance. Cutting the message rate
 * by a third changed nothing.
 *
 * So the data plane leaves the server. The bus keeps what it is good at: a
 * handful of signalling messages while the two browsers find each other.
 */

const CHANNEL_LABEL = "pingpong";
const CONNECT_TIMEOUT_MS = 8000;

/**
 * One RTCDataChannel, dressed as a transport.
 *
 * The channel is unordered and unreliable on purpose. The netcode already
 * discards stale snapshots by sequence number and re-derives the present from
 * whatever arrives, so retransmitting a snapshot that has been superseded would
 * only delay the one that matters.
 */
export class RtcTransport {
    /**
     * @param {object} options
     * @param {(type: string, payload: object) => void} options.signal
     *   sends a signalling message to the peer, over the bus
     * @param {boolean} options.isInitiator the host offers, the guest answers
     * @param {Array} [options.iceServers]
     * @param {(state: string) => void} [options.onState]
     */
    constructor({ signal, isInitiator, iceServers = [], onState = () => {} }) {
        this.signal = signal;
        this.isInitiator = isInitiator;
        this.iceServers = iceServers;
        this.onState = onState;

        this.state = "idle";        // idle | connecting | open | failed | closed
        this.sent = 0;
        this.received = 0;

        this._handlers = new Set();
        this._pc = null;
        this._channel = null;
        this._pendingCandidates = [];
        this._remoteDescribed = false;
        this._timer = null;
    }

    get connected() {
        return this.state === "open" && this._channel && this._channel.readyState === "open";
    }

    // ------------------------------------------------------------ lifecycle

    async connect() {
        if (this.state !== "idle") {
            return;
        }
        this._setState("connecting");
        this._pc = new RTCPeerConnection({ iceServers: this.iceServers });

        this._pc.onicecandidate = (event) => {
            if (!event.candidate) {
                return;                     // end-of-candidates, nothing to send
            }
            this.signal("ice", {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
            });
        };
        this._pc.onconnectionstatechange = () => {
            const pcState = this._pc && this._pc.connectionState;
            if (pcState === "failed" || pcState === "closed") {
                this._setState("failed");
            }
        };
        this._pc.ondatachannel = (event) => this._adoptChannel(event.channel);

        if (this.isInitiator) {
            this._adoptChannel(this._pc.createDataChannel(CHANNEL_LABEL, {
                ordered: false,
                maxRetransmits: 0,
            }));
            const offer = await this._pc.createOffer();
            await this._pc.setLocalDescription(offer);
            this.signal("sdp", { kind: "offer", sdp: offer.sdp });
        }

        // Not connecting is a normal outcome on a hostile network. Give up
        // quietly and let the caller stay on the bus.
        this._timer = setTimeout(() => {
            if (this.state !== "open") {
                this._setState("failed");
            }
        }, CONNECT_TIMEOUT_MS);
    }

    _adoptChannel(channel) {
        this._channel = channel;
        channel.binaryType = "arraybuffer";
        channel.onopen = () => {
            clearTimeout(this._timer);
            this._setState("open");
        };
        channel.onclose = () => {
            if (this.state !== "closed") {
                this._setState("failed");
            }
        };
        channel.onmessage = (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;                     // not ours, or truncated
            }
            if (!message || !message.t) {
                return;
            }
            this.received++;
            for (const handler of this._handlers) {
                handler(message.t, message.p || {});
            }
        };
    }

    // ---------------------------------------------------------- signalling

    /** Fed by the component for every `sdp` and `ice` message from the peer. */
    async handleSignal(type, payload) {
        if (!this._pc) {
            return;
        }
        try {
            if (type === "sdp") {
                await this._pc.setRemoteDescription({
                    type: payload.kind,
                    sdp: payload.sdp,
                });
                this._remoteDescribed = true;
                // Candidates that arrived before the description could not be
                // added yet; they can now.
                for (const candidate of this._pendingCandidates.splice(0)) {
                    await this._pc.addIceCandidate(candidate).catch(() => {});
                }
                if (payload.kind === "offer") {
                    const answer = await this._pc.createAnswer();
                    await this._pc.setLocalDescription(answer);
                    this.signal("sdp", { kind: "answer", sdp: answer.sdp });
                }
                return;
            }
            if (type === "ice" && payload.candidate) {
                const candidate = {
                    candidate: payload.candidate,
                    sdpMid: payload.sdpMid,
                    sdpMLineIndex: payload.sdpMLineIndex,
                };
                if (!this._remoteDescribed) {
                    this._pendingCandidates.push(candidate);
                    return;
                }
                await this._pc.addIceCandidate(candidate).catch(() => {});
            }
        } catch {
            this._setState("failed");
        }
    }

    // ------------------------------------------------------------ transport

    onMessage(handler) {
        this._handlers.add(handler);
        return () => this._handlers.delete(handler);
    }

    send(type, payload) {
        if (!this.connected) {
            return false;
        }
        try {
            this._channel.send(JSON.stringify({ t: type, p: payload }));
            this.sent++;
            return true;
        } catch {
            return false;                   // buffer full or channel gone
        }
    }

    close() {
        clearTimeout(this._timer);
        this._handlers.clear();
        this.state = "closed";
        if (this._channel) {
            this._channel.onmessage = null;
            this._channel.onopen = null;
            this._channel.onclose = null;
            try {
                this._channel.close();
            } catch {
                // already gone
            }
            this._channel = null;
        }
        if (this._pc) {
            this._pc.onicecandidate = null;
            this._pc.ondatachannel = null;
            this._pc.onconnectionstatechange = null;
            try {
                this._pc.close();
            } catch {
                // already gone
            }
            this._pc = null;
        }
    }

    _setState(state) {
        if (this.state === state || this.state === "closed") {
            return;
        }
        this.state = state;
        this.onState(state);
    }
}

/**
 * Plays over the bus, and switches to the peer connection once it opens.
 *
 * The match starts working immediately rather than waiting on a negotiation
 * that may never succeed, and the upgrade is invisible: NetGame holds one
 * transport and never learns which path its messages took. If the peer
 * connection drops mid-match, everything falls back to the bus by itself.
 */
export class HybridTransport {
    /**
     * @param {object} bus a BusTransport
     * @param {RtcTransport} [rtc]
     */
    constructor(bus, rtc = null) {
        this.bus = bus;
        this.rtc = rtc;
        this._handlers = new Set();
        this._offs = [];
        this._listen(bus);
        if (rtc) {
            this._listen(rtc);
        }
    }

    _listen(transport) {
        this._offs.push(transport.onMessage((type, payload) => {
            for (const handler of this._handlers) {
                handler(type, payload);
            }
        }));
    }

    /** Attach a peer connection after the fact, once it has been negotiated. */
    attach(rtc) {
        this.rtc = rtc;
        this._listen(rtc);
    }

    get usingRtc() {
        return Boolean(this.rtc && this.rtc.connected);
    }

    onMessage(handler) {
        this._handlers.add(handler);
        return () => this._handlers.delete(handler);
    }

    send(type, payload) {
        if (this.usingRtc && this.rtc.send(type, payload)) {
            return;
        }
        this.bus.send(type, payload);
    }

    /* The status readings NetGame reports come from the bus leg either way:
       they describe the fallback path, and they are what tells you whether the
       upgrade is worth having. */
    get httpRtt() {
        return this.bus.httpRtt;
    }

    get inFlight() {
        return this.bus.inFlight;
    }

    get superseded() {
        return this.bus.superseded;
    }

    close() {
        for (const off of this._offs) {
            off();
        }
        this._offs = [];
        this._handlers.clear();
        this.bus.close();
        if (this.rtc) {
            this.rtc.close();
        }
    }
}
