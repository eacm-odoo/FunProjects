/**
 * Shared explorations: one link that opens, on another screen, what someone
 * explored (one explanation with the path to it, or its whole tree), so the
 * next person goes on from there.
 *
 *     share {req, shown, turns, image?}  -> shared {req, id}, or share_error {req, code, message}
 *     open_share {id}                 -> share_opened {id, share}, or share_error {id, code, message}
 *     speak_share {turn, id, entry}   -> the speech of each sentence of that explanation, then spoken {turn}
 *
 * Only what the teacher itself said and drew can be shared. Each finished
 * answer comes with a seal (done.seal): an HMAC of its title, diagram,
 * sentences and citations, with a secret only the server knows. A share is
 * refused unless every explanation in it matches its seal, so a link always
 * shows the teacher's own words, never text written into a crafted request,
 * and speak_share only ever voices those words. The rest comes from the page
 * (the question as it showed it, the node each explanation went deeper into,
 * the nodes explored, where nodes were left) and is checked and cut to size
 * like any question.
 *
 * Each share is a JSON file in SHARES_DIR, named by a random id that is the
 * link, with the picture for its preview beside it (<id>.jpg, see
 * share_page.js) when the page sent one. Shares expire after SHARE_DAYS, and
 * past MAX_SHARES the oldest go first. The secret lives beside them
 * (.secret), so seals and links survive a restart.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { DIAGRAM_MEMORY, diveQuestion } from "./dive.js";
import { isLanguage, isLevel } from "./i18n.js";
import { LIMITS, cleanText, normalizeId } from "./protocol/diagram.js";
import { historyDrawLine } from "./turn.js";

export const SHARE_VERSION = 1;
/** A usual tree takes about 20 KB; no real one comes near this. */
export const MAX_SHARE_BYTES = 256 * 1024;
/** The question as the page showed it: a typed one is at most this long. */
const MAX_QUESTION_CHARS = 500;
const MAX_ROOT_CHARS = 200;
/** A node this far from the diagram is not where anybody left it. */
const MAX_PIN_METERS = 10;
const SHARE_ID_RE = /^[A-Za-z0-9_-]{12}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The preview's picture: a 1200 x 630 JPEG takes about 100 KB. */
export const MAX_IMAGE_BYTES = 400 * 1024;
const IMAGE_SIDES = Object.freeze({ min: 100, max: 2400 });
/** JPEG markers that start a frame and carry its size (all SOFn but DHT, JPG and DAC). */
const JPEG_FRAMES = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);

export class ShareError extends Error {
    /**
     * @param {string} code share_invalid, share_gone, ...
     * @param {string} message detail for the server log
     */
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export function isShareId(value) {
    return typeof value === "string" && SHARE_ID_RE.test(value);
}

/**
 * What a seal covers, in a fixed order. Throws on anything that is not
 * shaped like an answer.
 */
function canonicalTurn({ diagram, sentences, citations }) {
    return JSON.stringify([
        diagram.title,
        diagram.nodes.map((node) => [node.id, node.label, node.shape, node.color, node.step, node.icon ?? null, node.hook ?? null]),
        diagram.edges.map((edge) => [edge.from, edge.to, edge.step, edge.label ?? null]),
        sentences,
        citations.map((citation) => [
            citation.step, citation.source, citation.pages?.from ?? null, citation.pages?.to ?? null, citation.quote,
        ]),
    ]);
}

/** Seals answers as they finish, and checks the seals that come back with a share. */
export class Sealer {
    constructor(secret) {
        this.secret = secret;
    }

    /** @param {{diagram: object, sentences: string[], citations: object[]}} turn */
    seal(turn) {
        return createHmac("sha256", this.secret).update(canonicalTurn(turn)).digest("base64url");
    }

