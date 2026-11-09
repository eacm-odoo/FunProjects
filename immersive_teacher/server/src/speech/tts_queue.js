/**
 * Turns sentences into speech as they arrive, a couple at a time.
 *
 * A sentence is sent to the provider the moment its line is complete. Up to
 * `concurrency` sentences synthesize in parallel, so sentence 2 is usually
 * ready before sentence 1 finishes playing. Chunks are forwarded as soon as
 * they arrive, tagged with their step; the browser plays the steps in order.
 *
 * When the provider refuses the key, the voice or the payment, every later
 * sentence would fail the same way: those are not sent at all, and end as
 * failed right away, so the turn does not wait on doomed requests.
 */

/** Failures that will repeat for every sentence of the turn. */
const FATAL_CODES = new Set(["tts_auth", "tts_payment_required"]);

export class TtsQueue {
    /**
     * @param {object} options
     * @param {object} options.tts adapter from speech/tts/index.js
     * @param {string} [options.language] the voice's language (see i18n.js)
     * @param {number} [options.concurrency]
     * @param {AbortSignal} [options.signal] aborts every job (cancel, error)
     * @param {(step: number) => void} options.onStart
     * @param {(step: number, pcm: Uint8Array) => void} options.onChunk
     * @param {(step: number, ok: boolean) => void} options.onEnd always called once per step
     * @param {(step: number, error: Error) => void} options.onError
     */
    constructor({ tts, language = "es", concurrency = 2, signal, onStart, onChunk, onEnd, onError }) {
        this.tts = tts;
        this.language = language;
        this.concurrency = concurrency;
        this.signal = signal;
        this.callbacks = { onStart, onChunk, onEnd, onError };
        this.waiting = [];
        this.running = 0;
        this.jobs = [];
        this.previousText = "";
        this.refused = false;
    }

    /** Queues one sentence. */
    push(step, text) {
        this.waiting.push({ step, text, previousText: this.previousText });
        this.previousText = text;
        this.#startNext();
    }

    /** Resolves when every queued sentence has finished, failed or been aborted. */
    async drain() {
        while (this.waiting.length || this.running) {
            await Promise.allSettled(this.jobs);
        }
    }

    #startNext() {
        while (this.running < this.concurrency && this.waiting.length) {
            const job = this.waiting.shift();
            this.running += 1;
            const promise = this.#run(job).finally(() => {
                this.running -= 1;
                this.#startNext();
            });
            this.jobs.push(promise);
        }
    }

    async #run({ step, text, previousText }) {
        const { onStart, onChunk, onEnd, onError } = this.callbacks;
        if (this.signal?.aborted) {
            return;
        }
        onStart(step);
        if (this.refused) {
            onEnd(step, false);
            return;
        }
        try {
            const options = { previousText, language: this.language, signal: this.signal };
            for await (const pcm of this.tts.synthesize(text, options)) {
                onChunk(step, pcm);
            }
            onEnd(step, true);
        } catch (error) {
            if (this.signal?.aborted) {
                return; // the turn is gone: nobody is listening
            }
            if (FATAL_CODES.has(error.code)) {
                this.refused = true;
            }
            onError(step, error);
            onEnd(step, false);
        }
    }
}
