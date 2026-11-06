import assert from "node:assert/strict";
import { test } from "node:test";

import { layoutDiagram } from "../client/src/diagram/layout.js";

const node = (id) => ({ id });
const edge = (from, to) => ({ from, to });
const ids = (...names) => names.map(node);

function columnOf(positions) {
    const xs = [...new Set([...positions.values()].map((p) => p.x.toFixed(6)))].sort((a, b) => a - b);
    return (id) => xs.indexOf(positions.get(id).x.toFixed(6));
}

function width({ bounds }) {
    return bounds.maxX - bounds.minX;
}

test("an empty diagram has no positions", () => {
    const { positions, mode } = layoutDiagram([], []);
    assert.equal(positions.size, 0);
    assert.equal(mode, "empty");
});

test("a single node sits at the center", () => {
    const { positions } = layoutDiagram([node("a")], []);
    assert.deepEqual(positions.get("a"), { x: 0, y: 0, z: 0 });
});

test("a node goes one column after its furthest predecessor", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("a", "c"), edge("d", "c")];
    const { positions, mode } = layoutDiagram(ids("a", "b", "c", "d"), edges);
    const column = columnOf(positions);
    assert.equal(mode, "layered");
    assert.equal(column("a"), 0);
    assert.equal(column("d"), 0);
    assert.equal(column("b"), 1);
    assert.equal(column("c"), 2);
});

test("a long chain folds into a second row instead of growing wide", () => {
    const names = ["sol", "mar", "vapor", "nube", "lluvia", "rio"];
    const edges = names.slice(1).map((name, index) => edge(names[index], name));
    const result = layoutDiagram(ids(...names), edges);
    const { positions } = result;
    assert.ok(width(result) <= 1.2 + 1e-9);
    assert.ok(positions.get("lluvia").y < positions.get("nube").y, "second row is lower");
    // Snake: the second row starts under the end of the first one.
    assert.equal(positions.get("lluvia").x, positions.get("nube").x);
    assert.equal(positions.get("rio").x, positions.get("vapor").x);
});

test("a cycle goes on a circle that starts at the top", () => {
    const names = ["mar", "vapor", "nube", "lluvia", "rio"];
    const edges = names.map((name, index) => edge(name, names[(index + 1) % names.length]));
    const { positions, mode, bounds } = layoutDiagram(ids(...names), edges);
    assert.equal(mode, "cycle");
    const center = { x: (bounds.minX + bounds.maxX) / 2 };
    const distances = names.map((name) => Math.hypot(positions.get(name).x - center.x, positions.get(name).y));
    assert.equal(Math.max(...positions.values().map((p) => p.y)), positions.get("mar").y, "first node on top");
    assert.ok(positions.get("vapor").x > positions.get("mar").x, "clockwise");
    assert.ok(Math.max(...distances) - Math.min(...distances) < 0.2, "roughly on a circle");
});

test("nodes outside the cycle hang next to their neighbour", () => {
    const names = ["mar", "vapor", "nube", "lluvia", "sol"];
    const edges = [
        edge("mar", "vapor"), edge("vapor", "nube"), edge("nube", "lluvia"), edge("lluvia", "mar"),
        edge("sol", "mar"),
    ];
    const { positions } = layoutDiagram(ids(...names), edges);
    assert.ok(positions.get("sol").y > positions.get("mar").y, "sol above mar, outside the ring");
    assert.ok(Math.abs(positions.get("sol").x - positions.get("mar").x) < 1e-9);
});

test("a cycle does not hang and spreads every node", () => {
    const { positions } = layoutDiagram(ids("a", "b", "c"), [edge("a", "b"), edge("b", "c"), edge("c", "a")]);
    const keys = new Set([...positions.values()].map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
    assert.equal(keys.size, 3);
});

test("barycenter ordering keeps children next to their parent", () => {
    // Without reordering, x1 and y1 would cross: the second column starts in reveal order.
    const { positions } = layoutDiagram(ids("x", "y", "y1", "x1"), [edge("x", "x1"), edge("y", "y1")]);
    const above = (a, b) => positions.get(a).y > positions.get(b).y;
    assert.equal(above("x", "y"), above("x1", "y1"));
});

test("unknown edge ends and loops are ignored", () => {
    const { positions } = layoutDiagram([node("a")], [edge("a", "zzz"), edge("a", "a")]);
    assert.equal(positions.size, 1);
});
