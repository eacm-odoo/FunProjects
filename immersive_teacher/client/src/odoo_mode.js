/**
 * Whether questions go first to Odoo AI, the support assistant of
 * odoo.com/help, so the teacher explains its answer (see server/src/odoo_ai.js).
 *
 *     odooAvailable()        the server can (its hello says so: ODOO_AI not off)
 *     odooMode()             the user's switch, remembered in this browser
 *     odooActive()           both: the next question goes to Odoo AI
 *     setOdooMode(on)        flips the switch and tells the listeners
 *     setOdooAvailable(yes)  from the server's hello
 *     onOdooModeChange(fn)   fn() after either changes
 */

const STORAGE_KEY = "immersive-teacher.odoo-ai";
const listeners = new Set();

function readStored() {
    try {
        return globalThis.window?.localStorage?.getItem(STORAGE_KEY) === "on";
    } catch {
        return false; // storage blocked: the switch starts off
    }
}

let on = readStored();
let available = false;

function changed() {
    for (const listener of listeners) {
        listener();
    }
}

export function odooAvailable() {
    return available;
}

export function odooMode() {
    return on;
}

export function odooActive() {
    return available && on;
}

export function setOdooMode(next) {
    if (Boolean(next) === on) {
        return;
    }
    on = Boolean(next);
    try {
        globalThis.window?.localStorage?.setItem(STORAGE_KEY, on ? "on" : "off");
    } catch {
        // storage blocked: the choice just is not remembered
    }
    changed();
}

export function setOdooAvailable(next) {
    if (Boolean(next) === available) {
        return;
    }
    available = Boolean(next);
    changed();
}

/** Calls `listener()` after every change; returns the function that stops it. */
export function onOdooModeChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
