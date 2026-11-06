/**
 * Paces the sentences as if they were being spoken, while there is no audio.
 *
 * Phase 2 replaces it with an audio narrator that has the same interface, so
 * the rest of the client does not change:
 *
 *     enqueue(step, text)   a sentence is ready
 *     finish()              no more sentences will come for this turn
 *     stop()                drop everything (new question, cancel)
 *     onStepStart(step)     a sentence starts "playing"
 *     onIdle()              the last sentence ended after finish()
 */

export class TimedNarrator {
    /**
     * @param {object} options
     * @param {(step: number) => void} options.onStepStart
     * @param {() => void} options.onIdle
     * @param {number} [options.charsPerSecond] about 14 for Spanish read aloud
     * @param {number} [options.minSeconds]
     */
    constructor({ onStepStart, onIdle, charsPerSecond = 14, minSeconds = 1.4 }) {
        this.onStepStart = onStepStart;
        this.onIdle = onIdle;
        this.charsPerSecond = charsPerSecond;
        this.minSeconds = minSeconds;
        this.queue = [];
        this.timer = null;
        this.finished = false;
    }

    get busy() {
        return this.timer !== null;
    }

    enqueue(step, text) {
        this.queue.push({ step, text });
        if (!this.busy) {
            this.#next();
        }
    }

    finish() {
        this.finished = true;
        if (!this.busy && !this.queue.length) {
            this.onIdle();
        }
    }

    stop() {
        clearTimeout(this.timer);
        this.timer = null;
        this.queue = [];
        this.finished = false;
    }

    #next() {
        const item = this.queue.shift();
        if (!item) {
            this.timer = null;
            if (this.finished) {
                this.finished = false;
                this.onIdle();
            }
            return;
        }
        this.onStepStart(item.step);
        const seconds = Math.max(this.minSeconds, item.text.length / this.charsPerSecond);
        this.timer = setTimeout(() => this.#next(), seconds * 1000);
    }
}
