/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - DRONE-A / DRONE-B animation kit (RENDER side).
 *
 * Ported from the "DRONE-A Animation Kit" design study. Everything about it is
 * shaped by what a drone *is*: filler, twenty of them on screen at once, dead
 * to one shot for most of a run. The cost of anything here is multiplied by the
 * instance count, so the study's own rule is the rule:
 *
 *   ONE shared timeline, sampled with a per-instance phase offset. No state
 *   machine per drone, no animator object per drone, no allocation per frame.
 *
 * The engine already hands us that timeline for free: a drone's zigzag is
 * `sin(e.t * rate)` and `e.t` is seeded at random when the hull is created, so
 * `e.t` *is* the phase. Nothing new travels in the snapshot -- `tt` (the clock),
 * `h` (hull points) and `f` (the hit flash) were all already in it, which is
 * also why a guest draws the same pose as the host.
 *
 * The four pieces the study asked for, and what they became here:
 *
 *   DRIFT      the chassis leans into the direction it is sliding (5 steps) and
 *              the eyes lead it by one cell. Baked, not sheared at draw time: a
 *              matrix shear of a 16 px hull lands on half pixels and turns the
 *              art to mush, and the whole atlas is 45 tiny canvases per chassis.
 *   TURN_TELL  the outer lamps on the side it is about to turn towards light up
 *              a few frames before the zigzag reverses. One `fillRect`.
 *   HULL_TIERS the study proposed four ways to read hull points off the sprite
 *              and recommended D, "the area of saturated hull colour", because
 *              it is the only one that changes the *mass of light* and so
 *              survives twenty hulls at 32 px. That is what this is -- with the
 *              direction reversed: the study eroded the art down from tier 4,
 *              which would have left every drone of waves 1-8 (all of them tier
 *              1, the hull points only start growing on wave 9) a dark husk.
 *              The art is the baseline and light is only ever *added*: tier 1
 *              is the sprite exactly as it is drawn, and tiers 2-4 promote the
 *              core outwards to the light tint. Brightness therefore drains as
 *              a hull is worn down, which is the direction a health read should
 *              go in.
 *   HIT        no new code: the engine already flashes the silhouette white for
 *              5 frames, and since `e.hp` drops on the same frame the flash
 *              starts, the hull that comes back out of it is already the lower
 *              tier. Impact and remaining hull, in the same instant.
 *   DEATH      the piece that is seen most, so it is the one with the frames:
 *              the eyes go out, the chassis splits on its own symmetry axis and
 *              the two halves leave with the inertia the drone was carrying,
 *              plus four hull fragments. Sprite fragments, not a particle
 *              system: 2 clipped `drawImage` and 4 `fillRect`.
 *
 * DRONE-B is the same kit on a *radial* chassis, and the three pieces that
 * cannot survive the change of silhouette are the three that change:
 *
 *   DRIFT      a cross does not lean, it turns. The hull rotates about its own
 *              centre, quantised to 8 baked steps, and the turn *speeds up*
 *              with the zigzag: the angle is `t * rate - cos(z) * swing`,
 *              whose derivative carries the drone's own lateral velocity. It
 *              therefore runs at 0.05 rad/frame through the middle of a sweep
 *              and stalls at 0.01 at the reversal -- which parks the stall on
 *              the turn tell without a line of code asking for it.
 *              Only the arms and the eyes actually turn: the body is a diamond
 *              and rotating *it* would sand the pixels off a 16 px hull, while
 *              the two things the eye tracks are what carry the rotation.
 *   TURN_TELL  the tips of the two arms on the side it is about to turn
 *              towards, instead of the two pips under DRONE-A's hull.
 *   DEATH      radial: the four arms let go first and keep the angular
 *              momentum they had, the core collapses last.
 *
 * Which kit a chassis gets is read off the art, not off its name: a hull that
 * paints the neon accent in all four quadrants is radial (those cells are its
 * arms), and one that only paints it under itself is not. `drone0` and
 * `drone1` answer that question on their own, and so would a third chassis.
 *
 * Colour: no new tones. Every effect *promotes* a cell up the sprite bank's own
 * ramp (`RAMP_CHARS` in `sprites.js`), and a rung the art does not use folds
 * onto the nearest one it does -- so a lit lamp on this hull is the glass its
 * own eyes are painted in, and a tier-4 core is its own tint lighter. The
 * geometry is read out of the art the same way (`geometryOf`): the lamps are
 * the cells the sprite already paints in the neon accent, the eyes are its
 * glass, the split is its own axis. Retouch the sprite and all of it follows.
 *
 * Pure and deterministic: no `Math.random`, no rAF, no timers, no window
 * access. Time only enters as the engine's own frame clock, so pause freezes
 * this and slow-mo (and an EMP `stun`, which drives `mv` to 0) slows it.
 *
 * Measured at the numbers below (drone `r` = 14, so `px` = 2, hull 32x26 px):
 *   tilt         5 levels, |2| on 41% of the cycle, 0 on 18%
 *   turn tell    lit on 35% of each half cycle, blinking at 6 Hz -> 3.5 blinks
 *   tier steps   0 / 16 / 32 / 52 cells promoted out of 72 (drone0)
 *   atlas        <= 45 canvases per chassis and tint, ~3.7 KB each, lazily baked
 *   per drone    1 drawImage + at most 2 fillRect; a wreck 2 + 4
 *
 * And DRONE-B, on the same hull scale (its frame is 20x21 cells rather than
 * 18x13, because a turning arm leaves the grid on both axes):
 *   rotation     8 baked steps, 0.010..0.050 rad/frame -- never zero, never
 *                backwards; a wave 1 crossing is 2.1 turns, 18 steps
 *   turn tell    the 2 arm tips on that side, and every phase seed passes
 *                through all 8 steps while announcing turns
 *   atlas        32 canvases per chassis and tint for the living hull
 *                (4 tiers x 8 steps), ~6.7 KB each, lazily baked
 *   per drone    1 drawImage + 0.33 fillRect, measured over 12k draws
 * The port left DRONE-A byte-identical: the same workload replayed against
 * both versions matched over 33,201 canvas ops.
 */

