/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - flight and combat animation for the 5 regular bosses.
 *
 * Ported from the "Bullet-hell boss animator" design study (`boss-animator.js`),
 * which arrived already respecting the render-only contract. Three deliberate
 * departures from it:
 *
 *   1. **The hulls stay the module's.** The study shipped its own character
 *      grids for all five bosses, but `boss0..boss4` already exist in
 *      `sprites.js`, tinted per catalogue and wired into the chassis variant,
 *      the hit flash and the glossary. Replacing them would be an art swap, not
 *      an animation. The animator is handed a sprite name and draws that.
 *   2. **No lance beam.** The engine already owns the LANCER beam: it
 *      telegraphes it (`warn` frames), damages with it and ships it in the
 *      snapshot as `bm`. Drawing a second one would show a beam where the
 *      hitbox is not.
 *   3. **No hit flash and no death dissolve.** `e.flash` already paints the
 *      white silhouette and travels as `f`; and a dissolve would need the
 *      corpse to outlive `killEnemy`, which is gameplay, not cosmetics.
 *
 * Everything is **render only**: the engine (or, on a guest, the host snapshot)
 * owns position, hit points, armour and every bullet. This reads state that
 * already travels and derives the rest from observed motion, so host and guest
 * animate the same fight with no new bytes on the bus.
 *
 * State cannot live on the enemy object: a guest rebuilds `this.enemies` from
 * scratch on every snapshot, so the engine keeps these animators in a map keyed
 * by boss index and feeds them (see `_updateBossAnims`).
 *
 * -------------------------------------------------------------------------
 * WARDEN STUDY v2 port (2026-08-29)
 * -------------------------------------------------------------------------
 * What the study replaces, and why each one was worth replacing:
 *
 *   - **The ring was lying.** It drew a gap rotating at a constant 0.95 rad/s
 *     while the attack put its hole at `e.gap`, an x position that jumped 151
 *     px a volley. Measured over 472,629 armoured frames, the drawn gap pointed
 *     inside the real 132 px hole 23.5% of the time -- against 23.6% for
 *     pointing at random. The most eye-catching thing on the boss carried
 *     exactly no information, and `_drawTelegraph` was separately drawing the
 *     true corridor, so two gap indicators were on screen and one was noise.
 *     The ring now rotates while the hull has NO committed heading and locks
 *     onto the one it does: rotation means "no target yet", locked means
 *     "committed", and the hull leaves through the aperture it locked.
 *   - **The curtain was the colossus' pattern.** AEGIS opens a shutter over the
 *     hole it is about to leave; a regular boss doing the same competed with
 *     it. The armoured phase is a ram now (`WARDEN_RAM` in `game_engine.js`).
 *   - **The floating ARMOUR UP/DOWN caption** is gone. Two silhouette-scale
 *     events (plate travel, ring build/collapse) and a colour event (vent seam,
 *     core) fire on the same frame; the caption was restating them in words.
 *   - **The exposed core was static.** It is a drain column now: the hurt
 *     window has a clock on the hull, six cells for the enraged window against
 *     five for the normal one, so the phase change is visible rather than felt.
 *
 * Four departures from the sheet, all deliberate:
 *
 *   1. **Two plates, not four.** The sheet draws four corner plates from its
 *      own art. `bossPlate` is the module's, one per side, and the plates-last
 *      death reads with two. Swapping the art would be an art change.
 *   2. **A spent drain cell falls back to the ART, not to rung 1.** The sheet
 *      demotes it to near-black. Expressing "spent" as a demotion below the
 *      sprite is the mistake VULCAN's port already paid for: it turns the hull
 *      into a gauge and the boss stops looking like its own glossary card.
 *      Lit cells are promoted, spent cells are simply the hull as painted, and
 *      the read -- a bright column shrinking -- is identical.
 *   3. **The hull is one cached raster.** The sheet paints 261 cells a frame.
 *      `drawSprite` gives one `drawImage`, and the effects repaint only the
 *      cells they actually change (the rim on a raise, the seam, the column).
 *   4. **The heading travels.** The sheet derives it from observed motion and
 *      needs a 30-frame cooldown to stop the return trip after a lunge reading
 *      as a fresh wind-up. `ca`/`cs` are two optional fields on the wire, only
 *      present for the 74 frames a ram lasts, and the ring locks on the first
 *      wind-up frame instead of the twelfth.
 */

import {
    RAMP_CHARS, RUNG, drawSprite, palette, rungFold, sprite, spriteGrid, spriteSize,
} from "./sprites";

/** Top of the sprite bank's brightness ramp. */
const TOP = RAMP_CHARS.length - 1;

/**
 * Pull a cell a fraction of the way to white (or, negative, back towards the
 * dark hull). The same function `colossus_animator.js` promotes with: counting
 * rungs would land differently on every cell an effect crosses.
 */
const lift = (rung, k) => (k >= 0 ? rung + (TOP - rung) * k : rung * (1 + k));

/** Hull cells that make up WARDEN's core window: glass and hot white. */
const CORE_CHARS = "70";

/**
 * The darkest rung the hardening sweep is allowed to touch. Rungs 0 and 1 are
 * the dark hull and the dark accent, and the second of those is magenta on
 * every hull in the bank -- an effect that walks the outline upwards paints a
 * neon border round a teal boss.
 */
const RIM_MIN_RUNG = 2;

/**
 * WARDEN's death, frame by frame. Exported because `game_engine.js` needs the
 * total to size the corpse's lifetime, and one number in two files drifts.
 */
export const WARDEN_DEATH = {
    frames: 78,     // corpse lifetime, 1.30 s
    collapse: 24,   // hull collapses inward over frames 0..24
    hold: 42,       // the plates hold formation alone until here
    flare: 8,       // core flare, frames 0..8
    cellDelay: 6,   // per-cell delay in the collapse, x radial distance
    cellTravel: 12, // frames a cell takes to reach the centre
    dimEvery: 9,    // frames per rung the falling plates dim
};

const wardenGeo = new Map();

/**
 * WARDEN's hull, read off the art rather than hand-counted -- the same rule
 * `hullGeometry` follows in `colossus_animator.js`, so retouching `boss1` moves
 * the effects with it instead of leaving them pointing at old cells.
 *
 * What it finds on `boss1` (48 x 22 cells):
 *   - `rim`   the outermost band of PLATING -- cells painted in a real hull
 *             colour that touch either the outside or the dark outline. The
 *             outline itself is deliberately not in it: promoting the darkest
 *             rung moves it to the bank's dark accent, which is magenta, so
 *             lighting the silhouette turned a teal hull into a magenta-edged
 *             one. Rendered and looked at; it does not survive a look.
 *   - `core`  the glass-and-white window, dead centre, rows 6..14.
 *   - `drain` the window clock's six cells. Two hull rows each and six columns
 *             wide, centred on the core box: 12 x 24 logical px, the size the
 *             sheet asks for, and it divides evenly so no cell is a half.
 *   - `seam`  the row the vent opens along, and how wide.
 *
 * @param {string} name key in the sprite bank
 */
