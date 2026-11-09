/**
 * Layout of the diagram, computed in the browser.
 *
 * Two shapes cover what a teacher draws on a board:
 *
 * - "cycle": when the graph has a cycle of 3 or more nodes (the water cycle,
 *   a life cycle), that cycle goes on a circle, clockwise from the top, and
 *   every other node hangs outside the circle next to the node it connects to.
 * - "layered": otherwise nodes flow left to right, each one a column after
 *   the furthest node pointing to it (longest path). An arrow that skips
 *   columns gets a lane in every column it crosses (a "bend"), so it curves
 *   around the nodes in between instead of cutting through them. The order
 *   inside each column comes from repeated barycenter sweeps plus swaps of
 *   neighbours, counting the exact crossings and keeping the best order; then
 *   every column slides so its arrows run as straight as possible. A graph
 *   longer than five columns flows top to bottom instead, except a plain
 *   chain, which folds into rows like a snake.
 *
 * Arrows both ways between two nodes curve to opposite sides. Groups of
 * nodes with no arrow between them are laid out on their own, then put side
 * by side when they fit, or one under the other, in the order they appeared.
 *
 * Units are meters and the result is centered on (0, 0). Alternate columns or
 * rings get a little depth so the diagram does not look flat.
 *
 * Pure function with no three.js import, so it runs under node:test.
 */

const DEFAULTS = Object.freeze({
    maxWidth: 1.2,
    maxHeight: 0.8,
    minLayerGap: 0.28,
    maxLayerGap: 0.42,
    minRowGap: 0.18,
    maxRowGap: 0.3,
    /** Top to bottom: room of a node side by side in a row (its label is wide). */
    minColumnGap: 0.26,
    maxColumnGap: 0.34,
    minLevelGap: 0.18,
    maxLevelGap: 0.24,
    /** Room a bend takes in a column, as a share of the room of a node. */
    bendRoom: 0.4,
    maxUnfoldedLayers: 5,
    layersPerRow: 4,
    rowSpacing: 0.34,
    minRadius: 0.24,
    maxRadius: 0.36,
    outerDistance: 0.34,
    depth: 0.05,
    sweeps: 8,
    straightenPasses: 6,
    /** How far apart two arrows between the same nodes curve, in meters. */
    pairOffset: 0.06,
    /** A taller result is squeezed vertically, down to minSqueeze of its height. */
    tallestHeight: 1.3,
    minSqueeze: 0.75,
    /** Space between unconnected groups. */
    groupGap: 0.3,
});

/** Key of an edge in `routes`. */
export function edgeKey(edge) {
    return `${edge.from}>${edge.to}`;
}

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

/** Crossings between the edges of two neighbouring columns. */
function crossingsBetween(upper, lower, succs) {
    const lowerIndex = new Map(lower.map((id, index) => [id, index]));
    const pairs = [];
    upper.forEach((id, index) => {
        for (const next of succs.get(id)) {
            if (lowerIndex.has(next)) {
                pairs.push([index, lowerIndex.get(next)]);
            }
        }
    });
    let count = 0;
    for (let i = 0; i < pairs.length; i += 1) {
        for (let j = i + 1; j < pairs.length; j += 1) {
            const [a1, b1] = pairs[i];
            const [a2, b2] = pairs[j];
            if ((a1 - a2) * (b1 - b2) < 0) {
                count += 1;
            }
        }
    }
    return count;
}

function totalCrossings(layers, succs) {
    let count = 0;
    for (let index = 0; index + 1 < layers.length; index += 1) {
        count += crossingsBetween(layers[index], layers[index + 1], succs);
    }
    return count;
}

/** Reorders `members` by the mean position of their neighbours in `reference`. */
function sortByBarycenter(members, neighbours, reference) {
    const position = new Map(reference.map((id, index) => [id, index]));
    const keyed = members.map((id, index) => {
        const around = neighbours.get(id).filter((other) => position.has(other));
        const key = around.length
            ? around.reduce((sum, other) => sum + position.get(other), 0) / around.length
            : index;
        return { id, key, index };
    });
    keyed.sort((a, b) => a.key - b.key || a.index - b.index);
    return keyed.map((entry) => entry.id);
}

