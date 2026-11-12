/**
 * Kept answers: the same question again is answered from them, with its
 * speech, without asking Claude or counting for the hourly limit; a
 * follow-up, a question with Odoo AI and an answer that lost part of its
 * voice are never kept or given; the files on disk.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { AnswerCache, normalizeQuestion, signatureOf } from "../server/src/answer_cache.js";
import { loadConfig } from "../server/src/config.js";
import { HourlyLimiter } from "../server/src/limits.js";
import { createFakeLlm } from "../server/src/llm/fake.js";
import { FakeOdooAi } from "../server/src/odoo_ai.js";
import { Session } from "../server/src/session.js";
import { Sealer } from "../server/src/shares.js";
import { createFakeStt } from "../server/src/speech/stt/fake.js";
import { createFakeTts } from "../server/src/speech/tts/fake.js";

const quietLogger = { info() {}, warn() {}, error() {} };
const FIRST_QUESTION = "¿Cómo hacen las plantas la fotosíntesis?";
const CONFIG = loadConfig({ LLM_PROVIDER: "fake", STT_PROVIDER: "fake", TTS_PROVIDER: "fake" }, []);

const folders = [];
after(async () => {
    for (const folder of folders) {
        await rm(folder, { recursive: true, force: true });
    }
});

async function folder() {
    const dir = await mkdtemp(path.join(tmpdir(), "teacher-cache-"));
    folders.push(dir);
    return dir;
}

/** Resolves once `check()` is true; answers are kept just after `done`, without waiting for them. */
async function eventually(check, what) {
    for (let i = 0; i < 200; i += 1) {
        if (await check()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`never happened: ${what}`);
}

class FakeSocket extends EventEmitter {
    readyState = 1;
    sent = [];
    waiters = [];

    send(data, options) {
        const message = options?.binary ? { type: "binary", bytes: data.length, turn: data.readUInt32LE(0) } : JSON.parse(data);
        this.sent.push(message);
        this.waiters = this.waiters.filter(({ matches, resolve }) => (matches(message) ? (resolve(message), false) : true));
    }

    next(type, turn) {
        return new Promise((resolve) => this.waiters.push({ matches: (m) => m.type === type && m.turn === turn, resolve }));
    }

    fromBrowser(message) {
        this.emit("message", Buffer.from(JSON.stringify(message)), false);
    }

    async ask(message, binary = null) {
        const ended = Promise.race([this.next("done", message.turn), this.next("error", message.turn)]);
        this.fromBrowser(message);
        if (binary) {
            this.emit("message", binary, true);
        }
        return ended;
    }

    eventsOf(turn) {
        return this.sent.filter((event) => event.turn === turn);
    }
}

/** One server with kept answers, and connections to it. */
async function startServer({ maxPerHour = 0, tts = createFakeTts({ firstChunkMs: 0, chunkMs: 50, speedup: 0 }) } = {}) {
    const dir = await folder();
    const answers = new AnswerCache({ dir, maxEntries: 50, signature: signatureOf(CONFIG), logger: quietLogger });
    const limiter = new HourlyLimiter(maxPerHour);
    const sealer = new Sealer("a secret only the server knows, long enough");
    const connect = ({ odooAi = null, stt = createFakeStt({ delayMs: 0 }) } = {}) => {
        const fake = createFakeLlm({ firstTokenMs: 0, chunkMs: 0 });
        const requests = [];
        const llm = { ...fake, stream: (params) => { requests.push(params); return fake.stream(params); } };
        const socket = new FakeSocket();
        new Session({ socket, config: CONFIG, llm, stt, tts, odooAi, limiter, sealer, answers, logger: quietLogger });
        return { socket, requests };
    };
    const kept = async () => (await readdir(dir)).filter((name) => name.endsWith(".json")).length;
    return { dir, answers, sealer, connect, kept };
}

/** What a turn sent the page, without what changes every time. */
function shown(socket, turn) {
    return socket.eventsOf(turn)
        .filter((event) => event.type !== "done")
        .map(({ turn: _, ...event }) => event);
}

test("the same question again is answered from what was kept: same words, diagram and speech, nothing paid", async () => {
    const server = await startServer({ maxPerHour: 2 });
    const first = server.connect();
    const done = await first.socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es" });
    assert.equal(first.requests.length, 1);
    await eventually(async () => (await server.kept()) === 1, "the answer is kept");

    // Someone else, with other punctuation and capitals.
    const second = server.connect();
    const again = await second.socket.ask({ type: "ask_text", turn: 7, text: "como hacen las plantas la FOTOSINTESIS", language: "es" });
    assert.equal(second.requests.length, 0, "Claude is not asked");
    assert.equal(again.type, "done");
    assert.deepEqual(again.diagram, done.diagram);
    assert.equal(again.sentences, done.sentences);
    assert.equal(again.seal, done.seal, "it can be shared like the first one");
    assert.ok("cached" in again.timings);
    const firstShown = shown(first.socket, 1).filter((event) => event.type !== "transcript");
    const againShown = shown(second.socket, 7).filter((event) => event.type !== "transcript");
    assert.deepEqual(againShown, firstShown, "the same events, binary frames included, in the same order");
    assert.ok(againShown.filter((event) => event.type === "binary").length > 0, "with its speech");
    assert.equal(shown(second.socket, 7)[0].text, "como hacen las plantas la FOTOSINTESIS", "the question as this person asked it");

    // It did not count: one question is still left this hour, and the follow-up takes it.
    await second.socket.ask({ type: "ask_text", turn: 8, text: "¿Y de dónde saca el agua?", language: "es" });
    assert.equal(second.requests.length, 1);
    const { messages } = second.requests[0];
    assert.equal(messages.length, 3, "the kept answer is in the conversation");
    assert.equal(messages[0].content, "como hacen las plantas la FOTOSINTESIS");
    assert.match(messages[1].content, /^TITLE: La fotosíntesis\nSAY: /);
    const refused = await second.socket.ask({ type: "ask_text", turn: 9, text: "¿Qué es un átomo?", language: "es" });
    assert.equal(refused.code, "rate_limited");

    // Past the limit, a kept answer is still given.
    const third = server.connect();
    const still = await third.socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es" });
    assert.equal(still.type, "done");
    assert.equal(third.requests.length, 0);
});

test("going deeper is kept too, a recording finds the kept answer once heard, and a follow-up is never kept", async () => {
    const server = await startServer();
    const first = server.connect();
    await first.socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es" });
    await first.socket.ask({ type: "ask_node", turn: 2, from: 1, node: "glucosa", language: "es" });
    await first.socket.ask({ type: "ask_text", turn: 3, text: "¿Y eso por qué?", language: "es" });
    await eventually(async () => (await server.kept()) === 2, "the first answer and the deeper one are kept, not the follow-up");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await server.kept(), 2);

    // Another visitor, by voice; then the same node.
    const second = server.connect({ stt: createFakeStt({ delayMs: 0, text: FIRST_QUESTION }) });
    const heard = await second.socket.ask({ type: "ask_audio", turn: 1, mime: "audio/webm" }, Buffer.from([1, 2, 3]));
    assert.equal(heard.type, "done");
    const deeper = await second.socket.ask({ type: "ask_node", turn: 2, from: 1, node: "glucosa", language: "es" });
    assert.equal(deeper.type, "done");
    assert.equal(deeper.diagram.nodes[0].id, "glucosa");
    assert.equal(second.requests.length, 0, "neither one asked Claude");
    const seeded = second.socket.eventsOf(2).find((event) => event.type === "diagram_step");
    assert.deepEqual(seeded.nodes.map((node) => node.id), ["glucosa"], "the tapped node first, as always");

    // The same question at another level, or in another language, is another answer.
    const third = server.connect();
    await third.socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es", level: "kid" });
    assert.equal(third.requests.length, 1);
});

