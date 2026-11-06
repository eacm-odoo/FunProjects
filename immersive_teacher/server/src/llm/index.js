import { createClaudeLlm } from "./claude.js";
import { createFakeLlm } from "./fake.js";

/** Builds the LLM adapter selected by LLM_PROVIDER. */
export function createLlm(llmConfig) {
    switch (llmConfig.provider) {
        case "claude":
            return createClaudeLlm(llmConfig);
        case "fake":
            return createFakeLlm();
        default:
            throw new Error(`Unknown LLM provider "${llmConfig.provider}"`);
    }
}
