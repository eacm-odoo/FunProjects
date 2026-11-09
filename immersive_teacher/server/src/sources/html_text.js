/**
 * The readable text of an HTML page, for Claude to read.
 *
 * It keeps the main content: the <main> element, an element with
 * role="main" or the first <article>, and the whole <body> only when there
 * is none of those. Menus, scripts and styles are dropped. Headings become
 * "#" lines, list items "-" lines and <pre> blocks keep their line breaks,
 * so code examples from documentation stay readable.
 *
 * It is a reader for ordinary pages, not a full HTML parser. A page that
 * builds its content with JavaScript comes back nearly empty, and the caller
 * reports it.
 */

const NAMED_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", shy: "",
    copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", bull: "•", middot: "·",
    laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", sbquo: "‚", bdquo: "„",
    deg: "°", times: "×", divide: "÷", plusmn: "±", euro: "€", pound: "£", cent: "¢", sect: "§", para: "¶",
    iexcl: "¡", iquest: "¿", rarr: "→", larr: "←", uarr: "↑", darr: "↓", harr: "↔", rArr: "⇒", hArr: "⇔",
    le: "≤", ge: "≥", ne: "≠", asymp: "≈", minus: "−", infin: "∞", micro: "µ", ordf: "ª", ordm: "º",
    aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", uuml: "ü", ccedil: "ç",
    Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Uuml: "Ü", Ccedil: "Ç",
    agrave: "à", egrave: "è", ograve: "ò", acirc: "â", ecirc: "ê", ocirc: "ô", auml: "ä", ouml: "ö", szlig: "ß",
};

/** Replaces character references (&aacute;, &#233;, &#x2014;) with the characters. */
export function decodeEntities(text) {
    return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (match, entity) => {
        if (entity[0] !== "#") {
            return NAMED_ENTITIES[entity] ?? match;
        }
        const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF) ? String.fromCodePoint(code) : match;
    });
}

/** Collapses spaces in each line, trims the lines and keeps at most one empty line in a row. */
export function tidyText(text) {
    return text
        .split("\n")
        .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function stripTags(html) {
    return html.replace(/<[^>]*>/g, "");
}

/** Removes every <name>...</name> (and lone <name/>) for each name. */
function dropElements(html, names) {
    let result = html;
    for (const name of names) {
        result = result
            .replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}\\s*>`, "gi"), "\n")
            .replace(new RegExp(`<${name}\\b[^>]*\\/>`, "gi"), "");
    }
    return result;
}

/**
 * The inside of the first element whose opening tag matches `opening`,
 * counting nested elements of the same name; null when there is none.
 */
function elementContent(html, opening) {
    const start = opening.exec(html);
    if (!start) {
        return null;
    }
    const name = /^<([A-Za-z][\w:-]*)/.exec(start[0])[1];
    const tags = new RegExp(`<(\\/?)${name}\\b[^>]*>`, "gi");
    tags.lastIndex = start.index + start[0].length;
    let depth = 1;
    for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
        if (tag[0].endsWith("/>")) {
            continue;
        }
        depth += tag[1] ? -1 : 1;
        if (depth === 0) {
            return html.slice(start.index + start[0].length, tag.index);
        }
    }
    return html.slice(start.index + start[0].length);
}

const BLOCK_TAGS = "p|div|section|article|main|header|footer|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|"
    + "blockquote|figure|figcaption|details|summary|hr|address|center";

function toText(html) {
    // <pre> keeps its own line breaks: it is set aside before whitespace is collapsed.
    const blocks = [];
    let text = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (match, inner) => {
        const code = decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, "\n"))).replace(/\s+$/, "");
        blocks.push(`\n\`\`\`\n${code.replace(/^\n+/, "")}\n\`\`\`\n`);
        return `\u0000${blocks.length - 1}\u0000`;
    });
    text = text
        .replace(/\s+/g, " ")
        .replace(/<h([1-6])\b[^>]*>/gi, (match, level) => `\n\n${"#".repeat(Number(level))} `)
        .replace(/<\/h[1-6]\s*>/gi, "\n\n")
        .replace(/<li\b[^>]*>/gi, "\n- ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/?(td|th)\b[^>]*>/gi, " | ")
        .replace(new RegExp(`<\\/?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n");
    text = decodeEntities(stripTags(text));
    text = tidyText(text)
        .split("\n")
        .map((line) => line.replace(/^(\|\s*)+|(\s*\|)+$/g, "").replace(/(\s*\|\s*){2,}/g, " | "))
        .join("\n");
    return tidyText(text.replace(/\u0000(\d+)\u0000/g, (match, index) => blocks[Number(index)]));
}

/**
 * @param {string} html
 * @returns {{title: string, text: string}} title is "" when the page has none
 */
export function htmlToText(html) {
    let source = String(html).replace(/<!--[\s\S]*?-->/g, "");
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source);
    const title = titleMatch ? tidyText(decodeEntities(stripTags(titleMatch[1])).replace(/\s+/g, " ")) : "";
    source = dropElements(source, ["head", "script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "select"]);

    const main = elementContent(source, /<main\b[^>]*>/i)
        ?? elementContent(source, /<[A-Za-z][\w-]*\b[^>]*\brole\s*=\s*["']?main\b[^>]*>/i)
        ?? elementContent(source, /<article\b[^>]*>/i);
    const content = main !== null
        ? dropElements(main, ["nav", "aside", "form", "button"])
        : dropElements(elementContent(source, /<body\b[^>]*>/i) ?? source, ["nav", "header", "footer", "aside", "form", "button"]);
    return { title, text: toText(content) };
}