import { RAMP_CHARS, RUNG, canvasBounds, palette, rungFold, spriteGrid } from "./sprites";

const TOP = RAMP_CHARS.length - 1;
/** The index the sprite bank paints the neon accent (the lamps) with. */
const ACCENT_CHAR = "8";
/** The index the eyes are painted with. */
const GLASS_CHAR = "7";
/** The index the hull itself is painted with: the one an effect may promote. */
const TINT_CHAR = "4";

export const DRONE_ANIM = {
    drift: {
        // The zigzag itself. `game_engine.js` reads these two for the movement,
        // so the pose is sampled from the same numbers that produce it and the
        // lean cannot end up pointing the wrong way after a retune.
        rate: 0.05,             // rad per frame: a reversal every 62.8 frames
        ampPx: 1.1,             // px per frame at the middle of a sweep
        // Lean. The study's chassis shear, in the two rows that can carry it on
        // a 13 row hull: the top rows go with the drift, and at full tilt the
        // bottom rows counter it, which is what makes it read as a lean rather
        // than a slide.
        levels: 2,              // tilt steps each way
        topRows: 0.18,          // fraction of the hull that leans with the drift
        botRows: 0.78,          // rows that counter-lean, at full tilt only
        eyeCells: 1,            // cells the eyes lead the lean by
    },

    tell: {
        // The announcement of the reversal. The study asked for "6-8 frames"
        // out of its own 12 fps timeline (0.6 s); against the engine's 62.8
        // frame half cycle that would be lit two thirds of the time, which is
        // not an announcement, it is a lamp. 22 frames is 35% of the half
        // cycle: long enough to read across the arena, short enough that its
        // arrival is the event.
        frames: 22,
        blink: 5,               // frames per blink phase -> 6 Hz
        cells: 2,               // lamps lit per side (the outermost, lowest)
        lift: 2,                // rungs: the accent lights up to the glass
    },

    spin: {
        // DRONE-B's drift. Quantised so the whole rotation is a handful of
        // baked frames: a canvas rotation of a 16 px hull lands on half pixels
        // for the same reason the lean is baked and not sheared.
        //
        //   angle(t) = t * rate - cos(t * drift.rate) * swing
        //
        // The study modulates the spin by "the direction of the zigzag", which
        // on this engine is the *velocity* -- `game_engine.js` adds
        // `sin(e.t * rate)` to x every frame, so the sine is the speed and the
        // position is its integral. Differentiating the angle above gives
        // `rate + swing * drift.rate * sin(z)`, i.e. exactly that velocity.
        steps: 8,               // baked rotation frames (the study's 8 frame loop)
        rate: 0.03,             // rad per frame: a full turn every 3.5 s
        swing: 0.4,             // rad the zigzag adds and takes away
        tips: 1,                // arm cells the turn tell lights (the outermost)
    },

    tiers: {
        // Hull points, read off the sprite with no HUD. Per tier, the depth
        // from the silhouette's edge at which the hull starts being promoted;
        // 0 leaves the art alone. Deeper cells light first, so the bright core
        // grows outwards as the hull gets tougher.
        max: 4,
        depth: [0, 4, 3, 2],
        lift: 1,                // rungs: tint -> light tint
    },

    death: {
        // Frames, at the engine's 60 fps: the study's 10 frames at 12 fps.
        frames: 50,
        flash: 5,               // white silhouette, then
        hold: 10,               // ... eyes out, still whole, then it breaks
        spreadCells: 7,         // how far each half travels sideways
        dropCells: 10,          // gravity on the halves (quadratic)
        inertiaCells: 8,        // how much of the drift the pieces keep
        spin: 0.5,              // rad each half turns over the whole animation
        shards: 4,
        shardCells: 13,         // how far the fragments get
        shardSize: 1.5,         // in hull cells
        fadeFrom: 0.8,          // fraction of the animation the fade starts at
        // The radial break-up (DRONE-B). The arms leave along their own
        // bearing still turning, and the core is the last thing to go.
        armCells: 10,           // how far an arm slides out along itself
        armSpin: 3,             // multiple of the live spin rate it tumbles at
        coreHold: 0.45,         // fraction of the break-up before the core folds
    },

    /** Cap on live wrecks: a bomb can sweep thirty hulls in one frame. */
    maxWrecks: 48,
};

