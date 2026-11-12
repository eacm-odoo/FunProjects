/**
 * Entry point: one process, one port.
 *
 * - Development (`npm run dev`): Vite runs inside this server in middleware
 *   mode, with hot reload, so the page, the HMR socket and /ws share a port.
 *   That keeps `adb reverse` down to a single port for the Quest.
 * - Production (`npm start`, after `npm run build`): serves client/dist.
 *
 * The API keys never leave this process: the browser only talks to /ws.
 */

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

import { AnswerCache, signatureOf } from "./answer_cache.js";
import { ConfigError, loadConfig } from "./config.js";
import { HourlyLimiter } from "./limits.js";
import { createLlm } from "./llm/index.js";
import { createOdooAi } from "./odoo_ai.js";
import { Session } from "./session.js";
import { createShareRoutes } from "./share_page.js";
import { Sealer, ShareStore, loadSecret } from "./shares.js";
import { createStt } from "./speech/stt/index.js";
import { createTts } from "./speech/tts/index.js";
import { speedFor } from "./speech/tts/speed.js";

const ENV_FILE = fileURLToPath(new URL("../../.env", import.meta.url));
const CLIENT_DIR = fileURLToPath(new URL("../../client/", import.meta.url));
const DIST_DIR = path.join(CLIENT_DIR, "dist");
const WS_PATH = "/ws";
// Recordings are capped at 2 MB by the session, and uploaded documents at
// MAX_SOURCE_MB; the socket's hard stop is a little above the larger of both.
const MIN_WS_PAYLOAD = 4 * 1024 * 1024;
const WS_PAYLOAD_MARGIN = 1024 * 1024;
// Proxies on the way, such as Cloudflare's tunnel, close a WebSocket that
// stays quiet for a while, and nothing travels while the person looks at a
// diagram. A ping this often keeps it open; the browser answers it on its own.
const WS_PING_SECONDS = 30;

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
};

function createStaticHandler(rootDir) {
    const indexFile = path.join(rootDir, "index.html");
    return async (req, res) => {
        let pathname;
        try {
            pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
        } catch {
            res.writeHead(400).end();
            return;
        }
        let filePath = path.normalize(path.join(rootDir, pathname));
        if (!filePath.startsWith(rootDir + path.sep) && filePath !== rootDir) {
            res.writeHead(403).end();
            return;
        }
        try {
            if (!(await stat(filePath)).isFile()) {
                filePath = indexFile;
            }
        } catch {
            filePath = indexFile;
        }
        res.writeHead(200, {
            "Content-Type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
        });
        createReadStream(filePath).pipe(res);
    };
}

async function createViteHandler(server) {
    const { createServer } = await import("vite");
    const vite = await createServer({
        configFile: path.join(CLIENT_DIR, "vite.config.js"),
        appType: "spa",
        server: { middlewareMode: true, hmr: { server } },
    });
    const handler = (req, res) => vite.middlewares(req, res);
    handler.close = () => vite.close();
    // The page as Vite serves it, for the shared links' previews.
    handler.readIndex = async (url) => vite.transformIndexHtml(url, await readFile(path.join(CLIENT_DIR, "index.html"), "utf8"));
    return handler;
}

/** The built page, read once, for the shared links' previews. */
function builtIndexReader() {
    let html = null;
    return async () => {
        html ??= await readFile(path.join(DIST_DIR, "index.html"), "utf8");
        return html;
    };
}

/**
 * Loads immersive_teacher/.env when it exists. Variables already set in the
 * shell win over the file. Loaded here rather than with --env-file because
 * Node's watch mode crashes on an env file that does not exist.
 */
