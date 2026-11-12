/**
 * Answers kept for the next person who asks the same thing: what keeps a
 * public demo cheap. A question asked again is answered from what was kept,
 * at once and without paying Claude or the voice: the same sentences, diagram
 * and speech, sent as the turn sent them the first time.
 *
 * "The same" means the same words once lower-cased and without accents or
 * punctuation, in the same language and at the same level, with the same
 * model, prompt and voice (see signatureOf: changing any of them in .env
 * starts over).
 *
 * Only answers that depend on nothing but their question are kept and given
 * (the session decides, see Session#answersFor):
 * - a question with nothing asked before it on that connection, since a
 *   follow-up leans on the conversation;
 * - going deeper into a node, whose question already carries everything it
 *   needs (see dive.js);
 * never with documents loaded or Odoo AI on, and never an answer that failed,
 * was refused or lost part of its voice (see turn.js).
 *
 * Each answer is two files in CACHE_DIR: <key>.json (what was sent, in order)
 * and <key>.pcm (the speech, 16-bit PCM). Past MAX_CACHED_ANSWERS the least
 * recently used go first.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { MESSAGES } from "./i18n.js";
import { SYSTEM_PROMPTS } from "./llm/system_prompt.js";

const CACHE_VERSION = 1;
/** About 85 s of speech at 24 kHz: no real answer is that long, and nothing longer is kept. */
export const MAX_KEPT_AUDIO_BYTES = 8 * 1024 * 1024;
const KEY_RE = /^[0-9a-f]{40}$/;

/** "¿Cómo funciona el CICLO del agua?" and "como funciona el ciclo del agua" are one question. */
export function normalizeQuestion(text) {
    return String(text)
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

/**
 * Everything besides the question that shapes an answer: the model and how
 * it thinks, the prompts and level notes, and the voice. A change in any of
 * them makes every kept answer stale, so it goes in every key.
 */
export function signatureOf(config) {
    const { llm, tts } = config;
    const prompts = createHash("sha256")
        .update(JSON.stringify([SYSTEM_PROMPTS, Object.fromEntries(Object.entries(MESSAGES).map(([lang, m]) => [lang, m.levels]))]))
        .digest("hex");
    return JSON.stringify([
        llm.provider, llm.model, llm.effort, llm.thinking, llm.maxTokens, prompts,
        tts.provider, tts.voices ?? null, tts.provider === "elevenlabs" ? tts.model : null, tts.speed, tts.sampleRate,
    ]);
}

export class AnswerCache {
    /**
     * @param {object} options
     * @param {string} options.dir
     * @param {number} options.maxEntries past it, the least recently used go
     * @param {string} options.signature from signatureOf()
     * @param {Console} [options.logger]
     */
    constructor({ dir, maxEntries, signature, logger = console }) {
        this.dir = dir;
        this.maxEntries = maxEntries;
        this.signature = signature;
        this.logger = logger;
    }

    /** The key of an answer to `question`, asked in `language` at `level`. */
    keyFor({ question, language, level }) {
        return createHash("sha256")
            .update(JSON.stringify([CACHE_VERSION, this.signature, language, level, normalizeQuestion(question)]))
            .digest("hex")
            .slice(0, 40);
    }

    #files(key) {
        return { json: path.join(this.dir, `${key}.json`), pcm: path.join(this.dir, `${key}.pcm`) };
    }

    async #remove(key) {
        const files = this.#files(key);
        await rm(files.json, { force: true });
        await rm(files.pcm, { force: true });
    }

    /**
     * The answer kept under `key`, or null.
     * @returns {Promise<{events: object[], historyAnswer: string, diagram: object|null, stopReason: string,
     *   audio: Buffer}|null>}
     */
    async get(key) {
        if (!KEY_RE.test(key)) {
            return null;
        }
        const files = this.#files(key);
        let kept;
        try {
            kept = JSON.parse(await readFile(files.json, "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT") {
                this.logger.warn(`Answer cache: could not read ${key} (${error.message})`);
            }
            return null;
        }
        let audio = Buffer.alloc(0);
        if (kept.audioBytes) {
            audio = await readFile(files.pcm).catch(() => null);
        }
        if (kept.v !== CACHE_VERSION || !Array.isArray(kept.events) || audio?.length !== (kept.audioBytes ?? 0)) {
            await this.#remove(key);
            return null;
        }
        // Used now: the last to go.
        const now = new Date();
        await utimes(files.json, now, now).catch(() => {});
        const { events, historyAnswer, diagram, stopReason } = kept;
        return { events, historyAnswer, diagram, stopReason, audio };
    }

    /**
     * Keeps an answer under `key`. Returns false when it is too long to keep.
     * @param {{events: object[], historyAnswer: string, diagram: object|null, stopReason: string, audio: Buffer}} answer
     */
    async put(key, { events, historyAnswer, diagram, stopReason, audio }) {
        if (!KEY_RE.test(key) || audio.length > MAX_KEPT_AUDIO_BYTES) {
            return false;
        }
        await mkdir(this.dir, { recursive: true });
        const files = this.#files(key);
        // Written aside and renamed, the speech first: a reader never finds half an answer.
        const temporary = `.${randomBytes(6).toString("hex")}.tmp`;
        if (audio.length) {
            await writeFile(files.pcm + temporary, audio);
            await rename(files.pcm + temporary, files.pcm);
        }
        const kept = { v: CACHE_VERSION, events, historyAnswer, diagram, stopReason, audioBytes: audio.length };
        await writeFile(files.json + temporary, JSON.stringify(kept));
        await rename(files.json + temporary, files.json);
        await this.#prune(key).catch((error) => this.logger.warn(`Answer cache: could not clean up ${this.dir} (${error.message})`));
        return true;
    }

    /** Past maxEntries, drops the answers used longest ago; `keep` stays. */
    async #prune(keep) {
        const keys = (await readdir(this.dir))
            .filter((name) => name.endsWith(".json"))
            .map((name) => name.slice(0, -5))
            .filter((key) => KEY_RE.test(key) && key !== keep);
        if (keys.length < this.maxEntries) {
            return;
        }
        const used = [];
        for (const key of keys) {
            const { mtimeMs } = await stat(this.#files(key).json).catch(() => ({ mtimeMs: 0 }));
            used.push({ key, mtimeMs });
        }
        used.sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const { key } of used.slice(0, used.length + 1 - this.maxEntries)) {
            await this.#remove(key);
        }
    }
}