/* ------------------------------------------------------------------ */
/* Geometry: everything read out of the art, once per chassis          */
/* ------------------------------------------------------------------ */

const geometry = new Map();

/**
 * What never changes about a drone hull: how deep inside the silhouette every
 * cell sits, which rungs of the ramp its art actually uses, where its lamps
 * are and where its symmetry axis is.
 *
 * Nothing is hand-counted: the lamps are the cells already painted in the neon
 * accent, ordered from the lowest and most outboard inwards, so DRONE-A's two
 * corner pips and DRONE-B's six-cell diagonal trail both answer the question
 * "which lamp is on that side" without either being written down here.
 *
 * @param {string} name key in SPRITES
 * @returns {Object}
 */
function geometryOf(name) {
    let geo = geometry.get(name);
    if (geo) {
        return geo;
    }
    const grid = spriteGrid(name);
    const rows = grid.length;
    const cols = rows ? grid[0].length : 0;
    const solid = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows && grid[r][c] !== ".";
    // Depth from the edge of the silhouette: 0 on the rim, +1 for every cell
    // whose four neighbours are all at least as deep as the previous pass.
    let depth = [];
    for (let r = 0; r < rows; r++) {
        depth.push(new Int8Array(cols).fill(-1));
        for (let c = 0; c < cols; c++) {
            if (solid(c, r)) {
                depth[r][c] = 0;
            }
        }
    }
    for (let pass = 1; pass <= TOP; pass++) {
        const next = depth.map((row) => row.slice());
        let grew = false;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (depth[r][c] !== pass - 1) {
                    continue;
                }
                const in4 = r > 0 && r < rows - 1 && c > 0 && c < cols - 1;
                if (in4 && depth[r - 1][c] >= pass - 1 && depth[r + 1][c] >= pass - 1
                    && depth[r][c - 1] >= pass - 1 && depth[r][c + 1] >= pass - 1) {
                    next[r][c] = pass;
                    grew = true;
                }
            }
        }
        depth = next;
        if (!grew) {
            break;
        }
    }
    // Which rungs the art uses, so a promotion can only ever land on a colour
    // that is already somewhere on this hull. `rungFold` in `sprites.js` does
    // the folding: an unused rung goes to the nearest used one, and the three
    // tint shades are always the hull's own colour.
    const used = new Uint8Array(TOP + 1);
    const lamps = [];
    const eyes = [];
    for (let r = 0; r < rows; r++) {
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
                lamps.push([c, r]);
            }
            if (ch === GLASS_CHAR) {
                eyes.push([c, r]);
            }
        }
    }
    const rungs = rungFold(used);
    // Turn lamps: lowest first, then most outboard. The study lights "the outer
    // magenta pip of the side it is turning towards", and on both chassis that
    // is what this picks.
    const axis = cols / 2;
    const mid = rows / 2;
    const side = (cells, dir) => cells
        .filter(([c]) => (dir < 0 ? c + 0.5 < axis : c + 0.5 > axis))
        .sort((a, b) => (b[1] - a[1]) || (Math.abs(b[0] + 0.5 - axis) - Math.abs(a[0] + 0.5 - axis)))
        .slice(0, DRONE_ANIM.tell.cells);
    // A radial chassis paints the accent in all four quadrants -- those cells
    // are its arms. DRONE-A only paints it under the hull, so it fails this and
    // keeps the lean. Nothing here knows a sprite by name.
    const quads = [[], [], [], []];
    for (const cell of lamps) {
        quads[(cell[0] + 0.5 < axis ? 0 : 1) + (cell[1] + 0.5 < mid ? 0 : 2)].push(cell);
    }
    const radial = quads.every((q) => q.length > 0);
    const reach = ([c, r]) => Math.hypot(c + 0.5 - axis, r + 0.5 - mid);
    // Each arm, innermost cell first, so the last one is always the tip.
    const arms = radial ? quads.map((q) => q.slice().sort((a, b) => reach(a) - reach(b))) : [];
    geo = {
        name, grid, cols, rows, depth, rungs, axis, radial, arms, eyes,
        lamps: { "-1": side(lamps, -1), 1: side(lamps, 1) },
        // The shear only ever moves a row sideways, so DRONE-A needs one cell
        // of padding and no more. A turning arm leaves the grid on both axes.
        pad: { x: 1, y: 0 },
        turn: [],
    };
    if (radial) {
        const steps = DRONE_ANIM.spin.steps;
        let overX = 1;
        let overY = 0;
        for (let s = 0; s < steps; s++) {
            const ang = (s * 2 * Math.PI) / steps;
            const cos = Math.cos(ang);
            const sin = Math.sin(ang);
            const rot = ([c, r]) => {
                const dx = c + 0.5 - axis;
                const dy = r + 0.5 - mid;
                return [
                    Math.round(axis + dx * cos - dy * sin - 0.5),
                    Math.round(mid + dx * sin + dy * cos - 0.5),
                ];
            };
            const turned = arms.map((arm) => cellLine(rot(arm[0]), rot(arm[arm.length - 1])));
            const tips = { "-1": [], 1: [] };
            for (const arm of turned) {
                // The arms sit at +-39 degrees and turn in 45 degree steps, so
                // no arm ever lands on the vertical axis: every step has
                // exactly two of them on each side.
                const tip = arm[arm.length - 1];
                tips[tip[0] + 0.5 < axis ? -1 : 1].push(
                    ...arm.slice(Math.max(0, arm.length - DRONE_ANIM.spin.tips))
                );
                for (const [c, r] of arm) {
                    overX = Math.max(overX, -c, c - cols + 1);
                    overY = Math.max(overY, -r, r - rows + 1);
                }
            }
            geo.turn.push({ arms: turned, eyes: eyes.map(rot), tips });
        }
        geo.pad = { x: overX, y: overY };
    }
    geometry.set(name, geo);
    return geo;
}

