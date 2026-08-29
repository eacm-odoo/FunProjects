/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - the places the run flies through.
 *
 * A backdrop is decorative: it never touches the simulation, so it does not
 * travel in the snapshot. `backgroundForWave(wave)` is pure, which is what
 * keeps host and guests looking at the same sky without a single extra byte on
 * the bus.
 *
 * Each entry names a `kind` (the painter) plus its parameters, so 20+ places
 * come out of ~17 painters. A painter may implement any of:
 *   - `init(bd)`   one-off state (dust, cloud bands, orbits…)
 *   - `paint(bd, g)`  static art, baked **once** into an offscreen layer at
 *     half resolution. Use it for anything that does not move.
 *   - `update(bd, ts)` / `live(bd, g)`  per-frame state and drawing. Only for
 *     what genuinely moves: it runs at 60 fps behind the whole game.
 * Direction A places (below) bake from two more phases instead of `paint`:
 *   - `field(bd, x, y)`  the place as a scalar 0..1, sampled once per art
 *     pixel and snapped to the place's ramp through an ordered dither. It may
 *     return its own `rgb` to send that pixel to a second ramp.
 *   - `hard(bd, g, pix)`  hard-edged art laid over the quantised field, drawn
 *     in art pixels rather than logical ones.
 *   - `occlude(bd, x, y)`  how much of a baked star this place hides, 0..1.
 * Painters draw in **logical arena coordinates** (the 680x540 space), over the
 * box the camera can reach when it pulls back for a colossus.
 *
 * Each entry also carries the `desc` the glossary shows, so the catalogue of
 * places lives here and not in a second list that would drift from it.
 *
 * `BACKGROUNDS` order is the order they show up in a run: append at the end.
 *
 * -------------------------------------------------------------------------
 * PLACES study, Direction A -- places 1-5 (2026-08-29)
 * -------------------------------------------------------------------------
 * The study built VIOLET NEBULA both ways -- quantised, and deliberately
 * smooth -- and Direction A won: the seam at the play field was an accident,
 * not a depth cue. `deep`, `planet_blue`, `nebula_violet`, `belt` and
 * `blackhole` are now baked on the same 3 px lattice and the same 8-rung ramps
 * the sprites live on. Places 6-27 are still soft gradient art.
 *
 * Departures from the study, and why:
 *   1. The study kept a 1428x1162 upscaled copy of every bake (~6.6 MB each,
 *      "roughly 32 MB" by its own port note). Here the 476x388 buffer is kept
 *      and `drawImage` scales it with filtering off, which is one raster call
 *      either way and 9x less memory. That is also what the soft places
 *      already do with their half-resolution layer.
 *   2. The study drifts the baked plane but not the live one. With a 30 px
 *      horizon that slides the grains 28 px across their own hole, so `live`
 *      takes the drift too on a Direction A place: the sky is one rigid plane.
 *   3. Drift stays on the engine's `t * 0.0016` (a 3927-frame period), not the
 *      study's 1400. Five places breathing out of step with the other 22 is a
 *      worse defect than a slow breath.
 *   4. EVENT HORIZON's dust is the study's Keplerian inspiral, not the
 *      Newtonian integrator it replaces, which the brief asked to keep. The
 *      disc is a plane at 0.42 squash and the grains ride *in* it; a
 *      screen-plane 2D integrator cannot do that, which is exactly why the old
 *      painter had to draw the disc separately from its dust. The behaviour
 *      the entry promises survives -- omega goes as r^-1.5, so a grain both
 *      brightens and accelerates on the way in, and is gone at the horizon --
 *      and it drops the `Math.random()` the old `orbiter` used, which this
 *      file's own rules forbid.
 *   5. The singularity moved from `-H * 0.3` (entirely above the arena, so the
 *      hole and the photon ring were never on screen and the thumbnail was a
 *      smear of dust) to `H * 0.30`, inside it. The `desc` moved with it.
 *   6. The veil is per place now (`p.veil`, 0-22%) instead of the flat 30% laid
 *      over all 27. `bgScrim` falls back to `BG_SCRIM` for the rest.
 *   7. Point lights take `p.starRamp` rather than the top of the place's own
 *      ramp. The study's rule broke the one hard constraint the veil exists
 *      for: EVENT HORIZON's ramp is entirely warm, so its 300 baked stars came
 *      out as 3 px amber squares on black -- the size, the colour and the
 *      surround of a bullet. Measured on the composed arena 1500 frames in,
 *      counting warm blobs of 40 px or less sitting on a surround under
 *      luminance 40: EVENT HORIZON 1 (a grain on the disc's own edge) and
 *      VIOLET NEBULA 0, against dozens before. The other three are at 0
 *      because nothing in them is warm at all.
 *   8. ASTEROID BELT's far rocks are sized in art pixels. The study's 1-4.4 px
 *      radius rounds to exactly one art pixel for all 520 of them at its own
 *      default scale, so the band baked as dither noise and the lit-edge
 *      branch never ran once. They are 1-3 art pixels across now.
 *   9. The same place's mid rocks were painted one rung over the haze they sit
 *      on and could not be seen: body two rungs over it, lit edge four, shadow
 *      under it.
 *  10. A grain on the far side of the disc is hidden by the horizon. The disc
 *      is squashed and the hole is not, so the innermost grains crossed the
 *      black circle and lit up inside it.
 *
 * Measured against this arena rather than carried over: the box is the same
 * 1428x1162 the study drew for, so its geometry transfers unchanged. The two
 * numbers that had to be checked here are the belt's separation from the wave
 * -- scenery rocks drift at 0.10-0.32 px/frame and 6-9 px wide against
 * `spawnRock`'s 0.7-2.0 px/frame and 32-80 px -- and the live budget, which
 * comes out at 12 rasterising calls for the three quiet places, 78 for `belt`
 * and 96 for `blackhole`, against the ~122 average the animator ports quote.
 */

// The static layer is soft gradient art, so half resolution is free quality.
const LAYER_SCALE = 0.5;
// Slow parallax breathing applied to the static layer, in logical pixels. The
// baked box is this much taller on each side so the edge never shows.
const DRIFT = 14;
// Veil between the backdrop and the play field, for the places still painted
// the old way. Nine of the 27 (lava, supernova, binary, graveyard...) paint in
// the same warm reds and the same 1-3 px motes the enemy bullets use, and in
// `lighter` they add up until a bullet is indistinguishable from scenery. One
// flat number fixes those nine and flattens the other eighteen, which is why a
// Direction A place carries its own `p.veil` instead -- see `bgScrim`.
export const BG_SCRIM = "rgba(5,6,14,0.30)";
// One baked sky pixel, in logical pixels. At 3 the whole box bakes into a
// 476x388 buffer that is blown back up with filtering off, so the sky lands on
// the same lattice as the sprites in front of it.
const ART_PIX = 3;
// Bayer 4x4 ordered dither, and how much of a rung its threshold is worth. It
// is what carries a gradient across a ramp only eight rungs deep: at 0 every
// Direction A place bands into visible steps.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const DITHER = 1;
// EVENT HORIZON's geometry, in logical pixels: the horizon, where the disc
// starts and ends, and how flat it is seen from here.
const HOLE_R = 30;
const DISC_R0 = 52;
const DISC_R1 = 300;
const DISC_SQ = 0.42;
// BLUE MARBLE's star, as a direction rather than a sprite: up and to the
// right of the globe, which is what puts the terminator across its far half.
const SUN_X = 0.55;
const SUN_Y = -0.62;
const SUN_Z = 0.56;
// The field of a place that paints nothing at all, shared so the bake does not
// allocate one per art pixel.
const FIELD_DARK = { v: 0 };
// The arena the glossary thumbnails are composed in. Painters place things in
// logical pixels, so a still has to be taken at the size they were written for
// and scaled down afterwards, not painted small.
const THUMB_W = 680;
const THUMB_H = 540;
// Frames of warm-up before the still is taken, so the live painters have
// something on screen. The comet sets the number: it starts off the left edge
// and needs about this long to reach the middle.
const THUMB_WARMUP = 1500;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** Deterministic xorshift: the same place looks the same on every machine. */
function mkRng(seed) {
    let s = seed || 1;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

function hexRGB(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex, a) {
    const c = hexRGB(hex);
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** Soft radial glow: the building block of nearly everything in here. */
function blob(g, x, y, r, color, alpha) {
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, rgba(color, alpha));
    grd.addColorStop(0.45, rgba(color, alpha * 0.34));
    grd.addColorStop(1, rgba(color, 0));
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, 6.2832);
    g.fill();
}

/** A star with a glow and a thin cross flare. */
function sun(g, x, y, r, color, alpha = 1) {
    g.save();
    g.globalCompositeOperation = "lighter";
    blob(g, x, y, r * 6, color, 0.3 * alpha);
    blob(g, x, y, r * 2.2, color, 0.55 * alpha);
    g.fillStyle = rgba("#ffffff", 0.92 * alpha);
    g.beginPath();
    g.arc(x, y, r, 0, 6.2832);
    g.fill();
    g.strokeStyle = rgba(color, 0.35 * alpha);
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x - r * 5, y);
    g.lineTo(x + r * 5, y);
    g.moveTo(x, y - r * 4);
    g.lineTo(x, y + r * 4);
    g.stroke();
    g.restore();
}

/** Speckle of faint far-away stars, for the layers that want their own. */
function speckle(g, bd, n, color, maxA) {
    for (let i = 0; i < n; i++) {
        const x = bd.x0 + bd.rng() * bd.w;
        const y = bd.y0 + bd.rng() * bd.h;
        const s = bd.rng() * 1.4 + 0.3;
        g.fillStyle = rgba(color, 0.1 + bd.rng() * maxA);
        g.fillRect(x, y, s, s);
    }
}


