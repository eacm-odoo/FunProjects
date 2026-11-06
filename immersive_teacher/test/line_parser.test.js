import assert from "node:assert/strict";
import { test } from "node:test";

import { LineParser, parseLine, splitSentences } from "../server/src/protocol/line_parser.js";

const ANSWER = [
    "TITLE: La fotosíntesis",
    "SAY: Las plantas fabrican su alimento.",
    'DRAW: {"nodes":[{"id":"planta","label":"Planta","shape":"box","color":"#3A9D23"}]}',
    "SAY: Todo empieza con la luz.",
].join("\n");

function feedInChunks(text, sizes) {
    const parser = new LineParser();
    const items = [];
    let index = 0;
    let turn = 0;
    while (index < text.length) {
        const size = sizes[turn % sizes.length];
        items.push(...parser.push(text.slice(index, index + size)));
        index += size;
        turn += 1;
    }
    items.push(...parser.end());
    return items;
}

test("the same items come out whatever the chunk sizes", () => {
    const reference = feedInChunks(ANSWER, [ANSWER.length]);
    assert.deepEqual(reference.map((item) => item.kind), ["title", "say", "draw", "say"]);
    for (const sizes of [[1], [2, 7], [3, 1, 13], [50]]) {
        assert.deepEqual(feedInChunks(ANSWER, sizes), reference, `chunks ${sizes}`);
    }
});

test("an item is emitted as soon as its line ends", () => {
    const parser = new LineParser();
    assert.deepEqual(parser.push("TITLE: Hola"), []);
    assert.deepEqual(parser.push("\nSAY: Primera"), [{ kind: "title", text: "Hola", marked: true }]);
    assert.deepEqual(parser.push(" frase.\n"), [{ kind: "say", text: "Primera frase.", marked: true }]);
});

test("the unfinished tail can be discarded instead of parsed", () => {
    const parser = new LineParser();
    parser.push("SAY: Completa.\nSAY: Cortada por max_to");
    assert.equal(parser.discard(), "SAY: Cortada por max_to");
    assert.deepEqual(parser.end(), []);
});

test("markdown around markers is tolerated", () => {
    assert.deepEqual(parseLine("**SAY:** Hola **mundo**."), [{ kind: "say", text: "Hola mundo.", marked: true }]);
    assert.deepEqual(parseLine("- say: con viñeta"), [{ kind: "say", text: "con viñeta", marked: true }]);
    assert.deepEqual(parseLine("  Title :  Algo  "), [{ kind: "title", text: "Algo", marked: true }]);
    assert.deepEqual(parseLine("```"), []);
    assert.deepEqual(parseLine("   "), []);
    assert.deepEqual(parseLine("SAY:"), []);
});

test("DRAW keeps its JSON untouched", () => {
    const json = '{"nodes":[{"id":"a","label":"**no** tocar"}]}';
    assert.deepEqual(parseLine(`DRAW: ${json}`), [{ kind: "draw", text: json, marked: true }]);
});

test("a line without marker is spoken, split into sentences", () => {
    assert.deepEqual(parseLine("Claro. La luz llega a la hoja. ¿Ves cómo funciona?"), [
        { kind: "say", text: "Claro.", marked: false },
        { kind: "say", text: "La luz llega a la hoja.", marked: false },
        { kind: "say", text: "¿Ves cómo funciona?", marked: false },
    ]);
});

test("a bare JSON line is a diagram, never speech", () => {
    assert.deepEqual(parseLine('{"nodes":[]}'), [{ kind: "draw", text: '{"nodes":[]}', marked: false }]);
});

test("sentences split only where a new one starts", () => {
    assert.deepEqual(splitSentences("Mide 3.5 metros. Luego crece."), ["Mide 3.5 metros.", "Luego crece."]);
    assert.deepEqual(splitSentences("Sí... claro que sí."), ["Sí... claro que sí."]);
    assert.deepEqual(splitSentences("¡Hola! ¿Qué tal?"), ["¡Hola!", "¿Qué tal?"]);
});