/** A rotation step wrapped into the baked range: `t` grows without bound. */
function spinStep(step) {
    const steps = DRONE_ANIM.spin.steps;
    return ((step % steps) + steps) % steps;
}

/**
 * The cells of a line between two of them, both ends included.
 *
 * An arm is turned by moving its two ends and drawing the line back in, not by
 * rotating each of its cells: the hull is 16x13, so its centre sits on a half
 * cell in y, and rotating cell by cell rounds three neighbours onto a ragged,
 * sometimes broken run. A line keeps the arm connected and keeps its length,
 * which is what the silhouette is read from -- and on the step where nothing
 * has turned yet it lays the cells back exactly where the sprite painted them.
 *
 * @param {Array} a inner end, `[c, r]`
 * @param {Array} b outer end
 * @returns {Array} cells from `a` to `b`
 */
function cellLine(a, b) {
    const out = [];
    let [c, r] = a;
    const dc = Math.abs(b[0] - c);
    const dr = -Math.abs(b[1] - r);
    const sc = c < b[0] ? 1 : -1;
    const sr = r < b[1] ? 1 : -1;
    let err = dc + dr;
    for (let guard = 0; guard < 64; guard++) {
        out.push([c, r]);
        if (c === b[0] && r === b[1]) {
            break;
        }
        const e2 = 2 * err;
        if (e2 >= dr) {
            err += dr;
            c += sc;
        }
        if (e2 <= dc) {
            err += dc;
            r += sr;
        }
    }
    return out;
}

/** Walk a palette index `steps` rungs up the ramp, folded onto this hull's own colours. */
function promote(geo, ch, steps) {
    const rung = RUNG[ch];
    if (rung == null) {
        return ch;
    }
    return RAMP_CHARS[geo.rungs[Math.max(0, Math.min(TOP, rung + steps))]];
}

/**
 * How far a row slides at a given tilt. The lean is whole cells, so it is
 * applied to the grid before the raster is painted; the turn lamps are drawn on
 * top of that raster, which is why this has to be one function and not two.
 */
