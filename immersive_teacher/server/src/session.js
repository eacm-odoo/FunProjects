/**
 * One browser connection: its history and the turn in progress.
 *
 * A question arrives either as `ask_text`, or as `ask_audio` followed by one
 * binary message with the whole recording. A new question cancels the one in
 * progress (the user interrupted), and every event sent back carries the turn
 * number so the browser can drop stale ones. Speech goes back as binary
 * frames (see protocol/audio_frame.js).
 */

import { WebSocket } from "ws";

import { ConversationHistory } from "./history.js";
import { MAX_TURN, encodeAudioFrame } from "./protocol/audio_frame.js";
import { ERROR_MESSAGES, runTurn } from "./turn.js";

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
     */
    constructor({ socket, config, llm, stt, tts, limiter, logger = console }) {
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
        /** @type {{turn: number, mime: string} | null} ask_audio waiting for its recording */
        this.pendingAudio = null;

        socket.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
        socket.on("close", () => this.#cancelCurrent("connection closed"));
        this.#send({
            type: "hello",
            llm: { provider: llm.name, model: llm.model },
            stt: { provider: stt.name, maxSeconds: config.stt.maxSeconds },
            tts: tts ? { enabled: true, provider: tts.name, sampleRate: tts.sampleRate } : { enabled: false },
            maxQuestionsPerHour: config.maxQuestionsPerHour,
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
            this.#onRecording(data);
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

    #error(turn, code, message = ERROR_MESSAGES[code]) {
        this.#send({ type: "error", code, message, turn });
    }

    #askText({ turn, text }) {
        if (!this.#validTurn(turn)) {
            return;
        }
        this.pendingAudio = null;
        const question = typeof text === "string" ? text.trim() : "";
        if (!question || question.length > MAX_QUESTION_LENGTH) {
            this.#error(turn, "bad_request", `La pregunta debe tener entre 1 y ${MAX_QUESTION_LENGTH} caracteres.`);
            return;
        }
        this.#startTurn(turn, { text: question });
    }

    #announceAudio({ turn, mime }) {
        if (!this.#validTurn(turn)) {
            return;
        }
        if (typeof mime !== "string" || !AUDIO_MIME_RE.test(mime)) {
            this.#error(turn, "bad_audio", "El navegador mandó un audio en un formato que no reconozco.");
            return;
        }
        this.pendingAudio = { turn, mime };
    }

    #onRecording(data) {
        const pending = this.pendingAudio;
        this.pendingAudio = null;
        if (!pending) {
            this.logger.warn("recording without ask_audio before it, ignored");
            return;
        }
        const audio = Buffer.isBuffer(data) ? data : Buffer.concat(data);
        if (!audio.length) {
            this.#error(pending.turn, "empty_transcript");
            return;
        }
        if (audio.length > MAX_AUDIO_BYTES) {
            this.#error(pending.turn, "audio_too_long", "La grabación es demasiado larga. Haz la pregunta más corta.");
            return;
        }
        this.logger.info(`[turn ${this.connectionId}.${pending.turn}] recording received: ${(audio.length / 1024).toFixed(1)} KB ${pending.mime}`);
        this.#startTurn(pending.turn, { audio, mime: pending.mime });
    }

    #startTurn(turn, input) {
        // The user asked something new: whatever was going on is stale.
        this.#cancelCurrent("replaced by a new question");
        const quota = this.limiter.tryAcquire();
        if (!quota.ok) {
            const minutes = Math.ceil(quota.retryInSeconds / 60);
            this.#error(
                turn,
                "rate_limited",
                `Llegaste al límite de ${this.config.maxQuestionsPerHour} preguntas por hora. `
                    + `Podrás preguntar de nuevo en ${minutes} min.`,
            );
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
            llm: this.llm,
            stt: this.stt,
            tts: this.tts,
            history: this.history,
            emit,
            emitAudio,
            signal: controller.signal,
            logger: this.logger,
        }).catch((error) => {
            this.logger.error(`[turn ${label}] crashed`, error);
            emit({ type: "error", code: "internal", message: ERROR_MESSAGES.internal });
        }).finally(() => {
            if (this.current === current) {
                this.current = null;
            }
        });
    }
}
