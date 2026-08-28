/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - flight and combat animation for the colossal bosses.
 *
 * Ported from the design studies for AEGIS-01 (the Study, then the Animation
 * Sheet that reworked it) and for HYDRA-07 (its own Animation Sheet), which
 * arrived already respecting the render-only contract. Same shape as
 * `boss_animator.js`, one size up. Two of the five colossi are covered; the
 * other three fall through to the plain hull draw until they get a section of
 * their own (`COLOSSUS_ANIM_KINDS` is what decides).
 *
 * The sheet's one big idea is the **brightness ramp**: an effect never mixes a
 * colour, it promotes the pixel it lands on along the sprite bank's own palette
 * (see RAMP below). A slab 850 px wide covered in additive light stops reading
 * as pixel art after the second overlay; promotion cannot put a tone on screen
 * that the hull does not already have. Only the two effects that are glows
 * *around* the hull rather than on it (the enrage charge and its ring) are
 * still additive.
 *
 * Five deliberate departures from the studies:
 *
 *   1. **The hull stays the module's.** They shipped their own procedural grid
 *      (92x28, then 42x13) and painted it cell by cell. `colossus0` already
 *      exists in `sprites.js` with the ten-index palette where 4/5/6 are the
 *      tint, and it is what the glossary shows. So the hull is the cached
 *      raster, and only the cells an effect actually changes are painted on top
 *      of it -- and only when the promotion lands on a different rung, so the
 *      whole animation costs ~160 `fillRect`s in an average frame.
 *   2. **No lance.** The study gave AEGIS an eye that fires a 1100 px column of
 *      light at a ship. The engine has no such attack, and drawing a beam with
 *      no hitbox shows light where the damage is not -- the same reason
 *      `boss_animator.js` refused the LANCER beam.
 *   3. **No hit flash.** A colossus is under fire every frame, so that leaves
 *      it permanently washed out; the hit feedback stays the white burst at the
 *      point of impact plus the top bar.
 *   4. **The enrage beat is an envelope, not an observed flag.** `e.hold` does
 *      not travel in the snapshot, so `charge` runs off the `rage` cue for the
 *      50 frames `_bossRage` holds fire. Same beat on host and guest, no new
 *      bytes on the bus.
 *   5. **No state machine, and no DEATH.** The sheet drives itself through
 *      ENTRY/IDLE/LEAN/PLANT/CURTAIN/SALVO/STAGGER/DEATH and spawns its own
 *      bullets from it. Here the engine owns all of that: every one of those
 *      beats is *observed* (the plant from `tel`, the salvo from the cue, the
 *      stagger from `hp01`) so the animation cannot disagree with the fight.
 *      DEATH is dropped outright: it would need the corpse to outlive
 *      `killEnemy`, which is gameplay, not animation.
 *
 * HYDRA-07 arrived as a second sheet, and it did not describe the boss the
 * engine had: destructible side heads, attacks that take turns before the rage
 * and run together after it, a wind-up on the spiral and staggered fans were
 * all in the sheet and none of them in `_updateColossus`. That went the other
 * way round from AEGIS -- **the engine moved to meet the sheet** (see `_hydra`
 * and HYDRA_HEAD there), and what is left here is the animation of a boss that
 * now really does all of it. Only one thing was refused outright:
 *
 *   6. **Nothing moves that a cached raster cannot move.** The sheet redraws
 *      its monster every frame, so its heads swing on bezier arms and their
 *      snouts rotate to aim. Here a head says where it is looking by *where
 *      the light sits inside it* -- the promoted disc slides towards the ships,
 *      exactly as AEGIS's core slides with the lean -- the destroyed one goes
 *      dark and sparks at the stump instead of hanging from it, and the recoil
 *      is the whole hull, as it is for the siege salvo.
 *
 * The sheet's actual idea survived whole: three parts on beats of their own, so
 * the hull never pulses as one lamp; a crown whose ring of light turns with the
 * spiral it is firing and, during the wind-up, runs a single arc *the way the
 * coming spiral will turn*; and two heads that light, open and flash a beat
 * apart, because the stagger is the thing that makes two aimed cones readable.
 *
 * Everything else is **render only**: the engine (or, on a guest, the host
 * snapshot) owns position, hull points, every bullet and the telegraph. This
 * reads state that already travels -- x, y, hp01, tel, telK, `gap` (the hole in
 * the *next* curtain), the crown's angle and whether it is emitting (`sa`,
 * `sp`), the side heads (`hd`) and where the live ships are -- and derives the
 * rest from observed motion. Three of the sheet's states cost no cue at all:
 * a head's hull points travel, so a drop is a hit, zero is a destroyed head and
 * the countdown under it is the rebuild.
 *
 * State cannot live on the enemy object: a guest rebuilds `this.enemies` from
 * scratch on every snapshot, so the engine keeps these animators in a map keyed
 * by colossus index and feeds them (see `_updateColossusAnims`).
 */

import { palette, sprite, spriteGrid } from "./sprites";

/**
 * The brightness ramp, dark to bright, in sprite bank palette indices:
 * dark hull, dark accent, mid hull, dark tint, metal, TINT, light tint, glass,
 * hot white. The neon accent (8) shares the tint's rung, so the strip along the
 * shoulder flares with the plating instead of against it.
 *
 * Effects do not add a rung, they pull a cell a fraction of the way to the top
 * (or, negative, back down towards the dark hull). Rung counting would make an
 * effect land differently on every cell it crosses -- lighting the bottom edge
 * of AEGIS by "+2" barely moves its dark plating while blowing out the glass
 * two rows above it.
 */
const RAMP_CHARS = ["1", "9", "2", "5", "3", "4", "6", "7", "0"];
const RUNG = { 1: 0, 9: 1, 2: 2, 5: 3, 3: 4, 4: 5, 8: 5, 6: 6, 7: 7, 0: 8 };
const TOP = RAMP_CHARS.length - 1;

/** Hull cells the damage burns out: mid hull and metal, never the tint. */
const DEAD_CHARS = "23";
/** Hull cells that make up the core window: glass and hot white. */
const CORE_CHARS = "70";
/** The neon accent: the one index the sprite bank paints magenta on any hull. */
const ACCENT_CHAR = "8";
/**
 * The three rungs that are shades of the hull's own tint (5 dark, 4 flat, 6
 * light). They belong on any hull whether or not the art happens to use them;
 * every other rung is a fixed colour, and one the art never uses has no
 * business appearing under an effect (see `rungs` in `hullGeometry`).
 */
const TINT_RUNGS = [RUNG[5], RUNG[4], RUNG[6]];
/**
 * How far out of a part's own ellipse the ring of light sits: past this it is
 * the plating around the face, under it the face itself. 0.62 on HYDRA's crown
 * takes the horns, the sides and the collar and leaves the two eyes alone.
 */
const RING_INNER = 0.62;
/**
 * How far around its mouth a side head reaches, in multiples of the mouth's own
 * radius. 3 takes HYDRA's skull and wrist and stops at the forearm, which is
 * what the hitbox in `game_engine.js` is cut from -- so what you can shoot and
 * what lights up are the same cells, read from the same art.
 */
const HEAD_SPAN = 3;

/**
 * Reference speeds are the ones `aegis_motion.js` actually produces, measured
 * over a full 120 s fight: |v| peaks at 58 px/s (36 calm, 54 raged, more only
 * during the enrage shove) and a tick never moves the hull by a whole pixel.
 * On a guest the same positions arrive rounded to whole px at ~15 Hz, which is
 * why the derived velocity is smoothed hard rather than used raw.
 */
