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
 */

import { WebSocket } from "ws";

import { ConversationHistory } from "./history.js";
import { MESSAGES, format, isLanguage } from "./i18n.js";
import { MAX_TURN, encodeAudioFrame } from "./protocol/audio_frame.js";
import { SourceList, countSourceTokens, isSourceId, readSource } from "./sources/index.js";
import { runTurn } from "./turn.js";

const MAX_QUESTION_LENGTH = 500;
let connectionCount = 0;
/** About 60 s of opus; the browser already stops at MAX_RECORDING_SECONDS. */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const AUDIO_MIME_RE = /^audio\/[a-z0-9.+-]+(;\s*codecs=[a-z0-9.,"-]+)?$/i;

export class Session {
    /**
     * @param {object} options
     * @param {WebSocket} options.socket
     * @param {object} options.config result of loadConfig()
     * @param {object} options.llm
     * @param {object} options.stt
     * @param {object|null} options.tts null when TTS_PROVIDER=none
     * @param {import("./limits.js").HourlyLimiter} options.limiter
     * @param {Console} [options.logger]
     * @param {(address: string) => boolean} [options.isAllowedAddress] where URLs may point; tests open it to a local server
     */
    constructor({ socket, config, llm, stt, tts, limiter, logger = console, isAllowedAddress }) {
        this.socket = socket;
        this.config = config;
        this.llm = llm;
        this.stt = stt;
        this.tts = tts;
        this.limiter = limiter;
        this.logger = logger;
        // Turn numbers restart at 1 on every page load; the log shows "connection.turn".
        this.connectionId = ++connectionCount;
        this.history = new ConversationHistory(config.historyTurns);
        /** @type {{id: number, controller: AbortController} | null} */
        this.current = null;
        /**
         * The announcement waiting for its binary message: a recording or a file.
         * @type {{kind: "audio", turn: number, mime: string, language: string}
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
        this.#startTurn(turn, language, { text: question });
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
        this.pendingBinary = { kind: "audio", turn, mime, language };
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
        this.#startTurn(pending.turn, pending.language, { audio, mime: pending.mime });
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

    // --- Questions ----------------------------------------------------------

    #startTurn(turn, language, input) {
        // The user asked something new: whatever was going on is stale.
        this.#cancelCurrent("replaced by a new question");
        const quota = this.limiter.tryAcquire();
        if (!quota.ok) {
            const minutes = Math.ceil(quota.retryInSeconds / 60);
            this.#error(turn, language, "rate_limited", { max: this.config.maxQuestionsPerHour, minutes });
            this.logger.warn(`[turn ${this.connectionId}.${turn}] refused: MAX_QUESTIONS_PER_HOUR reached`);
            return;
        }

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
            llm: this.llm,
            stt: this.stt,
            tts: this.tts,
            history: this.history,
            sources: this.sources.blocks(),
            emit,
            emitAudio,
            signal: controller.signal,
            logger: this.logger,
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
