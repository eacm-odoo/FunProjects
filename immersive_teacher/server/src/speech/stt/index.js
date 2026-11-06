/**
 * Speech to text, behind one interface:
 *
 *     stt.transcribe(audio: Uint8Array, { mime, signal }) -> Promise<{ text }>
 *
 * Adding a provider means one file here and one entry in the switch.
 */

import { createDeepgramStt } from "./deepgram.js";
import { createFakeStt } from "./fake.js";

export function createStt(sttConfig) {
    switch (sttConfig.provider) {
        case "deepgram":
            return createDeepgramStt(sttConfig);
        case "fake":
            return createFakeStt();
        default:
            throw new Error(`Unknown STT provider "${sttConfig.provider}"`);
    }
}