function wardenGeometry(name) {
    let geo = wardenGeo.get(name);
    if (geo) {
        return geo;
    }
    const grid = spriteGrid(name);
    const rows = grid.length;
    const cols = rows ? grid[0].length : 0;
    const cells = new Int8Array(cols * rows).fill(-1);
    const used = new Uint8Array(TOP + 1);
    const rim = [];
    const core = [];
    let c0 = cols;
    let c1 = -1;
    let r0 = rows;
    let r1 = -1;
    const at = (c, r) => (c < 0 || r < 0 || c >= cols || r >= rows ? "." : grid[r][c]);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const ch = grid[r][c];
            if (ch === ".") {
                continue;
            }
            const rung = RUNG[ch];
            cells[r * cols + c] = rung;
            used[rung] = 1;
            // Plating only, and only where it meets the outside or the dark
            // outline: this is the shell, not the silhouette.
            if (rung >= RIM_MIN_RUNG) {
                const edge = [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dc, dr]) => {
                    const nb = at(c + dc, r + dr);
                    return nb === "." || RUNG[nb] < RIM_MIN_RUNG;
                });
                if (edge) {
                    rim.push(c, r);
                }
            }
            if (CORE_CHARS.indexOf(ch) >= 0) {
                core.push(c, r);
                if (c < c0) { c0 = c; }
                if (c > c1) { c1 = c; }
                if (r < r0) { r0 = r; }
                if (r > r1) { r1 = r; }
            }
        }
    }
    const midC = c1 >= c0 ? (c0 + c1 + 1) / 2 : cols / 2;
    const midR = r1 >= r0 ? (r0 + r1 + 1) / 2 : rows / 2;
    // The window clock. The sheet draws it as a 6-cell column inside the core,
    // which assumes a core with somewhere to go: `boss1`'s is a HOT WHITE
    // diamond sitting at the very top of the ramp with a ring of glass one rung
    // under it, so a column drawn there would repaint nothing at all in its
    // middle rows -- the same no-headroom trap the kamikaze's core taught the
    // fry kit. So the clock goes where the hull has room for it, on the tint
    // plating: the row below the core with the longest continuous run of cells
    // that are at least three rungs off white, cut into six pips.
    const pipRow = bestPipRow(cells, cols, rows, Math.round(r1 + 1));
    const drain = pipRow && {
        r: pipRow.r,
        // Two rows tall wherever the row below has headroom across the same
        // span. One row is 2 logical px on a 44 px hull, which is legible as a
        // change and not as a count -- and a gauge you cannot count is a wash.
        h: pipRowDeep(cells, cols, rows, pipRow) ? 2 : 1,
        c0: pipRow.c0,
        span: pipRow.c1 - pipRow.c0 + 1,
        cells: 6,
    };
    geo = {
        cols, rows, cells, rim, core, midC, midR,
        // A promotion may only land on a colour the hull is actually painted
        // with. `boss1` uses seven of the nine rungs and the two it skips are
        // tint shades, which always belong, so this comes back as the identity
        // -- but the next hull to answer to this code may not be so tidy.
        rungs: rungFold(used),
        coreBox: c1 >= c0 ? { c0, c1, r0, r1 } : null,
        drain,
        seam: { r: Math.round(midR), c0: Math.round(cols * 0.06), c1: Math.round(cols * 0.94) },
    };
    wardenGeo.set(name, geo);
    return geo;
}

/**
 * The row a segmented gauge can actually be drawn on: the longest continuous
 * run of cells with real headroom (rung <= 5, i.e. three steps off white), from
 * `from` downwards. On `boss1` this lands on row 15, twenty-nine cells of flat
 * tint under the core window.
 *
 * Promoting a cell that is already at the top of the ramp repaints nothing, so
 * "where does this effect have room to be seen" is a question about the art and
 * has to be answered from it.
 */
function pipRowDeep(cells, cols, rows, row) {
    const r = row.r + 1;
    if (r >= rows) {
        return false;
    }
    let ok = 0;
    for (let c = row.c0; c <= row.c1; c++) {
        const rung = cells[r * cols + c];
        if (rung >= 0 && rung <= 5) {
            ok++;
        }
    }
    return ok > (row.c1 - row.c0) * 0.8;
}

function bestPipRow(cells, cols, rows, from) {
    let best = null;
    for (let r = Math.max(0, from); r < rows; r++) {
        let c0 = -1;
        for (let c = 0; c <= cols; c++) {
            const rung = c < cols ? cells[r * cols + c] : -1;
            const ok = rung >= 0 && rung <= 5;
            if (ok && c0 < 0) {
                c0 = c;
            } else if (!ok && c0 >= 0) {
                if (!best || c - c0 > best.c1 - best.c0 + 1) {
                    best = { r, c0, c1: c - 1 };
                }
                c0 = -1;
            }
        }
    }
    return best;
}

/**
 * Reference speeds are **read off the real AI** in `_updateBoss`, not carried
 * over from the study (its 1280-wide canvas made every one of them saturate
 * instantly at this scale). At 60 fps, 1 px per frame = 60 px/s:
 *
 *   DREADNOUGHT  x = W/2 + sin(t*0.016) * W*0.32   -> peak 0.32*680*0.016 ≈ 209 px/s
 *   WARDEN       x += sin(t*0.011) * 1.5           -> peak 90 px/s
 *   HIVE         x += sin(t*0.008) * 1.1           -> peak 66 px/s
 *   LANCER       dive vy = 7, hover |dx| <= 2.2    -> 420 px/s down, 132 across
 */
