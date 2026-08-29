/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - SPEEDY / TANK / SNIPER / KAMIKAZE animation kit (RENDER side).
 *
 * Ported from the "FRY Study" design sheet. Its one idea, and the reason every
 * number below follows from it:
 *
 *   These are ships. They move by burning fuel, not by moving their parts.
 *
 * So the hull is *rigid* -- nothing on it ever moves relative to anything else
 * -- it *turns as a body* through baked yaw steps, and at rest the only thing
 * that animates is *the burn*: a two-`fillRect` plume on the thrust axis plus a
 * one-cell integer translate of the `drawImage` along that axis on the burn
 * frame. No shear, no roll, no legs, no sway. What separates the four is what
 * their engines are doing:
 *
 *   SPEEDY    one hard burn. A dart with a painted exhaust plug gets a single
 *             hot centre flame stuttering at 10 Hz; a delta with a plain wide
 *             tail gets a slower pair of outboard nozzles. It leans into the
 *             direction it is actually flying.
 *   TANK      one heavy sustained burn at 3 Hz, the widest and dimmest of the
 *             four -- a freighter engine holding a mass down rather than
 *             pushing it. When it is about to fire it *throttles down to steady
 *             the shot* and yaws at whoever it is aiming at: the hull going
 *             quiet is half the telegraph.
 *   SNIPER    station keeping. It is not travelling, it is holding a position,
 *             so it runs no main engine: one side thruster puffs, then the
 *             other, while the hull drifts slowly off vertical and back. The
 *             tell is that *the thrusters cut* -- the hull goes dead still,
 *             unpowered, before the sight line arrives.
 *   KAMIKAZE  there is no idle. It is under continuous full thrust from spawn,
 *             the plume says how hard it is burning and the core throb says how
 *             close it is.
 *
 * And death starts with a flame-out: the plume is gone on the first frame and
 * gutters as a single cell twice, so the hull is falling unpowered before it
 * breaks.
 *
 * What the port had to move, and why (the study's own harness is not this
 * engine, and it says so):
 *
 *   THE HULLS ARE THE MODULE'S. The study ships its own six grids; the sprite
 *      bank's are the ones on screen. Every piece of geometry is therefore read
 *      out of `sprites.js` art at bake time (`geometryOf`) rather than counted
 *      by hand -- and the art answered every question the sheet asks:
 *      `speedy0` paints a four-cell plug of dark tint at its tail (one centre
 *      nozzle) where `speedy1` has a plain six-cell tail (two outboard ones),
 *      `sniper0`'s side thrusters are the accent lamps already painted on its
 *      lower corners and its cannon is the four rows the silhouette narrows to,
 *      `kami0`'s core is the block of hot white in its middle. Retouch a sprite
 *      and the animation follows it.
 *   THE YAW IS THE FLIGHT PATH. The sheet steers a SPEEDY off
 *      `clamp((shipX - x) / 40)`, which against a 680 px arena is pinned at the
 *      stop essentially always. The engine already has the two numbers that
 *      matter -- the lateral velocity it is applying and the speed it is
 *      falling at -- so the hull simply points where it is *going*. Measured
 *      over three waves, that spreads across all five steps at wave 1
 *      (6/29/20/36/9%) and narrows as the hull falls faster, which is true.
 *   THE LADDER, NOT THE RAMP. An effect brightens a cell by walking it along
 *      the rungs *this hull is painted with* (`geo.ladder`), not the bank's
 *      nine. Both animators before this one folded an unused rung onto the
 *      nearest used one after the fact, which silently turns a step into a
 *      no-op: `speedy1` uses no metal, so demoting its tint by one rung folded
 *      straight back onto the tint and the whole first tier of wear repainted
 *      nothing. Stepping along the ladder means every step repaints.
 *   THE STUDY'S BARREL HAS NO ART. Its TANK B yaws a cannon barrel; neither
 *      `tank0` nor `tank1` has one, so both take the hull-yaw tell. The muzzle
 *      bead went with it, and it was redundant anyway -- the engine already
 *      draws the aimed sight line for `telK === "aimed"`. What is left is the
 *      part with art behind it: the recoil kick and a muzzle flash on the hull
 *      edge the shot actually leaves from.
 *
 * Pure and deterministic, like the drone kit: no `Math.random`, no rAF, no
 * timers, no window access, no per-instance state and no animator object (there
 * can be a dozen speedies on screen). Time only enters as the enemy's own frame
 * clock `e.t`, which the engine seeds per hull and advances with `mv`, so pause
 * freezes this, slow-mo slows it and an EMP `stun` stops it dead. Everything
 * sampled -- `t`, `hp`/`mhp`, `flash`, `v`, `rot`, `aim`, `tel`, the wave and
 * the synchronised ship positions -- either travels in the snapshot already or
 * is derived from something that does, so a guest draws the host's frame.
 *
 * Cost, per living hull, against the drone's 1 `drawImage` + <= 2 `fillRect`:
 * 1 `drawImage` + 2 `fillRect` at rest and never more than 2. The plume owns
 * both cells and every tell is built by *reallocating* them, not by adding a
 * third: TANK throttles to one plume cell and spends the other on the recoil
 * flash, SNIPER's charge bead takes the cell its second puff was using, and the
 * hit flash spends none at all (the silhouette replaces everything).
 */

import { RAMP_CHARS, RUNG, palette, rungFold, spriteGrid, trimCanvas } from "./sprites";

const TOP = RAMP_CHARS.length - 1;
/** The index the sprite bank paints the neon accent with (lamps, thrusters). */
const ACCENT_CHAR = "8";
/** The index the eyes are painted with. */
const GLASS_CHAR = "7";
/** The index the hull itself is painted with. */
const TINT_CHAR = "4";
/** The shade an artist recesses an exhaust with: the tail plug is made of it. */
const DARK_TINT_CHAR = "5";
/** The top of the ramp: a hull's hot core, and the one thing wear may not touch. */
const WHITE_CHAR = "0";

