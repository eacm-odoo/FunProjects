import { LocatorError, locate } from "./locator.js";
import { pageAction } from "./page.js";

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

function paragraph(text, className) {
    const el = document.createElement("p");
    el.className = className;
    el.textContent = text;
    return el;
}

function show(...nodes) {
    result.replaceChildren(...nodes);
    result.hidden = false;
}

function showMatches(matches) {
    const [first, ...others] = matches;
    const tag = document.createElement("pre");
    tag.className = "o_locator_tag";
    tag.textContent = first.tag.replace(/\s+/g, " ");
    const nodes = [paragraph(`Line ${first.row + 1}`, "o_locator_line"), tag];
    if (others.length) {
        const lines = others.slice(0, MAX_LISTED).map((match) => match.row + 1).join(", ");
        const more = others.length > MAX_LISTED ? ", …" : "";
        const where = others.length === 1 ? `the other is on line ${lines}` : `the others are on lines ${lines}${more}`;
        nodes.push(
            paragraph(`${matches.length} matches. Odoo uses the first one; ${where}.`, "o_locator_note")
        );
    }
    show(...nodes);
}

form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    remember(input.value.trim());
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const page = await runInPage(tab.id, "read");
        if (page.error) {
            show(paragraph(NO_EDITOR, "o_locator_error"));
            return;
        }
        const matches = locate(page.text, input.value);
        await runInPage(tab.id, "highlight", matches);
        if (matches.length) {
            showMatches(matches);
        } else {
            show(paragraph("Not found.", "o_locator_message"));
        }
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
