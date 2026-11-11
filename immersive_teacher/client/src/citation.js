/**
 * Where a fact of the answer comes from, as the server describes a citation
 * (see turn.js): the document's title and, for a PDF, its pages.
 */

import { t } from "./i18n.js";

/**
 * @param {{source: string, pages: {from: number, to: number}|null}} citation
 * @returns {string} "Manual.pdf, p. 4", "Manual.pdf, pp. 4-6" or just the title
 */
export function citationPlace({ source, pages }) {
    if (!pages) {
        return source;
    }
    const where = pages.from === pages.to ? t("cite.page", { page: pages.from }) : t("cite.pages", pages);
    return `${source}, ${where}`;
}
