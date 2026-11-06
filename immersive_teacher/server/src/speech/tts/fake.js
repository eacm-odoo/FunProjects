/**
 * Fake text to speech: no key, no network, no cost.
 *
 * It "speaks" a hum with the rhythm of speech: a low voice-like tone whose
 * loudness rises and falls about four times a second, like syllables, and
 * pauses at commas. That is enough to hear the pacing, see the diagram follow
 * the audio and, in phase 3, watch the mouth move. A sentence lasts about as
 * long as reading it aloud (14 characters a second) and streams faster than
 * real time, like the real provider.
 */

import { sleep } from "../../sleep.js";

/**
 * @param {object} [options]
 * @param {number} [options.sampleRate]
 * @param {number} [options.firstChunkMs] delay before the first chunk
 * @param {number} [options.chunkMs] audio length of each chunk
 * @param {number} [options.speedup] how much faster than real time it streams (0 = no waits)
 * @param {number} [options.charsPerSecond]
 */
export function createFakeTts({
    sampleRate = 24000,
    firstChunkMs = 180,
    chunkMs = 100,
    speedup = 4,
    charsPerSecond = 14,
} = {}) {
    return {
        name: "fake",
        label: "La voz de prueba",
        sampleRate,

        async *synthesize(text, { signal } = {}) {
            await sleep(firstChunkMs, signal);
            const seconds = Math.max(0.8, text.length / charsPerSecond);
            const total = Math.round(seconds * sampleRate);
            const perChunk = Math.round((sampleRate * chunkMs) / 1000);
            // Where the commas fall, as a fraction of the sentence: short silences there.
            const pauses = [...text.matchAll(/[,;:]/g)].map((match) => match.index / text.length);
            let phase = 0;
            for (let start = 0; start < total; start += perChunk) {
                const count = Math.min(perChunk, total - start);
                const samples = new Int16Array(count);
                for (let i = 0; i < count; i += 1) {
                    const t = (start + i) / sampleRate;
                    const progress = (start + i) / total;
                    const pitch = 160 + 25 * Math.sin(2 * Math.PI * 0.7 * t);
                    phase += (2 * Math.PI * pitch) / sampleRate;
                    const tone = Math.sin(phase) + 0.5 * Math.sin(2 * phase)
                        + 0.25 * Math.sin(3 * phase) + 0.12 * Math.sin(4 * phase);
                    const syllables = (0.5 - 0.5 * Math.cos(2 * Math.PI * 4.2 * t)) ** 1.5;
                    const edges = Math.min(1, t / 0.03, (total - start - i) / sampleRate / 0.05);
                    const pause = pauses.some((at) => Math.abs(progress - at) * seconds < 0.12) ? 0 : 1;
                    samples[i] = Math.round(0.22 * 32767 * (tone / 1.87) * syllables * edges * pause);
                }
                yield new Uint8Array(samples.buffer);
                if (speedup) {
                    await sleep(chunkMs / speedup, signal);
                }
            }
        },
    };
}
