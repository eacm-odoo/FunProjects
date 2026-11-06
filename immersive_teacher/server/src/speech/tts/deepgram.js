/**
 * Deepgram Aura-2 text to speech, as raw 16-bit mono PCM.
 *
 * Same account and key as the transcription, so one Deepgram account (and its
 * free credit) covers both ears and voice. The voice is the model name, for
 * example aura-2-estrella-es. Aura has no equivalent of ElevenLabs'
 * previous_text, so each sentence is read on its own.
 */

import { fetchWithDeadline } from "../http.js";
import { alignPcm16 } from "../pcm.js";

const API_URL = "https://api.deepgram.com/v1/speak";
const DEADLINE_MS = 8000;

/** @param {{deadlineMs?: number}} [options] tests shorten the deadline */
export function createDeepgramTts(ttsConfig, { deadlineMs = DEADLINE_MS } = {}) {
    return {
        name: "deepgram",
        label: "Deepgram",
        sampleRate: ttsConfig.sampleRate,

        /**
         * @param {string} text one sentence (Aura takes up to 2,000 characters)
         * @param {{signal?: AbortSignal}} options
         * @returns {AsyncGenerator<Uint8Array>} PCM chunks, whole samples only
         */
        async *synthesize(text, { signal } = {}) {
            const url = new URL(API_URL);
            url.searchParams.set("model", ttsConfig.model);
            url.searchParams.set("encoding", "linear16");
            url.searchParams.set("sample_rate", String(ttsConfig.sampleRate));
            // Raw samples, no WAV header in front of them.
            url.searchParams.set("container", "none");
            const { response, release } = await fetchWithDeadline("tts", url, {
                method: "POST",
                headers: {
                    Authorization: `Token ${ttsConfig.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ text }),
            }, { signal, deadlineMs });
            try {
                yield* alignPcm16(response.body);
            } finally {
                release();
            }
        },
    };
}