export const FRY_ANIM = {
    /** One yaw step. Every hull turns as a body, in whole steps of this. */
    yawStep: Math.PI / 16,          // 11.25 degrees

    speedy: {
        // The AI's own two numbers, read from here by `_updateEnemies` so the
        // pose is sampled from exactly what produces the motion: a second copy
        // would point the lean the wrong way the first time either is retuned.
        steer: 0.006,               // lateral px/frame per px of offset
        fall: [3, 0.08],            // px/frame, base + per wave
        yawSteps: 2,                // +-2 steps = +-22.5 degrees
        // The two chassis, told apart by their tails and not by their names.
        // `speedy0` recesses its exhaust in dark tint, so its flame is focused:
        // narrow, bright, and stuttering at 10 Hz. `speedy1`'s tail is a flush
        // plate, so its burn is broad: wider, longer, dimmer, and half the
        // rhythm. One hot single flame against one slow soft one.
        focused: { burn: 3, len: [2, 3], wid: 2, alpha: [0.5, 0.9] },
        broad: { burn: 5, len: [3, 4], wid: 3, alpha: [0.42, 0.75] },
    },

    tank: {
        // 20 frames, 50% duty: three beats a second, the slowest of the four.
        burn: 20,
        plumeLen: [2, 3],
        plumeWid: 3,                // the widest and the dimmest
        alpha: [0.42, 0.72],
        // The telegraph is the engine's own `tel` ramp (45 frames of a 150
        // frame cycle, measured). The hull yaws a step at half of it and the
        // eyes come up in two: `at whom` as well as `when`.
        yawAt: 0.5,
        eyeAt: [0.5, 0.85],
        // Throttled down to steady the shot: one guttering 3x1 cell.
        idleAlpha: 0.3,
        recoil: 3,                  // frames of kick and muzzle flash
    },

    sniper: {
        // Its own drift, straight off the AI (`sin(e.t * rate)`), so the lean
        // is the direction it is actually sliding.
        drift: 0.02,                // rad per frame: a 314 frame cycle
        puff: 24,                   // frames one side thruster holds
        pulse: 12,                  // frames lit within that
        alpha: [0.4, 0.7],
        // The charge, over the AI's 70 frame `aim`. Five stages, which collapse
        // to three distinct cannon promotions.
        charge: 70,
        stages: [0, 0, 1, 1, 2],
        // The tell: the thrusters cut and the hull pins straight.
        cutAt: 60,
        cutAlpha: 0.18,
        beadAt: 50,                 // where the travelling bead grows to 2 cells
    },

    kami: {
        // The AI's acceleration, read from here by `_updateEnemies`. The
        // throttle is derived from the clock rather than from a speed the
        // snapshot does not carry: `v = v0 + accel * t`, capped, which the two
        // roles compute identically because `tt` travels.
        v0: 1.2,
        accel: 0.09,
        cap: [3.4, 0.06],           // px/frame, base + per wave
        yawSteps: 16,               // 22.5 degrees: its facing is its whole read
        throb: [20, 12],            // frames per cycle, at rest and at the cap
        boostAt: 0.75,              // throttle above which the core takes a 2nd rung
        plumeOff: 0,                // cells past the hull edge the trail starts
        plumeLen: [2, 4.3],         // cells, base + per unit of throttle
        alpha: [0.4, 0.45],
    },

    /**
     * Wear. Tier from the fraction of hull left, and per tier the share of the
     * plating that is demoted along the ladder. It is a hashed subset of the
     * cells, not a region, so a worn hull reads as pitted rather than as a
     * shape that changed -- and the hash is of the *cell*, so it needs no state
     * and every hull of a type wears identically on both roles.
     *
     * One ramp per type, because a tier means a different thing to each. A TANK
     * at wave 1 has mhp 4, so its tiers are exactly hp 4/3/2/1 -- one tier per
     * hit, and it is the only hull a player watches wear down step by step, so
     * its ramp is the gentlest. A SPEEDY is the opposite: mhp 1 until wave 10
     * (tier 0 only, one shot kills it), and at mhp 2 the only fractions are 1.0
     * and 0.5 -- and 0.5 is not greater than 0.50, so it lands on tier 0 and
     * *tier 2*, which is therefore the wear state it is actually seen in for
     * twenty waves before any other. Its ramp is loaded there.
     */
    wear: {
        tiers: [0.75, 0.5, 0.25],   // fractions of hull left, tier 0 above the first
        speedy: [0.3, 0.8, 0.9],
        tank: [0.18, 0.4, 0.66],
        sniper: [0.24, 0.48, 0.74],
        kami: [0.26, 0.52, 0.78],
        // Tiers that may take a hull cell down two rungs instead of one, and
        // the share of the worn cells that get it.
        deepFrom: { speedy: 2, tank: 3, sniper: 3, kami: 3 },
        deepShare: 0.4,
    },

    /**
     * Death. Every one of them opens with the flame-out -- the plume is already
     * gone and gutters as a single cell -- so the hull is falling unpowered
     * before it comes apart. Distances are in hull cells and times are
     * fractions of the animation, so retuning `frames` cannot make a corpse
     * travel further.
     */
    death: {
        gutter: [3, 9],             // frames the guttering cell is drawn on
        speedy: {
            frames: 30, flash: 5, split: 6,
            spreadCells: 5, dropCells: 11, spin: 0.35,
            sparks: 2, sparkCells: 7, drainFrom: 0.8,
        },
        tank: {
            frames: 46, flash: 7, crush: 16, split: 18,
            squash: [0.85, 0.7], riseCells: 4, dropCells: 7, rollCells: 2,
            debris: 4, debrisCells: 9, drainFrom: 0.45,
        },
        sniper: {
            frames: 38, flash: 5, eyesOut: 7, split: 10,
            cannonCells: 13, convCells: 3.5, dropCells: 6, drainFrom: 0.4,
        },
        kami: {
            // It detonates: the flame-out and the detonation are the same
            // event, so it is the shortest of the four and leaves no corpse.
            frames: 22, flash: 4, core: 10,
            squash: 1.25, coreLift: 4, ringCells: 9, ringSize: 3,
        },
    },
};

/* ------------------------------------------------------------------ */
/* Geometry: everything read out of the art, once per hull             */
/* ------------------------------------------------------------------ */

const geometry = new Map();

/**
 * The cell runs of a grid row, as `[first, last]` pairs.
 *
 * @param {string} row
 * @returns {Array}
 */
function runsOf(row) {
    const out = [];
    let start = -1;
    for (let c = 0; c <= row.length; c++) {
        const on = c < row.length && row[c] !== ".";
        if (on && start < 0) {
            start = c;
        }
        if (!on && start >= 0) {
            out.push([start, c - 1]);
            start = -1;
        }
    }
    return out;
}

/**
 * What never changes about a fry hull: which rungs its art can show, where its
 * engine is, which cells are its eyes, its cannon and its core, and how much
 * room a turned copy of it needs.
 *
 * Nothing is hand-counted and nothing knows a sprite by name. The nozzles in
 * particular are the whole of the chassis test the study asks for: the tail is
 * the top edge (these hulls fly down the screen), and an artist who wanted an
 * exhaust there painted it in the dark tint. A hull with such a plug burns out
 * of it; one without burns out of its tail edge, and a tail wide enough for two
 * nozzles gets two.
 *
 * @param {string} name key in SPRITES
 * @param {string} kit "speedy" | "tank" | "sniper" | "kami"
 * @returns {Object}
 */
