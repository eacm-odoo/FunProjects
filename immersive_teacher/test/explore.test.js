/**
 * Going deeper into a node: the question the server builds from a diagram it
 * kept, the seeded node, Odoo AI's plain question, the memory of diagrams
 * and the page's side of the chain (client/src/exploration.js).
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { crumbId, crumbTurn, visibleCrumbs } from "../client/src/diagram/diagram_view.js";
import { Exploration } from "../client/src/exploration.js";
import { LEVELS, level, nextLevel, onLevelChange, setLevel } from "../client/src/level.js";
import { loadConfig } from "../server/src/config.js";
import { DiagramMemory, diveQuestion } from "../server/src/dive.js";
import { MESSAGES } from "../server/src/i18n.js";
import { HourlyLimiter } from "../server/src/limits.js";
import { createFakeLlm } from "../server/src/llm/fake.js";
import { FakeOdooAi } from "../server/src/odoo_ai.js";
import { Session } from "../server/src/session.js";
import { createFakeStt } from "../server/src/speech/stt/fake.js";

const quietLogger = { info() {}, warn() {}, error() {} };
const FIRST_QUESTION = "¿Cómo hacen las plantas la fotosíntesis?";

class FakeSocket extends EventEmitter {
    readyState = 1; // OPEN
    sent = [];
    waiters = [];

    send(data, options) {
        const message = options?.binary ? { type: "binary" } : JSON.parse(data);
        this.sent.push(message);
        this.waiters = this.waiters.filter(({ test: matches, resolve }) => (matches(message) ? (resolve(message), false) : true));
    }

    /** The next event of `type` for `turn`. */
    next(type, turn) {
        return new Promise((resolve) => this.waiters.push({ test: (m) => m.type === type && m.turn === turn, resolve }));
    }

    fromBrowser(message) {
        this.emit("message", Buffer.from(JSON.stringify(message)), false);
    }

    /** Sends `message` and waits for its turn to end (done or error). */
    async ask(message) {
        const ended = Promise.race([this.next("done", message.turn), this.next("error", message.turn)]);
        this.fromBrowser(message);
        return ended;
    }

    eventsOf(turn) {
        return this.sent.filter((event) => event.turn === turn);
    }
}

/** Odoo AI's fake, recording each question. */
class RecordingOdooAi extends FakeOdooAi {
    questions = [];

    ask(question, options) {
        this.questions.push(question);
        return super.ask(question, options);
    }
}

function openSession({ maxPerHour = 0, odooAi = null } = {}) {
    const config = loadConfig({ LLM_PROVIDER: "fake", STT_PROVIDER: "fake", TTS_PROVIDER: "none" }, []);
    const fake = createFakeLlm({ firstTokenMs: 0, chunkMs: 0 });
    const requests = [];
    const llm = { ...fake, stream: (params) => { requests.push(params); return fake.stream(params); } };
    const socket = new FakeSocket();
    new Session({
        socket, config, llm, stt: createFakeStt({ delayMs: 0 }), tts: null, odooAi,
        limiter: new HourlyLimiter(maxPerHour), logger: quietLogger,
    });
    return { socket, requests };
}

const lastQuestion = (request) => request.messages.at(-1).content;

test("a tapped node becomes a question tied to the first one, and starts the new diagram", async () => {
    const { socket, requests } = openSession();
    await socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es" });

    const done = await socket.ask({ type: "ask_node", turn: 2, from: 1, node: "glucosa", language: "es" });
    assert.equal(lastQuestion(requests[1]), [
        "Profundiza en «Glucosa» (id glucosa), un nodo de tu diagrama «La fotosíntesis».",
        `La pregunta inicial fue: «${FIRST_QUESTION}».`,
        "En ese diagrama: Planta → Glucosa (produce).",
        "La duda que dejaste abierta: «¿Adónde va la glucosa?».",
    ].join("\n"));
    // The earlier question and answer go along, as for any follow-up.
    assert.equal(requests[1].messages.length, 3);

    // The tapped node comes first, as it was, without its question.
    const [seeded] = socket.eventsOf(2).filter((event) => event.type === "diagram_step");
    assert.deepEqual(seeded, {
        type: "diagram_step", step: 1, turn: 2, edges: [],
        nodes: [{ id: "glucosa", label: "Glucosa", shape: "box", color: "#E67E22", step: 1, icon: "🍬" }],
    });
    assert.equal(done.type, "done");
    assert.equal(done.diagram.nodes[0].id, "glucosa");
    assert.ok(done.diagram.edges.some((edge) => edge.from === "glucosa" && edge.to === "glucosa_a"));

    // One level further down, the first question is still the one quoted.
    await socket.ask({ type: "ask_node", turn: 3, from: 2, node: "glucosa_b", language: "es" });
    assert.match(lastQuestion(requests[2]), /^Profundiza en «Para qué sirve» \(id glucosa_b\), un nodo de tu diagrama «Más de Glucosa»\./);
    assert.match(lastQuestion(requests[2]), new RegExp(`La pregunta inicial fue: «${FIRST_QUESTION.replace("?", "\\?")}»`));
    assert.match(lastQuestion(requests[2]), /La duda que dejaste abierta: «¿Qué pasaría sin esto\?»/);

    // An older diagram can still be explored (the page went back to it).
    await socket.ask({ type: "ask_node", turn: 4, from: 1, node: "planta", language: "es" });
    assert.match(lastQuestion(requests[3]), /^Profundiza en «Planta» \(id planta\)/);
    assert.doesNotMatch(lastQuestion(requests[3]), /duda/);
});

