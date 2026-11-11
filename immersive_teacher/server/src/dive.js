/**
 * Going deeper into a node: the person taps a node of a diagram the teacher
 * drew, and the teacher explains that node.
 *
 * The browser names the diagram (by its turn) and the node (by its id). The
 * question for Claude is built here, from what the server itself kept of
 * that diagram: the node, its connections, the question it leaves open (its
 * hook) and the first question of the chain, so every level stays tied to
 * what the person asked at the start. Odoo AI gets a plain question with that
 * same starting point.
 *
 * The page also sends its own copy of that diagram and of the first question.
 * It is used only when the server no longer keeps them: after a reconnection
 * or a restart of the server, the session's memory starts empty while the
 * page still shows the diagram. The copy goes through the same checks as
 * Claude's DRAW lines, and the question is built from it the same way. That
 * opens nothing new: the page can already type any question.
 */

import { MESSAGES, format } from "./i18n.js";
import { DiagramBuilder, LIMITS, cleanText } from "./protocol/diagram.js";

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
        return findNode(this.get(turn), id);
    }
}

/** The node `id` of the diagram of `entry`, with that entry; null when there is none. */
export function findNode(entry, id) {
    const node = typeof id === "string" ? entry?.diagram.nodes.find((item) => item.id === id) : undefined;
    return node ? { entry, node } : null;
}

/**
 * The page's copy of a diagram, checked as Claude's DRAW lines are, as an
 * entry of the memory; null when it is not one the server could have drawn.
 * Without the first question, the diagram's title stands for it.
 *
 * @param {{diagram?: {title?: string, nodes?: object[], edges?: object[]}, root?: {question?: string, title?: string}}} copy
 * @returns {{diagram: object, root: {question: string, title: string}}|null}
 */
export function restoreEntry(copy) {
    const nodes = copy?.diagram?.nodes;
    const edges = copy?.diagram?.edges ?? [];
    if (!Array.isArray(nodes) || !Array.isArray(edges) || nodes.length > LIMITS.nodes || edges.length > LIMITS.edges) {
        return null;
    }
    const builder = new DiagramBuilder();
    builder.addStep(1, { nodes, edges });
    const diagram = builder.toJSON(copy.diagram.title);
    const question = cleanText(copy.root?.question, MAX_ROOT_CHARS) || diagram?.title;
    if (!question) {
        return null;
    }
    return { diagram, root: { question, title: cleanText(copy.root?.title, LIMITS.title) || diagram.title } };
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
