/**
 * Sources: reading files and pages into document blocks, keeping URL loading
 * on the public internet, and the whole flow through a session, with the fake
 * LLM and a local web server.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { after, test } from "node:test";
import zlib from "node:zlib";

import { loadConfig } from "../server/src/config.js";
import { ConversationHistory } from "../server/src/history.js";
import { HourlyLimiter } from "../server/src/limits.js";
import { createFakeLlm } from "../server/src/llm/fake.js";
import { Session } from "../server/src/session.js";
import { docxToText } from "../server/src/sources/docx_text.js";
import { SourceError, documentFromBytes } from "../server/src/sources/documents.js";
import { FetchError, fetchUrl } from "../server/src/sources/fetch_url.js";
import { htmlToText } from "../server/src/sources/html_text.js";
import { SourceList } from "../server/src/sources/index.js";
import { isPublicAddress } from "../server/src/sources/net_guard.js";
import { runTurn, withSources } from "../server/src/turn.js";

const quietLogger = { info() {}, warn() {}, error() {} };
const LONG_ENOUGH = "Este párrafo tiene suficiente texto para que valga la pena leerlo con calma.";

const DOCS_PAGE = `<!doctype html><html><head><title>Guía &amp; ejemplos</title>
<style>.x { color: red }</style><script>var a = "<p>no</p>";</script></head>
<body>
<header><nav><a href="/">Inicio</a> <a href="/docs">Docs</a></nav></header>
<div class="layout"><aside>Menú lateral</aside>
<div role="main" class="body"><div class="section">
<h1>Instalaci&oacute;n</h1>
<p>Para instalar   el paquete,
   usa pip.</p>
<ul><li>Paso uno</li><li>Paso &#233;xito &#x2014; listo</li></ul>
<pre><code>pip install paquete
python -m paquete --help</code></pre>
<table><tr><th>Opción</th><th>Uso</th></tr><tr><td>-v</td><td>detalle</td></tr></table>
<button>Copiar</button>
</div></div></div>
<footer>© 2026 Ejemplo</footer>
</body></html>`;

/** A ZIP archive, as Word writes a .docx: one entry per file. */
function zip(entries) {
    const parts = [];
    const directory = [];
    let offset = 0;
    for (const { name, text, method = 8 } of entries) {
        const data = Buffer.from(text);
        const packed = method === 8 ? zlib.deflateRawSync(data) : data;
        const nameBytes = Buffer.from(name);
        const crc = zlib.crc32?.(data) ?? 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034B50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        parts.push(local, nameBytes, packed);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014B50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        directory.push(central, nameBytes);
        offset += 30 + nameBytes.length + packed.length;
    }
    const centralDirectory = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, centralDirectory, end]);
}

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Ttulo1"/></w:pPr><w:r><w:t>Manual de ventas</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Cada pedido pasa por </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>tres etapas</w:t></w:r><w:r><w:t> &amp; se factura al final.</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Cotización</w:t></w:r></w:p>
<w:p><w:r><w:t>Nombre</w:t></w:r><w:r><w:tab/><w:t>Valor</w:t></w:r></w:p>
<w:p><w:r><w:delText>texto borrado</w:delText></w:r></w:p>
</w:body></w:document>`;

// --- Reading -----------------------------------------------------------------

test("a documentation page keeps its main content as readable text", () => {
    const { title, text } = htmlToText(DOCS_PAGE);
    assert.equal(title, "Guía & ejemplos");
    assert.match(text, /^# Instalación$/m);
    assert.match(text, /^Para instalar el paquete, usa pip\.$/m);
    assert.match(text, /^- Paso uno$/m);
    assert.match(text, /^- Paso éxito — listo$/m);
    assert.ok(text.includes("```\npip install paquete\npython -m paquete --help\n```"), text);
    assert.match(text, /^Opción \| Uso$/m);
    assert.match(text, /^-v \| detalle$/m);
    for (const left of ["Menú lateral", "Inicio", "Copiar", "var a", "Ejemplo", "color"]) {
        assert.ok(!text.includes(left), `"${left}" should be gone`);
    }
});

test("a page without a main part keeps its body, without menus, header and footer", () => {
    const { text } = htmlToText(`<html><body><nav>Menú</nav><header>Encabezado</header>
        <p>${LONG_ENOUGH}</p><footer>Pie</footer></body></html>`);
    assert.equal(text, LONG_ENOUGH);
});

test("a Word document gives its paragraphs, headings and list items", () => {
    const text = docxToText(zip([
        { name: "[Content_Types].xml", text: "<Types/>", method: 0 },
        { name: "word/document.xml", text: DOCUMENT_XML },
    ]));
    assert.equal(text, "# Manual de ventas\n\nCada pedido pasa por tres etapas & se factura al final.\n- Cotización\nNombre Valor");
    assert.equal(docxToText(zip([{ name: "xl/workbook.xml", text: "<x/>" }])), null, "a spreadsheet is not a Word document");
    assert.equal(docxToText(Buffer.from("PK\u0003\u0004 truncated")), null);
});

test("each kind of file becomes the right document block", () => {
    const pdf = documentFromBytes({ data: Buffer.from("%PDF-1.7\n1 0 obj\n"), name: "C:\\Users\\ana\\informe.pdf" });
    assert.equal(pdf.kind, "pdf");
    assert.equal(pdf.title, "informe.pdf", "no folders in the name");
    assert.equal(pdf.block.source.media_type, "application/pdf");
    assert.equal(Buffer.from(pdf.block.source.data, "base64").toString(), "%PDF-1.7\n1 0 obj\n");

    const markdown = documentFromBytes({
        data: Buffer.from(`\uFEFF# Título\r\n\r\n\r\n\r\n    sangría de código   \r\n${LONG_ENOUGH}`),
        name: "notas.md",
        mime: "text/markdown",
    });
    assert.equal(markdown.kind, "text");
    assert.equal(markdown.block.source.type, "text");
    assert.equal(markdown.block.source.data, `# Título\n\n    sangría de código\n${LONG_ENOUGH}`);
    assert.equal(markdown.block.context, "File uploaded by the user: notas.md");

    const latin1 = documentFromBytes({ data: Buffer.from(`Canción ${LONG_ENOUGH}`, "latin1"), name: "viejo.txt", mime: "text/plain; charset=iso-8859-1" });
    assert.ok(latin1.block.source.data.startsWith("Canción"));

    const page = documentFromBytes({ data: Buffer.from(DOCS_PAGE), name: "index", mime: "text/html; charset=utf-8", url: "https://example.org/docs/" });
    assert.equal(page.kind, "html");
    assert.equal(page.title, "Guía & ejemplos");
    assert.equal(page.block.context, "Downloaded from https://example.org/docs/");

    const docx = documentFromBytes({ data: zip([{ name: "word/document.xml", text: DOCUMENT_XML }]), name: "manual.docx" });
    assert.equal(docx.kind, "docx");

    const refused = (data, name, mime) => {
        try {
            documentFromBytes({ data, name, mime });
        } catch (error) {
            assert.ok(error instanceof SourceError);
            return error.code;
        }
        return "accepted";
    };
    assert.equal(refused(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]), "foto.jpg", "image/jpeg"), "source_unsupported");
    assert.equal(refused(zip([{ name: "xl/workbook.xml", text: "<x/>" }]), "tabla.xlsx"), "source_unsupported");
    assert.equal(refused(Buffer.from("hola"), "corto.txt"), "source_empty");
    assert.equal(refused(Buffer.alloc(0), "vacío.txt"), "source_empty");
    const app = "<html><head><title>App</title></head><body><div id=\"root\"></div><script>render()</script></body></html>";
    assert.equal(refused(Buffer.from(app), "app.html"), "source_empty_page");
});

