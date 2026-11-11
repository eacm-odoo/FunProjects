/**
 * Buttons floating beside the teacher in the headset, aimed at with a ray and
 * pressed with the trigger or a pinch:
 *
 *   "Mover al profesor"   choose a new place (hands have no A or X button)
 *   "English"/"Español"   switch the language (named in the language it
 *                         switches to, so whoever speaks it finds it)
 *   "Nivel: Normal"       the level of the explanation; each press goes to
 *                         the next one (child, normal, expert)
 *   "Odoo AI: on/off"     check with Odoo's support assistant first; only
 *                         when the server has Odoo AI
 *   "Volver a explicar"   says the explanation of the diagram on screen
 *                         again; only when there is one to say. After a
 *                         level change it reads "Explicar de nuevo: Niño"
 *                         and asks it again at that level
 *   suggested questions   shown when there is no microphone, or with B or Y;
 *                         "explain this source" ones come first when the user
 *                         loaded documents or pages
 *
 * The caller turns the group toward the viewer each frame; the buttons are
 * text sprites with a flat invisible box behind each one for the rays. After
 * a language switch, relabel() rebuilds them in the new language.
 */

import * as THREE from "three";

import { createTextSprite, disposeSprite } from "../diagram/labels.js";
import { list, t } from "../i18n.js";

const MOVE_ID = "move";
const LANGUAGE_ID = "language";
const ODOO_ID = "odoo";
const LEVEL_ID = "level";
const REPLAY_ID = "replay";
const GAP = 0.018;
const HIT_DEPTH = 0.02;

function defaultLabel(text, accent) {
    return createTextSprite(text, {
        lineHeight: 0.03,
        maxChars: 24,
        maxLines: 2,
        weight: accent ? 650 : 500,
        background: accent ? "rgba(15, 74, 78, 0.92)" : "rgba(16, 19, 24, 0.85)",
        onTop: true,
    });
}

export class XrMenu {
    /**
     * @param {object} [options]
     * @param {(text: string, accent: boolean) => THREE.Sprite} [options.createLabel] for tests (no canvas in Node)
     */
    constructor({ createLabel = defaultLabel } = {}) {
        this.group = new THREE.Group();
        this.group.name = "xr-menu";
        this.group.visible = false;
        this.createLabel = createLabel;
        /** @type {{id: string, question: string|null, holder: THREE.Group, label: THREE.Sprite, hitArea: THREE.Mesh}[]} */
        this.buttons = [];
        this.suggestionsVisible = false;
        /** Questions about the user's sources, before the usual suggestions. */
        this.extraQuestions = [];
        /** The Odoo AI button: shown when the server has it, highlighted when on. */
        this.odoo = { available: false, on: false };
        /** The level the next question goes at (see level.js). */
        this.level = "normal";
        /** The "explain it again" button: shown while the diagram on screen can be said again. */
        this.replay = false;
        /** The level it would be asked again at, or null to say it again as it was. */
        this.replayLevel = null;
        this.#build();
    }

    static get MOVE() {
        return MOVE_ID;
    }

    static get LANGUAGE() {
        return LANGUAGE_ID;
    }

    static get ODOO() {
        return ODOO_ID;
    }

    static get REPLAY() {
        return REPLAY_ID;
    }

    static get LEVEL() {
        return LEVEL_ID;
    }

    /** Rebuilds every button in the current language. */
    relabel() {
        for (const button of this.buttons) {
            this.group.remove(button.holder);
            disposeSprite(button.label);
            button.hitArea.geometry.dispose();
            button.hitArea.material.dispose();
        }
        this.buttons = [];
        this.#build();
    }

    /** Shows the Odoo AI button and its state; rebuilds only when they changed. */
    setOdoo({ available, on }) {
        if (available === this.odoo.available && on === this.odoo.on) {
            return;
        }
        this.odoo = { available, on };
        this.relabel();
    }