test("a node no longer kept is node_gone, and Claude is not asked", async () => {
    const { socket, requests } = openSession();
    await socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es" });
    for (const [turn, from, node] of [[2, 9, "glucosa"], [3, 1, "nada"], [4, 1, 7], [5, "1", "glucosa"]]) {
        const error = await socket.ask({ type: "ask_node", turn, from, node, language: "es" });
        assert.deepEqual(error, { type: "error", code: "node_gone", message: MESSAGES.es.errors.node_gone, turn });
    }
    assert.equal(requests.length, 1);
});

test("a new connection goes deeper from the page's copy, checked as Claude's lines are", async () => {
    const first = openSession();
    const done = await first.socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es" });
    await first.socket.ask({ type: "ask_node", turn: 2, from: 1, node: "glucosa", language: "es" });
    const root = { question: FIRST_QUESTION, title: done.diagram.title };

    // The page reconnected, or the server restarted: this session never drew turn 1.
    const { socket, requests } = openSession();
    const reply = await socket.ask({ type: "ask_node", turn: 2, from: 1, node: "glucosa", diagram: done.diagram, root, language: "es" });
    assert.equal(reply.type, "done");
    assert.equal(lastQuestion(requests[0]), lastQuestion(first.requests[1]));
    const seeded = (events) => events.find((event) => event.type === "diagram_step");
    assert.deepEqual(seeded(socket.eventsOf(2)), seeded(first.socket.eventsOf(2)));

    // Labels are cut as Claude's are; without the first question, the title stands for it.
    const nodes = done.diagram.nodes.map((node) => (node.id === "glucosa" ? { ...node, label: "x".repeat(200) } : node));
    await socket.ask({ type: "ask_node", turn: 3, from: 1, node: "glucosa", diagram: { ...done.diagram, nodes }, language: "es" });
    assert.match(lastQuestion(requests[1]), /^Profundiza en «x{27}…» \(id glucosa\)/);
    assert.match(lastQuestion(requests[1]), /La pregunta inicial fue: «La fotosíntesis»/);

    // A copy the server could not have drawn, or without that node, is node_gone.
    const extra = Array.from({ length: 13 - done.diagram.nodes.length }, (_, index) => ({ id: `extra${index}`, label: "Extra" }));
    const withoutNode = done.diagram.nodes.filter((node) => node.id !== "glucosa");
    for (const [turn, copy] of [
        [4, { diagram: { ...done.diagram, nodes: [...done.diagram.nodes, ...extra] }, root }],
        [5, { diagram: { ...done.diagram, nodes: withoutNode }, root }],
        [6, { diagram: "glucosa", root }],
        [7, { diagram: { title: "", nodes: done.diagram.nodes, edges: [] } }],
    ]) {
        const error = await socket.ask({ type: "ask_node", turn, from: 1, node: "glucosa", ...copy, language: "es" });
        assert.equal(error.code, "node_gone", `turn ${turn}`);
    }
    assert.equal(requests.length, 2);
});

test("the server's own diagram wins over the page's copy", async () => {
    const { socket, requests } = openSession();
    const done = await socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es" });
    const nodes = done.diagram.nodes.map((node) => (node.id === "glucosa" ? { ...node, label: "Otra cosa" } : node));
    await socket.ask({
        type: "ask_node", turn: 2, from: 1, node: "glucosa",
        diagram: { ...done.diagram, nodes }, root: { question: "Otra pregunta" }, language: "es",
    });
    assert.match(lastQuestion(requests[1]), /^Profundiza en «Glucosa»/);
    assert.match(lastQuestion(requests[1]), new RegExp(`La pregunta inicial fue: «${FIRST_QUESTION.replace("?", "\\?")}»`));
});

