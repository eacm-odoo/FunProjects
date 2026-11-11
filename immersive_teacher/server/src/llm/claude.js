/**
 * Claude adapter: streams the answer text through the official SDK.
 *
 * Every LLM adapter exposes the same shape:
 *
 *     llm.stream({ system, messages, language, signal })
 *         -> AsyncIterable<{ type: "text", text } | { type: "citation", citation }
 *                          | { type: "end", stopReason, usage, model }>
 *     llm.countTokens({ messages, signal }) -> Promise<number>
 *
 * Claude gets the language through the system prompt (one per language), so
 * this adapter ignores `language`; the fake one uses it to pick its answers.
 *
 * Thinking blocks and fallback markers are ignored: only text deltas matter to
 * the line parser. A citation (the user's documents have citations on) comes
 * as its own event, just before the text it backs.
 *
 * A watchdog ends the request when Claude goes quiet: nothing for IDLE_MS,
 * from the request to the first block or between two tokens of the answer.
 * Thinking is streamed without its text by default (display "omitted"): a
 * thinking block looks like a pause, so inside one the watchdog waits up to
 * THINKING_IDLE_MS. A stalled stream does not leave the teacher silent for
 * the SDK's full timeout.
 */

import Anthropic from "@anthropic-ai/sdk";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const IDLE_MS = 10_000;
const THINKING_IDLE_MS = 30_000;

export class LlmError extends Error {
    /**
     * @param {string} code stable code sent to the browser
     * @param {string} message detail for the server log
     */
    constructor(code, message, { cause } = {}) {
        super(message, { cause });
        this.code = code;
    }
}

/** Maps SDK errors to the codes the browser understands. */
function toLlmError(error) {
    if (error instanceof Anthropic.APIUserAbortError) {
        return error;
    }
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        return new LlmError("llm_auth", `Claude rejected the API key: ${error.message}`, { cause: error });
    }
    if (error instanceof Anthropic.RateLimitError) {
        return new LlmError("llm_rate_limited", `Claude rate limit: ${error.message}`, { cause: error });
    }
    if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
        return new LlmError("llm_bad_request", `Claude rejected the request: ${error.message}`, { cause: error });
    }
    if (error instanceof Anthropic.InternalServerError) {
        return new LlmError("llm_unavailable", `Claude is unavailable: ${error.message}`, { cause: error });
    }
    if (error instanceof Anthropic.APIConnectionError) {
        return new LlmError("llm_network", `Cannot reach Claude: ${error.message}`, { cause: error });
    }
    return new LlmError("llm_failed", error?.message ?? String(error), { cause: error });
}

/**
 * @param {object} llmConfig config.llm
 * @param {{idleMs?: number, thinkingIdleMs?: number, baseURL?: string}} [options]
 *   tests shorten the watchdog and point the SDK at a local stand-in
 */
export function createClaudeLlm(llmConfig, { idleMs = IDLE_MS, thinkingIdleMs = THINKING_IDLE_MS, baseURL } = {}) {
    const client = new Anthropic({
        apiKey: llmConfig.apiKey,
        // A voice turn cannot wait for long retries: one retry, then report it.
        maxRetries: 1,
        timeout: 30_000,
        ...(baseURL ? { baseURL } : {}),
    });

    function buildParams(system, messages) {
        const params = {
            model: llmConfig.model,
            max_tokens: llmConfig.maxTokens,
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
            messages,
            output_config: { effort: llmConfig.effort },
            // "off" is the lowest thinking setting on Claude Sonnet 5.5. Other
            // models reject it, so "adaptive" is the default.
            thinking: { type: llmConfig.thinking === "off" ? "between_tools" : "adaptive" },
        };
        if (llmConfig.fallbacks) {
            params.fallbacks = "default";
            params.betas = [FALLBACK_BETA];
        }
        return params;
    }

    return {
        name: "claude",
        model: llmConfig.model,

        /** Input tokens of `messages`, from Claude's count_tokens: it sizes a source before it is added. */
        async countTokens({ messages, signal }) {
            try {
                const result = await client.messages.countTokens({ model: llmConfig.model, messages }, { signal });
                return result.input_tokens;
            } catch (error) {
                throw toLlmError(error);
            }
        },

        async *stream({ system, messages, signal }) {
            // The request stops on the caller's signal or on the watchdog.
            const controller = new AbortController();
            const forwardAbort = () => controller.abort(signal.reason);
            if (signal?.aborted) {
                forwardAbort();
            }
            signal?.addEventListener("abort", forwardAbort, { once: true });
            let quiet = false;
            let watchdog = null;
            let thinking = false;
            const rearm = () => {
                clearTimeout(watchdog);
                watchdog = setTimeout(() => {
                    quiet = true;
                    controller.abort();
                }, thinking ? thinkingIdleMs : idleMs);
            };
            rearm();
            try {
                const stream = client.beta.messages.stream(buildParams(system, messages), { signal: controller.signal });
                for await (const event of stream) {
                    if (event.type === "content_block_start") {
                        thinking = event.content_block.type.includes("thinking");
                        rearm();
                    } else if (event.type === "content_block_delta") {
                        rearm();
                    } else if (event.type === "content_block_stop") {
                        thinking = false;
                        rearm();
                    }
                    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                        yield { type: "text", text: event.delta.text };
                    } else if (event.type === "content_block_delta" && event.delta.type === "citations_delta") {
                        yield { type: "citation", citation: event.delta.citation };
                    }
                }
                clearTimeout(watchdog);
                const message = await stream.finalMessage();
                yield {
                    type: "end",
                    stopReason: message.stop_reason,
                    usage: message.usage,
                    model: message.model,
                };
            } catch (error) {
                if (quiet && !signal?.aborted) {
                    const limit = thinking ? thinkingIdleMs : idleMs;
                    throw new LlmError("llm_timeout", `Claude sent nothing for ${limit} ms${thinking ? " while thinking" : ""}`, { cause: error });
                }
                throw toLlmError(error);
            } finally {
                clearTimeout(watchdog);
                signal?.removeEventListener("abort", forwardAbort);
            }
        },
    };
}
