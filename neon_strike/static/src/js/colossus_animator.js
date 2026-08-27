/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - flight and combat animation for the colossal bosses.
 *
 * Ported from the "AEGIS-01 Study" design study (`colossus_animator.js`), which
 * arrived already respecting the render-only contract. Same shape as
 * `boss_animator.js`, one size up, and only AEGIS-01 is covered so far: the
 * other four colossi fall through to the plain hull draw until they get a
 * section of their own (`COLOSSUS_ANIM_KINDS` is what decides).
 *
 * Four deliberate departures from the study:
 *
 *   1. **The hull stays the module's.** The study shipped its own procedural
 *      92x28 grid and painted it cell by cell with a five-shade palette.
 *      `colossus0` already exists in `sprites.js` with the ten-index palette
 *      where 4/5/6 are the tint, and it is what the glossary shows. So the
 *      hull is the cached raster, and only the cells an effect actually
 *      changes are painted on top of it. That also keeps a colossus at one
 *      `drawImage` instead of 2576 `fillRect`s a frame.
 *   2. **No lance.** The study gave AEGIS an eye that fires a 1100 px column of
 *      light at a ship. The engine has no such attack, and drawing a beam with
 *      no hitbox shows light where the damage is not -- the same reason
 *      `boss_animator.js` refused the LANCER beam. Dropped, with its telegraph
 *      (`telK === "lance"` never happens) and its eye charge.
 *   3. **No hit flash.** The study brightened the hull on `flash`. A colossus
 *      is under fire every frame, so that leaves it permanently washed out; the
 *      hit feedback stays the white burst at the point of impact plus the top
 *      bar.
 *   4. **The enrage beat is an envelope, not an observed flag.** `e.hold` does
 *      not travel in the snapshot, so `charge` runs off the `rage` cue for the
 *      50 frames `_bossRage` holds fire. Same beat on host and guest, no new
 *      bytes on the bus.
 *
 * Everything else is **render only**: the engine (or, on a guest, the host
 * snapshot) owns position, hull points, every bullet and the telegraph. This
 * reads state that already travels -- x, y, hp01, tel, telK and `gap`, the
 * position of the hole in the *next* curtain -- and derives the rest from
 * observed motion.
 *
 * State cannot live on the enemy object: a guest rebuilds `this.enemies` from
 * scratch on every snapshot, so the engine keeps these animators in a map keyed
 * by colossus index and feeds them (see `_updateColossusAnims`).
 */

import { sprite, spriteGrid } from "./sprites";

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
        lean: { maxRad: 0.028, gain: 1, smooth: 6 },
        recoil: { px: 14, fall: 3.2 },
        barrel: { offsetPx: 187, life: 0.22, wCells: 3, hCells: 2 },
        curtain: { sweepSec: 0.3, rows: 2, tail: 0.28 },
        // The shutter that announces the hole in the next curtain. 7 cells is
        // 63 px against the 124 px the pattern actually skips, deliberately
        // narrower for the same reason the telegraph mark is: what it points
        // at is always safe.
        port: { wCells: 7, top: 7, bottom: 19, bloomCells: 2 },
        thruster: { count: 9, maxCells: 4, tiltCells: 2, idle: 0.3, jitter: 0.35 },
        damage: {
            start: 0.3,     // hp01 under which the hull starts failing
            shakePx: 5, shakeHz: 17,
            deadCells: 30,  // % of the hull's dark cells burnt out at 0 hull
            ventRate: 9, sparkLife: 0.55, sparkSpeed: 26,
        },
        // 0.83 s: the 50 frames `_bossRage` holds fire on a colossus.
        rage: { holdSec: 0.83, flareSec: 0.9, ringCells: 6 },
        charge: { max: 0.55, bands: 12, falloff: 1.4 },
    },
};

/** Index into COLOSSI -> section above. A colossus with no section is drawn plain. */
export const COLOSSUS_ANIM_KINDS = ["AEGIS"];

/** Hull cells the damage burns out: mid hull and metal, never the tint. */
const DEAD_CHARS = "23";

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Stable 0..1 noise for a cell, so the burnt sections never crawl. */
function cellNoise(c, r) {
    const n = (((c * 73856093) ^ (r * 19349663)) >>> 0) % 100000;
    return n / 100000;
}

const geometry = new Map();

