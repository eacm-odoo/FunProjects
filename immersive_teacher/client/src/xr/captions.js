/**
 * Text inside the headset, where the side panel cannot be seen: what to do
 * next, what the teacher heard, the sentence being said, and any warning.
 *
 * It takes the same calls as the desktop panel (startTurn, addSentence,
 * highlightStep, showError...), so the turn controller feeds both at once.
 * One line of text at a time, by priority: a warning or error for a few
 * seconds, else the sentence being said, else the current state, else a hint.
 * Under the sentence being said, a smaller line names where its facts come
 * from, when the teacher took them from the user's documents.
 * The hint and the states follow the page's language (relabel() after a switch).
 */

import * as THREE from "three";

import { createTextSprite, disposeSprite } from "../diagram/labels.js";
import { citationPlace } from "../citation.js";
import { t } from "../i18n.js";

const FLASH_SECONDS = 6;
const SOURCE_GAP = 0.008;

/** States that have their own line; the others show the hint. */
const STATES_WITH_TEXT = new Set(["connecting", "offline", "listening", "thinking"]);

export class XrCaptions {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = "captions";
        this.group.visible = false;
        this.sprite = null;
        this.text = "";
        this.sourceSprite = null;
        this.sourceText = "";
        /** "placing" or "teaching", the interaction mode the hint explains */
        this.hintMode = "placing";
        this.state = "ready";
        this.question = "";
        this.sentence = "";
        this.flashText = "";
        this.flashLeft = 0;
        /** @type {Map<number, string>} step -> sentence, for the current turn */
        this.sentences = new Map();
        /** @type {Map<number, object[]>} step -> where its facts come from */
        this.citations = new Map();
        this.step = null;
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
        this.citations = new Map();
        this.step = null;
        this.sentence = "";
        this.question = "";
        this.#refresh();
    }

    /** An earlier answer is said again: its sentences, by step, become the ones shown. */
    replayTurn(turnId, sentences, citations = new Map()) {
        this.turnId = turnId;
        this.sentences = new Map(sentences);
        this.citations = new Map(citations);
        this.step = null;
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
            this.step = step;
            this.sentence = this.sentences.get(step);
            this.#refresh();
        }
    }

    addCitation(turnId, step, citation) {
        if (turnId === this.turnId) {
            this.citations.set(step, [...(this.citations.get(step) ?? []), citation]);
            if (step === this.step) {
                this.#refresh();
            }
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

    /** The smaller line under the sentence being said: where its facts come from, or "". */
    currentSource() {
        if (this.flashText || !this.sentence) {
            return "";
        }
        const places = [...new Set((this.citations.get(this.step) ?? []).map(citationPlace))];
        return places.length ? t("cite.caption", { where: places.join("; ") }) : "";
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
        const source = this.currentSource();
        if (text === this.text && source === this.sourceText) {
            return;
        }
        this.text = text;
        this.sourceText = source;
        if (this.sourceSprite) {
            this.group.remove(this.sourceSprite);
            disposeSprite(this.sourceSprite);
            this.sourceSprite = null;
        }
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
        if (source) {
            this.sourceSprite = createTextSprite(source, {
                lineHeight: 0.026,
                maxChars: 48,
                maxLines: 2,
                weight: 500,
                color: "#BFD7D9",
                anchor: [0.5, 1],
                onTop: true,
            });
            this.sourceSprite.position.y = -this.sprite.scale.y - SOURCE_GAP;
            this.sourceSprite.renderOrder = 5;
            this.group.add(this.sourceSprite);
        }
    }
}
