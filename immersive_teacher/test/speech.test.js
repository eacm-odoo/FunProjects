import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeAudioFrame } from "../client/src/audio/audio_frame.js";
import { ConfigError, loadConfig } from "../server/src/config.js";
import { encodeAudioFrame } from "../server/src/protocol/audio_frame.js";
import { alignPcm16 } from "../server/src/speech/pcm.js";
import { createFakeStt } from "../server/src/speech/stt/fake.js";
import { createFakeTts } from "../server/src/speech/tts/fake.js";
import { TtsQueue } from "../server/src/speech/tts_queue.js";

async function collect(iterable) {
    const out = [];
    for await (const item of iterable) {
        out.push(item);
    }
    return out;
}

test("an audio frame decodes in the browser exactly as it was encoded", () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const frame = encodeAudioFrame(4_000_000_000, 7, new Uint8Array(samples.buffer));
    // The browser receives an ArrayBuffer of exactly the frame's bytes.
    const buffer = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
    const decoded = decodeAudioFrame(buffer);
    assert.equal(decoded.turn, 4_000_000_000);
    assert.equal(decoded.step, 7);
    assert.deepEqual([...decoded.samples], [...samples]);
});

test("PCM chunks are realigned on whole samples", async () => {
    async function* chunks() {
        yield Uint8Array.from([1, 2, 3]);
        yield Uint8Array.from([4]);
        yield Uint8Array.from([5, 6, 7, 8, 9]);
    }
    const out = await collect(alignPcm16(chunks()));
    assert.ok(out.every((chunk) => chunk.length % 2 === 0));
    assert.deepEqual(out.flatMap((chunk) => [...chunk]), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("the fake STT rotates questions and hears nothing in an empty recording", async () => {
    const stt = createFakeStt({ delayMs: 0 });
    const audio = Uint8Array.from([1, 2]);
    const first = await stt.transcribe(audio, {});
    const second = await stt.transcribe(audio, {});
    assert.notEqual(first.text, second.text);
    assert.equal((await stt.transcribe(new Uint8Array(), {})).text, "");
});

test("the fake TTS lasts about as long as reading the sentence aloud", async () => {
    const tts = createFakeTts({ firstChunkMs: 0, speedup: 0 });
    const text = "x".repeat(70); // 70 characters at 14 per second: 5 s
    const chunks = await collect(tts.synthesize(text));
    const samples = chunks.reduce((sum, chunk) => sum + chunk.length / 2, 0);
    assert.equal(samples, 5 * 24000);
    assert.ok(chunks.every((chunk) => chunk.length % 2 === 0));
});

function scriptedTts(plan) {
    // plan[text] = { chunks, failWith, delayMs }
    const calls = [];
    let running = 0;
    let maxRunning = 0;
    return {
        calls,
        get maxRunning() {
            return maxRunning;
        },
        sampleRate: 24000,
        async *synthesize(text, { previousText, signal }) {
            calls.push({ text, previousText });
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            try {
                const { chunks = 1, failWith, delayMs = 5 } = plan[text] ?? {};
                for (let i = 0; i < chunks; i += 1) {
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                    if (signal?.aborted) {
                        throw signal.reason ?? new Error("aborted");
                    }
                    yield Uint8Array.from([i, 0]);
                }
                if (failWith) {
                    throw Object.assign(new Error("boom"), { code: failWith });
                }
            } finally {
                running -= 1;
            }
        },
    };
}

test("the speech queue runs two sentences at a time and passes the previous one", async () => {
    const tts = scriptedTts({ a: { chunks: 3 }, b: { chunks: 3 }, c: { chunks: 1 } });
    const log = [];
    const queue = new TtsQueue({
        tts,
        onStart: (step) => log.push(`start ${step}`),
        onChunk: (step) => log.push(`chunk ${step}`),
        onEnd: (step, ok) => log.push(`end ${step} ${ok}`),
        onError: () => log.push("error"),
    });
    queue.push(1, "a");
    queue.push(2, "b");
    queue.push(3, "c");
    await queue.drain();
    assert.equal(tts.maxRunning, 2);
    assert.deepEqual(tts.calls, [
        { text: "a", previousText: "" },
        { text: "b", previousText: "a" },
        { text: "c", previousText: "b" },
    ]);
    for (const step of [1, 2, 3]) {
        assert.equal(log.filter((line) => line === `end ${step} true`).length, 1);
        assert.ok(log.indexOf(`start ${step}`) < log.indexOf(`end ${step} true`));
    }
});

test("a failed sentence is reported and ends, the others go on", async () => {
    const tts = scriptedTts({ a: { failWith: "tts_bad_request" }, b: {} });
    const ends = [];
    const errors = [];
    const queue = new TtsQueue({
        tts,
        onStart() {},
        onChunk() {},
        onEnd: (step, ok) => ends.push([step, ok]),
        onError: (step, error) => errors.push([step, error.code]),
    });
    queue.push(1, "a");
    queue.push(2, "b");
    await queue.drain();
    assert.deepEqual(errors, [[1, "tts_bad_request"]]);
    assert.deepEqual(ends.sort(), [[1, false], [2, true]]);
});

test("once the provider refuses the key, voice or payment, later sentences are not sent", async () => {
    for (const code of ["tts_auth", "tts_payment_required"]) {
        const tts = scriptedTts({ a: { chunks: 0, failWith: code, delayMs: 0 }, b: { delayMs: 20 }, c: {}, d: {} });
        const starts = [];
        const ends = [];
        const errors = [];
        const queue = new TtsQueue({
            tts,
            onStart: (step) => starts.push(step),
            onChunk() {},
            onEnd: (step, ok) => ends.push([step, ok]),
            onError: (step, error) => errors.push([step, error.code]),
        });
        for (const [step, text] of [[1, "a"], [2, "b"], [3, "c"], [4, "d"]]) {
            queue.push(step, text);
        }
        await queue.drain();
        // Sentence 2 was already on its way; 3 and 4 never reach the provider.
        assert.deepEqual(tts.calls.map((call) => call.text), ["a", "b"]);
        assert.deepEqual(errors, [[1, code]]);
        // Every step still starts and ends once, so the browser keeps its pace.
        assert.deepEqual(starts.sort(), [1, 2, 3, 4]);
        assert.deepEqual(ends.sort(), [[1, false], [2, true], [3, false], [4, false]]);
    }
});

test("aborting the queue stops quietly, without errors", async () => {
    const controller = new AbortController();
    const tts = scriptedTts({ a: { chunks: 50 } });
    const errors = [];
    const queue = new TtsQueue({
        tts,
        signal: controller.signal,
        onStart() {},
        onChunk() {},
        onEnd() {},
        onError: (step, error) => errors.push(error),
    });
    queue.push(1, "a");
    setTimeout(() => controller.abort(new Error("cancel")), 20);
    await queue.drain();
    assert.deepEqual(errors, []);
});

test("the language comes from TEACHER_LANGUAGE, never from the shell's LANGUAGE", () => {
    const base = { LLM_PROVIDER: "fake", STT_PROVIDER: "fake", TTS_PROVIDER: "none" };
    // Linux shells export LANGUAGE=en_US:en; it must not leak into Deepgram.
    const config = loadConfig({ ...base, LANGUAGE: "en_US:en" }, []);
    assert.equal(config.stt.language, "es");
    assert.equal(config.tts.language, "es");

    const regional = loadConfig({ ...base, TEACHER_LANGUAGE: "es-419" }, []);
    assert.equal(regional.stt.language, "es-419");
    assert.equal(regional.tts.language, "es", "ElevenLabs only takes the bare language");

    for (const bad of ["en_US:en", "spanish", "es_MX"]) {
        assert.throws(() => loadConfig({ ...base, TEACHER_LANGUAGE: bad }, []), /TEACHER_LANGUAGE/);
    }
});

test("Deepgram can be the voice too, with the same key", () => {
    const base = { LLM_PROVIDER: "fake", STT_PROVIDER: "fake", TTS_PROVIDER: "deepgram" };
    assert.throws(() => loadConfig(base, []), /DEEPGRAM_API_KEY/);
    const config = loadConfig({ ...base, DEEPGRAM_API_KEY: "dg" }, []);
    assert.equal(config.tts.apiKey, "dg");
    assert.equal(config.tts.model, "aura-2-estrella-es");
    assert.equal(loadConfig({ ...base, DEEPGRAM_API_KEY: "dg", DEEPGRAM_VOICE: "aura-2-javier-es" }, []).tts.model, "aura-2-javier-es");
});

test("speech providers need their keys, fake and none do not", () => {
    const base = { LLM_PROVIDER: "fake" };
    assert.throws(() => loadConfig({ ...base, TTS_PROVIDER: "none" }, []), ConfigError, "DEEPGRAM_API_KEY");
    assert.throws(
        () => loadConfig({ ...base, STT_PROVIDER: "fake", ELEVENLABS_API_KEY: "k" }, []),
        /ELEVENLABS_VOICE_ID/,
    );
    const config = loadConfig({ ...base, STT_PROVIDER: "fake", TTS_PROVIDER: "none" }, []);
    assert.equal(config.stt.provider, "fake");
    assert.equal(config.tts.provider, "none");
    assert.equal(config.tts.sampleRate, 24000);
});