/** Swaps neighbours inside each column while that lowers the crossings around it. */
function transpose(layers, preds, succs) {
    for (let round = 0; round < 6; round += 1) {
        let improved = false;
        for (let index = 0; index < layers.length; index += 1) {
            const layer = layers[index];
            const local = () => (index > 0 ? crossingsBetween(layers[index - 1], layer, succs) : 0)
                + (index + 1 < layers.length ? crossingsBetween(layer, layers[index + 1], succs) : 0);
            for (let slot = 0; slot + 1 < layer.length; slot += 1) {
                const before = local();
                [layer[slot], layer[slot + 1]] = [layer[slot + 1], layer[slot]];
                if (local() < before) {
                    improved = true;
                } else {
                    [layer[slot], layer[slot + 1]] = [layer[slot + 1], layer[slot]];
                }
            }
        }
        if (!improved) {
            return;
        }
    }
}

/** Several starting orders (the reveal order, its reverse, depth first), the best one kept. */
function bestOrdering(initial, preds, succs, sweeps) {
    const reversed = initial.map((layer) => [...layer].reverse());
    // Depth first from the first column: relatives end up close together.
    const seen = new Map();
    const visit = (vertex) => {
        if (seen.has(vertex)) {
            return;
        }
        seen.set(vertex, seen.size);
        for (const next of succs.get(vertex)) {
            visit(next);
        }
    };
    initial.flat().forEach(visit);
    const depthFirst = initial.map((layer) => [...layer].sort((a, b) => seen.get(a) - seen.get(b)));
    let best = null;
    for (const start of [initial, depthFirst, reversed]) {
        const result = minimizeCrossings(start, preds, succs, sweeps);
        if (!best || result.crossings < best.crossings) {
            best = result;
        }
    }
    return best;
}

/** Barycenter sweeps down and up, each followed by swaps; keeps the best order seen. */
function minimizeCrossings(initial, preds, succs, sweeps) {
    let current = initial.map((layer) => [...layer]);
    transpose(current, preds, succs);
    let best = current.map((layer) => [...layer]);
    let bestCount = totalCrossings(best, succs);
    for (let sweep = 0; sweep < sweeps && bestCount > 0; sweep += 1) {
        for (let index = 1; index < current.length; index += 1) {
            current[index] = sortByBarycenter(current[index], preds, current[index - 1]);
        }
        transpose(current, preds, succs);
        for (let index = current.length - 2; index >= 0; index -= 1) {
            current[index] = sortByBarycenter(current[index], succs, current[index + 1]);
        }
        transpose(current, preds, succs);
        const count = totalCrossings(current, succs);
        if (count < bestCount) {
            best = current.map((layer) => [...layer]);
            bestCount = count;
        }
    }
    return { layers: best, crossings: bestCount };
}

/**
 * Vertical positions inside one column, top to bottom (y goes down): each
 * member as close to `desired` as the gap below the previous one allows, then
 * the whole column shifted so, on average, it sits where its members want.
 */
function placeColumn(members, desired, gapAbove) {
    const y = [];
    members.forEach((id, index) => {
        y.push(index === 0 ? desired.get(id) : Math.min(desired.get(id), y[index - 1] - gapAbove(index)));
    });
    const shift = members.reduce((sum, id, index) => sum + (desired.get(id) - y[index]), 0) / members.length;
    return new Map(members.map((id, index) => [id, y[index] + shift]));
}

