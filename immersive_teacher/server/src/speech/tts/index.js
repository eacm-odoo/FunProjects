/**
 * Text to speech, behind one interface:
 *
 *     tts.sampleRate
 *     tts.synthesize(text, { previousText, language, signal }) -> AsyncIterable<Uint8Array>
 *
 * Every adapter streams 16-bit little-endian mono PCM at `sampleRate`, whole
 * samples per chunk. `TTS_PROVIDER=none` returns null: the browser then paces
 * the sentences with a timer, as in phase 1.
 */

import { createDeepgramTts } from "./deepgram.js";
import { createElevenLabsTts } from "./elevenlabs.js";
import { createFakeTts } from "./fake.js";

export function createTts(ttsConfig) {
    switch (ttsConfig.provider) {
        case "elevenlabs":
            return createElevenLabsTts(ttsConfig);
        case "deepgram":
            return createDeepgramTts(ttsConfig);
        case "fake":
            return createFakeTts({ sampleRate: ttsConfig.sampleRate });
        case "none":
            return null;
        default:
            throw new Error(`Unknown TTS provider "${ttsConfig.provider}"`);
    }
}