function geometryOf(name, kit) {
    const key = name + "|" + kit;
    let geo = geometry.get(key);
    if (geo) {
        return geo;
    }
    const grid = spriteGrid(name);
    const rows = grid.length;
    const cols = rows ? grid[0].length : 0;
    const axis = cols / 2;
    const used = new Uint8Array(TOP + 1);
    const accent = [];
    const white = [];
    const spans = [];
    let maxSpan = 0;
    for (let r = 0; r < rows; r++) {
        const runs = runsOf(grid[r]);
        spans.push(runs.length ? runs[runs.length - 1][1] - runs[0][0] + 1 : 0);
        maxSpan = Math.max(maxSpan, spans[r]);
        for (let c = 0; c < cols; c++) {
            const ch = grid[r][c];
            if (ch === ".") {
                continue;
            }
            const rung = RUNG[ch];
            if (rung != null) {
                used[rung] = 1;
            }
            if (ch === ACCENT_CHAR) {
                accent.push([c, r]);
            } else if (ch === WHITE_CHAR) {
                white.push([c, r]);
            }
        }
    }
    // The rungs this hull can actually show, darkest first. Promotion and wear
    // are steps along *this*, not along the bank's nine, so a step can never be
    // a no-op on a hull whose art skips the rung it would have landed on.
    const fold = rungFold(used);
    const ladder = [];
    const rungAt = new Int8Array(TOP + 1);
    for (let i = 0; i <= TOP; i++) {
        const r = fold[i];
        if (ladder.indexOf(r) < 0) {
            ladder.push(r);
        }
    }
    ladder.sort((a, b) => a - b);
    for (let i = 0; i <= TOP; i++) {
        rungAt[i] = ladder.indexOf(fold[i]);
    }

    // The engine, and the whole of the chassis test. The tail is the top edge
    // (these hulls fly down the screen) and its outline is painted in the
    // darkest rung the hull uses, so the *opening* is whatever the first tail
    // row paints in anything else. One nozzle per run of it: `tank0` paints two
    // four-cell openings either side of a dark spine and gets two, `speedy1`
    // paints one and gets one. A run of dark tint on that row is a *recessed*
    // exhaust, and the flame out of one is focused and hot rather than broad.
    let band = [];
    let recessed = false;
    for (let r = 0; r < rows && !band.length; r++) {
        const open = [];
        const plugged = [];
        for (let c = 0; c < cols; c++) {
            const ch = grid[r][c];
            const rung = RUNG[ch];
            open.push(ch !== "." && ch !== ACCENT_CHAR && rung != null && rungAt[rung] > 0 ? "x" : ".");
            plugged.push(ch === DARK_TINT_CHAR ? "x" : ".");
        }
        const runs = runsOf(open.join(""));
        if (!runs.length) {
            continue;
        }
        const plug = runsOf(plugged.join(""));
        recessed = plug.length > 0;
        band = recessed ? plug : runs;
    }
    const nozzles = band.length
        ? band.map((run) => (run[0] + run[1] + 1) / 2)
        : [axis];

    // The station-keeping thrusters: the accent lamp furthest from the spine on
    // each side, and the lowest of those if the art paints a trail of them. The
    // puff itself goes *under* the silhouette in that column, so it reads as
    // exhaust leaving the hull rather than as a mark on it.
    const thruster = {};
    for (const dir of [-1, 1]) {
        const side = accent
            .filter(([c]) => (dir < 0 ? c + 0.5 < axis : c + 0.5 > axis))
            .sort((a, b) => (Math.abs(b[0] + 0.5 - axis) - Math.abs(a[0] + 0.5 - axis)) || (b[1] - a[1]));
        const cell = side.length ? side[0] : [dir < 0 ? 0 : cols - 1, rows - 1];
        let low = cell[1];
        for (let r = Math.max(0, cell[1]); r < rows; r++) {
            if (grid[r][cell[0]] !== ".") {
                low = r;
            }
        }
        thruster[dir] = [cell[0], low];
    }

    // The cannon: the run of rows at the nose the silhouette narrows to. Found
    // by test, not by index -- the same rule that finds a colossus nozzle, read
    // from the other end of the hull.
    const cannon = [];
    let cannonTop = rows;
    for (let r = rows - 1; r >= 0; r--) {
        if (!spans[r] || spans[r] > maxSpan / 3) {
            break;
        }
        cannonTop = r;
    }
    if (cannonTop < rows) {
        for (let r = cannonTop; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (grid[r][c] !== ".") {
                    cannon.push([c, r]);
                }
            }
        }
    }

    // The core ring: the cells touching the hull's block of hot white. The core
    // itself is already at the top of the ramp and has no headroom, so the
    // throb is layered onto the plating around it -- the same lesson VULCAN's
    // gauge was rebuilt on.
    const ring = [];
    if (white.length) {
        const hot = new Set(white.map(([c, r]) => r * cols + c));
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const ch = grid[r][c];
                if (ch === "." || ch === WHITE_CHAR || ch === ACCENT_CHAR) {
                    continue;
                }
                if (hot.has((r - 1) * cols + c) || hot.has((r + 1) * cols + c)
                    || hot.has(r * cols + c - 1) || hot.has(r * cols + c + 1)) {
                    ring.push([c, r]);
                }
            }
        }
    }

    // Room for a turned copy: the bounding box of the hull at the widest angle
    // this kit bakes, so no rotated cell ever falls off the canvas. SNIPER
    // bakes none (its drift is a whole-cell translate) and KAMIKAZE bakes none
    // either (it is turned live, see `drawFry`), so both only need the cell of
    // slack every hull gets.
    const yawSteps = kit === "speedy" ? FRY_ANIM.speedy.yawSteps : kit === "tank" ? 1 : 0;
    let halfW = cols / 2;
    let halfH = rows / 2;
    if (yawSteps) {
        const a = yawSteps * FRY_ANIM.yawStep;
        const co = Math.abs(Math.cos(a));
        const si = Math.abs(Math.sin(a));
        halfW = (cols * co + rows * si) / 2;
        halfH = (cols * si + rows * co) / 2;
    }
    const squash = FRY_ANIM.death[kit].squash;
    const pad = {
        x: Math.ceil(halfW - cols / 2) + 1,
        y: Math.ceil(halfH * (Array.isArray(squash) ? 1 : squash || 1) - rows / 2) + 1,
    };

    geo = {
        name, kit, grid, cols, rows, axis, ladder, rungAt, pad,
        nozzles, recessed, thruster,
        cannon, cannonTop,
        ring,
        // Where the burn leaves the hull, and how far a plume clears it.
        tail: rows / 2 + 1,
        cannonLen: rows - cannonTop,
    };
    geometry.set(key, geo);
    return geo;
}

