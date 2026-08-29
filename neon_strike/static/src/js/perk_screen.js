/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - the between-waves upgrade screen.
 *
 * Drawn on the game canvas in HUD space, on host and guest alike: everything
 * on it comes from the perk phase packet (offers, picks, frames left) plus the
 * local ship's own perks and summed modifiers, so a guest renders the whole
 * screen without simulating anything.
 *
 * The screen owns its own animation state and nothing else. It never touches
 * the simulation, it is not in the snapshot, and it advances only from the
 * `ts` the engine hands it, so a paused game freezes it.
 *
 * -------------------------------------------------------------------------
 * UPGRADE STUDY port (2026-08-29)
 * -------------------------------------------------------------------------
 * What the study replaces: three 188x250 cards at a fixed centre, prose under
 * each name, and no answer at all to the question the player is actually
 * asking -- *what does this do to the ship I already have?*
 *
 * The three things it adds, in order of how much they matter:
 *   1. Modifier rows with a running total. A perk's delta next to what the
 *      ship's number becomes if you take it, and a stub against any modifier
 *      the ship already carries, so stacking is visible instead of remembered.
 *   2. The build block -- what you own, by family, with the active slots and
 *      the current totals. It is the context the deltas are read against.
 *   3. A measured layout. Card height comes from `measureText` at the live
 *      card width, the three are levelled to the tallest, and one rect array
 *      is shared by the drawing and the hit test, so a card can never be
 *      clickable somewhere it is not drawn.
 *
 * Departures from the study, and why:
 *   1. **Silkscreen and IBM Plex Mono are not shipped.** The study asks for
 *      two webfonts; an Odoo module that pulled them off a CDN would be worse
 *      than the seam it fixes, and there is no bitmap font in this codebase to
 *      use instead. Structure is `system-ui`, matching the rest of the HUD,
 *      and everything numeric is monospace so the deltas and totals line up in
 *      a column. The study rates this "survives, degraded", and it is the one
 *      part of the sheet that is not here.
 *   2. **The blocked state (4/4 actives) is not built, because it is
 *      unreachable.** `rollOffers` already drops actives from the pool once a
 *      ship holds `MAX_ACTIVES`, so an offer can never contain a card that
 *      would be discarded. The study's timeout fix -- take the first offer
 *      that is not blocked -- is correct against an engine that offers them
 *      anyway; here `offer[0]` is already always takeable. Dead code for a
 *      state that cannot happen is worse than the note saying so.
 *   3. **The rail threshold is 880 px, not the study's 1100.** Measured
 *      against the arena this game actually builds: `_fitArena` clamps the
 *      aspect to 2.1, so the widest arena is 1134x540 and W >= 1100 would put
 *      the rail on ultrawide only. At 880 the rail engages from 16:9 (960x540)
 *      up, where it has room -- the cards come out 176 px at 880 and 202 px at
 *      960, both clear of the 150 floor. Below it the build block is the
 *      study's strip.
 *   4. **35 of the 50 perks in this game carry no `mods` at all** -- they are
 *      flag perks, and the study's pool was all numbers. So the note is not
 *      the study's "conditionals and actives only": a card with no modifier
 *      rows always shows its description, because otherwise two thirds of the
 *      catalogue would be a name and a family. Cards that do have numbers show
 *      at most two (the most any perk here carries), and the study's five-row
 *      cap never binds.
 *   5. **The dead-player state is not built either, and for the same reason.**
 *      The study assumes a downed player sits the phase out; in this engine
 *      `_updatePerkPhase` waits on every ship including the downed ones and
 *      `pickPerk` grants to them, so a player who is dead when the wave clears
 *      still chooses. Drawing "NO PICK THIS PHASE" over a screen they can pick
 *      on would be a lie about the rules.
 *   6. Modifier bases live in the engine next to the constants they mirror and
 *      arrive in the model, rather than being copied into this file where they
 *      could drift away from `_fireDelay`, `SHIP_HIT_R` and `DASH_CD`.
 *
 * Kept exactly as the sheet specifies: every animation rate, the slack split
 * (24% under the name, 50% across the modifier rows, 18% above the note), the
 * 34 px band, the fuse on the default card, the 304 px card cap and the
 * 268/210 minimum heights.
 */

import { MAX_ACTIVES, PERKS } from "./perks";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

