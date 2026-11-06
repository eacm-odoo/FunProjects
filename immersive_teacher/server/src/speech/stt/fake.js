/**
 * Fake transcription: no key, no network. Whatever was recorded, it "hears"
 * the next question of a short rotation, so the fake LLM answers something
 * different each time (water cycle, photosynthesis, an answer with errors).
 */

import { sleep } from "../../sleep.js";

const QUESTIONS = [
    "¿Cómo funciona el ciclo del agua?",
    "¿Cómo hacen las plantas la fotosíntesis?",
    "Dame una respuesta con error",
];

/**
 * @param {{delayMs?: number, text?: string}} [options] `text` fixes the transcript (tests)
 */
export function createFakeStt({ delayMs = 250, text } = {}) {
    let next = 0;
    return {
        name: "fake",

        async transcribe(audio, { signal } = {}) {
            await sleep(delayMs, signal);
            if (!audio?.length) {
                return { text: "" };
            }
            const question = text ?? QUESTIONS[next % QUESTIONS.length];
            next += 1;
            return { text: question };
        },
    };
}