/* -------------------------------------------------------------------------- */
/* Direction A helpers                                                         */
/* -------------------------------------------------------------------------- */

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The veil this place needs, as a canvas fill. Direction A gives every place
 * its own number in the data file -- none at all for DEEP SPACE, 22% under an
 * accretion disc -- because the flat 30% that used to go over all 27 was a fix
 * for nine of them and a tax on the other eighteen. Everything not ported yet
 * still gets the flat one.
 *
 * @param {object} def - one entry of BACKGROUNDS
 * @returns {string}
 */
export function bgScrim(def) {
    const veil = def && def.p ? def.p.veil : undefined;
    return veil === undefined ? BG_SCRIM : "rgba(6,4,12," + (veil / 100).toFixed(3) + ")";
}

/**
 * Mulberry32. A second generator next to `mkRng`, kept because the study's
 * literal seeds are what place the stars and the rocks: reseeding them off the
 * id would reshuffle art that was tuned by eye against these exact layouts.
 */
function mulberry32(seed) {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Integer hash in 0..1, for a value that has to stay put across respawns. */
function hash2(x, y, s) {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(s | 0, 0xc2b2ae35);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2545f491);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
}

/** A ramp as RGB triplets, so the bake never parses a hex per art pixel. */
function rampRGB(ramp) {
    return ramp.map(hexRGB);
}

/**
 * Value noise on a 64x64 lattice, smoothstepped and summed over `oct` octaves.
 * Every Direction A place is a couple of these read through a shaping function:
 * it is the one thing that gives eight rungs something to quantise.
 */
function mkNoise(seed) {
    const G = 64;
    const rng = mulberry32(seed);
    const grid = new Float32Array(G * G);
    for (let i = 0; i < G * G; i++) {
        grid[i] = rng();
    }
    const at = (x, y) => grid[((((y % G) + G) % G) * G) + (((x % G) + G) % G)];
    const smp = (x, y) => {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        const fx = x - xi;
        const fy = y - yi;
        const ux = fx * fx * (3 - 2 * fx);
        const uy = fy * fy * (3 - 2 * fy);
        const a = at(xi, yi);
        const b = at(xi + 1, yi);
        const c = at(xi, yi + 1);
        const d = at(xi + 1, yi + 1);
        const top = a + (b - a) * ux;
        const bot = c + (d - c) * ux;
        return top + (bot - top) * uy;
    };
    return (x, y, oct) => {
        let s = 0;
        let amp = 0.5;
        let f = 1;
        let norm = 0;
        for (let o = 0; o < oct; o++) {
            s += smp(x * f, y * f) * amp;
            norm += amp;
            amp *= 0.5;
            f *= 2.07;
        }
        return s / norm;
    };
}

/**
 * Snap a live element onto the baked art grid. The lattice is anchored on the
 * corner of the box, not on the arena, so a grain and the pixel of sky under
 * it line up; a live element drawn off it is the one thing that gives the
 * direction away.
 */
function snapTo(origin, v) {
    return origin + Math.floor((v - origin) / ART_PIX) * ART_PIX;
}

/** The far stars a Direction A place bakes into its own layer, in box coords. */
function starList(bd, seed, n, aMin) {
    const rng = mulberry32(seed);
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({
            x: bd.x0 + rng() * bd.w,
            y: bd.y0 + rng() * bd.h,
            a: aMin + rng() * 0.5,
            big: rng() > 0.87,
        });
    }
    return out;
}

/**
 * The dozen stars that breathe, inside the arena only. They are the whole live
 * layer of three of the five places: one art pixel each, three alpha steps,
 * and they never leave the place's own ramp, so they cannot show a colour the
 * sky behind them does not have.
 */
function twinkleList(bd, seed, n) {
    const rng = mulberry32(seed);
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({
            x: 40 + rng() * (bd.W - 80),
            y: 30 + rng() * (bd.H - 60),
            ph: rng() * 6.2832,
            rate: 0.006 + rng() * 0.01,
            a: 0.3 + rng() * 0.32,
        });
    }
    return out;
}

/** Their phase is the only state three of the five places keep. */
function breathe(bd, ts) {
    for (const t of bd.twinkle) {
        t.ph += t.rate * ts;
    }
}

/**
 * The three colours a point light in this place is allowed to be, dim to
 * bright. The top of the place's own ramp by default, which is what keeps a
 * star inside the sky it is in -- but a place whose ramp is entirely warm has
 * to say otherwise, or its stars come out as 3 px amber squares on black and
 * are exactly what the bullets look like.
 */
function starRamp(bd) {
    return bd.p.starRamp || [bd.p.ramp[5], bd.p.ramp[6], bd.p.ramp[7]];
}

/** Draw them: 12 rasterising calls a frame, worst case. */
function twinkles(bd, g) {
    const ramp = starRamp(bd);
    for (const t of bd.twinkle) {
        const a = t.a * (0.45 + 0.55 * Math.sin(t.ph));
        const q = Math.round(clamp(a, 0, 1) * 3) / 3;
        if (q <= 0) {
            continue;
        }
        g.fillStyle = q > 0.66 ? ramp[2] : q > 0.33 ? ramp[1] : ramp[0];
        g.fillRect(snapTo(bd.x0, t.x), snapTo(bd.y0, t.y), ART_PIX, ART_PIX);
    }
}

/* -------------------------------------------------------------------------- */
/* Painters                                                                    */
/* -------------------------------------------------------------------------- */