// Window shape switches. `FLOOR_W` shrinks the type and the padding; above
// `RAIL_W` the build block moves from a strip under the title to a left rail.
// Both are measured against the arenas `_fitArena` can produce (680x540 up to
// 1134x540, and 680x800 the other way), not carried over from the study.
const FLOOR_W = 700;
const RAIL_W = 880;
const RAIL_SIZE = 236;
const RAIL_GAP = 28;
// A card never grows past this, however wide the window: three cards stretched
// across an ultrawide read as billboards. The leftover becomes margin.
const CARD_MAX_W = 304;
const CARD_MIN_W = 150;
// Levelled card height is clamped into this range, and again to the space
// available between the build block and the bottom bar.
const CARD_MIN_H = 268;
const CARD_MIN_H_FLOOR = 210;
const CARD_MAX_H = 430;
// The band welded to the bottom edge of every card: stacking, cooldown, or the
// state once a pick has landed.
const BAND_H = 34;
const CARD_PAD = 12;
const CHIP_W = 18;
const CHIP_H = 16;
const ROW_H = 17;
const NOTE_LH = 13;
// Slack under the levelled height is spent as leading rather than left as a
// hole, so a one-line perk and a three-line perk reach the same height with
// the same rhythm.
const SLACK_NAME = 0.24;
const SLACK_ROWS = 0.5;
const SLACK_ROW_MAX = 10;
const SLACK_NOTE = 0.18;

// One tint per family, taken off the perks themselves so this cannot drift
// from the catalogue.
const FAMILIES = ["Weapon", "Hull", "Support", "Utility", "Dash", "Active"];
const FAMILY_TINT = {};
for (const p of PERKS) {
    if (!FAMILY_TINT[p.tag]) {
        FAMILY_TINT[p.tag] = p.tint;
    }
}

const FG = "#eaf6ff";
const DIM = "rgba(180,210,255,0.55)";
const DIMMER = "rgba(180,210,255,0.35)";
const WARN = "#ffd166";
const OK = "#7bffb0";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const UI = "system-ui,sans-serif";

/**
 * How each modifier reads on a card. `fmt` decides both the delta and the
 * running total; the base each total is measured from comes from the engine in
 * `model.bases`, so the numbers stay next to the code that applies them.
 *   pct  - a fraction of a base value (fire delay, hitbox, dash cooldown)
 *   mul  - added straight onto a multiplier (crit multiplier, score)
 *   prob - a probability shown as a percentage (crit chance, capsule luck)
 *   int  - a count
 *   px   - logical pixels
 */
const MOD_VIEW = {
    fireRate: { label: "FIRE DELAY", fmt: "pct", unit: "f" },
    dmg: { label: "DAMAGE", fmt: "int" },
    bulletSpeed: { label: "BULLET SPD", fmt: "pct", unit: "x" },
    side: { label: "SIDE SHOTS", fmt: "int" },
    pierce: { label: "PIERCE", fmt: "int" },
    crit: { label: "CRIT CHANCE", fmt: "prob" },
    critMul: { label: "CRIT MULT", fmt: "mul" },
    moveSpeed: { label: "MOVE SPD", fmt: "pct", unit: "x" },
    hitbox: { label: "HITBOX", fmt: "pct", unit: "px" },
    lives: { label: "LIVES", fmt: "int" },
    maxLives: { label: "LIFE CAP", fmt: "int" },
    inv: { label: "I-FRAMES", fmt: "pct", unit: "x" },
    magnet: { label: "MAGNET", fmt: "px" },
    luck: { label: "CAPSULE LUCK", fmt: "prob" },
    scoreMul: { label: "SCORE MULT", fmt: "mul" },
    dashCd: { label: "DASH CD", fmt: "pct", unit: "f" },
    dashCharges: { label: "DASH CHG", fmt: "int" },
};

/* -------------------------------------------------------------------------- */
/* Number formatting                                                           */
/* -------------------------------------------------------------------------- */

function sign(v) {
    return v > 0 ? "+" : "";
}

/** What this perk adds, on its own. */
function modDelta(key, v) {
    const d = MOD_VIEW[key];
    if (!d) {
        return sign(v) + v;
    }
    if (d.fmt === "pct" || d.fmt === "prob") {
        return sign(v) + Math.round(v * 100) + "%";
    }
    if (d.fmt === "mul") {
        return sign(v) + v.toFixed(2) + "x";
    }
    if (d.fmt === "px") {
        return sign(v) + Math.round(v) + "px";
    }
    return sign(v) + v;
}

