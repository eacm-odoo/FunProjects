/**
 * The page's turn controller with a fake connection, panel, diagram and
 * narrators: a node explored before comes back without asking or talking,
 * and an explanation is said again from what was received.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TurnController } from "../client/src/turn_controller.js";

class FakeConnection {
    handlers = new Map();
    sent = [];

    on(type, handler) {
        this.handlers.set(type, handler);
    }

    onBinary(handler) {
        this.binary = handler;
    }

    send(message) {
        this.sent.push(message);
        return true;
    }

    sendBinary() {
        return true;
    }

    /** One event from the server, for the turn in progress unless it says otherwise. */
    emit(event) {
        this.handlers.get(event.type)?.(event);
    }

    /** One binary speech frame: the 8-byte header, then 16-bit samples. */
    speech(turn, step, samples) {
        const buffer = new ArrayBuffer(8 + samples.length * 2);
        const view = new DataView(buffer);
        view.setUint32(0, turn, true);
        view.setUint16(4, step, true);
        samples.forEach((sample, index) => view.setInt16(8 + index * 2, sample, true));
        this.binary(buffer);
    }
}

/**
 * Plays everything at once when told there is nothing more to come. Like the
 * real ones, it waits for the step after the last one it played: an earlier
 * step only plays again after stop().
 */
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

    audioStart(step, sampleRate) {
        this.log.push(`start ${step} ${sampleRate}`);
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

/** Records every call by name; any method exists. */
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

const PHOTOSYNTHESIS = {
    title: "La fotosíntesis",
    nodes: [{ id: "planta", label: "Planta" }, { id: "glucosa", label: "Glucosa", hook: "¿Adónde va la glucosa?" }],
    edges: [{ from: "planta", to: "glucosa" }],
};
const GLUCOSE = { title: "Más de Glucosa", nodes: [{ id: "glucosa", label: "Glucosa" }, { id: "celula", label: "Célula" }], edges: [] };

function setUp() {
    const connection = new FakeConnection();
    const panel = recorder();
    const diagram = recorder();
    const audioNarrator = new FakeNarrator();
    const timedNarrator = new FakeNarrator();
    const states = [];
    const replayable = [];
    const controller = new TurnController({
        connection,
        panel: panel.object,
        status: { set: (state) => states.push(state) },
        diagram: diagram.object,
        audioNarrator,
        timedNarrator,
        onReplayable: (available) => replayable.push(available),
    });
    controller.setSpeechEnabled(true);
    return { controller, connection, panel, diagram, audioNarrator, timedNarrator, states, replayable };
}

/** A whole answer from the server for `turn`: two sentences, speech for the first one only. */
function answer(connection, turn, diagram, [first, second]) {
    connection.emit({ type: "sentence", turn, step: 1, text: first });
    connection.emit({ type: "audio_start", turn, step: 1, sampleRate: 24000 });
    connection.speech(turn, 1, [1, 2, 3]);
    connection.speech(turn, 1, [4]);
    connection.emit({ type: "audio_end", turn, step: 1, ok: true });
    connection.emit({ type: "sentence", turn, step: 2, text: second });
    connection.emit({ type: "audio_end", turn, step: 2, ok: false });
    connection.emit({ type: "done", turn, diagram });
}

const quietly = (fn) => {
    const info = console.info;
    console.info = () => {};
    try {
        return fn();
    } finally {
        console.info = info;
    }
};

test("a node explored before shows the diagram it gave, without asking or talking", () => quietly(() => {
    const { controller, connection, diagram, audioNarrator, panel } = setUp();
    controller.ask("¿Cómo hacen las plantas la fotosíntesis?");
    answer(connection, 1, PHOTOSYNTHESIS, ["Frase uno.", "Frase dos."]);
    assert.equal(controller.explore(1, "glucosa"), true);
    assert.deepEqual(connection.sent.at(-1), { type: "ask_node", turn: 2, from: 1, node: "glucosa", language: "es" });
    answer(connection, 2, GLUCOSE, ["Más uno.", "Más dos."]);

    assert.equal(controller.goBack(), true);
    const sent = connection.sent.length;
    const said = audioNarrator.log.length;
    diagram.calls.length = 0;
    assert.equal(controller.explore(1, "glucosa"), true);
    assert.equal(connection.sent.length, sent, "nothing is asked again");
    assert.equal(audioNarrator.log.length, said, "nothing is said");
    const shown = diagram.calls.filter(([name]) => name === "show");
    assert.equal(shown.length, 1);
    assert.equal(shown[0][1], GLUCOSE);
    assert.equal(shown[0][2].parentTitle, "La fotosíntesis");
    assert.equal(controller.exploration.shown, 2);
    assert.ok(panel.calls.some(([name, turn]) => name === "revealTurn" && turn === 2));
}));

test("an explanation is said again from the sentences and the speech received, without asking", () => quietly(() => {
    const { controller, connection, panel, audioNarrator, states, replayable } = setUp();
    controller.ask("¿Cómo hacen las plantas la fotosíntesis?");
    answer(connection, 1, PHOTOSYNTHESIS, ["Frase uno.", "Frase dos."]);
    assert.ok(panel.calls.some(([name, turn]) => name === "setReplay" && turn === 1));
    assert.equal(replayable.at(-1), true);

    const sent = connection.sent.length;
    audioNarrator.log.length = 0;
    panel.calls.length = 0;
    states.length = 0;
    assert.equal(controller.replayShown(), true);
    assert.equal(connection.sent.length, sent);
    assert.deepEqual(audioNarrator.log, [
        "say 1 Frase uno.", "start 1 24000", "chunk 1 1,2,3", "chunk 1 4", "end 1",
        "say 2 Frase dos.", "end 2",
    ]);
    const steps = panel.calls.filter(([name]) => name === "highlightStep").map(([, turn, step]) => `${turn}:${step}`);
    assert.deepEqual(steps, ["1:1", "1:2"]);
    assert.deepEqual(states, ["explaining", "explaining", "ready"]);
    assert.equal(controller.replaying, null);
}));

test("without speech the explanation is paced as text, and a deeper answer in progress is not replayable", () => quietly(() => {
    const { controller, connection, audioNarrator, timedNarrator, replayable } = setUp();
    audioNarrator.unlocked = false;
    controller.ask("¿Cómo hacen las plantas la fotosíntesis?");
    answer(connection, 1, PHOTOSYNTHESIS, ["Frase uno.", "Frase dos."]);
    timedNarrator.log.length = 0;
    controller.replay(1);
    assert.deepEqual(timedNarrator.log, ["say 1 Frase uno.", "say 2 Frase dos."]);

    controller.explore(1, "glucosa");
    assert.equal(replayable.at(-1), false, "the deeper answer has not arrived yet");
    assert.equal(controller.replayShown(), false);
    // A failed answer is never said again.
    connection.emit({ type: "error", turn: 2, code: "llm_failed", message: "x" });
    assert.equal(controller.replay(2), false);
}));
