/**
 * What the trigger, the pinch, the grip and the A/X buttons do in the headset.
 *
 * Two modes:
 *
 *   placing   a reticle follows each controller or hand; trigger or pinch on
 *             a flat surface puts the lesson there
 *   teaching  hold trigger or pinch to talk; aim at the bar under the diagram
 *             and hold trigger, pinch or grip to carry the diagram; trigger or
 *             pinch on a floating button presses it; A or X goes back to
 *             placing (and, once placed, A or X again cancels)
 *
 * Pure logic, no WebXR: the caller describes each press (which source, which
 * button, what the ray points at) and gets the resulting callbacks. On the
 * Quest a hand's pinch arrives as "select", like the trigger.
 */

export class XrInteraction {
    /**
     * @param {object} handlers
     * @param {(source: string) => void} handlers.onPlace
     * @param {() => void} handlers.onTalkStart
     * @param {() => void} handlers.onTalkEnd
     * @param {(source: string) => void} handlers.onGrabStart
     * @param {(source: string) => void} handlers.onGrabEnd
     * @param {(control: string) => void} [handlers.onControl] a floating button was pressed
     * @param {(mode: "placing"|"teaching") => void} [handlers.onModeChange]
     */
    constructor(handlers) {
        this.handlers = handlers;
        this.mode = "placing";
        this.placed = false;
        /** "source:button" -> the action that press started ("place", "talk", "grab" or null) */
        this.held = new Map();
    }

    get talking() {
        return [...this.held.values()].includes("talk");
    }

    get grabbing() {
        return [...this.held.values()].includes("grab");
    }

    /**
     * @param {string} source which hand or controller
     * @param {"select"|"squeeze"} button
     * @param {{onHandle?: boolean, surface?: boolean, control?: string|null}} [target]
     *   what the ray points at: the grab bar, a flat surface, a floating button
     * @returns {"place"|"talk"|"grab"|"control"|null} what the press started
     */
    press(source, button, { onHandle = false, surface = false, control = null } = {}) {
        const key = `${source}:${button}`;
        if (this.held.has(key)) {
            return null;
        }
        let action = null;
        if (this.mode === "placing") {
            if (button === "select" && surface) {
                action = "place";
            }
        } else if (onHandle && !this.grabbing) {
            action = "grab";
        } else if (control && button === "select") {
            action = "control";
        } else if (button === "select" && !this.talking) {
            action = "talk";
        }
        this.held.set(key, action);

        if (action === "place") {
            this.placed = true;
            this.handlers.onPlace(source);
            this.#setMode("teaching");
        } else if (action === "grab") {
            this.handlers.onGrabStart(source);
        } else if (action === "control") {
            this.handlers.onControl?.(control);
        } else if (action === "talk") {
            this.handlers.onTalkStart();
        }
        return action;
    }

    release(source, button) {
        const key = `${source}:${button}`;
        const action = this.held.get(key);
        this.held.delete(key);
        if (action === "talk") {
            this.handlers.onTalkEnd();
        } else if (action === "grab") {
            this.handlers.onGrabEnd(source);
        }
    }

    /** A or X: choose a new place, or keep the current one if already choosing. */
    menu() {
        if (this.mode === "teaching") {
            this.#letGoOfEverything();
            this.#setMode("placing");
        } else if (this.placed) {
            this.#setMode("teaching");
        }
    }

    /** A controller turned off or a hand left the view: let go of what it held. */
    lost(source) {
        for (const key of [...this.held.keys()]) {
            if (key.startsWith(`${source}:`)) {
                this.release(source, key.slice(source.length + 1));
            }
        }
    }

    /** The session ended. */
    reset() {
        this.#letGoOfEverything();
        this.placed = false;
        this.#setMode("placing");
    }

    #letGoOfEverything() {
        for (const key of [...this.held.keys()]) {
            const separator = key.lastIndexOf(":");
            this.release(key.slice(0, separator), key.slice(separator + 1));
        }
    }

    #setMode(mode) {
        if (mode !== this.mode) {
            this.mode = mode;
            this.handlers.onModeChange?.(mode);
        }
    }
}
