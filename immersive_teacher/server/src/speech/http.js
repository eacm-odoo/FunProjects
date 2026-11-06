/**
 * fetch() for the speech providers, with the errors a voice turn cares about.
 *
 * The deadline covers the time to the response headers only: a long sentence
 * may stream for several seconds, and that is fine, but a provider that does
 * not answer at all must not leave the teacher silent forever.
 */

export class SpeechError extends Error {
    /**
     * @param {string} code e.g. "stt_auth", "tts_timeout"
     * @param {string} message detail for the server log
     */
    constructor(code, message, { cause } = {}) {
        super(message, { cause });
        this.code = code;
    }
}

function codeForStatus(service, status) {
    if (status === 401 || status === 403) {
        return `${service}_auth`;
    }
    if (status === 402) {
        return `${service}_payment_required`; // out of credit, or the plan does not cover it
    }
    if (status === 429) {
        return `${service}_rate_limited`;
    }
    if (status >= 500) {
        return `${service}_unavailable`;
    }
    return `${service}_bad_request`;
}

/**
 * @param {"stt"|"tts"} service prefix of the error codes
 * @param {string|URL} url
 * @param {RequestInit} init fetch options, without `signal`
 * @param {{signal?: AbortSignal, deadlineMs: number}} options
 * @returns {Promise<{response: Response, release: () => void}>} call `release()`
 *   once the body has been read, to stop listening to `signal`
 */
export async function fetchWithDeadline(service, url, init, { signal, deadlineMs }) {
    if (signal?.aborted) {
        throw signal.reason ?? new Error("aborted");
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const release = () => signal?.removeEventListener("abort", forwardAbort);
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, deadlineMs);

    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (!response.ok) {
            const detail = (await response.text().catch(() => "")).slice(0, 300);
            throw new SpeechError(codeForStatus(service, response.status), `HTTP ${response.status}: ${detail}`);
        }
        return { response, release };
    } catch (error) {
        release();
        if (error instanceof SpeechError || signal?.aborted) {
            throw error;
        }
        if (timedOut) {
            throw new SpeechError(`${service}_timeout`, `no answer within ${deadlineMs} ms`);
        }
        throw new SpeechError(`${service}_network`, error.message, { cause: error });
    } finally {
        clearTimeout(timer);
    }
}
