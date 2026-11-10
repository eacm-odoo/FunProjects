/**
 * Reads the environment once and returns a frozen config object.
 *
 * Every variable has a default except the provider API keys, which are only
 * required when the matching provider is selected. A missing key fails at
 * startup with a message that names the variable, not at the first question.
 */

import { LANGUAGES } from "./i18n.js";
import { ODOO_AI_URL } from "./odoo_ai.js";

const LLM_PROVIDERS = ["claude", "fake"];
const ODOO_AI_MODES = ["on", "off", "fake"];
const STT_PROVIDERS = ["deepgram", "fake"];
const TTS_PROVIDERS = ["elevenlabs", "deepgram", "fake", "none"];
/** Every TTS adapter streams 16-bit mono PCM at this rate. */
export const TTS_SAMPLE_RATE = 24000;
const THINKING_MODES = ["adaptive", "off"];
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

export class ConfigError extends Error {}

function readChoice(env, name, choices, fallback) {
    const value = (env[name] ?? fallback).trim().toLowerCase();
    if (!choices.includes(value)) {
        throw new ConfigError(`${name}="${value}" is not valid, use one of: ${choices.join(", ")}`);
    }
    return value;
}

function readInt(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new ConfigError(`${name}="${raw}" must be an integer between ${min} and ${max}`);
    }
    return value;
}

function readFlag(env, name, fallback) {
    const raw = (env[name] ?? "").trim().toLowerCase();
    if (raw === "") {
        return fallback;
    }
    if (["1", "on", "true", "yes"].includes(raw)) {
        return true;
    }
    if (["0", "off", "false", "no"].includes(raw)) {
        return false;
    }
    throw new ConfigError(`${name}="${env[name]}" must be on or off`);
}

/**
 * The language a new page starts in, as "es" or "en", optionally with a
 * region ("es-419", "en-GB") that only the transcription uses. The page can
 * switch language at any time; this is only the default. The variable is
 * TEACHER_LANGUAGE and not LANGUAGE on purpose: Linux shells already export
 * LANGUAGE for the system locale (en_US:en), and a variable from the shell
 * wins over the one in .env.
 */
function readLanguage(env) {
    const raw = (env.TEACHER_LANGUAGE ?? "").trim();
    const value = raw || LANGUAGES[0];
    const match = /^([a-z]{2,3})(-[A-Za-z0-9]{2,8})?$/.exec(value);
    if (!match || !LANGUAGES.includes(match[1])) {
        throw new ConfigError(
            `TEACHER_LANGUAGE="${raw}" is not supported; use ${LANGUAGES.join(" or ")}, optionally with a region such as es-419`,
        );
    }
    return { language: match[1], code: value };
}

/** Deepgram's language code for each language: the bare one, or TEACHER_LANGUAGE with its region. */
function transcriptionLanguages(teacherLanguage) {
    const codes = Object.fromEntries(LANGUAGES.map((language) => [language, language]));
    codes[teacherLanguage.language] = teacherLanguage.code;
    return Object.freeze(codes);
}

/**
 * The voice for each language. Deepgram's voice is a model name per language.
 * An ElevenLabs voice speaks every language (Flash v2.5 is multilingual), so
 * the English one defaults to the same voice; a native voice sounds better.
 */
function ttsVoices(env, provider) {
    if (provider === "elevenlabs") {
        const voice = requireKey(env, "ELEVENLABS_VOICE_ID", "TTS_PROVIDER is elevenlabs", "set TTS_PROVIDER=deepgram, fake or none");
        return Object.freeze({ es: voice, en: (env.ELEVENLABS_VOICE_ID_EN || voice).trim() });
    }
    return Object.freeze({
        es: (env.DEEPGRAM_VOICE || "aura-2-estrella-es").trim(),
        en: (env.DEEPGRAM_VOICE_EN || "aura-2-thalia-en").trim(),
    });
}

function ttsApiKey(env, provider) {
    switch (provider) {
        case "elevenlabs":
            return requireKey(env, "ELEVENLABS_API_KEY", "TTS_PROVIDER is elevenlabs", "set TTS_PROVIDER=deepgram, fake or none");
        case "deepgram":
            return requireKey(env, "DEEPGRAM_API_KEY", "TTS_PROVIDER is deepgram", "set TTS_PROVIDER=fake or none");
        default:
            return "";
    }
}