function layered(ids, edges, dagEdges, opts) {
    const layerOf = assignLayers(ids, dagEdges);
    const layerCount = Math.max(...layerOf.values()) + 1;

    // The virtual graph: real nodes plus a bend in every column an edge skips.
    // Its edges only join neighbouring columns, low to high.
    const isBend = new Set();
    const vertexLayer = new Map(ids.map((id) => [id, layerOf.get(id)]));
    const succs = new Map(ids.map((id) => [id, []]));
    const preds = new Map(ids.map((id) => [id, []]));
    const link = (from, to) => {
        succs.get(from).push(to);
        preds.get(to).push(from);
    };
    const chains = new Map();
    for (const edge of edges) {
        const a = layerOf.get(edge.from);
        const b = layerOf.get(edge.to);
        if (a === b) {
            continue;
        }
        const [low, high] = a < b ? [edge.from, edge.to] : [edge.to, edge.from];
        const bends = [];
        let previous = low;
        for (let step = 1; step < Math.abs(b - a); step += 1) {
            const bend = `\u0000${edgeKey(edge)}#${step}`;
            isBend.add(bend);
            vertexLayer.set(bend, Math.min(a, b) + step);
            succs.set(bend, []);
            preds.set(bend, []);
            link(previous, bend);
            bends.push(bend);
            previous = bend;
        }
        link(previous, high);
        chains.set(edgeKey(edge), a < b ? bends : bends.reverse());
    }

    const initial = Array.from({ length: layerCount }, () => []);
    for (const [vertex, layer] of vertexLayer) {
        initial[layer].push(vertex);
    }
    const { layers } = bestOrdering(initial, preds, succs, opts.sweeps);

    // Short graphs flow left to right in one row. Longer ones flow top to
    // bottom, except a plain chain (one node per column), which reads better
    // folded into rows like a snake.
    const long = layerCount > opts.maxUnfoldedLayers;
    const plainChain = layers.every((members) => members.length === 1);
    const shape = !long ? "row" : plainChain ? "snake" : "down";
    const perRow = shape === "snake" ? opts.layersPerRow : layerCount;
    const room = (vertex) => (isBend.has(vertex) ? opts.bendRoom : 1);
    const extent = (members) => members.reduce(
        (sum, vertex, index) => sum + (index ? (room(vertex) + room(members[index - 1])) / 2 : 0), 0,
    );
    const widest = Math.max(...layers.map(extent));
    // Room between neighbours inside a column (a row, when flowing down).
    const gap = shape === "down"
        ? (widest > 0 ? clamp(opts.maxWidth / widest, opts.minColumnGap, opts.maxColumnGap) : 0)
        : (widest > 0 ? clamp(opts.maxHeight / widest, opts.minRowGap, opts.maxRowGap) : 0);

    // Position across each column: start centered, then slide each column
    // toward the vertices it connects to so arrows run straight.
    const across = new Map();
    for (let start = 0; start < layerCount; start += perRow) {
        const band = layers.slice(start, start + perRow);
        for (const members of band) {
            let cursor = 0;
            members.forEach((vertex, index) => {
                if (index) {
                    cursor -= ((room(vertex) + room(members[index - 1])) / 2) * gap;
                }
                across.set(vertex, cursor);
            });
            for (const vertex of members) {
                across.set(vertex, across.get(vertex) - cursor / 2);
            }
        }
        const inBand = new Set(band.flat());
        for (let pass = 0; pass < opts.straightenPasses; pass += 1) {
            const order = pass % 2 ? [...band.keys()].reverse() : [...band.keys()];
            for (const column of order) {
                const members = band[column];
                const desired = new Map(members.map((vertex) => {
                    const around = [...preds.get(vertex), ...succs.get(vertex)].filter((other) => inBand.has(other));
                    const target = around.length
                        ? around.reduce((sum, other) => sum + across.get(other), 0) / around.length
                        : across.get(vertex);
                    return [vertex, target];
                }));
                const gapAbove = (index) => ((room(members[index]) + room(members[index - 1])) / 2) * gap;
                for (const [vertex, value] of placeColumn(members, desired, gapAbove)) {
                    across.set(vertex, value);
                }
            }
        }
    }

    const point = new Map();
    if (shape === "down") {
        // Columns become levels, top to bottom; "across" runs left to right.
        const levelGap = clamp(opts.maxHeight * 1.5 / Math.max(1, layerCount - 1), opts.minLevelGap, opts.maxLevelGap);
        layers.forEach((members, level) => {
            for (const vertex of members) {
                point.set(vertex, { x: -across.get(vertex), y: -level * levelGap, z: level % 2 ? -opts.depth : 0 });
            }
        });
    } else {
        // Rows go down the board; odd rows run right to left (a snake).
        const columnGap = perRow > 1
            ? clamp(opts.maxWidth / (perRow - 1), opts.minLayerGap, opts.maxLayerGap)
            : 0;
        let top = 0;
        for (let start = 0; start < layerCount; start += perRow) {
            const band = layers.slice(start, start + perRow);
            const values = band.flat().map((vertex) => across.get(vertex));
            const bandTop = Math.max(...values);
            const bandBottom = Math.min(...values);
            const reversed = (start / perRow) % 2 === 1;
            band.forEach((members, offset) => {
                const column = reversed ? perRow - 1 - offset : offset;
                const x = (column - (perRow - 1) / 2) * columnGap;
                const z = column % 2 ? -opts.depth : 0;
                for (const vertex of members) {
                    point.set(vertex, { x, y: top + (across.get(vertex) - bandTop), z });
                }
            });
            top -= (bandTop - bandBottom) + opts.rowSpacing;
        }
    }

    const positions = new Map(ids.map((id) => [id, point.get(id)]));
    const routes = new Map();
    for (const [key, bends] of chains) {
        if (bends.length) {
            routes.set(key, bends.map((bend) => ({ ...point.get(bend) })));
        }
    }
    return { positions, routes };
}

