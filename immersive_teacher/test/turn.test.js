import assert from "node:assert/strict";
import { test } from "node:test";

import { ConversationHistory } from "../server/src/history.js";
import { createFakeLlm } from "../server/src/llm/fake.js";
import { REFUSAL_SENTENCE } from "../server/src/llm/system_prompt.js";
import { MAX_SENTENCES, runTurn } from "../server/src/turn.js";

const quietLogger = { info() {}, warn() {}, error() {} };

function scriptedLlm(events) {
    return {
        name: "scripted",
        model: "scripted",
        async *stream() {
            yield* events;
        },
    };
}

async function run({ llm, question = "¿Qué es la fotosíntesis?", history = new ConversationHistory(4), signal }) {
    const events = [];
    const result = await runTurn({
        id: 1,
        input: { text: question },
        llm,
        history,
        emit: (event) => events.push(event),
        signal,
        logger: quietLogger,
    });
    return { result, events, history };
}

test("a full fake answer arrives in order, with steps from the sentences", async () => {
    const { result, events, history } = await run({ llm: createFakeLlm({ firstTokenMs: 0, chunkMs: 0 }) });
    assert.equal(result.status, "done");
    const types = events.map((event) => (event.step ? `${event.type}:${event.step}` : event.type));
    assert.deepEqual(types, [
        "transcript", "title",
        "sentence:1", "diagram_step:1", "sentence:2", "diagram_step:2", "sentence:3", "diagram_step:3",
        "sentence:4", "diagram_step:4", "sentence:5", "diagram_step:5",
        "done",
    ]);
    const done = events.at(-1);
    assert.equal(done.diagram.title, "La fotosíntesis");
    assert.equal(done.diagram.nodes.length, 6);
    assert.equal(done.diagram.edges.length, 5);
    assert.ok(done.timings.first_sentence >= 0);
    assert.equal(history.turns.length, 1);
    assert.match(history.turns[0].answer, /^TITLE: La fotosíntesis\nSAY: /);
});

test("broken diagram lines do not stop the speech", async () => {
    const { events } = await run({
        llm: createFakeLlm({ firstTokenMs: 0, chunkMs: 0 }),
        question: "muéstrame una respuesta con error",
    });
    const sentences = events.filter((event) => event.type === "sentence");
    assert.equal(sentences.length, 4);
    const done = events.at(-1);
    assert.equal(done.type, "done");
    assert.deepEqual(done.diagram.nodes.map((node) => node.id), ["inicio", "medio", "fin"]);
    assert.deepEqual(done.diagram.nodes[1], { id: "medio", label: "Medio", shape: "box", color: "#F5B700", step: 3 });
    assert.deepEqual(done.diagram.edges.map((edge) => `${edge.from}>${edge.to}`), ["inicio>medio", "medio>fin"]);
});

test("a line cut by max_tokens is dropped, the rest is kept", async () => {
    const { events } = await run({
        llm: scriptedLlm([
            { type: "text", text: "TITLE: Corte\nSAY: Frase completa.\nSAY: Frase cort" },
            { type: "end", stopReason: "max_tokens", usage: {} },
        ]),
    });
    assert.deepEqual(events.filter((e) => e.type === "sentence").map((e) => e.text), ["Frase completa."]);
    assert.equal(events.at(-1).stopReason, "max_tokens");
});

test("a refusal still says something", async () => {
    const { events, history } = await run({ llm: scriptedLlm([{ type: "end", stopReason: "refusal" }]) });
    assert.deepEqual(events.filter((e) => e.type === "sentence").map((e) => e.text), [REFUSAL_SENTENCE]);
    assert.equal(events.at(-1).type, "done");
    assert.equal(history.turns.length, 0);
});

test("an answer without sentences is an error", async () => {
    const { result, events } = await run({ llm: scriptedLlm([{ type: "end", stopReason: "end_turn" }]) });
    assert.equal(result.code, "empty_answer");
    assert.equal(events.at(-1).type, "error");
});

test("more sentences than the cap cut the stream", async () => {
    const lines = Array.from({ length: MAX_SENTENCES + 3 }, (_, i) => `SAY: Frase ${i + 1}.`).join("\n");
    let pulledAfterCut = false;
    const llm = {
        name: "long",
        model: "long",
        async *stream() {
            yield { type: "text", text: `${lines}\n` };
            pulledAfterCut = true;
            yield { type: "end", stopReason: "end_turn" };
        },
    };
    const { events } = await run({ llm });
    assert.equal(events.filter((e) => e.type === "sentence").length, MAX_SENTENCES);
    assert.equal(events.at(-1).stopReason, "sentence_limit");
    assert.equal(pulledAfterCut, false);
});

test("cancelling stops the turn without done and without history", async () => {
    const controller = new AbortController();
    const llm = createFakeLlm({ firstTokenMs: 0, chunkMs: 5 });
    setTimeout(() => controller.abort(new Error("user")), 60);
    const { result, events, history } = await run({ llm, signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.ok(!events.some((event) => event.type === "done"));
    assert.equal(history.turns.length, 0);
});

test("llm errors become a code the browser understands", async () => {
    const llm = {
        name: "down",
        model: "down",
        async *stream() {
            throw Object.assign(new Error("overloaded"), { code: "llm_unavailable" });
        },
    };
    const { result, events } = await run({ llm });
    assert.equal(result.code, "llm_unavailable");
    assert.equal(events.at(-1).code, "llm_unavailable");
});

test("history keeps the last turns only", () => {
    const history = new ConversationHistory(2);
    history.add("q1", "a1");
    history.add("q2", "a2");
    history.add("q3", "a3");
    assert.deepEqual(history.messagesFor("q4").map((m) => m.content), ["q2", "a2", "q3", "a3", "q4"]);
});
