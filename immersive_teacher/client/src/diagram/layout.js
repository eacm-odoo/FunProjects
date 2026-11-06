/**
 * Layout of the diagram, computed in the browser.
 *
 * Two simple shapes cover what a teacher draws on a board:
 *
 * - "cycle": when the graph has a cycle of 3 or more nodes (the water cycle,
 *   a life cycle), that cycle goes on a circle, clockwise from the top, and
 *   every other node hangs outside the circle next to the node it connects to.
 * - "layered": otherwise nodes flow left to right, each one a layer after the
 *   furthest node pointing to it (longest path), ordered inside the layer by
 *   the average position of their neighbours (barycenter). A chain longer than
 *   four layers folds into rows like a snake, so it does not grow too wide.
 *
 * Units are meters and the result is centered on (0, 0). Alternate columns or
 * rings get a little depth so the diagram does not look flat.
 *
 * Pure function with no three.js import, so it runs under node:test.
 */

const DEFAULTS = Object.freeze({
    maxWidth: 1.2,
    maxHeight: 0.8,
    minLayerGap: 0.3,
    maxLayerGap: 0.42,
    minRowGap: 0.24,
    maxRowGap: 0.3,
    layersPerRow: 4,
    rowSpacing: 0.34,
    minRadius: 0.24,
    maxRadius: 0.36,
    outerDistance: 0.34,
    depth: 0.05,
    sweeps: 2,
});

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function adjacency(ids, edges) {
    const out = new Map(ids.map((id) => [id, []]));
    const into = new Map(ids.map((id) => [id, []]));
    for (const edge of edges) {
        out.get(edge.from).push(edge.to);
        into.get(edge.to).push(edge.from);
    }
    return { out, into };
}

/**
 * DFS in node order. Returns the edges that do not close a cycle and the
 * longest cycle found through the back edges.
 */
function analyze(ids, edges) {
    const { out } = adjacency(ids, edges);
    const state = new Map(); // 1 = on the stack, 2 = finished
    const stack = [];
    const kept = [];
    let longestCycle = [];
    const visit = (id) => {
        state.set(id, 1);
        stack.push(id);
        for (const next of out.get(id)) {
            const nextState = state.get(next);
            if (nextState === 1) {
                const cycle = stack.slice(stack.indexOf(next));
                if (cycle.length > longestCycle.length) {
                    longestCycle = cycle;
                }
                continue; // back edge: left out of the layering
            }
            kept.push({ from: id, to: next });
            if (nextState === undefined) {
                visit(next);
            }
        }
        stack.pop();
        state.set(id, 2);
    };
    for (const id of ids) {
        if (!state.has(id)) {
            visit(id);
        }
    }
    return { dagEdges: kept, longestCycle };
}

/** Longest path from the sources, in a DAG. */
function assignLayers(ids, dagEdges) {
    const { out } = adjacency(ids, dagEdges);
    const layer = new Map(ids.map((id) => [id, 0]));
    const indegree = new Map(ids.map((id) => [id, 0]));
    for (const edge of dagEdges) {
        indegree.set(edge.to, indegree.get(edge.to) + 1);
    }
    const queue = ids.filter((id) => indegree.get(id) === 0);
    while (queue.length) {
        const id = queue.shift();
        for (const next of out.get(id)) {
            layer.set(next, Math.max(layer.get(next), layer.get(id) + 1));
            indegree.set(next, indegree.get(next) - 1);
            if (indegree.get(next) === 0) {
                queue.push(next);
            }
        }
    }
    return layer;
}

/** Centered position of each node inside its layer, from -(n-1)/2 to (n-1)/2. */
function centeredRows(layers) {
    const row = new Map();
    for (const members of layers) {
        members.forEach((id, index) => row.set(id, index - (members.length - 1) / 2));
    }
    return row;
}

function sortByBarycenter(members, neighbours, row) {
    const keyed = members.map((id, index) => {
        const around = neighbours.get(id).filter((other) => row.has(other));
        const key = around.length
            ? around.reduce((sum, other) => sum + row.get(other), 0) / around.length
            : index - (members.length - 1) / 2;
        return { id, key, index };
    });
    keyed.sort((a, b) => a.key - b.key || a.index - b.index);
    return keyed.map((entry) => entry.id);
}