    /** Names the level on its button; rebuilds only when it changed. */
    setLevel(current) {
        if (current === this.level) {
            return;
        }
        this.level = current;
        this.relabel();
    }

    /**
     * Shows or hides "Volver a explicar"; with `again`, a level, it asks the
     * answer again at that level. Rebuilds only when that changed.
     */
    setReplay(available, again = null) {
        if (available === this.replay && again === this.replayLevel) {
            return;
        }
        this.replay = available;
        this.replayLevel = again;
        this.relabel();
    }

    /** Puts these questions first among the suggestions; rebuilds only when they changed. */
    setExtraQuestions(questions) {
        if (questions.join("\n") === this.extraQuestions.join("\n")) {
            return;
        }
        this.extraQuestions = [...questions];
        this.relabel();
    }

    #build() {
        this.#add(MOVE_ID, t("menu.move"), null, true);
        this.#add(LANGUAGE_ID, t("language.switchTo"), null, false);
        this.#add(LEVEL_ID, t("level.menu", { level: t(`level.${this.level}`) }), null, this.level !== "normal");
        if (this.odoo.available) {
            this.#add(ODOO_ID, t(this.odoo.on ? "odoo.menuOn" : "odoo.menuOff"), null, this.odoo.on);
        }
        if (this.replay) {
            const label = this.replayLevel
                ? t("explore.reexplain", { level: t(`level.${this.replayLevel}`) })
                : t("explore.replay");
            this.#add(REPLAY_ID, label, null, Boolean(this.replayLevel));
        }
        [...this.extraQuestions, ...list("suggestions")]
            .forEach((question, index) => this.#add(`ask:${index}`, question, question, false));
        this.#layout();
    }

    setSuggestionsVisible(visible) {
        this.suggestionsVisible = visible;
        this.#layout();
    }

    toggleSuggestions() {
        this.setSuggestionsVisible(!this.suggestionsVisible);
    }

    /** The question behind a button id, or null for the other buttons. */
    questionFor(id) {
        return this.buttons.find((button) => button.id === id)?.question ?? null;
    }

    /**
     * @param {THREE.Raycaster} raycaster
     * @returns {{id: string, distance: number}|null} the nearest visible button the ray hits
     */
    hit(raycaster) {
        if (!this.group.visible) {
            return null;
        }
        const areas = this.buttons.filter((button) => button.holder.visible).map((button) => button.hitArea);
        const [nearest] = raycaster.intersectObjects(areas, false);
        return nearest ? { id: nearest.object.userData.id, distance: nearest.distance } : null;
    }

    /** @param {Set<string>} ids buttons some ray points at right now */
    setHover(ids) {
        for (const button of this.buttons) {
            const hovered = ids.has(button.id);
            button.label.material.opacity = hovered ? 1 : 0.82;
            button.holder.scale.setScalar(hovered ? 1.06 : 1);
        }
    }

    #add(id, text, question, accent) {
        const holder = new THREE.Group();
        const label = this.createLabel(text, accent);
        label.renderOrder = 6;
        const hitArea = new THREE.Mesh(new THREE.BoxGeometry(1, 1, HIT_DEPTH), new THREE.MeshBasicMaterial());
        hitArea.scale.set(label.scale.x, label.scale.y, 1);
        hitArea.visible = false;
        hitArea.userData.id = id;
        holder.add(label, hitArea);
        this.group.add(holder);
        this.buttons.push({ id, question, holder, label, hitArea });
    }

    /** A column from the top down: the move button, then the questions if shown. */
    #layout() {
        let y = 0;
        for (const button of this.buttons) {
            const visible = button.question === null || this.suggestionsVisible;
            button.holder.visible = visible;
            if (!visible) {
                continue;
            }
            const height = button.label.scale.y;
            button.holder.position.set(0, y - height / 2, 0);
            y -= height + GAP;
        }
    }
}
