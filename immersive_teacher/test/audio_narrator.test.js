import assert from "node:assert/strict";
import { test } from "node:test";

import { AudioNarrator } from "../client/src/narration/audio_narrator.js";

/** Just enough of the Web Audio API to record what gets scheduled, and when. */
class FakeAudioContext {
    constructor() {
        this.currentTime = 0;
        this.state = "running";
        this.destination = {};
        this.started = [];
    }

    createGain() {
        return { connect() {} };
    }

    createAnalyser() {
        return { connect() {}, fftSize: 0 };
    }

    createBuffer(channels, length, sampleRate) {
        return { duration: length / sampleRate, copyToChannel() {} };
    }

    createBufferSource() {
        const context = this;
        return {
            buffer: null,
            connect() {},
            start(at) {
                context.started.push({ at, duration: this.buffer.duration });
            },
            stop() {},
        };
    }

    resume() {}
}

function setup(options = {}) {
    const context = new FakeAudioContext();
    const started = [];
    let idle = 0;
    const narrator = new AudioNarrator({
        onStepStart: (step) => started.push([step, context.currentTime]),
        onIdle: () => {
            idle += 1;
        },
        createContext: () => context,
        // Ticks are driven by the test through advance().
        scheduler: { start: () => 1, stop() {} },
        ...options,
    });
    narrator.unlock();
    const advance = (seconds) => {
        context.currentTime = Math.round((context.currentTime + seconds) * 1000) / 1000;
        narrator.tick();
    };
    return { context, narrator, started, advance, idleCount: () => idle };
}

const samples = (seconds) => new Int16Array(Math.round(seconds * 24000));

test("sentences play in order even when their speech arrives out of order", () => {
    const { context, narrator, started, advance } = setup();
    narrator.enqueue(1, "uno");
    narrator.enqueue(2, "dos");
    narrator.audioStart(2, 24000);
    narrator.audioChunk(2, samples(1));
    narrator.audioEnd(2);
    advance(0.5);
    assert.deepEqual(started, [], "sentence 2 waits for sentence 1");

    narrator.audioStart(1, 24000);
    narrator.audioChunk(1, samples(1));
    narrator.audioEnd(1);
    advance(0.1);
    assert.deepEqual(started.map(([step]) => step), [1]);
    const [first, second] = context.started;
    assert.ok(Math.abs(second.at - (first.at + 1 + 0.18)) < 1e-9, "sentence 2 follows after a short gap");

    advance(1.2);
    assert.deepEqual(started.map(([step]) => step), [1, 2]);
    assert.ok(started[1][1] >= second.at, "step 2 is announced when its audio starts, not before");
});

test("a sentence waits for a little audio before starting, to avoid stutters", () => {
    const { narrator, started, advance } = setup();
    narrator.enqueue(1, "uno");
    narrator.audioStart(1, 24000);
    narrator.audioChunk(1, samples(0.05));
    advance(0.1);
    assert.deepEqual(started, []);
    narrator.audioChunk(1, samples(0.1));
    advance(0.1);
    assert.deepEqual(started.map(([step]) => step), [1]);
});

test("a sentence without speech keeps its time in silence", () => {
    const { context, narrator, started, advance } = setup();
    const text = "x".repeat(42); // 3 s at 14 characters per second
    narrator.enqueue(1, text);
    narrator.audioEnd(1);
    narrator.enqueue(2, "dos");
    narrator.audioChunk(2, samples(0.5));
    narrator.audioEnd(2);
    advance(0.1);
    assert.deepEqual(started.map(([step]) => step), [1]);
    assert.equal(context.started.length, 1, "only sentence 2 has sound");
    assert.ok(context.started[0].at >= 3, "sentence 2 starts after sentence 1's silent time");
    advance(3.2);
    assert.deepEqual(started.map(([step]) => step), [1, 2]);
});

test("idle comes once, after finish and the last sound", () => {
    const { narrator, advance, idleCount } = setup();
    narrator.enqueue(1, "uno");
    narrator.audioChunk(1, samples(1));
    narrator.audioEnd(1);
    narrator.finish();
    advance(0.5);
    assert.equal(idleCount(), 0, "still playing");
    advance(1);
    assert.equal(idleCount(), 1);
    advance(1);
    assert.equal(idleCount(), 1);
});

test("stop drops everything; late audio of the old turn is ignored", () => {
    const { context, narrator, started, advance } = setup();
    narrator.enqueue(1, "uno");
    narrator.audioChunk(1, samples(1));
    narrator.audioEnd(1);
    advance(0.1);
    narrator.stop();
    const scheduled = context.started.length;
    narrator.audioChunk(1, samples(1));
    advance(2);
    assert.equal(started.length, 1);
    assert.equal(context.started.length, scheduled);
});

test("a sentence without speech is known to be playing silently", () => {
    const { narrator, advance } = setup();
    narrator.enqueue(1, "Una frase que se queda sin voz.");
    narrator.audioEnd(1);
    advance(0.1);
    assert.equal(narrator.speakingSilently(), true);
    advance(3);
    assert.equal(narrator.speakingSilently(), false);
});
