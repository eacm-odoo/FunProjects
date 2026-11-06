/**
 * The real speech adapters, against a stand-in for fetch: the request each
 * provider receives, how its answer is read, and how its failures are named.
 * No network and no keys needed.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createDeepgramStt } from "../server/src/speech/stt/deepgram.js";
import { createDeepgramTts } from "../server/src/speech/tts/deepgram.js";
import { createElevenLabsTts } from "../server/src/speech/tts/elevenlabs.js";

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

/** Replaces fetch; `respond(url, init)` returns a Response or throws. */
function stubFetch(respond) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: new URL(url), init });
        return respond(new URL(url), init);
    };
    return calls;
}

/** A fetch that only ends when its signal aborts, like a provider that hangs. */
function hangingFetch() {
    globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
}

function streamOf(...chunks) {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(Uint8Array.from(chunk));
            }
            controller.close();
        },
    });
}

async function collect(iterable) {
    const out = [];
    for await (const item of iterable) {
        out.push(item);
    }
    return out;
}

const DEEPGRAM = { apiKey: "dg-key", model: "nova-3", language: "es" };
const ELEVENLABS = { apiKey: "el-key", voiceId: "voice/1", model: "eleven_flash_v2_5", language: "es", sampleRate: 24000 };

test("Deepgram gets the recording as is, with model, language and token", async () => {
    const calls = stubFetch(() => Response.json({
        results: { channels: [{ alternatives: [{ transcript: "  ¿Qué es un átomo?  " }] }] },
    }));
    const audio = Uint8Array.from([26, 69, 223, 163]);
    const result = await createDeepgramStt(DEEPGRAM).transcribe(audio, { mime: "audio/webm;codecs=opus" });
    assert.equal(result.text, "¿Qué es un átomo?");
    const [{ url, init }] = calls;
    assert.equal(url.origin + url.pathname, "https://api.deepgram.com/v1/listen");
    assert.equal(url.searchParams.get("model"), "nova-3");
    assert.equal(url.searchParams.get("language"), "es");
    assert.equal(url.searchParams.get("smart_format"), "true");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Token dg-key");
    assert.equal(init.headers["Content-Type"], "audio/webm");
    assert.equal(init.body, audio);
});

test("Deepgram failures get codes the browser explains", async () => {
    const stt = createDeepgramStt(DEEPGRAM, { deadlineMs: 50 });
    const audio = Uint8Array.from([1]);
    const cases = [
        [() => new Response("bad key", { status: 401 }), "stt_auth"],
        [() => new Response("no credit", { status: 402 }), "stt_payment_required"],
        [() => new Response("slow down", { status: 429 }), "stt_rate_limited"],
        [() => new Response("cannot decode", { status: 400 }), "stt_bad_request"],
        [() => new Response("oops", { status: 503 }), "stt_unavailable"],
        [() => { throw new TypeError("fetch failed"); }, "stt_network"],
    ];
    for (const [respond, code] of cases) {
        stubFetch(respond);
        await assert.rejects(stt.transcribe(audio, { mime: "audio/webm" }), { code });
    }
    hangingFetch();
    await assert.rejects(stt.transcribe(audio, { mime: "audio/webm" }), { code: "stt_timeout" });
});

test("ElevenLabs gets one sentence with the previous one, and returns aligned PCM", async () => {
    const calls = stubFetch(() => new Response(streamOf([1, 2, 3], [4, 5], [6, 7, 8, 9])));
    const tts = createElevenLabsTts(ELEVENLABS);
    const chunks = await collect(tts.synthesize("Segunda frase.", { previousText: "Primera frase." }));
    assert.ok(chunks.every((chunk) => chunk.length % 2 === 0));
    assert.deepEqual(chunks.flatMap((chunk) => [...chunk]), [1, 2, 3, 4, 5, 6, 7, 8]);

    const [{ url, init }] = calls;
    assert.equal(url.pathname, "/v1/text-to-speech/voice%2F1/stream");
    assert.equal(url.searchParams.get("output_format"), "pcm_24000");
    assert.equal(init.headers["xi-api-key"], "el-key");
    assert.deepEqual(JSON.parse(init.body), {
        text: "Segunda frase.",
        model_id: "eleven_flash_v2_5",
        language_code: "es",
        previous_text: "Primera frase.",
    });
});

test("ElevenLabs failures get codes, and a cancel is not reported as a failure", async () => {
    const tts = createElevenLabsTts(ELEVENLABS, { deadlineMs: 50 });
    stubFetch(() => new Response("invalid voice", { status: 401 }));
    await assert.rejects(collect(tts.synthesize("Hola.")), { code: "tts_auth" });
    stubFetch(() => new Response('{"detail":{"code":"paid_plan_required"}}', { status: 402 }));
    await assert.rejects(collect(tts.synthesize("Hola.")), { code: "tts_payment_required" });
    stubFetch(() => new Response("quota exceeded", { status: 429 }));
    await assert.rejects(collect(tts.synthesize("Hola.")), { code: "tts_rate_limited" });
    hangingFetch();
    await assert.rejects(collect(tts.synthesize("Hola.")), { code: "tts_timeout" });

    const controller = new AbortController();
    hangingFetch();
    const pending = collect(tts.synthesize("Hola.", { signal: controller.signal }));
    controller.abort(new Error("barge-in"));
    // The abort itself comes back (a DOMException), never a "tts_*" failure.
    await assert.rejects(pending, (error) => !String(error.code).startsWith("tts_"));
});

test("Deepgram's voice gets one sentence and returns raw 24 kHz PCM", async () => {
    const calls = stubFetch(() => new Response(streamOf([1, 2, 3], [4, 5, 6])));
    const tts = createDeepgramTts({ apiKey: "dg-key", model: "aura-2-estrella-es", sampleRate: 24000 });
    const chunks = await collect(tts.synthesize("Hola, clase.", { previousText: "ignored" }));
    assert.deepEqual(chunks.flatMap((chunk) => [...chunk]), [1, 2, 3, 4, 5, 6]);

    const [{ url, init }] = calls;
    assert.equal(url.origin + url.pathname, "https://api.deepgram.com/v1/speak");
    assert.equal(url.searchParams.get("model"), "aura-2-estrella-es");
    assert.equal(url.searchParams.get("encoding"), "linear16");
    assert.equal(url.searchParams.get("sample_rate"), "24000");
    assert.equal(url.searchParams.get("container"), "none");
    assert.equal(init.headers.Authorization, "Token dg-key");
    assert.deepEqual(JSON.parse(init.body), { text: "Hola, clase." });

    stubFetch(() => new Response("bad key", { status: 401 }));
    await assert.rejects(collect(tts.synthesize("Hola.")), { code: "tts_auth" });
});