/** Rare dense graphs grow tall: squeeze them a little rather than fill a wall. */
function squeeze(positions, routes, opts) {
    const ys = [...positions.values()].map((p) => p.y);
    const height = Math.max(...ys) - Math.min(...ys);
    if (height <= opts.tallestHeight) {
        return;
    }
    const factor = Math.max(opts.minSqueeze, opts.tallestHeight / height);
    for (const point of [...positions.values(), ...[...routes.values()].flat()]) {
        point.y *= factor;
    }
}

/** Arrows both ways between two nodes curve to opposite sides instead of overlapping. */
function separatePairs(edges, positions, routes, offset) {
    const keys = new Set(edges.map(edgeKey));
    for (const edge of edges) {
        const key = edgeKey(edge);
        if (routes.has(key) || !keys.has(edgeKey({ from: edge.to, to: edge.from }))) {
            continue;
        }
        const a = positions.get(edge.from);
        const b = positions.get(edge.to);
        const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        // The normal flips with the direction, so the two arrows part ways.
        const nx = -(b.y - a.y) / length;
        const ny = (b.x - a.x) / length;
        routes.set(key, [{ x: (a.x + b.x) / 2 + nx * offset, y: (a.y + b.y) / 2 + ny * offset, z: (a.z + b.z) / 2 }]);
    }
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
    return positions;
}

/**
 * @param {Array<{id: string}>} nodes in the order they appeared
 * @param {Array<{from: string, to: string}>} edges
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{
 *   positions: Map<string, {x: number, y: number, z: number}>,
 *   routes: Map<string, Array<{x: number, y: number, z: number}>>,
 *   bounds: {minX: number, maxX: number, minY: number, maxY: number},
 *   mode: "empty" | "layered" | "cycle",
 * }} routes: the points an arrow curves through between its two nodes, by
 *   edgeKey(), for the arrows that do not go straight
 */
