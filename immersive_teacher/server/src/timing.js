/**
 * Per-turn stopwatch. Every mark is measured from the start of the turn, so
 * the console line reads as a timeline:
 *
 *     [turn 7] claude_ttft=+612ms first_sentence=+1034ms done=+3410ms | tokens in=1650 out=410 cache_read=1520 | stop=end_turn
 */

export class TurnTimer {
    constructor(turnId, now = () => performance.now()) {
        this.turnId = turnId;
        this.now = now;
        this.start = now();
        /** @type {Map<string, number>} */
        this.marks = new Map();
    }

    /** Records the first time a stage is reached; later calls are ignored. */
    mark(name) {
        if (!this.marks.has(name)) {
            this.marks.set(name, Math.round(this.now() - this.start));
        }
    }

    toJSON() {
        return Object.fromEntries(this.marks);
    }

    line(details = "") {
        const stages = [...this.marks].map(([name, ms]) => `${name}=+${ms}ms`).join(" ");
        return `[turn ${this.turnId}] ${stages}${details ? ` | ${details}` : ""}`;
    }
}

export function describeUsage(usage) {
    if (!usage) {
        return "";
    }
    const parts = [`in=${usage.input_tokens ?? 0}`, `out=${usage.output_tokens ?? 0}`];
    if (usage.cache_read_input_tokens) {
        parts.push(`cache_read=${usage.cache_read_input_tokens}`);
    }
    if (usage.cache_creation_input_tokens) {
        parts.push(`cache_write=${usage.cache_creation_input_tokens}`);
    }
    return `tokens ${parts.join(" ")}`;
}
