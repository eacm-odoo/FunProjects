/**
 * Questions per hour, over a sliding window, for the whole server.
 *
 * It is the cost guard: one server is one user, so a process-wide counter is
 * enough. A limit of 0 turns it off.
 */

const HOUR_MS = 60 * 60 * 1000;

export class HourlyLimiter {
    constructor(maxPerHour, now = () => Date.now()) {
        this.maxPerHour = maxPerHour;
        this.now = now;
        this.stamps = [];
    }

    /**
     * Counts one question if there is room.
     * @returns {{ok: true} | {ok: false, retryInSeconds: number}}
     */
    tryAcquire() {
        if (!this.maxPerHour) {
            return { ok: true };
        }
        const now = this.now();
        while (this.stamps.length && now - this.stamps[0] >= HOUR_MS) {
            this.stamps.shift();
        }
        if (this.stamps.length >= this.maxPerHour) {
            return { ok: false, retryInSeconds: Math.ceil((this.stamps[0] + HOUR_MS - now) / 1000) };
        }
        this.stamps.push(now);
        return { ok: true };
    }
}
