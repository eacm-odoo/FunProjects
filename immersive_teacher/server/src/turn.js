/**
 * One question, from the recording (or the typed text) to the last sound.
 *
 *     [audio -> stt] -> transcript -> title -> sentence(1) -> diagram_step(1) -> ... -> done
 *                                                  \-> speech queue -> audio_start(1), PCM frames, audio_end(1)
 *
 * Claude's answer is read line by line: each sentence goes to the browser and
 * to the speech queue as soon as its line is complete, so the teacher starts
 * talking long before Claude finishes. The step of a DRAW line is the number
 * of the last SAY line before it, so Claude never has to count. A bad DRAW
 * line only loses its own elements, and a failed sentence of speech only
 * falls back to text for that sentence.
 *
 * When the turn fails (transcription, Claude, nothing to say), the sentences
 * already on their way still finish, then the teacher says a short apology
 * like any other sentence, and only then comes the error with its details.
 *
 * Each question carries its language (see i18n.js): it picks the system
 * prompt, the transcription language, the voice and the messages.
 *
 * The user's sources (documents and pages, see sources/index.js) go at the
 * start of the first message of every request, so they are the same prefix
 * each time and stay in Claude's cache.
 */

import { LANGUAGES, MESSAGES, format } from "./i18n.js";
import { DiagramBuilder, LIMITS, cleanText } from "./protocol/diagram.js";
import { LineParser } from "./protocol/line_parser.js";
import { SYSTEM_PROMPTS } from "./llm/system_prompt.js";
import { TtsQueue } from "./speech/tts_queue.js";
import { TurnTimer, describeUsage } from "./timing.js";

/** Hard cap on spoken sentences: past it the stream is cut to stop paying for tokens. */
export const MAX_SENTENCES = 8;

/** The apology for a failure: what went wrong, said as the teacher would. */
export function apologyFor(code, language = LANGUAGES[0]) {
    const { apologies } = MESSAGES[language];
    if (code === "empty_transcript" || code.startsWith("stt_")) {
        return apologies.heard;
    }
    return code === "empty_answer" ? apologies.explain : apologies.think;
}

/** DRAW line for the history: only what was accepted, without the step. */
function historyDrawLine(result) {
    const data = {};
    if (result.nodes.length) {
        data.nodes = result.nodes.map(({ id, label, icon, shape, color }) => (
            icon ? { id, label, icon, shape, color } : { id, label, shape, color }
        ));
    }
    if (result.edges.length) {
        data.edges = result.edges.map(({ from, to, label }) => (label ? { from, to, label } : { from, to }));
    }
    return `DRAW: ${JSON.stringify(data)}`;
}

/**
 * Puts the document blocks before the first question of `messages`. The
 * history trims old turns from the front, but the documents stay first.
 */
export function withSources(messages, sources) {
    if (!sources?.length) {
        return messages;
    }
    const [first, ...rest] = messages;
    return [{ role: "user", content: [...sources, { type: "text", text: first.content }] }, ...rest];
}

/** Aborts `controller` when `signal` aborts; returns the function that stops listening. */
function linkAbort(signal, controller) {
    if (!signal) {
        return () => {};
    }
    const forward = () => controller.abort(signal.reason);
    if (signal.aborted) {
        forward();
        return () => {};
    }
    signal.addEventListener("abort", forward, { once: true });
    return () => signal.removeEventListener("abort", forward);
}

/**
 * @param {object} options
 * @param {number} options.id turn number chosen by the browser
 * @param {string} [options.label] how the turn appears in the log (default: the id)
 * @param {{text: string} | {audio: Uint8Array, mime: string}} options.input
 * @param {string} [options.language] one of LANGUAGES (default: the first)
 * @param {object} options.llm adapter from llm/index.js
 * @param {object} [options.stt] adapter from speech/stt/index.js (needed for audio input)
 * @param {object|null} [options.tts] adapter from speech/tts/index.js, null for text only
 * @param {import("./history.js").ConversationHistory} options.history
 * @param {object[]} [options.sources] document blocks from SourceList.blocks()
 * @param {(event: object) => void} options.emit sends one JSON event to the browser
 * @param {(step: number, pcm: Uint8Array) => void} [options.emitAudio] sends one PCM chunk
 * @param {AbortSignal} [options.signal] aborted when the user cancels
 * @param {Console} [options.logger]
 * @returns {Promise<{status: "done"|"cancelled"|"error", code?: string}>}
 */
