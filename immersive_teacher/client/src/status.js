/**
 * What the app is doing right now, for everything that shows it: the side
 * panel and the teacher today, the headset's own view later.
 *
 * States: connecting, ready, listening, thinking, explaining, offline.
 */

export class Status {
    constructor(initial = "connecting") {
        this.state = initial;
        /** @type {Set<(state: string) => void>} */
        this.listeners = new Set();
    }

    set(state) {
        if (state === this.state) {
            return;
        }
        this.state = state;
        for (const listener of this.listeners) {
            listener(state);
        }
    }

    /** Calls `listener` now with the current state, then on every change. Returns a remover. */
    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.state);
        return () => this.listeners.delete(listener);
    }
}