export const BOSS_ANIM = {
    global: {
        smoothing: 12,          // 1/s, exponential ease for boolean -> 0..1
        lowHpThreshold: 0.30,   // hp01 under which the damage shake starts
        lowHpShake: 2.4,        // px of shake at hp01 = 0
        lowHpShakeHz: 14,
        maxEffects: 48,         // hard cap on cosmetic effects
        // A step bigger than this is a teleport, not flight. For PRISM that is
        // the signal itself; for everyone else it is a guard.
        teleportPx: 60,
    },

    DREADNOUGHT: {
        swayRefSpeed: 180,      // px/s at which the lean saturates
        maxLean: 0.12,          // rad (~7 deg)
        breathHz: 0.55,
        breathAmp: 0.018,
        coreGlowHz: 1.15,
        coreGlowAmp: 0.35,
        thrusterHz: 11,
        thrusterLen: 12,        // px
        burstRingSpeed: 260,    // px/s outward
        burstRingLife: 0.45,    // s
        burstRingWidth: 4,      // px
        salvoFlashLife: 0.14,   // s
        salvoFlashLen: 22,      // px
        recoilPx: 5,            // px
        recoilTime: 0.18,       // s
    },

    WARDEN: {
        armourTravel: 26,       // px each plate slides out when the armour drops
        armourTime: 0.34,       // s for a full raise or drop
        transFrames: 20,        // frames of a raise or drop (= armourTime at 60 fps)
        plateStagger: 3,        // frames between the two plates
        clampBite: 1,           // px the plate overshoots past flush on a raise
        clampFrom: 0.75,        // ...over the last quarter of the travel
        hardenFrames: 6,        // rim promoted this long on a raise
        // Fractions of the way to white, and both were re-measured against the
        // rungs they actually land on rather than carried over: the plating is
        // tint (rung 5 of 8), so anything under 1/6 moves it nowhere at all and
        // 0.55 is what buys the two clean steps a hardening flash needs.
        hardenLift: 0.55,
        ventFrames: 6,          // the vent seam opens over this long on a drop
        ventLift: 0.85,
        // The ring. It rotates while the hull has no committed heading and
        // locks onto the one it does -- so the rotation is information now,
        // and the aperture is the hole the hull leaves through.
        ringSpin: 0.95,         // rad/s
        ringBlocks: 28,
        ringNodePx: 4,          // px block size
        ringRx: 0.78,           // of the hull's own width
        ringRy: 0.92,           // of the hull's own height
        ringGapBlocks: 3.5,     // half-aperture, so 7 blocks
        ringGapLunge: 2,        // extra half-blocks while the hull comes through
        ringLockTime: 0.20,     // s to swing the aperture onto the heading
        ringReleaseTime: 0.33,  // s to let it go again
        ringPulseHz: 1.6,
        ringAppear: 8,          // frames the ring builds outward from the gap
        ringVanish: 6,
        // The window clock: one pip goes out per `drainSlice` frames, so the
        // enraged window shows six where the normal one shows five.
        drainSlice: 52,
        drainLift: 0.72,
        drainStutter: 30,       // final frames: the last pip stutters
        windowNormal: 260,      // frames the hurt window lasts (mirrors _bossWarden)
        windowRaged: 300,
        exposedPulseHz: 3.2,    // core pulse through the hurt window
        exposedPulseFast: 6.4,  // ...doubled over the last `drainStutter`
        coreLift: 0.55,
        coreRadius: 0.42,       // of the hull's half-width
        // How much flatter than a circle the core glow is. Measured, not
        // chosen: at 1.6 the glow reached the gauge row and washed 14 of its
        // cells every frame, so the pips scaled correctly and could not be
        // counted. At 2.8 the glow stays on the core's own rows.
        coreSquash: 2.8,
        lungeHeat: 0.25,        // rim promotion while the hull is coming through
        trailEvery: 2,          // frames between trail samples while lunging
        trailDrain: 3,          // frames per sample dropped once it stops
        trailMax: 8,
        trailPx: 8,             // leading block size
        fanFlashLife: 0.16,     // s
        breathHz: 0.4,
        breathAmp: 0.012,
        recoilPx: 3,
        recoilTime: 0.16,
    },

    LANCER: {
        chargeTime: 0.85,       // s the telegraph takes to fill
        diveRefSpeed: 420,      // px/s at which the dive stretch saturates
        diveStretchMax: 1.30,
        diveEnter: 210,         // px/s of downward speed that counts as diving
        afterimageEvery: 0.035, // s between trail samples
        afterimageLife: 0.22,   // s
        afterimageAlpha: 0.40,
        afterimageMax: 8,
        tiltRefSpeed: 180,      // px/s
        maxTilt: 0.22,          // rad (~13 deg)
    },

    HIVE: {
        bayTime: 0.26,          // s to open or close a door
        bayOpenHold: 0.34,      // s the doors stay open after a launch
        bayTravel: 5,           // px each door slides
        bayFlareLife: 0.25,     // s
        bayFlareLen: 16,        // px
        bobAmp: 3.2,            // px
        bobHz: 0.34,
        rimLights: 5,
        rimCycle: 1.7,          // s for one chase along the rim
        hullRollRef: 66,        // px/s
        maxRoll: 0.07,          // rad
        hangarGlowHz: 0.8,
    },

    PRISM: {
        blinkOutTime: 0.10,     // s of collapse (the engine teleports instantly,
                                //  so this plays on arrival, not before)
        blinkInTime: 0.16,      // s to materialise
        blinkScaleMin: 0.15,
        shockSpeed: 420,        // px/s
        shockLife: 0.55,        // s
        shockWidth: 5,          // px
        shockStartR: 30,        // px
        spiralArms: 3,
        spiralSpin: 2.2,        // rad/s
        spiralLength: 78,       // px measured from the centre
        spiralNodePx: 4,
        spiralNodeStep: 9,      // px between blocks along an arm
        spiralCurl: 1.5,        // rad of curl over the arm
        facetSpin: 0.85,        // rad/s
        coreGlowHz: 2.1,
        coreGlowAmp: 0.4,
    },
};

/** Tuning key per BOSSES index — the array order is wire format, so is this. */
export const BOSS_ANIM_KINDS = ["DREADNOUGHT", "WARDEN", "LANCER", "HIVE", "PRISM"];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const ease = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));

/** Pixel-quantised block, so the overlays land on the sprite's own grid. */
function pxRect(g, x, y, w, h, cell) {
    g.fillRect(
        Math.round(x / cell) * cell,
        Math.round(y / cell) * cell,
        Math.max(cell, Math.round(w / cell) * cell),
        Math.max(cell, Math.round(h / cell) * cell)
    );
}

/** Ring of blocks, optionally only over the arc [from, to]. */
function pxRing(g, cx, cy, r, blockPx, cell, from, to) {
    const a0 = from === undefined ? 0 : from;
    const a1 = to === undefined ? Math.PI * 2 : to;
    const steps = Math.max(8, Math.round(((a1 - a0) * r) / (blockPx * 0.85)));
    for (let i = 0; i < steps; i++) {
        const a = a0 + (a1 - a0) * (i / steps);
        pxRect(g, cx + Math.cos(a) * r - blockPx / 2, cy + Math.sin(a) * r - blockPx / 2,
            blockPx, blockPx, cell);
    }
}

