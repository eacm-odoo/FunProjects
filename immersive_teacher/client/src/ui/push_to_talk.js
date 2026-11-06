/**
 * Push-to-talk on the desktop: hold the talk button, or the space bar while
 * the cursor is not in a text field. Phase 4 adds the trigger and the pinch.
 *
 * Only reports press and release; what they do is up to the caller.
 */

function isTyping(target) {
    return target instanceof HTMLElement
        && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/**
 * @param {object} options
 * @param {HTMLButtonElement} options.button
 * @param {() => void} options.onPress
 * @param {() => void} options.onRelease
 * @returns {() => void} removes the listeners
 */
export function bindPushToTalk({ button, onPress, onRelease }) {
    let held = false;
    const press = () => {
        if (!held && !button.disabled) {
            held = true;
            onPress();
        }
    };
    const release = () => {
        if (held) {
            held = false;
            onRelease();
        }
    };

    const onPointerDown = (event) => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        button.setPointerCapture(event.pointerId);
        press();
    };
    const onKeyDown = (event) => {
        if (event.code === "Space" && !event.repeat && !isTyping(event.target)) {
            event.preventDefault();
            press();
        }
    };
    const onKeyUp = (event) => {
        if (event.code === "Space") {
            release();
        }
    };
    const onContextMenu = (event) => event.preventDefault();

    button.addEventListener("pointerdown", onPointerDown);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    // Losing focus while holding (alt-tab) must not leave the microphone open.
    window.addEventListener("blur", release);

    return () => {
        button.removeEventListener("pointerdown", onPointerDown);
        button.removeEventListener("pointerup", release);
        button.removeEventListener("pointercancel", release);
        button.removeEventListener("contextmenu", onContextMenu);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", release);
    };
}