const PAINTERS = {
    // Nothing at all: the engine star field is the whole sky. Still the
    // fallback for an entry whose `kind` does not resolve.
    void: {},

    /* -- Direction A: places 1-5 ------------------------------------------- */

    /**
     * DEEP SPACE. One plane and nothing to separate it from, which is the
     * place: the field never leaves rung 0, so what you see is 420 baked stars,
     * a dozen of them breathing, and the engine's own 44 near stars on top.
     * The only place in the catalogue that needs no veil at all.
     */
    pixelDeep: {
        init(bd) {
            bd.stars = starList(bd, 0x1a77, 420, 0.18);
            bd.twinkle = twinkleList(bd, 0x2f10, 12);
        },
        field: () => FIELD_DARK,
        update: breathe,
        live: twinkles,
    },

    /**
     * BLUE MARBLE. Two ramps in one bake: the noise decides sea or land per art
     * pixel and the field hands the bake whichever of the two that pixel
     * belongs to, which is the only way a coastline survives eight rungs. The
     * star is a direction rather than a sprite -- lambert against the sphere
     * normal -- so the terminator is baked and the lit half costs nothing.
     */
    pixelMarble: {
        init(bd) {
            bd.cx = bd.x0 + bd.w * 0.3;
            bd.cy = bd.y0 + bd.h * 0.86;
            bd.r = bd.w * 0.42;
            bd.land = mkNoise(0x6c31);
            bd.cloud = mkNoise(0x91ab);
            bd.stars = starList(bd, 0x4b02, 300, 0.24);
            bd.twinkle = twinkleList(bd, 0x7712, 12);
        },
        // The globe is solid: a star behind it is not drawn at all.
        occlude(bd, x, y) {
            const dx = (x - bd.cx) / bd.r;
            const dy = (y - bd.cy) / bd.r;
            return dx * dx + dy * dy <= 1 ? 1 : 0;
        },
        field(bd, x, y) {
            const dx = (x - bd.cx) / bd.r;
            const dy = (y - bd.cy) / bd.r;
            const q = dx * dx + dy * dy;
            if (q > 1) {
                // Outside the disc there is only air, falling off over about a
                // tenth of a radius.
                return { v: clamp(Math.exp(-(Math.sqrt(q) - 1) * 11) * 0.85, 0, 1) * 0.9 };
            }
            const bx = x - bd.x0;
            const by = y - bd.y0;
            const nz = Math.sqrt(Math.max(0, 1 - q));
            const lit = Math.pow(clamp(dx * SUN_X + dy * SUN_Y + nz * SUN_Z, 0, 1), 0.85);
            const l = bd.land(bx * 0.0055, by * 0.0055, 4);
            const isLand = l > 0.52;
            const clouds = clamp((bd.cloud(bx * 0.01 + 4, by * 0.0085, 3) - 0.6) * 2.4, 0, 1);
            // Land sits darker than sea and carries its own relief; cloud is
            // painted over both at nearly full lit value.
            let v = lit * (isLand ? 0.52 + (l - 0.52) * 0.8 : 0.68);
            v = v * (1 - clouds * 0.55) + clouds * lit * 0.95;
            // Limb darkening: the rim of the disc loses nearly half its value.
            v *= 0.55 + 0.45 * clamp((1 - q) * 3.2, 0, 1);
            return { v: clamp(v, 0, 1), rgb: isLand && clouds < 0.4 ? bd.rgbAlt : bd.rgb };
        },
        update: breathe,
        live: twinkles,
    },

    /**
     * VIOLET NEBULA. The place the direction was decided on: it has more
     * gradient in it than anything else in the catalogue, so if the dither
     * holds here it holds everywhere. Three noises -- the gas, the dust lanes
     * cut through it, a fine grain over both -- and a cap at rung 6, so however
     * bright the gas gets it stops short of the pale pink the enemies fire in.
     */
    pixelNebula: {
        init(bd) {
            bd.n1 = mkNoise(0x9e3f);
            bd.n2 = mkNoise(0x51c7);
            bd.n3 = mkNoise(0x2b81);
            bd.cx = bd.x0 + bd.w * 0.42;
            bd.cy = bd.y0 + bd.h * 0.45;
            bd.rr = bd.w * 0.58 * (bd.w * 0.58);
            bd.stars = starList(bd, 0x7b19, 300, 0.24);
            bd.twinkle = twinkleList(bd, 0x3ac5, 12);
        },
        // Gas dims the stars behind it and never quite hides them, which is
        // what the entry promises.
        occlude(bd, x, y) {
            return gasDensity(bd, x, y) * 0.8;
        },
        field(bd, x, y) {
            return { v: gasDensity(bd, x, y) };
        },
        update: breathe,
        live: twinkles,
    },

    /**
     * ASTEROID BELT. Two planes, and the separation between them is the place:
     * 520 rocks baked into the haze band, 26 nearer ones drifting down over it
     * at 0.10-0.32 px a frame and 6-9 px across. The rocks that can kill you
     * are the wave's, at 0.7-2.0 px a frame and 32-80 px across -- an order of
     * magnitude apart on both axes, which is what stops the scenery reading as
     * a target.
     */
    pixelBelt: {
        init(bd) {
            bd.haze = mkNoise(0x33cd);
            bd.stars = starList(bd, 0x5e88, 340, 0.24);
            const rng = mulberry32(0x8ad2);
            bd.far = [];
            for (let i = 0; i < 520; i++) {
                // Rocks crowd the middle of the band and thin towards its
                // edges: depth the haze on its own does not give.
                const band = Math.exp(-Math.pow((rng() * 2 - 1) * 1.5, 2));
                bd.far.push({
                    x: bd.x0 + rng() * bd.w,
                    y: bd.y0 + bd.h * 0.5 + (rng() * 2 - 1) * bd.h * 0.46 * (1 - band * 0.4),
                    // Measured against this arena rather than carried over: the
                    // study's 1-4.4 px radius rounds to one art pixel for every
                    // rock at a 3 px scale, so the whole band came out as
                    // dither noise and the lit-edge branch below never ran.
                    // Sized in art pixels instead: 1, 2 or 3 across.
                    r: ART_PIX * (0.8 + rng() * 2.2),
                    v: 0.3 + rng() * 0.55,
                });
            }
            const m = mulberry32(0x2caf);
            bd.rocks = [];
            for (let i = 0; i < 26; i++) {
                bd.rocks.push({
                    x: m() * bd.W,
                    y: m() * bd.H,
                    r: 3 + m() * 7,
                    sp: 0.1 + m() * 0.22,
                    a: 0.45 + m() * 0.35,
                });
                // The study drew a rotation per rock and never used it. Keep
                // the draw: without it every rock after the first lands
                // somewhere the sheet was not tuned against.
                m();
            }
        },
        occlude(bd, x, y) {
            return clamp(bd.haze((x - bd.x0) * 0.0035, (y - bd.y0) * 0.006, 3) * 0.55, 0, 0.8);
        },
        field(bd, x, y) {
            const by = y - bd.y0;
            const h = bd.haze((x - bd.x0) * 0.0035, by * 0.006, 3);
            const band = Math.exp(-Math.pow((by - bd.h * 0.5) / (bd.h * 0.34), 2));
            return { v: clamp(h * 0.34 * band + 0.05 * band, 0, 1) };
        },
        hard(bd, g, pix) {
            const ramp = bd.p.ramp;
            for (const rk of bd.far) {
                const rp = Math.max(1, Math.round(rk.r / pix));
                const x = Math.floor((rk.x - bd.x0) / pix);
                const y = Math.floor((rk.y - bd.y0) / pix);
                g.fillStyle = ramp[rk.v > 0.68 ? 5 : rk.v > 0.48 ? 4 : 3];
                g.fillRect(x, y, rp, rp);
                if (rp > 1) {
                    // A single lit art pixel along the top edge is all the
                    // shape a 2-3 px rock can carry.
                    g.fillStyle = ramp[rk.v > 0.68 ? 6 : 5];
                    g.fillRect(x, y, Math.max(1, rp - 1), 1);
                }
            }
        },
        update(bd, ts) {
            for (const rk of bd.rocks) {
                rk.y += rk.sp * ts;
                if (rk.y > bd.H + 12) {
                    rk.y = -12;
                }
            }
        },
        live(bd, g) {
            // 26 rocks, 3 rasterising calls each: body, lit top edge, cast
            // shadow down the right.
            const ramp = bd.p.ramp;
            for (const rk of bd.rocks) {
                const rp = Math.max(2, Math.round(rk.r / ART_PIX));
                const x = snapTo(bd.x0, rk.x);
                const y = snapTo(bd.y0, rk.y);
                // The haze this sits on runs at rungs 1-2, so the study's body
                // at rung 3 was a rock you could not see. Body two rungs over
                // it, lit edge four, and the cast shadow goes *under* the haze
                // rather than into it.
                g.fillStyle = ramp[4];
                g.fillRect(x, y, rp * ART_PIX, rp * ART_PIX);
                g.fillStyle = ramp[rk.a > 0.65 ? 6 : 5];
                g.fillRect(x, y, Math.max(ART_PIX, (rp - 1) * ART_PIX), ART_PIX);
                g.fillStyle = ramp[1];
                g.fillRect(x + (rp - 1) * ART_PIX, y + ART_PIX, ART_PIX, Math.max(ART_PIX, (rp - 1) * ART_PIX));
            }
        },
    },

    /**
     * EVENT HORIZON. The only place whose motion is physics rather than a sine,
     * and the only one whose live layer costs anything: 96 grains on a
     * Keplerian inspiral, angular rate going as r^-1.5, so a grain both
     * brightens and whips round as it falls, and is gone the frame it touches
     * the horizon. The disc they ride in, its photon ring and the hole itself
     * do not move, so all three are baked.
     */
    pixelHorizon: {
        init(bd) {
            bd.cx = bd.W * 0.5;
            bd.cy = bd.H * 0.3;
            bd.dust = mkNoise(0x71e9);
            const rng = mulberry32(0x1f3b);
            bd.grains = [];
            for (let i = 0; i < 96; i++) {
                bd.grains.push({
                    a: rng() * 6.2832,
                    r: DISC_R0 + rng() * (DISC_R1 - DISC_R0),
                    s: 0.9 + rng() * 0.5,
                    seed: rng(),
                });
            }
            bd.stars = starList(bd, 0x6f4c, 300, 0.24);
        },
        occlude(bd, x, y) {
            const v = discValue(bd, x, y);
            return v < 0 ? 1 : clamp(v * 1.5, 0, 1);
        },
        field(bd, x, y) {
            const v = discValue(bd, x, y);
            if (v < 0) {
                return FIELD_DARK;
            }
            const dx = x - bd.cx;
            const dy = y - bd.cy;
            // Photon ring: a thin halo standing just off the horizon, in the
            // plane of the screen rather than the plane of the disc.
            const d = Math.sqrt(dx * dx + dy * dy);
            const halo = Math.exp(-Math.abs(d - HOLE_R * 1.55) / 9) * 0.55;
            return { v: clamp(v + halo, 0, 1) };
        },
        hard(bd, g, pix) {
            // Nothing gets out of there, so the hole is punched to black over
            // the ramp rather than being the ramp's darkest rung.
            g.fillStyle = "#000000";
            const rp = HOLE_R / pix;
            const cxp = (bd.cx - bd.x0) / pix;
            const cyp = (bd.cy - bd.y0) / pix;
            for (let py = Math.floor(cyp - rp - 1); py <= Math.ceil(cyp + rp + 1); py++) {
                for (let px = Math.floor(cxp - rp - 1); px <= Math.ceil(cxp + rp + 1); px++) {
                    const dx = px + 0.5 - cxp;
                    const dy = py + 0.5 - cyp;
                    if (dx * dx + dy * dy <= rp * rp) {
                        g.fillRect(px, py, 1, 1);
                    }
                }
            }
        },
        update(bd, ts) {
            for (const gr of bd.grains) {
                gr.a += 0.02 * Math.pow(DISC_R0 / gr.r, 1.5) * gr.s * ts;
                gr.r -= (0.055 + 0.3 * Math.pow(DISC_R0 / gr.r, 2)) * ts * gr.s;
                if (gr.r <= HOLE_R * 1.04) {
                    // Back out at the rim. The re-entry angle is hashed off the
                    // grain instead of drawn, so the place stays a function of
                    // its id and the clock and nothing else.
                    gr.r = DISC_R1 * (0.86 + gr.seed * 0.14);
                    gr.a = hash2(gr.r * 100, gr.seed * 1000, 7) * 6.2832;
                }
            }
        },
        live(bd, g) {
            // 96 rasterising calls, the worst in the catalogue. A grain gets
            // one rung brighter and then twice as wide on the way in, which is
            // the whole read: it is accelerating.
            const ramp = bd.p.ramp;
            for (const gr of bd.grains) {
                const x = bd.cx + Math.cos(gr.a) * gr.r;
                const dy = Math.sin(gr.a) * gr.r * DISC_SQ;
                const y = bd.cy + dy;
                // The disc is squashed and the horizon is not, so the inner
                // grains cross the black circle. The near half of the disc
                // passes in front of the hole and the far half goes behind it:
                // without the second case a grain shows up as a lit speck
                // inside the one thing nothing gets out of.
                const dx = x - bd.cx;
                if (dy < 0 && dx * dx + dy * dy < HOLE_R * HOLE_R) {
                    continue;
                }
                const t = clamp(1 - (gr.r - HOLE_R) / (DISC_R1 - HOLE_R), 0, 1);
                g.fillStyle = ramp[t > 0.86 ? 7 : t > 0.68 ? 6 : t > 0.45 ? 5 : 4];
                g.fillRect(snapTo(bd.x0, x), snapTo(bd.y0, y), t > 0.78 ? ART_PIX * 2 : ART_PIX, ART_PIX);
            }
        },
    },

    // Coloured gas clouds with a couple of dark dust lanes for depth.
    nebula: {
        paint(bd, g) {
            const { c1, c2 } = bd.p;
            g.globalCompositeOperation = "lighter";
            for (let i = 0; i < 24; i++) {
                blob(
                    g,
                    bd.x0 + bd.rng() * bd.w,
                    bd.y0 + bd.rng() * bd.h,
                    100 + bd.rng() * 260,
                    bd.rng() < 0.5 ? c1 : c2,
                    0.05 + bd.rng() * 0.08
                );
            }
            g.globalCompositeOperation = "source-over";
            for (let i = 0; i < 8; i++) {
                g.save();
                g.translate(bd.x0 + bd.rng() * bd.w, bd.y0 + bd.rng() * bd.h);
                g.rotate((bd.rng() - 0.5) * 2);
                g.fillStyle = "rgba(3,4,10,0.5)";
                g.beginPath();
                g.ellipse(0, 0, 60 + bd.rng() * 180, 12 + bd.rng() * 26, 0, 0, 6.2832);
                g.fill();
                g.restore();
            }
            g.globalCompositeOperation = "lighter";
            speckle(g, bd, 90, "#ffffff", 0.35);
            g.globalCompositeOperation = "source-over";
        },
    },

    // Tunnel of light: concentric rings turning at different speeds.
    wormhole: {
        init(bd) {
            bd.cx = bd.W * 0.5;
            bd.cy = bd.H * 0.32;
        },
        live(bd, g) {
            g.save();
            g.globalCompositeOperation = "lighter";
            g.translate(bd.cx, bd.cy);
            for (let i = 0; i < 14; i++) {
                const ph = (bd.t * 0.006 + i / 14) % 1;
                const r = 40 + ph * 620;
                g.save();
                g.rotate(bd.t * 0.002 * (i % 2 ? 1 : -1) + i);
                g.scale(1, 0.7);
                g.strokeStyle = rgba(i % 2 ? bd.p.c1 : bd.p.c2, 0.34 * (1 - ph));
                g.lineWidth = 3 + ph * 10;
                g.beginPath();
                g.arc(0, 0, r, 0, 6.2832);
                g.stroke();
                g.restore();
            }
            blob(g, 0, 0, 90, bd.p.c1, 0.5);
            g.restore();
        },
    },

    // A star with planets on wide orbits, seen from far outside the system.
    system: {
        paint(bd, g) {
            const cx = bd.p.cx * bd.W;
            const cy = bd.p.cy * bd.H;
            g.save();
            g.strokeStyle = "rgba(160,190,255,0.10)";
            g.lineWidth = 1;
            for (let i = 0; i < 5; i++) {
                const r = 150 + i * 130;
                g.beginPath();
                g.ellipse(cx, cy, r, r * 0.34, 0.2, 0, 6.2832);
                g.stroke();
            }
            g.restore();
            sun(g, cx, cy, 26, bd.p.star);
            const cols = ["#8fb6ff", "#d9a066", "#7bffb0", "#ff9db0", "#c9a4ff"];
            for (let i = 0; i < 5; i++) {
                const r = 150 + i * 130;
                const ang = 0.7 + i * 1.3;
                const x = cx + Math.cos(ang) * r;
                const y = cy + Math.sin(ang) * r * 0.34;
                const rad = 6 + (i % 3) * 4;
                blob(g, x, y, rad * 4, cols[i], 0.28);
                g.fillStyle = cols[i];
                g.beginPath();
                g.arc(x, y, rad, 0, 6.2832);
                g.fill();
                g.fillStyle = "rgba(0,0,0,0.45)";
                g.beginPath();
                g.arc(x + rad * 0.45, y + rad * 0.2, rad, 0, 6.2832);
                g.fill();
            }
        },
    },

    // Two stars locked together, with the gas bridge between them.
    binary: {
        paint(bd, g) {
            const { a, b } = bd.p;
            g.save();
            g.globalCompositeOperation = "lighter";
            const grd = g.createLinearGradient(bd.W * 0.22, -bd.H * 0.1, bd.W * 0.8, bd.H * 0.16);
            grd.addColorStop(0, rgba(a, 0.22));
            grd.addColorStop(0.5, rgba("#ffffff", 0.10));
            grd.addColorStop(1, rgba(b, 0.22));
            g.fillStyle = grd;
            g.save();
            g.translate(bd.W * 0.5, bd.H * 0.03);
            g.rotate(0.16);
            g.fillRect(-bd.W * 0.34, -34, bd.W * 0.68, 68);
            g.restore();
            g.restore();
            sun(g, bd.W * 0.22, -bd.H * 0.1, 30, a);
            sun(g, bd.W * 0.8, bd.H * 0.16, 20, b);
            speckle(g, bd, 60, "#ffffff", 0.3);
        },
    },

    // Neutron star: the beams sweep past every couple of seconds.
    pulsar: {
        init(bd) {
            bd.cx = bd.W * 0.5;
            bd.cy = -bd.H * 0.12;
        },
        live(bd, g) {
            g.save();
            g.globalCompositeOperation = "lighter";
            g.translate(bd.cx, bd.cy);
            g.rotate(bd.t * 0.011);
            for (const s of [1, -1]) {
                const grd = g.createLinearGradient(0, 0, 0, s * 1300);
                grd.addColorStop(0, rgba(bd.p.c1, 0.42));
                grd.addColorStop(1, rgba(bd.p.c1, 0));
                g.fillStyle = grd;
                g.beginPath();
                g.moveTo(0, 0);
                g.lineTo(-120, s * 1300);
                g.lineTo(120, s * 1300);
                g.closePath();
                g.fill();
            }
            g.restore();
            sun(g, bd.cx, bd.cy, 12, bd.p.c1, 0.9 + Math.sin(bd.t * 0.3) * 0.1);
        },
    },

    // A star tearing itself apart: shock rings expanding out of the remnant.
    supernova: {
        init(bd) {
            bd.cx = bd.W * 0.5;
            bd.cy = bd.H * 0.1;
        },
        paint(bd, g) {
            g.globalCompositeOperation = "lighter";
            for (let i = 0; i < 16; i++) {
                blob(
                    g,
                    bd.cx + (bd.rng() - 0.5) * bd.W * 1.2,
                    bd.cy + (bd.rng() - 0.5) * bd.H,
                    80 + bd.rng() * 200,
                    bd.rng() < 0.5 ? bd.p.c1 : bd.p.c2,
                    0.05 + bd.rng() * 0.06
                );
            }
            g.globalCompositeOperation = "source-over";
        },
        live(bd, g) {
            g.save();
            g.globalCompositeOperation = "lighter";
            for (let i = 0; i < 3; i++) {
                const ph = ((bd.t * 0.0022 + i / 3) % 1);
                const r = 30 + ph * 900;
                g.strokeStyle = rgba(i % 2 ? bd.p.c2 : bd.p.c1, 0.4 * (1 - ph) * (1 - ph));
                g.lineWidth = 6 + ph * 26;
                g.beginPath();
                g.arc(bd.cx, bd.cy, r, 0, 6.2832);
                g.stroke();
            }
            const f = 0.8 + Math.sin(bd.t * 0.17) * 0.12 + Math.sin(bd.t * 0.41) * 0.08;
            blob(g, bd.cx, bd.cy, 190, bd.p.c1, 0.3 * f);
            blob(g, bd.cx, bd.cy, 70, "#ffffff", 0.5 * f);
            g.restore();
        },
    },

    // Looking straight into the crowded middle of the galaxy.
    galaxy: {
        paint(bd, g) {
            g.save();
            g.globalCompositeOperation = "lighter";
            g.translate(bd.W * 0.5, bd.H * 0.35);
            g.rotate(-0.35);
            for (let arm = 0; arm < 2; arm++) {
                for (let i = 0; i < 460; i++) {
                    const t = i / 460;
                    const ang = arm * Math.PI + t * 4.2;
                    const r = 30 + t * 780;
                    const sp = (bd.rng() - 0.5) * (40 + t * 150);
                    const x = Math.cos(ang) * r + sp;
                    const y = (Math.sin(ang) * r + sp) * 0.42;
                    g.fillStyle = rgba(bd.rng() < 0.25 ? bd.p.c2 : bd.p.c1, 0.1 + bd.rng() * 0.4);
                    g.fillRect(x, y, 1.4, 1.4);
                }
            }
            g.scale(1, 0.42);
            blob(g, 0, 0, 260, bd.p.c1, 0.22);
            blob(g, 0, 0, 90, "#fff3d0", 0.4);
            g.restore();
        },
    },

    /**
     * A world going past: the planet limb fills one side of the sky. `style`
     * picks the surface treatment, and the terminator always comes from the
     * same direction as the light in `p.lit`.
     */
    planet: {
        paint(bd, g) {
            const p = bd.p;
            const cx = p.cx * bd.W;
            const cy = p.cy * bd.H;
            const r = p.r * bd.W;
            if (p.star) {
                sun(g, cx + p.lit * r * 2.6, cy - r * 1.4, 18, p.star);
            }
            if (p.rings) {
                ring(g, bd, cx, cy, r, p.ringColor || "#cbb8a0", true);
            }
            // Body.
            g.save();
            g.beginPath();
            g.arc(cx, cy, r, 0, 6.2832);
            g.clip();
            const grd = g.createRadialGradient(cx + p.lit * r * 0.4, cy - r * 0.35, r * 0.1, cx, cy, r);
            grd.addColorStop(0, p.hi);
            grd.addColorStop(1, p.base);
            g.fillStyle = grd;
            g.fillRect(cx - r, cy - r, r * 2, r * 2);
            surface(g, bd, cx, cy, r, p);
            // Terminator: the unlit side goes to nothing.
            const sh = g.createLinearGradient(cx + p.lit * r, cy, cx - p.lit * r, cy);
            sh.addColorStop(0, "rgba(2,3,8,0)");
            sh.addColorStop(0.55, "rgba(2,3,8,0.55)");
            sh.addColorStop(1, "rgba(2,3,8,0.95)");
            g.fillStyle = sh;
            g.fillRect(cx - r, cy - r, r * 2, r * 2);
            g.restore();
            // Atmosphere rim.
            g.save();
            g.globalCompositeOperation = "lighter";
            g.strokeStyle = rgba(p.atmo || p.hi, 0.5);
            g.lineWidth = 6;
            g.beginPath();
            g.arc(cx, cy, r + 2, -1.2 + (p.lit < 0 ? Math.PI : 0), 1.5 + (p.lit < 0 ? Math.PI : 0));
            g.stroke();
            g.restore();
            if (p.rings) {
                ring(g, bd, cx, cy, r, p.ringColor || "#cbb8a0", false);
            }
            speckle(g, bd, 50, "#ffffff", 0.3);
        },
    },

    // A moon right below: craters and a hard horizon, no atmosphere.
    moon: {
        paint(bd, g) {
            const top = bd.H * 0.62;
            g.fillStyle = bd.p.base;
            g.fillRect(bd.x0, top, bd.w, bd.y0 + bd.h - top);
            for (let i = 0; i < 120; i++) {
                const x = bd.x0 + bd.rng() * bd.w;
                const y = top + bd.rng() * (bd.y0 + bd.h - top);
                const r = 6 + bd.rng() * 46;
                g.fillStyle = rgba(bd.p.hi, 0.1 + bd.rng() * 0.12);
                g.beginPath();
                g.arc(x, y, r, 0, 6.2832);
                g.fill();
                g.fillStyle = "rgba(0,0,0,0.18)";
                g.beginPath();
                g.arc(x - r * 0.2, y - r * 0.2, r * 0.8, 0, 6.2832);
                g.fill();
            }
            const grd = g.createLinearGradient(0, top - 60, 0, top + 40);
            grd.addColorStop(0, rgba(bd.p.hi, 0));
            grd.addColorStop(1, rgba(bd.p.hi, 0.3));
            g.fillStyle = grd;
            g.fillRect(bd.x0, top - 60, bd.w, 100);
            speckle(g, bd, 70, "#ffffff", 0.35);
        },
    },

    /**
     * Flying inside a planet's atmosphere: baked sky, live cloud bands
     * scrolling past. `motes` adds embers, snow or spores on top.
     */
    surface: {
        init(bd) {
            bd.bands = [];
            for (let i = 0; i < 16; i++) {
                bd.bands.push({
                    y: bd.rng(),
                    h: 14 + bd.rng() * 60,
                    a: 0.05 + bd.rng() * 0.16,
                    w: 0.5 + bd.rng() * 0.6,
                    x: bd.rng(),
                });
            }
            bd.motes = [];
            if (bd.p.motes) {
                for (let i = 0; i < 70; i++) {
                    bd.motes.push({
                        x: bd.x0 + bd.rng() * bd.w,
                        y: bd.y0 + bd.rng() * bd.h,
                        v: 0.4 + bd.rng() * 2.2,
                        s: 1 + bd.rng() * 2,
                    });
                }
            }
        },
        paint(bd, g) {
            const grd = g.createLinearGradient(0, bd.y0, 0, bd.y0 + bd.h);
            grd.addColorStop(0, bd.p.sky[0]);
            grd.addColorStop(0.55, bd.p.sky[1]);
            grd.addColorStop(1, bd.p.sky[2]);
            g.fillStyle = grd;
            g.fillRect(bd.x0, bd.y0, bd.w, bd.h);
        },
        update(bd, ts) {
            bd.scroll = (bd.scroll || 0) + (bd.p.speed || 0.7) * ts;
            for (const m of bd.motes) {
                m.y += m.v * (bd.p.motes === "ember" ? -1 : 1) * ts;
                if (m.y > bd.y0 + bd.h) { m.y = bd.y0; }
                if (m.y < bd.y0) { m.y = bd.y0 + bd.h; }
            }
        },
        live(bd, g) {
            g.save();
            g.globalCompositeOperation = bd.p.dark ? "source-over" : "lighter";
            for (const b of bd.bands) {
                let y = bd.y0 + ((b.y * bd.h + bd.scroll) % bd.h);
                const x = bd.x0 + b.x * bd.w * 0.3;
                g.fillStyle = rgba(bd.p.band, b.a);
                g.beginPath();
                g.ellipse(x + bd.w * 0.3, y, bd.w * 0.36 * b.w, b.h * 0.5, 0, 0, 6.2832);
                g.fill();
            }
            g.restore();
            if (bd.motes.length) {
                g.save();
                g.globalCompositeOperation = "lighter";
                g.fillStyle = rgba(bd.p.moteColor || "#ffffff", 0.55);
                for (const m of bd.motes) {
                    g.fillRect(m.x, m.y, m.s, m.s);
                }
                g.restore();
            }
            if (bd.p.lightning && Math.floor(bd.t * 0.02) % 37 === 0) {
                const f = Math.abs(Math.sin(bd.t * 0.6));
                g.save();
                g.globalCompositeOperation = "lighter";
                blob(g, bd.W * 0.3, bd.H * 0.2, 300, bd.p.band, 0.22 * f);
                g.restore();
            }
        },
    },

    // Rocks as far as the eye can see. They are scenery: the asteroids you can
    // actually hit are the engine's, much closer to the camera.
    belt: {
        paint(bd, g) {
            for (let i = 0; i < 150; i++) {
                const x = bd.x0 + bd.rng() * bd.w;
                const y = bd.y0 + bd.rng() * bd.h;
                const r = 3 + bd.rng() * 20;
                const a = 0.1 + bd.rng() * 0.3;
                g.save();
                g.translate(x, y);
                g.rotate(bd.rng() * 6.2832);
                g.fillStyle = rgba(bd.p.base, a);
                g.beginPath();
                for (let k = 0; k < 7; k++) {
                    const ang = (k / 7) * 6.2832;
                    const rr = r * (0.7 + bd.rng() * 0.5);
                    g[k ? "lineTo" : "moveTo"](Math.cos(ang) * rr, Math.sin(ang) * rr);
                }
                g.closePath();
                g.fill();
                g.fillStyle = rgba(bd.p.hi, a * 0.5);
                g.fillRect(-r * 0.3, -r * 0.5, r * 0.5, r * 0.3);
                g.restore();
            }
            speckle(g, bd, 60, "#ffffff", 0.3);
        },
    },

    // Hulls that never made it home.
    graveyard: {
        paint(bd, g) {
            speckle(g, bd, 90, "#ffffff", 0.35);
            for (let i = 0; i < 7; i++) {
                const x = bd.x0 + bd.rng() * bd.w;
                const y = bd.y0 + bd.rng() * bd.h;
                const l = 70 + bd.rng() * 260;
                const h = l * (0.12 + bd.rng() * 0.1);
                g.save();
                g.translate(x, y);
                g.rotate((bd.rng() - 0.5) * 2.4);
                g.fillStyle = rgba(bd.p.base, 0.55);
                g.beginPath();
                g.moveTo(-l / 2, -h / 2);
                g.lineTo(l / 2, -h * 0.2);
                g.lineTo(l / 2, h * 0.2);
                g.lineTo(-l / 2, h / 2);
                g.closePath();
                g.fill();
                g.fillStyle = rgba("#000000", 0.4);
                g.fillRect(-l / 2, 0, l, h / 2);
                // A few panels still have power.
                for (let k = 0; k < 5; k++) {
                    g.fillStyle = rgba(bd.p.hi, 0.15 + bd.rng() * 0.45);
                    g.fillRect(-l / 2 + bd.rng() * l, -h * 0.3 + bd.rng() * h * 0.6, 3, 2);
                }
                g.restore();
            }
        },
    },

    // Somebody still lives out here.
    station: {
        init(bd) {
            bd.cx = bd.p.cx * bd.W;
            bd.cy = bd.p.cy * bd.H;
            bd.r = bd.p.r * bd.W;
            bd.lights = [];
            for (let i = 0; i < 26; i++) {
                bd.lights.push({ a: bd.rng() * 6.2832, ph: bd.rng() * 6.2832 });
            }
        },
        paint(bd, g) {
            speckle(g, bd, 80, "#ffffff", 0.3);
            g.save();
            g.translate(bd.cx, bd.cy);
            g.scale(1, 0.36);
            g.strokeStyle = rgba(bd.p.base, 0.85);
            g.lineWidth = bd.r * 0.16;
            g.beginPath();
            g.arc(0, 0, bd.r, 0, 6.2832);
            g.stroke();
            g.strokeStyle = rgba(bd.p.base, 0.5);
            g.lineWidth = bd.r * 0.05;
            for (let i = 0; i < 6; i++) {
                const a = (i / 6) * 6.2832;
                g.beginPath();
                g.moveTo(0, 0);
                g.lineTo(Math.cos(a) * bd.r, Math.sin(a) * bd.r);
                g.stroke();
            }
            g.restore();
            g.fillStyle = rgba(bd.p.base, 0.9);
            g.beginPath();
            g.arc(bd.cx, bd.cy, bd.r * 0.16, 0, 6.2832);
            g.fill();
        },
        live(bd, g) {
            g.save();
            g.globalCompositeOperation = "lighter";
            for (const l of bd.lights) {
                const x = bd.cx + Math.cos(l.a) * bd.r;
                const y = bd.cy + Math.sin(l.a) * bd.r * 0.36;
                const f = 0.35 + Math.abs(Math.sin(bd.t * 0.03 + l.ph)) * 0.65;
                g.fillStyle = rgba(bd.p.hi, f);
                g.fillRect(x - 1.5, y - 1.5, 3, 3);
            }
            g.restore();
        },
    },

    // Charged particles hitting a magnetosphere: curtains of light.
    aurora: {
        init(bd) {
            bd.curtains = [];
            for (let i = 0; i < 5; i++) {
                bd.curtains.push({
                    x: bd.x0 + (i + 0.5) * (bd.w / 5),
                    w: 60 + bd.rng() * 120,
                    ph: bd.rng() * 6.2832,
                    sp: 0.006 + bd.rng() * 0.012,
                    c: bd.rng() < 0.5 ? bd.p.c1 : bd.p.c2,
                });
            }
        },
        live(bd, g) {
            g.save();
            g.globalCompositeOperation = "lighter";
            for (const c of bd.curtains) {
                const x = c.x + Math.sin(bd.t * c.sp + c.ph) * 90;
                const grd = g.createLinearGradient(x, bd.y0, x, bd.y0 + bd.h);
                grd.addColorStop(0, rgba(c.c, 0));
                grd.addColorStop(0.4, rgba(c.c, 0.20));
                grd.addColorStop(0.75, rgba(c.c, 0.07));
                grd.addColorStop(1, rgba(c.c, 0));
                g.fillStyle = grd;
                g.save();
                g.translate(x, 0);
                g.rotate(Math.sin(bd.t * c.sp * 0.6 + c.ph) * 0.12);
                g.fillRect(-c.w / 2, bd.y0, c.w, bd.h);
                g.restore();
            }
            g.restore();
        },
    },

    // Ice shards big enough to have their own gravity, catching the light.
    crystal: {
        paint(bd, g) {
            speckle(g, bd, 70, "#ffffff", 0.3);
            for (let i = 0; i < 34; i++) {
                const x = bd.x0 + bd.rng() * bd.w;
                const y = bd.y0 + bd.rng() * bd.h;
                const l = 30 + bd.rng() * 150;
                g.save();
                g.translate(x, y);
                g.rotate(bd.rng() * 6.2832);
                const grd = g.createLinearGradient(0, -l / 2, 0, l / 2);
                grd.addColorStop(0, rgba(bd.p.c1, 0.34));
                grd.addColorStop(1, rgba(bd.p.c2, 0.08));
                g.fillStyle = grd;
                g.beginPath();
                g.moveTo(0, -l / 2);
                g.lineTo(l * 0.14, 0);
                g.lineTo(0, l / 2);
                g.lineTo(-l * 0.14, 0);
                g.closePath();
                g.fill();
                g.strokeStyle = rgba(bd.p.c1, 0.3);
                g.lineWidth = 1;
                g.stroke();
                g.restore();
            }
        },
    },

    // A comet on its way in, tail pointing away from the star.
    comet: {
        init(bd) {
            bd.head = { x: bd.x0 - 100, y: bd.y0 + bd.h * 0.25, vx: 0.55, vy: 0.16 };
        },
        paint(bd, g) {
            speckle(g, bd, 90, "#ffffff", 0.35);
            blob(g, bd.W * 0.9, -bd.H * 0.2, 260, bd.p.c2, 0.10);
        },
        update(bd, ts) {
            const h = bd.head;
            h.x += h.vx * ts;
            h.y += h.vy * ts;
            if (h.x > bd.x0 + bd.w + 200) {
                h.x = bd.x0 - 200;
                h.y = bd.y0 + bd.h * (0.1 + (bd.t % 5) / 10);
            }
        },
        live(bd, g) {
            const h = bd.head;
            const len = 420;
            g.save();
            g.globalCompositeOperation = "lighter";
            const grd = g.createLinearGradient(h.x, h.y, h.x - h.vx * len, h.y - h.vy * len);
            grd.addColorStop(0, rgba(bd.p.c1, 0.4));
            grd.addColorStop(1, rgba(bd.p.c1, 0));
            g.strokeStyle = grd;
            g.lineWidth = 26;
            g.lineCap = "round";
            g.beginPath();
            g.moveTo(h.x, h.y);
            g.lineTo(h.x - h.vx * len, h.y - h.vy * len);
            g.stroke();
            blob(g, h.x, h.y, 40, "#ffffff", 0.5);
            g.restore();
        },
    },
};