/** What the ship's number becomes if the card is taken. */
function modTotal(key, base, owned, add) {
    const d = MOD_VIEW[key];
    const sum = (owned || 0) + add;
    if (!d) {
        return String(Math.round(base + sum));
    }
    if (d.fmt === "pct") {
        const v = base * (1 + sum);
        return (d.unit === "x" ? v.toFixed(2) : v.toFixed(1)) + (d.unit === "x" ? "x" : d.unit || "");
    }
    if (d.fmt === "prob") {
        return Math.round((base + sum) * 100) + "%";
    }
    if (d.fmt === "mul") {
        return (base + sum).toFixed(2) + "x";
    }
    if (d.fmt === "px") {
        return Math.round(base + sum) + "px";
    }
    return String(Math.round(base + sum));
}

/* -------------------------------------------------------------------------- */
/* The screen                                                                  */
/* -------------------------------------------------------------------------- */

export class PerkScreen {
    constructor() {
        this.t = 0;
        this.alpha = 0;
        this.cards = [];
        this.key = "";
        this.flashed = false;
    }

    /**
     * Point the screen at a phase. Idempotent: it only rewinds the animation
     * when the offers actually change, so a snapshot arriving every frame on a
     * guest does not restart the deal.
     *
     * @param {number[]} offers - perk indexes offered to the local slot
     */
    sync(offers) {
        const key = offers.join(",");
        if (key === this.key) {
            return;
        }
        this.key = key;
        this.t = 0;
        this.alpha = 0;
        this.flashed = false;
        this.cards = offers.map((_idx, i) => ({ a: 0, dy: 18, lift: 0, flash: 0, leave: 0, delay: i * 6 }));
    }

    /** Closed: the next phase deals a fresh hand even if it offers the same three. */
    close() {
        this.key = "";
    }

    /**
     * @param {number} ts - frames elapsed (the engine's own 60 fps step)
     * @param {Object} m - the model, see `draw`
     */
    update(ts, m) {
        this.t += ts;
        this.alpha += (0.88 - this.alpha) * 0.18 * ts;
        const hover = m.hover;
        for (let i = 0; i < this.cards.length; i++) {
            const c = this.cards[i];
            if (this.t > c.delay) {
                c.a += (1 - c.a) * 0.14 * ts;
                c.dy += (0 - c.dy) * 0.16 * ts;
            }
            c.lift += ((hover === i ? -3 : 0) - c.lift) * 0.25 * ts;
            if (c.flash > 0) {
                c.flash = Math.max(0, c.flash - 0.06 * ts);
            }
            if (m.picked != null && m.offers[i] !== m.picked) {
                c.leave = Math.min(1, c.leave + 0.055 * ts);
            }
        }
        if (m.picked != null && !this.flashed) {
            this.flashed = true;
            const i = m.offers.indexOf(m.picked);
            if (this.cards[i]) {
                this.cards[i].flash = 1;
            }
        }
    }

    /* ---------------------------------------------------------------- */
    /* Layout                                                            */
    /* ---------------------------------------------------------------- */

    /**
     * Every rect on the screen, measured at the live card width. The card
     * rects this returns are the same ones `draw` paints and the same ones the
     * engine hit-tests, which is the whole point: geometry is derived once.
     *
     * @param {CanvasRenderingContext2D} g
     * @param {Object} m - needs only `W`, `H` and `offers`, so the hit test can
     *  ask for it without building the rest of the model
     * @returns {Object} {floor, rail, pad, cards, build, bottom, titleY, ...}
     */
    layout(g, m) {
        const W = m.W;
        const H = m.H;
        const floor = W <= FLOOR_W;
        const rail = W >= RAIL_W;
        const pad = floor ? 14 : 24;
        const L = { W, H, floor, rail, pad };
        L.titleY = floor ? 26 : 40;
        L.titleSize = floor ? 16 : 24;
        L.bottomH = floor ? 40 : 52;
        const head = L.titleY + L.titleSize + (floor ? 22 : 30);
        let ax = pad;
        let aw = W - pad * 2;
        let ay = head;
        let ah = H - head - L.bottomH - pad;
        if (rail) {
            L.build = { x: pad, y: ay, w: RAIL_SIZE, h: ah, vertical: true };
            ax = pad + RAIL_SIZE + RAIL_GAP;
            aw = W - ax - pad;
        } else {
            L.build = { x: pad, y: ay, w: aw, h: floor ? 52 : 60, vertical: false };
            ay += L.build.h + (floor ? 14 : 20);
            ah = H - ay - L.bottomH - pad;
        }
        const gap = floor ? 10 : 20;
        const n = Math.max(1, m.offers.length);
        const cw = Math.max(CARD_MIN_W, Math.min(CARD_MAX_W, Math.floor((aw - gap * (n - 1)) / n)));
        const rowW = cw * n + gap * (n - 1);
        const x0 = ax + Math.floor((aw - rowW) / 2);
        // Levelled to the tallest of the three, then clamped both ways.
        let ch = 0;
        for (const idx of m.offers) {
            ch = Math.max(ch, this._cardH(g, PERKS[idx], cw, L));
        }
        ch = Math.min(Math.max(ch, floor ? CARD_MIN_H_FLOOR : CARD_MIN_H), Math.max(80, ah), CARD_MAX_H);
        const cy = ay + Math.floor((ah - ch) / 2);
        L.cards = m.offers.map((idx, i) => ({ idx, i, x: x0 + i * (cw + gap), y: cy, w: cw, h: ch }));
        L.bottom = { x: pad, y: H - L.bottomH, w: W - pad * 2, h: L.bottomH };
        return L;
    }

