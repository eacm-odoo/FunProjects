/**
 * Plays the teacher's voice and tells the rest of the page when each sentence
 * starts, so the diagram step of that sentence appears with it.
 *
 * Same interface as TimedNarrator, plus the audio events:
 *
 *     enqueue(step, text)            a sentence is ready (text is the fallback)
 *     audioStart(step, sampleRate)   its speech starts streaming
 *     audioChunk(step, samples)      16-bit PCM for that sentence
 *     audioEnd(step)                 no more audio for that sentence
 *     finish() / stop()
 *     onStepStart(step) / onIdle()
 *
 * Speech for several sentences may stream at once and out of order; they are
 * played strictly in step order. A sentence starts once it has a little audio
 * buffered (so the network does not cause stutters) or once its stream ended.
 * A sentence whose speech failed is "played" as silence for the time it would
 * take to say it, so the diagram keeps its pace (speakingSilently() tells the
 * teacher to keep moving its mouth through it).
 *
 * Time comes from the AudioContext, which is also what schedules the sound,
 * so the diagram and the voice cannot drift apart.
 */

const DEFAULTS = Object.freeze({
    jitterSeconds: 0.12,
    gapSeconds: 0.18,
    leadSeconds: 0.04,
    charsPerSecond: 14,
    minSilentSeconds: 1.2,
    tickMs: 40,
});

function intervalScheduler(ms) {
    return {
        start: (fn) => setInterval(fn, ms),
        stop: (handle) => clearInterval(handle),
    };
}

export class AudioNarrator {
    /**
     * @param {object} options
     * @param {(step: number) => void} options.onStepStart
     * @param {() => void} options.onIdle
     * @param {() => AudioContext} [options.createContext] for tests
     * @param {{start: Function, stop: Function}} [options.scheduler] for tests
     */
    constructor({ onStepStart, onIdle, createContext, scheduler, ...options }) {
        this.onStepStart = onStepStart;
        this.onIdle = onIdle;
        this.options = { ...DEFAULTS, ...options };
        this.createContext = createContext ?? (() => new AudioContext({ latencyHint: "interactive" }));
        this.scheduler = scheduler ?? intervalScheduler(this.options.tickMs);
        this.context = null;
        this.output = null;
        this.analyser = null;
        this.unlocked = false;
        this.handle = null;
        this.#reset();
    }

    /**
     * Creates or resumes the AudioContext. Call it from a user gesture (a
     * click, a key, the trigger): browsers keep audio muted until then.
     */
    unlock() {
        if (!this.context) {
            this.context = this.createContext();
            this.output = this.context.createGain();
            this.analyser = this.context.createAnalyser();
            // About 21 ms at 48 kHz: long enough for a steady loudness reading.
            this.analyser.fftSize = 1024;
            this.levelSamples = new Float32Array(this.analyser.fftSize);
            this.output.connect(this.analyser);
            this.analyser.connect(this.context.destination);
        }
        if (this.context.state === "suspended") {
            this.context.resume();
        }
        this.unlocked = true;
    }

    get busy() {
        return this.handle !== null;
    }