test("with Odoo AI, or when part of the voice was lost, the answer is not kept", async () => {
    const server = await startServer();
    const withOdoo = server.connect({ odooAi: new FakeOdooAi() });
    await withOdoo.socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es", odoo: true });
    await withOdoo.socket.ask({ type: "ask_text", turn: 2, text: FIRST_QUESTION, language: "es", odoo: true });
    assert.equal(withOdoo.requests.length, 2);

    let calls = 0;
    const voice = createFakeTts({ firstChunkMs: 0, chunkMs: 50, speedup: 0 });
    const flaky = {
        ...voice,
        async *synthesize(text, options) {
            calls += 1;
            if (calls === 2) {
                throw Object.assign(new Error("busy"), { code: "tts_unavailable" });
            }
            yield* voice.synthesize(text, options);
        },
    };
    const lossy = await startServer({ tts: flaky });
    const page = lossy.connect();
    const done = await page.socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es" });
    assert.equal(done.type, "done");
    assert.ok(page.socket.eventsOf(1).some((event) => event.type === "warning"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await lossy.kept(), 0);
    await withOdoo.socket.ask({ type: "ask_text", turn: 3, text: "x", language: "es" });
    assert.equal(await server.kept(), 0, "nothing was kept with Odoo AI on");
});

test("kept answers on disk: one key per question, language, level and setup; the least used go first", async () => {
    assert.equal(normalizeQuestion("¿Cómo   funciona el CICLO del agua?"), "como funciona el ciclo del agua");
    assert.equal(normalizeQuestion("What's an atom?!"), "what s an atom");

    const dir = await folder();
    const cache = new AnswerCache({ dir, maxEntries: 2, signature: "one setup", logger: quietLogger });
    const key = (question, language = "es", level = "normal") => cache.keyFor({ question, language, level });
    assert.equal(key("¿Qué es un átomo?"), key("que es un atomo"));
    assert.notEqual(key("¿Qué es un átomo?"), key("¿Qué es un átomo?", "en"));
    assert.notEqual(key("¿Qué es un átomo?"), key("¿Qué es un átomo?", "es", "kid"));
    const other = new AnswerCache({ dir, maxEntries: 2, signature: "another voice", logger: quietLogger });
    assert.notEqual(other.keyFor({ question: "¿Qué es un átomo?", language: "es", level: "normal" }), key("¿Qué es un átomo?"));
    assert.notEqual(signatureOf(CONFIG), signatureOf(loadConfig({ ...process.env, LLM_PROVIDER: "fake", STT_PROVIDER: "fake", TTS_PROVIDER: "fake", TTS_SPEED: "1" }, [])));

    const answer = (text) => ({
        events: [{ type: "sentence", step: 1, text }, { type: "pcm", step: 1, bytes: 4 }],
        historyAnswer: `SAY: ${text}`, diagram: null, stopReason: "end_turn", audio: Buffer.from([1, 0, 2, 0]),
    });
    assert.equal(await cache.put(key("a"), answer("A")), true);
    const back = await cache.get(key("a"));
    assert.deepEqual(back.events, answer("A").events);
    assert.deepEqual([...back.audio], [1, 0, 2, 0]);
    assert.equal(await cache.get(key("nunca")), null);
    assert.equal(await cache.get("../../etc/passwd"), null);

    // "a" was used long ago, "b" just now: "c" pushes "a" out.
    await cache.put(key("b"), answer("B"));
    const old = new Date(Date.now() - 60_000);
    await utimes(path.join(dir, `${key("a")}.json`), old, old);
    await cache.put(key("c"), answer("C"));
    assert.equal(await cache.get(key("a")), null);
    assert.ok(await cache.get(key("b")));

    // Speech cut short on disk: not given, and dropped.
    await writeFile(path.join(dir, `${key("b")}.pcm`), Buffer.from([1]));
    assert.equal(await cache.get(key("b")), null);
    assert.ok(!(await readdir(dir)).includes(`${key("b")}.json`));

    const long = { ...answer("L"), audio: Buffer.alloc(9 * 1024 * 1024) };
    assert.equal(await cache.put(key("long"), long), false, "past about 85 s of speech it is not kept");
});