    /** The text blocks of one card, measured at this width. */
    _rows(g, perk, w, L) {
        const inner = w - CARD_PAD * 2;
        g.font = "600 " + (L.floor ? 13 : 15) + "px " + UI;
        const name = wrap(g, perk.name.toUpperCase(), inner);
        const keys = Object.keys(perk.mods || {}).filter((k) => MOD_VIEW[k] && perk.mods[k]).slice(0, 5);
        // 35 of the 50 perks in this game carry no modifiers at all, so a card
        // with no rows always keeps its sentence -- without it two thirds of
        // the catalogue would read as a name and a family and nothing else.
        g.font = "400 10px " + MONO;
        const note = !keys.length || perk.kind !== "passive" ? wrap(g, perk.desc || "", inner) : [];
        return { name, keys, note, inner };
    }

    _cardH(g, perk, w, L) {
        const r = this._rows(g, perk, w, L);
        const nameLH = L.floor ? 17 : 19;
        let h = CARD_PAD + CHIP_H + 10 + r.name.length * nameLH + CARD_PAD;
        h += r.keys.length * ROW_H + (r.keys.length ? 8 : 0);
        if (r.note.length) {
            h += r.note.length * NOTE_LH + 6;
        }
        return h + 8 + BAND_H;
    }

    /* ---------------------------------------------------------------- */
    /* Draw                                                              */
    /* ---------------------------------------------------------------- */

    /**
     * @param {CanvasRenderingContext2D} g
     * @param {Object} m - {W, H, wave, t, tMax, offers, picked, hover, timedOut,
     *   owned (perk objects), ownedIds, sums, bases, actives, chips, pending}
     * @param {Object} [L] - a layout already computed this frame
     */
    draw(g, m, L) {
        const lay = L || this.layout(g, m);
        const W = m.W;
        const H = m.H;
        g.save();
        g.textAlign = "left";
        g.textBaseline = "top";
        // Overshoot: this covers the letterbox and, when the camera is still
        // pulled back from a colossus, the margin around the arena.
        g.fillStyle = "rgba(4,6,12," + this.alpha.toFixed(3) + ")";
        g.fillRect(-W, -H, W * 3, H * 3);
        g.fillStyle = "rgba(0,0,0,0.16)";
        for (let y = 0; y < H; y += 3) {
            g.fillRect(0, y, W, 1);
        }

        g.textAlign = "center";
        g.fillStyle = FG;
        g.font = "600 " + lay.titleSize + "px " + UI;
        g.fillText("CHOOSE AN UPGRADE", Math.round(W / 2), lay.titleY);
        g.fillStyle = DIM;
        g.font = "400 " + (lay.floor ? 10 : 11) + "px " + MONO;
        g.fillText(
            "WAVE " + m.wave + " CLEARED  ·  KEEP 1 OF " + m.offers.length + " FOR THE REST OF THE RUN",
            Math.round(W / 2),
            lay.titleY + lay.titleSize + 8
        );
        g.textAlign = "left";

        this._drawBuild(g, lay, m);

        const dflt = 0;
        for (const r of lay.cards) {
            const a = this.cards[r.i] || { a: 1, dy: 0, lift: 0, flash: 0, leave: 0 };
            const rect = {
                x: r.x,
                y: Math.round(r.y + a.dy + a.lift + a.leave * 14),
                w: r.w,
                h: r.h,
            };
            g.globalAlpha = Math.max(0, a.a * (1 - a.leave * 0.85));
            this._drawCard(g, rect, PERKS[r.idx], r.i, lay, m, {
                hover: m.hover === r.i,
                sel: m.picked === r.idx,
                flash: a.flash,
                dflt: r.i === dflt,
            });
            g.globalAlpha = 1;
        }

        this._drawBottom(g, lay, m);
        g.restore();
    }