    verify(turn, seal) {
        if (typeof seal !== "string") {
            return false;
        }
        let expected;
        try {
            expected = Buffer.from(this.seal(turn));
        } catch {
            return false; // not shaped like an answer
        }
        const given = Buffer.from(seal);
        return given.length === expected.length && timingSafeEqual(given, expected);
    }
}

/**
 * The secret of the seals, kept in `dir`/.secret; a new one the first time.
 * When it cannot be saved, it lasts until the server stops: answers given
 * before a restart then can no longer be shared (links already made still open).
 */
export async function loadSecret(dir, logger = console) {
    const file = path.join(dir, ".secret");
    try {
        const saved = (await readFile(file, "utf8")).trim();
        if (saved.length >= 32) {
            return saved;
        }
    } catch (error) {
        if (error.code !== "ENOENT") {
            logger.warn(`Shares: could not read ${file} (${error.message}), using a new secret`);
        }
    }
    const secret = randomBytes(32).toString("base64url");
    try {
        await mkdir(dir, { recursive: true });
        await writeFile(file, `${secret}\n`, { mode: 0o600 });
    } catch (error) {
        logger.warn(`Shares: could not save the secret in ${file} (${error.message}); `
            + "after a restart, answers given before it can no longer be shared");
    }
    return secret;
}

/** The diagram with only the fields an answer has. */
function pickDiagram({ title, nodes, edges }) {
    return {
        title,
        nodes: nodes.map(({ id, label, shape, color, step, icon, hook }) => ({
            id, label, shape, color, step, ...(icon ? { icon } : {}), ...(hook ? { hook } : {}),
        })),
        edges: edges.map(({ from, to, step, label }) => ({ from, to, step, ...(label ? { label } : {}) })),
    };
}

function pickCitations(citations) {
    return citations.map(({ step, source, pages, quote }) => ({
        step, source, pages: pages ? { from: pages.from, to: pages.to } : null, quote,
    }));
}

/** The ids of `values` that are nodes of the diagram, each once. */
function nodeIds(values, ids) {
    return Array.isArray(values) ? [...new Set(values.filter((id) => typeof id === "string" && ids.has(id)))] : [];
}

/** Where the user left nodes of the diagram, to the millimeter; anything else is dropped. */
function cleanPins(pins, ids) {
    if (!pins || typeof pins !== "object" || Array.isArray(pins)) {
        return {};
    }
    const clean = {};
    for (const [id, pin] of Object.entries(pins)) {
        const values = [pin?.x, pin?.y, pin?.z];
        if (ids.has(id) && values.every((value) => Number.isFinite(value) && Math.abs(value) <= MAX_PIN_METERS)) {
            const [x, y, z] = values.map((value) => Math.round(value * 1000) / 1000);
            clean[id] = { x, y, z };
        }
    }
    return clean;
}

/**
 * The share as it is kept, from what the page sent. Explanations are
 * numbered from 1 in the page's order, and `parent` names an earlier one.
 * Throws a ShareError when an explanation does not match its seal.
 *
 * @param {{shown?: number, turns?: object[]}} message
 * @param {Sealer} sealer
 * @param {{language?: string}} [options] for an explanation that does not say its language
 * @returns {{v: number, shown: number, turns: object[]}}
 */
export function cleanShare(message, sealer, { language = "es" } = {}) {
    const items = Array.isArray(message?.turns) ? message.turns : [];
    if (!items.length || items.length > DIAGRAM_MEMORY) {
        throw new ShareError("share_invalid", `${items.length} explanations, expected 1 to ${DIAGRAM_MEMORY}`);
    }
    /** The page's turn number -> its number in the share. */
    const numbers = new Map();
    const turns = [];
    for (const item of items) {
        const content = { diagram: item?.diagram, sentences: item?.sentences, citations: item?.citations ?? [] };
        if (!sealer.verify(content, item?.seal)) {
            throw new ShareError("share_invalid", `explanation ${JSON.stringify(item?.turn)} does not match its seal`);
        }
        // Sealed: exactly what the teacher said and drew.
        const diagram = pickDiagram(content.diagram);
        const ids = new Set(diagram.nodes.map((node) => node.id));
        const number = turns.length + 1;
        const parent = turns[(numbers.get(item.parent) ?? 0) - 1] ?? null;
        const focus = normalizeId(item.focus);
        const linked = Boolean(parent?.diagram.nodes.some((node) => node.id === focus));
        const question = cleanText(item.question, MAX_QUESTION_CHARS) || diagram.title;
        turns.push({
            turn: number,
            parent: linked ? parent.turn : null,
            focus: linked ? focus : null,
            language: isLanguage(item.language) ? item.language : language,
            level: isLevel(item.level) ? item.level : "normal",
            question,
            // A deeper explanation keeps the first question of its chain, as the server's memory does.
            root: linked ? parent.root : {
                question: cleanText(item.root?.question, MAX_ROOT_CHARS) || cleanText(question, MAX_ROOT_CHARS),
                title: cleanText(item.root?.title, LIMITS.title) || diagram.title,
            },
            diagram,
            sentences: [...content.sentences],
            citations: pickCitations(content.citations),
            explored: nodeIds(item.explored, ids),
            pins: cleanPins(item.pins, ids),
        });
        if (Number.isSafeInteger(item.turn) && !numbers.has(item.turn)) {
            numbers.set(item.turn, number);
        }
    }
    const share = { v: SHARE_VERSION, shown: numbers.get(message.shown) ?? turns.length, turns };
    if (JSON.stringify(share).length > MAX_SHARE_BYTES) {
        throw new ShareError("share_invalid", `over ${MAX_SHARE_BYTES} bytes`);
    }
    return share;
}

/** The width and height of a JPEG, read from its frame header; null when `bytes` is not one. */
export function jpegSize(bytes) {
    const ends = bytes.length > 4 && bytes[bytes.length - 2] === 0xFF && bytes[bytes.length - 1] === 0xD9;
    if (!ends || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
        return null;
    }
    let offset = 2;
    while (offset + 9 < bytes.length && bytes[offset] === 0xFF) {
        const marker = bytes[offset + 1];
        if (JPEG_FRAMES.has(marker)) {
            return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        }
        offset += 2 + bytes.readUInt16BE(offset + 2);
    }
    return null;
}

/**
 * The preview's picture from the page (base64), checked: a JPEG of a sensible
 * size. Null when there is none or it is not one.
 * @returns {{bytes: Buffer, width: number, height: number}|null}
 */
export function cleanImage(base64) {
    if (typeof base64 !== "string" || !base64 || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
        return null;
    }
    const bytes = Buffer.from(base64, "base64");
    const size = bytes.length <= MAX_IMAGE_BYTES ? jpegSize(bytes) : null;
    const fits = (side) => side >= IMAGE_SIDES.min && side <= IMAGE_SIDES.max;
    return size && fits(size.width) && fits(size.height) ? { bytes, ...size } : null;
}

/** The share as the page gets it: each explanation with its seal, so it can be shared again. */
export function sealedShare(share, sealer) {
    return { shown: share.shown, turns: share.turns.map((turn) => ({ ...turn, seal: sealer.seal(turn) })) };
}

/** The answer as Claude wrote it: its title, then each sentence with what it drew. */
function answerLines({ diagram, sentences, focus }) {
    const lines = [`TITLE: ${diagram.title}`];
    sentences.forEach((text, index) => {
        const step = index + 1;
        lines.push(`SAY: ${text}`);
        // The node tapped to go deeper was already drawn: Claude did not draw it again.
        const nodes = diagram.nodes.filter((node) => node.step === step && node.id !== focus);
        const edges = diagram.edges.filter((edge) => edge.step === step);
        if (nodes.length || edges.length) {
            lines.push(historyDrawLine({ nodes, edges }));
        }
    });
    return lines.join("\n");
}

/**
 * The conversation that led to the explanation opened, as Claude had it:
 * the history of whoever opens the link, for their follow-up questions.
 * @returns {{question: string, answer: string}[]} the oldest first
 */
export function historyOf(share) {
    const byNumber = (number) => share.turns[number - 1] ?? null;
    const chain = [];
    for (let turn = byNumber(share.shown); turn && chain.length < share.turns.length; turn = turn.parent ? byNumber(turn.parent) : null) {
        chain.unshift(turn);
    }
    return chain.map((turn) => {
        const parent = turn.parent ? byNumber(turn.parent) : null;
        const node = parent?.diagram.nodes.find((item) => item.id === turn.focus);
        const question = node
            ? diveQuestion({ node, entry: { diagram: parent.diagram, root: turn.root }, language: turn.language }).text
            : turn.question;
        return { question, answer: answerLines(turn) };
    });
}

/** The shares on disk, one JSON file each. */
export class ShareStore {
    /**
     * @param {object} options
     * @param {string} options.dir
     * @param {number} options.maxShares past it, the oldest go
     * @param {number} options.days how long a link lasts
     * @param {() => number} [options.now]
     * @param {Console} [options.logger]
     */
    constructor({ dir, maxShares, days, now = () => Date.now(), logger = console }) {
        this.dir = dir;
        this.maxShares = maxShares;
        this.days = days;
        this.now = now;
        this.logger = logger;
    }

