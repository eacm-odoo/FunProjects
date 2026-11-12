/**
 * Shared explorations: the seal on each answer, the link made of what the
 * page kept (refused when anything the teacher said was changed), opening it
 * on another connection with the conversation that led there, its voice, the
 * files on disk, and the page's side (exploration.js, sharing.js and the
 * turn controller).
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { Exploration } from "../client/src/exploration.js";
import { ShareRequests, shareIdFrom, shareUrl } from "../client/src/sharing.js";
import { TurnController } from "../client/src/turn_controller.js";
import { loadConfig } from "../server/src/config.js";
import { HourlyLimiter } from "../server/src/limits.js";
import { createFakeLlm } from "../server/src/llm/fake.js";
import { Session } from "../server/src/session.js";
import { Sealer, ShareStore, cleanShare, historyOf, loadSecret } from "../server/src/shares.js";
import { createFakeStt } from "../server/src/speech/stt/fake.js";
import { createFakeTts } from "../server/src/speech/tts/fake.js";

const quietLogger = { info() {}, warn() {}, error() {} };
const FIRST_QUESTION = "¿Cómo hacen las plantas la fotosíntesis?";
const DAY_MS = 24 * 60 * 60 * 1000;

const folders = [];
after(async () => {
    for (const folder of folders) {
        await rm(folder, { recursive: true, force: true });
    }
});

async function folder() {
    const dir = await mkdtemp(path.join(tmpdir(), "teacher-shares-"));
    folders.push(dir);
    return dir;
}

class FakeSocket extends EventEmitter {
    readyState = 1; // OPEN
    sent = [];
    waiters = [];

    send(data, options) {
        const message = options?.binary ? { type: "binary", bytes: data.length } : JSON.parse(data);
        this.sent.push(message);
        this.waiters = this.waiters.filter(({ matches, resolve }) => (matches(message) ? (resolve(message), false) : true));
    }

    /** The next event of `type` that passes `matches`. */
    next(type, matches = () => true) {
        return new Promise((resolve) => this.waiters.push({ matches: (m) => m.type === type && matches(m), resolve }));
    }

    fromBrowser(message) {
        this.emit("message", Buffer.from(JSON.stringify(message)), false);
    }

    /** Asks and waits for that turn to end (done or error). */
    async ask(message) {
        const ended = Promise.race([this.next("done", (m) => m.turn === message.turn), this.next("error", (m) => m.turn === message.turn)]);
        this.fromBrowser(message);
        return ended;
    }

    /** Sends `message` and waits for the first event of one of `types`. */
    async request(message, types) {
        const answer = Promise.race(types.map((type) => this.next(type)));
        this.fromBrowser(message);
        return answer;
    }

    eventsOf(turn) {
        return this.sent.filter((event) => event.turn === turn);
    }
}

/** One server: its shares on disk, and connections to it. */
async function startServer({ tts = null, maxShares = 50, sharing = true } = {}) {
    const dir = await folder();
    const sealer = sharing ? new Sealer(await loadSecret(dir, quietLogger)) : null;
    const store = sharing ? new ShareStore({ dir, maxShares, days: 30, logger: quietLogger }) : null;
    const config = loadConfig({ LLM_PROVIDER: "fake", STT_PROVIDER: "fake", TTS_PROVIDER: "none" }, []);
    const connect = ({ voiceLimiter } = {}) => {
        const fake = createFakeLlm({ firstTokenMs: 0, chunkMs: 0 });
        const requests = [];
        const llm = { ...fake, stream: (params) => { requests.push(params); return fake.stream(params); } };
        const socket = new FakeSocket();
        new Session({
            socket, config, llm, stt: createFakeStt({ delayMs: 0 }), tts, limiter: new HourlyLimiter(0),
            shares: store, sealer, voiceLimiter, logger: quietLogger,
        });
        return { socket, requests };
    };
    return { dir, sealer, store, connect };
}

/** What the page keeps of turn `turn`, from the events the server sent (as the turn controller does). */
function keep(exploration, socket, turn, { dive = null, question = "" } = {}) {
    exploration.begin(turn, dive, { question, language: "es" });
    for (const event of socket.eventsOf(turn)) {
        if (event.type === "sentence") {
            exploration.addSentence(turn, event.step, event.text);
        } else if (event.type === "citation") {
            exploration.addCitation(turn, event.step, { source: event.source, pages: event.pages ?? null, quote: event.quote ?? "" });
        } else if (event.type === "done") {
            exploration.finish(turn, event.diagram, event.seal ?? null);
        }
    }
}

