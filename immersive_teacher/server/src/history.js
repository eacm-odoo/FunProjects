/**
 * The last few questions and answers, sent back to Claude for follow-ups.
 *
 * Only text is kept. Thinking blocks are left out on purpose: the window drops
 * old turns from the front, and newer models reject thinking blocks replayed
 * after the history before them changed.
 */

export class ConversationHistory {
    constructor(maxTurns) {
        this.maxTurns = maxTurns;
        this.turns = [];
    }

    add(question, answer) {
        if (!this.maxTurns) {
            return;
        }
        this.turns.push({ question, answer });
        if (this.turns.length > this.maxTurns) {
            this.turns.splice(0, this.turns.length - this.maxTurns);
        }
    }

    /** Messages for the next request, ending with the new question. */
    messagesFor(question) {
        const messages = [];
        for (const turn of this.turns) {
            messages.push({ role: "user", content: turn.question });
            messages.push({ role: "assistant", content: turn.answer });
        }
        messages.push({ role: "user", content: question });
        return messages;
    }
}
