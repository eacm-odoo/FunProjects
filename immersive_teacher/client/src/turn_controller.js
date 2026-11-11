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
 *
 * With Odoo AI on (see odoo_mode.js), each question asks the server to check
 * with Odoo's support assistant first; Odoo AI's answer shows under the
 * explanation.
 *
 * A finished diagram can be explored (see exploration.js): explore() goes
 * deeper into one of its nodes, which stays on screen while the rest leaves,
 * and goBack() shows the diagram one level up again without asking anything.
 * Once the teacher is quiet, the questions the answer left open light up on
 * their nodes and show in the panel.
 *
 * Nothing is asked twice: a node already explored shows the diagram it gave,
 * without a word, and replay() says an explanation again from the sentences
 * and the speech received the first time.
 */

import { decodeAudioFrame } from "./audio/audio_frame.js";
import { Exploration } from "./exploration.js";
import { language, t } from "./i18n.js";
import { level } from "./level.js";
import { odooActive } from "./odoo_mode.js";

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
     * @param {(available: boolean) => void} [options.onReplayable] whether the diagram on screen can be explained again
     */
    constructor({
        connection, panel, status, diagram, audioNarrator, timedNarrator, onTrouble = () => {}, onReplayable = () => {},
    }) {
        this.connection = connection;
        this.panel = panel;
        this.status = status;
        this.onTrouble = onTrouble;
        this.onReplayable = onReplayable;
        this.replayableShown = false;
        this.replayableTurn = null;
        /** The turn being explained again, null otherwise. */
        this.replaying = null;
        this.diagram = diagram;
        this.audioNarrator = audioNarrator;
        this.timedNarrator = timedNarrator;
        for (const narrator of [audioNarrator, timedNarrator]) {
            narrator.onStepStart = (step) => this.#onStepStart(narrator, step);
            narrator.onIdle = () => this.#onIdle(narrator);
        }
        this.narrator = timedNarrator;
        this.speechEnabled = false;
        this.exploration = new Exploration();
        this.turnId = 0;
        this.#resetTurnState();

        const types = [
            "transcript", "title", "sentence", "citation", "diagram_step", "odoo_answer", "audio_start", "audio_end", "warning", "done", "error",
        ];
        for (const type of types) {
            connection.on(type, (event) => {
                if (event.turn === this.turnId) {
                    this.#handle(event);
                }
            });
        }
        connection.onBinary((buffer) => {
            const frame = decodeAudioFrame(buffer);
            if (frame.turn !== this.turnId) {
                return;
            }
            // Kept for replay(), whoever narrates now.
            this.exploration.speechChunk(frame.turn, frame.step, frame.samples);
            if (this.narrator === this.audioNarrator) {
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

    /** Stops the current answer (or the one said again) right away: the user started talking over it. */
    interrupt() {
        if (this.active) {
            this.connection.send({ type: "cancel", turn: this.turnId });
        }
        this.active = false;
        this.audioNarrator.stop();
        this.timedNarrator.stop();
        if (this.replaying !== null) {
            this.panel.finishTurn(this.replaying, { hasDiagram: true });
            this.replaying = null;
        }
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
        if (!this.connection.send({ type: "ask_text", turn: this.turnId, text: question, ...this.#askOptions() })) {
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
        const sent = this.connection.send({ type: "ask_audio", turn: this.turnId, mime: clip.mime, ...this.#askOptions() })
            && this.connection.sendBinary(audio);
        if (!sent) {
            this.#offline();
        }
    }

    /**
     * Goes deeper into node `nodeId` of the diagram of turn `fromTurnId`.
     * @returns {boolean} false when that diagram or that node is no longer kept
     */
    explore(fromTurnId, nodeId) {
        const node = this.exploration.node(fromTurnId, nodeId);
        if (!node) {
            return false;
        }
        // Explored before: the same diagram again, without asking or talking.
        const child = this.exploration.childOf(fromTurnId, nodeId);
        if (child) {
            return this.showTurn(child.turnId);
        }
        if (this.exploration.shown !== fromTurnId) {
            this.#showDiagram(fromTurnId);
        }
        this.#askNode(fromTurnId, node);
        return true;
    }

    /** Asks about `node` of the diagram of `fromTurnId`; the diagram on screen must hold that node. */
    #askNode(fromTurnId, node) {
        const nodeId = node.id;
        const path = [...this.exploration.pathTo(fromTurnId), { turnId: fromTurnId, title: this.exploration.entry(fromTurnId).diagram.title }];
        this.#begin(node.hook ?? t("explore.question", { label: node.label }), performance.now(), {
            from: fromTurnId,
            node: nodeId,
            path,
        });
        this.panel.setPath(this.turnId, path, (turnId) => this.showTurn(turnId));
        this.panel.markExplored(fromTurnId, nodeId);
        const sent = this.connection.send({
            type: "ask_node", turn: this.turnId, from: fromTurnId, node: nodeId,
            ...this.exploration.copyOf(fromTurnId), ...this.#askOptions(),
        });
        if (!sent) {
            this.#offline();
        }
    }

    /** Goes deeper into a node of the diagram on screen. */
    exploreShown(nodeId) {
        return this.explore(this.exploration.shown, nodeId);
    }

    /** Shows the diagram one level up from the one on screen; nothing is asked. */
    goBack() {
        const parent = this.exploration.parentOf(this.exploration.shown);
        return parent ? this.showTurn(parent.turnId) : false;
    }

    /** Puts the finished diagram of `turnId` back on screen, stopping the answer in progress. */
    showTurn(turnId) {
        if (!this.exploration.entry(turnId)?.diagram) {
            return false;
        }
        this.#stopCurrent();
        this.#showDiagram(turnId);
        this.panel.revealTurn(turnId);
        return true;
    }

    /**
     * Says the explanation of `turnId` again, sentence by sentence, from what
     * was received the first time: nothing is asked, nothing is paid. Its
     * diagram comes back on screen if another one was there.
     *
     * When the level changed since it was asked (too basic, too expert), the
     * same question is asked again at the level chosen now instead: a new
     * answer, which counts and costs like any question.
     * @returns {boolean} false when that explanation is not kept whole
     */
    replay(turnId) {
        const entry = this.exploration.entry(turnId);
        if (entry?.complete && entry.diagram && entry.level !== level()) {
            return this.#explainAgain(entry);
        }
        if (!this.exploration.replayable(turnId)) {
            return false;
        }
        this.#stopCurrent();
        // Even idle, a narrator waits for the step after the last one it played: start over.
        this.audioNarrator.stop();
        this.timedNarrator.stop();
        if (this.exploration.shown !== turnId) {
            this.#showDiagram(turnId);
        }
        const { sentences, speech } = this.exploration.entry(turnId);
        const withVoice = this.speechEnabled && this.audioNarrator.unlocked && speech.size > 0;
        this.narrator = withVoice ? this.audioNarrator : this.timedNarrator;
        this.replaying = turnId;
        this.panel.replayTurn(turnId, sentences, this.exploration.entry(turnId).citations);
        for (const step of [...sentences.keys()].sort((a, b) => a - b)) {
            this.narrator.enqueue(step, sentences.get(step));
            if (withVoice) {
                const voice = speech.get(step);
                if (voice) {
                    this.narrator.audioStart(step, voice.sampleRate);
                    for (const samples of voice.chunks) {
                        this.narrator.audioChunk(step, samples);
                    }
                }
                // A sentence without speech keeps its time in silence.
                this.narrator.audioEnd(step);
            }
        }
        this.narrator.finish();
        return true;
    }

    /** The question of `entry` asked again, at the level chosen now. */
    #explainAgain(entry) {
        const node = entry.parentTurnId === null ? null : this.exploration.node(entry.parentTurnId, entry.focusId);
        if (node) {
            // Its diagram already holds that node: it stays, and the new answer builds up around it.
            if (this.exploration.shown !== entry.turnId) {
                this.#showDiagram(entry.turnId);
            }
            this.#askNode(entry.parentTurnId, node);
            return true;
        }
        // A first question, or a deeper one whose diagram above is gone: the question as it was asked.
        const question = entry.asked || entry.root?.question;
        if (!question) {
            return false;
        }
        this.ask(question);
        return true;
    }

    /** The level the answer on screen was asked at, null before the first one. */
    shownLevel() {
        return this.exploration.entry(this.exploration.shown)?.level ?? null;
    }

    /** Says the explanation of the diagram on screen again. */
    replayShown() {
        return this.replay(this.exploration.shown);
    }

    /** Stops whatever is being said or received, before showing or saying something else. */
    #stopCurrent() {
        if (!this.busy) {
            return;
        }
        const wasAnswer = this.replaying === null;
        this.interrupt();
        if (wasAnswer) {
            this.panel.finishTurn(this.turnId, { hasDiagram: true });
        }
        // Whatever the stopped turn still sends is stale from now on.
        this.turnId += 1;
        this.#resetTurnState();
        this.status.set("ready");
    }

    #showDiagram(turnId) {
        this.#keepArrangement();
        const entry = this.exploration.entry(turnId);
        this.exploration.shown = turnId;
        this.diagram.show(entry.diagram, {
            path: this.exploration.pathTo(turnId),
            hooks: this.exploration.hooksOf(turnId).map((hook) => hook.id),
            explored: entry.explored,
            pins: entry.pins,
        });
        this.#refreshReplayable();
    }

    /** Before another diagram takes the screen: where the user left the nodes of this one. */
    #keepArrangement() {
        const entry = this.exploration.entry(this.exploration.shown);
        if (entry?.complete) {
            entry.pins = this.diagram.pins();
        }
    }

    /**
     * Tells onReplayable when the diagram on screen starts or stops being one
     * that can be said again, or another one takes the screen (it may have
     * been asked at another level).
     */
    #refreshReplayable() {
        const shown = this.exploration.shown;
        const available = this.exploration.replayable(shown);
        if (available !== this.replayableShown || shown !== this.replayableTurn) {
            this.replayableShown = available;
            this.replayableTurn = shown;
            this.onReplayable(available);
        }
    }

    /** What every question carries besides itself. */
    #askOptions() {
        const options = { language: language() };
        if (odooActive()) {
            options.odoo = true;
        }
        // "normal" is left out: the question goes exactly as without levels.
        if (level() !== "normal") {
            options.level = level();
        }
        return options;
    }

    /**
     * @param {string|null} question null for a recording not transcribed yet
     * @param {number} [startedAt]
     * @param {{from: number, node: string, path: object[]}|null} [dive] the node it goes deeper into,
     *        and the diagrams above the new one
     */
    #begin(question, startedAt = performance.now(), dive = null) {
        this.interrupt();
        this.#keepArrangement();
        if (dive) {
            this.diagram.focus(dive.node, dive.path);
        } else {
            this.diagram.clear();
        }
        this.turnId += 1;
        this.#resetTurnState();
        this.exploration.begin(this.turnId, dive && { from: dive.from, node: dive.node }, { level: level(), question });
        this.#refreshReplayable();
        this.active = true;
        this.startedAt = startedAt;
        this.fromVoice = question === null;
        // Speech plays only once a click or key has unlocked audio in this page.
        this.narrator = this.speechEnabled && this.audioNarrator.unlocked ? this.audioNarrator : this.timedNarrator;
        this.panel.startTurn(this.turnId, question, { dive: Boolean(dive), level: level() });
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
                this.exploration.setQuestion(this.turnId, event.text);
                if (this.fromVoice) {
                    this.panel.setQuestion(this.turnId, event.text || t("turn.nothingHeard"));
                    console.info(`[turn ${this.turnId}] release->transcript=${this.#elapsed()}ms`);
                }
                break;
            case "citation": {
                const citation = { source: event.source, pages: event.pages ?? null, quote: event.quote ?? "" };
                this.exploration.addCitation(this.turnId, event.step, citation);
                this.panel.addCitation(this.turnId, event.step, citation);
                break;
            }
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
                this.exploration.addSentence(this.turnId, event.step, event.text);
                this.panel.addSentence(this.turnId, event.step, event.text, event.kind);
                this.narrator.enqueue(event.step, event.text);
                break;
            case "diagram_step":
                this.#queueStep(event);
                break;
            case "odoo_answer":
                this.panel.addOdooAnswer(this.turnId, event.text, event.links ?? []);
                break;
            case "audio_start":
                this.exploration.speechStart(this.turnId, event.step, event.sampleRate);
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
                this.exploration.finish(this.turnId, event.diagram);
                // Its nodes can be explored from now on, even while the teacher still talks.
                this.diagram.interactive = Boolean(event.diagram);
                if (this.exploration.replayable(this.turnId)) {
                    const turnId = this.turnId;
                    this.panel.setReplay(turnId, () => this.replay(turnId), this.exploration.entry(turnId).level);
                }
                this.#refreshReplayable();
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
        if (this.replaying !== null) {
            // The diagram is already whole: only the sentence moves on, and the teacher points at its part.
            this.status.set("explaining");
            this.panel.highlightStep(this.replaying, step);
            this.diagram.pointAtStep(step);
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
        if (this.replaying !== null) {
            this.panel.finishTurn(this.replaying, { hasDiagram: true });
            this.replaying = null;
            this.status.set("ready");
            return;
        }
        // Steps drawn after the last sentence still belong to the diagram.
        this.#revealThrough(Infinity);
        // A failed answer gets its error, not a note about the missing diagram.
        this.panel.finishTurn(this.turnId, { hasDiagram: this.failed || Boolean(this.doneEvent?.diagram) });
        // The teacher has asked its question: now its node lights up.
        const hooks = this.failed ? [] : this.exploration.hooksOf(this.turnId);
        if (hooks.length) {
            const turnId = this.turnId;
            this.diagram.setMarks({ hooks: hooks.map((hook) => hook.id) });
            this.panel.setHooks(turnId, hooks, (nodeId) => this.explore(turnId, nodeId));
        }
        if (this.pendingError) {
            this.panel.showError(this.turnId, this.pendingError);
            this.pendingError = null;
        }
        this.status.set("ready");
    }
}
