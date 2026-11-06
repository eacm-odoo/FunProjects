/**
 * Binary WebSocket frame that carries one chunk of speech to the browser:
 *
 *     offset 0  uint32 LE  turn
 *     offset 4  uint16 LE  step (sentence number)
 *     offset 6  uint16 LE  reserved, 0
 *     offset 8  int16 LE   PCM samples, mono
 *
 * The header is 8 bytes so the samples start on an even offset and the
 * browser can view them as an Int16Array without copying.
 */

export const AUDIO_HEADER_BYTES = 8;
export const MAX_TURN = 0xFFFFFFFF;

/**
 * @param {number} turn
 * @param {number} step
 * @param {Uint8Array} pcm whole 16-bit samples
 * @returns {Buffer}
 */
export function encodeAudioFrame(turn, step, pcm) {
    const frame = Buffer.allocUnsafe(AUDIO_HEADER_BYTES + pcm.length);
    frame.writeUInt32LE(turn, 0);
    frame.writeUInt16LE(step, 4);
    frame.writeUInt16LE(0, 6);
    frame.set(pcm, AUDIO_HEADER_BYTES);
    return frame;
}