function shearOf(geo, tilt, row) {
    if (!tilt) {
        return 0;
    }
    const D = DRONE_ANIM.drift;
    const dir = tilt < 0 ? -1 : 1;
    if (row < geo.rows * D.topRows) {
        return dir;
    }
    if (Math.abs(tilt) >= D.levels && row > geo.rows * D.botRows) {
        return -dir;
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* The atlas: one canvas per (chassis, tint, px, tier, tilt, mode)     */
/* ------------------------------------------------------------------ */

const atlas = new Map();

/**
 * Bake one frame. The grid is transformed cell by cell -- eyes, hull tier,
 * lean -- and only then painted, so every pixel lands on a whole pixel and the
 * result is still pixel art. One cell of padding on each side, so a leaning row
 * never falls off the edge (and the hull stays centred, the padding is
 * symmetric).
 *
 * @param {Object} geo from `geometryOf`
 * @param {string} tint hex colour for indices 4/5/6
 * @param {number} px logical pixel size
 * @param {number} tier hull points, 1..`DRONE_ANIM.tiers.max`
 * @param {number} frame lean, -2..2 (DRONE-A) or rotation step, 0..7 (DRONE-B)
 * @param {string} mode "" | "flash" (hit silhouette) | "dark" (eyes out)
 *      | "core" (dark, and the arms have already come off)
 * @returns {HTMLCanvasElement}
 */
function bake(geo, tint, px, tier, frame, mode) {
    const { cols, rows, depth, radial } = geo;
    const cells = geo.grid.map((row) => row.split(""));
    const turn = radial ? geo.turn[frame] : null;
    const tilt = radial ? 0 : frame;
    const dir = tilt < 0 ? -1 : tilt > 0 ? 1 : 0;
    if (radial) {
        // The arms and the eyes come off the hull and go back on turned. The
        // body is left alone on purpose: it is a diamond, so turning it would
        // only cost it its pixels, and these two are what the eye tracks.
        for (const arm of geo.arms) {
            for (const [c, r] of arm) {
                cells[r][c] = ".";
            }
        }
        for (const [c, r] of geo.eyes) {
            cells[r][c] = TINT_CHAR;
        }
        geo.eyes.forEach(([c0, r0], i) => {
            const [c, r] = turn.eyes[i];
            // Same rule as the lean: an eye may not leave the silhouette.
            const on = r >= 0 && r < rows && c >= 0 && c < cols && cells[r][c] !== ".";
            cells[on ? r : r0][on ? c : c0] = GLASS_CHAR;
        });
    }
    // The eyes lead the lean: they move first and the hull follows.
    if (dir && mode !== "flash") {
        const eyes = [];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (cells[r][c] === GLASS_CHAR) {
                    eyes.push([c, r]);
                    cells[r][c] = TINT_CHAR;
                }
            }
        }
        for (const [c, r] of eyes) {
            const nc = c + dir * DRONE_ANIM.drift.eyeCells;
            // Only onto the hull: an eye may not slide out past the silhouette.
            cells[r][nc >= 0 && nc < cols && cells[r][nc] !== "." ? nc : c] = GLASS_CHAR;
        }
    }
    // Hull points: the core lights up outwards as the tier rises.
    const minDepth = DRONE_ANIM.tiers.depth[Math.min(tier, DRONE_ANIM.tiers.max) - 1] || 0;
    if (minDepth && mode !== "flash") {
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (cells[r][c] === TINT_CHAR && depth[r][c] >= minDepth) {
                    cells[r][c] = promote(geo, TINT_CHAR, DRONE_ANIM.tiers.lift);
                }
            }
        }
    }
    // A wreck's eyes are out: the glass goes to the bottom of the ramp.
    if (mode === "dark" || mode === "core") {
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (cells[r][c] === GLASS_CHAR) {
                    cells[r][c] = promote(geo, GLASS_CHAR, -TOP);
                }
            }
        }
    }
    const cv = document.createElement("canvas");
    const pad = geo.pad;
    cv.width = Math.max(1, Math.round((cols + 2 * pad.x) * px));
    cv.height = Math.max(1, Math.round((rows + 2 * pad.y) * px));
    const g = cv.getContext("2d");
    const pal = palette(tint);
    const size = Math.ceil(px);
    for (let r = 0; r < rows; r++) {
        const shift = shearOf(geo, tilt, r);
        for (let c = 0; c < cols; c++) {
            const ch = cells[r][c];
            const col = pal[ch];
            if (!col) {
                continue;
            }
            // Same hit silhouette the sprite bank paints, so a flashing drone
            // looks exactly like every other flashing hull in the game.
            g.fillStyle = mode === "flash"
                ? (ch === "1" || ch === "9" ? "#ffb9f2" : "#ffffff")
                : col;
            g.fillRect(
                Math.round((c + pad.x + shift) * px),
                Math.round((r + pad.y) * px),
                size, size
            );
        }
    }
    if (radial && mode !== "core") {
        // The arms, wherever this step put them -- including off the body,
        // which is what the padding is for.
        g.fillStyle = mode === "flash" ? "#ffffff" : pal[ACCENT_CHAR];
        for (const arm of turn.arms) {
            for (const [c, r] of arm) {
                g.fillRect(
                    Math.round((c + pad.x) * px),
                    Math.round((r + pad.y) * px),
                    size, size
                );
            }
        }
    }
    return cv;
}

