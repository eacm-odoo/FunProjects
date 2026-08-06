/** @odoo-module **/

import { STEP_H } from "./constants.js";

/**
 * Ring buffer of past simulation states, indexed by absolute tick.
 *
 * Both roles need it, for the same reason from opposite directions: the guest
 * has to know what it predicted at the tick a snapshot describes, and the host
 * has to be able to go back to the tick a guest claims it hit at.
 */
export class StateRing {
    /** @param {number} seconds how far back the buffer reaches */
    constructor(seconds = 1) {
        this.capacity = Math.ceil(seconds / STEP_H);
        this.entries = new Array(this.capacity).fill(null);
        this.newestTick = -1;
    }

    clear() {
        this.entries.fill(null);
        this.newestTick = -1;
    }

    /** Store a state. Must be called once per tick, in order. */
    push(state) {
        this.entries[state.tick % this.capacity] = state;
        this.newestTick = state.tick;
    }

    /** The stored state for that tick, or null if it fell out of the window. */
    get(tick) {
        if (tick < 0 || tick > this.newestTick || tick <= this.newestTick - this.capacity) {
            return null;
        }
        const entry = this.entries[tick % this.capacity];
        return entry && entry.tick === tick ? entry : null;
    }

    /** Oldest tick still reachable. */
    get oldestTick() {
        return Math.max(0, this.newestTick - this.capacity + 1);
    }
}
