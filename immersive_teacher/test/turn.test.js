import assert from "node:assert/strict";
import { test } from "node:test";

import { ConversationHistory } from "../server/src/history.js";
import { LANGUAGES, MESSAGES } from "../server/src/i18n.js";
import { createFakeLlm } from "../server/src/llm/fake.js";
import { SYSTEM_PROMPTS } from "../server/src/llm/system_prompt.js";
import { MAX_SENTENCES, runTurn } from "../server/src/turn.js";

const quietLogger = { info() {}, warn() {}, error() {} };
const APOLOGIES = MESSAGES.es.apologies;

function scriptedLlm(events) {
    return {
        name: "scripted",
        model: "scripted",
        async *stream() {
            yield* events;
        },
    };
}

async function run({ llm, question = "¿Qué es la fotosíntesis?", language, history = new ConversationHistory(4), signal }) {
    const events = [];
    const result = await runTurn({
        id: 1,
        input: { text: question },
        language,
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
        // The question left open: no drawing.
        "sentence:6",
        "done",
    ]);
    const done = events.at(-1);
    assert.equal(done.diagram.title, "La fotosíntesis");
    assert.equal(done.diagram.nodes.length, 6);
    assert.equal(done.diagram.edges.length, 5);
    assert.deepEqual(done.diagram.nodes.filter((node) => node.hook).map((node) => [node.id, node.hook]), [
        ["glucosa", "¿Adónde va la glucosa?"],
    ]);
    assert.deepEqual(result, { status: "done", question: "¿Qué es la fotosíntesis?", diagram: done.diagram });
    assert.match(history.turns[0].answer, /"hook":"¿Adónde va la glucosa\?"/);
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
    assert.deepEqual(events.filter((e) => e.type === "sentence").map((e) => e.text), [MESSAGES.es.refusal]);
    assert.equal(events.at(-1).type, "done");
    assert.equal(history.turns.length, 0);
});