function loadEnvFile() {
    try {
        process.loadEnvFile(ENV_FILE);
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
}

async function main() {
    loadEnvFile();
    let config;
    try {
        config = loadConfig();
    } catch (error) {
        if (error instanceof ConfigError) {
            console.error(`Configuration error: ${error.message}`);
            process.exit(1);
        }
        throw error;
    }

    const llm = createLlm(config.llm);
    const stt = createStt(config.stt);
    const tts = createTts(config.tts);
    const odooAi = createOdooAi(config.odooAi);
    const limiter = new HourlyLimiter(config.maxQuestionsPerHour);
    const voiceLimiter = new HourlyLimiter(config.maxQuestionsPerHour);
    const { shares: sharesConfig } = config;
    const sealer = sharesConfig.maxCount ? new Sealer(await loadSecret(sharesConfig.dir)) : null;
    const shares = sealer && new ShareStore({ dir: sharesConfig.dir, maxShares: sharesConfig.maxCount, days: sharesConfig.days });
    const { answers: answersConfig } = config;
    const answers = answersConfig.maxCount
        ? new AnswerCache({ dir: answersConfig.dir, maxEntries: answersConfig.maxCount, signature: signatureOf(config) })
        : null;
    const server = http.createServer();
    const handler = config.isProd ? createStaticHandler(DIST_DIR) : await createViteHandler(server);
    const shareRoutes = createShareRoutes({
        shares,
        allowedOrigins: config.allowedOrigins,
        readIndex: handler.readIndex ?? builtIndexReader(),
    });

    server.on("request", async (req, res) => {
        if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, llm: llm.name }));
            return;
        }
        try {
            if (await shareRoutes(req, res)) {
                return;
            }
        } catch (error) {
            // Without its preview, the page still opens the link.
            console.error(`Share preview for ${req.url} failed:`, error);
        }
        handler(req, res);
    });

    const maxPayload = Math.max(MIN_WS_PAYLOAD, config.sources.maxBytes + WS_PAYLOAD_MARGIN);
    const wss = new WebSocketServer({ noServer: true, maxPayload });
    server.on("upgrade", (req, socket, head) => {
        const { pathname } = new URL(req.url, "http://localhost");
        if (pathname !== WS_PATH) {
            // Vite answers its own HMR sockets; anything else is closed.
            const protocol = req.headers["sec-websocket-protocol"] ?? "";
            if (config.isProd || !protocol.startsWith("vite-")) {
                socket.destroy();
            }
            return;
        }
        if (!config.allowedOrigins.includes(req.headers.origin)) {
            console.warn(`WebSocket from origin ${JSON.stringify(req.headers.origin)} refused (see ALLOWED_ORIGINS)`);
            socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    wss.on("connection", (socket) => new Session({
        socket, config, llm, stt, tts, odooAi, limiter, shares, sealer, voiceLimiter, answers,
    }));
    const pings = setInterval(() => {
        for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.ping();
            }
        }
    }, WS_PING_SECONDS * 1000);
    pings.unref();

    server.on("error", (error) => {
        if (error.code === "EADDRINUSE") {
            console.error(`Port ${config.port} is already in use: is another instance running? Stop it or set PORT.`);
            process.exit(1);
        }
        throw error;
    });
    server.listen(config.port, config.host, () => {
        const { llm: llmConfig } = config;
        const llmInfo = llm.name === "claude"
            ? `claude ${llmConfig.model}, effort ${llmConfig.effort}, thinking ${llmConfig.thinking}, `
                + `fallbacks ${llmConfig.fallbacks ? "on" : "off"}, max_tokens ${llmConfig.maxTokens}`
            : llm.name;
        console.info(`Immersive teacher (${config.isProd ? "production" : "development"}) on http://localhost:${config.port}`);
        const pairs = (values) => Object.entries(values).map(([language, value]) => `${language}=${value}`).join(" ");
        const sttInfo = stt.name === "deepgram" ? `deepgram ${config.stt.model} (${pairs(config.stt.languages)})` : stt.name;
        const speed = (provider) => `speed ${speedFor(provider, config.tts.speed) ?? 1}`;
        const ttsInfo = {
            elevenlabs: `elevenlabs ${config.tts.model}, voices ${pairs(config.tts.voices)}, ${speed("elevenlabs")}`,
            deepgram: `deepgram ${pairs(config.tts.voices)}, ${speed("deepgram")}`,
        }[tts?.name] ?? (tts?.name ?? "none (text only)");
        console.info(`LLM: ${llmInfo} | ${config.maxQuestionsPerHour || "unlimited"} questions/hour`);
        console.info(`Speech: STT ${sttInfo} | TTS ${ttsInfo} | pages start in ${config.language}`);
        const { sources } = config;
        console.info(sources.maxCount
            ? `Sources: up to ${sources.maxCount}, ${sources.maxBytes / 1024 / 1024} MB each, ${sources.maxTokens} tokens in all`
            : "Sources: off (MAX_SOURCES=0)");
        console.info(odooAi
            ? `Odoo AI: ${odooAi.name === "fake" ? "fake answers" : `on (${odooAi.url})`}, asked when the page's switch is on`
            : "Odoo AI: off (ODOO_AI=off)");
        console.info(shares
            ? `Shares: up to ${sharesConfig.maxCount} links in ${sharesConfig.dir}, kept ${sharesConfig.days} days`
            : "Shares: off (MAX_SHARES=0)");
        console.info(answers
            ? `Answer cache: up to ${answersConfig.maxCount} answers in ${answersConfig.dir}`
            : "Answer cache: off (MAX_CACHED_ANSWERS=0)");
    });

    let closing = false;
    const shutdown = async () => {
        if (closing) {
            process.exit(1);
        }
        closing = true;
        clearInterval(pings);
        for (const client of wss.clients) {
            client.terminate();
        }
        await handler.close?.();
        server.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

await main();
