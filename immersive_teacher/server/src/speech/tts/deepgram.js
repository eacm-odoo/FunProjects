/**
 * Deepgram Aura-2 text to speech, as raw 16-bit mono PCM.
 *
 * Same account and key as the transcription, so one Deepgram account (and its
 * free credit) covers both ears and voice. The voice is the model name, one
 * per language: aura-2-estrella-es, aura-2-thalia-en. Aura has no equivalent
 * of ElevenLabs' previous_text, so each sentence is read on its own.
 * TTS_SPEED goes as the `speed` query parameter (see speed.js).
 */

import { fetchWithDeadline } from "../http.js";
import { alignPcm16 } from "../pcm.js";
import { speedFor, withSpeed } from "./speed.js";

const API_URL = "https://api.deepgram.com/v1/speak";
const DEADLINE_MS = 8000;

/** @param {{deadlineMs?: number}} [options] tests shorten the deadline */
export function createDeepgramTts(ttsConfig, { deadlineMs = DEADLINE_MS } = {}) {
    const speed = speedFor("deepgram", ttsConfig.speed ?? 1);
    const speedState = { refused: false };
    return {
        name: "deepgram",
        label: "Deepgram",
        sampleRate: ttsConfig.sampleRate,

        /**
         * @param {string} text one sentence (Aura takes up to 2,000 characters)
         * @param {{language: string, signal?: AbortSignal}} options
         * @returns {AsyncGenerator<Uint8Array>} PCM chunks, whole samples only
         */
        async *synthesize(text, { language, signal } = {}) {
            const url = new URL(API_URL);
            url.searchParams.set("model", ttsConfig.voices[language] ?? ttsConfig.voices.es);
            url.searchParams.set("encoding", "linear16");
            url.searchParams.set("sample_rate", String(ttsConfig.sampleRate));
            // Raw samples, no WAV header in front of them.
            url.searchParams.set("container", "none");
            const { response, release } = await withSpeed(speedState, "Deepgram", speed, (sent) => {
                const target = new URL(url);
                if (sent !== null) {
                    target.searchParams.set("speed", String(sent));
                }
                return fetchWithDeadline("tts", target, {
                    method: "POST",
                    headers: {
                        Authorization: `Token ${ttsConfig.apiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ text }),
                }, { signal, deadlineMs });
            });
            try {
                yield* alignPcm16(response.body);
            } finally {
                release();
            }
        },
    };
}
