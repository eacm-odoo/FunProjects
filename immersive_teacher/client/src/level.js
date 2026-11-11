/**
 * How deep the teacher explains: for a child, as usual, or for an expert.
 * Every question carries it (see the server's LEVELS); "normal" is left out,
 * so the question goes exactly as before.
 *
 *     level()              the user's choice, remembered in this browser
 *     setLevel(next)       one of LEVELS; tells the listeners
 *     nextLevel()          the one after the current one, for the headset button
 *     onLevelChange(fn)    fn() after every change
 */

export const LEVELS = Object.freeze(["kid", "normal", "expert"]);
const DEFAULT_LEVEL = "normal";
const STORAGE_KEY = "immersive-teacher.level";
const listeners = new Set();

function readStored() {
    try {
        const stored = globalThis.window?.localStorage?.getItem(STORAGE_KEY);
        return LEVELS.includes(stored) ? stored : DEFAULT_LEVEL;
    } catch {
        return DEFAULT_LEVEL; // storage blocked
    }
}

let current = readStored();

export function level() {
    return current;
}

export function setLevel(next) {
    if (!LEVELS.includes(next) || next === current) {
        return;
    }
    current = next;
    try {
        globalThis.window?.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
        // storage blocked: the choice just is not remembered
    }
    for (const listener of listeners) {
        listener();
    }
}

export function nextLevel() {
    return LEVELS[(LEVELS.indexOf(current) + 1) % LEVELS.length];
}

/** Calls `listener()` after every change; returns the function that stops it. */
export function onLevelChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
