/**
 * Going deeper into a node: the person taps a node of a diagram the teacher
 * drew, and the teacher explains that node.
 *
 * The browser only names the diagram (by its turn) and the node (by its id).
 * The question for Claude is built here, from what the server itself kept of
 * that diagram: the node, its connections, the question it leaves open (its
 * hook) and the first question of the chain, so every level stays tied to
 * what the person asked at the start. Odoo AI gets a plain question with that
 * same starting point.
 */

import { MESSAGES, format } from "./i18n.js";
import { cleanText } from "./protocol/diagram.js";

/** Finished diagrams a session keeps, the newest ones. */
export const DIAGRAM_MEMORY = 12;
/** The first question, as quoted in a deeper one. */
const MAX_ROOT_CHARS = 200;
/** Connections of the node named in the question. */
const MAX_LINKS = 4;

/** The finished diagrams of one connection, by turn, the oldest dropped first. */
export class DiagramMemory {
    constructor(maxEntries = DIAGRAM_MEMORY) {
        this.maxEntries = maxEntries;
        /** @type {Map<number, {diagram: object, root: {question: string, title: string}}>} */
        this.entries = new Map();
    }

    remember(turn, entry) {
        this.entries.delete(turn);
        this.entries.set(turn, entry);
        while (this.entries.size > this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
        }
    }

    get(turn) {
        return this.entries.get(turn) ?? null;
    }

    /** The node `id` of the diagram of `turn`, with that entry; null when either is gone. */
    find(turn, id) {
        const entry = this.get(turn);
        const node = typeof id === "string" ? entry?.diagram.nodes.find((item) => item.id === id) : undefined;
        return node ? { entry, node } : null;
    }
}

/** "Planta → Glucosa (produce)" for each connection of `node`, up to MAX_LINKS. */
function describeLinks(node, diagram) {
    const labels = new Map(diagram.nodes.map((item) => [item.id, item.label]));
    return diagram.edges
        .filter((edge) => edge.from === node.id || edge.to === node.id)
        .slice(0, MAX_LINKS)
        .map((edge) => {
            const arrow = `${labels.get(edge.from)} → ${labels.get(edge.to)}`;
            return edge.label ? `${arrow} (${edge.label})` : arrow;
        });
}

/**
 * @param {object} options
 * @param {object} options.node the tapped node, as the diagram kept it
 * @param {{diagram: object, root: {question: string, title: string}}} options.entry its diagram
 * @param {string} options.language
 * @returns {{text: string, odooQuestion: string}} the question for Claude and the one for Odoo AI
 */
export function diveQuestion({ node, entry, language }) {
    const texts = MESSAGES[language].dive;
    const root = cleanText(entry.root.question, MAX_ROOT_CHARS);
    const values = { label: node.label, id: node.id, title: entry.diagram.title, root, hook: node.hook ?? "" };
    const lines = [format(texts.prompt, values)];
    const links = describeLinks(node, entry.diagram);
    if (links.length) {
        lines.push(format(texts.links, { links: links.join("; ") }));
    }
    if (node.hook) {
        lines.push(format(texts.hook, values));
    }
    return {
        text: lines.join("\n"),
        odooQuestion: format(node.hook ? texts.odooHook : texts.odoo, values),
    };
}
