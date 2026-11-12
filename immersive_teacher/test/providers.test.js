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
import { speedFor } from "../server/src/speech/tts/speed.js";
import { ConfigError, TTS_SPEED, loadConfig } from "../server/src/config.js";

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

const DEEPGRAM = { apiKey: "dg-key", model: "nova-3", languages: { es: "es-419", en: "en" } };
const ELEVENLABS = {
    apiKey: "el-key", voices: { es: "voice/1", en: "voice/2" }, model: "eleven_flash_v2_5", sampleRate: 24000,
};

test("Deepgram gets the recording as is, with model, the question's language and token", async () => {
    const calls = stubFetch(() => Response.json({
        results: { channels: [{ alternatives: [{ transcript: "  ¿Qué es un átomo?  " }] }] },
    }));
    const audio = Uint8Array.from([26, 69, 223, 163]);
    const stt = createDeepgramStt(DEEPGRAM);
    const result = await stt.transcribe(audio, { mime: "audio/webm;codecs=opus", language: "es" });
    assert.equal(result.text, "¿Qué es un átomo?");
    const [{ url, init }] = calls;
    assert.equal(url.origin + url.pathname, "https://api.deepgram.com/v1/listen");
    assert.equal(url.searchParams.get("model"), "nova-3");
    // The region TEACHER_LANGUAGE gave goes along with its language.
    assert.equal(url.searchParams.get("language"), "es-419");
    assert.equal(url.searchParams.get("smart_format"), "true");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Token dg-key");
    assert.equal(init.headers["Content-Type"], "audio/webm");
    assert.equal(init.body, audio);

    await stt.transcribe(audio, { mime: "audio/webm", language: "en" });
    assert.equal(calls[1].url.searchParams.get("language"), "en");
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
    const chunks = await collect(tts.synthesize("Segunda frase.", { previousText: "Primera frase.", language: "es" }));
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

    // In English: the English voice, and the language said out loud.
    await collect(tts.synthesize("Second sentence.", { language: "en" }));
    assert.equal(calls[1].url.pathname, "/v1/text-to-speech/voice%2F2/stream");
    assert.equal(JSON.parse(calls[1].init.body).language_code, "en");
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

test("Deepgram's voice gets one sentence and returns raw 24 kHz PCM, in the voice of its language", async () => {
    const calls = stubFetch(() => new Response(streamOf([1, 2, 3], [4, 5, 6])));
    const voices = { es: "aura-2-estrella-es", en: "aura-2-thalia-en" };
    const tts = createDeepgramTts({ apiKey: "dg-key", voices, sampleRate: 24000 });
    const chunks = await collect(tts.synthesize("Hola, clase.", { previousText: "ignored", language: "es" }));
    assert.deepEqual(chunks.flatMap((chunk) => [...chunk]), [1, 2, 3, 4, 5, 6]);

    const [{ url, init }] = calls;
    assert.equal(url.origin + url.pathname, "https://api.deepgram.com/v1/speak");
    assert.equal(url.searchParams.get("model"), "aura-2-estrella-es");
    assert.equal(url.searchParams.get("encoding"), "linear16");
    assert.equal(url.searchParams.get("sample_rate"), "24000");
    assert.equal(url.searchParams.get("container"), "none");
    assert.equal(init.headers.Authorization, "Token dg-key");
    assert.deepEqual(JSON.parse(init.body), { text: "Hola, clase." });

    await collect(tts.synthesize("Hello, class.", { language: "en" }));
    assert.equal(calls[1].url.searchParams.get("model"), "aura-2-thalia-en");

    stubFetch(() => new Response("bad key", { status: 401 }));
    await assert.rejects(collect(tts.synthesize("Hola.")), { code: "tts_auth" });
});

test("TTS_SPEED goes to each voice in its own range, and nothing is sent at 1", async () => {
    assert.equal(speedFor("elevenlabs", 1.1), 1.1);
    assert.equal(speedFor("elevenlabs", 1.5), 1.2, "clamped to ElevenLabs' range");
    assert.equal(speedFor("deepgram", 1.5), 1.5);
    assert.equal(speedFor("deepgram", 0.5), 0.7);
    assert.equal(speedFor("deepgram", 1), null);

    let calls = stubFetch(() => new Response(streamOf([1, 2])));
    await collect(createElevenLabsTts({ ...ELEVENLABS, speed: 1.1 }).synthesize("Hola.", { language: "es" }));
    assert.deepEqual(JSON.parse(calls[0].init.body).voice_settings, { speed: 1.1 });
    calls = stubFetch(() => new Response(streamOf([1, 2])));
    await collect(createElevenLabsTts({ ...ELEVENLABS, speed: 1 }).synthesize("Hola.", { language: "es" }));
    assert.ok(!("voice_settings" in JSON.parse(calls[0].init.body)), "the request as without the setting");

    calls = stubFetch(() => new Response(streamOf([1, 2])));
    const voices = { es: "aura-2-estrella-es", en: "aura-2-thalia-en" };
    await collect(createDeepgramTts({ apiKey: "dg-key", voices, sampleRate: 24000, speed: 1.1 }).synthesize("Hola.", { language: "es" }));
    assert.equal(calls[0].url.searchParams.get("speed"), "1.1");
});

test("a voice that refuses the speed speaks at its normal pace instead of going silent", async () => {
    const voices = { es: "aura-2-estrella-es", en: "aura-2-thalia-en" };
    const warn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(message);
    try {
        // A 400 only with the speed: asked again without it, and never sent again.
        let calls = stubFetch((url) => (url.searchParams.has("speed")
            ? new Response("unknown parameter speed", { status: 400 })
            : new Response(streamOf([1, 2, 3, 4]))));
        const tts = createDeepgramTts({ apiKey: "dg-key", voices, sampleRate: 24000, speed: 1.1 });
        const chunks = await collect(tts.synthesize("Hola.", { language: "es" }));
        assert.deepEqual(chunks.flatMap((chunk) => [...chunk]), [1, 2, 3, 4]);
        await collect(tts.synthesize("Adiós.", { language: "es" }));
        assert.deepEqual(calls.map((call) => call.url.searchParams.get("speed")), ["1.1", null, null]);
        assert.equal(warnings.length, 1);

        // A 400 for another reason: the error goes up, and the speed stays for the next sentence.
        calls = stubFetch(() => new Response("text too long", { status: 400 }));
        const other = createElevenLabsTts({ ...ELEVENLABS, speed: 1.1 });
        await assert.rejects(collect(other.synthesize("Hola.", { language: "es" })), { code: "tts_bad_request" });
        calls = stubFetch(() => new Response(streamOf([1, 2])));
        await collect(other.synthesize("Hola.", { language: "es" }));
        assert.deepEqual(JSON.parse(calls[0].init.body).voice_settings, { speed: 1.1 });
    } finally {
        console.warn = warn;
    }
});

test("TTS_SPEED is a little faster by default, and a number in range", () => {
    const base = { LLM_PROVIDER: "fake", STT_PROVIDER: "fake", TTS_PROVIDER: "fake" };
    assert.equal(loadConfig(base, []).tts.speed, TTS_SPEED);
    assert.ok(TTS_SPEED > 1);
    assert.equal(loadConfig({ ...base, TTS_SPEED: "1.25" }, []).tts.speed, 1.25);
    for (const bad of ["fast", "3", "0.2"]) {
        assert.throws(() => loadConfig({ ...base, TTS_SPEED: bad }, []), ConfigError, bad);
    }
});
