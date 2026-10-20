import { CombinedUnavailable, locateCombined } from "./combined.js";
import { LocatorError, locate } from "./locator.js";
import { pageAction, pageRpc } from "./page.js";

const STORAGE_KEY = "lastXpath";
const MAX_LISTED = 10;
const NO_EDITOR = "No architecture editor here. Open the view's form in Odoo, on the Architecture tab.";
const NO_ACCESS = "Can't read this page. Open the view's form in Odoo, on the Architecture tab.";

const form = document.getElementById("form");
const input = document.getElementById("xpath");
const result = document.getElementById("result");

function recall() {
    try {
        return localStorage.getItem(STORAGE_KEY) || "";
    } catch {
        return "";
    }
}

function remember(value) {
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Only a convenience, the popup works without it.
    }
}

async function runInPage(tabId, action, matches = []) {
    const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: pageAction,
        args: [action, matches],
    });
    return injection?.result ?? {};
}

async function rpc(tab, method, params) {
    const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageRpc,
        args: [method, params, new URL(tab.url).origin],
    });
    const reply = injection?.result;
    if (!reply || "error" in reply) {
        throw new CombinedUnavailable(reply?.error || "Odoo did not answer");
    }
    return reply.result;
}

function paragraph(text, className) {
    const el = document.createElement("p");
    el.className = className;
    el.textContent = text;
    return el;
}

function tagBlock(tag) {
    const el = document.createElement("pre");
    el.className = "o_locator_tag";
    el.textContent = tag.replace(/\s+/g, " ");
    return el;
}

function show(...nodes) {
    result.replaceChildren(...nodes.filter(Boolean));
    result.hidden = false;
}

/** Results from the editor's text alone, when the combined arch is out of reach. */
function showMatches(matches, note) {
    const notice = paragraph(note, "o_locator_note");
    if (!matches.length) {
        show(paragraph("Not found.", "o_locator_message"), notice);
        return;
    }
    const [first, ...others] = matches;
    let count = null;
    if (others.length) {
        const lines = others.slice(0, MAX_LISTED).map((match) => match.row + 1).join(", ");
        const more = others.length > MAX_LISTED ? ", …" : "";
        const where = others.length === 1 ? `the other is on line ${lines}` : `the others are on lines ${lines}${more}`;
        count = paragraph(`${matches.length} matches. Odoo uses the first one; ${where}.`, "o_locator_note");
    }
    show(paragraph(`Line ${first.row + 1}`, "o_locator_line"), tagBlock(first.tag), count, notice);
}

function showCombined(outcome, tab) {
    if (!outcome.found) {
        show(paragraph("Not found.", "o_locator_message"), outcome.note && paragraph(outcome.note, "o_locator_note"));
        return;
    }
    const { origin, place, total, warning } = outcome;
    const nodes = [paragraph(place ? `Line ${place.row + 1}` : "Line unknown", "o_locator_line")];
    if (!origin) {
        nodes.push(paragraph("Could not tell which view this node comes from.", "o_locator_origin"));
    } else if (origin.isOpenView) {
        nodes.push(paragraph("In this view.", "o_locator_origin"));
    } else {
        nodes.push(
            paragraph(`In view “${origin.name}”`, "o_locator_origin"),
            paragraph(`${origin.xmlId ? `${origin.xmlId} · ` : ""}id ${origin.id}`, "o_locator_note")
        );
    }
    if (place) {
        nodes.push(tagBlock(place.tag));
    }
    if (origin?.url) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "o_locator_open";
        open.textContent = "Open that view";
        open.addEventListener("click", async () => {
            // Never leave the site the search was made on.
            if (new URL(origin.url).origin === new URL(tab.url).origin) {
                await chrome.tabs.update(tab.id, { url: origin.url });
            }
            window.close();
        });
        nodes.push(open, paragraph("Then press Locate again to highlight it there.", "o_locator_note"));
    }
    if (total > 1) {
        nodes.push(paragraph(`${total} matches in the combined architecture. Odoo uses the first one.`, "o_locator_note"));
    }
    if (warning) {
        nodes.push(paragraph(warning, "o_locator_warning"));
    }
    show(...nodes);
}

form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    remember(input.value.trim());
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        // Whatever comes back from the page is the page's to fake: only the
        // text is taken from there, the address comes from Chrome.
        const read = await runInPage(tab.id, "read");
        if (typeof read.text !== "string") {
            show(paragraph(NO_EDITOR, "o_locator_error"));
            return;
        }
        const page = { text: read.text, isArchField: read.isArchField === true, url: tab.url };
        let outcome;
        try {
            outcome = await locateCombined(page, input.value, (method, params) => rpc(tab, method, params));
        } catch (error) {
            if (!(error instanceof CombinedUnavailable)) {
                throw error;
            }
            const matches = locate(page.text, input.value);
            await runInPage(tab.id, "highlight", matches);
            showMatches(matches, `Searched only this view's own architecture (${error.message}).`);
            return;
        }
        await runInPage(tab.id, "highlight", outcome.editorMatches ?? []);
        showCombined(outcome, tab);
    } catch (error) {
        if (error instanceof LocatorError) {
            show(paragraph(error.message, "o_locator_error"));
        } else {
            console.error(error);
            show(paragraph(NO_ACCESS, "o_locator_error"));
        }
    }
});

input.value = recall();
input.select();
