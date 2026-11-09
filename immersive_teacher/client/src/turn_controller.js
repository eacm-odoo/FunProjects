/**
 * Ties one question to its answer on screen and in the speakers.
 *
 * The server sends sentences, diagram steps and speech as soon as they exist;
 * this controller holds each diagram step back until the narrator starts the
 * sentence it belongs to, so the diagram grows in step with the voice. Events
 * from an older turn are ignored.
 *
 * Two narrators share one interface: AudioNarrator plays the server's speech,
 * TimedNarrator paces the text when there is no speech (TTS_PROVIDER=none, or
 * the page could not unlock audio because nobody has clicked anything yet).
 *
 * When a turn fails, the server first sends an apology as one more sentence
 * ("apologized" on the error): what was already said plays to the end, the
 * apology after it, and the written details show once the teacher is quiet.
 */

import { decodeAudioFrame } from "./audio/audio_frame.js";
import { language, t } from "./i18n.js";

function formatTimings(timings = {}) {
    return Object.entries(timings).map(([stage, ms]) => `${stage}=+${ms}ms`).join(" ");
}

export class TurnController {
    /**
     * @param {object} options
     * @param {import("./net/connection.js").Connection} options.connection
     * @param {import("./ui/desktop_panel.js").DesktopPanel} options.panel
     * @param {import("./status.js").Status} options.status
     * @param {import("./diagram/diagram_view.js").DiagramView} options.diagram
     * @param {import("./narration/audio_narrator.js").AudioNarrator} options.audioNarrator
     * @param {import("./narration/timed_narrator.js").TimedNarrator} options.timedNarrator
     * @param {() => void} [options.onTrouble] the teacher starts apologizing, or a turn failed silently
     */
    constructor({ connection, panel, status, diagram, audioNarrator, timedNarrator, onTrouble = () => {} }) {
        this.connection = connection;
        this.panel = panel;
        this.status = status;
        this.onTrouble = onTrouble;
        this.diagram = diagram;
        this.audioNarrator = audioNarrator;
        this.timedNarrator = timedNarrator;
        for (const narrator of [audioNarrator, timedNarrator]) {
            narrator.onStepStart = (step) => this.#onStepStart(narrator, step);
            narrator.onIdle = () => this.#onIdle(narrator);
        }
        this.narrator = timedNarrator;
        this.speechEnabled = false;
        this.turnId = 0;
        this.#resetTurnState();

        const types = ["transcript", "title", "sentence", "diagram_step", "audio_start", "audio_end", "warning", "done", "error"];
        for (const type of types) {
            connection.on(type, (event) => {
                if (event.turn === this.turnId) {
                    this.#handle(event);
                }
            });
        }
        connection.onBinary((buffer) => {
            const frame = decodeAudioFrame(buffer);
            if (frame.turn === this.turnId && this.narrator === this.audioNarrator) {
                this.narrator.audioChunk(frame.step, frame.samples);
            }
        });
    }

    /** Whether the server speaks (from its hello). */
    setSpeechEnabled(enabled) {
        this.speechEnabled = enabled;
    }

    /** True while an answer is being received or played. */
    get busy() {
        return this.active || this.narrator.busy;
    }

    /** Stops the current answer right away: the user started talking over it. */
    interrupt() {
        if (this.active) {
            this.connection.send({ type: "cancel", turn: this.turnId });
        }
        this.active = false;
        this.audioNarrator.stop();
        this.timedNarrator.stop();
    }

    /** The server went away mid-answer: what was not received yet will never come. */
    connectionLost() {
        if (!this.active) {
            return; // the answer was complete: what is buffered keeps playing
        }
        this.active = false;
        this.audioNarrator.stop();
        this.timedNarrator.stop();
        this.panel.showError(this.turnId, t("turn.connectionLost"));
        this.onTrouble();
    }

    /** Asks a typed question. */
    ask(question) {
        this.#begin(question);
        if (!this.connection.send({ type: "ask_text", turn: this.turnId, text: question, language: language() })) {
            this.#offline();
        }
    }

    /**
     * Asks a recorded question.
     * @param {{blob: Blob, mime: string, durationMs: number}} clip
     * @param {number} releasedAt performance.now() when the button was released
     */
    async askAudio(clip, releasedAt) {
        const audio = await clip.blob.arrayBuffer();
        this.#begin(null, releasedAt);
        console.info(`[turn ${this.turnId}] recording: ${(clip.durationMs / 1000).toFixed(1)} s, ${(audio.byteLength / 1024).toFixed(1)} KB ${clip.mime}`);
        const sent = this.connection.send({ type: "ask_audio", turn: this.turnId, mime: clip.mime, language: language() })
            && this.connection.sendBinary(audio);
        if (!sent) {
            this.#offline();
        }
    }

