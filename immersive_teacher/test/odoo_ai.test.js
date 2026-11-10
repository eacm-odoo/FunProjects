/**
 * Odoo AI: the adapter against a local stand-in of odoo.com's route, the turn
 * that asks it before Claude, and the session that passes the switch along.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { test } from "node:test";

import { plainMarkdown } from "../client/src/ui/desktop_panel.js";
import { ConfigError, loadConfig } from "../server/src/config.js";
import { ConversationHistory } from "../server/src/history.js";
import { MESSAGES } from "../server/src/i18n.js";
import { HourlyLimiter } from "../server/src/limits.js";
import { createFakeLlm } from "../server/src/llm/fake.js";
import { FakeOdooAi, MAX_PROMPT_CHARS, ODOO_AI_URL, OdooAi, OdooAiError, OdooHistory } from "../server/src/odoo_ai.js";
import { Session } from "../server/src/session.js";
import { createFakeStt } from "../server/src/speech/stt/fake.js";
import { ODOO_UNREACHED, runTurn } from "../server/src/turn.js";

const quietLogger = { info() {}, warn() {}, error() {} };

/** A local stand-in of /help/generate_text: `reply(body, res)` answers each request. */
async function standIn(reply) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            requests.push({ body, headers: req.headers });
            reply(body, res);
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}/help/generate_text`,
        requests,
        close: () => new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
        }),
    };
}

function json(res, payload, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

const ANSWER = {
    parts: [
        { text: "Para activar **FIFO**:\n\n1. Abre **Inventario**.\n", thoughtSignature: "sig-1", extra: "dropped" },
        { text: "2. Ve a *Configuración ‣ Categorías de producto*." },
    ],
    grounding: [
        { retrievedContext: { uri: "https://www.odoo.com/documentation/19.0/fifo.html", title: "FIFO  removal", text: "…" } },
        { retrievedContext: { uri: "https://www.odoo.com/documentation/19.0/fifo.html", title: "Same page again" } },
        { retrievedContext: { uri: "javascript:alert(1)", title: "Not a page" } },
        { retrievedContext: { uri: "https://www.odoo.com/documentation/19.0/valuation.html" } },
        { somethingElse: true },
    ],
};

// --- The adapter ------------------------------------------------------------

test("Odoo AI is asked with JSON-RPC and the history, and its answer comes back clean", async () => {
    const site = await standIn((body, res) => json(res, { jsonrpc: "2.0", id: body.id, result: ANSWER }));
    try {
        const odoo = new OdooAi({ url: site.url });
        const earlier = [{ role: "user", parts: [{ text: "Hola" }] }, { role: "model", parts: [{ text: "¡Hola!", thoughtSignature: "s0" }] }];
        const answer = await odoo.ask(`¿Cómo activo FIFO?${" relleno".repeat(100)}`, { history: earlier });

        const [{ body, headers }] = site.requests;
        assert.equal(body.jsonrpc, "2.0");
        assert.equal(body.method, "call");
        const history = body.params.conversation_history;
        assert.deepEqual(history.slice(0, 2), earlier);
        assert.equal(history[2].role, "user");
        assert.equal(history[2].parts[0].text.length, MAX_PROMPT_CHARS, "cut to the help page's limit");
        assert.match(headers["user-agent"], /^ImmersiveTeacher\//);
        assert.equal(headers["content-type"], "application/json");

        assert.equal(answer.text, "Para activar **FIFO**:\n\n1. Abre **Inventario**.\n2. Ve a *Configuración ‣ Categorías de producto*.");
        assert.deepEqual(answer.links, [
            { title: "FIFO removal", uri: "https://www.odoo.com/documentation/19.0/fifo.html" },
            { title: "www.odoo.com", uri: "https://www.odoo.com/documentation/19.0/valuation.html" },
        ]);
        // The answer goes back in the next request as it came, signature included, extras dropped.
        assert.deepEqual(answer.exchange[1], {
            role: "model",
            parts: [{ text: ANSWER.parts[0].text, thoughtSignature: "sig-1" }, { text: ANSWER.parts[1].text }],
        });
        assert.deepEqual(answer.exchange[0], history[2]);
    } finally {
        await site.close();
    }
});

test("Odoo AI failures come back with a code: RPC error, HTTP status, empty, not JSON, too big", async () => {
    const replies = {
        rpc: (body, res) => json(res, { jsonrpc: "2.0", id: body.id, error: { message: "Odoo Server Error", data: { message: "Too many requests" } } }),
        status: (body, res) => json(res, { error: "no" }, 403),
        empty: (body, res) => json(res, { jsonrpc: "2.0", id: body.id, result: { parts: [{ text: "  " }], grounding: [] } }),
        noParts: (body, res) => json(res, { jsonrpc: "2.0", id: body.id, result: {} }),
        html: (body, res) => {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<html>login</html>");
        },
        huge: (body, res) => json(res, { jsonrpc: "2.0", id: body.id, result: { parts: [{ text: "x".repeat(1100 * 1024) }] } }),
    };
    let mode = "rpc";
    const site = await standIn((body, res) => replies[mode](body, res));
    const odoo = new OdooAi({ url: site.url });
    const failure = async () => {
        try {
            await odoo.ask("¿Qué es FIFO?");
        } catch (error) {
            return error;
        }
        assert.fail(`${mode}: no error`);
    };
    try {
        const expected = {
            rpc: ["odoo_ai_failed", /Too many requests/],
            status: ["odoo_ai_failed", /HTTP 403/],
            empty: ["odoo_ai_empty", /no text/],
            noParts: ["odoo_ai_failed", /no parts/],
            html: ["odoo_ai_failed", /not JSON/],
            huge: ["odoo_ai_failed", /larger than/],
        };
        for (const [name, [code, message]] of Object.entries(expected)) {
            mode = name;
            const error = await failure();
            assert.ok(error instanceof OdooAiError, `${name}: ${error}`);
            assert.equal(error.code, code, name);
            assert.match(error.message, message, name);
        }
    } finally {
        await site.close();
    }
});

test("Odoo AI times out on its own, but a cancelled turn stays a cancellation", async () => {
    const site = await standIn(() => {}); // never answers
    try {
        const slow = new OdooAi({ url: site.url, timeoutMs: 80 });
        await assert.rejects(slow.ask("¿Hola?"), (error) => error instanceof OdooAiError && error.code === "odoo_ai_timeout");

        const controller = new AbortController();
        const asking = new OdooAi({ url: site.url, timeoutMs: 5000 }).ask("¿Hola?", { signal: controller.signal });
        setTimeout(() => controller.abort(new Error("cancelled by the user")), 30);
        await assert.rejects(asking, (error) => !(error instanceof OdooAiError));
    } finally {
        await site.close();
    }
});

test("an unreachable Odoo AI is a failure, not a crash", async () => {
    const odoo = new OdooAi({ url: "http://127.0.0.1:9/help/generate_text" });
    await assert.rejects(odoo.ask("¿Hola?"), (error) => error instanceof OdooAiError && error.code === "odoo_ai_failed");
});

test("Odoo AI's history keeps the last turns, and none with HISTORY_TURNS=0", () => {
    const history = new OdooHistory(2);
    for (const n of [1, 2, 3]) {
        history.add([{ role: "user", parts: [{ text: `q${n}` }] }, { role: "model", parts: [{ text: `a${n}` }] }]);
    }
    assert.deepEqual(history.entries.map((entry) => entry.parts[0].text), ["q2", "a2", "q3", "a3"]);
    const none = new OdooHistory(0);
    none.add([{ role: "user", parts: [] }, { role: "model", parts: [] }]);
    assert.deepEqual(none.entries, []);
});

test("ODOO_AI and ODOO_AI_URL are read and checked", () => {
    const base = { LLM_PROVIDER: "fake", STT_PROVIDER: "fake", TTS_PROVIDER: "none" };
    assert.deepEqual({ ...loadConfig(base, []).odooAi }, { mode: "on", url: ODOO_AI_URL });
    assert.equal(loadConfig({ ...base, ODOO_AI: "fake" }, []).odooAi.mode, "fake");
    assert.equal(loadConfig({ ...base, ODOO_AI_URL: "http://127.0.0.1:8069/help/generate_text" }, []).odooAi.url,
        "http://127.0.0.1:8069/help/generate_text");
    assert.throws(() => loadConfig({ ...base, ODOO_AI: "maybe" }, []), ConfigError);
    assert.throws(() => loadConfig({ ...base, ODOO_AI_URL: "ftp://odoo.com/x" }, []), ConfigError);
    assert.throws(() => loadConfig({ ...base, ODOO_AI_URL: "not a url" }, []), ConfigError);
});

// --- In a turn ----------------------------------------------------------------

/** The fake LLM, recording what each request carried. */
function recordingLlm(options = {}) {
    const fake = createFakeLlm({ firstTokenMs: 0, chunkMs: 0, ...options });
    const requests = [];
    return { requests, llm: { ...fake, stream: (params) => { requests.push(params); return fake.stream(params); } } };
}

async function runWithOdoo({ odooAi, llm, sources = [], signal, odooHistory = new OdooHistory(4), logger = quietLogger }) {
    const events = [];
    const history = new ConversationHistory(4);
    const result = await runTurn({
        id: 1,
        input: { text: "¿Cómo activo FIFO en Inventario?" },
        language: "es",
        llm,
        history,
        sources,
        odooAi,
        odooHistory,
        emit: (event) => events.push(event),
        signal,
        logger,
    });
    return { result, events, history, odooHistory };
}

test("with Odoo AI the teacher explains Odoo AI's answer, without announcing it", async () => {
    const { llm, requests } = recordingLlm();
    const lines = [];
    const logger = { ...quietLogger, info: (line) => lines.push(line) };
    const source = { type: "document", source: { type: "text", media_type: "text/plain", data: "Notas" }, title: "notas.md" };
    const { result, events, history, odooHistory } = await runWithOdoo({
        odooAi: new FakeOdooAi({ delayMs: 0 }), llm, sources: [source], logger,
    });

    assert.equal(result.status, "done");
    const types = events.map((event) => (event.step ? `${event.type}:${event.step}` : event.type));
    assert.deepEqual(types.slice(0, 4), ["transcript", "odoo_answer", "title", "sentence:1"]);
    assert.match(events[1].text, /Respuesta de prueba de Odoo AI/);
    assert.deepEqual(events[1].links, [{ title: "Odoo documentation", uri: "https://www.odoo.com/documentation/" }]);
    assert.match(events[3].text, /^Esto es lo que hay que hacer/, "the fake's explanation of Odoo AI's answer");
    assert.ok(events.every((event) => !event.kind), "no extra sentence before Claude's");
    assert.equal(events.at(-1).type, "done");

    // One message: the user's source first (cached), then Odoo AI's answer, then the question.
    const [{ messages }] = requests;
    assert.equal(messages.length, 1);
    const content = messages[0].content;
    assert.deepEqual(content.map((block) => block.title ?? block.type), ["notas.md", "Odoo AI", "text"]);
    assert.match(content[1].source.data, /Sources:\n- Odoo documentation: https:\/\/www\.odoo\.com\/documentation\//);
    assert.equal(content[2].text, "¿Cómo activo FIFO en Inventario?");

    // Claude's history keeps the plain question; Odoo AI's history gets the exchange.
    assert.equal(history.turns[0].question, "¿Cómo activo FIFO en Inventario?");
    assert.equal(odooHistory.entries.length, 2);
    assert.match(lines.at(-1), /odoo=ok/);
    assert.match(lines.at(-1), /odoo_ai=\+\d+ms/);
});

test("a follow-up sends Odoo AI the earlier exchange, and Claude only the new answer", async () => {
    const asked = [];
    const odooAi = { name: "spy", async ask(question, { history }) {
        asked.push(history.length);
        return { text: `Respuesta a ${question}`, links: [], exchange: [{ role: "user", parts: [{ text: question }] }, { role: "model", parts: [{ text: "r" }] }] };
    } };
    const { llm, requests } = recordingLlm();
    const odooHistory = new OdooHistory(4);
    const history = new ConversationHistory(4);
    for (const text of ["¿Qué es FIFO?", "¿Y cómo lo activo?"]) {
        await runTurn({ id: 1, input: { text }, language: "es", llm, history, odooAi, odooHistory, emit() {}, logger: quietLogger });
    }
    assert.deepEqual(asked, [0, 2]);
    const second = requests[1].messages;
    assert.equal(second.length, 3, "question, answer, follow-up");
    assert.equal(typeof second[0].content, "string", "the earlier question goes without its Odoo AI answer");
    assert.deepEqual(second[2].content.map((block) => block.title ?? block.type), ["Odoo AI", "text"]);
});

test("when Odoo AI fails, a warning says so and the teacher answers on its own", async () => {
    const { llm, requests } = recordingLlm();
    const odooAi = { name: "down", async ask() {
        throw new OdooAiError("odoo_ai_timeout", "no answer after 30 s");
    } };
    const { result, events, odooHistory } = await runWithOdoo({ odooAi, llm });
    assert.equal(result.status, "done");
    const warning = events.find((event) => event.type === "warning");
    assert.deepEqual(warning, { type: "warning", code: "odoo_ai_timeout", message: MESSAGES.es.warnings.odoo_ai_timeout });
    assert.ok(!events.some((event) => event.type === "odoo_answer"));
    assert.deepEqual(requests[0].messages[0].content[0], ODOO_UNREACHED);
    assert.deepEqual(odooHistory.entries, []);

    // Any other error is an odoo_ai_failed warning.
    const broken = { name: "broken", async ask() {
        throw new TypeError("boom");
    } };
    const other = await runWithOdoo({ odooAi: broken, llm: recordingLlm().llm });
    assert.equal(other.events.find((event) => event.type === "warning").code, "odoo_ai_failed");
});

test("cancelling while Odoo AI thinks ends the turn before Claude", async () => {
    const { llm, requests } = recordingLlm();
    const controller = new AbortController();
    const odooAi = new FakeOdooAi({ delayMs: 5000 });
    setTimeout(() => controller.abort(new Error("cancelled by the user")), 30);
    const { result, events } = await runWithOdoo({ odooAi, llm, signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(requests.length, 0);
    assert.ok(!events.some((event) => event.type === "warning" || event.type === "error"));
});

test("Claude saying nothing after Odoo AI answered is an empty answer", async () => {
    const llm = { name: "silent", model: "silent", async *stream() {
        yield { type: "end", stopReason: "end_turn" };
    } };
    const { result, events } = await runWithOdoo({ odooAi: new FakeOdooAi({ delayMs: 0 }), llm });
    assert.deepEqual(result, { status: "error", code: "empty_answer" });
    assert.equal(events.at(-1).type, "error");
});

// --- Through a session ----------------------------------------------------------

class FakeSocket extends EventEmitter {
    readyState = 1; // OPEN
    sent = [];
    waiters = [];

    send(data, options) {
        const message = options?.binary ? { type: "binary" } : JSON.parse(data);
        this.sent.push(message);
        this.waiters = this.waiters.filter(({ type, resolve }) => (message.type === type ? (resolve(message), false) : true));
    }

    next(type) {
        return new Promise((resolve) => this.waiters.push({ type, resolve }));
    }

    fromBrowser(message, isBinary = false) {
        this.emit("message", isBinary ? message : Buffer.from(JSON.stringify(message)), isBinary);
    }
}

function openSession(odooAi) {
    const config = loadConfig({ LLM_PROVIDER: "fake", STT_PROVIDER: "fake", TTS_PROVIDER: "none" }, []);
    const { llm, requests } = recordingLlm();
    const socket = new FakeSocket();
    new Session({
        socket, config, llm, stt: createFakeStt({ delayMs: 0, text: "¿Cómo activo FIFO?" }), tts: null, odooAi,
        limiter: new HourlyLimiter(0), logger: quietLogger,
    });
    return { socket, requests };
}

const odooTitles = (request) => {
    const { content } = request.messages.at(-1);
    return typeof content === "string" ? [] : content.filter((block) => block.type === "document").map((block) => block.title);
};

test("a session asks Odoo AI only for questions that ask for it, typed or spoken", async () => {
    const { socket, requests } = openSession(new FakeOdooAi({ delayMs: 0 }));
    assert.equal(socket.sent[0].odooAi, true);

    let done = socket.next("done");
    socket.fromBrowser({ type: "ask_text", turn: 1, text: "¿Qué es FIFO?", language: "es" });
    await done;
    assert.deepEqual(odooTitles(requests[0]), []);

    done = socket.next("done");
    socket.fromBrowser({ type: "ask_text", turn: 2, text: "¿Cómo activo FIFO?", language: "es", odoo: true });
    await done;
    assert.deepEqual(odooTitles(requests[1]), ["Odoo AI"]);
    assert.ok(socket.sent.some((event) => event.type === "odoo_answer" && event.turn === 2));

    done = socket.next("done");
    socket.fromBrowser({ type: "ask_audio", turn: 3, mime: "audio/webm;codecs=opus", language: "es", odoo: true });
    socket.fromBrowser(Buffer.from("fake opus"), true);
    await done;
    assert.deepEqual(odooTitles(requests[2]), ["Odoo AI"]);

    // Only `true` counts.
    done = socket.next("done");
    socket.fromBrowser({ type: "ask_text", turn: 4, text: "¿Y AVCO?", language: "es", odoo: "yes" });
    await done;
    assert.deepEqual(odooTitles(requests[3]), []);
});

test("without Odoo AI on the server the flag is ignored and the page hides the switch", async () => {
    const { socket, requests } = openSession(null);
    assert.equal(socket.sent[0].odooAi, false);
    const done = socket.next("done");
    socket.fromBrowser({ type: "ask_text", turn: 1, text: "¿Cómo activo FIFO?", language: "es", odoo: true });
    await done;
    assert.deepEqual(odooTitles(requests[0]), []);
    assert.ok(!socket.sent.some((event) => event.type === "odoo_answer"));
});

// --- On the page ------------------------------------------------------------------

test("the panel shows Odoo AI's markdown as plain text", () => {
    const text = "Usa **Método de coste** (*Costing Method*).\n\n* Paso uno\n- Paso dos\n## Nota\n*Nota adicional:* nada";
    assert.equal(plainMarkdown(text), "Usa Método de coste (Costing Method).\n\n- Paso uno\n- Paso dos\nNota\nNota adicional: nada");
});