export const COLOSSUS_ANIM = {
    global: {
        velRefPx: 60,       // px/s that maps to |vx01| = 1
        velSmooth: 9,       // 1/s exponential ease on the derived velocity
        boolIn: 11,         // 1/s rise for a boolean eased into 0..1
        boolOut: 5,         // 1/s fall
        teleportPx: 24,     // a bigger step is a teleport: drop the velocity
        maxDt: 0.1,
        maxSparks: 48,      // hard cap on cosmetic particles
    },
    AEGIS: {
        breathe: { amp: 0.012, rate: 0.85, loadTilt: 0.35 },
        // The lean has two terms because the drift alone is not a pose: AEGIS
        // is stationary 95% of the fight (|v| p50 0.5 px/s, p95 13 px/s -- the
        // 54 px/s peak only happens on the enrage shove), so a lean driven by
        // velocity is invisible exactly when the catalogue promises "it leans
        // toward whoever is still flying". `aimGain` is that promise: the hull
        // tips towards the centre of mass of the live ships, which both roles
        // already have. `aimSpanPx` is a flank of the widened field.
        lean: { maxRad: 0.028, velGain: 1, aimGain: 0.7, aimSpanPx: 300, aimSmooth: 2.2, smooth: 6 },
        recoil: { px: 14, fall: 3.2 },
        barrel: { life: 0.22, rows: 3, lift: 1 },
        curtain: { sweepSec: 0.3, rows: 2, tail: 0.28, lift: 0.9 },
        // The shutter that announces the hole in the next curtain. 7 cells is
        // 63 px against the 124 px the pattern actually skips, deliberately
        // narrower for the same reason the telegraph mark is: what it points
        // at is always safe.
        port: { wCells: 7, top: 7, bottom: 19, bloomCells: 2, lift: 0.62, flicker: 0.28 },
        // The brace: the whole hull answering a telegraph, not just the shutter
        // lighting up. `aegis_motion.js` already stops the slab for the 0.75 s
        // of a curtain warning; this is what that stop looks like.
        plant: { squareUp: 0.55, judderCells: 1, judderHz: 6.5, emitDrop: 0.7 },
        // The core window (the glass lens at the centre of the hull). It
        // breathes, it saturates as an attack is charged, it is pushed towards
        // the side the slab leans to, and it goes cold as the hull fails --
        // AEGIS reads at a glance from a single bright shape.
        //
        // These numbers are set against the ramp, not carried over: the lens is
        // glass, one rung under white, so a cell only changes at all above
        // k = 0.5, and the study's 0.18..0.50 breath was a pulse that never
        // once lit a pixel. 0.5..0.9 crosses that line inside the lens and the
        // distance falloff turns the crossing into a ring growing from the
        // middle. `jitter` has to reach past 0 for the same reason: only a
        // negative k can push glass back down to metal.
        core: { base: 0.5, pulse: 0.4, rate: 0.55, sat: 0.5, squeeze: 0.34,
                biasCells: 2.4, flashSec: 0.12, jitter: 1, dim: 1.2 },
        // Plumes hang off the four nozzle clusters the hull actually has (the
        // only columns that reach below its bottom edge), the outer pair phase
        // shifted against the inner one so the slab never pulses as one lamp.
        emitters: { period: 0.77, amp: 0.45, idle: 0.45, outerPhase: 0.5,
                    maxCells: 5, tiltCells: 2, jitter: 0.35, velGain: 1 },
        damage: {
            start: 0.3,     // hp01 under which the hull starts failing
            shakePx: 5, shakeHz: 17,
            deadCells: 30,  // % of the hull's dark cells burnt out at 0 hull
            ventRate: 9, sparkLife: 0.55, sparkSpeed: 26,
        },
        // The arrival. `_updateColossus` slides the hull down at 78 px/s and
        // AEGIS never moves vertically faster than ~20 px/s once it is flying,
        // so the descent is the one thing a velocity threshold can name without
        // a byte on the bus. `landed` latches it: it can only ever happen once.
        entry: { vy: 45, span: 33, burn: 0.9 },
        // 0.83 s: the 50 frames `_bossRage` holds fire on a colossus.
        rage: { holdSec: 0.83, flareSec: 0.9, ringCells: 6 },
        charge: { max: 0.55, bands: 12, falloff: 1.4 },
    },
    HYDRA: {
        breathe: { amp: 0.013, rate: 0.7, loadTilt: 0.4 },
        // HYDRA actually travels -- a flat 38 px/s across a 210 px lane, with
        // the direction flipping at the ends -- so unlike AEGIS the drift is
        // the main term of the lean and the pull towards the ships only tips
        // it. The catalogue promises the *heads* aim, not the hull.
        lean: { maxRad: 0.032, velGain: 1, aimGain: 0.25, aimSpanPx: 320, aimSmooth: 2.6, smooth: 5 },
        recoil: { px: 11, fall: 3.6 },
        // HYDRA telegraphs one thing (the fan), so the brace *is* the wind-up:
        // the hull judders, the crown saturates and both mouths open on it.
        plant: { squareUp: 0.25, judderCells: 1, judderHz: 7.5, emitDrop: 0 },
        // The crown lens, on the same machinery as AEGIS's core window and set
        // against the same ramp: the eyes are glass around a white middle, so
        // nothing repaints at all under k = 0.5, and the idle breath is tuned
        // to cross it only near its peak. At rest the crown is exactly the
        // sprite; it blinks once every 2.7 s. `squeeze` is 0 because HYDRA's
        // lens has no charge to shrink for -- the crown never stops firing.
        core: { base: 0.4, pulse: 0.22, rate: 0.37, sat: 0.35, squeeze: 0,
                falloff: 0.45, biasCells: 1.6, flashSec: 0, jitter: 0.9, dim: 1.1 },
        // The ring of light on the crown's plating, turning with the spiral.
        // `cut` is what keeps it arcs instead of a halo: at 0.6 each of the two
        // arms lights ~68 deg of the ellipse (~48 with the third arm of the
        // enrage), and the square falloff puts the bright end of the arc on the
        // cells the bullets are leaving from.
        // The ring of light on the crown's plating. It only burns while the
        // crown is actually emitting; during the wind-up it runs a single arc
        // around the ring instead, *in the direction the coming spiral turns*,
        // which is the one thing the warning has to say.
        ring: { lift: 0.8, cut: 0.6, rageLift: 0.15,
                warnLift: 0.7, warnCut: 0.72, seqRate: 1.6, idle: 0.12 },
        // The side heads. Different rates half a period apart, which is the one
        // thing from the sheet that had to survive even though neither head can
        // move: three parts that never light together. `openCells` is the mouth
        // opening -- the promoted disc grows past the glass into the plating as
        // the fan winds up -- and `biasCells` is the only aiming a cached
        // raster can do.
        heads: { idle: 0.16, pulse: 0.5, rate: [0.31, 0.35], phase: [0, 0.5],
                 charge: 0.55, rage: 0.12, falloff: 0.35, openCells: 2.2,
                 biasCells: 1.8, aimSpanPx: 260, aimSmooth: 3.2, dim: 1,
                 flashSec: 0.16, flameCells: 4, flameTilt: 2,
                 // Local damage: 4 frames of the hit head alone going white,
                 // while the other two parts carry on. A colossus has no hull
                 // flash on purpose (it is under fire every frame); a part you
                 // have to deliberately fly out and shoot is the one place the
                 // feedback belongs.
                 hurtSec: 0.07,
                 // Destroyed: pulled this far back *down* the ramp, which is
                 // the only direction that reads as "off" on art this dark.
                 dead: 0.62, stumpRate: 13, stumpCells: 3,
                 // The rebuild grows out of the stump with a lit front, and the
                 // eyes are the last thing to come back.
                 growFront: 0.18, growLift: 0.8, eyesAt: 0.7 },
        // The chest grilles: the four bars the sprite already paints in the
        // neon accent. They ripple down the chest once per turn of the spiral,
        // which is the only thing the chest ever says about what the crown is
        // doing, and they drop away while the heads are winding up.
        vents: { idle: 0.08, amp: 0.46, rowPhase: 1.1, rage: 0.3, plantDrop: 0.5 },
        damage: {
            start: 0.3,
            shakePx: 5, shakeHz: 17,
            // Lower than AEGIS's 30: HYDRA's chest is 412 cells of mid hull
            // against AEGIS's 340 of mid hull and metal, so the same percentage
            // puts noticeably more of the silhouette out.
            deadCells: 24,
            ventRate: 9, sparkLife: 0.55, sparkSpeed: 26,
        },
        // Same descent as AEGIS: `_updateColossus` slides every colossus in at
        // 78 px/s, and HYDRA never moves vertically again once it is in its
        // lane, so the threshold names the arrival without a byte on the bus.
        entry: { vy: 45, span: 33 },
        // 0.83 s: the 50 frames `_bossRage` holds fire. HYDRA rears up over
        // that beat instead of AEGIS's shove, and settles as the guns come back.
        rage: { holdSec: 0.83, flareSec: 0.9, ringCells: 6, archPx: 9 },
        charge: { max: 0.5, bands: 12, falloff: 1.2 },
    },
};

/** Index into COLOSSI -> section above. A colossus with no section is drawn plain. */
export const COLOSSUS_ANIM_KINDS = ["AEGIS", "HYDRA"];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const smoothstep = (v) => v * v * (3 - 2 * v);

/** Pull a rung `k` of the way to hot white, or (k < 0) back down to dark hull. */
const lift = (rung, k) => (k >= 0 ? rung + (TOP - rung) * k : rung * (1 + k));

/** Stable 0..1 noise for a cell, so the burnt sections never crawl. */
function cellNoise(c, r) {
    const n = (((c * 73856093) ^ (r * 19349663)) >>> 0) % 100000;
    return n / 100000;
}

const geometry = new Map();