function layered(ids, edges, dagEdges, opts) {
    const layerOf = assignLayers(ids, dagEdges);
    const layerCount = Math.max(...layerOf.values()) + 1;
    const layers = Array.from({ length: layerCount }, () => []);
    for (const id of ids) {
        layers[layerOf.get(id)].push(id);
    }

    const { out: succs, into: preds } = adjacency(ids, edges);
    for (let sweep = 0; sweep < opts.sweeps; sweep += 1) {
        for (let index = 1; index < layers.length; index += 1) {
            layers[index] = sortByBarycenter(layers[index], preds, centeredRows(layers.slice(0, index)));
        }
        for (let index = layers.length - 2; index >= 0; index -= 1) {
            layers[index] = sortByBarycenter(layers[index], succs, centeredRows(layers.slice(index + 1)));
        }
    }

    // Fold into rows of `layersPerRow` columns; odd rows run right to left.
    const perRow = Math.min(opts.layersPerRow, layers.length);
    const columnGap = perRow > 1
        ? clamp(opts.maxWidth / (perRow - 1), opts.minLayerGap, opts.maxLayerGap)
        : 0;
    const widest = Math.max(...layers.map((members) => members.length));
    const rowGap = widest > 1 ? clamp(opts.maxHeight / (widest - 1), opts.minRowGap, opts.maxRowGap) : 0;

    const positions = new Map();
    let top = 0;
    for (let start = 0; start < layers.length; start += perRow) {
        const band = layers.slice(start, start + perRow);
        const bandRows = Math.max(...band.map((members) => members.length));
        const reversed = (start / perRow) % 2 === 1;
        band.forEach((members, offset) => {
            const column = reversed ? perRow - 1 - offset : offset;
            const x = (column - (perRow - 1) / 2) * columnGap;
            const z = column % 2 ? -opts.depth : 0;
            members.forEach((id, rowIndex) => {
                const y = top - ((bandRows - members.length) / 2 + rowIndex) * rowGap;
                positions.set(id, { x, y, z });
            });
        });
        top -= (bandRows - 1) * rowGap + opts.rowSpacing;
    }
    return positions;
}

function circular(ids, edges, cycle, opts) {
    const order = new Map(ids.map((id, index) => [id, index]));
    // Start the circle at the node that appeared first, at the top.
    const first = cycle.reduce((best, id) => (order.get(id) < order.get(best) ? id : best), cycle[0]);
    const shift = cycle.indexOf(first);
    const ring = [...cycle.slice(shift), ...cycle.slice(0, shift)];
    const radius = clamp(ring.length * 0.085, opts.minRadius, opts.maxRadius);

    const polar = new Map();
    ring.forEach((id, index) => {
        polar.set(id, { angle: Math.PI / 2 - (index * 2 * Math.PI) / ring.length, radius, z: 0 });
    });

    // Everything else hangs outside, next to the node that reaches it first.
    const neighbours = new Map(ids.map((id) => [id, []]));
    for (const edge of edges) {
        neighbours.get(edge.from).push(edge.to);
        neighbours.get(edge.to).push(edge.from);
    }
    const queue = [...ring];
    while (queue.length) {
        const anchor = queue.shift();
        const children = neighbours.get(anchor)
            .filter((id, index, list) => !polar.has(id) && list.indexOf(id) === index)
            .sort((a, b) => order.get(a) - order.get(b));
        const base = polar.get(anchor);
        const childRadius = base.radius + opts.outerDistance;
        children.forEach((id, index) => {
            const spread = (index - (children.length - 1) / 2) * (0.26 / childRadius);
            polar.set(id, { angle: base.angle + spread, radius: childRadius, z: -opts.depth });
            queue.push(id);
        });
    }

    const positions = new Map();
    for (const [id, { angle, radius: r, z }] of polar) {
        positions.set(id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r, z });
    }
    // Nodes not connected to the cycle go in a line underneath.
    const loose = ids.filter((id) => !positions.has(id));
    if (loose.length) {
        const bottom = Math.min(...[...positions.values()].map((p) => p.y)) - opts.rowSpacing;
        loose.forEach((id, index) => {
            positions.set(id, { x: (index - (loose.length - 1) / 2) * opts.minLayerGap, y: bottom, z: 0 });
        });
    }
    return positions;
}

/**
 * @param {Array<{id: string}>} nodes in the order they appeared
 * @param {Array<{from: string, to: string}>} edges
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{
 *   positions: Map<string, {x: number, y: number, z: number}>,
 *   bounds: {minX: number, maxX: number, minY: number, maxY: number},
 *   mode: "empty" | "layered" | "cycle",
 * }}
 */
export function layoutDiagram(nodes, edges, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const ids = nodes.map((node) => node.id);
    const known = new Set(ids);
    const usable = edges.filter((edge) => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to);
    if (!ids.length) {
        return { positions: new Map(), bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, mode: "empty" };
    }

    const { dagEdges, longestCycle } = analyze(ids, usable);
    const mode = longestCycle.length >= 3 ? "cycle" : "layered";
    const positions = mode === "cycle"
        ? circular(ids, usable, longestCycle, opts)
        : layered(ids, usable, dagEdges, opts);

    // Center the result on (0, 0).
    const xs = [...positions.values()].map((p) => p.x);
    const ys = [...positions.values()].map((p) => p.y);
    const dx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const dy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const position of positions.values()) {
        position.x -= dx;
        position.y -= dy;
        bounds.minX = Math.min(bounds.minX, position.x);
        bounds.maxX = Math.max(bounds.maxX, position.x);
        bounds.minY = Math.min(bounds.minY, position.y);
        bounds.maxY = Math.max(bounds.maxY, position.y);
    }
    return { positions, bounds, mode };
}