    _drawCard(g, r, perk, i, L, m, s) {
        const tint = perk.tint;
        const rows = this._rows(g, perk, r.w, L);
        const slack = Math.max(0, r.h - this._cardH(g, perk, r.w, L));
        const nameGap = CARD_PAD + Math.round(slack * SLACK_NAME);
        const rowExtra = rows.keys.length
            ? Math.min(SLACK_ROW_MAX, Math.round((slack * SLACK_ROWS) / rows.keys.length))
            : 0;
        const noteGap = Math.round(slack * SLACK_NOTE);
        const base = g.globalAlpha;

        g.fillStyle = "rgba(11,15,24,0.94)";
        g.fillRect(r.x, r.y, r.w, r.h);
        g.globalAlpha = base * (s.sel ? 0.1 : s.hover ? 0.06 : 0.03);
        g.fillStyle = tint;
        g.fillRect(r.x, r.y, r.w, r.h);
        // Border: rects rather than a stroke, so it lands on whole pixels at
        // every scale the arena can be blown up to.
        const bw = s.sel ? 2 : 1;
        g.globalAlpha = base * (s.sel ? 1 : s.hover ? 0.8 : 0.42);
        g.fillRect(r.x, r.y, r.w, bw);
        g.fillRect(r.x, r.y + r.h - bw, r.w, bw);
        g.fillRect(r.x, r.y, bw, r.h);
        g.fillRect(r.x + r.w - bw, r.y, bw, r.h);
        if (s.flash > 0) {
            g.globalAlpha = base * s.flash;
            g.fillRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
        }
        g.globalAlpha = base;

        const px = r.x + CARD_PAD;
        let y = r.y + CARD_PAD;
        // Key chip: the number you can press, on the card it presses.
        g.globalAlpha = base * (s.sel ? 1 : 0.8);
        if (s.sel) {
            g.fillStyle = tint;
            g.fillRect(px, y, CHIP_W, CHIP_H);
        } else {
            g.globalAlpha = base * 0.6;
            g.fillStyle = tint;
            g.fillRect(px, y, CHIP_W, 1);
            g.fillRect(px, y + CHIP_H - 1, CHIP_W, 1);
            g.fillRect(px, y, 1, CHIP_H);
            g.fillRect(px + CHIP_W - 1, y, 1, CHIP_H);
        }
        g.globalAlpha = base;
        g.font = "600 10px " + MONO;
        g.fillStyle = s.sel ? "#05070c" : tint;
        g.fillText(String(i + 1), px + 6, y + 3);
        g.textAlign = "right";
        g.font = "600 9px " + MONO;
        g.globalAlpha = base * 0.9;
        g.fillStyle = tint;
        g.fillText(
            perk.kind.toUpperCase() + " · " + perk.tag.toUpperCase(),
            r.x + r.w - CARD_PAD,
            y + 4
        );
        g.globalAlpha = base;
        g.textAlign = "left";
        y += CHIP_H + 10;

        const nameLH = L.floor ? 17 : 19;
        g.font = "600 " + (L.floor ? 13 : 15) + "px " + UI;
        g.fillStyle = FG;
        rows.name.forEach((line, k) => g.fillText(line, px, y + k * nameLH));
        y += rows.name.length * nameLH + nameGap;

        // The modifier rows: what it adds, and what the ship's number becomes.
        // A perk is granted the moment it is picked, so from that frame on its
        // own modifiers are already inside `sums`. Adding the delta again would
        // show the locked-in card promising twice what it gave.
        const has = m.ownedIds.indexOf(perk.id) >= 0;
        for (const k of rows.keys) {
            const owned = m.sums[k] || 0;
            const add = perk.mods[k];
            const stacks = Math.abs(owned - (has ? add : 0)) > 1e-6;
            g.font = "400 10px " + MONO;
            g.fillStyle = DIM;
            g.fillText(MOD_VIEW[k].label, px, y + 2);
            const total = "→ " + modTotal(k, m.bases[k] || 0, owned, has ? 0 : add);
            g.textAlign = "right";
            const dx = r.x + r.w - CARD_PAD;
            g.globalAlpha = base * 0.55;
            g.fillStyle = stacks ? tint : DIM;
            g.fillText(total, dx, y + 2);
            const tw = g.measureText(total).width;
            g.globalAlpha = base;
            g.font = "600 10px " + MONO;
            g.fillStyle = tint;
            g.fillText(modDelta(k, add), dx - tw - 8, y + 2);
            g.textAlign = "left";
            if (stacks) {
                // A stub against a modifier the ship already carries: this row
                // is not a new number, it is a bigger one.
                g.globalAlpha = base * 0.5;
                g.fillRect(px - 5, y + 3, 2, 8);
                g.globalAlpha = base;
            }
            y += ROW_H + rowExtra;
        }
        if (rows.keys.length) {
            y += 8 + noteGap;
        }
        if (rows.note.length) {
            g.font = "400 10px " + MONO;
            rows.note.forEach((line, k) => {
                g.globalAlpha = base * (perk.kind === "conditional" ? 0.85 : 0.72);
                g.fillStyle = perk.kind === "conditional" ? tint : "rgba(200,225,255,0.9)";
                g.fillText(line, px, y + k * NOTE_LH);
            });
            g.globalAlpha = base;
        }

        // The band, welded to the bottom edge. The right of it is built first
        // -- active slot pips, and the DEFAULT marker on the card the timeout
        // would take -- and the label on the left is then truncated to what is
        // actually left. The study caps it at 34 characters, which was measured
        // against its 304 px cards; at the 202 px a 16:9 arena gives, a full
        // "STACKS · OVERCLOCK, TWIN BARREL" ran straight through the marker.
        const by = r.y + r.h - BAND_H;
        dither(g, r.x + 8, by, r.w - 16, tint, base * 0.25);
        const bty = by + 11;
        g.font = "600 9px " + MONO;
        let right = r.x + r.w - CARD_PAD;
        if (perk.kind === "active" && !s.sel) {
            right -= MAX_ACTIVES * 8;
            this._pips(g, right, bty, m.actives, tint, base);
        }
        if (s.dflt && m.picked == null) {
            g.globalAlpha = base * (0.55 + 0.25 * Math.sin(this.t * 0.05));
            g.fillStyle = tint;
            g.textAlign = "right";
            g.fillText("DEFAULT", right - (right < r.x + r.w - CARD_PAD ? 8 : 0), bty);
            right -= g.measureText("DEFAULT").width + 8;
            g.textAlign = "left";
            g.globalAlpha = base;
        }
        const bandW = Math.max(20, right - px - 8);
        if (s.sel) {
            g.globalAlpha = base * 0.95;
            g.fillStyle = tint;
            g.fillText(m.timedOut ? "TAKEN BY TIMEOUT" : "LOCKED IN", px, bty);
            g.globalAlpha = base;
        } else if (perk.kind === "active") {
            g.globalAlpha = base * 0.85;
            g.fillStyle = tint;
            g.fillText(
                fit(g, "COOLDOWN " + (perk.cd || 600) + " FR · " + Math.round((perk.cd || 600) / 60) + " S", bandW),
                px,
                bty
            );
            g.globalAlpha = base;
        } else {
            const same = m.owned.filter((p) => p.tag === perk.tag).map((p) => p.name.toUpperCase());
            const shared = Object.keys(perk.mods || {}).filter(
                (k) => Math.abs((m.sums[k] || 0) - (has ? perk.mods[k] : 0)) > 1e-6
            ).length;
            let txt = same.length
                ? "STACKS · " + same.slice(0, 2).join(", ")
                : "NEW FAMILY · " + perk.tag.toUpperCase();
            if (!same.length && shared) {
                txt = "STACKS ON " + shared + " MODIFIER" + (shared > 1 ? "S" : "");
            }
            g.globalAlpha = base * (same.length || shared ? 0.85 : 0.5);
            g.fillStyle = same.length || shared ? tint : "rgba(180,210,255,0.8)";
            g.fillText(fit(g, txt, bandW), px, bty);
            g.globalAlpha = base;
        }

        // The fuse: the card that takes itself when the clock runs out says so,
        // on itself, for the whole twenty seconds rather than at the end. The
        // bar drains right to left along the bottom edge; the seconds are on
        // the bottom bar, where they are not competing for the band's width.
        if (s.dflt && m.picked == null) {
            const p = Math.max(0, Math.min(1, m.t / m.tMax));
            g.globalAlpha = base * 0.85;
            g.fillStyle = tint;
            g.fillRect(r.x + 1, r.y + r.h - 4, Math.round((r.w - 2) * (1 - p)), 3);
            g.globalAlpha = base;
        }
        if (s.sel) {
            g.globalAlpha = base * 0.9;
            g.fillStyle = tint;
            g.fillRect(r.x + 1, r.y + r.h - 4, r.w - 2, 3);
            g.globalAlpha = base;
        }
    }