const colours = new Map();

/**
 * A colour painted straight onto the frame rather than into a raster, resolved
 * once. `palette()` builds a fresh object on every call, and these run per hull
 * per frame -- the whole point of the kit is that a drone costs nothing.
 *
 * @param {Object} geo from `geometryOf`
 * @param {string} tint hull colour
 * @param {string} ch palette index to start from
 * @param {number} lift rungs to promote it by
 * @returns {string} CSS colour
 */
function colourOf(geo, tint, ch, lift) {
    const key = geo.name + "|" + tint + "|" + ch + "|" + lift;
    let col = colours.get(key);
    if (!col) {
        col = palette(tint)[promote(geo, ch, lift)];
        colours.set(key, col);
    }
    return col;
}

/**
 * A baked frame, from the atlas (baked on first use). `frame` is the lean on
 * DRONE-A and the rotation step on DRONE-B, already wrapped.
 */
function raster(name, tint, px, tier, frame, mode) {
    // The flash silhouette hides the tier, so it is one frame per pose.
    const key = name + "|" + tint + "|" + px + "|" + (mode === "flash" ? 0 : tier)
        + "|" + frame + "|" + mode;
    let cv = atlas.get(key);
    if (!cv) {
        cv = bake(geometryOf(name), tint, px, tier, frame, mode);
        atlas.set(key, cv);
    }
    return cv;
}

/**
 * A palette index in the sprite bank's own colour. `colourOf` walks the ramp,
 * which folds the accent onto the tint it shares a rung with -- right for a
 * lamp lighting up, wrong for an arm that is only ever its own colour.
 *
 * @param {string} tint hull colour
 * @param {string} ch palette index
 * @returns {string} CSS colour
 */
function rawColour(tint, ch) {
    const key = "raw|" + tint + "|" + ch;
    let col = colours.get(key);
    if (!col) {
        col = palette(tint)[ch];
        colours.set(key, col);
    }
    return col;
}

/* ------------------------------------------------------------------ */
/* The shared timeline                                                 */
/* ------------------------------------------------------------------ */

/** Hull points as a tier: everything past the top tier reads as the top tier. */
export function droneTier(hp) {
    return Math.max(1, Math.min(DRONE_ANIM.tiers.max, Math.round(hp)));
}

/**
 * The whole animation, sampled from the drone's own zigzag clock. This is the
 * single shared timeline: `t` is `e.t`, which the engine seeds at random per
 * hull and advances with `mv`, so it carries the phase offset, the pause, the
 * slow-mo and the EMP freeze all at once. Nothing here is stored per drone.
 *
 * @param {number} t the enemy's frame clock (`e.t`)
 * @returns {Object} `{ tilt, step, spinRate, tell, tellOn, vx }` -- lean level
 *      -2..2, the rotation step (unwrapped) and the rate it is turning at, the
 *      side it is about to turn towards (-1 left, 1 right, 0 not yet), whether
 *      the lamp is lit this frame, and the drift velocity in px/frame.
 */