test("only public addresses may be fetched", () => {
    const blocked = [
        "127.0.0.1", "10.1.2.3", "172.16.5.4", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
        "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "ff02::1",
        "::ffff:127.0.0.1", "::ffff:10.0.0.1", "localhost", "not an address",
    ];
    for (const address of blocked) {
        assert.equal(isPublicAddress(address), false, address);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "151.101.1.69", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
        assert.equal(isPublicAddress(address), true, address);
    }
});

test("the source list caps count, tokens and size, and caches up to its last document", () => {
    const block = (data) => ({ type: "document", source: { type: "text", media_type: "text/plain", data }, title: "t" });
    const list = new SourceList({ maxCount: 2, maxTokens: 1000 });
    const first = { id: "a", kind: "text", origin: "file", name: "a.md", title: "A", url: null, tokens: 600, block: block("aaa") };
    const second = { ...first, id: "b", tokens: 300, block: block("bbb") };
    list.add(first);
    assert.throws(() => list.add({ ...second, tokens: 500 }), { code: "source_too_long" });
    list.add(second);
    assert.throws(() => list.add({ ...second, id: "c", tokens: 1 }), { code: "source_limit" });
    const blocks = list.blocks();
    assert.equal(blocks[0].cache_control, undefined);
    assert.deepEqual(blocks[1].cache_control, { type: "ephemeral" });
    assert.equal(second.block.cache_control, undefined, "the stored block is not touched");
    assert.equal(list.tokens, 900);
    assert.ok(list.remove("a"));
    assert.ok(!list.remove("a"));
    assert.deepEqual(list.blocks()[0].cache_control, { type: "ephemeral" });

    const huge = { ...first, id: "h", tokens: 1, block: { ...block(""), source: { type: "base64", media_type: "application/pdf", data: "x".repeat(25 * 1024 * 1024) } } };
    assert.throws(() => list.add(huge), { code: "source_total_too_large" });
});

