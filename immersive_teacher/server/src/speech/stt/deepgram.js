/**
 * Deepgram pre-recorded transcription.
 *
 * The browser's recording (webm/opus from MediaRecorder) is sent as is: no
 * transcoding on the server. Nova-3 takes the language of each question:
 * `language=es` or `language=en` (or the region TEACHER_LANGUAGE names).
 */

import { fetchWithDeadline } from "../http.js";

const LISTEN_URL = "https://api.deepgram.com/v1/listen";
const DEADLINE_MS = 8000;

/** @param {{deadlineMs?: number}} [options] tests shorten the deadline */
export function createDeepgramStt(sttConfig, { deadlineMs = DEADLINE_MS } = {}) {
    return {
        name: "deepgram",

        /**
         * @param {Uint8Array} audio the whole recording
         * @param {{mime: string, language: string, signal?: AbortSignal}} options
         * @returns {Promise<{text: string}>}
         */
        async transcribe(audio, { mime, language, signal }) {
            const url = new URL(LISTEN_URL);
            url.searchParams.set("model", sttConfig.model);
            url.searchParams.set("language", sttConfig.languages[language] ?? language);
            url.searchParams.set("smart_format", "true");
            url.searchParams.set("punctuate", "true");
            const { response, release } = await fetchWithDeadline("stt", url, {
                method: "POST",
                headers: {
                    Authorization: `Token ${sttConfig.apiKey}`,
                    // "audio/webm;codecs=opus" -> "audio/webm": the container is what matters.
                    "Content-Type": mime.split(";")[0].trim(),
                },
                body: audio,
            }, { signal, deadlineMs });
            try {
                const data = await response.json();
                const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
                return { text: text.trim() };
            } finally {
                release();
            }
        },
    };
}