    #begin(question, startedAt = performance.now()) {
        this.interrupt();
        this.diagram.clear();
        this.turnId += 1;
        this.#resetTurnState();
        this.active = true;
        this.startedAt = startedAt;
        this.fromVoice = question === null;
        // Speech plays only once a click or key has unlocked audio in this page.
        this.narrator = this.speechEnabled && this.audioNarrator.unlocked ? this.audioNarrator : this.timedNarrator;
        this.panel.startTurn(this.turnId, question);
        this.status.set("thinking");
    }

    #offline() {
        this.active = false;
        this.panel.showError(this.turnId, t("turn.offline"));
        this.status.set("offline");
    }

    #resetTurnState() {
        this.active = false;
        this.currentStep = 0;
        /** @type {Map<number, {nodes: object[], edges: object[]}>} */
        this.pendingSteps = new Map();
        this.doneEvent = null;
        this.failed = false;
        this.pendingError = null;
        this.apologyStep = null;
        this.firstSentenceLogged = false;
        this.firstStepLogged = false;
    }

    #elapsed() {
        return Math.round(performance.now() - this.startedAt);
    }

    #handle(event) {
        switch (event.type) {
            case "transcript":
                if (this.fromVoice) {
                    this.panel.setQuestion(this.turnId, event.text || t("turn.nothingHeard"));
                    console.info(`[turn ${this.turnId}] release->transcript=${this.#elapsed()}ms`);
                }
                break;
            case "title":
                this.diagram.setTitle(event.text);
                this.panel.setTitle(this.turnId, event.text);
                break;
            case "sentence":
                if (!this.firstSentenceLogged) {
                    this.firstSentenceLogged = true;
                    console.info(`[turn ${this.turnId}] ${this.fromVoice ? "release" : "ask"}->first_sentence=${this.#elapsed()}ms`);
                }
                if (event.kind === "apology") {
                    this.apologyStep = event.step;
                }
                this.panel.addSentence(this.turnId, event.step, event.text, event.kind);
                this.narrator.enqueue(event.step, event.text);
                break;
            case "diagram_step":
                this.#queueStep(event);
                break;
            case "audio_start":
                if (this.narrator === this.audioNarrator) {
                    this.narrator.audioStart(event.step, event.sampleRate);
                }
                break;
            case "audio_end":
                if (this.narrator === this.audioNarrator) {
                    this.narrator.audioEnd(event.step);
                }
                break;
            case "warning":
                this.panel.showNote(this.turnId, event.message);
                break;
            case "done":
                this.doneEvent = event;
                this.active = false;
                console.info(`[turn ${this.turnId}] ${this.fromVoice ? "release" : "ask"}->done=${this.#elapsed()}ms | server ${formatTimings(event.timings)}`);
                this.narrator.finish();
                break;
            case "error":
                this.active = false;
                this.failed = true;
                if (event.apologized) {
                    // Let the answer so far and the apology play; details after.
                    this.pendingError = event.message;
                    this.narrator.finish();
                } else {
                    this.narrator.stop();
                    this.panel.showError(this.turnId, event.message);
                    this.status.set("ready");
                    this.onTrouble();
                }
                break;
            default:
                break;
        }
    }

    #queueStep({ step, nodes, edges }) {
        if (step <= this.currentStep) {
            // Its sentence is already playing: show it right away.
            this.diagram.reveal({ nodes, edges });
            return;
        }
        const pending = this.pendingSteps.get(step) ?? { nodes: [], edges: [] };
        pending.nodes.push(...nodes);
        pending.edges.push(...edges);
        this.pendingSteps.set(step, pending);
    }

    #revealThrough(step) {
        const ready = [...this.pendingSteps.keys()].filter((key) => key <= step).sort((a, b) => a - b);
        for (const key of ready) {
            this.diagram.reveal(this.pendingSteps.get(key));
            this.pendingSteps.delete(key);
        }
    }

    #onStepStart(narrator, step) {
        if (narrator !== this.narrator) {
            return;
        }
        if (!this.firstStepLogged && narrator === this.audioNarrator) {
            this.firstStepLogged = true;
            console.info(`[turn ${this.turnId}] ${this.fromVoice ? "release" : "ask"}->first_audio=${this.#elapsed()}ms`);
        }
        this.currentStep = step;
        if (step === this.apologyStep) {
            this.onTrouble();
        }
        this.status.set("explaining");
        this.panel.highlightStep(this.turnId, step);
        this.#revealThrough(step);
    }

    #onIdle(narrator) {
        if (narrator !== this.narrator) {
            return;
        }
        // Steps drawn after the last sentence still belong to the diagram.
        this.#revealThrough(Infinity);
        // A failed answer gets its error, not a note about the missing diagram.
        this.panel.finishTurn(this.turnId, { hasDiagram: this.failed || Boolean(this.doneEvent?.diagram) });
        if (this.pendingError) {
            this.panel.showError(this.turnId, this.pendingError);
            this.pendingError = null;
        }
        this.status.set("ready");
    }
}