// --- Downloading -------------------------------------------------------------

const site = http.createServer((req, res) => {
    const { port } = site.address();
    const page = (body, headers = {}) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
        res.end(body);
    };
    switch (req.url) {
        case "/docs":
            page(DOCS_PAGE);
            break;
        case "/gzip":
            page(zlib.gzipSync(DOCS_PAGE), { "content-encoding": "gzip" });
            break;
        case "/moved":
            res.writeHead(301, { location: "/docs" }).end();
            break;
        case "/loop":
            res.writeHead(302, { location: "/loop" }).end();
            break;
        case "/to-private":
            res.writeHead(302, { location: `http://127.0.0.2:${port}/docs` }).end();
            break;
        case "/big":
            res.writeHead(200, { "content-type": "text/plain", "content-length": "5000000" });
            res.end();
            break;
        case "/endless":
            res.writeHead(200, { "content-type": "text/plain" });
            res.write("x".repeat(64 * 1024));
            res.end("x".repeat(64 * 1024));
            break;
        case "/slow":
            break; // never answers
        case "/manual.pdf":
            res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.4\n%fake\n");
            break;
        default:
            res.writeHead(404).end("not here");
    }
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}`;
after(() => {
    site.closeAllConnections();
    site.close();
});
/** The test site lives on 127.0.0.1: let only that address through. */
const onlyTheTestSite = (address) => address === "127.0.0.1";

async function fetchError(url, options = {}) {
    try {
        await fetchUrl(url, { maxBytes: 100_000, isAllowed: onlyTheTestSite, ...options });
    } catch (error) {
        assert.ok(error instanceof FetchError, `${url}: ${error}`);
        return error;
    }
    assert.fail(`${url} was fetched`);
}

test("a public page downloads, follows redirects and decompresses", async () => {
    const plain = await fetchUrl(`${siteUrl}/docs#install`, { maxBytes: 100_000, isAllowed: onlyTheTestSite });
    assert.equal(plain.url, `${siteUrl}/docs`);
    assert.equal(plain.body.toString(), DOCS_PAGE);
    const gzip = await fetchUrl(`${siteUrl}/gzip`, { maxBytes: 100_000, isAllowed: onlyTheTestSite });
    assert.equal(gzip.body.toString(), DOCS_PAGE);
    const moved = await fetchUrl(`${siteUrl}/moved`, { maxBytes: 100_000, isAllowed: onlyTheTestSite });
    assert.equal(moved.url, `${siteUrl}/docs`);
    assert.match(moved.contentType, /text\/html/);
});