/* ------------------------------------------------------------------ */
/* Colour: steps along the hull's own ladder                           */
/* ------------------------------------------------------------------ */

/**
 * Walk a palette index `n` rungs along the ladder this hull is painted with.
 * Positive brightens, negative darkens; both clamp at the ends.
 *
 * @param {Object} geo from `geometryOf`
 * @param {string} ch palette index
 * @param {number} n steps
 * @returns {string} palette index
 */
function shift(geo, ch, n) {
    const rung = RUNG[ch];
    if (rung == null || !n) {
        return ch;
    }
    const at = geo.rungAt[rung] + n;
    return RAMP_CHARS[geo.ladder[Math.max(0, Math.min(geo.ladder.length - 1, at))]];
}

const colours = new Map();

/**
 * A colour painted straight onto the frame rather than baked into a raster,
 * resolved once. `palette()` builds a fresh object per call and these run per
 * hull per frame.
 *
 * @param {Object} geo from `geometryOf`
 * @param {string} tint hull colour
 * @param {string} ch palette index to start from
 * @param {number} n ladder steps
 * @returns {string} CSS colour
 */
function colourOf(geo, tint, ch, n) {
    const key = geo.name + "|" + tint + "|" + ch + "|" + n;
    let col = colours.get(key);
    if (!col) {
        col = palette(tint)[shift(geo, ch, n)];
        colours.set(key, col);
    }
    return col;
}

/* ------------------------------------------------------------------ */
/* Wear                                                                */
/* ------------------------------------------------------------------ */

/**
 * A stable 0..1 per cell. The subset of the plating that pits is the same one
 * on every hull of a type and on both roles, and it costs no state.
 */
function cellHash(x, y) {
    let h = (x * 73856093) ^ (y * 19349663) ^ 0x9e3779b9;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Hull points as a wear tier, 0 (untouched art) to 3.
 *
 * A hull that only ever has one point is always tier 0: the art is the
 * baseline, and a SPEEDY that dies to a single shot must never be seen pitted.
 *
 * @param {number} hp
 * @param {number} mhp
 * @returns {number} 0..3
 */
export function fryTier(hp, mhp) {
    if (!mhp || mhp <= 1) {
        return 0;
    }
    const f = Math.max(0, hp) / mhp;
    const t = FRY_ANIM.wear.tiers;
    return f > t[0] ? 0 : f > t[1] ? 1 : f > t[2] ? 2 : 3;
}

/* ------------------------------------------------------------------ */
/* The atlas: one canvas per (hull, tint, px, tier, pose, mode)         */
/* ------------------------------------------------------------------ */

const atlas = new Map();

/**
 * Fill the holes a rotation opens: a cell with at least three orthogonal
 * neighbours takes the first of them, so a turned run does not comb.
 */
function fillHoles(dest, w, h) {
    const add = [];
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (dest[i]) {
                continue;
            }
            const n = [dest[i - 1], dest[i + 1], dest[i - w], dest[i + w]].filter(Boolean);
            if (n.length >= 3) {
                add.push([i, n[0]]);
            }
        }
    }
    for (const [i, cell] of add) {
        dest[i] = cell;
    }
}

/**
 * Bake one pose. The grid is transformed cell by cell -- squashed, turned,
 * promoted, worn -- and only then painted, so every pixel lands on a whole
 * pixel and the result is still pixel art. A live matrix rotation of a 14 px
 * hull lands on half pixels; this does not, and step 0 lays every cell back
 * exactly where the sprite painted it.
 *
 * @param {Object} geo from `geometryOf`
 * @param {string} tint hex colour for indices 4/5/6
 * @param {number} px logical pixel size
 * @param {number} tier wear tier, 0..3
 * @param {Object} p pose: `{ yaw, eye, cannon, core, squash, drain }`
 * @param {string} mode "" | "flash" (hit silhouette) | "dark" (eyes out)
 * @returns {HTMLCanvasElement}
 */
function bake(geo, tint, px, tier, p, mode) {
    const { cols, rows, grid, pad } = geo;
    const W = cols + 2 * pad.x;
    const H = rows + 2 * pad.y;
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    const cos = p.yaw ? Math.cos(p.yaw) : 1;
    const sin = p.yaw ? Math.sin(p.yaw) : 0;
    const cannon = p.cannon ? new Set(geo.cannon.map(([c, r]) => r * cols + c)) : null;
    const ring = p.core ? new Set(geo.ring.map(([c, r]) => r * cols + c)) : null;
    const dest = {};
    for (let r = 0; r < rows; r++) {
        // A squash is applied to the cell's whole extent, not to its centre:
        // stretching by centres alone leaves empty rows between them, which is
        // how a kamikaze's death silhouette came out striped.
        let r0 = r;
        let r1 = r;
        if (p.squash != null) {
            r0 = Math.round(cy + (r - 0.5 - cy) * p.squash);
            r1 = Math.max(r0, Math.round(cy + (r + 0.5 - cy) * p.squash) - 1);
        }
        for (let rr = r0; rr <= r1; rr++) {
            for (let c = 0; c < cols; c++) {
                const ch = grid[r][c];
                if (ch === ".") {
                    continue;
                }
                let nx = c;
                let ny = rr;
                if (p.yaw) {
                    const ox = nx - cx;
                    const oy = ny - cy;
                    nx = cx + ox * cos - oy * sin;
                    ny = cy + ox * sin + oy * cos;
                }
                nx = Math.round(nx) + pad.x;
                ny = Math.round(ny) + pad.y;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
                    continue;
                }
                let lift = 0;
                if (p.eye && ch === GLASS_CHAR) {
                    lift = p.eye;
                } else if (cannon && cannon.has(r * cols + c)) {
                    lift = p.cannon;
                } else if (ring && ring.has(r * cols + c)) {
                    lift = p.core;
                }
                dest[ny * W + nx] = { ch, lift, c, r };
            }
        }
    }
    if (p.yaw) {
        fillHoles(dest, W, H);
    }
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(W * px));
    cv.height = Math.max(1, Math.round(H * px));
    const g = cv.getContext("2d");
    const pal = palette(tint);
    const size = Math.ceil(px);
    const ramp = FRY_ANIM.wear[geo.kit] || FRY_ANIM.wear.tank;
    const deepFrom = FRY_ANIM.wear.deepFrom[geo.kit] || 3;
    for (const k in dest) {
        const i = +k;
        const x = i % W;
        const y = (i - x) / W;
        const cell = dest[i];
        let ch = cell.ch;
        // Wear: a hashed subset of the plating goes down the ladder. Never the
        // neon layer -- the accent, the glass and the hot core are what an
        // effect lights, not what plating does, and they are the read a worn
        // hull still has to keep.
        if (tier && ch !== ACCENT_CHAR && ch !== GLASS_CHAR && ch !== WHITE_CHAR) {
            const frac = ramp[tier - 1];
            const h = cellHash(cell.c, cell.r);
            if (h < frac) {
                ch = shift(geo, ch, -(tier >= deepFrom && h < frac * FRY_ANIM.wear.deepShare ? 2 : 1));
            }
        }
        if (cell.lift) {
            ch = shift(geo, ch, cell.lift);
        }
        if (p.drain) {
            ch = shift(geo, ch, -p.drain);
        }
        if (mode === "dark" && (ch === GLASS_CHAR || ch === WHITE_CHAR)) {
            // A corpse's lights are out: the glass and the core go to the
            // bottom of what this hull can show.
            ch = shift(geo, ch, -TOP);
        }
        const col = pal[ch];
        if (!col) {
            continue;
        }
        // The same hit silhouette the sprite bank paints, so a flashing fry
        // hull looks exactly like every other flashing hull in the game.
        g.fillStyle = mode === "flash"
            ? (ch === "1" || ch === "9" ? "#ffb9f2" : "#ffffff")
            : col;
        g.fillRect(Math.round(x * px), Math.round(y * px), size, size);
    }
    return cv;
}