export function dronePose(t) {
    const D = DRONE_ANIM.drift;
    const a = t * D.rate;
    const v = Math.sin(a);
    const tilt = Math.max(-D.levels, Math.min(D.levels, Math.round(v * D.levels)));
    // The drift reverses every time the sine crosses zero: how far that is, in
    // frames, is the whole of the telegraph.
    const phase = ((a % Math.PI) + Math.PI) % Math.PI;
    const toTurn = (Math.PI - phase) / D.rate;
    const T = DRONE_ANIM.tell;
    const tell = toTurn <= T.frames ? (v >= 0 ? -1 : 1) : 0;
    // The radial chassis turns instead of leaning. Both are read off the same
    // sine, so neither can end up pointing away from the drift.
    const S = DRONE_ANIM.spin;
    const angle = t * S.rate - Math.cos(a) * S.swing;
    return {
        tilt, tell,
        step: Math.round((angle * S.steps) / (2 * Math.PI)),
        spinRate: S.rate + S.swing * D.rate * v,
        tellOn: !!tell && Math.floor(t / T.blink) % 2 === 0,
        vx: v * D.ampPx,
    };
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

/**
 * One drone: a baked frame plus, while it is announcing a turn, its lamps.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {Object} o
 * @param {string} o.name sprite key ("drone0"/"drone1")
 * @param {string} o.tint hull colour
 * @param {number} o.px logical pixel size
 * @param {number} o.x centre
 * @param {number} o.y centre
 * @param {number} o.t the enemy's frame clock
 * @param {number} o.hp hull points left
 * @param {boolean} [o.flash] the hit silhouette
 */
export function drawDrone(g, o) {
    const geo = geometryOf(o.name);
    const pose = dronePose(o.t || 0);
    const tier = droneTier(o.hp);
    const frame = geo.radial ? spinStep(pose.step) : pose.tilt;
    const cv = raster(o.name, o.tint, o.px, tier, frame, o.flash ? "flash" : "");
    const x0 = Math.round(o.x - cv.width / 2);
    const y0 = Math.round(o.y - cv.height / 2);
    // Set and put back rather than save/restore: this runs on every hull on
    // screen, and the rest of the game leaves the flag alone (`drawSprite`
    // brackets its own), so the two assignments keep that invariant for the
    // price of two, instead of a full state push and pop.
    g.imageSmoothingEnabled = false;
    g.drawImage(cv, x0, y0);
    if (!pose.tellOn || o.flash) {
        g.imageSmoothingEnabled = true;
        return;
    }
    // DRONE-A announces the turn with the two pips under the hull; DRONE-B
    // with the tips of the two arms currently on that side, which is a
    // different pair of cells at every step of the rotation.
    const lamps = geo.radial ? geo.turn[frame].tips[pose.tell] : geo.lamps[pose.tell];
    const px = o.px;
    const size = Math.ceil(px);
    const pad = geo.pad;
    // The lean is baked into the frame under these, so the lamps have to take
    // the same shift or they come off the cell they are meant to be lighting.
    // A radial hull is baked at no lean at all, and its tips must not move.
    const tilt = geo.radial ? 0 : pose.tilt;
    g.fillStyle = colourOf(geo, o.tint, ACCENT_CHAR, DRONE_ANIM.tell.lift);
    for (const [c, r] of lamps) {
        g.fillRect(
            x0 + Math.round((c + pad.x + shearOf(geo, tilt, r)) * px),
            y0 + Math.round((r + pad.y) * px),
            size, size
        );
    }
    g.imageSmoothingEnabled = true;
}

/** Frames of a card's loop sampled to find the box its art needs. */
const CARD_FRAMES = 420;

/**
 * The card art for the catalogue, on the same terms as `fryCard`: the chassis
 * animating on its own shared timeline, on a canvas measured from the union of
 * everything the loop paints, so the card shows the drone the glossary line
 * describes -- the lean or the turn, and the lamps announcing a reversal --
 * rather than a still hull.
 *
 * @param {Object} o `{ sprite, tint, px }` from the catalogue entry
 * @returns {Object} `{ width, height, draw(g, t) }`, sizes in device pixels
 */
export function droneCard(o) {
    // The catalogue calls the sprite key `sprite`, the animator calls it `name`.
    const name = o.sprite || o.name;
    const geo = geometryOf(name);
    const px = o.px;
    const margin = 4;
    const W = Math.round((geo.cols + 2 * margin) * px);
    const H = Math.round((geo.rows + 2 * margin) * px);
    const probe = document.createElement("canvas");
    probe.width = W;
    probe.height = H;
    const pg = probe.getContext("2d");
    // Hull points in the middle of the range, so the card shows a core with
    // light in it and still has somewhere to go in both directions.
    const hp = 3;
    for (let t = 0; t < CARD_FRAMES; t++) {
        drawDrone(pg, { name, tint: o.tint, px, x: W / 2, y: H / 2, t, hp });
    }
    const box = canvasBounds(probe, Math.round(px)) || { x: 0, y: 0, w: W, h: H };
    const ox = W / 2 - box.x;
    const oy = H / 2 - box.y;
    return {
        width: box.w,
        height: box.h,
        draw(g, t) {
            drawDrone(g, { name, tint: o.tint, px, x: ox, y: oy, t, hp });
        },
    };
}

/**
 * The radial break-up: DRONE-B lets go of its four arms and then folds.
 *
 * The arms slide out along their own bearing and keep turning at the rate the
 * chassis was turning at, which is the whole of "conserving the angular
 * momentum" at this size -- the tumble is what says the thing was spinning. The
 * core is drawn from the atlas with the arms already off it, and is the last
 * thing to go, so the silhouette reads as a cross that came apart rather than a
 * sprite that was swapped for debris.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {Object} w the wreck record
 * @param {Object} geo from `geometryOf`
 * @param {Object} pose from `dronePose`, at the clock it died on
 * @param {number} frame rotation step it died at
 * @param {number} k 0..1 through the break-up
 */
function radialWreck(g, w, geo, pose, frame, k) {
    const D = DRONE_ANIM.death;
    const px = w.px;
    const size = Math.max(1, Math.ceil(px));
    const inertia = pose.vx * k * D.inertiaCells * px;
    g.save();
    if (k > D.fadeFrom) {
        g.globalAlpha = Math.max(0, 1 - (k - D.fadeFrom) / (1 - D.fadeFrom));
    }
    // The core holds its shape for most of the animation, then collapses.
    const scale = k < D.coreHold ? 1 : Math.max(0, 1 - (k - D.coreHold) / (1 - D.coreHold));
    if (scale > 0) {
        const cv = raster(w.name, w.tint, px, w.tier, frame, "core");
        g.save();
        g.translate(w.x + inertia, w.y);
        g.scale(scale, scale);
        g.drawImage(cv, -Math.round(cv.width / 2), -Math.round(cv.height / 2));
        g.restore();
    }
    // The arms: the same cells of the same sprite, further out and further
    // round. No particle system and nothing random, so both roles agree.
    const spin = k * pose.spinRate * (D.frames - D.hold) * D.armSpin;
    const out = k * D.armCells;
    g.fillStyle = rawColour(w.tint, ACCENT_CHAR);
    for (const arm of geo.turn[frame].arms) {
        for (const [c, r] of arm) {
            const dx = c + 0.5 - geo.cols / 2;
            const dy = r + 0.5 - geo.rows / 2;
            const rad = Math.hypot(dx, dy) + out;
            const ang = Math.atan2(dy, dx) + spin;
            g.fillRect(
                Math.round(w.x + Math.cos(ang) * rad * px + inertia - px / 2),
                Math.round(w.y + Math.sin(ang) * rad * px - px / 2),
                size, size
            );
        }
    }
    g.restore();
}

/**
 * A dead drone. The one animation in the kit that is worth frames: it is seen
 * hundreds of times in a run, and it is the only feedback that the hull the
 * player was shooting at is actually gone.
 *
 * It is a pure function of the wreck's age, so it allocates nothing, runs
 * identically on a host and a guest, and needs no state beyond the five numbers
 * `game_engine.js` keeps per wreck.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {Object} w `{ name, tint, px, x, y, t, tier, t0 }` -- `t` is the age
 *      of the wreck in frames and `t0` the drone's own clock when it died,
 *      which is all the pose it was in (and the drift it keeps) is read from.
 */
export function drawDroneWreck(g, w) {
    const D = DRONE_ANIM.death;
    if (w.t >= D.frames) {
        return;
    }
    const geo = geometryOf(w.name);
    const pose = dronePose(w.t0 || 0);
    const px = w.px;
    g.imageSmoothingEnabled = false;
    const frame = geo.radial ? spinStep(pose.step) : pose.tilt;
    if (w.t < D.hold) {
        // The eyes go out before anything moves: two frames of white, then the
        // hull sitting there dark for a beat. That beat is what makes the break
        // read as a break instead of a sprite being replaced by particles.
        const cv = raster(w.name, w.tint, px, w.tier, frame, w.t < D.flash ? "flash" : "dark");
        g.drawImage(cv, Math.round(w.x - cv.width / 2), Math.round(w.y - cv.height / 2));
        g.imageSmoothingEnabled = true;
        return;
    }
    const k = (w.t - D.hold) / (D.frames - D.hold);
    if (geo.radial) {
        radialWreck(g, w, geo, pose, frame, k);
        g.imageSmoothingEnabled = true;
        return;
    }
    const cv = raster(w.name, w.tint, px, w.tier, 0, "dark");
    const half = Math.round(cv.width / 2);
    const inertia = pose.vx * k * D.inertiaCells * px;
    const drop = k * k * D.dropCells * px;
    const spread = k * D.spreadCells * px;
    g.save();
    if (k > D.fadeFrom) {
        g.globalAlpha = Math.max(0, 1 - (k - D.fadeFrom) / (1 - D.fadeFrom));
    }
    // The chassis comes apart on its own axis of symmetry: the same half of the
    // same raster, mirrored around the centre line the sprite was drawn about.
    for (const dir of [-1, 1]) {
        g.save();
        g.translate(w.x + dir * spread + inertia, w.y + drop);
        g.rotate(k * D.spin * dir);
        g.drawImage(
            cv, dir < 0 ? 0 : half, 0, half, cv.height,
            dir < 0 ? -half : 0, -Math.round(cv.height / 2), half, cv.height
        );
        g.restore();
    }
    // Hull fragments. Four rectangles of the hull's own colour on fixed
    // bearings: no particle system, and nothing random, so both roles draw the
    // same wreck.
    g.fillStyle = colourOf(geo, w.tint, TINT_CHAR, 0);
    const size = Math.max(1, Math.round(D.shardSize * px));
    for (let i = 0; i < D.shards; i++) {
        const a = i * 1.9 + 0.4;
        const r = k * D.shardCells * px;
        g.fillRect(
            Math.round(w.x + Math.cos(a) * r + inertia * 0.6),
            Math.round(w.y + Math.sin(a) * r * 0.7 + drop * 0.8),
            size, size
        );
    }
    g.restore();
    g.imageSmoothingEnabled = true;
}
