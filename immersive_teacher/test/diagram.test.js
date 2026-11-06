import assert from "node:assert/strict";
import { test } from "node:test";

import { DiagramBuilder, LIMITS, PALETTE, normalizeId } from "../server/src/protocol/diagram.js";

test("a valid step is accepted with the caller's step number", () => {
    const builder = new DiagramBuilder();
    const result = builder.addStep(2, JSON.stringify({
        nodes: [
            { id: "sol", label: "Luz solar", shape: "sphere", color: "#f5b700" },
            { id: "hoja", label: "Hoja", shape: "box", color: "#3A9D23" },
        ],
        edges: [{ from: "sol", to: "hoja", label: "energía" }],
    }));
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.nodes, [
        { id: "sol", label: "Luz solar", shape: "sphere", color: "#F5B700", step: 2 },
        { id: "hoja", label: "Hoja", shape: "box", color: "#3A9D23", step: 2 },
    ]);
    assert.deepEqual(result.edges, [{ from: "sol", to: "hoja", step: 2, label: "energía" }]);
});

test("broken JSON loses the whole line and nothing else", () => {
    const builder = new DiagramBuilder();
    builder.addStep(1, '{"nodes":[{"id":"a","label":"A"}]}');
    const broken = builder.addStep(2, '{"nodes":[{"id":"b","label":"B"');
    assert.deepEqual(broken.nodes, []);
    assert.deepEqual(broken.issues, ["not a JSON object"]);
    assert.equal(builder.toJSON("T").nodes.length, 1);
});

test("text around the JSON object is ignored", () => {
    const builder = new DiagramBuilder();
    const result = builder.addStep(1, '{"nodes":[{"id":"a","label":"A"}]} ```');
    assert.equal(result.nodes.length, 1);
});

test("bad fields are repaired, bad references are dropped", () => {
    const builder = new DiagramBuilder();
    const result = builder.addStep(1, JSON.stringify({
        nodes: [
            { id: "Luz Solar", label: "  Luz   solar ", shape: "hexagono", color: "amarillo" },
            { id: "agua", shape: "Cylinder", color: "#09f" },
            { id: "luz_solar", label: "Duplicado" },
            { label: "Sin id" },
        ],
        edges: [
            { from: "luz solar", to: "agua" },
            { from: "agua", to: "fantasma" },
            { from: "agua", to: "agua" },
            { from: "Luz Solar", to: "agua" },
        ],
    }));
    assert.deepEqual(result.nodes, [
        { id: "luz_solar", label: "Luz solar", shape: "box", color: PALETTE[0], step: 1 },
        { id: "agua", label: "agua", shape: "cylinder", color: "#0099FF", step: 1 },
    ]);
    assert.deepEqual(result.edges, [{ from: "luz_solar", to: "agua", step: 1 }]);
    assert.equal(result.issues.length, 5);
});

test("edges may point to nodes from earlier steps only", () => {
    const builder = new DiagramBuilder();
    builder.addStep(1, '{"nodes":[{"id":"a","label":"A"}]}');
    const early = builder.addStep(2, '{"edges":[{"from":"a","to":"b"}]}');
    assert.equal(early.edges.length, 0);
    const later = builder.addStep(3, '{"nodes":[{"id":"b","label":"B"}],"edges":[{"from":"a","to":"b"}]}');
    assert.equal(later.edges.length, 1);
});

test("limits on nodes, edges and label length hold", () => {
    const builder = new DiagramBuilder();
    const nodes = Array.from({ length: LIMITS.nodes + 3 }, (_, index) => ({
        id: `n${index}`,
        label: "x".repeat(60),
    }));
    const result = builder.addStep(1, JSON.stringify({ nodes }));
    assert.equal(result.nodes.length, LIMITS.nodes);
    assert.equal(result.issues.length, 3);
    assert.equal(result.nodes[0].label.length, LIMITS.label);

    const edges = [];
    for (let a = 0; a < LIMITS.nodes; a += 1) {
        for (let b = 0; b < LIMITS.nodes; b += 1) {
            if (a !== b) {
                edges.push({ from: `n${a}`, to: `n${b}` });
            }
        }
    }
    const linked = builder.addStep(2, JSON.stringify({ edges }));
    assert.equal(linked.edges.length, LIMITS.edges);
});

test("no node means no diagram", () => {
    const builder = new DiagramBuilder();
    builder.addStep(1, "nada");
    assert.equal(builder.toJSON("Título"), null);
});

test("ids are normalized the same way for nodes and edges", () => {
    assert.equal(normalizeId("Dióxido de Carbono"), "dioxido_de_carbono");
    assert.equal(normalizeId("  --x--  "), "x");
    assert.equal(normalizeId(42), "42");
    assert.equal(normalizeId(null), "");
});
