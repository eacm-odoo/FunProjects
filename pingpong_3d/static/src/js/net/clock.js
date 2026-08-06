/** @odoo-module **/

import { STEP_H } from "../engine/constants.js";

const STEP_MS = STEP_H * 1000;

/**
 * Maps wall-clock time onto simulation ticks.
 *
 * Both peers derive their tick from the same instant, so their tick counters
 * agree by construction instead of drifting apart. That is what lets a guest
 * index its own history by the tick a host snapshot carries and compare the
 * two directly.
 */
export class MatchClock {
    constructor() {
        this.t0 = 0;          // host wall clock at tick 0
        this.offset = 0;      // add to our clock to get the host's
        this.pausedMs = 0;
        this.running = false;
    }

    /** Anchor tick 0. The host calls this; a guest gets t0 in the start message. */
    start(t0 = Date.now()) {
        this.t0 = t0;
        this.pausedMs = 0;
        this.running = true;
    }

    stop() {
        this.running = false;
    }

    /** The tick that `nowMs` (our clock) corresponds to. */
    tickAt(nowMs = Date.now()) {
        return Math.floor((nowMs + this.offset - this.t0 - this.pausedMs) / STEP_MS);
    }

    /** Our clock reading for a tick, useful when stamping outgoing messages. */
    timeOf(tick) {
        return this.t0 + this.pausedMs + tick * STEP_MS - this.offset;
    }

    /** Shift the anchor so that `tick` maps to now: used after a long stall. */
    anchorTo(tick, nowMs = Date.now()) {
        this.t0 = nowMs + this.offset - this.pausedMs - tick * STEP_MS;
    }

    /** Freeze time; the tick stops advancing until resume(). */
    pauseAt(nowMs = Date.now()) {
        this._pausedSince = nowMs;
    }

    resume(nowMs = Date.now()) {
        if (this._pausedSince) {
            this.pausedMs += nowMs - this._pausedSince;
            this._pausedSince = 0;
        }
    }
}

/**
 * NTP-style offset estimation over the game's own transport.
 *
 * Measuring on the real path matters: an HTTP round trip does not represent an
 * RPC that ends in a `bus.bus` insert and a websocket push.
 */
export class ClockSync {
    /**
     * @param {(payload: object) => void} sendPing
     * @param {object} [options]
     */
    constructor(sendPing, { samples = 7, keepFraction = 3, maxCorrectionMs = 3 } = {}) {
        this.sendPing = sendPing;
        this.samples = [];
        this.maxSamples = samples;
        this.keepFraction = keepFraction;
        this.maxCorrectionMs = maxCorrectionMs;
        this.offset = 0;
        this.rtt = 0;
        this._seq = 0;
        this._settled = false;
    }

    /** Send one probe. */
    ping() {
        this._seq++;
        this.sendPing({ id: this._seq, t0: Date.now() });
    }

    /** The peer echoes {id, t0, t1}; t1 is its clock when it answered. */
    onPong({ t0, t1 }) {
        const t3 = Date.now();
        const rtt = t3 - t0;
        const offset = t1 - (t0 + t3) / 2;
        this.samples.push({ rtt, offset });
        if (this.samples.length > this.maxSamples * 3) {
            this.samples.shift();
        }
        this._recompute();
    }

    _recompute() {
        // Keep the lowest-RTT third: a sample that queued behind something else
        // says more about the queue than about the link.
        const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
        const keep = Math.max(1, Math.floor(sorted.length / this.keepFraction));
        const best = sorted.slice(0, keep);
        const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
        const median = offsets[Math.floor(offsets.length / 2)];
        this.rtt = best[Math.floor(best.length / 2)].rtt;

        if (!this._settled) {
            this.offset = median;
            this._settled = this.samples.length >= this.maxSamples;
            return;
        }
        // Once settled, never jump: a step in the tick target is visible.
        const delta = median - this.offset;
        this.offset += Math.max(-this.maxCorrectionMs, Math.min(this.maxCorrectionMs, delta));
    }

    get halfRtt() {
        return this.rtt / 2;
    }

    get ready() {
        return this._settled;
    }
}