export class BossAnimator {
    /**
     * @param {number} k index into BOSSES (same order as BOSS_ANIM_KINDS)
     * @param {string} tint the boss colour from the catalogue
     */
    constructor(k, tint) {
        this.k = k;
        this.kind = BOSS_ANIM_KINDS[k] || BOSS_ANIM_KINDS[0];
        this.t = BOSS_ANIM[this.kind];
        this.g0 = BOSS_ANIM.global;
        this.tint = tint;
        this.effects = [];
        this.time = 0;
        this.x = null;
        this.y = null;
        this.vx = 0;
        this.vy = 0;
        this.lean = 0;
        this.breath = 0;
        this.shield01 = 0;
        this.charge01 = 0;
        this.bay01 = 0;
        this.bayHold = 0;
        this.stretch = 1;
        this.spin = 0;
        this.facet = 0;
        this.blink = 1;
        this.recoil = 0;
        this.shake = 0;
        this.lastAim = Math.PI / 2;
        this._trailT = 0;
        // --- WARDEN ------------------------------------------------------
        // `armor` starts null so the first frame it is observed counts as a
        // transition: the ring then builds in as the hull slides on screen
        // instead of snapping into existence complete.
        this.armor = null;
        this.transF = 0;
        this.window = 0;
        this.head = Math.PI / 2;
        this.lock = 0;
        this.lunging = false;
        this.trail = [];
        this._trailD = 0;
        this.ramp = null;
    }

    /**
     * Advance the cosmetics from state the engine already owns.
     *
     * @param {number} dt seconds
     * @param {Object} s read-only view of the boss: x, y, hp01, armor, charging
     */
    observe(dt, s) {
        if (!(dt > 0)) {
            return this;
        }
        if (dt > 0.1) {
            dt = 0.1;
        }
        const t = this.t;
        const g = this.g0;
        this.time += dt;
        this.recoil = Math.max(0, this.recoil - dt / (t.recoilTime || 0.18));

        // --- observed motion: the engine moves bosses by writing x/y, so there
        // --- is no velocity to read. Deriving it works the same on a guest.
        let jumped = false;
        if (this.x === null) {
            this.x = s.x;
            this.y = s.y;
        } else {
            const dx = s.x - this.x;
            const dy = s.y - this.y;
            this.x = s.x;
            this.y = s.y;
            if (Math.abs(dx) > g.teleportPx || Math.abs(dy) > g.teleportPx) {
                jumped = true;
                this.vx = 0;
                this.vy = 0;
            } else {
                this.vx = dx / dt;
                this.vy = dy / dt;
            }
        }

        const hp01 = clamp01(s.hp01 == null ? 1 : s.hp01);
        const dmg = hp01 >= g.lowHpThreshold ? 0 : 1 - hp01 / g.lowHpThreshold;
        this.shake = dmg * g.lowHpShake;

        switch (this.kind) {
            case "DREADNOUGHT":
                this.lean = ease(this.lean,
                    clamp(this.vx / t.swayRefSpeed, -1, 1) * t.maxLean, g.smoothing, dt);
                this.breath = Math.sin(this.time * 6.2832 * t.breathHz);
                break;
            case "WARDEN": {
                this.shield01 = ease(this.shield01, s.armor ? 1 : 0, 3 / t.armourTime, dt);
                this.breath = Math.sin(this.time * 6.2832 * t.breathHz);
                const f = dt * 60;
                // Frames since the armour last flipped. The whole transition --
                // plate travel, hardening sweep, vent seam, ring build -- is
                // staged off this one counter rather than off the eased shield
                // level: a stage that starts "when shield01 crosses 0.8" lands
                // on a different frame for a guest, whose snapshots arrive at
                // ~15 Hz, while the flip itself travels as `ar`.
                if (!!s.armor !== this.armor) {
                    this.armor = !!s.armor;
                    this.transF = 0;
                } else if (this.transF < 900) {
                    this.transF += f;
                }
                // The hurt window's clock. `e.phase` does not travel, but the
                // flip that starts it does and both lengths are known, so
                // counting from the flip gives a guest the same gauge with
                // nothing new on the wire. A snapshot arriving up to four
                // frames late is invisible against a 52-frame pip.
                this.window = s.raged ? t.windowRaged : t.windowNormal;
                this.spin = (this.spin + t.ringSpin * dt) % 6.2832;
                // 0 idle / 1 wind-up / 2 lunge / 3 recover. Only the first two
                // are a commitment: the recover is the hull going home and the
                // aperture should already be releasing by then.
                const committed = s.charge === 1 || s.charge === 2;
                if (committed) {
                    this.head = s.head;
                }
                this.lock = clamp01(this.lock
                    + (committed ? dt / t.ringLockTime : -dt / t.ringReleaseTime));
                this.lunging = s.charge === 2;
                if (this.lunging) {
                    this._trailT += f;
                    while (this._trailT >= t.trailEvery) {
                        this._trailT -= t.trailEvery;
                        this.trail.unshift({ x: s.x, y: s.y });
                        if (this.trail.length > t.trailMax) {
                            this.trail.pop();
                        }
                    }
                } else {
                    this._trailT = 0;
                    this._trailD += f;
                    while (this._trailD >= t.trailDrain && this.trail.length) {
                        this._trailD -= t.trailDrain;
                        this.trail.pop();
                    }
                }
                break;
            }
            case "LANCER": {
                // `charging` is read off the beam the engine already owns, so it
                // is true on a guest too: beams travel in the snapshot.
                this.charge01 = ease(this.charge01, s.charging ? 1 : 0, 3 / t.chargeTime, dt);
                this.lean = ease(this.lean,
                    clamp(this.vx / t.tiltRefSpeed, -1, 1) * t.maxTilt, g.smoothing, dt);
                const diving = this.vy > t.diveEnter;
                this.stretch = ease(this.stretch,
                    1 + clamp01(Math.abs(this.vy) / t.diveRefSpeed) * (t.diveStretchMax - 1),
                    14, dt);
                if (diving) {
                    this._trailT += dt;
                    while (this._trailT >= t.afterimageEvery) {
                        this._trailT -= t.afterimageEvery;
                        let n = 0;
                        for (const e of this.effects) {
                            if (e.type === "trail") {
                                n++;
                            }
                        }
                        if (n < t.afterimageMax) {
                            this._push({
                                type: "trail", x: s.x, y: s.y, sy: this.stretch,
                                life: t.afterimageLife, max: t.afterimageLife,
                            });
                        }
                    }
                } else {
                    this._trailT = 0;
                }
                break;
            }
            case "HIVE":
                // The doors are held open by the launch cue, then close again.
                this.bayHold = Math.max(0, this.bayHold - dt);
                this.bay01 = ease(this.bay01, this.bayHold > 0 ? 1 : 0, 3 / t.bayTime, dt);
                this.lean = ease(this.lean,
                    clamp(this.vx / t.hullRollRef, -1, 1) * t.maxRoll, g.smoothing, dt);
                this.breath = Math.sin(this.time * 6.2832 * t.bobHz);
                break;
            case "PRISM":
                this.spin = (this.spin + t.spiralSpin * dt) % 6.2832;
                this.facet = (this.facet - t.facetSpin * dt) % 6.2832;
                // The engine teleports in a single frame, so the collapse cannot
                // play before the jump: the jump *is* the cue, and what plays is
                // the materialisation at the new position.
                if (jumped) {
                    // Hold the pinch fully closed for this frame. Easing away
                    // from 0 in the same call never lets the hull get below ~0.38
                    // scale, and the collapse is the whole point of a blink.
                    this.blink = 0;
                } else {
                    this.blink = ease(this.blink, 1, 3 / t.blinkInTime, dt);
                }
                break;
        }

        for (let i = this.effects.length - 1; i >= 0; i--) {
            const e = this.effects[i];
            e.life -= dt;
            if (e.speed) {
                e.r += e.speed * dt;
            }
            if (e.life <= 0) {
                this.effects.splice(i, 1);
            }
        }
        return this;
    }