/**
 * A baked pose, from the atlas (baked on first use).
 *
 * @param {Object} geo from `geometryOf`
 * @param {string} tint hull colour
 * @param {number} px logical pixel size
 * @param {number} tier wear tier
 * @param {string} key what makes this pose different from the others
 * @param {Object} p pose for `bake`
 * @param {string} [mode]
 * @returns {HTMLCanvasElement}
 */
function raster(geo, tint, px, tier, key, p, mode) {
    // The flash silhouette hides the wear, so it is one canvas per pose.
    const k = geo.name + "|" + tint + "|" + px + "|" + (mode === "flash" ? 0 : tier)
        + "|" + key + "|" + (mode || "");
    let cv = atlas.get(k);
    if (!cv) {
        cv = bake(geo, tint, px, tier, p, mode);
        atlas.set(k, cv);
    }
    return cv;
}

/* ------------------------------------------------------------------ */
/* The shared timeline                                                 */
/* ------------------------------------------------------------------ */

/** Which kit an enemy type takes, or `null` if it has one of its own. */
export function fryKit(type) {
    return FRY_ANIM[type] && FRY_ANIM.death[type] ? type : null;
}

/**
 * The yaw step a hull is posed in right now, so the corpse can open in the pose
 * it died in. The engine calls this once, at the kill, and puts the answer on
 * the cue: a guest never simulates and so cannot recompute it.
 *
 * @param {Object} o see `drawFry`
 * @returns {number} the baked step
 */
export function fryStep(o) {
    return fryPose(o, geometryOf(o.name, o.kit)).step;
}

/** How long a corpse of this kit lives, in frames. */
export function fryDeathFrames(kit) {
    return (FRY_ANIM.death[kit] || FRY_ANIM.death.speedy).frames;
}

/** A kamikaze's throttle, 0..1, from its own clock and the wave. */
function kamiThrottle(t, wave) {
    const K = FRY_ANIM.kami;
    const cap = K.cap[0] + (wave || 0) * K.cap[1];
    return Math.max(0, Math.min(1, (K.v0 + K.accel * (t || 0)) / cap));
}

/**
 * The whole pose of one hull, sampled from its own clock and the handful of
 * numbers the snapshot already carries. Nothing is stored per enemy.
 *
 * @param {Object} o see `drawFry`
 * @returns {Object} `{ yaw, key, pose, burn, ... }` -- the baked pose to draw
 *      and everything the plume is painted from
 */
