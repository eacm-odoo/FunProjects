/**
 * One browser connection: its history and the turn in progress.
 *
 * A question arrives either as `ask_text`, or as `ask_audio` followed by one
 * binary message with the whole recording. A new question cancels the one in
 * progress (the user interrupted), and every event sent back carries the turn
 * number so the browser can drop stale ones. Speech goes back as binary
 * frames (see protocol/audio_frame.js).
 *
 * Each question names its language ("es" or "en"); without one, or with one
 * the server does not speak, it uses TEACHER_LANGUAGE. The history is kept
 * across a switch: the system prompt makes Claude answer in the new language.
 *
 * Sources (documents and public pages the teacher answers from) belong to
 * the connection too. The browser names each one with its own id:
 *
 *     source_file {id, name, mime}, then one binary message with the file
 *     source_url {id, url}
 *     source_remove {id}
 *
 * and gets back `source_added {id, source}` or `source_error {id, code,
 * message}`. Loading happens beside the questions: asking while a document
 * loads is fine, and the question goes without it.
 *
 * Each question can also name a `level` ("kid", "normal" or "expert", see
 * LEVELS); anything else is "normal".
 *
 * A question with `odoo: true` goes first to Odoo AI (see odoo_ai.js) when the
 * server has it on; `hello.odooAi` tells the page whether to show its switch.
 * Odoo AI's side of the conversation is kept here, for the follow-ups.
 *
 * `ask_node {turn, from, node, diagram?, root?}` goes deeper into one node of
 * a diagram the teacher drew in turn `from` (see dive.js). The session keeps
 * the last finished diagrams for that. When it no longer has the one named
 * (the connection is new), it uses the page's copy, `diagram` and `root`;
 * without a usable one, the answer is the error `node_gone`.
 *
 * With shares on (see shares.js), every finished answer carries a seal, and:
 *
 *     share {req, shown, turns, image?}  -> shared {req, id} | share_error {req, code, message}
 *     open_share {id}                 -> share_opened {id, share} | share_error {id, code, message}
 *     speak_share {turn, id, entry}   -> audio_start / frames / audio_end per sentence, then spoken {turn}
 *
 * Opening a share starts this connection's history over with the conversation
 * that led to the explanation opened, so the next question follows from it.
 * Voicing a shared explanation does not ask Claude; it counts in its own
 * hourly window, as long as MAX_QUESTIONS_PER_HOUR.
 *
 * With kept answers on (see answer_cache.js), a question that depends on
 * nothing but its words is answered from them when it was asked before, and
 * does not count for MAX_QUESTIONS_PER_HOUR.
 */

import { WebSocket } from "ws";

import { DiagramMemory, diveQuestion, findNode, restoreEntry } from "./dive.js";
import { ConversationHistory } from "./history.js";
import { MESSAGES, format, isLanguage, isLevel } from "./i18n.js";
import { OdooHistory } from "./odoo_ai.js";
import { MAX_TURN, encodeAudioFrame } from "./protocol/audio_frame.js";
import { ShareError, cleanImage, cleanShare, historyOf, isShareId, sealedShare } from "./shares.js";
import { SourceList, countSourceTokens, isSourceId, readSource } from "./sources/index.js";
import { TtsQueue } from "./speech/tts_queue.js";
import { runTurn } from "./turn.js";

