import assert from "node:assert/strict";
import { test } from "node:test";

import { DiagramBuilder, LIMITS, PALETTE, cleanIcon, normalizeId } from "../server/src/protocol/diagram.js";

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

test("a node keeps one emoji as its icon, and anything else is dropped", () => {
    assert.equal(cleanIcon("🍎"), "🍎");
    assert.equal(cleanIcon(" 🧑‍🔬 "), "🧑‍🔬", "a joined sequence is still one emoji");
    assert.equal(cleanIcon("☀️"), "☀️");
    assert.equal(cleanIcon("🇲🇽"), "🇲🇽", "a flag is two letters but one picture");
    for (const bad of ["manzana", "🍎🍐", "A", "#", "", null, 3, "🍎 roja"]) {
        assert.equal(cleanIcon(bad), "", `kept ${JSON.stringify(bad)}`);
    }
    const builder = new DiagramBuilder();
    const { nodes } = builder.addStep(1, JSON.stringify({ nodes: [
        { id: "manzana", label: "Manzana", icon: "🍎", shape: "sphere", color: "#E74C3C" },
        { id: "gravedad", label: "Gravedad", icon: "fuerza", shape: "cone", color: "#9B6ADE" },
    ] }));
    assert.equal(nodes[0].icon, "🍎");
    assert.ok(!("icon" in nodes[1]), "a word is not an icon: the node keeps its shape");
});

test("a node keeps its hook, cleaned and cut, and only the first two are kept", () => {
    const builder = new DiagramBuilder();
    const result = builder.addStep(1, JSON.stringify({
        nodes: [
            { id: "a", label: "A", hook: "  ¿Por   qué? " },
            { id: "b", label: "B", hook: 42 },
            { id: "c", label: "C", hook: "x".repeat(200) },
            { id: "d", label: "D", hook: "¿Y esta?" },
        ],
    }));
    assert.deepEqual(result.nodes.map((node) => node.hook), ["¿Por qué?", undefined, `${"x".repeat(LIMITS.hook - 1)}…`, undefined]);
    assert.deepEqual(result.issues, [`hook of node "d" over the limit of ${LIMITS.hooks}`]);
    assert.equal(result.nodes.length, 4);
});

test("a seeded node starts the diagram at step 1, without its hook, and Claude can connect to it", () => {
    const builder = new DiagramBuilder();
    const seeded = builder.seed({ id: "glucosa", label: "Glucosa", shape: "box", color: "#E67E22", step: 4, icon: "🍬", hook: "¿Adónde va?" });
    assert.deepEqual(seeded, { id: "glucosa", label: "Glucosa", shape: "box", color: "#E67E22", step: 1, icon: "🍬" });
    const result = builder.addStep(1, JSON.stringify({
        nodes: [{ id: "glucosa", label: "Otra vez" }, { id: "celula", label: "Célula" }],
        edges: [{ from: "glucosa", to: "celula" }],
    }));
    assert.deepEqual(result.issues, ['duplicate node id "glucosa"']);
    assert.deepEqual(result.edges, [{ from: "glucosa", to: "celula", step: 1 }]);
    assert.deepEqual(builder.toJSON("Más").nodes.map((node) => node.id), ["glucosa", "celula"]);
});
