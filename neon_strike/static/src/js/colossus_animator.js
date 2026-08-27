/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - flight and combat animation for the colossal bosses.
 *
 * Ported from the "AEGIS-01" design studies (the Study, then the Animation
 * Sheet that reworked it), which arrived already respecting the render-only
 * contract. Same shape as `boss_animator.js`, one size up, and only AEGIS-01 is
 * covered so far: the other four colossi fall through to the plain hull draw
 * until they get a section of their own (`COLOSSUS_ANIM_KINDS` is what decides).
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
 * Everything else is **render only**: the engine (or, on a guest, the host
 * snapshot) owns position, hull points, every bullet and the telegraph. This
 * reads state that already travels -- x, y, hp01, tel, telK, `gap` (the
 * position of the hole in the *next* curtain) and where the live ships are --
 * and derives the rest from observed motion.
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
};

/** Index into COLOSSI -> section above. A colossus with no section is drawn plain. */
export const COLOSSUS_ANIM_KINDS = ["AEGIS"];

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
    let edgeRow = rows - 1;
    for (let r = 0; r < rows; r++) {
        let filled = 0;
        for (let c = 0; c < cols; c++) {
            const ch = grid[r][c];
            if (ch === ".") {
                continue;
            }
            filled++;
            cells[r * cols + c] = RUNG[ch] == null ? 0 : RUNG[ch];
            lowest[c] = r;
            if (DEAD_CHARS.indexOf(ch) >= 0) {
                dead.push([cellNoise(c, r), c, r]);
            }
            if (CORE_CHARS.indexOf(ch) >= 0) {
                core.push(c, r);
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

    geo = {
        cols, rows, cells, lowest, edgeRow,
        dead: dead.map((d) => [d[1], d[2]]),
        core, coreBox, nozzles, barrels,
    };
    geometry.set(name, geo);
    return geo;
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
        this.sparks = [];
        this._spawn = 0;
        this._fell = false;
        this._seed = 0.1234;
    }

    /**
     * Advance the cosmetics from state the engine already owns.
     *
     * @param {number} dt seconds
     * @param {Object} s read-only view: x, y, hp01, tel, telK, gapX, aimX
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
        this._vent(dt);
        return this;
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

    /** Cosmetic cue from the engine, mirrored to the guests over the bus. */
    emit(name) {
        if (name === "salvo") {
            this.recoil = 1;
            this.barrels[0] = 0;
            this.barrels[1] = 0;
            this.coreFlash = this.t.core.flashSec;
        } else if (name === "curtain") {
            this.sweep = 0;
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
        return {
            vx: this.vx, vy: this.vy, vx01: this.vx01,
            lean: this.lean,
            recoilPx: this.recoil * t.recoil.px,
            breathe: 1 + Math.sin(this.time * 6.2832 * t.breathe.rate) * t.breathe.amp * load,
            sweep: this.sweep, plant: this.plant, port: this.port, charge: this.charge,
            flare: this.flare, dmg: this.dmg, enter: this.enter,
            core, coreScale: 1 - t.core.squeeze * this.plant,
            coreBias: -this.lean / t.lean.maxRad * t.core.biasCells,
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
        g.translate(o.x + sx, o.y - p.recoilPx + sy);
        g.scale(p.breathe, p.breathe);
        // Shear the columns instead of rotating the bitmap: a slab this wide
        // pulls apart visibly past ~0.03 rad, and a rotation would soften every
        // pixel edge in the hull.
        g.transform(1, 0, -p.lean, 1, 0, 0);
        g.translate(-w / 2, -h / 2);
        g.drawImage(cv, 0, 0, w, h);

        this._drawDamage(g, geo, cell, p);
        this._drawCore(g, geo, cell, p);
        this._drawSweep(g, geo, cell, p);
        this._drawPort(g, geo, cell, p, o.x);
        this._drawBarrels(g, geo, cell, p);
        this._drawPlumes(g, geo, cell, p);
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
        const to = clamp(Math.round(lift(rung, k)), 0, TOP);
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
