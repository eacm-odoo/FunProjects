/**
 * Side panel of the desktop view: the question box, the talk button, the
 * status, the language and level switches, the Odoo AI switch and the conversation, with
 * the sentence being spoken highlighted. Switching language relabels the
 * panel; the conversation already on screen stays as it was said.
 *
 * Under a finished answer, "Volver a explicar" says it again (or, when the
 * level changed since, "Explicar de nuevo: Niño" asks it again at the new
 * level); a question asked at a level other than normal carries its name; and the questions
 * it left open are buttons that go deeper into their node; a deeper answer
 * starts with a button back to the diagram it came from.
 */

import { citationPlace } from "../citation.js";
import { language, t } from "../i18n.js";
import { level } from "../level.js";

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

/** Odoo AI writes markdown; the panel shows it as plain text, without the emphasis marks. */
export function plainMarkdown(text) {
    return text
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/__(.+?)__/g, "$1")
        .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,;:!?]|$)/gm, "$1$2")
        .replace(/^[ \t]*[*-][ \t]+/gm, "- ")
        .replace(/^#{1,6}[ \t]+/gm, "");
}

/** Only links to web pages: anything else in Odoo AI's answer is dropped. */
function webUrl(raw) {
    try {
        const url = new URL(raw);
        return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}

export class DesktopPanel {
    /**
     * @param {HTMLElement} root
     * @param {{onAsk: (question: string) => void, onLanguage: (language: string) => void,
     *   onOdoo?: (on: boolean) => void, onLevel?: (level: string) => void}} handlers
     */
    constructor(root, { onAsk, onLanguage, onOdoo = () => {}, onLevel = () => {} }) {
        this.statusEl = root.querySelector("#status");
        this.state = this.statusEl.dataset.state;
        this.recording = false;
        this.languageButtons = [...root.querySelectorAll("#language-switch [data-language]")];
        for (const button of this.languageButtons) {
            button.addEventListener("click", () => onLanguage(button.dataset.language));
        }
        this.levelButtons = [...root.querySelectorAll("#level-switch [data-level]")];
        for (const button of this.levelButtons) {
            button.addEventListener("click", () => onLevel(button.dataset.level));
        }
        this.odooRow = root.querySelector("#odoo-row");
        this.odooInput = root.querySelector("#odoo-switch");
        this.odooInput.addEventListener("change", () => onOdoo(this.odooInput.checked));
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
        /**
         * @type {Map<number, {block: HTMLElement, questionEl: HTMLElement, answer: HTMLElement, title: HTMLElement,
         *   list: HTMLElement, sentences: Map<number, HTMLElement>}>}
         */
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
        for (const turn of this.turns.values()) {
            if (turn.replay) {
                this.#labelReplay(turn);
            }
            if (turn.levelTag) {
                turn.levelTag.textContent = t(`level.${turn.levelTag.dataset.level}`);
            }
        }
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

    /** The Odoo AI switch: shown when the server has it, checked when the user turned it on. */
    /** Marks the level the next question goes at; the "explain again" buttons follow it. */
    setLevel(current) {
        for (const button of this.levelButtons) {
            button.setAttribute("aria-pressed", String(button.dataset.level === current));
        }
        for (const turn of this.turns.values()) {
            if (turn.replay) {
                this.#labelReplay(turn);
            }
        }
    }

    setOdoo({ available, on }) {
        this.odooRow.hidden = !available;
        this.odooInput.checked = on;
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

    /**
     * @param {string|null} question null for a recording not transcribed yet
     * @param {{dive?: boolean}} [options] dive: the question goes deeper into a node
     */
    startTurn(turnId, question, { dive = false, level: asked = "normal" } = {}) {
        const block = element("section", "turn");
        const questionEl = question === null
            ? element("p", "question transcribing", t("turn.transcribing"))
            : element("p", dive ? "question dive" : "question", question);
        // The level the question went at, unless normal.
        const levelTag = asked === "normal" ? null : element("span", "level-tag", t(`level.${asked}`));
        if (levelTag) {
            levelTag.dataset.level = asked;
            questionEl.append(levelTag);
        }
        block.append(questionEl);
        const answer = element("div", "answer");
        const title = element("h2", "answer-title");
        const list = element("ol", "sentences");
        answer.append(title, list);
        block.append(answer);
        this.conversationEl.append(block);
        this.turns.set(turnId, { block, questionEl, levelTag, answer, title, list, sentences: new Map() });
        this.#scrollToEnd();
    }

    setQuestion(turnId, text) {
        const turn = this.turns.get(turnId);
        if (turn) {
            turn.questionEl.textContent = text;
            if (turn.levelTag) {
                turn.questionEl.append(turn.levelTag);
            }
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
        const item = element("li", kind ? `sentence ${kind} pending` : "sentence pending", text);
        turn.sentences.set(step, item);
        turn.list.append(item);
        this.#scrollToEnd();
    }

    /** Marks `step` as the sentence being said and the earlier ones as said. */
    /** Where a fact of sentence `step` comes from: the document and its page, the passage on hover. */
    addCitation(turnId, step, citation) {
        const item = this.turns.get(turnId)?.sentences.get(step);
        if (!item) {
            return;
        }
        const chip = element("span", "cite", citationPlace(citation));
        if (citation.quote) {
            chip.title = citation.quote;
        }
        item.append(chip);
    }

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

    /** Odoo AI's own answer, folded under the explanation, with the pages it used. */
    addOdooAnswer(turnId, text, links) {
        const turn = this.turns.get(turnId);
        if (!turn) {
            return;
        }
        const details = element("details", "odoo-answer");
        details.append(element("summary", "", t("odoo.answerTitle")), element("p", "odoo-answer-text", plainMarkdown(text)));
        const pages = links.map((link) => [link, webUrl(link.uri)]).filter(([, url]) => url);
        if (pages.length) {
            const list = element("ul", "odoo-answer-links");
            for (const [link, url] of pages) {
                const anchor = element("a", "", link.title || url);
                anchor.href = url;
                anchor.target = "_blank";
                anchor.rel = "noopener noreferrer";
                const item = element("li");
                item.append(anchor);
                list.append(item);
            }
            details.append(list);
        }
        turn.answer.append(details);
        this.#scrollToEnd();
    }

    /** The button back to the diagram a deeper answer came from, before its question. */
    /**
     * The diagrams above a deeper answer, at the start of its block: each one
     * is a button back to it ("‹ Photosynthesis › Glucose").
     * @param {{turnId: number, title: string}[]} path the top of the chain first
     * @param {(turnId: number) => void} onPick
     */
    setPath(turnId, path, onPick) {
        const turn = this.turns.get(turnId);
        if (!turn || !path.length) {
            return;
        }
        const nav = element("nav", "path");
        nav.setAttribute("aria-label", t("explore.path"));
        path.forEach((crumb, index) => {
            const button = element("button", "back-link", `${index === 0 ? "‹" : "›"} ${crumb.title}`);
            button.type = "button";
            button.addEventListener("click", () => onPick(crumb.turnId));
            nav.append(button);
        });
        turn.block.prepend(nav);
    }

    setHooks(turnId, hooks, onPick) {
        const turn = this.turns.get(turnId);
        if (!turn || turn.hooks) {
            return;
        }
        const box = element("div", "hooks");
        box.append(element("p", "hooks-hint", t("explore.hint")));
        turn.hookButtons = new Map();
        for (const hook of hooks) {
            const button = element("button", "hook", hook.hook);
            button.type = "button";
            button.title = hook.label;
            button.addEventListener("click", () => onPick(hook.id));
            turn.hookButtons.set(hook.id, button);
            box.append(button);
        }
        turn.hooks = box;
        turn.answer.append(box);
        this.#scrollToEnd();
    }

    /** A node of that answer was explored, from its button or from the diagram. */
    markExplored(turnId, nodeId) {
        this.turns.get(turnId)?.hookButtons?.get(nodeId)?.classList.add("explored");
    }

    /** Scrolls to the answer whose diagram came back on screen. */
    revealTurn(turnId) {
        this.turns.get(turnId)?.block.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    /**
     * The button that says this answer again, from what was received: nothing
     * is asked. At another level than `asked`, it asks again at that level.
     */
    setReplay(turnId, onReplay, asked = "normal") {
        const turn = this.turns.get(turnId);
        if (!turn || turn.replay) {
            return;
        }
        const button = element("button", "replay");
        button.type = "button";
        button.addEventListener("click", () => onReplay());
        turn.replay = button;
        turn.replayLevel = asked;
        this.#labelReplay(turn);
        turn.answer.append(button);
    }

    /** "Volver a explicar" at the level it was asked at, "Explicar de nuevo: Niño" at another one. */
    #labelReplay(turn) {
        const again = turn.replayLevel !== level();
        turn.replay.textContent = again ? t("explore.reexplain", { level: t(`level.${level()}`) }) : t("explore.replay");
        turn.replay.classList.toggle("again", again);
    }

    /** That answer is being said again: its sentences light up one by one, as the first time. */
    replayTurn(turnId) {
        this.revealTurn(turnId);
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