/**
 * VIOLET NEBULA's gas, 0..1. Read twice per art pixel -- once for the field,
 * once to work out how much of the star behind it survives -- so it is a
 * function rather than a closure the painter has to carry.
 */
function gasDensity(bd, x, y) {
    const bx = x - bd.x0;
    const by = y - bd.y0;
    let d = bd.n1(bx * 0.0042, by * 0.0055, 3);
    // The sine is what stacks the gas into layers instead of leaving it a
    // cloud: one band every ~1010 px of box, warped by the noise itself.
    d = d * 0.86 + 0.26 * Math.sin(by * 0.0062 + d * 3.4) + 0.14;
    // Dust lanes: wherever the second noise crosses its own midpoint the gas
    // is cut down to a third over a band about 0.085 of the noise wide.
    const lane = bd.n2(bx * 0.0016 + by * 0.0009, by * 0.0022, 2);
    d *= 0.34 + 0.66 * clamp(Math.abs(lane - 0.5) / 0.085, 0, 1);
    const dx = x - bd.cx;
    const dy = y - bd.cy;
    d *= 0.42 + 0.58 * Math.exp(-(dx * dx + dy * dy * 1.35) / bd.rr);
    d *= 0.88 + 0.24 * bd.n3(bx * 0.011, by * 0.013, 2);
    return clamp(d, 0, 1);
}

