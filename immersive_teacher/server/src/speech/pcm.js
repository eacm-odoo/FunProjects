/**
 * Keeps a byte stream of 16-bit PCM aligned on whole samples.
 *
 * Network chunks can end in the middle of a sample; the browser builds an
 * Int16Array from each chunk, so an odd length would shift every sample after
 * it. The odd byte is carried over to the next chunk.
 *
 * @param {AsyncIterable<Uint8Array>} chunks
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* alignPcm16(chunks) {
    let carry = null;
    for await (const chunk of chunks) {
        let bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        if (carry) {
            const joined = new Uint8Array(carry.length + bytes.length);
            joined.set(carry, 0);
            joined.set(bytes, carry.length);
            bytes = joined;
            carry = null;
        }
        if (bytes.length % 2) {
            carry = bytes.slice(bytes.length - 1);
            bytes = bytes.subarray(0, bytes.length - 1);
        }
        if (bytes.length) {
            yield bytes;
        }
    }
    // A trailing half sample is noise: drop it.
}