    _push(e) {
        if (this.effects.length >= this.g0.maxEffects) {
            this.effects.shift();
        }
        this.effects.push(e);
    }

    /**
     * A cosmetic cue for something the engine just did. On the host these are
     * called from the boss AI; they reach a guest through the existing `ev`
     * event channel, which is what that channel is for. Deriving them from the
     * AI's own arithmetic instead (`floor(e.t) % 85 === 0`) would desync the
     * animation the first time anyone retunes a boss.
     *
     * @param {string} name burst | salvo | launch | blink
     * @param {Object} [d] payload: {a} aim angle, {x, y} departure point
     */
    emit(name, d) {
        const t = this.t;
        const o = d || {};
        if (name === "burst" && this.kind === "DREADNOUGHT") {
            this._push({
                type: "ring", r: this.halfW || 40, life: t.burstRingLife,
                max: t.burstRingLife, speed: t.burstRingSpeed, w: t.burstRingWidth,
            });
        } else if (name === "salvo") {
            const a = typeof o.a === "number" ? o.a : this.lastAim;
            this.lastAim = a;
            this.recoil = 1;
            const life = t.fanFlashLife || t.salvoFlashLife;
            this._push({ type: "muzzle", a, life, max: life });
        } else if (name === "launch" && this.kind === "HIVE") {
            // `c` is the bay offset as a fraction of the half-width, straight
            // from the AI (`off / e.r`), so the flare lands on the door that
            // actually opened instead of a fixed slot.
            this.bayHold = t.bayOpenHold;
            this._push({
                type: "bay", c: clamp(o.c == null ? 0 : o.c, -1, 1),
                life: t.bayFlareLife, max: t.bayFlareLife,
            });
        } else if (name === "blink" && this.kind === "PRISM") {
            this._push({
                type: "shock", x: o.x, y: o.y, r: t.shockStartR,
                life: t.shockLife, max: t.shockLife, speed: t.shockSpeed, w: t.shockWidth,
            });
        }
    }

    /** Cosmetic offsets around the engine-owned position. */
    pose() {
        const t = this.t;
        const sh = this.shake
            ? Math.sin(this.time * 6.2832 * this.g0.lowHpShakeHz) * this.shake
            : 0;
        let ox = sh;
        let oy = sh * 0.6;
        let sx = 1;
        let sy = 1;
        if (this.kind === "DREADNOUGHT" || this.kind === "WARDEN") {
            const b = 1 + this.breath * t.breathAmp;
            sx = b;
            sy = b;
            ox -= this.recoil * t.recoilPx * Math.cos(this.lastAim);
            oy -= this.recoil * t.recoilPx * Math.sin(this.lastAim);
        } else if (this.kind === "LANCER") {
            sy = this.stretch;
            sx = 1 / this.stretch;
        } else if (this.kind === "HIVE") {
            oy += this.breath * t.bobAmp;
        } else if (this.kind === "PRISM") {
            const b = t.blinkScaleMin + (1 - t.blinkScaleMin) * this.blink;
            sx = b;
            sy = b;
        }
        const alpha = this.kind === "PRISM" ? 0.15 + 0.85 * this.blink : 1;
        return { ox, oy, rot: this.lean, sx, sy, alpha };
    }

    /**
     * Draw the boss. The caller has NOT translated: everything here works in
     * arena coordinates, because half the effects sit at their own positions.
     *
     * @param {CanvasRenderingContext2D} g
     * @param {Object} o
     * @param {string} o.sprite hull name in the sprite bank
     * @param {number} o.px logical pixel size the engine draws the hull at
     * @param {number} o.x engine-owned centre — authoritative, so a cue that
     *   created this animator before the first `observe` still draws correctly
     * @param {number} o.y
     * @param {boolean} o.flash the engine's own hit flash
     */
    draw(g, o) {
        const size = spriteSize(o.sprite);
        if (!size.w) {
            return;
        }
        this.x = o.x;
        this.y = o.y;
        const cell = Math.max(1, Math.round(o.px));
        const w = size.w * o.px;
        const h = size.h * o.px;
        this.halfW = w / 2;
        const p = this.pose();

        g.save();
        g.imageSmoothingEnabled = false;
        this._behind(g, o, cell, w, h);

        if (p.alpha > 0.01) {
            g.save();
            g.globalAlpha = p.alpha;
            g.translate(this.x + p.ox, this.y + p.oy);
            g.rotate(p.rot);
            g.scale(p.sx, p.sy);
            if (this.kind === "WARDEN") {
                this._plates(g, cell, w, -1);
                this._plates(g, cell, w, 1);
            }
            drawSprite(g, o.sprite, 0, 0, { tint: this.tint, px: o.px, flash: o.flash });
            this._core(g, cell);
            if (this.kind === "WARDEN" && !o.flash) {
                // Skipped on the hit flash: the silhouette is white that frame
                // and a promotion has nothing left to promote.
                this._wardenHull(g, o);
            }
            g.restore();
        }

        this._front(g, o, cell, w, h);
        g.restore();
    }

    /* ---------------- effects under the hull ---------------- */

    _behind(g, o, cell, w, h) {
        const t = this.t;
        // LANCER dive afterimages.
        for (const e of this.effects) {
            if (e.type !== "trail") {
                continue;
            }
            const k = e.life / e.max;
            g.save();
            g.globalAlpha = t.afterimageAlpha * k * k;
            g.translate(e.x, e.y);
            g.scale(1 / e.sy, e.sy);
            drawSprite(g, o.sprite, 0, 0, { tint: this.tint, px: o.px });
            g.restore();
        }
        if (this.kind === "PRISM") {
            this._spiral(g, cell, w);
        }
        if (this.kind === "WARDEN") {
            this._trail(g, cell);
            this._ring(g, cell, w, h);
        }
    }

    /* ---------------- effects over the hull ---------------- */