/**
 * EVENT HORIZON's accretion disc, 0..1, or -1 inside the horizon. The disc is
 * a plane seen at 0.42 squash, so the distance that matters is measured in the
 * plane and not on the screen.
 */
function discValue(bd, x, y) {
    const dx = x - bd.cx;
    const dy = (y - bd.cy) / DISC_SQ;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < HOLE_R) {
        return -1;
    }
    if (d > DISC_R1 * 1.25) {
        return 0;
    }
    // Ramp up out of the horizon, fade out past the rim, and brighten steeply
    // towards the inner edge where the gas is moving fastest.
    const band = clamp((d - HOLE_R) / (DISC_R0 - HOLE_R), 0, 1) *
        clamp((DISC_R1 * 1.2 - d) / (DISC_R1 * 0.55), 0, 1);
    const inner = Math.pow(clamp(1 - (d - DISC_R0) / (DISC_R1 - DISC_R0), 0, 1), 1.5);
    // Texture read in polar space, so the streaks run the way the disc turns.
    const tex = 0.72 + 0.42 * bd.dust(Math.atan2(dy, dx) * 7, d * 0.055, 3);
    return clamp(band * (0.3 + 0.85 * inner) * tex, 0, 1);
}

/** Planet rings: `back` is the half behind the body, drawn before it. */
function ring(g, bd, cx, cy, r, color, back) {
    g.save();
    g.translate(cx, cy);
    g.rotate(-0.3);
    g.scale(1, 0.22);
    for (let i = 0; i < 5; i++) {
        const rr = r * (1.35 + i * 0.16);
        g.strokeStyle = rgba(color, i % 2 ? 0.3 : 0.16);
        g.lineWidth = r * 0.09;
        g.beginPath();
        g.arc(0, 0, rr, back ? Math.PI : 0, back ? 6.2832 : Math.PI);
        g.stroke();
    }
    g.restore();
}