    /** The four active slots, filled to `n`. */
    _pips(g, x, y, n, tint, base) {
        for (let k = 0; k < MAX_ACTIVES; k++) {
            g.globalAlpha = base * (k < n ? 0.9 : 0.3);
            g.fillStyle = k < n ? tint : "rgba(180,210,255,0.8)";
            g.fillRect(x + k * 8, y, 6, 8);
        }
        g.globalAlpha = base;
    }

    /**
     * What you already own, which is the context every delta on a card is read
     * against. A rail on a wide arena, a strip under the title otherwise.
     */
    _drawBuild(g, L, m) {
        const r = L.build;
        const counts = {};
        for (const p of m.owned) {
            counts[p.tag] = (counts[p.tag] || 0) + 1;
        }
        const fams = FAMILIES.filter((f) => counts[f]);
        g.font = "600 9px " + MONO;
        g.fillStyle = DIM;
        g.fillText("YOUR BUILD · " + m.owned.length + " PERK" + (m.owned.length === 1 ? "" : "S"), r.x, r.y);
        dither(g, r.x, r.y + 14, r.w, "#9db4cc", 0.3);
        if (!m.owned.length) {
            g.font = "400 9px " + MONO;
            g.fillStyle = DIMMER;
            g.fillText("FIRST UPGRADE OF THE RUN — NOTHING TO STACK WITH YET.", r.x, r.y + 24);
            return;
        }
        const sums = Object.keys(m.sums)
            .filter((k) => MOD_VIEW[k] && Math.abs(m.sums[k]) > 1e-6)
            .slice(0, r.vertical ? 8 : 4);
        if (r.vertical) {
            let y = r.y + 26;
            for (const f of fams) {
                g.fillStyle = FAMILY_TINT[f];
                g.fillRect(r.x, y + 2, 6, 6);
                g.font = "600 10px " + MONO;
                g.fillStyle = "rgba(234,246,255,0.85)";
                g.fillText(f.toUpperCase(), r.x + 12, y);
                for (let k = 0; k < counts[f]; k++) {
                    g.fillStyle = FAMILY_TINT[f];
                    g.fillRect(r.x + r.w - 6 - k * 6, y + 2, 4, 6);
                }
                y += 16;
            }
            y += 10;
            g.font = "600 9px " + MONO;
            g.fillStyle = DIM;
            g.fillText("ACTIVE SLOTS", r.x, y);
            for (let k = 0; k < MAX_ACTIVES; k++) {
                g.fillStyle = k < m.actives ? WARN : "rgba(180,210,255,0.25)";
                g.fillRect(r.x + r.w - 4 - (MAX_ACTIVES - k) * 12, y, 9, 8);
            }
            y += 20;
            g.font = "600 9px " + MONO;
            g.fillStyle = DIM;
            g.fillText("CURRENT TOTALS", r.x, y);
            y += 16;
            for (const k of sums) {
                g.font = "400 10px " + MONO;
                g.fillStyle = DIM;
                g.fillText(MOD_VIEW[k].label, r.x, y);
                g.textAlign = "right";
                g.font = "600 10px " + MONO;
                g.fillStyle = FG;
                g.fillText(modTotal(k, m.bases[k] || 0, m.sums[k], 0), r.x + r.w, y);
                g.textAlign = "left";
                y += 15;
            }
            return;
        }
        let x = r.x;
        const y = r.y + 24;
        for (const f of fams) {
            const label = f.toUpperCase() + " x" + counts[f];
            g.font = "600 10px " + MONO;
            const w = g.measureText(label).width + 20;
            g.globalAlpha *= 0.14;
            g.fillStyle = FAMILY_TINT[f];
            g.fillRect(x, y, w, 16);
            g.globalAlpha /= 0.14;
            g.fillStyle = FAMILY_TINT[f];
            g.fillRect(x + 6, y + 6, 4, 4);
            g.fillText(label, x + 14, y + 4);
            x += w + 6;
        }
        g.font = "600 10px " + MONO;
        g.fillStyle = DIM;
        g.fillText("ACTIVES", x + 6, y + 4);
        const ax = x + 6 + g.measureText("ACTIVES").width + 8;
        for (let k = 0; k < MAX_ACTIVES; k++) {
            g.fillStyle = k < m.actives ? WARN : "rgba(180,210,255,0.25)";
            g.fillRect(ax + k * 10, y + 4, 7, 8);
        }
        let sx = r.x;
        const sy = y + 22;
        for (const k of sums) {
            g.font = "400 10px " + MONO;
            g.fillStyle = DIM;
            const t = MOD_VIEW[k].label + " " + modTotal(k, m.bases[k] || 0, m.sums[k], 0);
            g.fillText(t, sx, sy);
            sx += g.measureText(t).width + 16;
        }
    }

