/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - the heads-up display.
 *
 * Ported from the HUD Study (Claude Design, 2026-08-29). The study's argument
 * in one line: the play field claims the window. The three things you act on
 * -- lives, dash, bombs -- move into one band on the bottom edge, split around
 * a void the ship flies through, so all three sit in the same peripheral field
 * as the hitbox dot. Everything else moves outward in priority order or off the
 * play screen entirely.
 *
 * Everything here is drawn in **bitmap pixels on the same grid as the hulls**:
 * a 3x5 font at integer scales and shapes built from whole `fillRect`s. There
 * is no `fillText`, no `arc`, no gradient and no stroke left in the HUD, which
 * is why the draw-call count can go up while the frame cost goes down. The
 * sans-serif survives only in DOM chrome, where text wraps.
 *
 * Two rules that make this portable, and that the study wrote itself against:
 *   - Every element is an **anchor** (an edge or a corner) plus an offset in
 *     logical pixels. Never a fraction of W/H: the arena is shaped from the
 *     window, so a fraction moves things that should not move.
 *   - Every rate is **per frame at 60 fps**, counted off the engine's own frame
 *     counter, so pause, slow motion and hitstop scale the HUD exactly as they
 *     scale the field. Nothing in here reads a wall clock.
 *
 * The HUD renders from values that are already on the ship or in the snapshot,
 * so a guest draws its own slice from the host's state and nothing here
 * simulates anything.
 *
 * Departures from the study, and why:
 *   1. The study fires its transitions from its own control panel. Here `HudFx`
 *      **observes** the ship and starts an envelope wherever a number moved,
 *      which is the same on host and guest and costs nothing on the wire.
 *   2. The study prints graze as a bare running total (`G47`). The engine's
 *      graze meter exists to show how close the next combo step is, and the
 *      snapshot carries exactly that, so the meta line reads `G7/10`.
 *   3. Two numbers the study asked for that the wire did not have: the dash
 *      recharge fraction and the frames left on a capsule. Both are now in the
 *      snapshot (`dp`, `bt`) -- see `snapshot()`. Without them a guest could
 *      only ever draw present/absent, which is the failure the study is fixing.
 *   4. The actives lose their names (the study's 20x20 cell has room for the
 *      key numeral only). The perk tint stays on the border, and the Esc
 *      overlay names them.
 */

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

/** Foreground and secondary, unchanged from the old HUD. */
const HUD_FG = "#eaf6ff";
const HUD_DIM = "#b4d2ff";
/**
 * The one colour the study adds, reserved for one meaning: you are one hit
 * from losing the run. It is the only red in the HUD, and the enemy bullets
 * are pink-magenta and amber, so it does not collide with them.
 */
const HUD_LAST = "#ff4d5e";
const DASH_TINT = "#c9a4ff";
const BOMB_TINT = "#ffb347";
const COMBO_TINT = "#ffd166";
const ODOO_TINT = "#714B67";

/* -------------------------------------------------------------------------- */
/* 3x5 bitmap font                                                             */
/* -------------------------------------------------------------------------- */

/** Each glyph is 15 bits, row-major over a 3x5 cell. */
const GLYPHS = {
    0: "111101101101111", 1: "010110010010111", 2: "111001111100111",
    3: "111001111001111", 4: "101101111001001", 5: "111100111001111",
    6: "111100111101111", 7: "111001001001001", 8: "111101111101111",
    9: "111101111001111",
    A: "111101111101101", B: "110101110101110", C: "111100100100111",
    D: "110101101101110", E: "111100111100111", F: "111100111100100",
    G: "111100101101111", H: "101101111101101", I: "111010010010111",
    J: "001001001101111", K: "101101110101101", L: "100100100100111",
    M: "101111111101101", N: "110101101101101", O: "111101101101111",
    P: "111101111100100", Q: "111101101111001", R: "111101110101101",
    S: "111100111001111", T: "111010010010010", U: "101101101101111",
    V: "101101101101010", W: "101101111111101", X: "101101010101101",
    Y: "101101010010010", Z: "111001010100111",
    "%": "101001010100101", ":": "000010000010000", ".": "000000000000010",
    "-": "000000111000000", "/": "001001010100100", "+": "000010111010000",
    "!": "010010010000010", "#": "101111101111101", " ": "000000000000000",
};
const CHARS = Object.keys(GLYPHS);

/**
 * One baked strip per colour: 4 px per cell, 5 px tall. A glyph is then a
 * single `drawImage`, which is what lets the HUD spend more calls than the
 * proportional text it replaces and still cost less.
 */
const ATLAS = {};

