import assert from "node:assert/strict";
import { test } from "node:test";

import { ConversationHistory } from "../server/src/history.js";
import { createFakeLlm } from "../server/src/llm/fake.js";
import { createFakeStt } from "../server/src/speech/stt/fake.js";
import { createFakeTts } from "../server/src/speech/tts/fake.js";
import { runTurn } from "../server/src/turn.js";

const quietLogger = { info() {}, warn() {}, error() {} };
const RECORDING = { audio: Uint8Array.from([1, 2, 3, 4]), mime: "audio/webm;codecs=opus" };

function fastTts() {
    return createFakeTts({ firstChunkMs: 0, speedup: 0, charsPerSecond: 2000 });
}

async function run({ stt = createFakeStt({ delayMs: 0, text: "¿Cómo funciona el ciclo del agua?" }), tts = fastTts(), input = RECORDING, signal } = {}) {
    const events = [];
    const frames = [];
    const history = new ConversationHistory(4);
    const result = await runTurn({
        id: 3,
        input,
        llm: createFakeLlm({ firstTokenMs: 0, chunkMs: 0 }),
        stt,
        tts,
        history,
        emit: (event) => events.push(event),
        emitAudio: (step, pcm) => frames.push({ step, bytes: pcm.length }),
        signal,
        logger: quietLogger,
    });
    return { result, events, frames, history };
}

test("a recorded question is transcribed, answered and spoken sentence by sentence", async () => {
    const { result, events, frames, history } = await run();
    assert.equal(result.status, "done");
    assert.deepEqual(events[0], { type: "transcript", text: "¿Cómo funciona el ciclo del agua?" });

    const sentences = events.filter((e) => e.type === "sentence").map((e) => e.step);
    assert.deepEqual(sentences, [1, 2, 3, 4, 5]);
    for (const step of sentences) {
        const start = events.findIndex((e) => e.type === "audio_start" && e.step === step);
        const end = events.findIndex((e) => e.type === "audio_end" && e.step === step);
        const said = events.findIndex((e) => e.type === "sentence" && e.step === step);
        assert.ok(said < start && start < end, `sentence ${step}: said, then audio starts, then ends`);
        assert.equal(events[end].ok, true);
        assert.ok(frames.some((frame) => frame.step === step), `audio frames for sentence ${step}`);
    }
    assert.equal(events.find((e) => e.type === "audio_start").sampleRate, 24000);

    // done comes after the last sound, and carries the speech timings.
    const done = events.at(-1);
    assert.equal(done.type, "done");
    assert.ok(done.timings.stt >= 0);
    assert.ok(done.timings.tts_first_chunk >= done.timings.first_sentence);
    assert.equal(history.turns[0].question, "¿Cómo funciona el ciclo del agua?");
});

test("a recording with nothing in it ends politely before Claude is asked", async () => {
    let asked = false;
    const stt = { name: "silent", transcribe: async () => ({ text: "  " }) };
    const llm = { name: "x", model: "x", async *stream() { asked = true; } };
    const events = [];
    const result = await runTurn({
        id: 1, input: RECORDING, llm, stt, tts: null, history: new ConversationHistory(4),
        emit: (event) => events.push(event), logger: quietLogger,
    });
    assert.equal(result.code, "empty_transcript");
    assert.equal(asked, false);
    assert.equal(events.at(-1).code, "empty_transcript");
});

test("a transcription failure becomes a clear error", async () => {
    const stt = { name: "down", transcribe: async () => { throw Object.assign(new Error("401"), { code: "stt_auth" }); } };
    const { result, events } = await run({ stt });
    assert.equal(result.code, "stt_auth");
    assert.match(events.at(-1).message, /DEEPGRAM_API_KEY/);
});

test("when speech fails the text goes on, with one warning", async () => {
    const tts = {
        name: "broken",
        sampleRate: 24000,
        async *synthesize() {
            throw Object.assign(new Error("quota"), { code: "tts_rate_limited" });
        },
    };
    const { result, events, frames } = await run({ tts });
    assert.equal(result.status, "done");
    assert.equal(frames.length, 0);
    const warnings = events.filter((e) => e.type === "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /cuota/);
    assert.ok(!warnings[0].message.includes("{voice}"));
    assert.equal(events.filter((e) => e.type === "audio_end" && e.ok === false).length, 5);
    assert.equal(events.filter((e) => e.type === "sentence").length, 5);
});

test("without TTS the turn is text only, as in phase 1", async () => {
    const { events, frames } = await run({ tts: null, input: { text: "fotosíntesis" } });
    assert.equal(frames.length, 0);
    assert.ok(!events.some((e) => e.type.startsWith("audio_")));
    assert.equal(events.at(-1).type, "done");
});

test("cancelling while speech streams stops everything, without done", async () => {
    const controller = new AbortController();
    const tts = createFakeTts({ firstChunkMs: 0, speedup: 1, chunkMs: 20 });
    setTimeout(() => controller.abort(new Error("barge-in")), 80);
    const { result, events } = await run({ tts, signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.ok(!events.some((e) => e.type === "done"));
    assert.ok(!events.some((e) => e.type === "warning"));
});