    _front(g, o, cell, w, h) {
        const t = this.t;
        for (const e of this.effects) {
            const k = clamp01(e.life / e.max);
            g.save();
            g.globalCompositeOperation = "lighter";
            g.fillStyle = this.tint;
            if (e.type === "ring") {
                g.globalAlpha = k * 0.9;
                pxRing(g, this.x, this.y, e.r, e.w, cell);
            } else if (e.type === "shock") {
                g.globalAlpha = k * k * 0.85;
                pxRing(g, e.x, e.y, e.r, e.w, cell);
                g.globalAlpha = k * k * 0.35;
                pxRing(g, e.x, e.y, e.r * 0.7, Math.max(cell, e.w - cell), cell);
            } else if (e.type === "muzzle") {
                const len = (t.salvoFlashLen || 20) * (0.4 + 0.6 * k);
                g.globalAlpha = k;
                // The spread mirrors what the AI actually fires: a triple for the
                // dreadnought, a five-shot fan for the warden.
                const spread = this.kind === "WARDEN"
                    ? [-0.34, -0.17, 0, 0.17, 0.34]
                    : [-0.22, 0, 0.22];
                const r0 = w * 0.34;
                for (const off of spread) {
                    const a = e.a + off;
                    for (let d = r0; d < r0 + len; d += cell) {
                        pxRect(g, this.x + Math.cos(a) * d - cell,
                            this.y + Math.sin(a) * d - cell, cell * 2, cell * 2, cell);
                    }
                }
            } else if (e.type === "bay") {
                const bx = this.x + (w / 2) * e.c;
                const by = this.y + cell * 3;
                g.globalAlpha = k;
                for (let d = 0; d < t.bayFlareLen * k; d += cell) {
                    pxRect(g, bx - cell, by + d, cell * 2, cell * 2, cell);
                }
            }
            g.restore();
        }
        if (this.kind === "DREADNOUGHT") {
            this._thrusters(g, cell, w);
        }
        if (this.kind === "HIVE") {
            this._rimLights(g, cell, w);
        }
    }

    /* ---------------- per-boss pieces ---------------- */

    /** Core glow, drawn in the hull's own transform. */
    _core(g, cell) {
        const t = this.t;
        let glow = 0;
        if (this.kind === "DREADNOUGHT" || this.kind === "PRISM") {
            glow = 0.5 + 0.5 * Math.sin(this.time * 6.2832 * t.coreGlowHz) * t.coreGlowAmp;
        } else if (this.kind === "LANCER") {
            glow = this.charge01 * 0.8;
        } else if (this.kind === "HIVE") {
            glow = 0.25 + 0.25 * Math.sin(this.time * 6.2832 * t.hangarGlowHz);
        }
        if (glow <= 0.01) {
            return;
        }
        g.save();
        g.globalCompositeOperation = "lighter";
        g.fillStyle = this.tint;
        const r = cell * 3;
        g.globalAlpha = clamp01(glow) * 0.55;
        pxRect(g, -r, -r, r * 2, r * 2, cell);
        g.globalAlpha = clamp01(glow) * 0.3;
        pxRect(g, -r * 1.7, -r * 1.7, r * 3.4, r * 3.4, cell);
        g.restore();
    }

    /**
     * WARDEN armour plate. Staggered so the two do not read as one piece, eased
     * out, and with a 1 px bite past flush at the end of a raise: a clamp
     * closing overshoots and settles, it does not glide to a stop.
     */
    _plates(g, cell, w, side) {
        const t = this.t;
        const cv = sprite("bossPlate", this.tint, cell, false);
        if (!cv) {
            return;
        }
        const k = clamp01((this.transF - (side < 0 ? 0 : t.plateStagger)) / t.transFrames);
        const e = 1 - (1 - k) * (1 - k);
        let out = this.armor ? t.armourTravel * (1 - e) : t.armourTravel * e;
        if (this.armor && k > t.clampFrom && k < 1) {
            out = -t.clampBite;
        }
        g.save();
        g.globalAlpha = this.armor ? 1 : 0.35 + 0.65 * (1 - e);
        g.drawImage(cv, side * (w * 0.3 + out) - cv.width / 2, -cv.height / 2);
        g.restore();
    }

    /**
     * WARDEN's ring. The gap used to rotate at a constant rate while the real
     * hole in the attack was somewhere else entirely; it now says what the hull
     * is doing. Rotating = no committed heading. Locked = committed, and the
     * aperture points where the hull is about to go. Widening = it is coming
     * through, now.
     */
    _ring(g, cell, w, h) {
        const t = this.t;
        const appear = this.armor
            ? Math.min(1, this.transF / t.ringAppear)
            : 1 - Math.min(1, this.transF / t.ringVanish);
        if (appear <= 0) {
            return;
        }
        const N = t.ringBlocks;
        const step = 6.2832 / N;
        const rx = w * t.ringRx;
        const ry = h * t.ringRy;
        let centre = this.spin;
        if (this.lock > 0) {
            let d = this.head - this.spin;
            while (d > Math.PI) { d -= 6.2832; }
            while (d < -Math.PI) { d += 6.2832; }
            centre = this.spin + d * this.lock;
        }
        const gapHalf = step * (t.ringGapBlocks + (this.lunging ? t.ringGapLunge : 0));
        const pulse = Math.sin(this.time * 6.2832 * t.ringPulseHz) > 0 ? 1 : 0;
        g.save();
        g.globalCompositeOperation = "lighter";
        for (let i = 0; i < N; i++) {
            const a = i * step;
            let d = a - centre;
            while (d > Math.PI) { d -= 6.2832; }
            while (d < -Math.PI) { d += 6.2832; }
            const ad = Math.abs(d);
            if (ad < gapHalf) {
                continue;
            }
            // The ring builds outward FROM the gap, so what appears first is
            // the edge of the hole rather than a circle closing on the hull.
            if (ad / Math.PI > appear) {
                continue;
            }
            // The blocks either side of the aperture are its brackets, and they
            // sharpen as the lock completes: a locked gap has hard edges, a
            // rotating one does not, so the two states differ at a glance even
            // in a still frame.
            const edge = ad < gapHalf + step * 1.5 * (0.4 + 0.6 * this.lock);
            g.globalAlpha = edge ? 0.95 : 0.42 + 0.28 * pulse;
            g.fillStyle = edge ? "#ffffff" : this.tint;
            pxRect(g, this.x + Math.cos(a) * rx - t.ringNodePx / 2,
                this.y + Math.sin(a) * ry - t.ringNodePx / 2,
                t.ringNodePx, t.ringNodePx, cell);
            if (edge) {
                g.globalAlpha = 0.7;
                g.fillStyle = this.tint;
                pxRect(g, this.x + Math.cos(a) * rx * 1.16 - 1,
                    this.y + Math.sin(a) * ry * 1.16 - 1, 2, 2, cell);
            }
        }
        g.restore();
    }

    /** The lunge trail: where the hull has just been, draining once it stops. */
    _trail(g, cell) {
        const t = this.t;
        if (!this.trail.length) {
            return;
        }
        g.save();
        g.globalCompositeOperation = "lighter";
        g.fillStyle = this.tint;
        for (let i = 0; i < this.trail.length; i++) {
            const p = this.trail[i];
            const sz = t.trailPx - i;
            if (sz <= 1) {
                continue;
            }
            g.globalAlpha = 0.5 * (1 - i / t.trailMax);
            pxRect(g, p.x - sz / 2, p.y - sz / 2, sz, sz, cell);
        }
        g.restore();
    }