test("an answer without sentences is an error", async () => {
    const { result, events } = await run({ llm: scriptedLlm([{ type: "end", stopReason: "end_turn" }]) });
    assert.equal(result.code, "empty_answer");
    assert.equal(events.at(-1).type, "error");
    assert.equal(events.at(-2).text, APOLOGIES.explain);
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

test("a failure mid-answer keeps what was said, apologizes, then reports", async () => {
    const llm = {
        name: "flaky",
        model: "flaky",
        async *stream() {
            yield { type: "text", text: "TITLE: Agua\nSAY: Primera frase.\nSAY: Segunda frase.\n" };
            throw Object.assign(new Error("connection reset"), { code: "llm_network" });
        },
    };
    const { result, events, history } = await run({ llm });
    assert.equal(result.code, "llm_network");
    const said = events.filter((e) => e.type === "sentence");
    assert.deepEqual(said.map((e) => [e.step, e.text, e.kind]), [
        [1, "Primera frase.", undefined],
        [2, "Segunda frase.", undefined],
        [3, APOLOGIES.think, "apology"],
    ]);
    const error = events.at(-1);
    assert.equal(error.type, "error");
    assert.equal(error.apologized, true);
    assert.equal(history.turns.length, 0, "a failed answer is not remembered");
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
    assert.equal(events.at(-2).text, APOLOGIES.think);
});

test("history keeps the last turns only", () => {
    const history = new ConversationHistory(2);
    history.add("q1", "a1");
    history.add("q2", "a2");
    history.add("q3", "a3");
    assert.deepEqual(history.messagesFor("q4").map((m) => m.content), ["q2", "a2", "q3", "a3", "q4"]);
});

test("an English question gets the English prompt, answer and apology", async () => {
    let request = null;
    const fake = createFakeLlm({ firstTokenMs: 0, chunkMs: 0 });
    const llm = { ...fake, stream: (params) => { request = params; return fake.stream(params); } };
    const { result, events } = await run({ llm, question: "How do plants do photosynthesis?", language: "en" });
    assert.equal(result.status, "done");
    assert.equal(request.system, SYSTEM_PROMPTS.en);
    assert.equal(request.language, "en");
    assert.equal(events.find((e) => e.type === "title").text, "Photosynthesis");

    const failing = await run({ llm: scriptedLlm([{ type: "end", stopReason: "end_turn" }]), language: "en" });
    assert.equal(failing.events.at(-2).text, MESSAGES.en.apologies.explain);
    assert.equal(failing.events.at(-1).message, MESSAGES.en.errors.empty_answer);
});

test("both languages say the same things and have their own prompt", () => {
    const shape = (messages) => Object.entries(messages).map(([key, value]) => (
        typeof value === "object" ? `${key}:${Object.keys(value).sort().join(",")}` : key
    ));
    for (const language of LANGUAGES) {
        assert.deepEqual(shape(MESSAGES[language]), shape(MESSAGES.es), `messages in ${language}`);
        assert.ok(SYSTEM_PROMPTS[language].length > 2000, `system prompt in ${language}`);
    }
    // Each prompt pins its own language, whatever the history says.
    assert.match(SYSTEM_PROMPTS.es, /Responde siempre en español/);
    assert.match(SYSTEM_PROMPTS.en, /Always answer in English/);
});

test("a level other than normal adds its note after the question, for this request only", async () => {
    const requests = [];
    const fake = createFakeLlm({ firstTokenMs: 0, chunkMs: 0 });
    const llm = { ...fake, stream: (params) => { requests.push(params); return fake.stream(params); } };
    const history = new ConversationHistory(4);
    const ask = (level, question) => runTurn({
        id: requests.length + 1, input: { text: question }, language: "es", level, llm, history,
        emit() {}, logger: quietLogger,
    });

    await ask("kid", "¿Qué es la fotosíntesis?");
    assert.deepEqual(requests[0].messages.at(-1).content, [
        { type: "text", text: "¿Qué es la fotosíntesis?" },
        { type: "text", text: MESSAGES.es.levels.kid },
    ]);
    // The history keeps the question alone, and "normal" (or anything unknown) adds nothing.
    await ask("normal", "¿Y las plantas de noche?");
    assert.equal(requests[1].messages[0].content, "¿Qué es la fotosíntesis?");
    assert.equal(requests[1].messages.at(-1).content, "¿Y las plantas de noche?");
    await ask("wizard", "¿Y en invierno?");
    assert.equal(requests[2].messages.at(-1).content, "¿Y en invierno?");
    for (const language of LANGUAGES) {
        assert.deepEqual(Object.keys(MESSAGES[language].levels), ["kid", "expert"]);
    }
});

test("a citation goes with the sentence that holds its text, once per place", async () => {
    const page = (start, end) => ({
        type: "page_location", document_index: 0, document_title: "Manual.pdf",
        start_page_number: start, end_page_number: end, cited_text: "  El pedido\nse confirma.  ",
    });
    const { events } = await run({
        llm: scriptedLlm([
            { type: "text", text: "TITLE: Pedidos\nSAY: Primero se crea el pedido." },
            // Its text starts after the line break: it belongs to the second sentence.
            { type: "citation", citation: page(4, 5) },
            { type: "text", text: "\nSAY: Luego " },
            { type: "citation", citation: page(4, 5) },
            { type: "citation", citation: { ...page(6, 8), document_title: null, document_index: 1 } },
            { type: "text", text: "se confirma.\n" },
            { type: "end", stopReason: "end_turn" },
        ]),
    });
    const citations = events.filter((event) => event.type === "citation");
    assert.deepEqual(citations, [
        { type: "citation", step: 2, source: "Manual.pdf", pages: { from: 4, to: 4 }, quote: "El pedido se confirma." },
        { type: "citation", step: 2, source: "#2", pages: { from: 6, to: 7 }, quote: "El pedido se confirma." },
    ]);
    // Right after its sentence, before the next one.
    const types = events.map((event) => (event.step ? `${event.type}:${event.step}` : event.type));
    assert.deepEqual(types.slice(types.indexOf("sentence:2"), types.indexOf("sentence:2") + 3), ["sentence:2", "citation:2", "citation:2"]);
});

test("the person's documents are cited by the fake as Claude does, with the pages of a PDF", async () => {
    const history = new ConversationHistory(4);
    const text = { type: "document", source: { type: "text", media_type: "text/plain", data: "Guía de pedidos de venta." },
        title: "Guía", citations: { enabled: true } };
    const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
        title: "Manual.pdf", citations: { enabled: true } };
    for (const [document, expected] of [
        [text, { source: "Guía", pages: null, quote: "Guía de pedidos de venta." }],
        [pdf, { source: "Manual.pdf", pages: { from: 1, to: 1 }, quote: "" }],
    ]) {
        const events = [];
        await runTurn({
            id: 1, input: { text: "Explícame el documento" }, language: "es", llm: createFakeLlm({ firstTokenMs: 0, chunkMs: 0 }),
            history, sources: [document], emit: (event) => events.push(event), logger: quietLogger,
        });
        assert.deepEqual(events.filter((event) => event.type === "citation"), [{ type: "citation", step: 2, ...expected }]);
    }
});
