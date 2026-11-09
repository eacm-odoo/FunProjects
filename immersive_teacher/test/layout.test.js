import assert from "node:assert/strict";
import { test } from "node:test";

import { edgeKey, layoutDiagram } from "../client/src/diagram/layout.js";

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

/** Each arrow as the 2D polyline it is drawn along: its node, its bends, the other node. */
function polylines({ positions, routes }, edges) {
    return edges.map((e) => ({
        edge: e,
        points: [positions.get(e.from), ...(routes.get(edgeKey(e)) ?? []), positions.get(e.to)],
    }));
}

function segmentsCross(p1, p2, p3, p4) {
    const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const d1 = d(p3, p4, p1);
    const d2 = d(p3, p4, p2);
    const d3 = d(p1, p2, p3);
    const d4 = d(p1, p2, p4);
    return d1 * d2 < -1e-12 && d3 * d4 < -1e-12;
}

/** Crossings between arrows that do not share a node, as drawn. */
function drawnCrossings(result, edges) {
    const lines = polylines(result, edges);
    let count = 0;
    for (let i = 0; i < lines.length; i += 1) {
        for (let j = i + 1; j < lines.length; j += 1) {
            const a = lines[i];
            const b = lines[j];
            const shared = [a.edge.from, a.edge.to].some((id) => id === b.edge.from || id === b.edge.to);
            if (shared) {
                continue;
            }
            for (let s = 0; s + 1 < a.points.length; s += 1) {
                for (let t = 0; t + 1 < b.points.length; t += 1) {
                    if (segmentsCross(a.points[s], a.points[s + 1], b.points[t], b.points[t + 1])) {
                        count += 1;
                    }
                }
            }
        }
    }
    return count;
}

function distanceToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Arrows that pass closer than `clearance` to a node that is not theirs. */
function arrowsThroughNodes(result, edges, clearance = 0.07) {
    const hits = [];
    for (const { edge: e, points } of polylines(result, edges)) {
        for (const [id, position] of result.positions) {
            if (id === e.from || id === e.to) {
                continue;
            }
            for (let s = 0; s + 1 < points.length; s += 1) {
                if (distanceToSegment(position, points[s], points[s + 1]) < clearance) {
                    hits.push(`${edgeKey(e)} over ${id}`);
                }
            }
        }
    }
    return hits;
}

test("the gravity diagram: no arrow crosses another or a node", () => {
    // The diagram from the first test on the headset emulator, where straight
    // arrows skipping a column crossed each other and cut through nodes.
    const names = ["aristoteles", "tierra", "objetos", "galileo", "manzana", "gravitacion", "luna", "newton"];
    const edges = [
        edge("aristoteles", "tierra"), edge("objetos", "tierra"), edge("galileo", "objetos"),
        edge("newton", "gravitacion"), edge("gravitacion", "manzana"), edge("gravitacion", "luna"),
        edge("newton", "manzana"), edge("newton", "luna"),
    ];
    const result = layoutDiagram(ids(...names), edges);
    assert.equal(drawnCrossings(result, edges), 0);
    assert.deepEqual(arrowsThroughNodes(result, edges), []);
    // Arrows that skip the middle column bend through it.
    assert.equal(result.routes.get("aristoteles>tierra").length, 1);
    assert.equal(result.routes.get("newton>luna").length, 1);
});

test("arrows that skip columns go around, and the order avoids crossings", () => {
    const cases = {
        // A process with a shortcut.
        shortcut: [["a", "b"], ["b", "c"], ["c", "d"], ["a", "d"]],
        // Two sources feeding two results, revealed in an awkward order.
        crossed: [["x", "q"], ["y", "p"], ["x", "r"], ["y", "s"], ["q", "t"], ["p", "t"]],
        // The photosynthesis answer.
        plant: [["sol", "planta"], ["agua", "planta"], ["co2", "planta"], ["planta", "glucosa"], ["planta", "oxigeno"]],
        // A hub with spokes both ways.
        hub: [["a", "h"], ["b", "h"], ["h", "c"], ["h", "d"], ["a", "c"], ["b", "d"]],
    };
    for (const [name, pairs] of Object.entries(cases)) {
        const edges = pairs.map(([from, to]) => edge(from, to));
        const nodeIds = [...new Set(pairs.flat())];
        const result = layoutDiagram(ids(...nodeIds), edges);
        assert.equal(drawnCrossings(result, edges), 0, `${name}: crossings`);
        assert.deepEqual(arrowsThroughNodes(result, edges), [], `${name}: arrows over nodes`);
    }
});

test("arrows both ways between two nodes curve to opposite sides", () => {
    const edges = [edge("a", "b"), edge("b", "a")];
    const result = layoutDiagram(ids("a", "b"), edges);
    const there = result.routes.get("a>b")[0];
    const back = result.routes.get("b>a")[0];
    assert.ok(Math.hypot(there.x - back.x, there.y - back.y) > 0.08, "the two arrows part ways");
});

test("bends move with the diagram when it is centered", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("a", "c")];
    const result = layoutDiagram(ids("a", "b", "c"), edges);
    const [bend] = result.routes.get("a>c");
    assert.ok(Math.abs(bend.x - result.positions.get("b").x) < 1e-9, "the bend sits in b's column");
    assert.ok(Math.abs(bend.y - result.positions.get("b").y) > 0.05, "but not on b");
});

test("groups with no arrow between them are laid out apart, close together", () => {
    // Aristotle and Galileo's story, and Newton's: two groups in one answer.
    const edges = [
        edge("aristoteles", "tierra"), edge("galileo", "objetos"), edge("objetos", "tierra"),
        edge("newton", "gravitacion"), edge("gravitacion", "manzana"), edge("gravitacion", "luna"),
        edge("newton", "manzana"), edge("newton", "luna"),
    ];
    const names = ["aristoteles", "tierra", "galileo", "objetos", "newton", "gravitacion", "manzana", "luna"];
    const { positions } = layoutDiagram(ids(...names), edges);
    const lowestOld = Math.min(...["aristoteles", "tierra", "galileo", "objetos"].map((id) => positions.get(id).y));
    const highestNew = Math.max(...["newton", "gravitacion", "manzana", "luna"].map((id) => positions.get(id).y));
    const gap = lowestOld - highestNew;
    // One under the other (side by side would not fit), in the order they appeared.
    assert.ok(gap > 0, "the second group is below the first");
    assert.ok(gap < 0.45, `gap between groups: ${gap.toFixed(2)} m`);

    // A node without arrows yet waits beside the rest, not on a row of its own far away.
    const lone = layoutDiagram(ids("a", "b", "solo"), [edge("a", "b")]);
    assert.ok(Math.abs(lone.positions.get("solo").y - lone.positions.get("a").y) < 0.01);
});