/** A photosynthesis answer and one deeper into its glucose, kept by the page of a new connection. */
async function explored(server) {
    const { socket } = server.connect();
    const exploration = new Exploration();
    const first = await socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es" });
    keep(exploration, socket, 1, { question: FIRST_QUESTION });
    await socket.ask({ type: "ask_node", turn: 2, from: 1, node: "glucosa", language: "es" });
    keep(exploration, socket, 2, { dive: { from: 1, node: "glucosa" }, question: "¿Adónde va la glucosa?" });
    return { socket, exploration, first };
}

async function share(socket, payload, req = 1) {
    return socket.request({ type: "share", req, language: "es", ...payload }, ["shared", "share_error"]);
}

test("a link holds what the teacher said, and opens on another connection where its author was", async () => {
    const server = await startServer();
    const { socket, exploration, first } = await explored(server);
    assert.equal(typeof first.seal, "string", "every finished answer comes sealed");
    exploration.entry(2).pins.set("glucosa", { x: 0.1234, y: 1.2, z: -0.3 });

    const payload = exploration.shareOf(2, "path");
    assert.deepEqual(payload.turns.map((turn) => turn.turn), [1, 2]);
    const shared = await share(socket, payload);
    assert.equal(shared.type, "shared");
    assert.equal(shareIdFrom(shared.id), shared.id);
    assert.ok((await readdir(server.dir)).includes(`${shared.id}.json`));

    // Someone else opens the link.
    const other = server.connect();
    const opened = await other.socket.request({ type: "open_share", id: shared.id, language: "es" }, ["share_opened", "share_error"]);
    assert.equal(opened.type, "share_opened");
    const { share: received } = opened;
    assert.equal(received.shown, 2);
    assert.deepEqual(received.turns.map(({ turn, parent, focus }) => ({ turn, parent, focus })), [
        { turn: 1, parent: null, focus: null },
        { turn: 2, parent: 1, focus: "glucosa" },
    ]);
    assert.equal(received.turns[0].question, FIRST_QUESTION);
    assert.equal(received.turns[1].question, "¿Adónde va la glucosa?");
    assert.deepEqual(received.turns[1].sentences, payload.turns[1].sentences);
    assert.deepEqual(received.turns[1].diagram, payload.turns[1].diagram);
    assert.deepEqual(received.turns[1].pins, { glucosa: { x: 0.123, y: 1.2, z: -0.3 } });
    assert.equal(received.turns[1].root.question, FIRST_QUESTION);
    assert.ok(received.turns.every((turn) => typeof turn.seal === "string"));

    // Their next question follows from the conversation that led there.
    await other.socket.ask({ type: "ask_text", turn: 1, text: "¿Y la planta cómo la usa?", language: "es" });
    const { messages } = other.requests[0];
    assert.equal(messages.length, 5);
    assert.equal(messages[0].content, FIRST_QUESTION);
    assert.match(messages[1].content, /^TITLE: La fotosíntesis\nSAY: La fotosíntesis es /);
    assert.match(messages[1].content, /\nDRAW: \{"nodes":\[/);
    assert.match(messages[2].content, /^Profundiza en «Glucosa» \(id glucosa\), un nodo de tu diagrama «La fotosíntesis»\./);
    assert.doesNotMatch(messages[3].content, /"id":"glucosa"/, "the tapped node was not drawn again by Claude");

    // What they received can be shared again, whole.
    const again = new Exploration();
    const { turnIds, shown } = again.load(shared.id, received, 1);
    assert.deepEqual(turnIds, [1, 2]);
    const reshared = await share(other.socket, again.shareOf(shown, "tree"), 2);
    assert.equal(reshared.type, "shared");
    assert.notEqual(reshared.id, shared.id);
});

test("nothing the teacher said can be changed on the way to a link", async () => {
    const server = await startServer();
    const { socket, exploration } = await explored(server);
    const changes = [
        (turn) => { turn.sentences[0] = "La fotosíntesis es un invento reciente."; },
        (turn) => { turn.diagram.nodes[0].label = "Otra cosa"; },
        (turn) => { turn.diagram.title = "Otro título"; },
        (turn) => { turn.sentences.push("Una frase de más."); },
        (turn) => { turn.seal = "x"; },
        (turn) => { delete turn.seal; },
    ];
    for (const [index, change] of changes.entries()) {
        const payload = structuredClone(exploration.shareOf(2, "path"));
        change(payload.turns[0]);
        const answer = await share(socket, payload, index + 1);
        assert.equal(answer.type, "share_error", `change ${index}`);
        assert.equal(answer.code, "share_invalid");
        assert.match(answer.message, /ya no reconoce/);
    }
    assert.deepEqual(await readdir(server.dir), [".secret"], "nothing was saved");

    // A citation too: its passage is part of what the teacher said.
    const answer = {
        diagram: { title: "T", nodes: [{ id: "a", label: "A", shape: "box", color: "#4C9BE8", step: 1 }], edges: [] },
        sentences: ["Una frase."],
        citations: [{ step: 1, source: "Manual.pdf", pages: { from: 4, to: 4 }, quote: "texto citado" }],
    };
    const turn = { turn: 1, ...structuredClone(answer), seal: server.sealer.seal(answer) };
    assert.deepEqual(cleanShare({ turns: [turn] }, server.sealer).turns[0].citations, answer.citations);
    turn.citations[0].quote = "otro texto";
    assert.throws(() => cleanShare({ turns: [turn] }, server.sealer), { code: "share_invalid" });
});

test("what the page adds around the explanations is checked and cut to size", async () => {
    const sealer = new Sealer("a secret only the server knows, long enough");
    const answer = (title, ids) => {
        const content = {
            diagram: {
                title,
                nodes: ids.map((id, index) => ({ id, label: id, shape: "box", color: "#4C9BE8", step: index + 1 })),
                edges: [],
            },
            sentences: ids.map((id) => `Sobre ${id}.`),
            citations: [],
        };
        return { ...content, seal: sealer.seal(content) };
    };
    const share = cleanShare({
        shown: 99,
        turns: [
            {
                turn: 7, parent: 3, focus: "nada", level: "genius", language: "fr", question: "x".repeat(900),
                root: { question: "", title: "" }, explored: ["a", "a", "zzz", 4],
                pins: { a: { x: 1, y: 2, z: 3 }, b: { x: 99, y: 0, z: 0 }, zzz: { x: 0, y: 0, z: 0 } },
                ...answer("Uno", ["a", "b"]),
            },
            // Its parent is the first one, but the node it names is not there.
            { turn: 8, parent: 7, focus: "zzz", ...answer("Dos", ["c"]) },
            { turn: 9, parent: 7, focus: "B", level: "kid", language: "es", ...answer("Tres", ["b", "d"]) },
        ],
    }, sealer, { language: "en" });

    const [one, two, three] = share.turns;
    assert.equal(share.shown, 3, "an unknown turn opens at the last explanation");
    assert.deepEqual({ parent: one.parent, focus: one.focus, level: one.level, language: one.language },
        { parent: null, focus: null, level: "normal", language: "en" });
    assert.equal(one.question.length, 500);
    assert.deepEqual(one.root, { question: "x".repeat(199) + "…", title: "Uno" });
    assert.deepEqual(one.explored, ["a"]);
    assert.deepEqual(one.pins, { a: { x: 1, y: 2, z: 3 } });
    assert.deepEqual({ parent: two.parent, focus: two.focus }, { parent: null, focus: null });
    assert.equal(two.question, "Dos", "without a question, the diagram's title");
    assert.deepEqual({ parent: three.parent, focus: three.focus, level: three.level }, { parent: 1, focus: "b", level: "kid" });
    assert.equal(three.root, one.root, "a deeper explanation keeps the first question of its chain");

    assert.throws(() => cleanShare({ turns: [] }, sealer), { code: "share_invalid" });
    assert.throws(() => cleanShare({ turns: Array.from({ length: 13 }, () => answer("T", ["a"])) }, sealer), { code: "share_invalid" });
    assert.throws(() => cleanShare({ turns: [null] }, sealer), { code: "share_invalid" });

    // The conversation for whoever opens it: the chain down to the explanation shown.
    const history = historyOf({ ...share, shown: 3 });
    assert.equal(history.length, 2);
    assert.equal(history[0].question, one.question);
    assert.match(history[1].question, /^Profundiza en «b» \(id b\), un nodo de tu diagrama «Uno»\./);
    assert.equal(history[1].answer, "TITLE: Tres\nSAY: Sobre b.\nSAY: Sobre d.\nDRAW: {\"nodes\":[{\"id\":\"d\",\"label\":\"d\",\"shape\":\"box\",\"color\":\"#4C9BE8\"}]}");
});

test("a shared explanation is said again by the server, only its own sentences", async () => {
    const tts = createFakeTts({ firstChunkMs: 0, chunkMs: 50, speedup: 0 });
    const server = await startServer({ tts });
    const { socket, exploration } = await explored(server);
    const { id } = await share(socket, exploration.shareOf(2, "path"));

    const other = server.connect({ voiceLimiter: new HourlyLimiter(1) });
    await other.socket.request({ type: "open_share", id }, ["share_opened"]);
    const spoken = other.socket.next("spoken", (m) => m.turn === 5);
    other.socket.fromBrowser({ type: "speak_share", turn: 5, id, entry: 2, language: "es" });
    await spoken;
    const events = other.socket.eventsOf(5);
    const sentences = exploration.shareOf(2, "path").turns[1].sentences;
    assert.deepEqual(events.filter((event) => event.type === "audio_start").map((event) => event.step),
        sentences.map((_, index) => index + 1));
    assert.ok(events.filter((event) => event.type === "audio_end").every((event) => event.ok));
    assert.ok(other.socket.sent.some((event) => event.type === "binary"), "speech frames");
    assert.ok(!events.some((event) => event.type === "sentence"), "nothing is asked to Claude");

    // Its own hourly window: past it, the explanation goes as text.
    const refused = await other.socket.request({ type: "speak_share", turn: 6, id, entry: 1, language: "es" }, ["error"]);
    assert.equal(refused.code, "rate_limited");

    const third = server.connect();
    for (const [turn, message] of [[1, { id, entry: 9 }], [2, { id: "AAAAAAAAAAAA", entry: 1 }], [3, { id: "../../.secret", entry: 1 }]]) {
        const gone = await third.socket.request({ type: "speak_share", turn, language: "es", ...message }, ["error"]);
        assert.equal(gone.code, "share_gone");
    }
});

test("a link that is gone, or a server without links, says so", async () => {
    const server = await startServer();
    const { socket } = server.connect();
    const gone = await socket.request({ type: "open_share", id: "AAAAAAAAAAAA", language: "es" }, ["share_error"]);
    assert.deepEqual({ code: gone.code, id: gone.id }, { code: "share_gone", id: "AAAAAAAAAAAA" });
    assert.match(gone.message, /caducó/);

    const off = await startServer({ sharing: false });
    const page = off.connect();
    assert.equal(page.socket.sent.find((event) => event.type === "hello").share, false);
    const done = await page.socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es" });
    assert.equal(done.seal, undefined, "no seal without links");
    const refused = await share(page.socket, { shown: 1, turns: [{ turn: 1 }] });
    assert.equal(refused.code, "share_off");
    const closed = await page.socket.request({ type: "open_share", id: "AAAAAAAAAAAA", language: "en" }, ["share_error"]);
    assert.equal(closed.code, "share_off");
    assert.match(closed.message, /does not keep/);
});

test("links expire after SHARE_DAYS, the oldest go past MAX_SHARES, and the secret stays", async () => {
    const dir = await folder();
    let now = Date.now();
    const store = new ShareStore({ dir, maxShares: 2, days: 30, now: () => now, logger: quietLogger });
    const share = { v: 1, shown: 1, turns: [] };

    const first = await store.save(share);
    assert.deepEqual((await store.load(first)).turns, []);
    now += 31 * DAY_MS;
    assert.equal(await store.load(first), null);
    assert.deepEqual(await readdir(dir), [], "the expired file is gone");

    now = Date.now();
    const a = await store.save(share);
    const b = await store.save(share);
    const old = new Date(Date.now() - 60_000);
    await utimes(path.join(dir, `${a}.json`), old, old);
    const c = await store.save(share);
    assert.deepEqual((await readdir(dir)).sort(), [`${b}.json`, `${c}.json`].sort());
    assert.equal(await store.load("../x"), null);

    const secret = await loadSecret(dir, quietLogger);
    assert.equal(await loadSecret(dir, quietLogger), secret);
    assert.ok(secret.length >= 32);
});

// --- The page ------------------------------------------------------------------

const PHOTOSYNTHESIS = {
    title: "La fotosíntesis",
    nodes: [{ id: "planta", label: "Planta", step: 1 }, { id: "glucosa", label: "Glucosa", step: 2, hook: "¿Adónde va la glucosa?" }],
    edges: [{ from: "planta", to: "glucosa", step: 2 }],
};
const GLUCOSE = { title: "Más de Glucosa", nodes: [{ id: "glucosa", label: "Glucosa", step: 1 }, { id: "celula", label: "Célula", step: 1 }], edges: [] };
const PLANT = { title: "Más de Planta", nodes: [{ id: "planta", label: "Planta", step: 1 }], edges: [] };

function answered(exploration, turnId, diagram, { dive = null, seal = `seal-${turnId}`, finish = true } = {}) {
    exploration.begin(turnId, dive, { question: `Pregunta ${turnId}`, language: "es" });
    exploration.addSentence(turnId, 1, `Frase ${turnId}.`);
    if (finish) {
        exploration.finish(turnId, diagram, seal);
    }
}

test("the page shares one explanation with the path to it, or its whole tree, and takes a shared one in", () => {
    const exploration = new Exploration();
    answered(exploration, 1, PHOTOSYNTHESIS);
    answered(exploration, 2, GLUCOSE, { dive: { from: 1, node: "glucosa" } });
    exploration.addCitation(2, 1, { source: "Manual.pdf", pages: { from: 4, to: 4 }, quote: "texto" });
    answered(exploration, 3, PLANT, { dive: { from: 1, node: "planta" } });
    answered(exploration, 4, GLUCOSE); // another question, another tree
    answered(exploration, 5, PLANT, { dive: { from: 4, node: "glucosa" }, finish: false });
    answered(exploration, 6, PLANT, { seal: null }); // given while links were off

    assert.deepEqual(exploration.shareSizes(2), { path: 2, tree: 3 });
    assert.deepEqual(exploration.shareSizes(4), { path: 1, tree: 1 });
    assert.equal(exploration.shareOf(5), null, "not finished");
    assert.equal(exploration.shareOf(6), null, "without a seal");
    const tree = exploration.shareOf(2, "tree");
    assert.equal(tree.shown, 2);
    assert.deepEqual(tree.turns.map(({ turn, parent, focus }) => [turn, parent, focus]), [[1, null, null], [2, 1, "glucosa"], [3, 1, "planta"]]);
    const deeper = tree.turns[1];
    assert.deepEqual(deeper.sentences, ["Frase 2."]);
    assert.deepEqual(deeper.citations, [{ step: 1, source: "Manual.pdf", pages: { from: 4, to: 4 }, quote: "texto" }]);
    assert.equal(deeper.seal, "seal-2");
    assert.deepEqual(deeper.explored, []);
    assert.deepEqual(tree.turns[0].explored.sort(), ["glucosa", "planta"]);

    // On another page, after one question of its own.
    const other = new Exploration();
    answered(other, 1, GLUCOSE);
    const received = JSON.parse(JSON.stringify(tree));
    received.turns.forEach((turn, index) => { turn.turn = index + 1; turn.parent = turn.parent === null ? null : 1; });
    received.shown = 2;
    const { turnIds, shown } = other.load("AbCdEfGhIjKl", received, 2);
    assert.deepEqual(turnIds, [2, 3, 4]);
    assert.equal(shown, 3);
    assert.equal(other.shown, 1, "what is on screen does not change until it is shown");
    const entry = other.entry(3);
    assert.equal(entry.parentTurnId, 2);
    assert.equal(entry.root, other.entry(2).root);
    assert.deepEqual(entry.shared, { id: "AbCdEfGhIjKl", turn: 2 });
    assert.deepEqual([...entry.sentences], [[1, "Frase 2."]]);
    assert.deepEqual(entry.citations.get(1), [{ source: "Manual.pdf", pages: { from: 4, to: 4 }, quote: "texto" }]);
    assert.equal(entry.speech.size, 0);
    assert.equal(other.childOf(2, "glucosa"), entry, "a node explored there opens what it gave, without asking");
    assert.deepEqual(other.pathTo(3), [{ turnId: 2, title: "La fotosíntesis" }]);
    assert.ok(other.shareable(3));
});

test("a share request is settled by its own answer", async () => {
    const sent = [];
    const requests = new ShareRequests({ send: (message) => sent.push(message) > 0 }, { timeoutMs: 20, timeoutMessage: () => "lento" });
    const first = requests.request({ shown: 1, turns: [] });
    const second = requests.request({ shown: 2, turns: [] });
    assert.deepEqual(sent.map(({ type, req }) => [type, req]), [["share", 1], ["share", 2]]);
    assert.equal(requests.answer({ type: "share_error", req: 2, message: "no" }), true);
    assert.equal(requests.answer({ type: "shared", req: 1, id: "AbCdEfGhIjKl" }), true);
    assert.equal(requests.answer({ type: "share_error", message: "a link opened" }), false);
    assert.equal(await first, "AbCdEfGhIjKl");
    await assert.rejects(second, { message: "no" });
    await assert.rejects(requests.request({}), { message: "lento" });

    const offline = new ShareRequests({ send: () => false }, { timeoutMessage: () => "sin conexión" });
    await assert.rejects(offline.request({}), { message: "sin conexión" });

    assert.equal(shareUrl("AbCdEfGhIjKl", { origin: "https://profe.example", pathname: "/" }), "https://profe.example/?share=AbCdEfGhIjKl");
    assert.equal(shareIdFrom("AbCdEfGhIjKl"), "AbCdEfGhIjKl");
    for (const bad of [null, "", "short", "AbCdEfGhIjK/", "AbCdEfGhIjKlm"]) {
        assert.equal(shareIdFrom(bad), null, String(bad));
    }
});

// --- The turn controller with a shared exploration ----------------------------

class FakeConnection {
    handlers = new Map();
    sent = [];
    isOpen = true;

    on(type, handler) {
        this.handlers.set(type, handler);
    }

    onBinary(handler) {
        this.binary = handler;
    }

    send(message) {
        this.sent.push(message);
        return this.isOpen;
    }

    emit(event) {
        this.handlers.get(event.type)?.(event);
    }

    speech(turn, step, samples) {
        const buffer = new ArrayBuffer(8 + samples.length * 2);
        const view = new DataView(buffer);
        view.setUint32(0, turn, true);
        view.setUint16(4, step, true);
        samples.forEach((sample, index) => view.setInt16(8 + index * 2, sample, true));
        this.binary(buffer);
    }
}

/** Says everything at once when told nothing more comes, like the turn controller tests' one. */
class FakeNarrator {
    unlocked = true;
    busy = false;
    log = [];
    queue = [];
    next = 1;

    enqueue(step, text) {
        this.log.push(`say ${step} ${text}`);
        if (step >= this.next) {
            this.queue.push(step);
        }
    }

    audioStart(step) {
        this.log.push(`start ${step}`);
    }

    audioChunk(step, samples) {
        this.log.push(`chunk ${step} ${[...samples].join(",")}`);
    }

    audioEnd(step) {
        this.log.push(`end ${step}`);
    }

    finish() {
        const steps = this.queue;
        this.queue = [];
        for (const step of steps) {
            this.next = step + 1;
            this.onStepStart(step);
        }
        this.onIdle();
    }

    stop() {
        this.queue = [];
        this.next = 1;
    }
}

function recorder() {
    const calls = [];
    const object = new Proxy({}, {
        get: (target, name) => (name in target ? target[name] : (...args) => calls.push([name, ...args])),
        set: (target, name, value) => {
            target[name] = value;
            return true;
        },
    });
    return { object, calls };
}

function controllerSetUp({ snapshot = null } = {}) {
    const connection = new FakeConnection();
    const panel = recorder();
    const diagram = recorder();
    diagram.object.pins = () => new Map();
    const audioNarrator = new FakeNarrator();
    const timedNarrator = new FakeNarrator();
    const controller = new TurnController({
        connection, panel: panel.object, status: { set() {} }, diagram: diagram.object, audioNarrator, timedNarrator,
        linkFor: (id) => `https://profe.example/?share=${id}`,
        snapshot,
    });
    controller.setSpeechEnabled(true);
    controller.setSharing(true);
    return { controller, connection, panel, diagram, audioNarrator, timedNarrator };
}

const SHARED = {
    shown: 2,
    turns: [
        { turn: 1, parent: null, focus: null, language: "es", level: "normal", question: FIRST_QUESTION,
            root: { question: FIRST_QUESTION, title: "La fotosíntesis" }, diagram: PHOTOSYNTHESIS,
            sentences: ["Uno.", "Dos."], citations: [], explored: ["glucosa"], pins: {}, seal: "s1" },
        { turn: 2, parent: 1, focus: "glucosa", language: "es", level: "normal", question: "¿Adónde va la glucosa?",
            root: { question: FIRST_QUESTION, title: "La fotosíntesis" }, diagram: GLUCOSE,
            sentences: ["Tres.", "Cuatro."], citations: [{ step: 2, source: "Manual.pdf", pages: null, quote: "" }],
            explored: [], pins: { celula: { x: 0.2, y: 1, z: 0 } }, seal: "s2" },
    ],
};

const quietly = async (fn) => {
    const info = console.info;
    console.info = () => {};
    try {
        return await fn();
    } finally {
        console.info = info;
    }
};

test("a link opens where its author was, and the shared explanation gets its voice from the server once", () => quietly(() => {
    const { controller, connection, panel, diagram, audioNarrator } = controllerSetUp();
    assert.equal(controller.openLink("AbCdEfGhIjKl"), true);
    assert.deepEqual(connection.sent.at(-1), { type: "open_share", id: "AbCdEfGhIjKl", language: "es" });
    connection.emit({ type: "share_opened", id: "AbCdEfGhIjKl", share: structuredClone(SHARED) });

    const names = panel.calls.map(([name]) => name);
    assert.equal(names[0], "showNote");
    assert.deepEqual(panel.calls.filter(([name]) => name === "startTurn").map(([, turn, question, options]) => [turn, question, options.dive]),
        [[1, FIRST_QUESTION, false], [2, "¿Adónde va la glucosa?", true]]);
    assert.ok(panel.calls.some(([name, turn, path]) => name === "setPath" && turn === 2 && path[0].title === "La fotosíntesis"));
    assert.ok(panel.calls.some(([name, turn, step, citation]) => name === "addCitation" && turn === 2 && step === 2 && citation.source === "Manual.pdf"));
    assert.deepEqual(panel.calls.filter(([name]) => name === "setShare").map(([, turn]) => turn), [1, 2]);
    const [show] = diagram.calls.filter(([name]) => name === "show");
    assert.equal(show[1].title, "Más de Glucosa");
    assert.deepEqual([...show[2].pins], [["celula", { x: 0.2, y: 1, z: 0 }]]);
    assert.equal(controller.exploration.shown, 2);

    // The first time, the server says it; the speech is kept under that explanation.
    assert.equal(controller.replayShown(), true);
    const ask = connection.sent.at(-1);
    assert.deepEqual(ask, { type: "speak_share", turn: 3, id: "AbCdEfGhIjKl", entry: 2, language: "es" });
    for (const step of [1, 2]) {
        connection.emit({ type: "audio_start", turn: 3, step, sampleRate: 24000 });
        connection.speech(3, step, [step, 9]);
        connection.emit({ type: "audio_end", turn: 3, step, ok: true });
    }
    connection.emit({ type: "spoken", turn: 3 });
    const speech = controller.exploration.entry(2).speech;
    assert.deepEqual([...speech.keys()], [1, 2]);
    assert.equal(controller.voicing, null);

    // The next time it plays from what was kept: nothing is asked.
    const sent = connection.sent.length;
    audioNarrator.log.length = 0;
    assert.equal(controller.replayShown(), true);
    assert.equal(connection.sent.length, sent);
    assert.ok(audioNarrator.log.includes("chunk 1 1,9"));
    assert.ok(audioNarrator.log.includes("chunk 2 2,9"));
}));

test("without the server's voice, a shared explanation is said as text, and a cut voice is asked again", () => quietly(() => {
    const { controller, connection, panel, timedNarrator } = controllerSetUp();
    controller.openLink("AbCdEfGhIjKl");
    connection.emit({ type: "share_opened", id: "AbCdEfGhIjKl", share: structuredClone(SHARED) });

    controller.replayShown();
    assert.equal(connection.sent.at(-1).type, "speak_share");
    connection.emit({ type: "error", turn: 3, code: "share_gone", message: "Ese link ya no existe." });
    assert.ok(panel.calls.some(([name, turn, message]) => name === "showNote" && turn === 2 && message === "Ese link ya no existe."));
    assert.deepEqual(timedNarrator.log.filter((line) => line.startsWith("say")), ["say 1 Tres.", "say 2 Cuatro."]);
    assert.equal(controller.exploration.entry(2).speech.size, 0);

    // Interrupted halfway: what arrived is dropped, and the next replay asks for it again.
    controller.replayShown();
    const { turn } = connection.sent.at(-1);
    connection.emit({ type: "audio_start", turn, step: 1, sampleRate: 24000 });
    connection.speech(turn, 1, [1]);
    controller.interrupt();
    assert.deepEqual(connection.sent.at(-1), { type: "cancel", turn });
    assert.equal(controller.exploration.entry(2).speech.size, 0);
    controller.replayShown();
    assert.equal(connection.sent.at(-1).type, "speak_share");

    // A server without links says so instead of opening anything.
    const off = controllerSetUp();
    off.controller.setSharing(false);
    assert.equal(off.controller.openLink("AbCdEfGhIjKl"), false);
    assert.equal(off.connection.sent.length, 0);
    assert.ok(off.panel.calls.some(([name]) => name === "showError"));
}));

test("an answer can be shared once it is whole and sealed", () => quietly(async () => {
    const { controller, connection, panel } = controllerSetUp();
    controller.ask(FIRST_QUESTION);
    connection.emit({ type: "sentence", turn: 1, step: 1, text: "Uno." });
    connection.emit({ type: "done", turn: 1, diagram: PHOTOSYNTHESIS, seal: "s1" });
    const [offer] = panel.calls.filter(([name]) => name === "setShare");
    assert.equal(offer[1], 1);
    assert.deepEqual(offer[2].sizes(), { path: 1, tree: 1 });

    const link = offer[2].onShare("path");
    const request = connection.sent.at(-1);
    assert.equal(request.type, "share");
    assert.equal(request.turns[0].seal, "s1");
    assert.deepEqual(request.turns[0].sentences, ["Uno."]);
    connection.emit({ type: "shared", req: request.req, id: "AbCdEfGhIjKl" });
    assert.equal(await link, "https://profe.example/?share=AbCdEfGhIjKl");

    // Without a seal (links off when it was given), no button.
    controller.ask("Otra");
    connection.emit({ type: "sentence", turn: 2, step: 1, text: "Uno." });
    connection.emit({ type: "done", turn: 2, diagram: PLANT });
    assert.equal(panel.calls.filter(([name]) => name === "setShare").length, 1);
}));

test("the link's picture goes with the share, and a link is made without it when it cannot be drawn", () => quietly(async () => {
    const views = [];
    const { controller, connection } = controllerSetUp({ snapshot: (view) => { views.push(view); return "/9j/AAAA"; } });
    controller.ask(FIRST_QUESTION);
    connection.emit({ type: "sentence", turn: 1, step: 1, text: "Uno." });
    connection.emit({ type: "done", turn: 1, diagram: PHOTOSYNTHESIS, seal: "s1" });
    const link = controller.share(1, "path");
    const request = connection.sent.at(-1);
    assert.equal(request.image, "/9j/AAAA");
    assert.equal(views[0].diagram, PHOTOSYNTHESIS);
    assert.deepEqual(views[0].hooks, ["glucosa"], "the open questions, as on screen");
    connection.emit({ type: "shared", req: request.req, id: "AbCdEfGhIjKl" });
    await link;

    const broken = controllerSetUp({ snapshot: () => { throw new Error("no WebGL"); } });
    const warn = console.warn;
    console.warn = () => {};
    try {
        broken.controller.ask(FIRST_QUESTION);
        broken.connection.emit({ type: "sentence", turn: 1, step: 1, text: "Uno." });
        broken.connection.emit({ type: "done", turn: 1, diagram: PHOTOSYNTHESIS, seal: "s1" });
        const made = broken.controller.share(1, "path");
        const sent = broken.connection.sent.at(-1);
        assert.equal(sent.type, "share");
        assert.ok(!("image" in sent));
        broken.connection.emit({ type: "shared", req: sent.req, id: "AbCdEfGhIjKl" });
        assert.equal(await made, "https://profe.example/?share=AbCdEfGhIjKl");
    } finally {
        console.warn = warn;
    }
}));
