import assert from "node:assert/strict";
import { test } from "node:test";

import { DiagramBuilder } from "../server/src/protocol/diagram.js";
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

test("tool-call markup is read as the markers it stands for, and never spoken", () => {
    // Lines from a real answer that slipped into tool-call markup.
    const draw = '<parameter name="DRAW">{"nodes":[{"id":"venta","label":"Pedido de venta","hook":"¿Y si no alcanza?"}],"edges":[]}</parameter>';
    assert.deepEqual(parseLine("SAY: Puedes crearla a mano.</parameter>"), [{ kind: "say", text: "Puedes crearla a mano.", marked: true }]);
    assert.deepEqual(parseLine('<parameter name="SAY">Hola mundo.</parameter>'), [{ kind: "say", text: "Hola mundo.", marked: false }]);
    assert.deepEqual(parseLine("<SAY>Frase.</SAY>"), [{ kind: "say", text: "Frase.", marked: false }]);
    assert.deepEqual(parseLine('<parameter name="TITLE">Fabricar bajo pedido</parameter>'), [
        { kind: "title", text: "Fabricar bajo pedido", marked: false },
    ]);
    const [item] = parseLine(draw);
    assert.equal(item.kind, "draw");
    // The diagram reads the object and ignores the closing tag.
    const result = new DiagramBuilder().addStep(1, item.text);
    assert.deepEqual(result.issues, []);
    assert.equal(result.nodes[0].hook, "¿Y si no alcanza?");
    for (const line of ["</parameter>", '<invoke name="answer">', "</invoke>", "</function_calls>"]) {
        assert.deepEqual(parseLine(line), [], line);
    }
    // A diagram after some words is still a diagram; a comparison is not a tag.
    assert.deepEqual(parseLine('Mira: {"nodes":[]}'), [{ kind: "draw", text: '{"nodes":[]}', marked: false }]);
    assert.deepEqual(parseLine("Dos < tres y cinco > cuatro."), [{ kind: "say", text: "Dos < tres y cinco > cuatro.", marked: false }]);
});

test("sentences split only where a new one starts", () => {
    assert.deepEqual(splitSentences("Mide 3.5 metros. Luego crece."), ["Mide 3.5 metros.", "Luego crece."]);
    assert.deepEqual(splitSentences("Sí... claro que sí."), ["Sí... claro que sí."]);
    assert.deepEqual(splitSentences("¡Hola! ¿Qué tal?"), ["¡Hola!", "¿Qué tal?"]);
});
