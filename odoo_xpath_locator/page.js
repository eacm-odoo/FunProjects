/**
 * Runs in the page's main world, where the Ace editor of the view form
 * lives (Ace only renders the visible lines, so the text has to come from
 * its API, not from the DOM). Injected with chrome.scripting.executeScript,
 * which serializes the function: it must not use anything from outside.
 *
 * @param {"read"|"highlight"|"clear"} action
 * @param {object[]} matches the result of locate(), for "highlight"
 */
export function pageAction(action, matches) {
    const STYLE_ID = "o_xpath_locator_style";
    const GUTTER_CLASS = "o_xpath_locator_gutter";

    const isUsable = (el) => el.env?.editor && el.getClientRects().length > 0;
    const container =
        [...document.querySelectorAll('[name="arch_base"].ace_editor, [name="arch_base"] .ace_editor')].find(isUsable) ||
        [...document.querySelectorAll(".ace_editor")].find(isUsable);
    if (!container) {
        return { error: "no-editor" };
    }
    const editor = container.env.editor;
    if (action === "read") {
        return { text: editor.getValue() };
    }

    const state = (editor.oXpathLocator ??= { markers: [], gutterRows: [] });
    const clear = () => {
        if (!state.session) {
            return;
        }
        state.markers.forEach((id) => state.session.removeMarker(id));
        state.gutterRows.forEach((row) => state.session.removeGutterDecoration(row, GUTTER_CLASS));
        state.session.off("change", state.onChange);
        state.session = null;
        state.markers = [];
        state.gutterRows = [];
    };
    clear();
    if (action === "clear" || !matches.length) {
        return {};
    }

    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            .ace_marker-layer .o_xpath_locator_match {
                position: absolute;
                background: rgba(255, 176, 0, 0.35);
                border-bottom: 2px solid #e89b00;
            }
            .ace_marker-layer .o_xpath_locator_block {
                position: absolute;
                background: rgba(255, 176, 0, 0.1);
            }
            .ace_marker-layer .o_xpath_locator_other {
                position: absolute;
                background: rgba(255, 176, 0, 0.15);
                border-bottom: 1px dashed #e89b00;
            }
            .ace_gutter-cell.${GUTTER_CLASS} {
                background: #e89b00;
                color: #000;
            }
        `;
        document.head.append(style);
    }

    const session = editor.getSession();
    const Range = window.ace?.Range || window.ace?.require?.("ace/range").Range || editor.getSelectionRange().constructor;
    const mark = (from, to, className) => {
        state.markers.push(session.addMarker(new Range(from, 0, to, 1), className, "fullLine", false));
    };
    const [first, ...others] = matches;
    mark(first.row, first.openEndRow, "o_xpath_locator_match");
    if (first.endRow > first.openEndRow) {
        mark(first.openEndRow + 1, first.endRow, "o_xpath_locator_block");
    }
    for (const match of others) {
        mark(match.row, match.openEndRow, "o_xpath_locator_other");
    }
    session.addGutterDecoration(first.row, GUTTER_CLASS);
    state.gutterRows.push(first.row);
    // Marker positions go stale as soon as the text is edited.
    state.session = session;
    state.onChange = clear;
    session.on("change", state.onChange);

    // gotoLine unfolds and scrolls inside Ace; Odoo usually lets the editor
    // grow to full height though, so the page around it has to scroll too.
    editor.gotoLine(first.row + 1, first.column, false);
    editor.renderer.updateFull(true);
    const lineHeight = editor.renderer.lineHeight;
    for (let el = container.parentElement; el; el = el.parentElement) {
        const isRoot = el === document.scrollingElement;
        if (el.scrollHeight <= el.clientHeight) {
            continue;
        }
        if (!isRoot && !/auto|scroll|overlay/.test(getComputedStyle(el).overflowY)) {
            continue;
        }
        const top = editor.renderer.textToScreenCoordinates(first.row, 0).pageY;
        const box = isRoot ? { top: 0, height: window.innerHeight } : el.getBoundingClientRect();
        el.scrollTop += top + lineHeight / 2 - (box.top + box.height / 2);
    }
    return {};
}
