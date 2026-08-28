/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - DRONE-A animation kit (RENDER side).
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
 */

import { RAMP_CHARS, RUNG, TINT_RUNGS, palette, spriteGrid } from "./sprites";

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
    // that is already somewhere on this hull. Same fold as `hullGeometry` in
    // `colossus_animator.js`: an unused rung goes to the nearest used one, and
    // the three tint shades are always the hull's own colour.
    const used = new Uint8Array(TOP + 1);
    const lamps = [];
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
        }
    }
    const rungs = new Int8Array(TOP + 1);
    for (let i = 0; i <= TOP; i++) {
        rungs[i] = i;
        if (used[i] || TINT_RUNGS.indexOf(i) >= 0) {
            continue;
        }
        let best = i;
        let bestD = TOP + 1;
        for (let j = 0; j <= TOP; j++) {
            if (used[j] && Math.abs(j - i) < bestD) {
                bestD = Math.abs(j - i);
                best = j;
            }
        }
        rungs[i] = best;
    }
    // Turn lamps: lowest first, then most outboard. The study lights "the outer
    // magenta pip of the side it is turning towards", and on both chassis that
    // is what this picks.
    const axis = cols / 2;
    const side = (cells, dir) => cells
        .filter(([c]) => (dir < 0 ? c + 0.5 < axis : c + 0.5 > axis))
        .sort((a, b) => (b[1] - a[1]) || (Math.abs(b[0] + 0.5 - axis) - Math.abs(a[0] + 0.5 - axis)))
        .slice(0, DRONE_ANIM.tell.cells);
    geo = {
        name, grid, cols, rows, depth, rungs, axis,
        lamps: { "-1": side(lamps, -1), 1: side(lamps, 1) },
    };
    geometry.set(name, geo);
    return geo;
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
 * @param {number} tilt -2..2
 * @param {string} mode "" | "flash" (hit silhouette) | "dark" (eyes out)
 * @returns {HTMLCanvasElement}
 */
function bake(geo, tint, px, tier, tilt, mode) {
    const { cols, rows, depth } = geo;
    const cells = geo.grid.map((row) => row.split(""));
    const dir = tilt < 0 ? -1 : tilt > 0 ? 1 : 0;
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
    if (mode === "dark") {
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (cells[r][c] === GLASS_CHAR) {
                    cells[r][c] = promote(geo, GLASS_CHAR, -TOP);
                }
            }
        }
    }
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round((cols + 2) * px));
    cv.height = Math.max(1, Math.round(rows * px));
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
            g.fillRect(Math.round((c + 1 + shift) * px), Math.round(r * px), size, size);
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

/** A baked frame, from the atlas (baked on first use). */
function raster(name, tint, px, tier, tilt, mode) {
    // The flash silhouette hides the tier, so it is one frame per lean.
    const key = name + "|" + tint + "|" + px + "|" + (mode === "flash" ? 0 : tier)
        + "|" + tilt + "|" + mode;
    let cv = atlas.get(key);
    if (!cv) {
        cv = bake(geometryOf(name), tint, px, tier, tilt, mode);
        atlas.set(key, cv);
    }
    return cv;
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
 * @returns {Object} `{ tilt, tell, tellOn, vx }` -- lean level -2..2, the side
 *      it is about to turn towards (-1 left, 1 right, 0 not yet), whether the
 *      lamp is lit this frame, and the drift velocity in px/frame.
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
    return {
        tilt, tell,
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
    const pose = dronePose(o.t || 0);
    const tier = droneTier(o.hp);
    const cv = raster(o.name, o.tint, o.px, tier, pose.tilt, o.flash ? "flash" : "");
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
    const geo = geometryOf(o.name);
    const lamps = geo.lamps[pose.tell];
    const px = o.px;
    const size = Math.ceil(px);
    g.fillStyle = colourOf(geo, o.tint, ACCENT_CHAR, DRONE_ANIM.tell.lift);
    for (const [c, r] of lamps) {
        g.fillRect(
            x0 + Math.round((c + 1 + shearOf(geo, pose.tilt, r)) * px),
            y0 + Math.round(r * px),
            size, size
        );
    }
    g.imageSmoothingEnabled = true;
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
    if (w.t < D.hold) {
        // The eyes go out before anything moves: two frames of white, then the
        // hull sitting there dark for a beat. That beat is what makes the break
        // read as a break instead of a sprite being replaced by particles.
        const cv = raster(w.name, w.tint, px, w.tier, pose.tilt, w.t < D.flash ? "flash" : "dark");
        g.drawImage(cv, Math.round(w.x - cv.width / 2), Math.round(w.y - cv.height / 2));
        g.imageSmoothingEnabled = true;
        return;
    }
    const k = (w.t - D.hold) / (D.frames - D.hold);
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
