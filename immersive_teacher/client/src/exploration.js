/**
 * The page's side of going deeper into a node: which diagram came from which
 * node of which other one, which nodes were already opened, and which
 * diagram is on screen.
 *
 * A typed or spoken question starts a new chain with no parent. Tapping a
 * node starts a turn whose parent is the diagram the node belongs to, and
 * marks that node as explored there. Going back is only showing the parent
 * again: nothing is asked. Tapping a node already explored shows the diagram
 * it gave (childOf), silently: nothing is asked either.
 *
 * Each turn also keeps what the teacher said (its sentences and the speech
 * received for each one), so the explanation can be said again without
 * asking the server (replayable).
 *
 * It keeps as many diagrams as the server does (dive.js): an older one could
 * not be explored any more anyway.
 *
 * Pure logic, no three.js: it runs under node:test.
 */

export const DIAGRAM_MEMORY = 12;

export class Exploration {
    constructor(maxEntries = DIAGRAM_MEMORY) {
        this.maxEntries = maxEntries;
        /**
         * @type {Map<number, {turnId: number, parentTurnId: number|null, focusId: string|null,
         *   diagram: object|null, explored: Set<string>, complete: boolean, sentences: Map<number, string>,
         *   speech: Map<number, {sampleRate: number, chunks: Int16Array[]}>}>}
         */
        this.entries = new Map();
        /** The turn whose diagram is on screen (or being drawn), null before the first one. */
        this.shown = null;
    }

    /**
     * A question starts.
     * @param {number} turnId
     * @param {{from: number, node: string}|null} [dive] the node it goes deeper into
     */
    begin(turnId, dive = null) {
        this.entries.set(turnId, {
            turnId,
            parentTurnId: dive?.from ?? null,
            focusId: dive?.node ?? null,
            diagram: null,
            explored: new Set(),
            // Set by finish(): the answer arrived whole.
            complete: false,
            sentences: new Map(),
            speech: new Map(),
        });
        if (dive) {
            this.entries.get(dive.from)?.explored.add(dive.node);
        }
        this.shown = turnId;
        while (this.entries.size > this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
        }
    }

    /** The turn is done: its whole diagram, as the server sent it (null without one). */
    finish(turnId, diagram) {
        const entry = this.entries.get(turnId);
        if (entry) {
            entry.diagram = diagram ?? null;
            entry.complete = true;
        }
    }

    /** A sentence the teacher says in `turnId`. */
    addSentence(turnId, step, text) {
        this.entries.get(turnId)?.sentences.set(step, text);
    }

    /** The speech of sentence `step` starts streaming. */
    speechStart(turnId, step, sampleRate) {
        this.entries.get(turnId)?.speech.set(step, { sampleRate, chunks: [] });
    }

    /** @param {Int16Array} samples */
    speechChunk(turnId, step, samples) {
        this.entries.get(turnId)?.speech.get(step)?.chunks.push(samples);
    }

    /** Whether the explanation of `turnId` can be said again: whole, with its diagram. */
    replayable(turnId) {
        const entry = this.entry(turnId);
        return Boolean(entry?.complete && entry.diagram && entry.sentences.size);
    }

    /** The finished diagram a node already gave when it was explored, or null. */
    childOf(turnId, nodeId) {
        let child = null;
        for (const entry of this.entries.values()) {
            if (entry.parentTurnId === turnId && entry.focusId === nodeId && entry.complete && entry.diagram) {
                child = entry; // the latest one
            }
        }
        return child;
    }

    entry(turnId) {
        return this.entries.get(turnId) ?? null;
    }

    /** The node `nodeId` of the finished diagram of `turnId`, or null. */
    node(turnId, nodeId) {
        return this.entry(turnId)?.diagram?.nodes.find((node) => node.id === nodeId) ?? null;
    }

    /** The diagram one level up from `turnId`, when it has one and it is still kept. */
    parentOf(turnId) {
        const parentTurnId = this.entry(turnId)?.parentTurnId;
        const parent = parentTurnId === null || parentTurnId === undefined ? null : this.entry(parentTurnId);
        return parent?.diagram ? parent : null;
    }

    /** The title "‹ ..." above the diagram of `turnId` goes back to; null at the top of a chain. */
    parentTitle(turnId) {
        return this.parentOf(turnId)?.diagram.title ?? null;
    }

    /** Questions left open in the diagram of `turnId` that were not explored yet. */
    hooksOf(turnId) {
        const entry = this.entry(turnId);
        return (entry?.diagram?.nodes ?? [])
            .filter((node) => node.hook && !entry.explored.has(node.id))
            .map(({ id, label, hook }) => ({ id, label, hook }));
    }
}
