/**
 * Downloads one public URL for the teacher to read.
 *
 * Only http and https, only public addresses (see net_guard.js), at most
 * MAX_REDIRECTS redirects, each one checked again, and never more than
 * `maxBytes` once decompressed. A timeout bounds the whole download.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { pipeline } from "node:stream";
import zlib from "node:zlib";

import { BlockedAddressError, guardedLookup, isPublicAddress } from "./net_guard.js";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// A generic client name: nothing about the user goes to the site.
const USER_AGENT = "ImmersiveTeacher/0.1 (reads one page when asked)";

export class FetchError extends Error {
    /**
     * @param {string} code stable code, translated for the browser by i18n.js
     * @param {string} message detail for the server log
     * @param {object} [values] fills the translated message, such as {status}
     */
    constructor(code, message, values = {}) {
        super(message);
        this.code = code;
        this.values = values;
    }
}

/** The URL if it is http(s) without credentials; throws url_invalid otherwise. */
export function parsePublicUrl(raw) {
    let url;
    try {
        url = new URL(String(raw ?? "").trim());
    } catch {
        throw new FetchError("url_invalid", `not a URL: ${JSON.stringify(String(raw).slice(0, 200))}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new FetchError("url_invalid", `scheme ${url.protocol} refused`);
    }
    if (url.username || url.password) {
        throw new FetchError("url_invalid", "credentials in the URL refused");
    }
    url.hash = "";
    return url;
}

/** Host names skip the lookup when they already are an address: check those here. */
function checkLiteralHost(url, isAllowed) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && !isAllowed(host)) {
        throw new FetchError("url_blocked", `${host} is not a public address`);
    }
}

function get(url, { signal, isAllowed }) {
    return new Promise((resolve, reject) => {
        const client = url.protocol === "https:" ? https : http;
        const request = client.get(url, {
            headers: {
                "User-Agent": USER_AGENT,
                Accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
                "Accept-Encoding": "gzip, deflate, br",
            },
            lookup: guardedLookup(isAllowed),
            signal,
        }, resolve);
        request.on("error", reject);
    });
}

/** The body as a stream, decompressed when the server compressed it. */
function decoded(response) {
    const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
    const decoder = {
        gzip: zlib.createGunzip,
        "x-gzip": zlib.createGunzip,
        deflate: zlib.createInflate,
        br: zlib.createBrotliDecompress,
    }[encoding];
    if (!decoder) {
        return response;
    }
    const stream = decoder();
    pipeline(response, stream, () => {});
    return stream;
}

async function readBody(response, maxBytes) {
    const chunks = [];
    let size = 0;
    const body = decoded(response);
    for await (const chunk of body) {
        size += chunk.length;
        if (size > maxBytes) {
            response.destroy();
            body.destroy();
            throw new FetchError("url_too_large", `more than ${maxBytes} bytes`);
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/**
 * @param {string} raw the URL the user typed
 * @param {object} options
 * @param {number} options.maxBytes
 * @param {AbortSignal} [options.signal] the user removed the source, or left
 * @param {number} [options.timeoutMs]
 * @param {(address: string) => boolean} [options.isAllowed] tests reach a local server with it
 * @returns {Promise<{url: string, contentType: string, body: Buffer}>} url is the final one, after redirects
 */
export async function fetchUrl(raw, { maxBytes, signal, timeoutMs = TIMEOUT_MS, isAllowed = isPublicAddress }) {
    let url = parsePublicUrl(raw);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
        for (let redirects = 0; ; redirects += 1) {
            checkLiteralHost(url, isAllowed);
            const response = await get(url, { signal: combined, isAllowed });
            const status = response.statusCode ?? 0;
            if (REDIRECTS.has(status) && response.headers.location) {
                response.resume();
                if (redirects >= MAX_REDIRECTS) {
                    throw new FetchError("url_failed", `more than ${MAX_REDIRECTS} redirects`, { detail: "redirects" });
                }
                url = parsePublicUrl(new URL(response.headers.location, url).href);
                continue;
            }
            if (status < 200 || status >= 300) {
                response.resume();
                throw new FetchError("url_status", `HTTP ${status}`, { status });
            }
            const declared = Number(response.headers["content-length"]);
            if (declared > maxBytes) {
                response.destroy();
                throw new FetchError("url_too_large", `Content-Length ${declared}`);
            }
            const body = await readBody(response, maxBytes);
            return { url: url.href, contentType: String(response.headers["content-type"] ?? ""), body };
        }
    } catch (error) {
        if (error instanceof FetchError) {
            throw error;
        }
        if (signal?.aborted) {
            throw signal.reason ?? error;
        }
        if (timeout.aborted) {
            throw new FetchError("url_timeout", `no complete answer in ${timeoutMs} ms`);
        }
        if (error instanceof BlockedAddressError || error?.cause instanceof BlockedAddressError) {
            throw new FetchError("url_blocked", error.message);
        }
        if (error?.code === "ENOTFOUND" || error?.code === "EAI_AGAIN") {
            throw new FetchError("url_not_found", `${url.hostname}: ${error.code}`, { host: url.hostname });
        }
        throw new FetchError("url_failed", error?.message ?? String(error), { detail: error?.code ?? "error" });
    }
}