/** Surface detail inside an already-clipped planet disc. */
function surface(g, bd, cx, cy, r, p) {
    if (p.style === "gas") {
        for (let i = 0; i < 14; i++) {
            const y = cy - r + bd.rng() * r * 2;
            g.fillStyle = rgba(bd.rng() < 0.5 ? p.hi : p.base, 0.1 + bd.rng() * 0.3);
            g.beginPath();
            g.ellipse(cx, y, r, 6 + bd.rng() * 26, 0, 0, 6.2832);
            g.fill();
        }
    } else if (p.style === "rock") {
        for (let i = 0; i < 60; i++) {
            const a = bd.rng() * 6.2832;
            const d = bd.rng() * r;
            g.fillStyle = rgba("#000000", 0.06 + bd.rng() * 0.14);
            g.beginPath();
            g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 3 + bd.rng() * 22, 0, 6.2832);
            g.fill();
        }
    } else {
        // "marble": continents / ice caps as soft irregular masses.
        for (let i = 0; i < 26; i++) {
            const a = bd.rng() * 6.2832;
            const d = bd.rng() * r * 0.95;
            g.fillStyle = rgba(p.land || p.hi, 0.16 + bd.rng() * 0.3);
            g.save();
            g.translate(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
            g.rotate(bd.rng() * 6.2832);
            g.beginPath();
            g.ellipse(0, 0, 14 + bd.rng() * r * 0.35, 8 + bd.rng() * r * 0.18, 0, 0, 6.2832);
            g.fill();
            g.restore();
        }
    }
}

/* -------------------------------------------------------------------------- */
/* The places                                                                  */
/* -------------------------------------------------------------------------- */

