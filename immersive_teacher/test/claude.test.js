/**
 * The real Claude adapter (official SDK) against a local stand-in for the
 * Messages API that streams server-sent events at a chosen pace: the watchdog
 * cuts a silent stream and leaves a slow but living one alone.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";

import { createClaudeLlm } from "../server/src/llm/claude.js";

const CONFIG = { apiKey: "sk-test", model: "claude-sonnet-5-5", effort: "low", thinking: "adaptive", fallbacks: false, maxTokens: 1000 };
const MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: CONFIG.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `script(send)` writes the events of one response, at its own pace. */
let script = async () => {};
/** Requests to count_tokens: path and body. */
const counted = [];
const sockets = new Set();
const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
        if (req.url.includes("count_tokens")) {
            counted.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ input_tokens: 4321 }));
            return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (data) => {
            if (!res.destroyed) {
                res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
            }
        };
        await script(send);
        res.end();
    });
});
server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;
after(() => {
    for (const socket of sockets) {
        socket.destroy();
    }
    server.close();
});

async function collect(llm, signal) {
    let text = "";
    for await (const event of llm.stream({ system: "SYS", messages: [{ role: "user", content: "hola" }], signal })) {
        if (event.type === "text") {
            text += event.text;
        }
    }
    return text;
}

function textEvents(text) {
    return [
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
    ];
}

test("a stream that goes silent ends with llm_timeout", async () => {
    script = async (send) => {
        send({ type: "message_start", message: MESSAGE });
        await sleep(2000); // never says anything
    };
    const llm = createClaudeLlm(CONFIG, { idleMs: 150, baseURL });
    const started = Date.now();
    await assert.rejects(collect(llm), { code: "llm_timeout" });
    assert.ok(Date.now() - started < 1500, "cut long before the SDK's own timeout");
});

test("thinking counts as activity: a slow but living stream is not cut", async () => {
    script = async (send) => {
        send({ type: "message_start", message: MESSAGE });
        send({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
        for (let i = 0; i < 4; i += 1) {
            await sleep(100);
            send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm " } });
        }
        send({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } });
        send({ type: "content_block_stop", index: 0 });
        for (const event of textEvents("SAY: Hola.\n")) {
            send(event);
        }
    };
    const llm = createClaudeLlm(CONFIG, { idleMs: 250, baseURL });
    assert.equal(await collect(llm), "SAY: Hola.\n");
});

test("a thinking block streamed without text gets more time, but not forever", async () => {
    // display "omitted": the thinking block opens, then nothing until it closes.
    const silentThought = (ms) => async (send) => {
        send({ type: "message_start", message: MESSAGE });
        send({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
        await sleep(ms);
        send({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } });
        send({ type: "content_block_stop", index: 0 });
        for (const event of textEvents("SAY: Listo.\n")) {
            send(event);
        }
    };
    script = silentThought(400);
    const patient = createClaudeLlm(CONFIG, { idleMs: 150, thinkingIdleMs: 1000, baseURL });
    assert.equal(await collect(patient), "SAY: Listo.\n");

    script = silentThought(1500);
    const strict = createClaudeLlm(CONFIG, { idleMs: 150, thinkingIdleMs: 300, baseURL });
    await assert.rejects(collect(strict), (error) => error.code === "llm_timeout" && /while thinking/.test(error.message));
});

test("the caller's cancel is a cancel, not a timeout", async () => {
    script = async (send) => {
        send({ type: "message_start", message: MESSAGE });
        await sleep(2000);
    };
    const llm = createClaudeLlm(CONFIG, { idleMs: 1000, baseURL });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("user")), 100);
    await assert.rejects(collect(llm, controller.signal), (error) => error.code !== "llm_timeout");
});

test("a source is counted with count_tokens on the configured model", async () => {
    const llm = createClaudeLlm(CONFIG, { baseURL });
    const document = { type: "document", source: { type: "text", media_type: "text/plain", data: "Manual" }, title: "manual.md" };
    const messages = [{ role: "user", content: [document, { type: "text", text: "?" }] }];
    assert.equal(await llm.countTokens({ messages }), 4321);
    const [request] = counted;
    assert.match(request.url, /^\/v1\/messages\/count_tokens/);
    assert.deepEqual(request.body, { model: CONFIG.model, messages });
});