const MAX_QUESTION_LENGTH = 500;
let connectionCount = 0;
/** About 60 s of opus; the browser already stops at MAX_RECORDING_SECONDS. */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const AUDIO_MIME_RE = /^audio\/[a-z0-9.+-]+(;\s*codecs=[a-z0-9.,"-]+)?$/i;
/** Shares a connection keeps at hand after opening them, for their voice. */
const OPENED_SHARES = 4;

export class Session {
    /**
     * @param {object} options
     * @param {WebSocket} options.socket
     * @param {object} options.config result of loadConfig()
     * @param {object} options.llm
     * @param {object} options.stt
     * @param {object|null} options.tts null when TTS_PROVIDER=none
     * @param {object|null} [options.odooAi] adapter from odoo_ai.js, null when ODOO_AI=off
     * @param {import("./limits.js").HourlyLimiter} options.limiter
     * @param {import("./shares.js").ShareStore|null} [options.shares] null when MAX_SHARES=0
     * @param {import("./shares.js").Sealer|null} [options.sealer] seals answers, checks shared ones
     * @param {import("./limits.js").HourlyLimiter} [options.voiceLimiter] voicings of shared explanations
     * @param {import("./answer_cache.js").AnswerCache|null} [options.answers] kept answers, null when MAX_CACHED_ANSWERS=0
     * @param {Console} [options.logger]
     * @param {(address: string) => boolean} [options.isAllowedAddress] where URLs may point; tests open it to a local server
     */
    constructor({
        socket, config, llm, stt, tts, odooAi = null, limiter, shares = null, sealer = null, voiceLimiter = null,
        answers = null, logger = console, isAllowedAddress,
    }) {
        this.socket = socket;
        this.config = config;
        this.llm = llm;
        this.stt = stt;
        this.tts = tts;
        this.odooAi = odooAi;
        this.odooHistory = new OdooHistory(config.historyTurns);
        this.limiter = limiter;
        this.shares = shares && sealer ? shares : null;
        this.sealer = sealer;
        this.voiceLimiter = voiceLimiter ?? limiter;
        this.answers = answers;
        /** @type {Map<string, object>} shares opened here, by id */
        this.openedShares = new Map();
        this.logger = logger;
        // Turn numbers restart at 1 on every page load; the log shows "connection.turn".
        this.connectionId = ++connectionCount;
        this.history = new ConversationHistory(config.historyTurns);
        /** Finished diagrams, for going deeper into one of their nodes. */
        this.diagrams = new DiagramMemory();
        /** @type {{id: number, controller: AbortController} | null} */
        this.current = null;
        /**
         * The announcement waiting for its binary message: a recording or a file.
         * @type {{kind: "audio", turn: number, mime: string, language: string, options: object}
         *      | {kind: "file", id: string, name: string, mime: string, language: string} | null}
         */
        this.pendingBinary = null;
        this.sources = new SourceList(config.sources);
        /** @type {Map<string, AbortController>} sources being read or counted */
        this.sourceLoads = new Map();
        this.isAllowedAddress = isAllowedAddress;

        socket.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
        socket.on("close", () => {
            this.#cancelCurrent("connection closed");
            for (const controller of this.sourceLoads.values()) {
                controller.abort(new Error("connection closed"));
            }
        });
        this.#send({
            type: "hello",
            llm: { provider: llm.name, model: llm.model },
            stt: { provider: stt.name, maxSeconds: config.stt.maxSeconds },
            tts: tts ? { enabled: true, provider: tts.name, sampleRate: tts.sampleRate } : { enabled: false },
            maxQuestionsPerHour: config.maxQuestionsPerHour,
            // The browser starts in this language unless the user chose one.
            language: config.language,
            sources: {
                maxCount: config.sources.maxCount,
                maxBytes: config.sources.maxBytes,
                maxTokens: config.sources.maxTokens,
            },
            odooAi: Boolean(odooAi),
            share: Boolean(this.shares),
        });
    }

    #send(event) {
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(event));
        }
    }

    #sendBinary(frame) {
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(frame, { binary: true });
        }
    }

    #onMessage(data, isBinary) {
        if (isBinary) {
            this.#onBinary(data);
            return;
        }
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            this.logger.warn("message that is not JSON ignored");
            return;
        }
        switch (message?.type) {
            case "ask_text":
                this.#askText(message);
                break;
            case "ask_audio":
                this.#announceAudio(message);
                break;
            case "ask_node":
                this.#askNode(message);
                break;
            case "cancel":
                if (this.current && this.current.id === message.turn) {
                    this.#cancelCurrent("cancelled by the user");
                }
                break;
            case "source_file":
                this.#announceFile(message);
                break;
            case "source_url":
                this.#loadUrl(message);
                break;
            case "source_remove":
                this.#removeSource(message);
                break;
            case "share":
                void this.#share(message);
                break;
            case "open_share":
                void this.#openShare(message);
                break;
            case "speak_share":
                void this.#speakShare(message);
                break;
            default:
                this.logger.warn(`unknown message type ${JSON.stringify(message?.type)} ignored`);
        }
    }

    #cancelCurrent(reason) {
        if (this.current) {
            this.current.controller.abort(new Error(reason));
            this.current = null;
        }
    }

    #validTurn(turn) {
        if (Number.isSafeInteger(turn) && turn >= 0 && turn <= MAX_TURN) {
            return true;
        }
        this.logger.warn(`question without a valid turn number: ${JSON.stringify(turn)}`);
        return false;
    }

    /** What a question asks for besides itself: Odoo AI first, and the level. */
    #optionsOf(message) {
        return { odoo: message.odoo === true, level: isLevel(message.level) ? message.level : "normal" };
    }

    #languageOf(message) {
        return isLanguage(message.language) ? message.language : this.config.language;
    }

    #error(turn, language, code, values = {}) {
        this.#send({ type: "error", code, message: format(MESSAGES[language].errors[code], values), turn });
    }

    #askText(message) {
        const { turn, text } = message;
        if (!this.#validTurn(turn)) {
            return;
        }
        if (this.pendingBinary?.kind === "audio") {
            this.pendingBinary = null; // its recording never came
        }
        const language = this.#languageOf(message);
        const question = typeof text === "string" ? text.trim() : "";
        if (!question || question.length > MAX_QUESTION_LENGTH) {
            this.#error(turn, language, "bad_request", { max: MAX_QUESTION_LENGTH });
            return;
        }
        this.#startTurn(turn, language, { text: question }, this.#optionsOf(message));
    }

    #askNode(message) {
        const { turn, from, node } = message;
        if (!this.#validTurn(turn)) {
            return;
        }
        if (this.pendingBinary?.kind === "audio") {
            this.pendingBinary = null;
        }
        const language = this.#languageOf(message);
        const label = `${this.connectionId}.${turn}`;
        let found = this.diagrams.find(from, node);
        if (!found) {
            // A new connection (the page reconnected, or the server restarted): the page's copy.
            found = findNode(restoreEntry(message), node);
            if (found) {
                this.logger.info(`[turn ${label}] diagram of turn ${JSON.stringify(from)} taken from the page's copy`);
            }
        }
        if (!found) {
            this.logger.warn(`[turn ${label}] node ${JSON.stringify(node)} of turn ${JSON.stringify(from)} is not kept`);
            this.#error(turn, language, "node_gone");
            return;
        }
        const { text, odooQuestion } = diveQuestion({ ...found, language });
        this.#startTurn(turn, language, { text }, {
            ...this.#optionsOf(message),
            dive: { node: found.node, odooQuestion, root: found.entry.root },
        });
    }

    #announceAudio(message) {
        const { turn, mime } = message;
        if (!this.#validTurn(turn)) {
            return;
        }
        const language = this.#languageOf(message);
        if (typeof mime !== "string" || !AUDIO_MIME_RE.test(mime)) {
            this.#error(turn, language, "bad_audio");
            return;
        }
        this.pendingBinary = { kind: "audio", turn, mime, language, options: this.#optionsOf(message) };
    }

    #onBinary(data) {
        const pending = this.pendingBinary;
        this.pendingBinary = null;
        if (!pending) {
            this.logger.warn("binary message without ask_audio or source_file before it, ignored");
            return;
        }
        const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data);
        if (pending.kind === "file") {
            this.#loadFile(pending, bytes);
        } else {
            this.#onRecording(pending, bytes);
        }
    }

    #onRecording(pending, audio) {
        if (!audio.length) {
            this.#error(pending.turn, pending.language, "empty_transcript");
            return;
        }
        if (audio.length > MAX_AUDIO_BYTES) {
            this.#error(pending.turn, pending.language, "audio_too_long");
            return;
        }
        this.logger.info(`[turn ${this.connectionId}.${pending.turn}] recording received: ${(audio.length / 1024).toFixed(1)} KB ${pending.mime}`);
        this.#startTurn(pending.turn, pending.language, { audio, mime: pending.mime }, pending.options);
    }

    // --- Sources ------------------------------------------------------------

    #sourceError(id, language, code, values = {}) {
        const messages = MESSAGES[language];
        const template = messages.sources[code] ?? messages.errors[code] ?? messages.sources.source_failed;
        const numbers = new Intl.NumberFormat(language);
        const shown = Object.fromEntries(Object.entries(values).map(([key, value]) => (
            [key, typeof value === "number" && key !== "status" ? numbers.format(value) : value]
        )));
        this.#send({ type: "source_error", id, code, message: format(template, shown) });
    }

    /** Whether a new source `id` may start loading; answers the browser when not. */
    #canLoad(id, language) {
        if (!isSourceId(id)) {
            this.logger.warn(`source without a valid id: ${JSON.stringify(id)}`);
            return false;
        }
        if (this.sources.has(id) || this.sourceLoads.has(id)) {
            this.#sourceError(id, language, "source_bad_request");
            return false;
        }
        const { maxCount } = this.config.sources;
        if (this.sources.items.length + this.sourceLoads.size >= maxCount) {
            this.#sourceError(id, language, "source_limit", { max: maxCount });
            return false;
        }
        return true;
    }

    #announceFile(message) {
        const { id, name, mime } = message;
        const language = this.#languageOf(message);
        if (!this.#canLoad(id, language)) {
            // The file still comes: mark it so it is not taken for a recording.
            this.pendingBinary = { kind: "file", id: null, name: "", mime: "", language };
            return;
        }
        this.pendingBinary = {
            kind: "file",
            id,
            name: typeof name === "string" ? name : "",
            mime: typeof mime === "string" ? mime.slice(0, 200) : "",
            language,
        };
    }

    #loadFile(pending, data) {
        if (pending.id === null) {
            return; // refused when it was announced
        }
        const { name, mime } = pending;
        void this.#loadSource(pending.id, pending.language, (signal) => readSource(
            { file: { name, mime, data } },
            { maxBytes: this.config.sources.maxBytes, signal },
        ));
    }

    #loadUrl(message) {
        const { id, url } = message;
        const language = this.#languageOf(message);
        if (!this.#canLoad(id, language)) {
            return;
        }
        void this.#loadSource(id, language, (signal) => readSource(
            { url },
            { maxBytes: this.config.sources.maxBytes, signal, isAllowed: this.isAllowedAddress },
        ));
    }

    /**
     * Reads a source, counts its tokens and adds it, or tells the browser why
     * not. `read(signal)` returns the document (see sources/index.js).
     */
    async #loadSource(id, language, read) {
        const controller = new AbortController();
        this.sourceLoads.set(id, controller);
        const log = `[sources ${this.connectionId}]`;
        const started = performance.now();
        let document = null;
        try {
            document = await read(controller.signal);
            // A text far over the limit is refused without asking Claude to count it.
            const estimate = document.chars === null ? 0 : Math.ceil(document.chars / 4);
            const tokens = estimate > this.sources.maxTokens
                ? estimate
                : await countSourceTokens(this.llm, document.block, controller.signal);
            controller.signal.throwIfAborted();
            const item = { id, ...document, tokens };
            delete item.chars;
            this.sources.add(item);
            const [source] = this.sources.describe().filter((entry) => entry.id === id);
            this.#send({ type: "source_added", id, source });
            const ms = Math.round(performance.now() - started);
            this.logger.info(`${log} added ${JSON.stringify(item.title)} (${item.kind} from ${item.origin}): `
                + `${tokens} tokens, ${this.sources.tokens} of ${this.sources.maxTokens} in use, ${ms} ms`);
        } catch (error) {
            if (controller.signal.aborted) {
                this.logger.info(`${log} ${id} stopped: ${controller.signal.reason?.message ?? "aborted"}`);
                return;
            }
            const messages = MESSAGES[language];
            let code = error?.code === "llm_bad_request" ? "source_unreadable" : error?.code;
            if (!(code in messages.sources) && !(code in messages.errors)) {
                code = "source_failed";
                this.logger.error(`${log} ${id} failed`, error);
            } else {
                this.logger.warn(`${log} ${id} refused (${code}): ${error.message}`);
            }
            this.#sourceError(id, language, code, { name: document?.title ?? id, ...error?.values });
        } finally {
            if (this.sourceLoads.get(id) === controller) {
                this.sourceLoads.delete(id);
            }
        }
    }

    #removeSource(message) {
        const { id } = message;
        if (!isSourceId(id)) {
            return;
        }
        this.sourceLoads.get(id)?.abort(new Error("removed by the user"));
        this.sourceLoads.delete(id);
        if (this.sources.remove(id)) {
            this.logger.info(`[sources ${this.connectionId}] ${id} removed, ${this.sources.tokens} tokens in use`);
        }
    }

    // --- Shares ---------------------------------------------------------------

    /** Makes a link of explanations the page kept, if each one matches its seal. */
    async #share(message) {
        const { req } = message;
        if (!Number.isSafeInteger(req)) {
            this.logger.warn(`share without a valid request number: ${JSON.stringify(req)}`);
            return;
        }
        const language = this.#languageOf(message);
        const log = `[share ${this.connectionId}.${req}]`;
        const refuse = (code) => this.#send({ type: "share_error", req, code, message: MESSAGES[language].errors[code] });
        if (!this.shares) {
            refuse("share_off");
            return;
        }
        let share;
        try {
            share = cleanShare(message, this.sealer, { language: this.config.language });
        } catch (error) {
            if (error instanceof ShareError) {
                this.logger.warn(`${log} refused: ${error.message}`);
            } else {
                this.logger.error(`${log} refused`, error);
            }
            refuse(error.code ?? "share_invalid");
            return;
        }
        // The picture of the link's preview, drawn by the page: kept when it is a JPEG of a sensible size.
        const image = cleanImage(message.image);
        if (message.image && !image) {
            this.logger.warn(`${log} picture dropped: not a JPEG of 100 to 2400 pixels a side, under 400 KB`);
        }
        try {
            const id = await this.shares.save(share, image);
            const picture = image ? `, picture ${image.width}x${image.height} ${(image.bytes.length / 1024).toFixed(0)} KB` : "";
            this.logger.info(`${log} saved as ${id}: ${share.turns.length} explanation(s), opens at ${share.shown}${picture}`);
            this.#send({ type: "shared", req, id });
        } catch (error) {
            this.logger.error(`${log} could not be saved`, error);
            refuse("share_failed");
        }
    }

    /** The share `id`, from this connection's own or from disk; null when it is gone. */
    async #loadShare(id) {
        if (!this.shares || !isShareId(id)) {
            return null;
        }
        if (this.openedShares.has(id)) {
            return this.openedShares.get(id);
        }
        const share = await this.shares.load(id);
        if (share) {
            this.openedShares.set(id, share);
            while (this.openedShares.size > OPENED_SHARES) {
                this.openedShares.delete(this.openedShares.keys().next().value);
            }
        }
        return share;
    }

    /** Sends a shared exploration to the page; the conversation goes on from the explanation it opens at. */
    async #openShare(message) {
        const { id } = message;
        const language = this.#languageOf(message);
        const named = isShareId(id) ? id : null;
        const refuse = (code) => this.#send({ type: "share_error", id: named, code, message: MESSAGES[language].errors[code] });
        if (!this.shares) {
            refuse("share_off");
            return;
        }
        const share = await this.#loadShare(id);
        if (!share) {
            this.logger.warn(`[share ${this.connectionId}] ${JSON.stringify(id)} is gone`);
            refuse("share_gone");
            return;
        }
        this.history = new ConversationHistory(this.config.historyTurns);
        for (const { question, answer } of historyOf(share)) {
            this.history.add(question, answer);
        }
        this.logger.info(`[share ${this.connectionId}] opened ${id}: ${share.turns.length} explanation(s)`);
        this.#send({ type: "share_opened", id, share: sealedShare(share, this.sealer) });
    }

    /**
     * Says the sentences of explanation `entry` of share `id` again, as turn
     * `turn`: only those, never any text from the page. Claude is not asked.
     */
    async #speakShare(message) {
        const { turn, id, entry } = message;
        if (!this.#validTurn(turn)) {
            return;
        }
        const language = this.#languageOf(message);
        const label = `${this.connectionId}.${turn}`;
        const share = await this.#loadShare(id);
        const item = share?.turns.find((candidate) => candidate.turn === entry);
        if (!item) {
            this.logger.warn(`[turn ${label}] explanation ${JSON.stringify(entry)} of share ${JSON.stringify(id)} is gone`);
            this.#error(turn, language, "share_gone");
            return;
        }
        if (!this.tts) {
            this.#send({ type: "spoken", turn });
            return;
        }
        const quota = this.voiceLimiter.tryAcquire();
        if (!quota.ok) {
            const minutes = Math.ceil(quota.retryInSeconds / 60);
            this.#error(turn, language, "rate_limited", { max: this.config.maxQuestionsPerHour, minutes });
            this.logger.warn(`[turn ${label}] voice of a shared explanation refused: hourly limit reached`);
            return;
        }
        this.#cancelCurrent("replaced by a shared explanation");
        const controller = new AbortController();
        const current = { id: turn, controller };
        this.current = current;
        const voice = MESSAGES[item.language] ?? MESSAGES[language];
        let warned = false;
        const speech = new TtsQueue({
            tts: this.tts,
            language: item.language,
            signal: controller.signal,
            onStart: (step) => this.#send({ type: "audio_start", step, sampleRate: this.tts.sampleRate, turn }),
            onChunk: (step, pcm) => this.#sendBinary(encodeAudioFrame(turn, step, pcm)),
            onEnd: (step, ok) => this.#send({ type: "audio_end", step, ok, turn }),
            onError: (step, error) => {
                const code = error.code in voice.warnings ? error.code : "tts_failed";
                this.logger.warn(`[turn ${label}] speech of shared sentence ${step} failed (${code}): ${error.message}`);
                if (!warned) {
                    warned = true;
                    this.#send({ type: "warning", code, message: format(voice.warnings[code], { voice: this.tts.label ?? voice.voice }), turn });
                }
            },
        });
        item.sentences.forEach((text, index) => speech.push(index + 1, text));
        await speech.drain();
        if (this.current === current) {
            this.current = null;
        }
        if (!controller.signal.aborted) {
            this.logger.info(`[turn ${label}] said explanation ${entry} of share ${id} again: ${item.sentences.length} sentence(s)`);
            this.#send({ type: "spoken", turn });
        }
    }

    // --- Questions ----------------------------------------------------------

    /**
     * The kept answers this question may use, or null when its answer depends
     * on more than its words: the conversation so far (a follow-up; going
     * deeper carries what it needs in its own question), documents, Odoo AI.
     */
    #answersFor({ language, level, odoo, dive }) {
        const leansOnMore = (odoo && this.odooAi) || this.sources.items.length > 0 || (!dive && this.history.turns.length > 0);
        if (!this.answers || leansOnMore) {
            return null;
        }
        const keyOf = (question) => this.answers.keyFor({ question, language, level });
        return {
            lookup: (question) => this.answers.get(keyOf(question)),
            save: (question, answer) => this.answers.put(keyOf(question), answer),
        };
    }

    /**
     * @param {object} [options]
     * @param {boolean} [options.odoo] whether the page asked to check with Odoo AI first
     * @param {string} [options.level] one of LEVELS
     * @param {{node: object, odooQuestion: string, root: object}|null} [options.dive] the node
     *        tapped to go deeper, and the first question of its chain
     */
    #startTurn(turn, language, input, { odoo = false, level = "normal", dive = null } = {}) {
        // The user asked something new: whatever was going on is stale.
        this.#cancelCurrent("replaced by a new question");
        // Asked right before anything is paid: a kept answer does not count.
        const admit = () => {
            const quota = this.limiter.tryAcquire();
            if (quota.ok) {
                return true;
            }
            const minutes = Math.ceil(quota.retryInSeconds / 60);
            this.#error(turn, language, "rate_limited", { max: this.config.maxQuestionsPerHour, minutes });
            this.logger.warn(`[turn ${this.connectionId}.${turn}] refused: MAX_QUESTIONS_PER_HOUR reached`);
            return false;
        };

        const emit = (event) => this.#send({ ...event, turn });
        const emitAudio = (step, pcm) => this.#sendBinary(encodeAudioFrame(turn, step, pcm));
        const controller = new AbortController();
        const current = { id: turn, controller };
        this.current = current;
        const label = `${this.connectionId}.${turn}`;
        runTurn({
            id: turn,
            label,
            input,
            language,
            level,
            llm: this.llm,
            stt: this.stt,
            tts: this.tts,
            history: this.history,
            sources: this.sources.blocks(),
            odooAi: odoo ? this.odooAi : null,
            odooHistory: this.odooHistory,
            focus: dive && { node: dive.node, odooQuestion: dive.odooQuestion },
            seal: this.sealer && ((answer) => this.sealer.seal(answer)),
            cache: this.#answersFor({ language, level, odoo, dive }),
            admit,
            emit,
            emitAudio,
            signal: controller.signal,
            logger: this.logger,
        }).then((result) => {
            // Kept for going deeper; a deeper diagram keeps the first question of its chain.
            if (result.status === "done" && result.diagram) {
                const root = dive?.root ?? { question: result.question, title: result.diagram.title };
                this.diagrams.remember(turn, { diagram: result.diagram, root });
            }
        }).catch((error) => {
            this.logger.error(`[turn ${label}] crashed`, error);
            emit({ type: "error", code: "internal", message: MESSAGES[language].errors.internal });
        }).finally(() => {
            if (this.current === current) {
                this.current = null;
            }
        });
    }
}