function atlas(color) {
    if (ATLAS[color]) {
        return ATLAS[color];
    }
    const cv = document.createElement("canvas");
    cv.width = CHARS.length * 4;
    cv.height = 5;
    const g = cv.getContext("2d");
    g.fillStyle = color;
    const idx = {};
    CHARS.forEach((ch, i) => {
        idx[ch] = i * 4;
        const bits = GLYPHS[ch];
        for (let y = 0; y < 5; y++) {
            for (let x = 0; x < 3; x++) {
                if (bits[y * 3 + x] === "1") {
                    g.fillRect(i * 4 + x, y, 1, 1);
                }
            }
        }
    });
    ATLAS[color] = { cv, idx };
    return ATLAS[color];
}

/** Width of a string at `scale`, in logical pixels. */
function textW(str, scale) {
    return String(str).length * 4 * scale - scale;
}

/** Draw a string from the baked atlas. One call per lit glyph, none for spaces. */
function text(g, str, x, y, scale, color, alpha) {
    const a = atlas(color);
    const s = String(str).toUpperCase();
    let cx = Math.round(x);
    g.globalAlpha = alpha == null ? 1 : alpha;
    for (let i = 0; i < s.length; i++) {
        const ch = a.idx[s[i]] == null ? " " : s[i];
        if (ch !== " ") {
            g.drawImage(a.cv, a.idx[ch], 0, 3, 5, cx, Math.round(y), 3 * scale, 5 * scale);
        }
        cx += 4 * scale;
    }
    g.globalAlpha = 1;
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

function px(g, x, y, w, h, color, alpha) {
    g.globalAlpha = alpha == null ? 1 : alpha;
    g.fillStyle = color;
    g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    g.globalAlpha = 1;
}

/**
 * The three vitals are told apart by silhouette, not by colour, because in
 * peripheral vision they are only shapes: a chevron, an upright bar, a
 * diamond. Each is built on a `s` px cell and occupies 5s x 3s (5s x 5s for
 * the diamond).
 */
function chevron(g, x, y, s, color, alpha) {
    px(g, x + 2 * s, y, s, s, color, alpha);
    px(g, x + s, y + s, 3 * s, s, color, alpha);
    px(g, x, y + 2 * s, s, s, color, alpha);
    px(g, x + 4 * s, y + 2 * s, s, s, color, alpha);
}

/** The same outline with nothing in it: a life that is gone, or about to be. */
function chevronHollow(g, x, y, s, color, alpha) {
    px(g, x + 2 * s, y, s, s, color, alpha);
    px(g, x + s, y + s, s, s, color, alpha);
    px(g, x + 3 * s, y + s, s, s, color, alpha);
    px(g, x, y + 2 * s, s, s, color, alpha);
    px(g, x + 4 * s, y + 2 * s, s, s, color, alpha);
}

function diamond(g, x, y, s, color, alpha) {
    px(g, x + 2 * s, y, s, s, color, alpha);
    px(g, x + s, y + s, 3 * s, s, color, alpha);
    px(g, x, y + 2 * s, 5 * s, s, color, alpha);
    px(g, x + s, y + 3 * s, 3 * s, s, color, alpha);
    px(g, x + 2 * s, y + 4 * s, s, s, color, alpha);
}

function easeOut(t) {
    return t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3);
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The void in the middle of the band, kept clear for the ship. The study chose
 * 72 px by eye against a 680 px floor and flagged it as the first number to
 * re-measure: the ship is 32 px wide and spends most of a run inside the
 * middle third, so the band has to part around it rather than sit under it.
 */
const LANE = 72;
/** Height of the band and how far its bottom sits off the edge. */
const BAND_H = 22;
const BAND_OFF = 10;
/** Corner inset shared by every corner-anchored block. */
const EDGE = 12;

/* -------------------------------------------------------------------------- */
/* Render-only effect state                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The transitions, as envelopes in frames. The study fires them from buttons;
 * here they are **observed**: the HUD watches the three counters it draws and
 * starts an envelope wherever one moved. That works the same on the host and
 * on a guest replaying a snapshot, needs nothing on the wire, and cannot
 * disagree with the number it is decorating.
 *
 * Every field is `-1` for idle, or the frames elapsed since the trigger.
 */
export class HudFx {
    constructor() {
        this.lives = -1;
        this.bombs = -1;
        this.dash = -1;
        this.lifeGain = -1;
        this.lifeLoss = -1;
        this.bombSpend = -1;
        this.bombGain = -1;
        this.dashSpend = -1;
    }

    /**
     * @param {object} sp - the ship this belongs to
     * @param {number} ts - frame delta, 1.0 at full speed
     */
    observe(sp, ts) {
        for (const k of ["lifeGain", "lifeLoss", "bombSpend", "bombGain", "dashSpend"]) {
            if (this[k] >= 0) {
                this[k] += ts;
            }
        }
        if (this.lives >= 0 && sp.lives !== this.lives) {
            this[sp.lives > this.lives ? "lifeGain" : "lifeLoss"] = 0;
        }
        if (this.bombs >= 0 && sp.bombs !== this.bombs) {
            this[sp.bombs > this.bombs ? "bombGain" : "bombSpend"] = 0;
        }
        // Only a spend: a charge coming back is already told by the pip that
        // finishes filling, and lighting it twice reads as two charges.
        if (this.dash >= 0 && sp.dashCharges < this.dash) {
            this.dashSpend = 0;
        }
        this.lives = sp.lives;
        this.bombs = sp.bombs;
        this.dash = sp.dashCharges;
    }

    /** Progress 0..1 through an envelope of `dur` frames, or -1 if idle. */
    at(key, dur) {
        const t = this[key];
        if (t < 0) {
            return -1;
        }
        if (t >= dur) {
            this[key] = -1;
            return -1;
        }
        return t / dur;
    }
}

/* -------------------------------------------------------------------------- */
/* The band: lives, dash, bombs                                                */
/* -------------------------------------------------------------------------- */

/**
 * The local player's three vitals, on the bottom edge, split around the lane.
 * Quantity is read as length and state as fill and colour, so none of it has
 * to be counted.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {object} sp - the local ship
 * @param {number} W - arena width
 * @param {number} H - arena height
 * @param {number} frame - the engine's frame counter, for the looping breathe
 * @param {number} bombMax
 * @param {number} revive01 - how far the revive has run, 0..1
 */
export function drawVitals(g, sp, W, H, frame, bombMax, revive01) {
    const fx = sp.hudFx;
    const cx = Math.round(W / 2);
    const by = H - BAND_OFF - BAND_H;
    const laneL = cx - LANE / 2;
    const laneR = cx + LANE / 2;
    // 48-frame breathe, shared by everything that has to say "this is the last
    // one". It rides the engine's clock, so it stops when the game does.
    const pulse = 0.55 + 0.45 * Math.sin(frame * (Math.PI * 2 / 48));

    // ---- Lives: chevrons growing outward from the lane -------------------
    const cell = 3;
    const cw = 5 * cell;
    const gap = 5;
    const last = sp.lives === 1;
    const gainT = fx.at("lifeGain", 12);
    const lossT = fx.at("lifeLoss", 14);
    const lx = laneL - 10;
    for (let i = 0; i < sp.lives; i++) {
        const x = lx - (i + 1) * (cw + gap);
        let a = 1;
        if (last) {
            a = 0.55 + 0.45 * pulse;
        }
        if (gainT >= 0 && i === sp.lives - 1) {
            // Alpha only: scaling a 3 px cell puts it off the grid.
            a = easeOut(gainT);
        }
        chevron(g, x, by + 6 + (last ? -Math.round(pulse) : 0), cell, last ? HUD_LAST : sp.color, a);
    }
    if (last) {
        px(g, lx - (cw + gap), by + 6 + 3 * cell + 3, cw, 1, HUD_LAST, 0.4 + 0.6 * pulse);
    }
    if (sp.lives === 0) {
        chevronHollow(g, lx - (cw + gap), by + 6, cell, HUD_LAST, 0.5 + 0.5 * pulse);
    }
    if (lossT >= 0) {
        // The ghost of the life just lost, sliding outward at 0.43 px/frame.
        chevronHollow(
            g, lx - (sp.lives + 1) * (cw + gap) - Math.round(lossT * 6), by + 6,
            cell, HUD_LAST, 1 - lossT
        );
    }

    // ---- Dash: upright pips, the next one filling from the bottom --------
    const dx = laneR + 10;
    const pipW = 8;
    const pipH = 14;
    const pipGap = 3;
    const spendT = fx.at("dashSpend", 8);
    for (let d = 0; d < sp.dashMax; d++) {
        const x = dx + d * (pipW + pipGap);
        const y = by + 4;
        px(g, x, y, pipW, pipH, DASH_TINT, 0.16);
        px(g, x, y + pipH - 1, pipW, 1, DASH_TINT, 0.5);
        if (d < sp.dashCharges) {
            px(g, x, y, pipW, pipH, DASH_TINT);
            px(g, x + 1, y + 1, pipW - 2, 2, "#f2e6ff", 0.8);
        } else if (d === sp.dashCharges && sp.dashCdMax > 0) {
            // The recharging charge. The bright meniscus is the part that
            // reads in peripheral vision; the column behind it is the number.
            const fh = Math.round(pipH * (1 - Math.max(0, sp.dashCd) / sp.dashCdMax));
            if (fh > 0) {
                px(g, x, y + pipH - fh, pipW, fh, DASH_TINT, 0.75);
            }
            px(g, x, y + pipH - fh - 1, pipW, 1, "#f2e6ff", 0.9);
        }
    }
    if (spendT >= 0) {
        px(
            g, dx + sp.dashCharges * (pipW + pipGap) - 1, by + 3 - Math.round(spendT * 4),
            pipW + 2, pipH + 6, DASH_TINT, (1 - spendT) * 0.5
        );
    }

    // ---- Bombs: diamonds, past a 1 px rule -------------------------------
    const rule = dx + sp.dashMax * (pipW + pipGap) + 4;
    px(g, rule, by + 6, 1, 10, HUD_DIM, 0.28);
    const bx = rule + 7;
    const bs = 2;
    const bw = 5 * bs;
    const bombT = fx.at("bombSpend", 10);
    for (let b = 0; b < bombMax; b++) {
        const x = bx + b * (bw + 4);
        if (b < sp.bombs) {
            diamond(g, x, by + 5, bs, BOMB_TINT);
            if (sp.bombs === 1) {
                // Last bomb: spending it should read as a decision.
                px(g, x, by + 5 + 5 * bs + 2, bw, 1, BOMB_TINT, 0.4 + 0.6 * pulse);
            }
        } else {
            px(g, x + 2 * bs, by + 5 + 2 * bs, bs, bs, BOMB_TINT, 0.35);
        }
    }
    if (bombT >= 0) {
        // A 2 px bar opening along the band at 2.6 px/frame: the screen-clear
        // the bomb just caused, said in the place the bomb was counted.
        const r = 4 + bombT * 26;
        const x = bx + sp.bombs * (bw + 4) + bw / 2;
        px(g, x - r, by + 5 + 5 * bs / 2 - 1, r * 2, 2, BOMB_TINT, 1 - bombT);
    }

    // ---- Down: the revive bar takes the whole band, lane included --------
    if (sp.down) {
        const rw = 132;
        const rx = cx - rw / 2;
        px(g, rx, by + 6, rw, 6, "rgba(255,77,94,0.18)");
        px(g, rx, by + 6, Math.round(rw * revive01), 6, HUD_LAST, 0.9);
        text(g, "REVIVE " + Math.round(revive01 * 100) + "%", rx + 2, by - 6, 2, HUD_FG, 0.9);
    }
}

/* -------------------------------------------------------------------------- */
/* Co-op: the other players                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A remote player, 104x16, stacking up the bottom-left corner. Nothing about
 * the band changes with player count -- solo and four players are the same
 * code path with a different number of these.
 */
export function drawCrewTag(g, sp, x, y, revive01) {
    const w = 104;
    const name = sp.name.slice(0, 6);
    px(g, x, y, 2, 16, sp.color, 0.9);
    text(g, name, x + 6, y + 2, 2, sp.down ? HUD_LAST : sp.color, 0.95);
    const lx = x + 6 + textW(name, 2) + 8;
    if (sp.down) {
        // A downed player has no lives, no charges and no bombs worth reading:
        // the tag says the one thing you can act on, and how long you have.
        text(g, "DOWN", lx, y + 4, 2, HUD_LAST, 0.9);
        px(g, x, y + 14, Math.round(w * revive01), 2, HUD_LAST);
        return;
    }
    for (let i = 0; i < sp.lives; i++) {
        chevron(g, lx + i * 7, y + 3, 1, sp.color, 0.9);
    }
    const dx = x + w - 4 - sp.dashMax * 4;
    for (let d = 0; d < sp.dashMax; d++) {
        px(g, dx + d * 4, y + 4, 2, 8, DASH_TINT, d < sp.dashCharges ? 0.95 : 0.25);
    }
    if (sp.bombs > 0) {
        px(g, dx - 12, y + 6, 4, 4, BOMB_TINT, 0.9);
        text(g, String(sp.bombs), dx - 6, y + 5, 1, BOMB_TINT, 0.9);
    }
}

/* -------------------------------------------------------------------------- */
/* The corners                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Actives 1-4, bottom-right. The key numeral is the whole label: the cooldown
 * is a wipe rising through the cell in the perk's own tint, and the corner pip
 * says ready at a glance.
 *
 * @param {function} tintOf - active -> its perk tint
 * @returns {number} the y the buffs stack above, bound or not
 */
export function drawActives(g, sp, W, H, tintOf) {
    const cell = 20;
    const gap = 4;
    const n = sp.actives.length;
    const ax = W - EDGE - (n * (cell + gap) - gap);
    const ay = H - EDGE - cell;
    for (let i = 0; i < n; i++) {
        const a = sp.actives[i];
        const x = ax + i * (cell + gap);
        const tint = tintOf(a) || BOMB_TINT;
        px(g, x, ay, cell, cell, "rgba(6,10,20,0.5)");
        px(g, x, ay, cell, 1, tint, 0.8);
        px(g, x, ay + cell - 1, cell, 1, tint, 0.8);
        px(g, x, ay, 1, cell, tint, 0.8);
        px(g, x + cell - 1, ay, 1, cell, tint, 0.8);
        if (a.cd > 0 && a.cdMax > 0) {
            px(g, x + 1, ay + 1, cell - 2, Math.round((cell - 2) * (a.cd / a.cdMax)), tint, 0.22);
        }
        text(g, String(i + 1), x + 3, ay + 3, 2, a.cd > 0 ? HUD_DIM : HUD_FG, a.cd > 0 ? 0.55 : 1);
        px(g, x + cell - 6, ay + cell - 6, 3, 3, tint, a.cd > 0 ? 0.3 : 1);
    }
    return ay;
}

/**
 * Timed capsules, as draining columns up the right edge above the actives. A
 * refresh re-fills its own column; they never stack, so the row is as wide as
 * the number of different capsules and no wider.
 *
 * @param {string[]} keys - buff letters, in their fixed order
 * @param {object} maxOf - letter -> full duration in frames
 * @param {number} bottom - y the columns sit above (the actives block)
 */
export function drawBuffs(g, sp, W, frame, keys, maxOf, bottom) {
    const cw = 5;
    const ch = 16;
    const gap = 3;
    const right = W - EDGE;
    const y = bottom - 8 - ch;
    let n = 0;
    for (const k of keys) {
        const left = sp.buffs[k];
        if (!(left > 0)) {
            continue;
        }
        const x = right - (n + 1) * (cw + gap);
        n++;
        px(g, x, y, cw, ch, HUD_DIM, 0.12);
        const fill = Math.round(ch * Math.min(1, left / (maxOf[k] || 600)));
        // Under two seconds left it flickers 8 frames on, 8 off. No movement:
        // a capsule that slides is a capsule you look at.
        const low = left < 120;
        px(g, x, y + ch - fill, cw, fill, HUD_FG, low ? (frame % 16 < 8 ? 1 : 0.35) : 0.95);
        text(g, k, x + 1, y + ch + 2, 1, HUD_DIM, 0.7);
    }
}

/** Combo, top-centre: the numeral, and a 60 px rail for what is left of it. */
export function drawCombo(g, combo, comboT, comboTMax, W, frame) {
    if (combo <= 1) {
        return;
    }
    const cx = Math.round(W / 2);
    const hot = combo >= 15;
    const label = "X" + combo;
    const scale = hot ? 4 : 3;
    const w = textW(label, scale);
    // The last second before the multiplier dies, said the way an expiring
    // capsule says it: 8 frames on, 8 off, no movement. The rail alone was
    // 60 px of top edge nobody is looking at mid-pattern.
    const low = comboT < 60 && (frame % 16 < 8);
    text(g, label, cx - w / 2, 10, scale, hot ? COMBO_TINT : HUD_FG, low ? 0.35 : 0.9);
    const ry = 10 + 5 * scale + 3;
    px(g, cx - 30, ry, 60, 2, COMBO_TINT, 0.18);
    px(g, cx - 30, ry, Math.round(60 * Math.max(0, Math.min(1, comboT / comboTMax))), 2, COMBO_TINT, low ? 0.35 : 0.85);
}

/**
 * Score, and under it the line nothing is ever read off in a hurry: wave,
 * clock, and how close the next combo step is. Bottom of the priority stack,
 * furthest corner from the ship.
 */
export function drawMeta(g, score, meta, W) {
    const s = String(score);
    text(g, s, W - EDGE - textW(s, 2), 10, 2, HUD_FG, 0.85);
    text(g, meta, W - EDGE - textW(meta, 1), 22, 1, HUD_DIM, 0.55);
}

/**
 * Top-left: the whole toolbar, collapsed into one affordance that never grows.
 * It is not interactive -- Esc opens the overlay that owns everything the
 * toolbar used to hold.
 */
export function drawEscPip(g) {
    px(g, 10, 10, 3, 10, ODOO_TINT);
    text(g, "ESC", 16, 12, 2, HUD_DIM, 0.55);
}