function readHttpUrl(env, name, fallback) {
    const raw = (env[name] ?? "").trim() || fallback;
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new ConfigError(`${name}="${raw}" is not a valid URL`);
    }
    if (!["http:", "https:"].includes(url.protocol)) {
        throw new ConfigError(`${name}="${raw}" must start with https:// or http://`);
    }
    return url.href;
}

function requireKey(env, name, why, alternative = "") {
    const value = (env[name] ?? "").trim();
    if (!value) {
        const hint = alternative ? ` Fill it in .env, or ${alternative}.` : " Copy .env.example to .env and fill it in.";
        throw new ConfigError(`${name} is empty; it is required because ${why}.${hint}`);
    }
    return value;
}

export function loadConfig(env = process.env, argv = process.argv) {
    const llmProvider = readChoice(env, "LLM_PROVIDER", LLM_PROVIDERS, "claude");
    const thinking = readChoice(env, "CLAUDE_THINKING", THINKING_MODES, "adaptive");
    const effort = readChoice(env, "CLAUDE_EFFORT", EFFORT_LEVELS, "low");
    if (thinking === "off" && (effort === "xhigh" || effort === "max")) {
        throw new ConfigError("CLAUDE_THINKING=off only works with CLAUDE_EFFORT low, medium or high");
    }

    const sttProvider = readChoice(env, "STT_PROVIDER", STT_PROVIDERS, "deepgram");
    const ttsProvider = readChoice(env, "TTS_PROVIDER", TTS_PROVIDERS, "elevenlabs");
    const teacherLanguage = readLanguage(env);

    const port = readInt(env, "PORT", 8787, { min: 1, max: 65535 });
    return Object.freeze({
        isProd: argv.includes("--prod"),
        host: (env.HOST ?? "127.0.0.1").trim(),
        port,
        // Origins allowed to open the WebSocket. Any web page can try to reach
        // localhost, so without this check a random site could spend the API keys.
        allowedOrigins: (env.ALLOWED_ORIGINS ?? `http://localhost:${port},http://127.0.0.1:${port}`)
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean),
        language: teacherLanguage.language,
        historyTurns: readInt(env, "HISTORY_TURNS", 4, { min: 0, max: 20 }),
        maxQuestionsPerHour: readInt(env, "MAX_QUESTIONS_PER_HOUR", 30, { min: 0 }),
        llm: Object.freeze({
            provider: llmProvider,
            apiKey: llmProvider === "claude"
                ? requireKey(env, "ANTHROPIC_API_KEY", "LLM_PROVIDER is claude")
                : "",
            model: (env.CLAUDE_MODEL ?? "claude-sonnet-5-5").trim(),
            effort,
            thinking,
            fallbacks: readFlag(env, "CLAUDE_FALLBACKS", true),
            maxTokens: readInt(env, "MAX_TOKENS_PER_ANSWER", 1000, { min: 200, max: 8000 }),
        }),
        stt: Object.freeze({
            provider: sttProvider,
            apiKey: sttProvider === "deepgram"
                ? requireKey(env, "DEEPGRAM_API_KEY", "STT_PROVIDER is deepgram", "set STT_PROVIDER=fake")
                : "",
            model: (env.DEEPGRAM_MODEL ?? "nova-3").trim(),
            languages: transcriptionLanguages(teacherLanguage),
            maxSeconds: readInt(env, "MAX_RECORDING_SECONDS", 20, { min: 3, max: 60 }),
        }),
        // Documents and pages the teacher answers from; MAX_SOURCES=0 turns them off.
        sources: Object.freeze({
            maxCount: readInt(env, "MAX_SOURCES", 3, { min: 0, max: 10 }),
            maxBytes: readInt(env, "MAX_SOURCE_MB", 10, { min: 1, max: 20 }) * 1024 * 1024,
            maxTokens: readInt(env, "MAX_SOURCE_TOKENS", 100_000, { min: 1_000, max: 900_000 }),
        }),
        // Odoo's support assistant, asked first when the page's switch is on.
        odooAi: Object.freeze({
            mode: readChoice(env, "ODOO_AI", ODOO_AI_MODES, "on"),
            url: readHttpUrl(env, "ODOO_AI_URL", ODOO_AI_URL),
        }),
        tts: Object.freeze({
            provider: ttsProvider,
            apiKey: ttsApiKey(env, ttsProvider),
            voices: ttsVoices(env, ttsProvider),
            // ElevenLabs only: Deepgram's voice already is its model.
            model: (env.ELEVENLABS_MODEL || "eleven_flash_v2_5").trim(),
            sampleRate: TTS_SAMPLE_RATE,
        }),
    });
}
