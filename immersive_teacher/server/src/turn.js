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
 */

import { DiagramBuilder, LIMITS, cleanText } from "./protocol/diagram.js";
import { LineParser } from "./protocol/line_parser.js";
import { REFUSAL_SENTENCE, SYSTEM_PROMPT } from "./llm/system_prompt.js";
import { TtsQueue } from "./speech/tts_queue.js";
import { TurnTimer, describeUsage } from "./timing.js";

/** Hard cap on spoken sentences: past it the stream is cut to stop paying for tokens. */
export const MAX_SENTENCES = 8;

/** Errors that end the turn, as the browser shows them. */
export const ERROR_MESSAGES = Object.freeze({
    llm_auth: "La llave de Claude no es válida. Revisa ANTHROPIC_API_KEY en el servidor.",
    llm_rate_limited: "Claude está recibiendo demasiadas peticiones. Espera un momento y vuelve a preguntar.",
    llm_bad_request: "Claude rechazó la petición. Revisa CLAUDE_MODEL y el log del servidor.",
    llm_unavailable: "Claude no está disponible ahora mismo. Intenta de nuevo en un rato.",
    llm_network: "El servidor no logra conectarse con Claude. Revisa su conexión a internet.",
    llm_failed: "Algo falló al pedir la respuesta. El detalle está en el log del servidor.",
    stt_auth: "Deepgram rechazó la llave. Revisa DEEPGRAM_API_KEY en el servidor.",
    stt_payment_required: "Deepgram pide un pago: se acabó el crédito de la cuenta. Escribe la pregunta mientras tanto.",
    stt_rate_limited: "Deepgram está recibiendo demasiadas peticiones. Espera un momento y vuelve a preguntar.",
    stt_bad_request: "Deepgram rechazó la petición. El detalle está en el log del servidor: puede ser la grabación, DEEPGRAM_MODEL o TEACHER_LANGUAGE.",
    stt_unavailable: "Deepgram no está disponible ahora mismo. Escribe la pregunta mientras tanto.",
    stt_network: "El servidor no logra conectarse con Deepgram. Revisa su conexión a internet.",
    stt_timeout: "Deepgram tardó demasiado en transcribir. Prueba otra vez o escribe la pregunta.",
    empty_transcript: "No te escuché. Mantén presionado mientras hablas y suelta al terminar.",
    empty_answer: "No llegó ninguna explicación. Prueba a preguntarlo de otra forma.",
    internal: "Algo falló en el servidor. El detalle está en su log.",
});

/**
 * Speech failures do not end the turn: the text goes on and this note explains
 * the silence. `{voice}` is the speech provider (ElevenLabs, Deepgram).
 */
export const WARNING_MESSAGES = Object.freeze({
    tts_auth: "{voice} rechazó la llave o la voz: sigo en texto. Revisa la llave y la voz en el .env del servidor.",
    tts_payment_required: "{voice} pide un plan de pago para esta voz, o se acabó el crédito: sigo en texto. El detalle está en el log del servidor.",
    tts_rate_limited: "{voice} está limitando las peticiones o se acabó la cuota: sigo en texto.",
    tts_bad_request: "{voice} rechazó la frase: esa parte sigue en texto. El detalle está en el log del servidor.",
    tts_unavailable: "{voice} no está disponible ahora mismo: sigo en texto.",
    tts_network: "El servidor no logra conectarse con {voice}: sigo en texto.",
    tts_timeout: "{voice} tardó demasiado: esa parte sigue en texto.",
    tts_failed: "La voz falló: esa parte sigue en texto. El detalle está en el log del servidor.",
});