export async function runTurn({
    id, label = String(id), input, language = LANGUAGES[0], llm, stt, tts = null, history, sources = [], emit,
    emitAudio = () => {}, signal, logger = console,
}) {
    const messages = MESSAGES[language];
    const timer = new TurnTimer(label);
    const parser = new LineParser();
    const diagram = new DiagramBuilder();
    const historyLines = [];
    // Everything of this turn (Claude, speech) stops when the user cancels or on error.
    const turnAbort = new AbortController();
    const unlinkTurn = linkAbort(signal, turnAbort);
    // Claude alone can also be cut when the answer runs past MAX_SENTENCES.
    const llmAbort = new AbortController();
    const unlinkLlm = linkAbort(turnAbort.signal, llmAbort);

    let warned = false;
    const speech = tts && new TtsQueue({
        tts,
        language,
        signal: turnAbort.signal,
        onStart: (step) => emit({ type: "audio_start", step, sampleRate: tts.sampleRate }),
        onChunk: (step, pcm) => {
            timer.mark("tts_first_chunk");
            emitAudio(step, pcm);
        },
        onEnd: (step, ok) => emit({ type: "audio_end", step, ok }),
        onError: (step, error) => {
            const code = error.code in messages.warnings ? error.code : "tts_failed";
            logger.warn(`[turn ${label}] speech of sentence ${step} failed (${code}): ${error.message}`);
            if (!warned) {
                warned = true;
                emit({ type: "warning", code, message: format(messages.warnings[code], { voice: tts.label ?? messages.voice }) });
            }
        },
    });

    let question = "";
    let title = "";
    let sentences = 0;
    let unmarkedLines = 0;
    let overLimit = false;
    let end = null;

    function say(text, kind) {
        sentences += 1;
        timer.mark("first_sentence");
        emit(kind ? { type: "sentence", step: sentences, text, kind } : { type: "sentence", step: sentences, text });
        speech?.push(sentences, text);
    }

    function handle(item) {
        if (!item.marked) {
            unmarkedLines += 1;
        }
        if (item.kind === "title") {
            if (!title) {
                title = cleanText(item.text, LIMITS.title);
                emit({ type: "title", text: title });
                historyLines.push(`TITLE: ${title}`);
            }
            return;
        }
        if (item.kind === "say") {
            if (sentences >= MAX_SENTENCES) {
                overLimit = true;
                return;
            }
            say(item.text);
            historyLines.push(`SAY: ${item.text}`);
            return;
        }
        if (item.kind === "draw" && !overLimit) {
            const step = Math.max(sentences, 1);
            const result = diagram.addStep(step, item.text);
            for (const issue of result.issues) {
                logger.warn(`[turn ${label}] diagram step ${step}: dropped ${issue}`);
            }
            if (result.nodes.length || result.edges.length) {
                emit({ type: "diagram_step", step, nodes: result.nodes, edges: result.edges });
                historyLines.push(historyDrawLine(result));
            }
        }
    }

    /**
     * Ends the turn on an error: Claude stops, the speech already on its way
     * finishes, the teacher apologizes, then the browser gets the details.
     */
    async function fail(code, error, { log = true } = {}) {
        llmAbort.abort();
        if (log) {
            logger.error(`[turn ${label}] ${code}: ${error?.message ?? ""}`);
        }
        if (code === "internal" && error) {
            logger.error(error);
        }
        let apologized = false;
        if (!signal?.aborted) {
            say(apologyFor(code, language), "apology");
            await speech?.drain();
            apologized = !signal?.aborted;
        }
        unlinkTurn();
        if (signal?.aborted) {
            return cancelled();
        }
        emit({ type: "error", code, message: messages.errors[code], apologized });
        return { status: "error", code };
    }

    function cancelled() {
        logger.info(`[turn ${label}] cancelled`);
        return { status: "cancelled" };
    }

    try {
        if ("audio" in input) {
            const { text } = await stt.transcribe(input.audio, { mime: input.mime, language, signal: turnAbort.signal });
            timer.mark("stt");
            question = text.trim();
            if (!question) {
                emit({ type: "transcript", text: "" });
                unlinkLlm();
                logger.warn(timer.line("nothing heard in the recording"));
                return await fail("empty_transcript", null, { log: false });
            }
        } else {
            question = input.text;
        }
        emit({ type: "transcript", text: question });

        timer.mark("claude_request");
        const events = llm.stream({
            system: SYSTEM_PROMPTS[language],
            messages: withSources(history.messagesFor(question), sources),
            language,
            signal: llmAbort.signal,
        });
        for await (const event of events) {
            if (event.type === "end") {
                end = event;
                continue;
            }
            timer.mark("claude_ttft");
            for (const item of parser.push(event.text)) {
                handle(item);
            }
            if (overLimit) {
                logger.warn(`[turn ${label}] more than ${MAX_SENTENCES} sentences, stream cut`);
                llmAbort.abort();
                break;
            }
        }
    } catch (error) {
        unlinkLlm();
        if (signal?.aborted) {
            unlinkTurn();
            return cancelled();
        }
        const known = error.code in messages.errors;
        return await fail(known ? error.code : "internal", error);
    }
    unlinkLlm();

    if (signal?.aborted) {
        unlinkTurn();
        return cancelled();
    }

    const stopReason = overLimit ? "sentence_limit" : (end?.stopReason ?? "unknown");
    if (stopReason === "max_tokens" || overLimit) {
        const tail = parser.discard();
        if (stopReason === "max_tokens") {
            logger.warn(`[turn ${label}] hit MAX_TOKENS_PER_ANSWER, dropped the cut line: ${JSON.stringify(tail)}`);
        }
    } else {
        for (const item of parser.end()) {
            handle(item);
        }
    }
    if (unmarkedLines) {
        logger.warn(`[turn ${label}] ${unmarkedLines} line(s) came without a marker and were read as speech or diagram`);
    }

    const refused = stopReason === "refusal";
    if (refused) {
        say(messages.refusal);
    }
    if (!sentences) {
        logger.warn(timer.line(`no sentence | stop=${stopReason}`));
        return await fail("empty_answer", null, { log: false });
    }

    // The answer is complete; wait for its last sound before calling it done.
    await speech?.drain();
    unlinkTurn();
    if (signal?.aborted) {
        return cancelled();
    }

    timer.mark("done");
    const result = diagram.toJSON(title);
    emit({ type: "done", diagram: result, stopReason, sentences, timings: timer.toJSON() });
    if (!refused) {
        history.add(question, historyLines.join("\n"));
    }
    const details = [describeUsage(end?.usage), `stop=${stopReason}`, `model=${end?.model ?? llm.model}`];
    if (sources.length) {
        details.push(`sources=${sources.length}`);
    }
    if (!result) {
        details.push("no diagram");
    }
    logger.info(timer.line(details.filter(Boolean).join(" | ")));
    return { status: "done" };
}