    _drawBottom(g, L, m) {
        const r = L.bottom;
        const p = Math.max(0, Math.min(1, m.t / m.tMax));
        g.fillStyle = "rgba(180,210,255,0.14)";
        g.fillRect(r.x, r.y + 4, r.w, 2);
        g.globalAlpha = 0.8;
        g.fillStyle = m.t < 300 ? WARN : "#5ee1ff";
        g.fillRect(r.x, r.y + 4, Math.round(r.w * p), 2);
        g.globalAlpha = 1;
        g.font = "600 10px " + MONO;
        let msg;
        let col = "rgba(180,210,255,0.7)";
        if (m.picked == null) {
            msg =
                "CLICK A CARD OR PRESS 1 / " + m.offers.length + " · " +
                Math.max(0, Math.ceil(m.t / 60)) + " S";
        } else if (m.pending) {
            msg = "WAITING FOR " + m.pending + " PLAYER" + (m.pending > 1 ? "S" : "") +
                " · " + Math.max(0, Math.ceil(m.t / 60)) + " S";
        } else {
            msg = "ALL PICKED · RESUMING";
            col = OK;
        }
        g.globalAlpha = 0.65 + 0.3 * Math.sin(this.t * 0.045);
        g.fillStyle = col;
        g.fillText(msg, r.x, r.y + 16);
        g.globalAlpha = 1;
        if (m.chips.length > 1) {
            g.textAlign = "right";
            let x = r.x + r.w;
            for (let i = m.chips.length - 1; i >= 0; i--) {
                const c = m.chips[i];
                const label = c.label + (c.me ? " YOU" : "") + (c.picked ? " ✓" : " …");
                g.font = "600 10px " + MONO;
                const w = g.measureText(label).width;
                g.globalAlpha = c.picked ? 1 : 0.45;
                g.fillStyle = c.picked ? OK : "rgba(180,210,255,0.9)";
                g.fillText(label, x, r.y + 16);
                g.globalAlpha = 1;
                x -= w + 14;
            }
            g.textAlign = "left";
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Word wrap at the current font. The caller sets it; this only measures. */
function wrap(g, text, maxW) {
    const words = String(text || "").split(" ");
    const out = [];
    let line = "";
    for (const word of words) {
        const next = line ? line + " " + word : word;
        if (g.measureText(next).width > maxW && line) {
            out.push(line);
            line = word;
        } else {
            line = next;
        }
    }
    if (line) {
        out.push(line);
    }
    return out;
}

/** Trim text to a width at the current font, with an ellipsis if it had to. */
function fit(g, text, maxW) {
    let t = String(text);
    if (g.measureText(t).width <= maxW) {
        return t;
    }
    while (t.length > 1 && g.measureText(t + "…").width > maxW) {
        t = t.slice(0, -1);
    }
    return t + "…";
}

/** A 1-in-2 dotted rule: the separator the rest of this screen is built from. */
function dither(g, x, y, w, color, alpha) {
    const prev = g.globalAlpha;
    g.globalAlpha = alpha;
    g.fillStyle = color;
    for (let i = 0; i < w; i += 2) {
        g.fillRect(x + i, y, 1, 1);
    }
    g.globalAlpha = prev;
}