    /**
     * Repaint one hull cell `k` of the way up the ramp, in the hull's own
     * transform. Nothing is drawn when the promotion lands on the rung the cell
     * already has, which is most of why this is affordable -- and also why the
     * effects above were placed by asking the art where it has headroom.
     *
     * The arithmetic mirrors the rasterizer's exactly (`Math.round` on the
     * cell origin, `Math.ceil` on the size, and the canvas top-left rounded the
     * way `drawSprite` rounds it). An overlay that computes its own rounding
     * lands a pixel off the cells it means to light, which reads as a smear
     * along one edge of every effect and passes any test that only counts cells.
     */
    _promoteCell(g, geo, o, c, r, k) {
        if (c < 0 || r < 0 || c >= geo.cols || r >= geo.rows) {
            return;
        }
        const rung = geo.cells[r * geo.cols + c];
        if (rung < 0) {
            return;
        }
        const to = geo.rungs[clamp(Math.round(lift(rung, k)), 0, TOP)];
        if (to === rung) {
            return;
        }
        g.fillStyle = this.ramp[to];
        g.fillRect(o.ox + Math.round(c * o.px), o.oy + Math.round(r * o.px), o.sz, o.sz);
    }

    /**
     * Everything WARDEN says on its own plating: the hardening sweep as the
     * armour clamps shut, the vent seam as it opens, the core through the hurt
     * window and the window's own clock.
     *
     * All of it is promotion along the sprite bank's ramp over the cached
     * raster -- one `drawImage` for the hull, then only the cells an effect
     * actually changes.
     */
    _wardenHull(g, o) {
        const t = this.t;
        const geo = wardenGeometry(o.sprite);
        if (!geo.cols) {
            return;
        }
        if (!this.ramp) {
            const pal = palette(this.tint);
            this.ramp = RAMP_CHARS.map((ch) => pal[ch]);
        }
        const px = o.px;
        const f = {
            px,
            sz: Math.ceil(px),
            ox: Math.round(-Math.round(geo.cols * px) / 2),
            oy: Math.round(-Math.round(geo.rows * px) / 2),
        };

        // The clamp: the outer hull hardens as the armour comes up, and the
        // same rim carries the heat while the hull is coming through a lunge.
        let rimK = 0;
        if (this.armor && this.transF < t.hardenFrames) {
            rimK = t.hardenLift * (1 - this.transF / t.hardenFrames);
        }
        if (this.lunging) {
            rimK = Math.max(rimK, t.lungeHeat);
        }
        if (rimK > 0) {
            for (let i = 0; i < geo.rim.length; i += 2) {
                this._promoteCell(g, geo, f, geo.rim[i], geo.rim[i + 1], rimK);
            }
        }

        if (this.armor) {
            return;
        }

        // The vent: a seam opening across the hull on the frame the armour
        // drops. It is a silhouette-scale event on a colour event's budget --
        // one row of cells -- and it is what replaces the caption.
        if (this.transF < t.ventFrames) {
            const grow = Math.min(1, this.transF / t.ventFrames);
            const half = ((geo.seam.c1 - geo.seam.c0) / 2) * grow;
            const mid = (geo.seam.c0 + geo.seam.c1) / 2;
            for (let c = Math.round(mid - half); c <= Math.round(mid + half); c++) {
                this._promoteCell(g, geo, f, c, geo.seam.r, t.ventLift);
            }
        }

        // The core, through the hurt window. The white middle is already at the
        // top of the ramp and takes no part; what lights is the glass ring
        // around it and the plating past that, so the eye reads as opening
        // rather than as a lamp switching on.
        const left = Math.max(0, this.window - this.transF);
        const fast = left < t.drainStutter;
        const hz = fast ? t.exposedPulseFast : t.exposedPulseHz;
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 6.2832 * hz);
        const rad = geo.cols * t.coreRadius * 0.5;
        const c0 = Math.max(0, Math.floor(geo.midC - rad));
        const c1 = Math.min(geo.cols - 1, Math.ceil(geo.midC + rad));
        const r0 = Math.max(0, Math.floor(geo.midR - rad));
        const r1 = Math.min(geo.rows - 1, Math.ceil(geo.midR + rad));
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                const d = Math.hypot(c - geo.midC, (r - geo.midR) * t.coreSquash) / rad;
                if (d > 1) {
                    continue;
                }
                this._promoteCell(g, geo, f, c, r, t.coreLift * pulse * (1 - d * 0.7));
            }
        }

        // The window clock. One pip per `drainSlice` frames left, so the
        // enraged window opens with six where the normal one opens with five --
        // the phase change becomes something you can read off the hull instead
        // of something you feel.
        const d = geo.drain;
        if (!d) {
            return;
        }
        const lit = Math.max(0, Math.min(d.cells, Math.ceil(left / t.drainSlice)));
        const stutter = fast && Math.floor(this.time * 60) % 5 < 2;
        for (let i = 0; i < lit; i++) {
            const k = t.drainLift * (0.7 + 0.3 * pulse)
                * (i === lit - 1 && stutter ? 0.3 : 1);
            const a = d.c0 + Math.round((i * d.span) / d.cells);
            const b = d.c0 + Math.round(((i + 1) * d.span) / d.cells) - 2;
            for (let rr = d.r; rr < d.r + d.h; rr++) {
                for (let c = a; c <= b; c++) {
                    this._promoteCell(g, geo, f, c, rr, k);
                }
            }
        }
    }

    /** PRISM: three curling arms of blocks, counter-spun by `facet`. */
    _spiral(g, cell, w) {
        const t = this.t;
        if (this.blink < 0.05) {
            return;
        }
        const r0 = w * 0.4;
        g.save();
        g.globalCompositeOperation = "lighter";
        g.fillStyle = this.tint;
        for (let arm = 0; arm < t.spiralArms; arm++) {
            const base = this.spin + (arm / t.spiralArms) * 6.2832;
            for (let d = r0; d < r0 + t.spiralLength; d += t.spiralNodeStep) {
                const k = (d - r0) / t.spiralLength;
                const a = base + k * t.spiralCurl;
                g.globalAlpha = this.blink * (0.95 - 0.55 * k);
                const sz = t.spiralNodePx * (1 - 0.35 * k);
                pxRect(g, this.x + Math.cos(a) * d - sz / 2,
                    this.y + Math.sin(a) * d - sz / 2, sz, sz, cell);
            }
        }
        g.restore();
    }

    /** DREADNOUGHT: two rear plumes. Bosses face +Y, so they sit above it. */
    _thrusters(g, cell, w) {
        const t = this.t;
        const f = 0.55 + 0.45 * Math.sin(this.time * 6.2832 * t.thrusterHz);
        const len = t.thrusterLen * f;
        g.save();
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = 0.8;
        g.fillStyle = this.tint;
        for (const s of [-0.38, 0.38]) {
            for (let d = 0; d < len; d += cell) {
                const pw = cell * (2 - d / Math.max(len, 1));
                pxRect(g, this.x + (w / 2) * s - pw / 2, this.y - w * 0.34 - d, pw, cell, cell);
            }
        }
        g.restore();
    }

    /** HIVE: a light chasing along the rim, so the carrier reads as powered. */
    _rimLights(g, cell, w) {
        const t = this.t;
        const half = w / 2;
        const phase = (this.time % t.rimCycle) / t.rimCycle;
        g.save();
        g.globalCompositeOperation = "lighter";
        g.fillStyle = this.tint;
        const n = t.rimLights * 2;
        for (let i = 0; i < n; i++) {
            const u = i / (n - 1);
            const lx = this.x - half * 0.86 + u * half * 1.72;
            const ly = this.y + cell * 1.5 + Math.abs(u - 0.5) * cell * 3
                + this.bay01 * t.bayTravel;
            const k = (u + phase) % 1;
            g.globalAlpha = 0.25 + 0.75 * Math.pow(1 - Math.abs(k - 0.5) * 2, 3);
            pxRect(g, lx - cell / 2, ly, cell, cell, cell);
        }
        g.restore();
    }
}