    /**
     * Loudness of what the speakers play right now (RMS, 0..1), for the
     * teacher's mouth. The analyser sits right before the output, so it
     * follows the sound as heard, not as received.
     */
    level() {
        if (!this.sources.size || !this.analyser?.getFloatTimeDomainData) {
            return 0;
        }
        const samples = this.levelSamples;
        this.analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) {
            sum += samples[i] * samples[i];
        }
        return Math.sqrt(sum / samples.length);
    }

    /** True while a sentence without speech is "playing" in silence. */
    speakingSilently() {
        if (!this.context || !this.silences.length) {
            return false;
        }
        const now = this.context.currentTime;
        while (this.silences.length && this.silences[0].to <= now) {
            this.silences.shift();
        }
        return this.silences.length > 0 && this.silences[0].from <= now;
    }

    enqueue(step, text) {
        this.#step(step).text = text;
        this.#wake();
    }

    audioStart(step, sampleRate) {
        if (step >= this.next) {
            this.#step(step).sampleRate = sampleRate;
        }
    }

    /** @param {Int16Array} samples */
    audioChunk(step, samples) {
        if (step < this.next || !samples.length) {
            return; // that sentence is already over
        }
        const entry = this.#step(step);
        if (entry.ended) {
            return;
        }
        const floats = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i += 1) {
            floats[i] = samples[i] / 32768;
        }
        entry.chunks.push(floats);
        entry.buffered += samples.length / entry.sampleRate;
        entry.hadAudio = true;
        this.#wake();
    }

    /**
     * No more audio for `step`. Whether its speech failed (the server's `ok`)
     * does not matter here: what arrived plays, and a sentence with no audio
     * at all keeps its time in silence.
     */
    audioEnd(step) {
        if (step < this.next) {
            return;
        }
        this.#step(step).ended = true;
        this.#wake();
    }

    finish() {
        this.finished = true;
        this.#wake();
    }

    /** Silences everything at once (new question, barge-in). */
    stop() {
        for (const source of this.sources) {
            try {
                source.stop();
            } catch {
                // Already stopped.
            }
        }
        this.#sleep();
        this.#reset();
    }

    /** One scheduling pass; runs every tickMs while there is work. */
    tick() {
        if (!this.context) {
            return;
        }
        const now = this.context.currentTime;
        this.#schedule(now);
        while (this.announcements.length && this.announcements[0].at <= now + 0.005) {
            this.onStepStart(this.announcements.shift().step);
        }
        const nothingLeft = !this.steps.has(this.next) && !this.announcements.length;
        if (nothingLeft && now >= this.playhead) {
            this.#sleep();
            if (this.finished) {
                this.finished = false;
                this.onIdle();
            }
        }
    }

    #reset() {
        /** @type {Map<number, object>} */
        this.steps = new Map();
        this.next = 1;
        this.playhead = 0;
        this.finished = false;
        this.announcements = [];
        this.sources = new Set();
        /** @type {{from: number, to: number}[]} context times of silent sentences */
        this.silences = [];
    }

    #step(step) {
        if (!this.steps.has(step)) {
            this.steps.set(step, {
                text: undefined,
                sampleRate: 24000,
                chunks: [],
                buffered: 0,
                hadAudio: false,
                ended: false,
                startAt: null,
            });
        }
        return this.steps.get(step);
    }

    #wake() {
        if (!this.busy && this.context) {
            this.handle = this.scheduler.start(() => this.tick());
        }
        this.tick();
    }

    #sleep() {
        if (this.handle !== null) {
            this.scheduler.stop(this.handle);
            this.handle = null;
        }
    }

    #schedule(now) {
        const { jitterSeconds, gapSeconds, leadSeconds, charsPerSecond, minSilentSeconds } = this.options;
        for (;;) {
            const entry = this.steps.get(this.next);
            if (!entry || entry.text === undefined) {
                return; // the next sentence has not arrived yet
            }
            if (entry.startAt === null) {
                if (!entry.ended && entry.buffered < jitterSeconds) {
                    return; // wait for a little audio before starting
                }
                entry.startAt = Math.max(now + leadSeconds, this.playhead);
                this.playhead = entry.startAt;
                this.announcements.push({ step: this.next, at: entry.startAt });
                if (entry.ended && !entry.hadAudio) {
                    // No speech for this sentence: keep its time, in silence.
                    const seconds = Math.max(minSilentSeconds, entry.text.length / charsPerSecond);
                    this.silences.push({ from: entry.startAt, to: entry.startAt + seconds });
                    this.playhead += seconds;
                }
            }
            for (const floats of entry.chunks) {
                this.#play(floats, entry.sampleRate, now);
            }
            entry.chunks = [];
            if (!entry.ended) {
                return; // more audio may come for this sentence
            }
            this.steps.delete(this.next);
            this.playhead += gapSeconds;
            this.next += 1;
        }
    }

    #play(floats, sampleRate, now) {
        if (this.playhead < now) {
            this.playhead = now + 0.02; // the network fell behind: resume a hair later
        }
        const buffer = this.context.createBuffer(1, floats.length, sampleRate);
        buffer.copyToChannel(floats, 0);
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.output);
        source.start(this.playhead);
        source.onended = () => this.sources.delete(source);
        this.sources.add(source);
        this.playhead += buffer.duration;
    }
}