function fryPose(o, geo) {
    const kit = o.kit;
    const t = o.t || 0;
    if (kit === "speedy") {
        const S = FRY_ANIM.speedy;
        // The hull points where it is going: the lateral velocity the AI is
        // applying over the speed it is falling at.
        const vx = (o.dx || 0) * S.steer;
        const vy = S.fall[0] + (o.wave || 0) * S.fall[1];
        const step = Math.max(-S.yawSteps, Math.min(S.yawSteps,
            Math.round(Math.atan2(vx, vy) / FRY_ANIM.yawStep)));
        const flame = geo.recessed ? S.focused : S.broad;
        const burn = Math.floor(t / flame.burn) % 2;
        return { step, burn, flame, yaw: -step * FRY_ANIM.yawStep, key: "Y" + step, pose: {} };
    }
    if (kit === "tank") {
        const T = FRY_ANIM.tank;
        const tel = o.tel || 0;
        const eye = tel > T.eyeAt[1] ? 2 : tel > T.eyeAt[0] ? 1 : 0;
        // It yaws at whoever it is aiming at, a step at a time.
        const step = tel >= T.yawAt ? (o.dx >= 0 ? 1 : -1) : 0;
        return {
            step, eye,
            burn: t % T.burn < T.burn / 2 ? 1 : 0,
            yaw: -step * FRY_ANIM.yawStep,
            key: "Y" + step + "E" + eye,
            pose: { eye },
        };
    }
    if (kit === "sniper") {
        const N = FRY_ANIM.sniper;
        const aim = Math.max(0, Math.min(N.charge, o.aim || 0));
        const frozen = aim >= N.cutAt;
        // Its own drift, rounded to a whole cell: the hull *slides*, it does not
        // bank, which is both what station keeping actually is and the only
        // thing a 16x18 hull with two-cell eyes survives being asked to do
        // three quarters of the time. It pins dead centre the moment the
        // thrusters cut, and that stillness is the tell.
        const step = frozen ? 0 : Math.round(Math.sin(t * N.drift));
        const stage = N.stages[Math.min(N.stages.length - 1, Math.floor(aim / (N.charge / N.stages.length)))];
        return {
            step, aim, frozen, stage, shift: step,
            side: t % (N.puff * 2) < N.puff ? -1 : 1,
            burn: frozen ? 0 : (t % N.puff < N.pulse ? 1 : 0),
            yaw: 0,
            key: "C" + stage,
            pose: { cannon: stage },
        };
    }
    const K = FRY_ANIM.kami;
    const n = kamiThrottle(t, o.wave);
    const per = K.throb[0] - K.throb[1] * n;
    const lit = t % per < per / 2 ? 1 : 0;
    const step = ((Math.round((o.rot || 0) / (2 * Math.PI / K.yawSteps)) % K.yawSteps) + K.yawSteps) % K.yawSteps;
    const core = lit ? (n > K.boostAt ? 2 : 1) : 0;
    // `step` is only what the corpse opens in: the living hull is turned live.
    return {
        step, lit, n, core,
        burn: lit,
        spin: o.rot || 0,
        yaw: 0,
        key: "C" + core,
        pose: { core },
    };
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

/**
 * One living hull: a baked pose, translated a cell along the thrust axis on the
 * burn frame, plus the two cells of its plume.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {Object} o
 * @param {string} o.name sprite key
 * @param {string} o.kit "speedy" | "tank" | "sniper" | "kami"
 * @param {string} o.tint hull colour
 * @param {number} o.px logical pixel size
 * @param {number} o.x centre
 * @param {number} o.y centre
 * @param {number} o.t the enemy's frame clock
 * @param {number} o.hp hull points left
 * @param {number} o.mhp hull points when whole
 * @param {number} o.wave the wave, for the speeds the AI derives from it
 * @param {number} [o.dx] how far the target is to the side (speedy, tank)
 * @param {number} [o.dy] how far the target is below (tank, for the muzzle)
 * @param {number} [o.tel] telegraph ramp 0..1 (tank)
 * @param {number} [o.aim] charge frames 0..70 (sniper)
 * @param {number} [o.rot] facing (kamikaze)
 * @param {number} [o.fire] recoil frames left (tank)
 * @param {boolean} [o.flash] the hit silhouette
 */
export function drawFry(g, o) {
    const geo = geometryOf(o.name, o.kit);
    const px = o.px;
    const tier = fryTier(o.hp, o.mhp);
    const p = fryPose(o, geo);
    g.imageSmoothingEnabled = false;
    if (o.flash) {
        // The silhouette replaces everything, plume included: 1 + 0.
        const cv = raster(geo, o.tint, px, 0, p.key, Object.assign({ yaw: p.yaw }, p.pose), "flash");
        g.drawImage(cv, Math.round(o.x - cv.width / 2), Math.round(o.y - cv.height / 2));
        g.imageSmoothingEnabled = true;
        return;
    }
    // The burn shoves the hull a whole cell along its own axis. Whole device
    // pixels only: a fractional translate of a baked frame would resample it.
    const kick = Math.max(1, Math.round(px));
    // How the hull is turned. SPEEDY and TANK bake the yaw into the pose;
    // KAMIKAZE is turned live by the matrix, because it is the one hull that
    // turns through the whole circle and a 14x14 diamond rotated cell by cell
    // only loses its pixels -- the same reason DRONE-B turns its arms and
    // leaves its body alone. SNIPER does not turn at all.
    const ang = p.spin || p.yaw;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    // The thrust axis in screen space: the hull's own "up" (these sprites face
    // down, so the exhaust leaves through the top edge), turned with the body.
    const ax = sin;
    const ay = -cos;
    let lurch = 0;
    if (o.kit === "speedy" || o.kit === "kami") {
        lurch = p.burn ? -1 : 0;            // a hard burn shoves it forward
    } else if (p.burn) {
        lurch = 1;                          // a heavy one settles back on itself
    }
    if (o.kit === "tank" && o.fire > 0) {
        lurch = 1;                          // and the shot kicks it back
    }
    const cv = raster(geo, o.tint, px, tier, p.key, Object.assign({ yaw: p.yaw }, p.pose));
    if (p.spin) {
        g.save();
        g.translate(Math.round(o.x), Math.round(o.y));
        g.rotate(p.spin);
        g.drawImage(cv, -Math.round(cv.width / 2), -Math.round(cv.height / 2) - lurch * kick);
        g.restore();
    } else {
        g.drawImage(
            cv,
            Math.round(o.x - cv.width / 2) + Math.round(ax * lurch * kick) + (p.shift || 0) * kick,
            Math.round(o.y - cv.height / 2) + Math.round(ay * lurch * kick)
        );
    }
    // Two fillRect, in hull cells about the hull's centre, on the thrust axis.
    const rect = (dcx, dcy, w, h, col, alpha) => {
        g.globalAlpha = alpha;
        g.fillStyle = col;
        g.fillRect(
            Math.round(o.x + dcx * px - (w * px) / 2),
            Math.round(o.y + dcy * px - (h * px) / 2),
            Math.max(1, Math.round(w * px)),
            Math.max(1, Math.round(h * px))
        );
        g.globalAlpha = 1;
    };
    // The flame is the hull's own colour driven towards white, never a new
    // tone: the light tint for the head of the plume, the flat tint behind it.
    const hot = colourOf(geo, o.tint, TINT_CHAR, 1);
    const warm = colourOf(geo, o.tint, TINT_CHAR, 0);
    // A nozzle in screen-cell offsets, turned with the hull.
    const at = (nx, out) => [
        (nx - geo.axis) * cos - (-geo.tail - out) * sin,
        (nx - geo.axis) * sin + (-geo.tail - out) * cos,
    ];
    if (o.kit === "speedy") {
        const f = p.flame;
        const len = f.len[p.burn];
        const a = f.alpha[p.burn];
        const [hx, hy] = at(geo.nozzles[0], 0);
        rect(hx, hy, f.wid, f.wid, hot, a);
        rect(hx + ax * len, hy + ay * len, f.wid - 1, f.wid - 1, warm, a * 0.45);
    } else if (o.kit === "tank") {
        const T = FRY_ANIM.tank;
        if (o.fire > 0) {
            // The muzzle flash sits on the hull edge the shot leaves from, and
            // the flame-out cell is the other half of the budget.
            const d = Math.hypot(o.dx || 0, o.dy || 1) || 1;
            const mx = ((o.dx || 0) / d) * geo.tail;
            const my = ((o.dy || 1) / d) * geo.tail;
            rect(mx, my, 2, 2, "#ffffff", o.fire / T.recoil);
            rect(ax * geo.tail, ay * geo.tail, T.plumeWid, 1, warm, T.idleAlpha);
        } else if (p.eye) {
            // Throttled down to steady the shot: the hull going quiet is half
            // the telegraph, and it costs one cell instead of two.
            rect(ax * geo.tail, ay * geo.tail, T.plumeWid, 1, warm, T.idleAlpha);
        } else {
            // A column of flame `len` cells long, anchored on the hull edge, so
            // the beat is a change of *shape* and not only of alpha -- the one
            // thing a 3 Hz burn has to read across an arena.
            const len = T.plumeLen[p.burn];
            const a = T.alpha[p.burn];
            const twin = geo.nozzles.length > 1;
            for (const nx of geo.nozzles) {
                const [hx, hy] = at(nx, len / 2 - 1);
                rect(hx, hy, T.plumeWid, len, hot, a);
            }
            if (!twin) {
                rect(ax * (geo.tail + len), ay * (geo.tail + len), T.plumeWid, 1, warm, a * 0.6);
            }
        }
    } else if (o.kit === "sniper") {
        const N = FRY_ANIM.sniper;
        const cool = colourOf(geo, o.tint, TINT_CHAR, 2);
        if (p.aim > 0) {
            // The charge bead travels down the cannon the art actually paints,
            // and the surviving puff shrinks to a bar under the hull.
            const along = (p.aim / N.charge) * geo.cannonLen;
            const dcx = p.shift || 0;
            rect(dcx, geo.cannonTop - (geo.rows - 1) / 2 + along, p.aim > N.beadAt ? 2 : 1,
                p.aim > N.beadAt ? 2 : 1, cool, 0.6 + 0.4 * (p.aim / N.charge));
            rect(dcx, geo.tail - 3, 4, 1, hot, p.frozen ? N.cutAlpha : 0.4);
        } else {
            // Station keeping: one side thruster puffs, then the other. Both
            // sit on the accent lamps the sprite already paints there.
            const [tx, ty] = geo.thruster[p.side];
            const dcx = tx + 0.5 - geo.axis + (p.shift || 0);
            const dcy = ty + 1.5 - (geo.rows - 1) / 2;
            rect(dcx, dcy, 2, 2, hot, N.alpha[p.burn]);
            rect(dcx, dcy + 2, 1, 1, warm, N.alpha[p.burn] * 0.5);
        }
    } else {
        const K = FRY_ANIM.kami;
        // No idle and no tell: the plume is always lit, and its length, its
        // alpha and the core's throb rate are all the same number.
        const len = K.plumeLen[0] + K.plumeLen[1] * p.n;
        const a = K.alpha[0] + K.alpha[1] * p.n;
        const off = K.plumeOff;
        rect(ax * (geo.tail + off), ay * (geo.tail + off), 1 + len * 0.3, 1 + len * 0.3, hot, a);
        rect(ax * (geo.tail + off + len * 0.8), ay * (geo.tail + off + len * 0.8),
            1 + len * 0.2, 1 + len * 0.2, warm, a * 0.6);
    }
    g.imageSmoothingEnabled = true;
}

/* ------------------------------------------------------------------ */
/* The glossary still                                                  */
/* ------------------------------------------------------------------ */

/**
 * The card art for the catalogue: the hull in the one pose that says the most
 * about it, on a canvas cut to what is actually drawn. It exists for the same
 * reason `backdropThumb` does -- the glossary promises that what you see on the
 * card is what shows up while playing, and a flat sprite stopped being that the
 * moment these hulls grew an engine.
 *
 * Each kit is shown in the state it is genuinely seen in: SPEEDY and TANK
 * mid-burn (SPEEDY leaning a step, because it always is), SNIPER part way
 * through the charge it spends its whole life in, and KAMIKAZE spooling up with
 * its core lit -- not at the cap, where the trail is longer than the hull and
 * the card would be mostly exhaust.
 *
 * @param {Object} o `{ name, kit, tint, px }` from the catalogue entry
 * @returns {HTMLCanvasElement}
 */
export function fryThumb(o) {
    // The catalogue calls the sprite key `sprite`, the animator calls it `name`.
    const name = o.sprite || o.name;
    const geo = geometryOf(name, o.kit);
    const px = o.px;
    // Generous room for the longest plume any of them throws, then cropped to
    // what was actually painted -- so the card is the drawing, centred, and no
    // hull needs a margin written down for it.
    const margin = 10;
    const cv = document.createElement("canvas");
    cv.width = Math.round((geo.cols + 2 * margin) * px);
    cv.height = Math.round((geo.rows + 2 * margin) * px);
    const g = cv.getContext("2d");
    const pose = {
        speedy: { t: 3, dx: 140, wave: 1 },
        tank: { t: 3, dx: 0, dy: 1 },
        sniper: { t: 5, aim: 42 },
        kami: { t: 8, rot: 0, wave: 1 },
    }[o.kit] || {};
    drawFry(g, Object.assign({
        name, kit: o.kit, tint: o.tint, px,
        x: cv.width / 2, y: cv.height / 2,
        t: 0, hp: 4, mhp: 4, wave: 1, dx: 0, dy: 1, tel: 0, aim: 0, rot: 0, fire: 0,
    }, pose));
    return trimCanvas(cv, Math.round(px));
}

/* ------------------------------------------------------------------ */
/* Death                                                               */
/* ------------------------------------------------------------------ */

/**
 * A dead hull. Every one of them opens the same way -- a white silhouette while
 * the engine flames out, a guttering cell where the plume was, and only then
 * the break-up -- and each comes apart the way its own silhouette wants to:
 *
 *   SPEEDY    splits down its long axis and the halves leave with the steer
 *             they were carrying.
 *   TANK      crushes vertically first, then parts on the eye line: the top
 *             slab lifts and rolls, the bottom drops, four cells of debris.
 *   SNIPER    the only one whose death changes its motion, because it was the
 *             only one holding still. Its eyes go out, the cannon detaches and
 *             falls on its own, and the body collapses inward.
 *   KAMIKAZE  no fragments. It detonates: the flame-out and the detonation are
 *             the same event, and no corpse persists.
 *
 * A pure function of the wreck's age, so it allocates nothing, runs identically
 * on a host and a guest, and needs no state beyond the numbers the kill cue
 * already carries.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {Object} w `{ name, kit, tint, px, x, y, t, tier, step }` -- `t` is the
 *      age of the corpse in frames and `step` the pose it died in
 */
export function drawFryWreck(g, w) {
    const D = FRY_ANIM.death[w.kit];
    if (!D || w.t >= D.frames) {
        return;
    }
    const geo = geometryOf(w.name, w.kit);
    const px = w.px;
    const t = w.t;
    // Turned the way the living hull was: baked for the two that bake it, live
    // for the kamikaze, not at all for the sniper.
    const baked = w.kit === "speedy" || w.kit === "tank";
    const spin = w.kit === "kami" ? (w.step * 2 * Math.PI) / FRY_ANIM.kami.yawSteps : 0;
    const yaw = baked ? -w.step * FRY_ANIM.yawStep : 0;
    const key = baked ? "Y" + w.step : "W";
    g.imageSmoothingEnabled = false;
    const put = (cv) => {
        if (spin) {
            g.save();
            g.translate(Math.round(w.x), Math.round(w.y));
            g.rotate(spin);
            g.drawImage(cv, -Math.round(cv.width / 2), -Math.round(cv.height / 2));
            g.restore();
            return;
        }
        g.drawImage(cv, Math.round(w.x - cv.width / 2), Math.round(w.y - cv.height / 2));
    };
    const rect = (dcx, dcy, cw, ch, col, alpha) => {
        g.globalAlpha = Math.max(0, alpha);
        g.fillStyle = col;
        g.fillRect(
            Math.round(w.x + dcx * px - (cw * px) / 2),
            Math.round(w.y + dcy * px - (ch * px) / 2),
            Math.max(1, Math.round(cw * px)), Math.max(1, Math.round(ch * px))
        );
        g.globalAlpha = 1;
    };
    // The flame-out. The plume is gone from the first frame; what is left is one
    // cell guttering at the nozzle, twice, and then nothing is powered again.
    if (FRY_ANIM.death.gutter.indexOf(Math.floor(t)) >= 0) {
        const ax = Math.sin(spin || yaw);
        const ay = -Math.cos(spin || yaw);
        rect(ax * geo.tail, ay * geo.tail, 1, 1, "#ffffff", 0.55 - t * 0.04);
    }
    if (t < D.flash) {
        put(raster(geo, w.tint, px, 0, key + (w.kit === "kami" ? "X" : ""),
            { yaw, squash: w.kit === "kami" ? D.squash : undefined }, "flash"));
        g.imageSmoothingEnabled = true;
        return;
    }
    if (w.kit === "kami") {
        // It detonates. The core goes up four rungs on its own, then the ring
        // leaves and there is no corpse.
        if (t < D.core) {
            put(raster(geo, w.tint, px, w.tier, key + "CO", { yaw, core: D.coreLift }));
            g.imageSmoothingEnabled = true;
            return;
        }
        const k = (t - D.core) / (D.frames - D.core);
        const r = 1 + k * D.ringCells;
        const a = 1 - k * k;
        const sz = D.ringSize * (1 - k * 0.4);
        const hot = colourOf(geo, w.tint, TINT_CHAR, 2);
        const warm = colourOf(geo, w.tint, TINT_CHAR, 0);
        // Four cells leaving on the diagonals of the hull's own diamond, so the
        // ring reads as *that* silhouette coming apart rather than as a puff.
        const d = r * 0.7071;
        rect(-d, -d, sz, sz, hot, a);
        rect(d, -d, sz, sz, hot, a);
        rect(-d, d, sz, sz, warm, a);
        rect(d, d, sz, sz, warm, a);
        g.imageSmoothingEnabled = true;
        return;
    }
    if (w.kit === "tank" && t < D.split) {
        // The crush: two baked squash steps before anything comes apart.
        const s = t < D.crush ? D.squash[0] : D.squash[1];
        put(raster(geo, w.tint, px, w.tier, key + "Q" + (t < D.crush ? 0 : 1), { yaw, squash: s }, "dark"));
        g.imageSmoothingEnabled = true;
        return;
    }
    if (w.kit === "sniper" && t < D.split) {
        put(raster(geo, w.tint, px, w.tier, key, { yaw }, t < D.eyesOut ? "" : "dark"));
        g.imageSmoothingEnabled = true;
        return;
    }
    if (w.kit === "speedy" && t < D.split) {
        put(raster(geo, w.tint, px, w.tier, key, { yaw }, "dark"));
        g.imageSmoothingEnabled = true;
        return;
    }
    const k = (t - D.split) / (D.frames - D.split);
    const drain = k > D.drainFrom
        ? Math.min(2, 1 + Math.floor(((k - D.drainFrom) / (1 - D.drainFrom)) * 2))
        : 0;
    const cv = raster(geo, w.tint, px, w.tier, key + "D" + drain, { yaw, drain }, "dark");
    const half = Math.round(cv.width / 2);
    g.save();
    if (k > 0.75) {
        g.globalAlpha = Math.max(0, 1 - (k - 0.75) * 4);
    }
    if (w.kit === "speedy") {
        // It comes apart on its own axis of symmetry, and the halves keep the
        // steer they were carrying: nothing accelerates after the flame-out.
        const spread = k * D.spreadCells * px;
        const drop = k * k * D.dropCells * px;
        const drift = w.step * k * D.spreadCells * px * 0.4;
        for (const dir of [-1, 1]) {
            g.save();
            g.translate(w.x + dir * spread + drift, w.y + drop);
            g.rotate(k * D.spin * dir);
            g.drawImage(
                cv, dir < 0 ? 0 : half, 0, half, cv.height,
                dir < 0 ? -half : 0, -Math.round(cv.height / 2), half, cv.height
            );
            g.restore();
        }
        g.restore();
        const hot = colourOf(geo, w.tint, ACCENT_CHAR, 0);
        for (let i = 0; i < D.sparks; i++) {
            const dir = i ? 1 : -1;
            rect(dir * (2 + k * D.sparkCells), -2 + k * D.dropCells * 0.4, 1, 1, hot, 1 - k);
        }
        g.imageSmoothingEnabled = true;
        return;
    }
    if (w.kit === "tank") {
        // Parted on the eye line: the top slab lifts and rolls, the bottom
        // drops away under it.
        const cut = Math.round(cv.height / 2);
        g.drawImage(
            cv, 0, 0, cv.width, cut,
            Math.round(w.x - cv.width / 2 + k * D.rollCells * px),
            Math.round(w.y - cv.height / 2 - k * D.riseCells * px), cv.width, cut
        );
        g.drawImage(
            cv, 0, cut, cv.width, cv.height - cut,
            Math.round(w.x - cv.width / 2 - k * D.rollCells * 0.5 * px),
            Math.round(w.y - cv.height / 2 + cut + k * D.dropCells * px), cv.width, cv.height - cut
        );
        g.restore();
        const col = colourOf(geo, w.tint, TINT_CHAR, 0);
        for (let i = 0; i < D.debris; i++) {
            const a = i * 1.9 + 0.4;
            const r = k * D.debrisCells;
            rect(Math.cos(a) * r, Math.sin(a) * r * 0.6 + k * D.dropCells * 0.6, 1, 1, col, 1 - k);
        }
        g.imageSmoothingEnabled = true;
        return;
    }
    // Sniper: the cannon detaches and falls on its own, and the body collapses
    // inward around the space it left.
    const conv = Math.min(D.convCells, k * D.convCells * 1.6) * px;
    const drop = k * D.dropCells * px;
    const cutY = Math.round((geo.cannonTop + geo.pad.y) * px);
    for (const dir of [-1, 1]) {
        // Inward: the body folds into the space the cannon left, which is the
        // one death in the four that closes instead of opening.
        g.drawImage(
            cv, dir < 0 ? 0 : half, 0, half, cutY,
            Math.round(w.x - cv.width / 2 + (dir < 0 ? 0 : half) - dir * conv),
            Math.round(w.y - cv.height / 2 + drop), half, cutY
        );
    }
    g.restore();
    const col = colourOf(geo, w.tint, TINT_CHAR, 1);
    rect(0, geo.cannonTop - (geo.rows - 1) / 2 + k * D.cannonCells, 2, geo.cannonLen, col, 1 - k);
    g.imageSmoothingEnabled = true;
}
