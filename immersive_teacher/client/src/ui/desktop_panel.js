/**
 * Side panel of the desktop view: the question box, the talk button, the
 * status and the conversation, with the sentence being spoken highlighted.
 */

const STATUS_TEXT = {
    connecting: "Conectando…",
    ready: "Listo",
    listening: "Escuchando…",
    thinking: "Pensando…",
    explaining: "Explicando",
    offline: "Sin conexión",
    error: "Error",
};

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
     * @param {{onAsk: (question: string) => void}} handlers
     */
    constructor(root, { onAsk }) {
        this.statusEl = root.querySelector("#status");
        this.conversationEl = root.querySelector("#conversation");
        this.formEl = root.querySelector("#ask-form");
        this.inputEl = root.querySelector("#question");
        this.buttonEl = this.formEl.querySelector('button[type="submit"]');
        this.infoEl = root.querySelector("#model-info");
        this.talkEl = root.querySelector("#talk");
        this.talkLabelEl = this.talkEl.querySelector(".talk-label");
        this.hintEl = root.querySelector("#talk-hint");
        this.defaultHint = this.hintEl.textContent;
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
        this.statusEl.dataset.state = state;
        this.statusEl.textContent = STATUS_TEXT[state] ?? state;
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
        this.talkEl.classList.toggle("recording", recording);
        this.talkEl.setAttribute("aria-pressed", String(recording));
        this.talkLabelEl.textContent = recording ? "Suelta para enviar" : "Mantén para hablar";
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
            ? element("p", "question transcribing", "Transcribiendo tu pregunta…")
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

    addSentence(turnId, step, text) {
        const turn = this.turns.get(turnId);
        if (!turn) {
            return;
        }
        const item = element("li", "sentence pending", text);
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
            turn.block.append(element("p", "note", "Esta respuesta llegó sin diagrama."));
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
