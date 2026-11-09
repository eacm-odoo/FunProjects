/**
 * Side panel of the desktop view: the question box, the talk button, the
 * status, the language switch and the conversation, with the sentence being
 * spoken highlighted. Switching language relabels the panel; the conversation
 * already on screen stays as it was said.
 */

import { language, t } from "../i18n.js";

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

export class DesktopPanel {
    /**
     * @param {HTMLElement} root
     * @param {{onAsk: (question: string) => void, onLanguage: (language: string) => void}} handlers
     */
    constructor(root, { onAsk, onLanguage }) {
        this.statusEl = root.querySelector("#status");
        this.state = this.statusEl.dataset.state;
        this.recording = false;
        this.languageButtons = [...root.querySelectorAll("#language-switch [data-language]")];
        for (const button of this.languageButtons) {
            button.addEventListener("click", () => onLanguage(button.dataset.language));
        }
        this.conversationEl = root.querySelector("#conversation");
        this.formEl = root.querySelector("#ask-form");
        this.inputEl = root.querySelector("#question");
        this.buttonEl = this.formEl.querySelector('button[type="submit"]');
        this.infoEl = root.querySelector("#model-info");
        this.talkEl = root.querySelector("#talk");
        this.talkLabelEl = this.talkEl.querySelector(".talk-label");
        this.hintEl = root.querySelector("#talk-hint");
        this.defaultHint = t("talk.hint");
        this.hintTimer = null;
        /** @type {Map<number, {block: HTMLElement, questionEl: HTMLElement, title: HTMLElement, list: HTMLElement, sentences: Map<number, HTMLElement>}>} */
        this.turns = new Map();

        this.formEl.addEventListener("submit", (event) => {
            event.preventDefault();
            const question = this.inputEl.value.trim();
            if (question) {
                this.inputEl.value = "";
                onAsk(question);
            }
        });
    }

    setStatus(state) {
        this.state = state;
        this.statusEl.dataset.state = state;
        this.statusEl.textContent = t(`status.${state}`);
    }

    /** Relabels what the panel writes itself, after the language changed. */
    applyLanguage() {
        for (const button of this.languageButtons) {
            button.setAttribute("aria-pressed", String(button.dataset.language === language()));
        }
        this.setStatus(this.state);
        this.setRecording(this.recording);
        this.defaultHint = t("talk.hint");
        if (!this.hintEl.classList.contains("flash")) {
            this.hintEl.textContent = this.defaultHint;
        }
    }

    setAskEnabled(enabled) {
        this.buttonEl.disabled = !enabled;
    }

    setInfo(text) {
        this.infoEl.textContent = text;
    }

    /** The talk button: off while disconnected or when the browser cannot record. */
    setTalkEnabled(enabled, reason = "") {
        this.talkEl.disabled = !enabled;
        this.talkEl.title = reason;
    }

    setRecording(recording) {
        this.recording = recording;
        this.talkEl.classList.toggle("recording", recording);
        this.talkEl.setAttribute("aria-pressed", String(recording));
        this.talkLabelEl.textContent = t(recording ? "talk.release" : "talk.hold");
    }

    /** Shows `text` under the question box for a few seconds. */
    flashHint(text, seconds = 4) {
        clearTimeout(this.hintTimer);
        this.hintEl.textContent = text;
        this.hintEl.classList.add("flash");
        this.hintTimer = setTimeout(() => {
            this.hintEl.textContent = this.defaultHint;
            this.hintEl.classList.remove("flash");
        }, seconds * 1000);
    }

    /** @param {string|null} question null for a recording not transcribed yet */
    startTurn(turnId, question) {
        const block = element("section", "turn");
        const questionEl = question === null
            ? element("p", "question transcribing", t("turn.transcribing"))
            : element("p", "question", question);
        block.append(questionEl);
        const answer = element("div", "answer");
        const title = element("h2", "answer-title");
        const list = element("ol", "sentences");
        answer.append(title, list);
        block.append(answer);
        this.conversationEl.append(block);
        this.turns.set(turnId, { block, questionEl, title, list, sentences: new Map() });
        this.#scrollToEnd();
    }

    setQuestion(turnId, text) {
        const turn = this.turns.get(turnId);
        if (turn) {
            turn.questionEl.textContent = text;
            turn.questionEl.classList.remove("transcribing");
        }
    }

    setTitle(turnId, text) {
        const turn = this.turns.get(turnId);
        if (turn) {
            turn.title.textContent = text;
        }
    }

    /** @param {string} [kind] "apology" when the teacher excuses itself after a failure */
    addSentence(turnId, step, text, kind) {
        const turn = this.turns.get(turnId);
        if (!turn) {
            return;
        }
        const item = element("li", kind === "apology" ? "sentence apology pending" : "sentence pending", text);
        turn.sentences.set(step, item);
        turn.list.append(item);
        this.#scrollToEnd();
    }

    /** Marks `step` as the sentence being said and the earlier ones as said. */
    highlightStep(turnId, step) {
        const turn = this.turns.get(turnId);
        if (!turn) {
            return;
        }
        for (const [index, item] of turn.sentences) {
            item.classList.toggle("pending", index > step);
            item.classList.toggle("current", index === step);
        }
    }

    finishTurn(turnId, { hasDiagram }) {
        const turn = this.turns.get(turnId);
        if (!turn) {
            return;
        }
        for (const item of turn.sentences.values()) {
            item.classList.remove("pending", "current");
        }
        if (!hasDiagram) {
            turn.block.append(element("p", "note", t("turn.noDiagram")));
        }
    }

    showNote(turnId, message) {
        const turn = this.turns.get(turnId);
        (turn ? turn.block : this.conversationEl).append(element("p", "note", message));
        this.#scrollToEnd();
    }

    showError(turnId, message) {
        const turn = this.turns.get(turnId);
        const note = element("p", "error", message);
        (turn ? turn.block : this.conversationEl).append(note);
        this.#scrollToEnd();
    }

    #scrollToEnd() {
        this.conversationEl.scrollTop = this.conversationEl.scrollHeight;
    }
}
