/**
 * The preview card of a shared link: the picture the page sends (a JPEG of a
 * sensible size, kept beside its share), the page's Open Graph tags from the
 * teacher's own words, and the two HTTP routes crawlers fetch.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { loadConfig } from "../server/src/config.js";
import { HourlyLimiter } from "../server/src/limits.js";
import { createFakeLlm } from "../server/src/llm/fake.js";
import { Session } from "../server/src/session.js";
import { createShareRoutes, previewOf, publicOrigin, withPreview } from "../server/src/share_page.js";
import { Sealer, ShareStore, cleanImage, jpegSize } from "../server/src/shares.js";
import { createFakeStt } from "../server/src/speech/stt/fake.js";

const quietLogger = { info() {}, warn() {}, error() {} };
const DAY_MS = 24 * 60 * 60 * 1000;
const INDEX = '<!doctype html>\n<html lang="es">\n<head>\n    <title>Profesor inmersivo</title>\n</head>\n<body></body>\n</html>\n';

const folders = [];
after(async () => {
    for (const folder of folders) {
        await rm(folder, { recursive: true, force: true });
    }
});

async function folder() {
    const dir = await mkdtemp(path.join(tmpdir(), "teacher-preview-"));
    folders.push(dir);
    return dir;
}

/** The smallest JPEG this code reads: start, a JFIF header, the frame with its size, padding, end. */
function jpeg(width, height, padding = 0) {
    const app0 = [0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const frame = [0xFF, 0xC0, 0x00, 0x11, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    return Buffer.concat([Buffer.from([0xFF, 0xD8, ...app0, ...frame]), Buffer.alloc(padding), Buffer.from([0xFF, 0xD9])]);
}

const SHARE = {
    v: 1,
    shown: 2,
    turns: [
        { turn: 1, language: "es", diagram: { title: "La fotosíntesis", nodes: [], edges: [] }, sentences: ["Uno."] },
        {
            turn: 2, language: "es", diagram: { title: 'Más de "Glucosa" <b>', nodes: [], edges: [] },
            sentences: ["La glucosa es azúcar.", "La planta la guarda como almidón.", "Una tercera que no va."],
        },
    ],
};

test("the picture must be a JPEG of a sensible size", () => {
    const card = jpeg(1200, 630);
    assert.deepEqual(jpegSize(card), { width: 1200, height: 630 });
    const clean = cleanImage(card.toString("base64"));
    assert.deepEqual({ width: clean.width, height: clean.height, bytes: clean.bytes.length }, { width: 1200, height: 630, bytes: card.length });

    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
    for (const [bad, why] of [
        [png.toString("base64"), "a PNG"],
        [jpeg(1200, 630, 450 * 1024).toString("base64"), "over 400 KB"],
        [jpeg(50, 50).toString("base64"), "too small"],
        [jpeg(5000, 630).toString("base64"), "too wide"],
        [card.subarray(0, -2).toString("base64"), "cut short"],
        ["not base64 at all!", "not an image"],
        [42, "not text"],
        ["", "empty"],
    ]) {
        assert.equal(cleanImage(bad), null, why);
    }
});

test("the picture is kept beside its share, and goes with it", async () => {
    const dir = await folder();
    let now = Date.now();
    const store = new ShareStore({ dir, maxShares: 1, days: 30, now: () => now, logger: quietLogger });
    const image = cleanImage(jpeg(1200, 630).toString("base64"));
    const id = await store.save(SHARE, image);
    assert.deepEqual((await store.load(id)).image, { width: 1200, height: 630 });
    assert.deepEqual(await store.loadImage(id), image.bytes);
    assert.deepEqual((await readdir(dir)).sort(), [`${id}.jpg`, `${id}.json`]);

    // Past MAX_SHARES, the oldest goes with its picture.
    const old = new Date(Date.now() - 60_000);
    await utimes(path.join(dir, `${id}.json`), old, old);
    const next = await store.save(SHARE);
    assert.deepEqual(await readdir(dir), [`${next}.json`]);
    assert.equal(await store.loadImage(next), null, "a share without a picture");

    // Expired, too.
    const last = await store.save(SHARE, image);
    now += 31 * DAY_MS;
    assert.equal(await store.loadImage(last), null);
    assert.ok(!(await readdir(dir)).includes(`${last}.jpg`));
});

test("the card shows the teacher's own words, escaped, at this server's public address", () => {
    const origin = publicOrigin({ headers: { host: "profe.example.com" } }, ["http://localhost:8787", "https://profe.example.com"]);
    assert.equal(origin, "https://profe.example.com");
    assert.equal(publicOrigin({ headers: { host: "evil.example" } }, ["https://profe.example.com"]), "https://profe.example.com",
        "never the Host header's own address");

    const preview = previewOf({ ...SHARE, image: { width: 1200, height: 630 } }, { id: "AbCdEfGhIjKl", origin });
    assert.equal(preview.title, 'Más de "Glucosa" <b> - Profesor inmersivo');
    assert.equal(preview.description, "La glucosa es azúcar. La planta la guarda como almidón.");
    assert.equal(preview.url, "https://profe.example.com/?share=AbCdEfGhIjKl");
    assert.equal(preview.image.url, "https://profe.example.com/share/AbCdEfGhIjKl.jpg");

    const html = withPreview(INDEX, preview);
    assert.match(html, /<title>Más de &quot;Glucosa&quot; &lt;b&gt; - Profesor inmersivo<\/title>/);
    assert.match(html, /<meta property="og:title" content="Más de &quot;Glucosa&quot; &lt;b&gt; - Profesor inmersivo">/);
    assert.match(html, /<meta property="og:image" content="https:\/\/profe\.example\.com\/share\/AbCdEfGhIjKl\.jpg">/);
    assert.match(html, /<meta property="og:image:width" content="1200">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/profe\.example\.com\/\?share=AbCdEfGhIjKl">\n<\/head>/);
    assert.doesNotMatch(html, /<b>/);

    const english = previewOf({ ...SHARE, turns: [{ ...SHARE.turns[0], language: "en", sentences: [] }], shown: 1 }, { id: "AbCdEfGhIjKl", origin });
    assert.equal(english.title, "La fotosíntesis - Immersive teacher");
    assert.match(english.description, /^An explanation with a 3D diagram/);
    const plain = withPreview(INDEX, english);
    assert.match(plain, /<html lang="en">/);
    assert.match(plain, /<meta name="twitter:card" content="summary">/);
    assert.doesNotMatch(plain, /og:image/);
});

/** What the routes write, as a stand-in for an HTTP response. */
function response() {
    return {
        status: null,
        headers: null,
        body: null,
        writeHead(status, headers = {}) {
            this.status = status;
            this.headers = headers;
            return this;
        },
        end(body) {
            this.body = body ?? null;
            return this;
        },
    };
}

test("crawlers get the page with its card, and the picture", async () => {
    const dir = await folder();
    const store = new ShareStore({ dir, maxShares: 10, days: 30, logger: quietLogger });
    const image = cleanImage(jpeg(1200, 630).toString("base64"));
    const id = await store.save(SHARE, image);
    const routes = createShareRoutes({
        shares: store,
        allowedOrigins: ["https://profe.example.com"],
        readIndex: async () => INDEX,
    });
    const get = async (url, method = "GET") => {
        const res = response();
        const handled = await routes({ url, method, headers: { host: "profe.example.com" } }, res);
        return { handled, ...res };
    };

    const page = await get(`/?share=${id}`);
    assert.equal(page.handled, true);
    assert.equal(page.status, 200);
    assert.match(page.headers["Content-Type"], /^text\/html/);
    assert.match(page.body, new RegExp(`og:image" content="https://profe\\.example\\.com/share/${id}\\.jpg"`));

    const picture = await get(`/share/${id}.jpg`);
    assert.equal(picture.status, 200);
    assert.equal(picture.headers["Content-Type"], "image/jpeg");
    assert.deepEqual(picture.body, image.bytes);
    assert.equal((await get(`/share/${id}.jpg`, "HEAD")).body, null);
    assert.equal((await get("/share/AAAAAAAAAAAA.jpg")).status, 404);

    // Anything else is the page's own handler's: unknown links, other paths, other methods.
    for (const [url, method] of [["/?share=AAAAAAAAAAAA"], ["/?share=../../x"], [`/other?share=${id}`], ["/"], [`/?share=${id}`, "POST"]]) {
        assert.equal((await get(url, method)).handled, false, `${method ?? "GET"} ${url}`);
    }
    const off = createShareRoutes({ shares: null, allowedOrigins: [], readIndex: async () => INDEX });
    assert.equal(await off({ url: `/share/${id}.jpg`, method: "GET", headers: {} }, response()), false);
});

class FakeSocket extends EventEmitter {
    readyState = 1;
    sent = [];
    waiters = [];

    send(data, options) {
        const message = options?.binary ? { type: "binary" } : JSON.parse(data);
        this.sent.push(message);
        this.waiters = this.waiters.filter(({ matches, resolve }) => (matches(message) ? (resolve(message), false) : true));
    }

    request(message, type) {
        const answer = new Promise((resolve) => this.waiters.push({ matches: (m) => m.type === type, resolve }));
        this.emit("message", Buffer.from(JSON.stringify(message)), false);
        return answer;
    }
}

test("a share keeps the page's picture when it is a JPEG, and is made without it otherwise", async () => {
    const dir = await folder();
    const sealer = new Sealer("a secret only the server knows, long enough");
    const shares = new ShareStore({ dir, maxShares: 10, days: 30, logger: quietLogger });
    const socket = new FakeSocket();
    new Session({
        socket, config: loadConfig({ LLM_PROVIDER: "fake", STT_PROVIDER: "fake", TTS_PROVIDER: "none" }, []),
        llm: createFakeLlm({ firstTokenMs: 0, chunkMs: 0 }), stt: createFakeStt({ delayMs: 0 }), tts: null,
        limiter: new HourlyLimiter(0), shares, sealer, logger: quietLogger,
    });
    const content = {
        diagram: { title: "T", nodes: [{ id: "a", label: "A", shape: "box", color: "#4C9BE8", step: 1 }], edges: [] },
        sentences: ["Una frase."],
        citations: [],
    };
    const turns = [{ turn: 1, ...content, seal: sealer.seal(content) }];

    const withPicture = await socket.request({ type: "share", req: 1, shown: 1, turns, image: jpeg(1200, 630).toString("base64") }, "shared");
    assert.ok((await readdir(dir)).includes(`${withPicture.id}.jpg`));
    assert.deepEqual((await shares.load(withPicture.id)).image, { width: 1200, height: 630 });

    const withJunk = await socket.request({ type: "share", req: 2, shown: 1, turns, image: "AAAA" }, "shared");
    assert.ok(!(await readdir(dir)).includes(`${withJunk.id}.jpg`));
    assert.equal((await shares.load(withJunk.id)).image, undefined);
});