/**
 * WARDEN's corpse, drawn from the wreck record `killEnemy` pushed and its own
 * age. A pure function of the two, so a guest that only ever receives the kill
 * cue draws the same death as the host.
 *
 * The order is the whole point of it, and it is the one thing this animator
 * needed the engine's help for: the hull collapses inward over 24 frames, and
 * then the two plates HOLD FORMATION alone for eighteen more before they fall.
 * A boss that simply stops existing on the frame its points reach zero has no
 * such beat, which is why the corpse has to outlive `killEnemy`.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {Object} w wreck record: `{name, x, y, t, tint, px, armor}`
 */
export function drawBossWreck(g, w) {
    const D = WARDEN_DEATH;
    const geo = wardenGeometry(w.name);
    if (!geo.cols) {
        return;
    }
    const f = w.t;
    const px = w.px;
    const sz = Math.ceil(px);
    const pal = palette(w.tint);
    const ramp = RAMP_CHARS.map((ch) => pal[ch]);
    const ox = Math.round(w.x) + Math.round(-Math.round(geo.cols * px) / 2);
    const oy = Math.round(w.y) + Math.round(-Math.round(geo.rows * px) / 2);
    g.save();
    g.imageSmoothingEnabled = false;

    // 1. The hull, folding in on itself. Per-cell, and affordable because it is
    //    24 frames once per boss: the alternative is baking 24 frames of a
    //    96x44 hull for a corpse that is on screen for a second.
    if (f < D.collapse) {
        const half = Math.hypot(geo.cols, geo.rows) / 2;
        for (let r = 0; r < geo.rows; r++) {
            for (let c = 0; c < geo.cols; c++) {
                const rung = geo.cells[r * geo.cols + c];
                if (rung < 0) {
                    continue;
                }
                const dc = c - geo.cols / 2;
                const dr = r - geo.rows / 2;
                // Cells further from the centre have further to fall, so the
                // hull closes from the outside in rather than shrinking.
                const delay = (Math.hypot(dc, dr) / half) * D.cellDelay;
                const k = clamp01((f - delay) / D.cellTravel);
                if (k >= 1) {
                    continue;
                }
                const to = f < D.flare
                    ? TOP
                    : geo.rungs[clamp(Math.round(lift(rung, -k * 0.8)), 0, TOP)];
                g.fillStyle = ramp[to];
                g.fillRect(
                    ox + Math.round((c - dc * k) * px),
                    oy + Math.round((r - dr * k) * px),
                    sz, sz
                );
            }
        }
        if (f < D.flare) {
            g.fillStyle = "#ffffff";
            const fr = (1 - f / D.flare) * geo.cols * px * 0.22;
            g.fillRect(Math.round(w.x - fr), Math.round(w.y - fr),
                Math.round(fr * 2), Math.round(fr * 2));
        }
    }

    // 2. The plates. They hold where the hull left them, then let go.
    const cv = sprite("bossPlate", w.tint, Math.max(1, Math.round(px)), false);
    if (cv) {
        const hw = geo.cols * px * 0.3;
        for (const side of [-1, 1]) {
            let x = w.x + side * hw;
            let y = w.y;
            let dim = 0;
            let shear = 0;
            if (f > D.hold) {
                const a = f - D.hold;
                const k = a / 60;
                x += side * 0.42 * a;
                y += -20 * k + 300 * k * k;
                dim = Math.floor(a / D.dimEvery);
                shear = Math.min(3, Math.floor(a / D.dimEvery));
            } else if (f > D.collapse) {
                // One px inward: unlatched, not yet falling.
                x -= side;
            }
            if (dim > 4) {
                continue;
            }
            g.save();
            g.globalAlpha = Math.max(0, 1 - dim / 5);
            // Baked shear rather than a rotation: turning a 6x12 pixel plate
            // by a matrix only costs it its pixels (the DRONE-B lesson), and a
            // shear of 0 lays it back exactly where the sprite painted it.
            g.transform(1, 0, shear * 0.18 * side, 1, Math.round(x), Math.round(y));
            g.drawImage(cv, -cv.width / 2, -cv.height / 2);
            g.restore();
        }
    }
    g.restore();
}

/* =============================================================================
 * DERIVED SIGNAL RANGES — so thresholds can be checked without running Odoo.
 * Re-measured against this engine's AI, not the design study's canvas.
 *
 *   lean       DREADNOUGHT ±0.12 rad, saturates at 180 px/s (AI peaks at 209)
 *              LANCER      ±0.22 rad, saturates at 180 px/s (hover peaks at 132)
 *              HIVE        ±0.07 rad, saturates at  66 px/s (AI peaks at  66)
 *   breath     -1..1 sine; ±1.8% scale (DREADNOUGHT), ±1.2% (WARDEN)
 *   stretch    LANCER 1.00 hovering, 1.30 cap; the dive runs at 420 px/s
 *   shield01   0..1, 95% of a transition in ~0.34 s
 *   charge01   0..1, ~0.85 s to 95% while the engine's beam is telegraphing
 *   bay01      0..1, opens in ~0.26 s, held 0.34 s per launch
 *   blink      0..1, reset to 0 on a detected teleport, back to 1 in ~0.16 s
 *   shake      0 while hp01 >= 0.30, rising to 2.4 px at hp01 = 0
 *   recoil     0..1 over 0.18 s; peak hull offset 5 px (3 for WARDEN)
 *   effects    <= 12 in normal play; hard cap 48
 * ========================================================================== */
