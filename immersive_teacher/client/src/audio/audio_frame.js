/**
 * Reads the binary speech frames sent by the server
 * (server/src/protocol/audio_frame.js):
 *
 *     uint32 LE turn | uint16 LE step | uint16 reserved | int16 LE PCM...
 */

export const AUDIO_HEADER_BYTES = 8;

/**
 * @param {ArrayBuffer} buffer
 * @returns {{turn: number, step: number, samples: Int16Array}}
 */
export function decodeAudioFrame(buffer) {
    const view = new DataView(buffer);
    const sampleCount = (buffer.byteLength - AUDIO_HEADER_BYTES) >> 1;
    return {
        turn: view.getUint32(0, true),
        step: view.getUint16(4, true),
        // The header is 8 bytes, so the samples start aligned; no copy needed.
        samples: new Int16Array(buffer, AUDIO_HEADER_BYTES, Math.max(0, sampleCount)),
    };
}