/**
 * Bounding box of a flat [c, r, c, r, ...] cell list, with the radii an effect
 * needs to talk about "the outer third" of it. Null for an empty list.
 */
function cellBox(cells) {
    if (!cells.length) {
        return null;
    }
    let c0 = Infinity;
    let c1 = -Infinity;
    let r0 = Infinity;
    let r1 = -Infinity;
    for (let i = 0; i < cells.length; i += 2) {
        c0 = Math.min(c0, cells[i]);
        c1 = Math.max(c1, cells[i]);
        r0 = Math.min(r0, cells[i + 1]);
        r1 = Math.max(r1, cells[i + 1]);
    }
    return {
        c0, c1, r0, r1,
        cx: (c0 + c1) / 2, cy: (r0 + r1) / 2,
        rx: (c1 - c0) / 2 + 0.5, ry: (r1 - r0) / 2 + 0.5,
    };
}

/**
 * The crown: everything above the shoulder line, provided there is glass up
 * there. Returns the cells, the lens (the glass) with the distance of each of
 * its cells to the middle of it, and the ring -- the plating outside
 * RING_INNER, carrying the *true* angle of each cell (not the ellipse-normalised
 * one), because the lit arc has to point where the spiral arms actually fly.
 */
function crownOf(grid, cols, rows) {
    const mid = cols >> 1;
    let shoulder = 0;
    for (let r = 0; r < rows; r++) {
        if (grid[r][mid] === ".") {
            continue;
        }
        let a = mid;
        while (a > 0 && grid[r][a - 1] !== ".") {
            a--;
        }
        let b = mid;
        while (b < cols - 1 && grid[r][b + 1] !== ".") {
            b++;
        }
        if (b - a + 1 >= cols * 0.4) {
            shoulder = r;
            break;
        }
    }
    const cells = [];
    const core = [];
    for (let r = 0; r < shoulder; r++) {
        for (let c = 0; c < cols; c++) {
            const ch = grid[r][c];
            if (ch === ".") {
                continue;
            }
            cells.push(c, r);
            if (CORE_CHARS.indexOf(ch) >= 0) {
                core.push(c, r);
            }
        }
    }
    const coreBox = cellBox(core);
    if (!coreBox) {
        return null;
    }
    const box = cellBox(cells);
    const ring = [];
    const ringA = [];
    for (let i = 0; i < cells.length; i += 2) {
        const c = cells[i];
        const r = cells[i + 1];
        if (CORE_CHARS.indexOf(grid[r][c]) >= 0) {
            continue;
        }
        const dx = (c - box.cx) / box.rx;
        const dy = (r - box.cy) / box.ry;
        if (Math.sqrt(dx * dx + dy * dy) <= RING_INNER) {
            continue;
        }
        ring.push(c, r);
        ringA.push(Math.atan2(r - box.cy, c - box.cx));
    }
    return { shoulder, cells, box, core, coreBox, ring, ringA };
}

/**
 * The side heads: the outer two of exactly three pieces the silhouette breaks
 * into under its widest row.
 *
 * The piece includes the forearm, which is not the head: `cells` is cut back to
 * what sits within HEAD_SPAN of the mouth, and that cut is the head everywhere
 * -- the cells an effect may light, the box `hullParts` hands the engine to
 * shoot at, and the mass that goes dark when it is destroyed. `stump` is where
 * that cut meets the arm, which is where the sparks come from and where the
 * rebuild grows back from; `sd` is every cell's distance from it, 0..1, so the
 * regrow can spread instead of switching on.
 */
function headsOf(grid, cols, rows) {
    let waist = 0;
    let widest = -1;
    for (let r = 0; r < rows; r++) {
        let n = 0;
        for (let c = 0; c < cols; c++) {
            if (grid[r][c] !== ".") {
                n++;
            }
        }
        if (n > widest) {
            widest = n;
            waist = r;
        }
    }
    let split = -1;
    for (let r = waist; r < rows && split < 0; r++) {
        let runs = 0;
        for (let c = 0; c < cols; c++) {
            if (grid[r][c] !== "." && (c === 0 || grid[r][c - 1] === ".")) {
                runs++;
            }
        }
        if (runs >= 3) {
            split = r;
        }
    }
    if (split < 0) {
        return null;
    }
    const seen = new Uint8Array(cols * rows);
    const parts = [];
    for (let r = split; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (grid[r][c] === "." || seen[r * cols + c]) {
                continue;
            }
            seen[r * cols + c] = 1;
            const stack = [c, r];
            const cells = [];
            while (stack.length) {
                const y = stack.pop();
                const x = stack.pop();
                cells.push(x, y);
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || nx >= cols || ny < split || ny >= rows
                                || grid[ny][nx] === "." || seen[ny * cols + nx]) {
                            continue;
                        }
                        seen[ny * cols + nx] = 1;
                        stack.push(nx, ny);
                    }
                }
            }
            parts.push({ cells, box: cellBox(cells) });
        }
    }
    if (parts.length !== 3) {
        return null;
    }
    parts.sort((a, b) => a.box.c0 - b.box.c0);
    const mid = cols >> 1;
    if (parts[1].box.c0 > mid || parts[1].box.c1 < mid) {
        return null;
    }
    return [parts[0], parts[2]].map((part, side) => {
        const glass = [];
        for (let i = 0; i < part.cells.length; i += 2) {
            if (CORE_CHARS.indexOf(grid[part.cells[i + 1]][part.cells[i]]) >= 0) {
                glass.push(part.cells[i], part.cells[i + 1]);
            }
        }
        const gbox = cellBox(glass) || part.box;
        const r = Math.max(gbox.rx, gbox.ry);
        const reach = r * HEAD_SPAN;
        const cells = [];
        for (let i = 0; i < part.cells.length; i += 2) {
            if (Math.hypot(part.cells[i] - gbox.cx, part.cells[i + 1] - gbox.cy) <= reach) {
                cells.push(part.cells[i], part.cells[i + 1]);
            }
        }
        const box = cellBox(cells);
        // The stump: the top corner of the head on the side the arm comes down
        // from, which is the inner one.
        const stump = { c: side ? box.c0 : box.c1, r: box.r0 };
        const sd = new Float32Array(cells.length / 2);
        let far = 1;
        for (let i = 0; i < cells.length; i += 2) {
            sd[i / 2] = Math.hypot(cells[i] - stump.c, cells[i + 1] - stump.r);
            far = Math.max(far, sd[i / 2]);
        }
        for (let i = 0; i < sd.length; i++) {
            sd[i] /= far;
        }
        return { cells, box, glass, gbox, r, stump, sd };
    });
}

/**
 * Everything about a hull grid that never changes, worked out once: the ramp
 * rung of every cell, the lowest occupied row of each column (where a plume
 * hangs), the last row wide enough to count as the bottom edge (where the
 * curtain leaves the hull), the dark cells damage can burn out in a stable
 * order, the core window and the nozzle clusters.
 *
 * Nothing here is written down per colossus: a nozzle is any run of columns
 * that reaches below the bottom edge, and the core is the glass. Both fall out
 * of the art, so the next colossus to get a section does not have to hand-count
 * its own cells -- and neither can drift when a sprite is retouched.
 *
 * The same goes for the parts a hull is *built* out of, which is what HYDRA-07
 * needs and AEGIS does not have:
 *
 *   - the **crown** is whatever sits above the row where the silhouette first
 *     spans 40% of its width -- the shoulder line -- and it only counts as one
 *     if there is glass up there to be a face;
 *   - the **heads** are the outer two of the three pieces the silhouette breaks
 *     into below its widest row, and only when it breaks into exactly three
 *     with the middle one straddling the centre. AEGIS breaks into four nozzle
 *     clusters, so it has no heads and never asks for any;
 *   - the **vents** are the cells the sprite already paints in the neon accent.
 */