test("each question, typed or tapped, goes at the level the page names", async () => {
    const { socket, requests } = openSession();
    await socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es", level: "expert" });
    await socket.ask({ type: "ask_node", turn: 2, from: 1, node: "glucosa", language: "es", level: "kid" });
    const noteOf = (request) => request.messages.at(-1).content.at(-1).text;
    assert.equal(noteOf(requests[0]), MESSAGES.es.levels.expert);
    assert.equal(noteOf(requests[1]), MESSAGES.es.levels.kid);
});

test("Odoo AI gets a plain question with the first one, not the text for Claude", async () => {
    const odooAi = new RecordingOdooAi({ delayMs: 0 });
    const { socket } = openSession({ odooAi });
    await socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es" });
    await socket.ask({ type: "ask_node", turn: 2, from: 1, node: "glucosa", language: "es", odoo: true });
    await socket.ask({ type: "ask_node", turn: 3, from: 1, node: "planta", language: "es", odoo: true });
    assert.deepEqual(odooAi.questions, [
        `Sobre «${FIRST_QUESTION}»: ¿Adónde va la glucosa?`,
        `Sobre «${FIRST_QUESTION}»: cuéntame más de «Planta».`,
    ]);
});

test("a deeper question counts for the hourly limit", async () => {
    const { socket } = openSession({ maxPerHour: 1 });
    await socket.ask({ type: "ask_text", turn: 1, text: FIRST_QUESTION, language: "es" });
    const error = await socket.ask({ type: "ask_node", turn: 2, from: 1, node: "glucosa", language: "es" });
    assert.equal(error.code, "rate_limited");
});

test("the question follows the language, names up to four connections and quotes a long first question cut", () => {
    const nodes = ["hub", "a", "b", "c", "d", "e"].map((id) => ({ id, label: id.toUpperCase(), shape: "box", color: "#000000", step: 1 }));
    const edges = ["a", "b", "c", "d", "e"].map((id) => ({ from: "hub", to: id, step: 1, ...(id === "a" ? { label: "feeds" } : {}) }));
    const entry = { diagram: { title: "Hub", nodes, edges }, root: { question: "x".repeat(300), title: "Hub" } };
    const { text, odooQuestion } = diveQuestion({ node: nodes[0], entry, language: "en" });
    const lines = text.split("\n");
    assert.equal(lines[0], "Go deeper into “HUB” (id hub), a node of your diagram “Hub”.");
    assert.equal(lines[1], `The first question was: “${"x".repeat(199)}…”.`);
    assert.equal(lines[2], "In that diagram: HUB → A (feeds); HUB → B; HUB → C; HUB → D.");
    assert.equal(lines.length, 3);
    assert.equal(odooQuestion, `About “${"x".repeat(199)}…”: tell me more about “HUB”.`);
});

test("the memory keeps the newest diagrams", () => {
    const memory = new DiagramMemory(2);
    const entry = (title) => ({ diagram: { title, nodes: [{ id: "n", label: "N" }], edges: [] }, root: { question: "q", title } });
    memory.remember(1, entry("one"));
    memory.remember(2, entry("two"));
    memory.remember(1, entry("one again"));
    memory.remember(3, entry("three"));
    assert.equal(memory.get(2), null);
    assert.equal(memory.find(1, "n").entry.diagram.title, "one again");
    assert.equal(memory.find(3, "missing"), null);
    assert.equal(memory.find(3, "n").node.label, "N");
});

// --- On the page ------------------------------------------------------------------

const PHOTOSYNTHESIS = {
    title: "La fotosíntesis",
    nodes: [
        { id: "planta", label: "Planta" },
        { id: "glucosa", label: "Glucosa", hook: "¿Adónde va la glucosa?" },
        { id: "oxigeno", label: "Oxígeno", hook: "¿Quién respira el oxígeno?" },
    ],
    edges: [],
};

test("the page knows each diagram's parent, what was explored and which questions are still open", () => {
    const exploration = new Exploration();
    exploration.begin(1);
    exploration.finish(1, PHOTOSYNTHESIS);
    assert.equal(exploration.parentOf(1), null);
    assert.deepEqual(exploration.hooksOf(1).map((hook) => hook.id), ["glucosa", "oxigeno"]);

    exploration.begin(2, { from: 1, node: "glucosa" });
    assert.equal(exploration.shown, 2);
    // Going back works while the deeper answer is still on its way.
    assert.equal(exploration.parentTitle(2), "La fotosíntesis");
    assert.deepEqual([...exploration.entry(1).explored], ["glucosa"]);
    assert.deepEqual(exploration.hooksOf(1).map((hook) => hook.id), ["oxigeno"]);
    exploration.finish(2, { title: "Más de Glucosa", nodes: [{ id: "glucosa", label: "Glucosa" }], edges: [] });
    assert.equal(exploration.node(2, "glucosa").label, "Glucosa");
    assert.equal(exploration.node(2, "nada"), null);

    // A new question starts a chain of its own.
    exploration.begin(3);
    exploration.finish(3, null);
    assert.equal(exploration.parentOf(3), null);
    assert.deepEqual(exploration.hooksOf(3), []);
});

