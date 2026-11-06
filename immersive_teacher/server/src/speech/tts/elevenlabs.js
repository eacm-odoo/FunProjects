/**
 * ElevenLabs streaming text to speech, as raw 16-bit mono PCM.
 *
 * Each sentence is a separate request, so `previous_text` carries the
 * sentence before it: the voice keeps its intonation across the cut instead
 * of starting every sentence like the first one.
 */

import { fetchWithDeadline } from "../http.js";
import { alignPcm16 } from "../pcm.js";

const API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEADLINE_MS = 8000;

/** @param {{deadlineMs?: number}} [options] tests shorten the deadline */
export function createElevenLabsTts(ttsConfig, { deadlineMs = DEADLINE_MS } = {}) {
    return {
        name: "elevenlabs",
        label: "ElevenLabs",
        sampleRate: ttsConfig.sampleRate,

        /**
         * @param {string} text one sentence
         * @param {{previousText?: string, signal?: AbortSignal}} options
         * @returns {AsyncGenerator<Uint8Array>} PCM chunks, whole samples only
         */
        async *synthesize(text, { previousText, signal } = {}) {
            const url = new URL(`${API_URL}/${encodeURIComponent(ttsConfig.voiceId)}/stream`);
            url.searchParams.set("output_format", `pcm_${ttsConfig.sampleRate}`);
            const body = {
                text,
                model_id: ttsConfig.model,
                language_code: ttsConfig.language,
            };
            if (previousText) {
                body.previous_text = previousText;
            }
            const { response, release } = await fetchWithDeadline("tts", url, {
                method: "POST",
                headers: {
                    "xi-api-key": ttsConfig.apiKey,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            }, { signal, deadlineMs });
            try {
                yield* alignPcm16(response.body);
            } finally {
                release();
            }
        },
    };
}