function hullGeometry(name) {
    let geo = geometry.get(name);
    if (geo) {
        return geo;
    }
    const grid = spriteGrid(name);
    const rows = grid.length;
    const cols = rows ? grid[0].length : 0;
    const cells = new Int8Array(cols * rows).fill(-1);
    const lowest = new Int16Array(cols).fill(-1);
    const dead = [];
    const core = [];
    const vents = [];
    const used = new Uint8Array(TOP + 1);
    let edgeRow = rows - 1;
    for (let r = 0; r < rows; r++) {
        let filled = 0;
        for (let c = 0; c < cols; c++) {
            const ch = grid[r][c];
            if (ch === ".") {
                continue;
            }
            filled++;
            const rung = RUNG[ch] == null ? 0 : RUNG[ch];
            cells[r * cols + c] = rung;
            used[rung] = 1;
            lowest[c] = r;
            if (DEAD_CHARS.indexOf(ch) >= 0) {
                dead.push([cellNoise(c, r), c, r]);
            }
            if (CORE_CHARS.indexOf(ch) >= 0) {
                core.push(c, r);
            }
            if (ch === ACCENT_CHAR) {
                vents.push(c, r);
            }
        }
        if (cols && filled / cols >= 0.6) {
            edgeRow = r;
        }
    }
    dead.sort((a, b) => a[0] - b[0]);

    // Core window: the ellipse the glass cells fill, so an effect can talk
    // about "the outer third of the core" without knowing the shape.
    let c0 = cols, c1 = -1, r0 = rows, r1 = -1;
    for (let i = 0; i < core.length; i += 2) {
        c0 = Math.min(c0, core[i]); c1 = Math.max(c1, core[i]);
        r0 = Math.min(r0, core[i + 1]); r1 = Math.max(r1, core[i + 1]);
    }
    const coreBox = core.length
        ? { cx: (c0 + c1) / 2, cy: (r0 + r1) / 2, rx: (c1 - c0) / 2 + 0.5, ry: (r1 - r0) / 2 + 0.5 }
        : null;

    // Nozzles: runs of columns hanging below the bottom edge.
    const nozzles = [];
    for (let c = 0; c < cols; c++) {
        if (lowest[c] <= edgeRow) {
            continue;
        }
        const last = nozzles[nozzles.length - 1];
        if (last && c - last.c1 <= 1) {
            last.c1 = c;
        } else {
            nozzles.push({ c0: c, c1: c });
        }
    }
    for (const n of nozzles) {
        n.x = (n.c0 + n.c1 + 1) / 2;                    // centre in cell units
        n.outer = 0;
    }
    // The siege barrels are the two clusters nearest the centre line, and the
    // pair furthest from it breathes out of phase with them.
    const byDist = nozzles.map((n, i) => i)
        .sort((a, b) => Math.abs(nozzles[a].x - cols / 2) - Math.abs(nozzles[b].x - cols / 2));
    const barrels = byDist.slice(0, 2).sort((a, b) => nozzles[a].x - nozzles[b].x);
    byDist.slice(2).forEach((i) => { nozzles[i].outer = 1; });

    // A promotion may only land on a colour the hull is actually painted with.
    // The three tint shades always belong -- they are this hull's own colour,
    // darker and lighter -- but a fixed palette entry the art never uses does
    // not: promoted through rung 4, a cell of HYDRA's chest would put the
    // sprite bank's grey-blue on a violet hull. Those fold onto the nearest
    // rung the art does use, darker side first, so an effect can only ever
    // brighten a cell into a tone that is already on screen somewhere.
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

    geo = {
        cols, rows, cells, lowest, edgeRow, rungs, vents,
        dead: dead.map((d) => [d[1], d[2]]),
        core, coreBox, nozzles, barrels,
        crown: crownOf(grid, cols, rows),
        heads: headsOf(grid, cols, rows),
        ventBox: cellBox(vents),
    };
    geometry.set(name, geo);
    return geo;
}

/**
 * Where a hull's parts are, as fractions of its own width and height measured
 * from its centre -- the form `game_engine.js` wants, since a colossus knows
 * `e.w`/`e.h` and nothing about cells.
 *
 * This is the one thing the animator exports that the *simulation* reads, and
 * it is deliberate: HYDRA's spiral leaves from the lens between the crown's
 * eyes, its fans from the glass in each side head, and its side heads can be
 * shot off. All four of those want the same answer to "where is that part", and
 * a second copy of it in the engine would drift from the art the first time the
 * sprite is retouched. Pure and cached, so host and guest agree.
 *
 * @param {string} name sprite key
 * @returns {Object|null} { crown: {x, y}, heads: [{x, y, hw, hh, mx, my}] } or
 *      null for a hull with no parts (AEGIS). `mx`/`my` is the mouth, `x`/`y`
 *      with `hw`/`hh` the box the head fills.
 */
export function hullParts(name) {
    const geo = hullGeometry(name);
    if (!geo.crown || !geo.heads) {
        return null;
    }
    const fx = (c) => c / geo.cols - 0.5;
    const fy = (r) => r / geo.rows - 0.5;
    return {
        crown: { x: fx(geo.crown.coreBox.cx + 0.5), y: fy(geo.crown.coreBox.cy + 0.5) },
        heads: geo.heads.map((head) => ({
            x: fx(head.box.cx + 0.5), y: fy(head.box.cy + 0.5),
            hw: (head.box.c1 - head.box.c0 + 1) / 2 / geo.cols,
            hh: (head.box.r1 - head.box.r0 + 1) / 2 / geo.rows,
            mx: fx(head.gbox.cx + 0.5), my: fy(head.gbox.cy + 0.5),
        })),
    };
}

