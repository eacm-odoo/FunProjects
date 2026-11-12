/**
 * What a link to a shared exploration shows before anyone opens it: the card
 * LinkedIn, WhatsApp or Slack draw from the page's Open Graph tags. Their
 * crawlers do not run JavaScript, so the tags must be in the HTML the server
 * sends:
 *
 *     GET /?share=<id>      the page, with the share's title, first words and picture as tags
 *     GET /share/<id>.jpg   the picture (drawn by the page that shared, see client/src/scene/snapshot.js)
 *
 * The words are the teacher's own: the title and the first sentences of the
 * explanation the link opens at, both sealed (see shares.js). The address in
 * the tags is the one of ALLOWED_ORIGINS the request came to, never whatever
 * the request's Host header says.
 */

import { MESSAGES, format } from "./i18n.js";
import { cleanText } from "./protocol/diagram.js";
import { isShareId } from "./shares.js";

const PICTURE_RE = /^\/share\/([A-Za-z0-9_-]{12})\.jpg$/;
/** Cards show about two lines of description. */
const MAX_DESCRIPTION_CHARS = 200;
/** Previews are fetched once per link by each network: a day keeps them cheap. */
const PICTURE_MAX_AGE_SECONDS = 24 * 60 * 60;

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * The address this server is reached at for this request: the allowed origin
 * whose host the request names, or else the first allowed one.
 * @param {import("node:http").IncomingMessage} req
 * @param {string[]} allowedOrigins ALLOWED_ORIGINS
 */
export function publicOrigin(req, allowedOrigins) {
    const host = String(req.headers.host ?? "").toLowerCase();
    const origins = allowedOrigins.map((origin) => {
        try {
            return new URL(origin);
        } catch {
            return null;
        }
    }).filter(Boolean);
    const match = origins.find((origin) => origin.host === host) ?? origins[0];
    return match ? match.origin : "http://localhost";
}

/**
 * The card of share `id`.
 * @param {{shown: number, turns: object[], image?: {width: number, height: number}}} share as ShareStore keeps it
 * @returns {{title: string, description: string, url: string, language: string, site: string,
 *   image: {url: string, width: number, height: number, alt: string}|null}}
 */
export function previewOf(share, { id, origin }) {
    const turn = share.turns[share.shown - 1] ?? share.turns.at(-1);
    const language = MESSAGES[turn?.language] ? turn.language : "es";
    const texts = MESSAGES[language].preview;
    const title = turn?.diagram?.title || texts.site;
    const description = cleanText((turn?.sentences ?? []).slice(0, 2).join(" "), MAX_DESCRIPTION_CHARS) || texts.description;
    return {
        title: format(texts.title, { title }),
        description,
        url: `${origin}/?share=${id}`,
        language,
        site: texts.site,
        image: share.image
            ? { url: `${origin}/share/${id}.jpg`, width: share.image.width, height: share.image.height, alt: title }
            : null,
    };
}

/** The page's HTML with the card's tags, its title and its language. */
export function withPreview(html, preview) {
    const tags = [
        ["property", "og:type", "website"],
        ["property", "og:site_name", preview.site],
        ["property", "og:title", preview.title],
        ["property", "og:description", preview.description],
        ["property", "og:url", preview.url],
        ["name", "description", preview.description],
        ["name", "twitter:card", preview.image ? "summary_large_image" : "summary"],
        ["name", "twitter:title", preview.title],
        ["name", "twitter:description", preview.description],
    ];
    if (preview.image) {
        tags.push(
            ["property", "og:image", preview.image.url],
            ["property", "og:image:type", "image/jpeg"],
            ["property", "og:image:width", preview.image.width],
            ["property", "og:image:height", preview.image.height],
            ["property", "og:image:alt", preview.image.alt],
            ["name", "twitter:image", preview.image.url],
        );
    }
    const head = [
        ...tags.map(([attribute, key, value]) => `<meta ${attribute}="${key}" content="${escapeHtml(value)}">`),
        `<link rel="canonical" href="${escapeHtml(preview.url)}">`,
    ].join("\n    ");
    return html
        .replace(/<html lang="[^"]*">/, `<html lang="${escapeHtml(preview.language)}">`)
        .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(preview.title)}</title>`)
        .replace("</head>", `    ${head}\n</head>`);
}

/**
 * The two routes above, for the HTTP server: returns true when it answered
 * the request, false to let the page's own handler serve it.
 * @param {object} options
 * @param {import("./shares.js").ShareStore|null} options.shares null when MAX_SHARES=0
 * @param {string[]} options.allowedOrigins
 * @param {(url: string) => Promise<string>} options.readIndex the page's HTML, as it is served
 */
export function createShareRoutes({ shares, allowedOrigins, readIndex }) {
    return async (req, res) => {
        if (!shares || (req.method !== "GET" && req.method !== "HEAD")) {
            return false;
        }
        let url;
        try {
            url = new URL(req.url, "http://localhost");
        } catch {
            return false;
        }
        const picture = PICTURE_RE.exec(url.pathname);
        if (picture) {
            const image = await shares.loadImage(picture[1]);
            if (!image) {
                res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
                return true;
            }
            res.writeHead(200, {
                "Content-Type": "image/jpeg",
                "Content-Length": image.length,
                "Cache-Control": `public, max-age=${PICTURE_MAX_AGE_SECONDS}`,
            });
            res.end(req.method === "HEAD" ? undefined : image);
            return true;
        }
        const id = url.searchParams.get("share");
        if ((url.pathname !== "/" && url.pathname !== "/index.html") || !isShareId(id)) {
            return false;
        }
        const share = await shares.load(id);
        if (!share) {
            return false; // the page itself says the link is gone
        }
        const html = withPreview(await readIndex(req.url), previewOf(share, { id, origin: publicOrigin(req, allowedOrigins) }));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(req.method === "HEAD" ? undefined : html);
        return true;
    };
}
