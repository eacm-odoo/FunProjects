/**
 * The "Sources" part of the side panel: upload a document, load a public
 * page by its address, or drop a file anywhere on the page. Each source shows
 * its kind, its name and its size in tokens while it is ready, "Reading…"
 * while the server reads it, or why it was refused. A ready one has a button
 * that asks the teacher to explain it.
 */

import { language, t } from "../i18n.js";

const REMOVE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>';
const MESSAGE_SECONDS = 6;

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

/**
 * "docs.odoo.com/…" typed without a scheme is meant as https. Only "name://"
 * counts as a scheme: "localhost:8080/" is a host and a port.
 */
function withScheme(raw) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export class SourcesPanel {
    /**
     * @param {HTMLElement} root the #sources section
     * @param {object} options
     * @param {import("../sources.js").SourceManager} options.sources
     * @param {(entry: object) => void} options.onExplain the "Explain it" button of a ready source
     */
    constructor(root, { sources, onExplain }) {
        this.root = root;
        this.sources = sources;
        this.onExplain = onExplain;
        this.listEl = root.querySelector("#source-list");
        this.fileEl = root.querySelector("#source-file");
        this.urlForm = root.querySelector("#source-url-form");
        this.urlEl = root.querySelector("#source-url");
        this.messageEl = root.querySelector("#source-message");
        this.online = false;
        this.flashing = false;
        this.messageTimer = null;

        this.fileEl.addEventListener("change", () => {
            for (const file of this.fileEl.files) {
                this.#report(sources.addFile(file));
            }
            this.fileEl.value = "";
        });
        this.urlForm.addEventListener("submit", (event) => {
            event.preventDefault();
            const raw = this.urlEl.value.trim();
            if (!raw) {
                return;
            }
            const problem = sources.addUrl(withScheme(raw));
            this.#report(problem);
            if (!problem) {
                this.urlEl.value = "";
            }
        });
        sources.onChange(() => this.render());
        this.render();
    }

    /** Files dropped anywhere on `area` become sources. */
    acceptDrops(area) {
        let depth = 0;
        const carriesFiles = (event) => this.sources.enabled && [...(event.dataTransfer?.types ?? [])].includes("Files");
        const stop = () => {
            depth = 0;
            this.root.classList.remove("dropping");
        };
        area.addEventListener("dragenter", (event) => {
            if (carriesFiles(event)) {
                event.preventDefault();
                depth += 1;
                this.root.classList.add("dropping");
            }
        });
        area.addEventListener("dragover", (event) => {
            if (carriesFiles(event)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
            }
        });
        area.addEventListener("dragleave", () => {
            depth = Math.max(0, depth - 1);
            if (!depth) {
                stop();
            }
        });
        area.addEventListener("drop", (event) => {
            if (!carriesFiles(event)) {
                return;
            }
            event.preventDefault();
            stop();
            for (const file of event.dataTransfer.files) {
                this.#report(this.sources.addFile(file));
            }
        });
    }

    setOnline(online) {
        this.online = online;
        this.render();
    }

    applyLanguage() {
        this.render();
    }

    render() {
        this.root.hidden = !this.sources.enabled;
        this.listEl.replaceChildren(...this.sources.all.map((entry) => this.#item(entry)));
        if (!this.flashing) {
            this.#setMessage(this.sources.all.length ? "" : t("sources.hint"), false);
        }
    }

    #detail(entry) {
        if (entry.state === "error") {
            return entry.error;
        }
        if (entry.state === "loading") {
            return t(this.online ? "sources.loading" : "sources.offline");
        }
        const tokens = new Intl.NumberFormat(language(), { notation: "compact", maximumFractionDigits: 1 }).format(entry.tokens);
        return t("sources.tokens", { tokens });
    }

    #item(entry) {
        const item = element("li", "source");
        item.dataset.state = entry.state;
        if (entry.kind) {
            item.dataset.kind = entry.kind;
        }
        const kindLabel = entry.kind ? t(`sources.kind.${entry.kind}`) : (entry.origin === "url" ? "URL" : "…");
        const text = element("div", "source-text");
        const name = element("span", "source-name", entry.title);
        name.title = entry.url ?? entry.name;
        text.append(name, element("span", "source-detail", this.#detail(entry)));
        item.append(element("span", "source-kind", kindLabel), text);

        if (entry.state === "ready") {
            const explain = element("button", "source-explain", t("sources.explain"));
            explain.type = "button";
            explain.disabled = !this.online;
            explain.addEventListener("click", () => this.onExplain(entry));
            item.append(explain);
        }
        const remove = element("button", "source-remove");
        remove.type = "button";
        remove.innerHTML = REMOVE_ICON;
        remove.title = t("sources.remove", { name: entry.title });
        remove.setAttribute("aria-label", remove.title);
        remove.addEventListener("click", () => this.sources.remove(entry.id));
        item.append(remove);
        return item;
    }

    /** Shows why something was not added, for a few seconds. */
    #report(problem) {
        if (!problem) {
            return;
        }
        clearTimeout(this.messageTimer);
        this.flashing = true;
        this.#setMessage(problem, true);
        this.messageTimer = setTimeout(() => {
            this.flashing = false;
            this.render();
        }, MESSAGE_SECONDS * 1000);
    }

    #setMessage(text, warning) {
        this.messageEl.textContent = text;
        this.messageEl.classList.toggle("flash", warning);
    }
}