/** DRAW line for the history: only what was accepted, without the step. */
function historyDrawLine(result) {
    const data = {};
    if (result.nodes.length) {
        data.nodes = result.nodes.map(({ id, label, shape, color }) => ({ id, label, shape, color }));
    }
    if (result.edges.length) {
        data.edges = result.edges.map(({ from, to, label }) => (label ? { from, to, label } : { from, to }));
    }
    return `DRAW: ${JSON.stringify(data)}`;
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
 * @param {object} options.llm adapter from llm/index.js
 * @param {object} [options.stt] adapter from speech/stt/index.js (needed for audio input)
 * @param {object|null} [options.tts] adapter from speech/tts/index.js, null for text only
 * @param {import("./history.js").ConversationHistory} options.history
 * @param {(event: object) => void} options.emit sends one JSON event to the browser
 * @param {(step: number, pcm: Uint8Array) => void} [options.emitAudio] sends one PCM chunk
 * @param {AbortSignal} [options.signal] aborted when the user cancels
 * @param {Console} [options.logger]
 * @returns {Promise<{status: "done"|"cancelled"|"error", code?: string}>}
 */
export async function runTurn({
    id, label = String(id), input, llm, stt, tts = null, history, emit, emitAudio = () => {}, signal, logger = console,
}) {
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
        signal: turnAbort.signal,
        onStart: (step) => emit({ type: "audio_start", step, sampleRate: tts.sampleRate }),
        onChunk: (step, pcm) => {
            timer.mark("tts_first_chunk");
            emitAudio(step, pcm);
        },
        onEnd: (step, ok) => emit({ type: "audio_end", step, ok }),
        onError: (step, error) => {
            const code = error.code in WARNING_MESSAGES ? error.code : "tts_failed";
            logger.warn(`[turn ${label}] speech of sentence ${step} failed (${code}): ${error.message}`);
            if (!warned) {
                warned = true;
                emit({ type: "warning", code, message: WARNING_MESSAGES[code].replace("{voice}", tts.label ?? "La voz") });
            }
        },
    });

    let question = "";
    let title = "";
    let sentences = 0;
    let unmarkedLines = 0;
    let overLimit = false;
    let end = null;

    function say(text) {
        sentences += 1;
        timer.mark("first_sentence");
        emit({ type: "sentence", step: sentences, text });
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

    function fail(code, error) {
        turnAbort.abort();
        logger.error(`[turn ${label}] ${code}: ${error?.message ?? ""}`);
        if (code === "internal" && error) {
            logger.error(error);
        }
        emit({ type: "error", code, message: ERROR_MESSAGES[code] });
        return { status: "error", code };
    }

    function cancelled() {
        logger.info(`[turn ${label}] cancelled`);
        return { status: "cancelled" };
    }

    try {
        if ("audio" in input) {
            const { text } = await stt.transcribe(input.audio, { mime: input.mime, signal: turnAbort.signal });
            timer.mark("stt");
            question = text.trim();
            if (!question) {
                emit({ type: "transcript", text: "" });
                logger.warn(timer.line("nothing heard in the recording"));
                emit({ type: "error", code: "empty_transcript", message: ERROR_MESSAGES.empty_transcript });
                return { status: "error", code: "empty_transcript" };
            }
        } else {
            question = input.text;
        }
        emit({ type: "transcript", text: question });

        timer.mark("claude_request");
        const events = llm.stream({
            system: SYSTEM_PROMPT,
            messages: history.messagesFor(question),
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
        unlinkTurn();
        if (signal?.aborted) {
            return cancelled();
        }
        const known = error.code in ERROR_MESSAGES;
        return fail(known ? error.code : "internal", error);
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
        say(REFUSAL_SENTENCE);
    }
    if (!sentences) {
        unlinkTurn();
        emit({ type: "error", code: "empty_answer", message: ERROR_MESSAGES.empty_answer });
        logger.warn(timer.line(`no sentence | stop=${stopReason}`));
        return { status: "error", code: "empty_answer" };
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
    if (!result) {
        details.push("no diagram");
    }
    logger.info(timer.line(details.filter(Boolean).join(" | ")));
    return { status: "done" };
}
