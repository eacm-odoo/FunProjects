/**
 * Text inside the headset, where the side panel cannot be seen: what to do
 * next, what the teacher heard, the sentence being said, and any warning.
 *
 * It takes the same calls as the desktop panel (startTurn, addSentence,
 * highlightStep, showError...), so the turn controller feeds both at once.
 * One line of text at a time, by priority: a warning or error for a few
 * seconds, else the sentence being said, else the current state, else a hint.
 * The hint and the states follow the page's language (relabel() after a switch).
 */

import * as THREE from "three";

import { createTextSprite, disposeSprite } from "../diagram/labels.js";
import { t } from "../i18n.js";

const FLASH_SECONDS = 6;

/** States that have their own line; the others show the hint. */
const STATES_WITH_TEXT = new Set(["connecting", "offline", "listening", "thinking"]);

export class XrCaptions {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = "captions";
        this.group.visible = false;
        this.sprite = null;
        this.text = "";
        /** "placing" or "teaching", the interaction mode the hint explains */
        this.hintMode = "placing";
        this.state = "ready";
        this.question = "";
        this.sentence = "";
        this.flashText = "";
        this.flashLeft = 0;
        /** @type {Map<number, string>} step -> sentence, for the current turn */
        this.sentences = new Map();
        this.turnId = null;
    }

    /** @param {"placing"|"teaching"} mode */
    setHint(mode) {
        this.hintMode = mode;
        this.#refresh();
    }

    /** Redraws the line in the new language. */
    relabel() {
        this.#refresh();
    }

    // --- The desktop panel's interface (what the captions need of it) -----

    setStatus(state) {
        this.state = state;
        if (state === "ready") {
            this.sentence = "";
        }
        this.#refresh();
    }

    startTurn(turnId) {
        this.turnId = turnId;
        this.sentences.clear();
        this.sentence = "";
        this.question = "";
        this.#refresh();
    }

    /** An earlier answer is said again: its sentences, by step, become the ones shown. */
    replayTurn(turnId, sentences) {
        this.turnId = turnId;
        this.sentences = new Map(sentences);
        this.sentence = "";
        this.question = "";
        this.#refresh();
    }

    setQuestion(turnId, text) {
        if (turnId === this.turnId) {
            this.question = text;
            this.#refresh();
        }
    }

    addSentence(turnId, step, text) {
        if (turnId === this.turnId) {
            this.sentences.set(step, text);
        }
    }

    highlightStep(turnId, step) {
        if (turnId === this.turnId && this.sentences.has(step)) {
            this.sentence = this.sentences.get(step);
            this.#refresh();
        }
    }

    finishTurn(turnId) {
        if (turnId === this.turnId) {
            this.sentence = "";
            this.#refresh();
        }
    }

    showNote(turnId, message) {
        this.flash(message);
    }

    showError(turnId, message) {
        this.flash(message);
    }

    flashHint(message) {
        this.flash(message, 4);
    }

    // ---------------------------------------------------------------------

    /** Shows `message` over everything else for a few seconds. */
    flash(message, seconds = FLASH_SECONDS) {
        this.flashText = message;
        this.flashLeft = seconds;
        this.#refresh();
    }

    update(dt) {
        if (this.flashLeft > 0) {
            this.flashLeft -= dt;
            if (this.flashLeft <= 0) {
                this.flashText = "";
                this.#refresh();
            }
        }
    }

    /** The line shown right now (also handy for tests and the console). */
    currentText() {
        if (this.flashText) {
            return this.flashText;
        }
        if (this.sentence) {
            return this.sentence;
        }
        if (this.state === "thinking" && this.question) {
            return t("captions.thinkingAbout", { question: this.question });
        }
        return STATES_WITH_TEXT.has(this.state) ? t(`captions.${this.state}`) : t(`hint.${this.hintMode}`);
    }

    #refresh() {
        const text = this.currentText();
        if (text === this.text) {
            return;
        }
        this.text = text;
        if (this.sprite) {
            this.group.remove(this.sprite);
            disposeSprite(this.sprite);
            this.sprite = null;
        }
        if (!text || typeof document === "undefined") {
            return; // no canvas in Node tests: the text logic still runs
        }
        this.sprite = createTextSprite(text, {
            lineHeight: 0.04,
            maxChars: 36,
            maxLines: 3,
            weight: 500,
            anchor: [0.5, 1],
            onTop: true,
        });
        this.sprite.renderOrder = 5;
        this.group.add(this.sprite);
    }
}