function hexToRgb(h) {
    const n = parseInt(String(h).replace("#", ""), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class ColossusAnimator {
    /**
     * @param {number} k index into COLOSSI (same order as COLOSSUS_ANIM_KINDS)
     * @param {string} tint the colossus colour from the catalogue
     */
    constructor(k, tint) {
        this.k = k;
        this.kind = COLOSSUS_ANIM_KINDS[k] || COLOSSUS_ANIM_KINDS[0];
        this.t = COLOSSUS_ANIM[this.kind];
        this.g0 = COLOSSUS_ANIM.global;
        this.tint = tint || "#ff4d4d";
        // The ramp resolved for this hull's tint, straight out of the sprite
        // bank, so a promoted cell is exactly a colour the raster already uses.
        const pal = palette(this.tint);
        this.ramp = RAMP_CHARS.map((ch) => pal[ch]);
        const [r, g, b] = hexToRgb(this.tint);
        // The additive colour of the two glows: the hull's own tint pushed most
        // of the way to white, so a red slab glows hot and a teal one glows cold.
        this.hot = ((r + (255 - r) * 0.6) | 0) + ","
            + ((g + (255 - g) * 0.75) | 0) + ","
            + ((b + (255 - b) * 0.7) | 0);
        this.time = 0;
        this.x = null;
        this.y = null;
        this.vx = 0;
        this.vy = 0;
        this.vx01 = 0;
        this.aim = 0;
        this.lean = 0;
        this.recoil = 0;
        this.sweep = -1;        // < 0 idle, else 0..1 + tail
        this.plant = 0;         // 0..1 brace on any telegraph
        this.port = 0;          // 0..1 shutter, curtain telegraph only
        this.charge = 0;
        this.hold = 0;          // seconds left of the enrage beat
        this.flare = -1;
        this.dmg = 0;
        this.enter = 0;         // 0..1 while it is still coming down
        this.landed = false;
        this.coreFlash = 0;     // seconds left of the salvo core flash
        this.gapX = null;
        this.barrels = [-1, -1];
        // HYDRA: the crown reads the spiral it is firing straight off the AI
        // (`spin` is the arm angle, `arms` how many there are), the enrage is a
        // level rather than a beat, and each side head keeps its own muzzle
        // timer and its own, slower, look at the ships.
        this.spin = 0;
        this.spinDir = 1;
        this.arms = 2;
        this.emit01 = 0;        // 0..1, the crown actually emitting
        this.crownWarn = 0;     // 0..1, SPIRAL_CHARGE
        this.rage01 = 0;
        this.aimH = 0;
        this.headFlash = [0, 0];
        this.headHurt = [0, 0];
        this.headHp = [null, null];
        this.headState = [
            { k: 0, dead: false, grow: 1, hurt: 0 },
            { k: 0, dead: false, grow: 1, hurt: 0 },
        ];
        this.sparks = [];
        this._spawn = 0;
        this._fell = false;
        this._seed = 0.1234;
    }

    /**
     * Advance the cosmetics from state the engine already owns.
     *
     * @param {number} dt seconds
     * @param {Object} s read-only view: x, y, hp01, tel, telK, gapX, aimX, and
     *      for HYDRA spinA (the angle of the spiral arm the AI is firing),
     *      arms (how many of them) and raged
     */
    observe(dt, s) {
        const t = this.t;
        const g = this.g0;
        if (!(dt > 0)) {
            return this;
        }
        if (dt > g.maxDt) {
            dt = g.maxDt;
        }
        this.time += dt;

        // The engine moves a colossus by writing x/y, so there is no velocity to
        // read. On a guest those positions are whole px at ~15 Hz, which makes
        // the raw difference steppy and often exactly 0 for several frames --
        // hence the smoothing rather than the difference itself.
        if (this.x === null) {
            this.x = s.x;
            this.y = s.y;
        }
        const dx = s.x - this.x;
        const dy = s.y - this.y;
        if (Math.abs(dx) > g.teleportPx || Math.abs(dy) > g.teleportPx) {
            this.vx = 0;
            this.vy = 0;
        } else {
            this.vx = ease(this.vx, dx / dt, g.velSmooth, dt);
            this.vy = ease(this.vy, dy / dt, g.velSmooth, dt);
        }
        this.x = s.x;
        this.y = s.y;

        this.vx01 = clamp(this.vx / g.velRefPx, -1, 1);

        // Where the ships are, as a signed fraction of a flank. Eased slowly:
        // a slab this size answering a dodge frame for frame would read as a
        // turret, and the pull `aegis_motion.js` applies is slewed just as hard.
        const aim = s.aimX == null ? 0 : clamp((s.aimX - s.x) / t.lean.aimSpanPx, -1, 1);
        this.aim = ease(this.aim, aim, t.lean.aimSmooth, dt);

        // The arrival: emitters at full burn and a cold core, both fading out as
        // the slab settles into its lane. Once it has fallen and stopped, the
        // latch closes for good -- nothing else it does can look like a descent.
        if (!this.landed) {
            const want = clamp01((this.vy - t.entry.vy) / t.entry.span);
            this.enter = ease(this.enter, want, want > this.enter ? g.boolIn : g.boolOut, dt);
            if (this.enter > 0.5) {
                this._fell = true;
            } else if (this._fell && this.enter < 0.02) {
                this.enter = 0;
                this.landed = true;
            }
        }

        // A telegraph braces the whole hull; only the curtain one opens the
        // shutter, because only the curtain has a hole to point at.
        const tel = smoothstep(clamp01(s.tel || 0));
        const brace = s.telK === "curtain" || s.telK === "aimed" ? tel : 0;
        this.plant = ease(this.plant, brace, brace > this.plant ? g.boolIn : g.boolOut, dt);
        const shutter = s.telK === "curtain" ? tel : 0;
        this.port = ease(this.port, shutter, shutter > this.port ? g.boolIn : g.boolOut, dt);
        this.gapX = s.gapX;

        // Planting squares the slab up: it stops leaning where it was going and
        // faces the arena to fire.
        const tip = clamp(this.vx01 * t.lean.velGain + this.aim * t.lean.aimGain, -1, 1);
        const leanTo = -tip * t.lean.maxRad * (1 - this.plant * t.plant.squareUp);
        this.lean = ease(this.lean, leanTo, t.lean.smooth, dt);

        if (this.hold > 0) {
            this.hold -= dt;
        }
        this.charge = ease(this.charge, this.hold > 0 ? 1 : 0,
            this.hold > 0 ? g.boolIn : g.boolOut, dt);
        this.dmg = clamp01((t.damage.start - clamp01(s.hp01 == null ? 1 : s.hp01)) / t.damage.start);

        this.recoil = this.recoil > 0.001 ? ease(this.recoil, 0, t.recoil.fall, dt) : 0;
        if (this.coreFlash > 0) {
            this.coreFlash -= dt;
        }
        if (this.sweep >= 0) {
            this.sweep += dt / t.curtain.sweepSec;
            if (this.sweep > 1 + t.curtain.tail) {
                this.sweep = -1;
            }
        }
        if (this.flare >= 0) {
            this.flare += dt / t.rage.flareSec;
            if (this.flare > 1) {
                this.flare = -1;
            }
        }
        for (let i = 0; i < 2; i++) {
            if (this.barrels[i] >= 0) {
                this.barrels[i] += dt / t.barrel.life;
                if (this.barrels[i] > 1) {
                    this.barrels[i] = -1;
                }
            }
        }
        if (this.kind === "HYDRA") {
            this._observeHydra(dt, s);
        }
        this._vent(dt);
        return this;
    }

    /**
     * The three parts of HYDRA-07: what the crown is firing, how hurt it is and
     * where the heads are looking.
     *
     * The enrage is a *level* here, not the beat AEGIS gets: the phase lasts
     * the rest of the fight, and it is read off `hp01` (which travels) against
     * the same threshold the AI uses, so host and guest cross it on the same
     * frame without `raged` ever going on the bus.
     */
    _observeHydra(dt, s) {
        const t = this.t;
        const g = this.g0;
        // Which way the crown is turning, read off its own angle rather than
        // sent: the direction flips at the start of every wind-up and that is
        // what the warning is *for*, so it has to be right on a guest too. Only
        // a real step counts -- between two snapshots the angle repeats, and a
        // frame of no movement is not a change of direction.
        const step = ((s.spinA || 0) - this.spin + Math.PI * 3) % 6.2832 - Math.PI;
        if (Math.abs(step) > 0.002) {
            this.spinDir = step > 0 ? 1 : -1;
        }
        this.spin = s.spinA || 0;
        this.arms = s.arms || 2;
        this.emit01 = ease(this.emit01, s.spiral ? 1 : 0, s.spiral ? g.boolIn : g.boolOut, dt);
        const warn = s.telK === "spiral" ? smoothstep(clamp01(s.tel || 0)) : 0;
        this.crownWarn = ease(this.crownWarn, warn, warn > this.crownWarn ? g.boolIn : g.boolOut, dt);
        this._observeHeads(dt, s);
        // Deliberately the slower of the two boolean rates in both directions:
        // the phase takes ~0.6 s to settle, so it reads as a change of state
        // rather than a second flash on top of the one `rage` already fires.
        this.rage01 = ease(this.rage01, s.raged ? 1 : 0, g.boolOut, dt);
        // The heads answer a dodge more slowly than the hull leans into one: a
        // head that snapped onto the ships would read as a turret, which is the
        // same reason `lean.aimSmooth` is what it is.
        const aim = s.aimX == null ? 0 : clamp((s.aimX - s.x) / t.heads.aimSpanPx, -1, 1);
        this.aimH = ease(this.aimH, aim, t.heads.aimSmooth, dt);
    }

    /**
     * The two side heads, all of it *observed*: their hull points travel, so a
     * drop is a hit, zero is a destroyed head and the countdown under it is the
     * rebuild. Three of the sheet's states for no cue at all -- and the local
     * hit flash in particular could not have been one, because it fires as
     * often as you can put a bullet on a head.
     */
    _observeHeads(dt, s) {
        const t = this.t.heads;
        const regrow = s.headRegrow || 40;
        for (let i = 0; i < 2; i++) {
            if (this.headFlash[i] > 0) {
                this.headFlash[i] -= dt;
            }
            if (this.headHurt[i] > 0) {
                this.headHurt[i] -= dt;
            }
            const h = s.heads && s.heads[i];
            const st = this.headState[i];
            if (!h) {
                st.dead = false;
                st.grow = 1;
                continue;
            }
            const was = this.headHp[i];
            if (was != null && h.hp < was && h.hp > 0) {
                this.headHurt[i] = t.hurtSec;
            }
            this.headHp[i] = h.hp;
            st.dead = h.hp <= 0;
            // `t` counts the whole death down: the rebuild is its last frames.
            st.grow = st.dead ? clamp01(1 - h.t / regrow) : 1;
            if (st.dead) {
                this.headFlash[i] = 0;
            }
            st.hurt = clamp01(this.headHurt[i] / t.hurtSec);
        }
    }

    /** Venting sparks, in cell space, while the hull is failing. */
    _vent(dt) {
        const t = this.t;
        if (this.dmg > 0.05) {
            this._spawn += dt * t.damage.ventRate * this.dmg;
            while (this._spawn >= 1) {
                this._spawn -= 1;
                // `c` is the column it vents from, as a fraction of the hull
                // (the grid is not known here); `dc` is its drift, in cells.
                this.sparks.push({
                    c: this._rnd(), dc: 0, r: 6 + this._rnd() * 20,
                    vc: (this._rnd() - 0.5) * 2, vr: 0.4 + this._rnd() * 1.6,
                    life: t.damage.sparkLife * (0.6 + this._rnd() * 0.7), age: 0,
                });
            }
        }
        for (let i = this.sparks.length - 1; i >= 0; i--) {
            const p = this.sparks[i];
            p.age += dt;
            p.dc += p.vc * dt * 2;
            p.r += p.vr * dt * t.damage.sparkSpeed * 0.1;
            if (p.age >= p.life) {
                this.sparks.splice(i, 1);
            }
        }
        if (this.sparks.length > this.g0.maxSparks) {
            this.sparks.splice(0, this.sparks.length - this.g0.maxSparks);
        }
    }

    /**
     * Cosmetic cue from the engine, mirrored to the guests over the bus.
     *
     * Every branch is guarded by the tuning block it needs, because a cue
     * arrives off the wire as a name plus a colossus index: a `cfx` for a hull
     * whose section has no barrels (or no heads) has to be ignored, not read a
     * block that is not there and take the whole guest down with it.
     */
    emit(name) {
        if (name === "salvo" && this.t.barrel) {
            this.recoil = 1;
            this.barrels[0] = 0;
            this.barrels[1] = 0;
            this.coreFlash = this.t.core.flashSec;
        } else if (name === "curtain" && this.t.curtain) {
            this.sweep = 0;
        } else if ((name === "fanL" || name === "fanR") && this.t.heads) {
            // One cue per mouth, because the two heads deliberately fire a
            // beat apart: flashing both would erase the very thing the stagger
            // exists to show. The recoil is still the hull's -- a head cannot
            // move on a cached raster.
            this.recoil = 1;
            this.headFlash[name === "fanL" ? 0 : 1] = this.t.heads.flashSec;
        } else if (name === "rage") {
            this.flare = 0;
            this.hold = this.t.rage.holdSec;
        }
        return this;
    }

    pose() {
        const t = this.t;
        const load = 1 + t.breathe.loadTilt * this.dmg;
        // Core: idle breath, saturated by the brace, whited out by the salvo,
        // jittering and going cold as the hull fails, dark while it arrives.
        const beat = 0.5 + 0.5 * Math.sin(this.time * 6.2832 * t.core.rate);
        let core = t.core.base + t.core.pulse * beat + this.plant * t.core.sat;
        if (this.dmg > 0.05) {
            core = core * (1 - 0.5 * this.dmg) - this.dmg * t.core.jitter
                * (0.5 + 0.5 * Math.sin(this.time * 37));
        }
        core -= this.enter * t.core.dim;
        if (this.coreFlash > 0) {
            core = Math.max(core, 1);
        }
        // HYDRA only: the chest grilles and the two side heads. Both are levels
        // the draw turns into promotions; the grilles carry the phase of the
        // spiral so the ripple runs down the chest in step with the crown.
        let vent = null;
        let heads = null;
        if (this.kind === "HYDRA") {
            const v = t.vents;
            const gain = (1 - this.plant * v.plantDrop) * (1 - 0.7 * this.dmg);
            vent = {
                base: (v.idle + this.rage01 * v.rage) * gain,
                amp: v.amp * gain,
                phase: this.spin,
            };
            const hd = t.heads;
            heads = [];
            for (let i = 0; i < 2; i++) {
                const st = this.headState[i];
                const w = this.time * hd.rate[i] + hd.phase[i];
                let k = hd.idle + hd.pulse * (0.5 + 0.5 * Math.sin(w * 6.2832))
                    + this.plant * hd.charge + this.rage01 * hd.rage;
                if (this.headFlash[i] > 0) {
                    k = Math.max(k, 1);
                }
                k = k * (1 - 0.6 * this.dmg) - this.enter * hd.dim;
                // Coming back, the eyes are the last thing to light.
                if (st.dead) {
                    k *= clamp01((st.grow - hd.eyesAt) / (1 - hd.eyesAt));
                }
                heads.push({ k, dead: st.dead, grow: st.grow, hurt: st.hurt });
            }
        }
        return {
            vx: this.vx, vy: this.vy, vx01: this.vx01,
            lean: this.lean,
            recoilPx: this.recoil * t.recoil.px,
            breathe: 1 + Math.sin(this.time * 6.2832 * t.breathe.rate) * t.breathe.amp * load,
            sweep: this.sweep, plant: this.plant, port: this.port, charge: this.charge,
            flare: this.flare, dmg: this.dmg, enter: this.enter,
            core, coreScale: 1 - t.core.squeeze * this.plant,
            coreBias: -this.lean / t.lean.maxRad * t.core.biasCells,
            vent, heads,
            // The hull rears up over the enrage beat. AEGIS's block has no
            // `archPx`, so for it this stays 0 and the transform is the one it
            // always had.
            archPx: (t.rage.archPx || 0) * this.charge,
        };
    }

    /** Deterministic noise: no `Math.random` anywhere in the simulation path. */
    _rnd() {
        this._seed = (this._seed * 16807) % 2147483647;
        return this._seed / 2147483647;
    }

    /**
     * Draw the hull with the current pose.
     *
     * Everything is laid out in the hull's own space (origin top left, one unit
     * = one logical px) under a transform that carries the recoil, the damage
     * shake, the brace judder, the breathing and the lean, so an effect only has
     * to know which cell it belongs to.
     *
     * Two passes: the promotions repaint cells of the hull opaquely (source
     * over, exactly as the rasterizer painted them), then the two glows that
     * live around the silhouette go on additively.
     *
     * @param {CanvasRenderingContext2D} g
     * @param {Object} o { sprite, px, x, y }
     */
    draw(g, o) {
        const t = this.t;
        const geo = hullGeometry(o.sprite);
        const cv = sprite(o.sprite, this.tint, o.px, false);
        if (!cv || !geo.cols) {
            return;
        }
        const p = this.pose();
        const cell = o.px;
        const w = geo.cols * cell;
        const h = geo.rows * cell;

        // The shake is quantised to whole cells: at this scale anything smaller
        // reads as the sprite vibrating rather than the hull taking damage. The
        // brace judder rides on the same quantisation, one cell at most.
        let sx = 0;
        let sy = 0;
        if (p.dmg > 0.02) {
            const a = t.damage.shakePx * p.dmg;
            sx = Math.round(Math.sin(this.time * t.damage.shakeHz * 6.2832) * a / cell) * cell;
            sy = Math.round(Math.cos(this.time * t.damage.shakeHz * 4.1) * a * 0.6 / cell) * cell;
        }
        if (p.plant > 0.02) {
            // Cubed on purpose: with a telegraph up ~44% of the fight a judder
            // that tracks `plant` linearly is just a permanent shudder. This
            // one only really lands in the last third of the warning.
            const j = t.plant.judderCells * p.plant * p.plant * p.plant;
            sx += Math.round(Math.sin(this.time * t.plant.judderHz * 6.2832) * j) * cell;
            sy += Math.round(Math.cos(this.time * t.plant.judderHz * 9.7) * j * 0.5) * cell;
        }

        g.save();
        g.imageSmoothingEnabled = false;
        g.translate(o.x + sx, o.y - p.recoilPx - p.archPx + sy);
        g.scale(p.breathe, p.breathe);
        // Shear the columns instead of rotating the bitmap: a slab this wide
        // pulls apart visibly past ~0.03 rad, and a rotation would soften every
        // pixel edge in the hull.
        g.transform(1, 0, -p.lean, 1, 0, 0);
        g.translate(-w / 2, -h / 2);
        g.drawImage(cv, 0, 0, w, h);

        this._drawDamage(g, geo, cell, p);
        if (this.kind === "HYDRA") {
            this._drawVents(g, geo, cell, p);
            this._drawCrown(g, geo, cell, p);
            this._drawHeads(g, geo, cell, p);
        } else {
            this._drawCore(g, geo, cell, p);
            this._drawSweep(g, geo, cell, p);
            this._drawPort(g, geo, cell, p, o.x);
            this._drawBarrels(g, geo, cell, p);
            this._drawPlumes(g, geo, cell, p);
        }
        this._drawSparks(g, geo, cell);
        g.globalCompositeOperation = "lighter";
        this._drawCharge(g, cv, geo, cell, h, p);
        this._drawFlare(g, cell, w, h, p);
        g.restore();
    }

    /**
     * Repaint one hull cell `k` of the way up the ramp. Nothing is drawn when
     * the promotion lands on the rung the cell already has, which is most of
     * why this is affordable: measured over a 120 s fight the hull costs one
     * `drawImage` plus ~160 `fillRect`s in an average frame and 425 at the
     * worst, against the 2576 a full cell-by-cell repaint would cost.
     */
    _promote(g, geo, cell, c, r, k) {
        const rung = geo.cells[r * geo.cols + c];
        if (rung < 0) {
            return;
        }
        const to = geo.rungs[clamp(Math.round(lift(rung, k)), 0, TOP)];
        if (to === rung) {
            return;
        }
        g.fillStyle = this.ramp[to];
        g.fillRect(c * cell, r * cell, cell, cell);
    }

    /** Burnt-out sections: the lights go off in the hull's dark cells. */
    _drawDamage(g, geo, cell, p) {
        if (p.dmg <= 0.05) {
            return;
        }
        const n = Math.round(geo.dead.length * p.dmg * (this.t.damage.deadCells / 100));
        g.fillStyle = this.ramp[0];
        for (let i = 0; i < n; i++) {
            const d = geo.dead[i];
            g.fillRect(d[0] * cell, d[1] * cell, cell, cell);
        }
    }

    /**
     * The core window. The glass is promoted from the middle outwards, so a
     * pulse reads as light spreading rather than the whole lens switching; the
     * cells that fall outside `coreScale` are pushed back down to the plating,
     * which is what makes the core visibly shrink as an attack is charged.
     * `coreBias` slides that centre towards the side the hull leans to.
     */
    _drawCore(g, geo, cell, p) {
        const box = geo.coreBox;
        if (!box) {
            return;
        }
        const cx = box.cx + p.coreBias;
        for (let i = 0; i < geo.core.length; i += 2) {
            const c = geo.core[i];
            const r = geo.core[i + 1];
            const dx = (c - cx) / box.rx;
            const dy = (r - box.cy) / box.ry;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d > p.coreScale) {
                // Out of the squeezed lens: back to plating, not to black.
                const rung = geo.cells[r * geo.cols + c];
                if (rung !== RUNG[4]) {
                    g.fillStyle = this.ramp[RUNG[4]];
                    g.fillRect(c * cell, r * cell, cell, cell);
                }
                continue;
            }
            this._promote(g, geo, cell, c, r, p.core * (1 - 0.35 * d));
        }
    }

    /** The bottom edge lights cell by cell as the curtain leaves the hull. */
    _drawSweep(g, geo, cell, p) {
        if (p.sweep < 0) {
            return;
        }
        const t = this.t.curtain;
        const front = p.sweep * geo.cols;
        const tail = geo.cols * t.tail;
        const r0 = Math.max(0, geo.edgeRow - t.rows + 1);
        for (let r = r0; r <= geo.edgeRow; r++) {
            for (let c = 0; c < geo.cols; c++) {
                const d = front - c;
                if (d < 0 || d >= tail) {
                    continue;
                }
                this._promote(g, geo, cell, c, r, t.lift * (1 - d / tail));
            }
        }
    }

    /**
     * The shutter over the hole in the *next* curtain. `gap` is decided one
     * curtain ahead and travels in the snapshot, so the hull can point at the
     * hole on every machine. The gap is often outside the hull, which is wide
     * but not as wide as the field: the port then slides to that edge and stays
     * there, still pointing the right way.
     */
    _drawPort(g, geo, cell, p, cx) {
        if (p.port <= 0.01 || this.gapX == null) {
            return;
        }
        const t = this.t.port;
        const half = t.wCells / 2;
        const local = (this.gapX - cx) / cell + geo.cols / 2;
        const mid = clamp(local, half, geo.cols - 1 - half);
        const c0 = Math.round(mid - half);
        const c1 = Math.round(mid + half);
        const rowMid = (t.top + t.bottom) / 2;
        const span = ((t.bottom - t.top) / 2) * p.port;
        // A shutter that only ramps up is a lamp; the flicker is what says it is
        // a mechanism opening under load.
        const pulse = p.port * (1 - t.flicker + t.flicker * (0.5 + 0.5 * Math.sin(this.time * 33)));
        for (let c = c0; c <= c1; c++) {
            for (let r = t.top; r <= t.bottom; r++) {
                const d = Math.abs(r - rowMid);
                let k = 0;
                if (d <= span) {
                    k = t.lift * (0.35 + 0.65 * pulse);
                } else if (d < span + t.bloomCells) {
                    k = t.lift * 0.3 * pulse;
                }
                if (k <= 0.01) {
                    continue;
                }
                this._promote(g, geo, cell, c, r, k);
            }
        }
    }

    /**
     * Muzzle flash at the two siege barrels: the nozzle clusters nearest the
     * centre line, which is where `_updateColossus` fires the salvo from. The
     * flash is the nozzle itself going white, not a sprite laid over it.
     */
    _drawBarrels(g, geo, cell, p) {
        const t = this.t.barrel;
        for (let i = 0; i < geo.barrels.length && i < 2; i++) {
            const f = this.barrels[i];
            if (f < 0) {
                continue;
            }
            const n = geo.nozzles[geo.barrels[i]];
            const a = 1 - f;
            for (let c = n.c0; c <= n.c1; c++) {
                const base = geo.lowest[c];
                if (base < 0) {
                    continue;
                }
                for (let r = Math.max(0, geo.edgeRow); r <= base; r++) {
                    this._promote(g, geo, cell, c, r, t.lift * a);
                }
                // The flame leaving the mouth, outside the silhouette.
                for (let k = 1; k <= t.rows; k++) {
                    g.globalAlpha = a * (1 - (k - 1) / (t.rows + 1));
                    g.fillStyle = this.ramp[k > 1 ? TOP - 1 : TOP];
                    g.fillRect(c * cell, (base + k) * cell, cell, cell);
                }
            }
        }
        g.globalAlpha = 1;
    }

    /**
     * Level of one emitter, 0..2: a slow breath phase-shifted between the inner
     * and the outer pair, plus the throttle (drift, enrage charge, recoil, the
     * arrival), minus whatever the brace holds back. Over 1 the nozzle is at the
     * top of the ramp, which is what the muzzle flash rides on.
     */
    _emitLevel(i, geo, p) {
        const t = this.t.emitters;
        const n = geo.nozzles[i];
        const ph = (i * 0.29 + (n.outer ? t.outerPhase : 0)) % 1;
        const w = (this.time / t.period + ph) % 1;
        let lvl = t.idle + t.amp * (0.5 + 0.5 * Math.sin(w * 6.2832));
        lvl += Math.abs(p.vx01) * t.velGain + p.charge * 0.6 + this.recoil * 0.8
            + p.enter * this.t.entry.burn;
        // Time-hashed flicker: the draw must not consume the simulation's noise.
        lvl += Math.sin(this.time * 21 + i * 2.4) * 0.5 * t.jitter;
        return clamp(lvl * (1 - p.plant * this.t.plant.emitDrop), 0, 2);
    }

    /** Plumes hanging off the nozzle clusters, tapered and tilted against the drift. */
    _drawPlumes(g, geo, cell, p) {
        const t = this.t.emitters;
        for (let i = 0; i < geo.nozzles.length; i++) {
            const n = geo.nozzles[i];
            const lvl = this._emitLevel(i, geo, p);
            const len = Math.round(lvl * t.maxCells);
            if (len <= 0) {
                continue;
            }
            for (let k = 0; k < len; k++) {
                const a = 1 - k / len;
                // Solid ramp rungs, so the plume stays pixel art: white at the
                // mouth when the nozzle is over-driven, then glass, tint, and a
                // dark accent tail.
                const rung = lvl > 1 && k === 0 ? TOP : a > 0.7 ? TOP - 1 : a > 0.4 ? RUNG[4] : 1;
                const taper = Math.floor(k / 2);
                const tilt = Math.round(-p.vx01 * t.tiltCells * (k / Math.max(1, len - 1)));
                g.globalAlpha = k === len - 1 ? 0.55 : 1;
                g.fillStyle = this.ramp[rung];
                for (let c = n.c0 + taper; c <= n.c1 - taper; c++) {
                    const base = geo.lowest[c];
                    if (base < 0) {
                        continue;
                    }
                    g.fillRect((c + tilt) * cell, (base + 1 + k) * cell, cell, cell);
                }
            }
        }
        g.globalAlpha = 1;
    }

    /**
     * HYDRA's chest grilles: the four bars the sprite already paints in the
     * neon accent, rippling downwards once per turn of the spiral. They sit on
     * the tint's rung, so they cross into the light tint at k = 0.17 and into
     * glass at 0.5 -- the idle ripple stays under the second line and only the
     * enrage puts them there.
     */
    _drawVents(g, geo, cell, p) {
        const box = geo.ventBox;
        if (!p.vent || !box) {
            return;
        }
        const span = Math.max(1, box.r1 - box.r0);
        for (let i = 0; i < geo.vents.length; i += 2) {
            const r = geo.vents[i + 1];
            const ph = p.vent.phase - ((r - box.r0) / span) * this.t.vents.rowPhase;
            const k = p.vent.base + p.vent.amp * (0.5 + 0.5 * Math.sin(ph));
            if (k <= 0.01) {
                continue;
            }
            this._promote(g, geo, cell, geo.vents[i], r, k);
        }
    }

    /**
     * HYDRA's crown: the lens between the eyes, and a ring of light on the
     * plating around it turning with the spiral.
     *
     * The lens is AEGIS's core window on a different set of cells -- promoted
     * from the middle outwards so a pulse spreads instead of switching, and
     * slid towards the side the hull leans to. What is new is the ring:
     * `this.spin` is the arm angle `_updateColossus` is firing at *this* frame,
     * so the lit arcs cannot end up anywhere except on the cells the last pair
     * of bullets left from. Getting that for free is the whole reason the angle
     * is handed over instead of being reinvented here.
     */
    _drawCrown(g, geo, cell, p) {
        const crown = geo.crown;
        if (!crown) {
            return;
        }
        const t = this.t;
        const box = crown.coreBox;
        const cx = box.cx + p.coreBias;
        for (let i = 0; i < crown.core.length; i += 2) {
            const c = crown.core[i];
            const r = crown.core[i + 1];
            const dx = (c - cx) / box.rx;
            const dy = (r - box.cy) / box.ry;
            const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
            this._promote(g, geo, cell, c, r, p.core * (1 - t.core.falloff * d));
        }

        // The ring. While the crown emits it burns in as many arcs as there
        // are arms, sitting on the sectors the bullets are leaving from. While
        // it winds up it runs a *single* arc around instead, turning the way
        // the coming spiral will: that direction is the whole content of the
        // warning, and a wall of bullets you can only read once it is on top of
        // you is not a pattern, it is a die roll.
        const ring = t.ring;
        const seq = this.crownWarn > this.emit01;
        const arcs = seq ? 1 : Math.max(1, this.arms);
        const level = seq ? this.crownWarn : this.emit01;
        const lift = (seq ? ring.warnLift : ring.lift + this.rage01 * ring.rageLift) * level;
        const cut = seq ? ring.warnCut : ring.cut;
        const at = seq
            ? this.time * ring.seqRate * 6.2832 * this.spinDir
            : this.spin;
        const step = 6.2832 / arcs;
        const half = step / 2;
        const idle = ring.idle * (1 - level);
        for (let i = 0, j = 0; i < crown.ring.length; i += 2, j++) {
            // Angle to the nearest arc, folded into 0..half.
            const d = Math.abs((((crown.ringA[j] - at) % step) + step * 1.5) % step - half);
            const k = 1 - d / half;
            const f = k > cut ? (k - cut) / (1 - cut) : 0;
            const promote = lift * f * f + idle;
            if (promote <= 0.01) {
                continue;
            }
            this._promote(g, geo, cell, crown.ring[i], crown.ring[i + 1], promote);
        }
    }

    /**
     * HYDRA's two side heads. Neither can turn -- the hull is one cached raster
     * -- so what a head does instead is move the light inside itself: the
     * promoted disc sits on its mouth, slides towards the ships and grows out
     * into the plating as the fan winds up. Both heads fire in the same frame,
     * so both flash together; only the muzzle flame is drawn outside the
     * silhouette, hanging off the columns under the mouth for the same reason
     * AEGIS's barrel flame does -- that is where the bullets leave from.
     */
    _drawHeads(g, geo, cell, p) {
        const heads = geo.heads;
        if (!heads || !p.heads) {
            return;
        }
        const t = this.t.heads;
        const open = t.openCells * clamp01(this.plant);
        for (let i = 0; i < heads.length && i < 2; i++) {
            const head = heads[i];
            const h = p.heads[i];
            if (h.dead) {
                this._drawDeadHead(g, geo, cell, head, i, h);
            }
            // A hit is the whole head going white for four frames, and nothing
            // else on the hull moving: that is the point of it.
            if (h.hurt > 0.01) {
                for (let n = 0; n < head.cells.length; n += 2) {
                    this._promote(g, geo, cell, head.cells[n], head.cells[n + 1], h.hurt * 0.95);
                }
            }
            if (h.k <= 0.02) {
                continue;
            }
            const rad = head.r + open;
            const cx = head.gbox.cx + this.aimH * t.biasCells;
            for (let n = 0; n < head.cells.length; n += 2) {
                const c = head.cells[n];
                const r = head.cells[n + 1];
                const dx = c - cx;
                const dy = r - head.gbox.cy;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d > rad) {
                    continue;
                }
                this._promote(g, geo, cell, c, r, h.k * (1 - t.falloff * (d / rad)));
            }
            if (this.headFlash[i] > 0) {
                this._drawMuzzle(g, geo, cell, head, clamp01(this.headFlash[i] / t.flashSec));
            }
        }
    }

    /**
     * A destroyed side head, and its rebuild.
     *
     * Dead, it is pulled *down* the ramp -- the only direction that reads as
     * "off" on plating this dark -- and the stump it hangs from throws sparks.
     * The rebuild grows back out of that stump: every cell knows how far it is
     * from it (`sd`), so the head fills in from the arm outwards behind a lit
     * front instead of fading in as one block. The eyes come last, which
     * `pose()` handles by holding the mouth level down until `eyesAt`.
     */
    _drawDeadHead(g, geo, cell, head, i, h) {
        const t = this.t.heads;
        for (let n = 0, j = 0; n < head.cells.length; n += 2, j++) {
            const d = head.sd[j];
            if (d <= h.grow - t.growFront) {
                continue;               // rebuilt: the sprite's own colour
            }
            if (d <= h.grow) {
                // The growth front.
                this._promote(g, geo, cell, head.cells[n], head.cells[n + 1], t.growLift);
                continue;
            }
            this._promote(g, geo, cell, head.cells[n], head.cells[n + 1], -t.dead);
        }
        // Sparks at the stump. Time-hashed rather than drawn from the particle
        // system: the draw must not consume the simulation's noise.
        for (let k = 0; k < t.stumpCells; k++) {
            const ph = this.time * t.stumpRate + k * 2.39 + i * 1.7;
            const a = 1 - (ph % 1);
            if (a < 0.15) {
                continue;
            }
            const dc = Math.sin(ph * 3.1 + k) * 2;
            const dr = -(1 - a) * 4;
            g.globalAlpha = clamp01(a * 0.9);
            g.fillStyle = this.ramp[a > 0.6 ? TOP : a > 0.3 ? TOP - 1 : RUNG[4]];
            g.fillRect(Math.round(head.stump.c + dc) * cell,
                Math.round(head.stump.r + dr) * cell, cell, cell);
        }
        g.globalAlpha = 1;
    }

    /** The fan leaving a mouth: cells under the head's own bottom edge. */
    _drawMuzzle(g, geo, cell, head, a) {
        const t = this.t.heads;
        for (let c = Math.round(head.gbox.c0); c <= Math.round(head.gbox.c1); c++) {
            const base = geo.lowest[c];
            if (base < 0) {
                continue;
            }
            for (let k = 1; k <= t.flameCells; k++) {
                const f = 1 - (k - 1) / t.flameCells;
                // Leaning the way the fan was thrown, and in solid ramp
                // rungs, so the flame stays pixel art instead of a gradient.
                const tilt = Math.round(this.aimH * t.flameTilt * (k / t.flameCells));
                g.globalAlpha = a * f;
                g.fillStyle = this.ramp[k > 2 ? RUNG[4] : k > 1 ? TOP - 1 : TOP];
                g.fillRect((c + tilt) * cell, (base + k) * cell, cell, cell);
            }
        }
        g.globalAlpha = 1;
    }

    _drawSparks(g, geo, cell) {
        for (const p of this.sparks) {
            const a = 1 - p.age / p.life;
            g.globalAlpha = clamp01(a * 0.85);
            g.fillStyle = this.ramp[a > 0.6 ? TOP : a > 0.3 ? TOP - 1 : RUNG[4]];
            g.fillRect((p.c * geo.cols + p.dc) * cell, p.r * cell, cell, cell);
        }
        g.globalAlpha = 1;
    }

    /**
     * The enrage charge: the hull itself heats up from the core outwards. Drawn
     * as vertical slices of the cached raster added back on top of itself, so
     * the glow stops exactly at the silhouette without a second raster.
     */
    _drawCharge(g, cv, geo, cell, h, p) {
        if (p.charge <= 0.01) {
            return;
        }
        const c = this.t.charge;
        const rx = cv.width / geo.cols;
        for (let i = 0; i < c.bands; i++) {
            const c0 = (i / c.bands) * geo.cols;
            const c1 = ((i + 1) / c.bands) * geo.cols;
            const d = Math.abs((c0 + c1) / 2 - geo.cols / 2) / (geo.cols / 2);
            const a = p.charge * c.max * Math.max(0, 1 - d * c.falloff);
            if (a <= 0.01) {
                continue;
            }
            g.globalAlpha = Math.min(1, a);
            g.drawImage(cv, c0 * rx, 0, (c1 - c0) * rx, cv.height,
                c0 * cell, 0, (c1 - c0) * cell, h);
        }
        g.globalAlpha = 1;
    }

    /** One expanding ring of cells on the phase change. */
    _drawFlare(g, cell, w, h, p) {
        if (p.flare < 0) {
            return;
        }
        const t = this.t.rage;
        const a = 1 - p.flare;
        const rad = (t.ringCells + p.flare * (w / cell) * 0.42) * cell;
        g.strokeStyle = "rgba(" + this.hot + "," + (a * 0.55).toFixed(3) + ")";
        g.lineWidth = cell;
        g.strokeRect(w / 2 - rad, h / 2 - rad * 0.55, rad * 2, rad * 1.1);
    }
}
