/**
 * Claude adapter: streams the answer text through the official SDK.
 *
 * Every LLM adapter exposes the same shape:
 *
 *     llm.stream({ system, messages, signal })
 *         -> AsyncIterable<{ type: "text", text } | { type: "end", stopReason, usage, model }>
 *
 * Thinking blocks and fallback markers are ignored: only text deltas matter to
 * the line parser.
 */

import Anthropic from "@anthropic-ai/sdk";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

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

export function createClaudeLlm(llmConfig) {
    const client = new Anthropic({
        apiKey: llmConfig.apiKey,
        // A voice turn cannot wait for long retries: one retry, then report it.
        maxRetries: 1,
        timeout: 30_000,
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

        async *stream({ system, messages, signal }) {
            let stream;
            try {
                stream = client.beta.messages.stream(buildParams(system, messages), { signal });
                for await (const event of stream) {
                    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                        yield { type: "text", text: event.delta.text };
                    }
                }
                const message = await stream.finalMessage();
                yield {
                    type: "end",
                    stopReason: message.stop_reason,
                    usage: message.usage,
                    model: message.model,
                };
            } catch (error) {
                throw toLlmError(error);
            }
        },
    };
}
