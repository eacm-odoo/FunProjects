/**
 * The text of a Word document (.docx), without a library.
 *
 * A .docx file is a ZIP archive, and its text lives in word/document.xml.
 * This reads that one entry from the archive's central directory, inflates
 * it with zlib and keeps the paragraphs. Headings become "#" lines and list
 * items "-" lines. Images, comments and deleted text are left out.
 */

import zlib from "node:zlib";

import { decodeEntities, tidyText } from "./html_text.js";

const END_OF_DIRECTORY = 0x06054B50;
const DIRECTORY_ENTRY = 0x02014B50;
const LOCAL_HEADER = 0x04034B50;
/** document.xml is far bigger than its text; past this the archive is suspicious. */
const MAX_XML_BYTES = 64 * 1024 * 1024;
// Word saves heading styles under the name of the user's language: Heading1, Ttulo1, Titre1...
const HEADING_STYLE_RE = /<w:pStyle w:val="(?:Heading|Ttulo|Titulo|Titre|Kop|berschrift|Intestazione)(\d)"/i;

/** Whether `data` starts like a ZIP archive. */
export function isZip(data) {
    return data.length > 4 && data.readUInt32LE(0) === LOCAL_HEADER;
}

/**
 * The bytes of one entry of a ZIP archive, or null when it is not there or
 * uses a compression other than none or deflate.
 */
export function readZipEntry(data, name, maxBytes = MAX_XML_BYTES) {
    const lowest = Math.max(0, data.length - 0xFFFF - 22);
    let end = -1;
    for (let offset = data.length - 22; offset >= lowest; offset -= 1) {
        if (data.readUInt32LE(offset) === END_OF_DIRECTORY) {
            end = offset;
            break;
        }
    }
    if (end < 0) {
        return null;
    }
    const count = data.readUInt16LE(end + 10);
    let offset = data.readUInt32LE(end + 16);
    for (let index = 0; index < count; index += 1) {
        if (data.readUInt32LE(offset) !== DIRECTORY_ENTRY) {
            return null;
        }
        const method = data.readUInt16LE(offset + 10);
        const compressedSize = data.readUInt32LE(offset + 20);
        const nameLength = data.readUInt16LE(offset + 28);
        const extraLength = data.readUInt16LE(offset + 30);
        const commentLength = data.readUInt16LE(offset + 32);
        const localOffset = data.readUInt32LE(offset + 42);
        if (data.toString("utf8", offset + 46, offset + 46 + nameLength) === name) {
            if (data.readUInt32LE(localOffset) !== LOCAL_HEADER) {
                return null;
            }
            const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
            const packed = data.subarray(start, start + compressedSize);
            if (method === 0) {
                return packed;
            }
            return method === 8 ? zlib.inflateRawSync(packed, { maxOutputLength: maxBytes }) : null;
        }
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return null;
}

/**
 * @param {Buffer} data the .docx file
 * @returns {string|null} its text, or null when it is not a Word document
 */
export function docxToText(data) {
    let xml;
    try {
        xml = readZipEntry(data, "word/document.xml")?.toString("utf8");
    } catch {
        return null; // a truncated or damaged archive
    }
    if (xml === undefined || xml === null) {
        return null;
    }
    const lines = [];
    for (const paragraph of xml.split(/<\/w:p>/)) {
        let text = "";
        for (const match of paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g)) {
            if (match[1] !== undefined) {
                text += match[1];
            } else {
                text += match[0] === "<w:tab/>" ? "\t" : "\n";
            }
        }
        text = decodeEntities(text);
        if (!text.trim()) {
            lines.push("");
            continue;
        }
        const heading = HEADING_STYLE_RE.exec(paragraph);
        if (heading) {
            lines.push("", `${"#".repeat(Math.min(Number(heading[1]) || 1, 6))} ${text}`, "");
        } else if (paragraph.includes("<w:numPr>")) {
            lines.push(`- ${text}`);
        } else {
            lines.push(text);
        }
    }
    return tidyText(lines.join("\n"));
}