    #file(id) {
        return path.join(this.dir, `${id}.json`);
    }

    #image(id) {
        return path.join(this.dir, `${id}.jpg`);
    }

    /** Deletes share `id` and its picture. */
    async #remove(id) {
        await rm(this.#file(id), { force: true });
        await rm(this.#image(id), { force: true });
    }

    /**
     * Keeps `share`, with the picture of its preview when there is one, and
     * returns its id, the part of the link that names it.
     * @param {object} share from cleanShare()
     * @param {{bytes: Buffer, width: number, height: number}|null} [image] from cleanImage()
     */
    async save(share, image = null) {
        await mkdir(this.dir, { recursive: true });
        const id = randomBytes(9).toString("base64url");
        const created = new Date(this.now()).toISOString();
        if (image) {
            await writeFile(this.#image(id), image.bytes, { flag: "wx" });
        }
        const kept = image ? { ...share, image: { width: image.width, height: image.height } } : share;
        await writeFile(this.#file(id), JSON.stringify({ ...kept, created }), { flag: "wx" });
        await this.#prune(id).catch((error) => this.logger.warn(`Shares: could not clean up ${this.dir} (${error.message})`));
        return id;
    }

    /** The picture of share `id`'s preview, or null when the share or its picture is gone. */
    async loadImage(id) {
        const share = await this.load(id);
        if (!share?.image) {
            return null;
        }
        return readFile(this.#image(id)).catch(() => null);
    }

    /** The share `id`, or null when there is none or it expired. */
    async load(id) {
        if (!isShareId(id)) {
            return null;
        }
        let share;
        try {
            share = JSON.parse(await readFile(this.#file(id), "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT") {
                this.logger.warn(`Shares: could not read ${id} (${error.message})`);
            }
            return null;
        }
        if (share?.v !== SHARE_VERSION || !Array.isArray(share.turns) || this.#expired(Date.parse(share.created))) {
            await this.#remove(id);
            return null;
        }
        return share;
    }

    #expired(createdMs) {
        return !Number.isFinite(createdMs) || this.now() - createdMs >= this.days * DAY_MS;
    }

    /** Drops the expired shares, then the oldest ones past maxShares; `keep` stays. */
    async #prune(keep) {
        const ids = (await readdir(this.dir)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5))
            .filter((id) => id !== keep);
        const kept = [];
        for (const id of ids) {
            const { mtimeMs } = await stat(this.#file(id)).catch(() => ({ mtimeMs: NaN }));
            if (this.#expired(mtimeMs)) {
                await this.#remove(id);
            } else {
                kept.push({ id, mtimeMs });
            }
        }
        kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const { id } of kept.slice(0, Math.max(0, kept.length + 1 - this.maxShares))) {
            await this.#remove(id);
        }
    }
}
