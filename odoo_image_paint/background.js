/**
 * The toolbar icon injects the content scripts into the tab (once) and
 * toggles the picker. activeTab grants access to that tab only, and only
 * after the click, so the extension needs no host permissions.
 */

const CONTENT_SCRIPTS = [
    "odoo.js",
    "imaging.js",
    "paint.js",
    "pdfdoc.js",
    "ui.js",
    "picker.js",
    "editor.js",
    "main.js",
];
// Injected on demand, the first time a PDF is opened in the tab. The worker
// goes first: it registers itself for pdf.js to run in the same thread.
const PDF_LIBRARIES = ["lib/pdf.worker.min.js", "lib/pdf.min.js", "lib/pdf-lib.min.js"];

async function flag(tabId, title) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#b42318" });
    await chrome.action.setBadgeText({ tabId, text: "!" });
    await chrome.action.setTitle({ tabId, title });
    setTimeout(() => {
        chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
        chrome.action.setTitle({ tabId, title: chrome.runtime.getManifest().action.default_title }).catch(() => {});
    }, 4000);
}

async function start(tab) {
    let url;
    try {
        url = new URL(tab.url);
    } catch {
        await flag(tab.id, "Can't edit images on this page.");
        return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        await flag(tab.id, "Can't edit images on this page.");
        return;
    }
    const target = { tabId: tab.id };
    try {
        const [{ result: loaded }] = await chrome.scripting.executeScript({
            target,
            func: () => typeof globalThis.oImagePaint?.toggle === "function",
        });
        if (!loaded) {
            await chrome.scripting.executeScript({ target, files: CONTENT_SCRIPTS });
        }
        await chrome.scripting.executeScript({
            target,
            func: (origin) => globalThis.oImagePaint.toggle(origin),
            args: [url.origin],
        });
    } catch (error) {
        await flag(tab.id, `Can't edit images on this page: ${error.message}`);
    }
}

chrome.action.onClicked.addListener((tab) => {
    start(tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only this extension's own content scripts, in a tab it was started in.
    if (message?.type !== "load-pdf-libraries" || sender.id !== chrome.runtime.id || !sender.tab) {
        return false;
    }
    chrome.scripting
        .executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, files: PDF_LIBRARIES })
        .then(
            () => sendResponse({ ok: true }),
            (error) => sendResponse({ ok: false, error: error.message })
        );
    return true;
});