export const BACKGROUNDS = [
    {
        id: "deep", name: "DEEP SPACE", tint: "#8be9ff", kind: "pixelDeep",
        // The ramp is never called above rung 2, so the cap is what the place
        // is rather than a safety net.
        p: {
            veil: 0, topRung: 2,
            ramp: ["#04060c", "#080c16", "#0d1322", "#131b2e", "#1a2340", "#26315a", "#3a4a7a", "#6d80b0"],
        },
        desc: "The sky the star field has all to itself: no gas, no world, nothing painted behind you. Wave 1 is fought in the only place with nothing in it, and the only one that needs no veil between you and it.",
    },
    {
        id: "planet_blue", name: "BLUE MARBLE", tint: "#7fb6ff", kind: "pixelMarble",
        // `ramp` is the old base/hi/atmo run out to eight rungs, `landRamp` the
        // old `land`. Retune the place here: the painter reads nothing else.
        p: {
            veil: 18,
            ramp: ["#02050c", "#061426", "#0b2a4a", "#10426e", "#1a5c8c", "#2b86b0", "#57b3cf", "#a8e0ee"],
            landRamp: ["#04070a", "#0a1410", "#132018", "#1d3020", "#2a4526", "#3d5c2c", "#587a3a", "#86a856"],
        },
        desc: "A living world sitting low on the left, close enough to make out continents through the blue rim of its atmosphere. The star is off to one side, so the far half of it falls away into the dark.",
    },
    {
        id: "nebula_violet", name: "VIOLET NEBULA", tint: "#c9a4ff", kind: "pixelNebula",
        // The old `c1` violet climbing into the old `c2` pink. Capped one rung
        // under the top: the gas may not reach the colour the enemies fire in.
        p: {
            veil: 12, topRung: 6,
            ramp: ["#0a0714", "#1a0f2e", "#2e1748", "#4b2168", "#6f2f86", "#a4508f", "#d98aae", "#f2c4d6"],
            // Same reason as EVENT HORIZON, one order of magnitude smaller: a
            // star taken off the top of this ramp is a pale pink 3 px square,
            // and ten of them landed in a dust lane where nothing else is lit.
            // Stars in a nebula are white anyway, and cool ones read as being
            // behind the gas rather than in it.
            starRamp: ["#4b4470", "#7a74a4", "#b9b6d8"],
        },
        desc: "Violet and pink gas stacked in soft layers, with dark dust lanes cutting across it and stars showing through wherever it thins out. However bright the gas gets, it stops short of the pink the enemies shoot in.",
    },
    {
        id: "belt", name: "ASTEROID BELT", tint: "#c7b8a8", kind: "pixelBelt",
        // From the old base/hi.
        p: {
            veil: 8, topRung: 6,
            ramp: ["#05050a", "#0e0c12", "#1a161c", "#282029", "#3a2f34", "#544344", "#7a6058", "#a8877a"],
        },
        desc: "Rocks as far out as you can see, in two layers: five hundred baked into the haze, a couple of dozen nearer ones drifting down over it. They are scenery and cannot be shot -- the asteroids that can kill you are the near ones the wave spawns, and they come at you five times faster and five times bigger.",
    },
    {
        id: "blackhole", name: "EVENT HORIZON", tint: "#ffb35e", kind: "pixelHorizon",
        // The old `c1` amber. The old `c2` blue is gone: the disc is one
        // temperature now, and the ramp is the only place it can get hot.
        p: {
            veil: 22,
            ramp: ["#04030a", "#120a12", "#241017", "#3d1a1c", "#5e2a1c", "#8c4620", "#c07a2a", "#f0c060"],
            // Stars do not come out of that ramp here: its top three rungs are
            // the amber the enemies fire in, and a star is a 3 px square on
            // black, which is also what a bullet is.
            starRamp: ["#232a38", "#38414f", "#5a6478"],
        },
        desc: "A singularity hanging in the top third of the arena, its accretion disc laid out flat around it. The dust is on real orbits: grains spiral in, go bright as they pick up speed and are gone the moment they reach the horizon.",
    },
    {
        id: "gas_giant", name: "GAS GIANT DESCENT", tint: "#ffca8a", kind: "surface",
        p: { sky: ["#3a1f12", "#8a4a1e", "#d98b3a"], band: "#ffd9a0", speed: 0.8, motes: null },
        desc: "Inside the cloud deck of a gas giant. Amber bands scroll past and the sky runs from near black at the top to lit haze at the bottom.",
    },
    {
        id: "system", name: "INNER SYSTEM", tint: "#ffe9a8", kind: "system",
        p: { cx: 0.28, cy: 0.12, star: "#ffd66b" },
        desc: "A whole system seen from outside it: a yellow star with five planets strung along wide tilted orbits.",
    },
    {
        id: "ice_world", name: "ICE WORLD", tint: "#bfe9ff", kind: "surface",
        p: { sky: ["#0b2438", "#2a6a8f", "#a9dcf2"], band: "#e6f7ff", speed: 0.5, motes: "snow", moteColor: "#ffffff" },
        desc: "Snow falling across a pale blue sky, with cloud banks drifting behind it. The slowest weather of any of the places.",
    },
    {
        id: "comet", name: "COMET TRAIL", tint: "#a8f0ff", kind: "comet",
        p: { c1: "#a8f0ff", c2: "#ffd66b" },
        desc: "A comet crossing on its way in, tail streaming off the head and pointing away from the star. It crosses, leaves and comes round again.",
    },
    {
        id: "ringed", name: "RINGED GIANT", tint: "#e8c98f", kind: "planet",
        p: { cx: 0.78, cy: 0.2, r: 0.5, lit: -1, base: "#6b4a22", hi: "#e2b877", atmo: "#ffd9a0", style: "gas", rings: true, ringColor: "#e8d6b0" },
        desc: "A banded giant filling the top right, with its rings passing behind the body and back out in front of it.",
    },
    {
        id: "lava_world", name: "MOLTEN WORLD", tint: "#ff7a45", kind: "surface",
        p: { sky: ["#1a0603", "#5e1206", "#c23a10"], band: "#ff8a3c", speed: 1.1, motes: "ember", moteColor: "#ffb066", lightning: false },
        desc: "Low over molten ground: red sky and embers rising instead of falling. It paints in the same reds as enemy fire, which is why the backdrop sits behind a veil.",
    },
    {
        id: "pulsar", name: "PULSAR", tint: "#8fd8ff", kind: "pulsar",
        p: { c1: "#8fd8ff" },
        desc: "A neutron star turning fast overhead, sweeping two beams of light past the arena every couple of seconds.",
    },
    {
        id: "graveyard", name: "SHIP GRAVEYARD", tint: "#9aa6c4", kind: "graveyard",
        p: { base: "#2b3350", hi: "#ff8f5e" },
        desc: "Hulls left where they died, tumbled at every angle and going nowhere. A few panels on them still have power and blink.",
    },
    {
        id: "ocean_world", name: "OCEAN WORLD", tint: "#5ee1ff", kind: "surface",
        p: { sky: ["#04202c", "#0a5a72", "#3fb6c9"], band: "#9ff2ff", speed: 0.6, motes: "spore", moteColor: "#bffaff" },
        desc: "Over open water: teal sky, long cloud banks and spores drifting up through them.",
    },
    {
        id: "aurora", name: "ION STORM", tint: "#7bffb0", kind: "aurora",
        p: { c1: "#7bffb0", c2: "#5ee1ff" },
        desc: "Charged particles hitting a magnetosphere. Curtains of green and cyan light lean and swing across the whole sky.",
    },
    {
        id: "moon", name: "LOW MOON ORBIT", tint: "#d6d2c8", kind: "moon",
        p: { base: "#1b1c26", hi: "#c8c4b8" },
        desc: "Low over an airless moon: craters below and a hard horizon, with no atmosphere to soften the edge.",
    },
    {
        id: "nebula_emerald", name: "EMERALD NEBULA", tint: "#7bffb0", kind: "nebula",
        p: { c1: "#25c07a", c2: "#5ee1ff" },
        desc: "The same kind of cloud as the violet nebula, in green and cyan: layered gas, dust lanes and stars behind it.",
    },
    {
        id: "jungle_world", name: "JUNGLE WORLD", tint: "#9ade6b", kind: "surface",
        p: { sky: ["#0a2413", "#1f5a24", "#6fae4a"], band: "#c9f08a", speed: 0.7, motes: "spore", moteColor: "#d9ff9a" },
        desc: "Green haze over a canopy, with spores rising through the cloud bands.",
    },
    {
        id: "binary", name: "BINARY SUNS", tint: "#ffd66b", kind: "binary",
        p: { a: "#ffd66b", b: "#ff6b8a" },
        desc: "Two stars locked together, a gold one above and a small red one below, with the gas bridge streaming between them.",
    },
    {
        id: "station", name: "ORBITAL STATION", tint: "#9fd4ff", kind: "station",
        p: { cx: 0.72, cy: 0.18, r: 0.3, base: "#2f3a56", hi: "#8fe0ff" },
        desc: "A ring station still lit, turning slowly at the top right with lights blinking around the rim. Somebody out here is still home.",
    },
    {
        id: "desert_world", name: "DESERT WORLD", tint: "#e8c07a", kind: "surface",
        p: { sky: ["#2a1a08", "#8a6220", "#e0b874"], band: "#ffe2a8", speed: 0.9, motes: "sand", moteColor: "#ffe2a8" },
        desc: "Sand blowing across an ochre sky, thick enough that you can read the wind in it.",
    },
    {
        id: "supernova", name: "SUPERNOVA", tint: "#ff8f5e", kind: "supernova",
        p: { c1: "#ffb45e", c2: "#ff4f7a" },
        desc: "A star tearing itself apart. Shock rings expand out of the remnant one after another while the core flickers. Another place that shares its colours with enemy fire.",
    },
    {
        id: "crystal", name: "CRYSTAL FIELD", tint: "#a8d8ff", kind: "crystal",
        p: { c1: "#a8d8ff", c2: "#c9a4ff" },
        desc: "Ice shards big enough to hold themselves together, each one catching the light down its length.",
    },
    {
        id: "storm_world", name: "STORM WORLD", tint: "#b9a8ff", kind: "surface",
        p: { sky: ["#0a0a1e", "#2b2350", "#5b4e8a"], band: "#c9b8ff", speed: 1.4, motes: null, lightning: true },
        desc: "The night side of a storm world: violet cloud running faster than anywhere else, and lightning that lights the whole sky from behind.",
    },
    {
        id: "eclipse", name: "ECLIPSE", tint: "#ffd9a0", kind: "planet",
        p: { cx: 0.5, cy: 0.1, r: 0.42, lit: -1, base: "#0b0d18", hi: "#2a2f4a", atmo: "#ffd9a0", style: "rock", star: "#fff2c4" },
        desc: "A dead world dead ahead with the star behind it, so what you get is the ring of atmosphere burning around a black disc.",
    },
    {
        id: "galaxy", name: "GALACTIC CORE", tint: "#ffd6a8", kind: "galaxy",
        p: { c1: "#ffd6a8", c2: "#8fb6ff" },
        desc: "Looking straight into the crowded middle of the galaxy: two arms of stars wound around a core bright enough to read by.",
    },
    {
        id: "wormhole", name: "WORMHOLE", tint: "#c9a4ff", kind: "wormhole",
        p: { c1: "#c9a4ff", c2: "#5ee1ff" },
        desc: "The mouth of a tunnel, straight ahead. Rings of light rush out of it, each one turning against the one before it.",
    },
];