test("the page forgets the oldest diagrams, and a forgotten parent ends the way back", () => {
    const exploration = new Exploration(2);
    exploration.begin(1);
    exploration.finish(1, PHOTOSYNTHESIS);
    exploration.begin(2, { from: 1, node: "planta" });
    exploration.begin(3, { from: 2, node: "x" });
    assert.equal(exploration.entry(1), null);
    assert.equal(exploration.parentOf(2), null);
});

test("the page keeps what each answer said, and the diagram a node already gave", () => {
    const exploration = new Exploration();
    exploration.begin(1);
    exploration.addSentence(1, 1, "Uno.");
    exploration.speechStart(1, 1, 24000);
    exploration.speechChunk(1, 1, new Int16Array([1, 2]));
    exploration.speechChunk(1, 2, new Int16Array([3])); // no speech started for step 2: dropped
    assert.equal(exploration.replayable(1), false, "not before it is done");
    exploration.finish(1, PHOTOSYNTHESIS);
    assert.equal(exploration.replayable(1), true);
    assert.deepEqual([...exploration.entry(1).speech.get(1).chunks[0]], [1, 2]);
    assert.equal(exploration.entry(1).speech.has(2), false);

    assert.equal(exploration.childOf(1, "glucosa"), null);
    exploration.begin(2, { from: 1, node: "glucosa" });
    assert.equal(exploration.childOf(1, "glucosa"), null, "not until it arrived");
    exploration.finish(2, { title: "Más", nodes: [{ id: "glucosa", label: "Glucosa" }], edges: [] });
    assert.equal(exploration.childOf(1, "glucosa").turnId, 2);
    assert.equal(exploration.childOf(1, "planta"), null);
    // A refused answer has no diagram: nothing to say again.
    exploration.begin(3);
    exploration.addSentence(3, 1, "Prefiero no responder.");
    exploration.finish(3, null);
    assert.equal(exploration.replayable(3), false);
});

test("the path above a diagram names every diagram up the chain, and its labels lead back to them", () => {
    const exploration = new Exploration();
    const diagram = (title) => ({ title, nodes: [{ id: "a" }, { id: "b" }], edges: [] });
    exploration.begin(1);
    exploration.finish(1, diagram("La fotosíntesis"));
    exploration.begin(2, { from: 1, node: "a" });
    exploration.finish(2, diagram("Más de Glucosa"));
    exploration.begin(3, { from: 2, node: "b" });
    exploration.finish(3, diagram("La respiración"));
    assert.deepEqual(exploration.pathTo(1), []);
    assert.deepEqual(exploration.pathTo(3), [{ turnId: 1, title: "La fotosíntesis" }, { turnId: 2, title: "Más de Glucosa" }]);
    // Where the user left nodes is kept per diagram, empty at first.
    assert.equal(exploration.entry(3).pins.size, 0);

    assert.equal(crumbTurn(crumbId(12)), 12);
    for (const other of ["glucosa", "<crumb:x>", "<crumb:3", 7, null]) {
        assert.equal(crumbTurn(other), null, String(other));
    }
    const long = [1, 2, 3, 4, 5].map((turnId) => ({ turnId, title: `T${turnId}` }));
    assert.deepEqual(visibleCrumbs(long).map((crumb) => crumb.title), ["T1", "…", "T4", "T5"]);
    assert.equal(visibleCrumbs(long)[1].turnId, null, "the dots lead nowhere");
    assert.deepEqual(visibleCrumbs(long.slice(0, 3)), long.slice(0, 3));
});

test("the level goes round child, normal, expert, and tells its listeners", () => {
    assert.deepEqual(LEVELS, ["kid", "normal", "expert"]);
    assert.equal(level(), "normal");
    const heard = [];
    const stop = onLevelChange(() => heard.push(level()));
    try {
        setLevel(nextLevel());
        setLevel(nextLevel());
        setLevel("wizard");
        setLevel(nextLevel());
        assert.deepEqual(heard, ["expert", "kid", "normal"]);
    } finally {
        stop();
        setLevel("normal");
    }
});