/**
 * Everything about a hull grid that never changes, worked out once: the cell
 * values, the lowest occupied row of each column (where a thruster hangs), the
 * last row wide enough to count as the bottom edge (where the curtain leaves
 * the hull) and the dark cells damage can burn out, in a stable order.
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
    let edgeRow = rows - 1;
    for (let r = 0; r < rows; r++) {
        let filled = 0;
        for (let c = 0; c < cols; c++) {
            const ch = grid[r][c];
            if (ch === ".") {
                continue;
            }
            filled++;
            cells[r * cols + c] = ch.charCodeAt(0) - 48;
            lowest[c] = r;
            if (DEAD_CHARS.indexOf(ch) >= 0) {
                dead.push([cellNoise(c, r), c, r]);
            }
        }
        if (cols && filled / cols >= 0.6) {
            edgeRow = r;
        }
    }
    dead.sort((a, b) => a[0] - b[0]);
    geo = {
        cols, rows, cells, lowest, edgeRow,
        dead: dead.map((d) => [d[1], d[2]]),
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
        const [r, g, b] = hexToRgb(this.tint);
        // The additive colour of every glow: the hull's own tint pushed most of
        // the way to white, so a red slab glows hot and a teal one glows cold.
        this.hot = ((r + (255 - r) * 0.6) | 0) + ","
            + ((g + (255 - g) * 0.75) | 0) + ","
            + ((b + (255 - b) * 0.7) | 0);
        this.time = 0;
        this.x = null;
        this.y = null;
        this.vx = 0;
        this.vy = 0;
        this.vx01 = 0;
        this.lean = 0;
        this.recoil = 0;
        this.sweep = -1;        // < 0 idle, else 0..1 + tail
        this.port = 0;
        this.charge = 0;
        this.hold = 0;          // seconds left of the enrage beat
        this.flare = -1;
        this.dmg = 0;
        this.gapX = null;
        this.barrels = [-1, -1];
        this.sparks = [];
        this._spawn = 0;
        this._seed = 0.1234;
    }

    /**
     * Advance the cosmetics from state the engine already owns.
     *
     * @param {number} dt seconds
     * @param {Object} s read-only view: x, y, hp01, tel, telK, gapX
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
        this.lean = ease(this.lean, -this.vx01 * t.lean.maxRad * t.lean.gain, t.lean.smooth, dt);

        // The hole in the next curtain: known one curtain ahead, and it travels.
        const tel = clamp01(s.tel || 0);
        const target = s.telK === "curtain" ? tel * tel * (3 - 2 * tel) : 0;
        this.port = ease(this.port, target, target > this.port ? g.boolIn : g.boolOut, dt);
        this.gapX = s.gapX;

        if (this.hold > 0) {
            this.hold -= dt;
        }
        this.charge = ease(this.charge, this.hold > 0 ? 1 : 0,
            this.hold > 0 ? g.boolIn : g.boolOut, dt);
        this.dmg = clamp01((t.damage.start - clamp01(s.hp01 == null ? 1 : s.hp01)) / t.damage.start);

        this.recoil = this.recoil > 0.001 ? ease(this.recoil, 0, t.recoil.fall, dt) : 0;
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
        return {
            vx: this.vx, vy: this.vy, vx01: this.vx01,
            lean: this.lean,
            recoilPx: this.recoil * t.recoil.px,
            breathe: 1 + Math.sin(this.time * 6.2832 * t.breathe.rate) * t.breathe.amp * load,
            sweep: this.sweep, port: this.port, charge: this.charge,
            flare: this.flare, dmg: this.dmg,
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
     * shake, the breathing and the lean, so an effect only has to know which
     * cell it belongs to.
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
        // reads as the sprite vibrating rather than the hull taking damage.
        let sx = 0;
        let sy = 0;
        if (p.dmg > 0.02) {
            const a = t.damage.shakePx * p.dmg;
            sx = Math.round(Math.sin(this.time * t.damage.shakeHz * 6.2832) * a / cell) * cell;
            sy = Math.round(Math.cos(this.time * t.damage.shakeHz * 4.1) * a * 0.6 / cell) * cell;
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
        g.globalCompositeOperation = "lighter";
        this._drawCharge(g, cv, geo, cell, w, h, p);
        this._drawSweep(g, geo, cell, p);
        this._drawPort(g, geo, cell, p, o.x);
        this._drawThrusters(g, geo, cell, p);
        this._drawBarrels(g, geo, cell, w);
        this._drawSparks(g, geo, cell);
        this._drawFlare(g, cell, w, h, p);
        g.restore();
    }

    /** Burnt-out sections: the lights go off in the hull's dark cells. */
    _drawDamage(g, geo, cell, p) {
        if (p.dmg <= 0.05) {
            return;
        }
        const n = Math.round(geo.dead.length * p.dmg * (this.t.damage.deadCells / 100));
        g.fillStyle = "rgba(10,6,18,0.78)";
        for (let i = 0; i < n; i++) {
            const d = geo.dead[i];
            g.fillRect(d[0] * cell, d[1] * cell, cell, cell);
        }
    }

    /**
     * The enrage charge: the hull itself heats up from the core outwards. Drawn
     * as vertical slices of the cached raster added back on top of itself, so
     * the glow stops exactly at the silhouette without a second raster.
     */
    _drawCharge(g, cv, geo, cell, w, h, p) {
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
                if (geo.cells[r * geo.cols + c] < 0) {
                    continue;
                }
                const d = front - c;
                if (d < 0 || d >= tail) {
                    continue;
                }
                g.fillStyle = "rgba(" + this.hot + "," + (1 - d / tail).toFixed(3) + ")";
                g.fillRect(c * cell, r * cell, cell, cell);
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
        for (let c = c0; c <= c1; c++) {
            for (let r = t.top; r <= t.bottom; r++) {
                if (geo.cells[r * geo.cols + c] < 0) {
                    continue;
                }
                const d = Math.abs(r - rowMid);
                let a = 0;
                if (d <= span) {
                    a = 0.35 + 0.65 * p.port;
                } else if (d < span + t.bloomCells) {
                    a = 0.25 * p.port;
                }
                if (a <= 0.01) {
                    continue;
                }
                g.fillStyle = "rgba(" + this.hot + "," + a.toFixed(3) + ")";
                g.fillRect(c * cell, r * cell, cell, cell);
            }
        }
    }

    /** Plumes hanging off the lowest cell of their column, tilted against the drift. */
    _drawThrusters(g, geo, cell, p) {
        const t = this.t.thruster;
        const vsig = Math.abs(p.vx01);
        for (let i = 0; i < t.count; i++) {
            const c = Math.min(geo.cols - 1, Math.round(((i + 0.5) / t.count) * geo.cols));
            const base = geo.lowest[c];
            if (base < 0) {
                continue;
            }
            // Time-hashed flicker: the draw must not consume the simulation's noise.
            const flick = Math.sin(this.time * 21 + i * 2.4) * 0.5 * t.jitter;
            const len = Math.max(0, t.idle + vsig + p.charge * 0.6 + this.recoil * 0.8 + flick)
                * t.maxCells;
            const n = Math.round(len);
            for (let k = 0; k < n; k++) {
                const a = 1 - k / n;
                const tilt = Math.round(-p.vx01 * t.tiltCells * (k / Math.max(1, n - 1)));
                g.fillStyle = "rgba(255," + ((140 + 90 * a) | 0) + "," + ((90 + 60 * a) | 0)
                    + "," + (0.16 + 0.5 * a).toFixed(3) + ")";
                g.fillRect((c + tilt) * cell, (base + 1 + k) * cell, cell, cell);
            }
        }
    }

    /** Muzzle flash at the two siege barrels, on the row the salvo leaves from. */
    _drawBarrels(g, geo, cell, w) {
        const t = this.t.barrel;
        for (let i = 0; i < 2; i++) {
            const f = this.barrels[i];
            if (f < 0) {
                continue;
            }
            const a = 1 - f;
            const c0 = Math.round((w / 2 + (i ? t.offsetPx : -t.offsetPx)) / cell)
                - (t.wCells >> 1);
            for (let k = 0; k <= t.hCells; k++) {
                g.fillStyle = "rgba(255," + ((200 - k * 30) | 0) + ",170,"
                    + (a * (1 - k / (t.hCells + 1))).toFixed(3) + ")";
                g.fillRect(c0 * cell, (geo.edgeRow + k) * cell, cell * t.wCells, cell);
            }
        }
    }

    _drawSparks(g, geo, cell) {
        for (const p of this.sparks) {
            const a = 1 - p.age / p.life;
            g.fillStyle = "rgba(255," + ((170 + 60 * a) | 0) + ",150," + (a * 0.8).toFixed(3) + ")";
            g.fillRect((p.c * geo.cols + p.dc) * cell, p.r * cell, cell, cell);
        }
    }

    /** One expanding ring of cells on the phase change. */
    _drawFlare(g, cell, w, h, p) {
        if (p.flare < 0) {
            return;
        }
        const t = this.t.rage;
        const a = 1 - p.flare;
        const rad = (t.ringCells + p.flare * (w / cell) * 0.42) * cell;
        g.strokeStyle = "rgba(255," + ((120 + 100 * a) | 0) + ",120," + (a * 0.55).toFixed(3) + ")";
        g.lineWidth = cell;
        g.strokeRect(w / 2 - rad, h / 2 - rad * 0.55, rad * 2, rad * 1.1);
    }
}