test("private addresses, bad schemes, errors and oversized pages are refused", async () => {
    // The real guard: this computer is not on the public internet.
    assert.equal((await fetchError(`${siteUrl}/docs`, { isAllowed: undefined })).code, "url_blocked");
    assert.equal((await fetchError(`http://localhost:${site.address().port}/docs`, { isAllowed: undefined })).code, "url_blocked");
    assert.equal((await fetchError("http://[::1]/")).code, "url_blocked");
    assert.equal((await fetchError(`${siteUrl}/to-private`)).code, "url_blocked", "a redirect is checked again");
    for (const url of ["file:///etc/passwd", "ftp://example.org/", "javascript:alert(1)", "no es una url", `http://user:pw@127.0.0.1:${site.address().port}/`]) {
        assert.equal((await fetchError(url)).code, "url_invalid", url);
    }
    const missing = await fetchError(`${siteUrl}/nothing`);
    assert.equal(missing.code, "url_status");
    assert.equal(missing.values.status, 404);
    assert.equal((await fetchError(`${siteUrl}/loop`)).code, "url_failed");
    assert.equal((await fetchError(`${siteUrl}/big`)).code, "url_too_large");
    assert.equal((await fetchError(`${siteUrl}/endless`)).code, "url_too_large");
    assert.equal((await fetchError(`${siteUrl}/slow`, { timeoutMs: 150 })).code, "url_timeout");
    assert.equal((await fetchError("http://no-such-host.invalid/")).code, "url_not_found");
});

// --- Through a session -------------------------------------------------------

class FakeSocket extends EventEmitter {
    readyState = 1; // OPEN
    sent = [];
    waiters = [];

    send(data, options) {
        const message = options?.binary ? { type: "binary" } : JSON.parse(data);
        this.sent.push(message);
        this.waiters = this.waiters.filter(({ type, resolve }) => (message.type === type ? (resolve(message), false) : true));
    }

    /** The next message of `type` the server sends. */
    next(type) {
        return new Promise((resolve) => this.waiters.push({ type, resolve }));
    }

    fromBrowser(message) {
        this.emit("message", Buffer.from(JSON.stringify(message)), false);
    }

    fileFromBrowser(data) {
        this.emit("message", data, true);
    }
}

/** `realGuard` keeps the server's own address check, which refuses the test site. */
function openSession(env = {}, { realGuard = false } = {}) {
    const config = loadConfig({
        LLM_PROVIDER: "fake", STT_PROVIDER: "fake", TTS_PROVIDER: "none",
        MAX_SOURCES: "2", MAX_SOURCE_TOKENS: "5000", ...env,
    }, []);
    const fake = createFakeLlm({ firstTokenMs: 0, chunkMs: 0 });
    const requests = [];
    const llm = { ...fake, stream: (params) => { requests.push(params); return fake.stream(params); } };
    const socket = new FakeSocket();
    new Session({ socket, config, llm, stt: { name: "fake" }, tts: null, limiter: new HourlyLimiter(0), logger: quietLogger,
        isAllowedAddress: realGuard ? undefined : onlyTheTestSite });
    return { socket, requests };
}

const NOTES = Buffer.from(`# Notas del curso\n\n${LONG_ENOUGH} ${LONG_ENOUGH}\n`);

test("a session loads a file and a page, and every question carries them", async () => {
    const { socket, requests } = openSession();
    assert.deepEqual(socket.sent[0].sources, { maxCount: 2, maxBytes: 10 * 1024 * 1024, maxTokens: 5000 });

    let added = socket.next("source_added");
    socket.fromBrowser({ type: "source_file", id: "f1", name: "notas.md", mime: "text/markdown", language: "es" });
    socket.fileFromBrowser(NOTES);
    const file = await added;
    assert.equal(file.id, "f1");
    assert.equal(file.source.kind, "text");
    assert.equal(file.source.name, "notas.md");
    assert.ok(file.source.tokens > 30, `tokens: ${file.source.tokens}`);

    let done = socket.next("done");
    socket.fromBrowser({ type: "ask_text", turn: 1, text: "¿De qué trata?", language: "es" });
    await done;
    const [first] = requests[0].messages;
    assert.deepEqual(first.content.map((block) => block.type), ["document", "text"]);
    assert.deepEqual(first.content[0].cache_control, { type: "ephemeral" });
    assert.equal(first.content[1].text, "¿De qué trata?");
    const said = socket.sent.filter((event) => event.type === "sentence").map((event) => event.text).join(" ");
    assert.match(said, /Leí «notas\.md»/);

    added = socket.next("source_added");
    socket.fromBrowser({ type: "source_url", id: "u1", url: `${siteUrl}/docs`, language: "es" });
    const page = await added;
    assert.equal(page.source.kind, "html");
    assert.equal(page.source.title, "Guía & ejemplos");
    assert.equal(page.source.url, `${siteUrl}/docs`);

    // Full: a third one is refused, in the language of the request.
    let refused = socket.next("source_error");
    socket.fromBrowser({ type: "source_url", id: "u2", url: `${siteUrl}/docs`, language: "en" });
    assert.deepEqual(await refused, { type: "source_error", id: "u2", code: "source_limit", message: "There are already 2 sources. Remove one to add another." });

    socket.fromBrowser({ type: "source_remove", id: "f1" });
    done = socket.next("done");
    socket.fromBrowser({ type: "ask_text", turn: 2, text: "¿Y la página?", language: "es" });
    await done;
    const documents = requests[1].messages[0].content.filter((block) => block.type === "document");
    assert.deepEqual(documents.map((block) => block.title), ["Guía & ejemplos"]);
    assert.equal(requests[1].messages.length, 3, "the earlier question stays in the history");

    refused = socket.next("source_error");
    socket.fromBrowser({ type: "source_url", id: "u3", url: `${siteUrl}/nothing`, language: "es" });
    assert.equal((await refused).message, "La página respondió con el error 404. Revisa la dirección o prueba con otra.");
});

