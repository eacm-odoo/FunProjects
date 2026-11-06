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
 */

import { decodeAudioFrame } from "./audio/audio_frame.js";

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
     */
    constructor({ connection, panel, status, diagram, audioNarrator, timedNarrator }) {
        this.connection = connection;
        this.panel = panel;
        this.status = status;
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

    /** Asks a typed question. */
    ask(question) {
        this.#begin(question);
        if (!this.connection.send({ type: "ask_text", turn: this.turnId, text: question })) {
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
        const sent = this.connection.send({ type: "ask_audio", turn: this.turnId, mime: clip.mime })
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
        this.panel.showError(this.turnId, "No hay conexión con el servidor. Reintentando…");
        this.status.set("offline");
    }

    #resetTurnState() {
        this.active = false;
        this.currentStep = 0;
        /** @type {Map<number, {nodes: object[], edges: object[]}>} */
        this.pendingSteps = new Map();
        this.doneEvent = null;
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
                    this.panel.setQuestion(this.turnId, event.text || "(no se entendió nada)");
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
                this.panel.addSentence(this.turnId, event.step, event.text);
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
                this.narrator.stop();
                this.panel.showError(this.turnId, event.message);
                this.status.set("ready");
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
        this.panel.finishTurn(this.turnId, { hasDiagram: Boolean(this.doneEvent?.diagram) });
        this.status.set("ready");
    }
}