export function layoutDiagram(nodes, edges, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const ids = nodes.map((node) => node.id);
    const known = new Set(ids);
    const usable = edges.filter((edge) => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to);
    if (!ids.length) {
        return { positions: new Map(), routes: new Map(), bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, mode: "empty" };
    }

    const found = components(ids, usable);
    // Nodes without any arrow yet share one row instead of a row each.
    const loners = found.filter((members) => members.length === 1).flat();
    const groups = found.filter((members) => members.length > 1).map((members) => {
        const inGroup = new Set(members);
        return layoutGroup(members, usable.filter((edge) => inGroup.has(edge.from)), opts);
    });
    if (loners.length) {
        groups.push(lonerRow(loners, opts));
    }
    const { positions, routes } = arrange(groups, opts);
    squeeze(positions, routes, opts);

    // Center the result on (0, 0), bends included.
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
    for (const bends of routes.values()) {
        for (const bend of bends) {
            bend.x -= dx;
            bend.y -= dy;
        }
    }
    // The shape of the largest group names the whole.
    const mode = groups.reduce((a, b) => (b.size > a.size ? b : a)).mode;
    return { positions, routes, bounds, mode };
}

/** Groups of nodes joined by arrows (either way), in the order they appeared. */
function components(ids, edges) {
    const neighbours = new Map(ids.map((id) => [id, []]));
    for (const edge of edges) {
        neighbours.get(edge.from).push(edge.to);
        neighbours.get(edge.to).push(edge.from);
    }
    const seen = new Set();
    const groups = [];
    for (const id of ids) {
        if (seen.has(id)) {
            continue;
        }
        const group = [];
        const stack = [id];
        seen.add(id);
        while (stack.length) {
            const current = stack.pop();
            group.push(current);
            for (const next of neighbours.get(current)) {
                if (!seen.has(next)) {
                    seen.add(next);
                    stack.push(next);
                }
            }
        }
        // Keep the reveal order inside the group too.
        const order = new Map(ids.map((other, index) => [other, index]));
        groups.push(group.sort((a, b) => order.get(a) - order.get(b)));
    }
    return groups;
}

/** One connected group: a circle around its longest cycle, or layers. */
function layoutGroup(ids, edges, opts) {
    const { dagEdges, longestCycle } = analyze(ids, edges);
    const mode = longestCycle.length >= 3 ? "cycle" : "layered";
    const { positions, routes } = mode === "cycle"
        ? { positions: circular(ids, edges, longestCycle, opts), routes: new Map() }
        : layered(ids, edges, dagEdges, opts);
    separatePairs(edges, positions, routes, opts.pairOffset);
    squeeze(positions, routes, opts);
    const xs = [...positions.values()].map((p) => p.x);
    const ys = [...positions.values()].map((p) => p.y);
    const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    return { positions, routes, box, mode, size: ids.length };
}

/** Unconnected nodes in a row, spaced like columns. */
function lonerRow(ids, opts) {
    const positions = new Map(ids.map((id, index) => [id, { x: index * opts.minLayerGap, y: 0, z: 0 }]));
    const box = { minX: 0, maxX: (ids.length - 1) * opts.minLayerGap, minY: 0, maxY: 0 };
    return { positions, routes: new Map(), box, mode: "layered", size: ids.length };
}

/** Side by side when they fit in the width, otherwise one under the other. */
function arrange(groups, opts) {
    const positions = new Map();
    const routes = new Map();
    const width = (group) => group.box.maxX - group.box.minX;
    const totalWidth = groups.reduce((sum, group) => sum + width(group), 0) + opts.groupGap * (groups.length - 1);
    const sideBySide = groups.length === 1 || totalWidth <= opts.maxWidth * 1.1;
    let cursor = 0;
    for (const group of groups) {
        // Shift so the group's box starts at the cursor (left, or top).
        const dx = sideBySide ? cursor - group.box.minX : -(group.box.minX + group.box.maxX) / 2;
        const dy = sideBySide ? -(group.box.minY + group.box.maxY) / 2 : cursor - group.box.maxY;
        for (const [id, p] of group.positions) {
            positions.set(id, { x: p.x + dx, y: p.y + dy, z: p.z });
        }
        for (const [key, bends] of group.routes) {
            routes.set(key, bends.map((b) => ({ x: b.x + dx, y: b.y + dy, z: b.z })));
        }
        cursor += sideBySide
            ? width(group) + opts.groupGap
            : -((group.box.maxY - group.box.minY) + opts.groupGap);
    }
    return { positions, routes };
}