/**
 * The place a wave is fought in. One per wave, in order, cycling: the run keeps
 * moving and a long one ends up going round again. Pure, so every client in a
 * co-op match paints the same sky without it travelling in the snapshot.
 */
export function backgroundForWave(wave) {
    const i = Math.max(0, (wave | 0) - 1) % BACKGROUNDS.length;
    return BACKGROUNDS[i];
}

/* -------------------------------------------------------------------------- */
/* Backdrop                                                                    */
/* -------------------------------------------------------------------------- */

export class Backdrop {
    /**
     * @param {object} def - one entry of BACKGROUNDS
     * @param {number} W - logical arena width
     * @param {number} H - logical arena height
     * @param {number} [layerScale] - resolution of the baked static layer, as a
     *  fraction of the logical size. The glossary thumbnails pass their own:
     *  baking a 130 px card at half the arena resolution is wasted work.
     */
    constructor(def, W, H, layerScale = LAYER_SCALE) {
        this.def = def;
        this.p = def.p || {};
        this.W = W;
        this.H = H;
        this.layerScale = layerScale;
        // The box the camera can reach: the arena plus the margin the star
        // field already covers, plus room for the parallax drift.
        const mx = W * 0.55;
        const my = H * 0.55;
        this.x0 = -mx;
        this.y0 = -my - DRIFT;
        this.w = W + mx * 2;
        this.h = H + my * 2 + DRIFT * 2;
        this.t = 0;
        this.scroll = 0;
        this.rng = mkRng(hash(def.id));
        this.dust = [];
        this.motes = [];
        this.bands = [];
        this.stars = [];
        this.layer = null;
        this.painter = PAINTERS[def.kind] || PAINTERS.void;
        // A Direction A place bakes from `field` instead of `paint`: it is
        // quantised art, so it is composed at full strength and veiled with its
        // own number rather than dimmed with everyone else's.
        this.pixel = !!this.painter.field;
        this.scrim = bgScrim(def);
        if (this.pixel) {
            this.rgb = rampRGB(this.p.ramp);
            this.rgbAlt = this.p.landRamp ? rampRGB(this.p.landRamp) : this.rgb;
        }
        if (this.painter.init) {
            this.painter.init(this);
        }
        if (this.pixel) {
            this._bakeField();
        } else if (this.painter.paint) {
            this._bake();
        }
    }

    /**
     * Direction A bake. The place is sampled once per art pixel, snapped to its
     * ramp through a Bayer 4x4 threshold, and the point lights go on top: stars
     * first, dimmed by whatever the place puts in front of them, then any
     * hard-edged art.
     *
     * The buffer stays at art resolution -- 476x388 for a 1428x1162 box -- and
     * `draw` scales it up with filtering off. That is one raster call either
     * way and a ninth of the memory of keeping the upscale around.
     */
    _bakeField() {
        const pix = ART_PIX;
        const aw = Math.max(1, Math.ceil(this.w / pix));
        const ah = Math.max(1, Math.ceil(this.h / pix));
        const cv = document.createElement("canvas");
        cv.width = aw;
        cv.height = ah;
        const g = cv.getContext("2d");
        const img = g.createImageData(aw, ah);
        const data = img.data;
        const field = this.painter.field;
        const last = this.rgb.length - 1;
        const cap = Math.min(this.p.topRung === undefined ? last : this.p.topRung, last);
        for (let py = 0; py < ah; py++) {
            const row = (py & 3) * 4;
            const y = this.y0 + (py + 0.5) * pix;
            for (let px = 0; px < aw; px++) {
                const s = field(this, this.x0 + (px + 0.5) * pix, y);
                const ramp = s.rgb || this.rgb;
                const bay = (BAYER[row + (px & 3)] / 16 - 0.46) * DITHER;
                const col = ramp[clamp(Math.round(s.v * last + bay), 0, cap)];
                const o = (py * aw + px) * 4;
                data[o] = col[0];
                data[o + 1] = col[1];
                data[o + 2] = col[2];
                data[o + 3] = 255;
            }
        }
        g.putImageData(img, 0, 0);
        // Stars are point lights, so the rung cap does not apply to them: on
        // DEEP SPACE the cap is 2 and the stars are the entire place.
        const occlude = this.painter.occlude;
        const ramp = starRamp(this);
        for (const s of this.stars) {
            const a = s.a * (1 - (occlude ? occlude(this, s.x, s.y) : 0));
            if (a < 0.1) {
                continue;
            }
            const q = Math.round(clamp(a, 0, 1) * 3) / 3;
            g.fillStyle = q > 0.66 ? ramp[2] : q > 0.33 ? ramp[1] : ramp[0];
            const w = s.big ? 2 : 1;
            g.fillRect(Math.floor((s.x - this.x0) / pix), Math.floor((s.y - this.y0) / pix), w, w);
        }
        if (this.painter.hard) {
            this.painter.hard(this, g, pix);
        }
        this.layer = cv;
    }

    /** Render the static art once, at reduced resolution, in logical coordinates. */
    _bake() {
        const k = this.layerScale;
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(this.w * k));
        cv.height = Math.max(1, Math.round(this.h * k));
        const g = cv.getContext("2d");
        g.scale(k, k);
        g.translate(-this.x0, -this.y0);
        this.painter.paint(this, g);
        this.layer = cv;
    }

    update(ts) {
        this.t += ts;
        if (this.painter.update) {
            this.painter.update(this, ts);
        }
    }

    draw(g) {
        g.save();
        // Soft places are drawn dim so the enemies in front of them keep their
        // contrast. A Direction A place is already dark by construction and
        // pays for its contrast with `p.veil`, so it goes down at full value.
        g.globalAlpha = this.pixel ? 1 : 0.85;
        const drift = Math.sin(this.t * 0.0016) * DRIFT;
        if (this.layer) {
            g.save();
            g.translate(0, drift);
            g.imageSmoothingEnabled = !this.pixel;
            g.drawImage(this.layer, this.x0, this.y0, this.w, this.h);
            g.restore();
        }
        if (this.painter.live) {
            if (this.pixel) {
                // The live layer takes the drift too: it is the same plane. Let
                // it stand still and the grains slide across their own hole.
                g.save();
                g.translate(0, drift);
                this.painter.live(this, g);
                g.restore();
            } else {
                this.painter.live(this, g);
            }
        }
        g.restore();
    }
}

/* -------------------------------------------------------------------------- */
/* Thumbnails                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A still of one place, for the glossary card. The painters are written in
 * logical arena pixels, so the frame is composed at arena size and the canvas
 * is scaled down under them; painting it small would shrink the sky but not
 * the things in it.
 *
 * The live painters are stepped forward first, otherwise half the catalogue
 * would come out as an empty box: the comet is still off screen, the shock
 * rings have not left the remnant and the beams have not turned. Only the
 * painters that actually keep state are stepped; the ones that just read the
 * clock are taken straight to the same instant.
 *
 * @param {object} def - one entry of BACKGROUNDS
 * @param {number} [w] - width of the still, in device pixels
 * @returns {HTMLCanvasElement}
 */
export function backdropThumb(def, w = 272) {
    const k = w / THUMB_W;
    const h = Math.round(THUMB_H * k);
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const g = cv.getContext("2d");
    g.fillStyle = "#05060e";
    g.fillRect(0, 0, w, h);
    g.save();
    g.scale(k, k);
    // Only the arena: the painters cover the whole box the camera can reach,
    // and the card is meant to show the part you fly in.
    g.beginPath();
    g.rect(0, 0, THUMB_W, THUMB_H);
    g.clip();
    const bd = new Backdrop(def, THUMB_W, THUMB_H, k);
    if (bd.painter.update) {
        for (let i = 0; i < THUMB_WARMUP; i++) {
            bd.update(1);
        }
    } else {
        bd.t = THUMB_WARMUP;
    }
    bd.draw(g);
    g.fillStyle = bd.scrim;
    g.fillRect(0, 0, THUMB_W, THUMB_H);
    // The star field on top, the way the engine layers it: it is the near
    // layer, and for DEEP SPACE it is the whole picture. Same density the
    // arena shows in game, seeded off the id so a place always looks itself.
    const rng = mkRng(hash(def.id + "stars"));
    for (let i = 0; i < 44; i++) {
        const x = rng() * THUMB_W;
        const y = rng() * THUMB_H;
        const z = rng() * 2 + 0.5;
        // At this scale a sub-pixel star washes out, so it never goes under one
        // device pixel wide.
        const s = Math.max(1 / k, rng() * 1.4 + 0.4);
        g.fillStyle = "rgba(200,220,255," + (0.25 + z * 0.25) + ")";
        g.fillRect(x, y, s, s + z * 2);
    }
    g.restore();
    return cv;
}