test("a session refuses what it cannot read or what does not fit, and keeps answering", async () => {
    const { socket } = openSession({ MAX_SOURCE_TOKENS: "1000" }, { realGuard: true });

    let refused = socket.next("source_error");
    socket.fromBrowser({ type: "source_file", id: "img", name: "foto.jpg", mime: "image/jpeg", language: "es" });
    socket.fileFromBrowser(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]));
    assert.equal((await refused).message, "No sé leer «foto.jpg». Sube un PDF, un Word (.docx), texto, Markdown, CSV o HTML.");

    refused = socket.next("source_error");
    socket.fromBrowser({ type: "source_file", id: "long", name: "libro.txt", mime: "text/plain", language: "es" });
    socket.fileFromBrowser(Buffer.from(LONG_ENOUGH.repeat(100)));
    const tooLong = await refused;
    assert.equal(tooLong.code, "source_too_long");
    // Far over the limit: estimated from the characters, without asking Claude.
    assert.match(tooLong.message, /^«libro\.txt» es demasiado largo: unos 1900 tokens, y quedan 1000 de 1000\./);

    refused = socket.next("source_error");
    socket.fromBrowser({ type: "source_url", id: "local", url: `${siteUrl}/docs`, language: "es" });
    assert.equal((await refused).code, "url_blocked", "the real guard keeps the server off this computer");

    // Nothing was added, and a question still goes without documents.
    const done = socket.next("done");
    socket.fromBrowser({ type: "ask_text", turn: 1, text: "¿Qué es un átomo?", language: "es" });
    await done;
    assert.ok(!socket.sent.some((event) => event.type === "source_added"));
});

test("documents go first in the first message, before the history", async () => {
    const doc = { type: "document", source: { type: "text", media_type: "text/plain", data: "x" }, title: "d" };
    assert.deepEqual(withSources([{ role: "user", content: "q" }], []), [{ role: "user", content: "q" }]);
    const messages = withSources(new ConversationHistory(4).messagesFor("q"), [doc]);
    assert.deepEqual(messages, [{ role: "user", content: [doc, { type: "text", text: "q" }] }]);

    const history = new ConversationHistory(4);
    history.add("q1", "TITLE: a");
    const withHistory = withSources(history.messagesFor("q2"), [doc]);
    assert.deepEqual(withHistory.map((message) => message.role), ["user", "assistant", "user"]);
    assert.equal(withHistory[0].content[1].text, "q1");
    assert.equal(withHistory[2].content, "q2");

    // The fake teacher answers about the document, and the turn logs it.
    const lines = [];
    const events = [];
    const result = await runTurn({
        id: 1,
        input: { text: "Explain it" },
        language: "en",
        llm: createFakeLlm({ firstTokenMs: 0, chunkMs: 0 }),
        history: new ConversationHistory(4),
        sources: [{ ...doc, title: "Sales manual", source: { ...doc.source, data: "Every order goes through three stages." } }],
        emit: (event) => events.push(event),
        logger: { info: (line) => lines.push(line), warn() {}, error() {} },
    });
    assert.equal(result.status, "done");
    assert.equal(events.find((event) => event.type === "title").text, "Sales manual");
    assert.match(events.find((event) => event.type === "sentence" && event.step === 2).text, /starts like this: Every order goes through three stages\./);
    assert.match(lines.at(-1), /sources=1/);
});
