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
 * Painters draw in **logical arena coordinates** (the 680x540 space), over the
 * box the camera can reach when it pulls back for a colossus.
 *
 * Each entry also carries the `desc` the glossary shows, so the catalogue of
 * places lives here and not in a second list that would drift from it.
 *
 * `BACKGROUNDS` order is the order they show up in a run: append at the end.
 */

// The static layer is soft gradient art, so half resolution is free quality.
const LAYER_SCALE = 0.5;
// Slow parallax breathing applied to the static layer, in logical pixels. The
// baked box is this much taller on each side so the edge never shows.
const DRIFT = 14;
// Veil between the backdrop and the play field. Nine of the 27 places (lava,
// supernova, binary, black hole, graveyard...) paint in the same warm reds and
// the same 1-3 px motes the enemy bullets use, and in `lighter` they add up
// until a bullet is indistinguishable from scenery. The engine lays it over
// the backdrop, and so does the glossary thumbnail: the card has to show what
// you actually fly in, not the unveiled art.
export const BG_SCRIM = "rgba(5,6,14,0.30)";
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

function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
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
/* Painters                                                                    */
/* -------------------------------------------------------------------------- */

const PAINTERS = {
    // Nothing at all: the engine star field is the whole sky.
    void: {},

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

    /**
     * Black hole. The dust is the only thing in this file with real physics:
     * Newtonian pull towards the singularity, softened at short range so a
     * particle that grazes the horizon does not get flung out at silly speed.
     * Anything that crosses the horizon is gone and respawns at the rim.
     */
    blackhole: {
        init(bd) {
            bd.cx = bd.W * 0.5;
            bd.cy = -bd.H * 0.3;
            bd.hr = 44;                       // event horizon
            bd.rMax = bd.W * 1.15;            // where the disc fades out
            bd.g0 = 1500;                     // GM, tuned by eye
            bd.dust = [];
            for (let i = 0; i < 190; i++) {
                bd.dust.push(orbiter(bd));
            }
        },
        update(bd, ts) {
            for (const d of bd.dust) {
                const dx = bd.cx - d.x;
                const dy = bd.cy - d.y;
                const r2 = dx * dx + dy * dy;
                const r = Math.sqrt(r2) || 1;
                const a = bd.g0 / (r2 + 1200);
                d.vx += (dx / r) * a * ts;
                d.vy += (dy / r) * a * ts;
                d.x += d.vx * ts;
                d.y += d.vy * ts;
                d.spd = Math.hypot(d.vx, d.vy);
                if (r < bd.hr * 0.85 || r > bd.rMax * 1.5) {
                    Object.assign(d, orbiter(bd));
                }
            }
        },
        live(bd, g) {
            const a = bd.t * 0.004;
            g.save();
            g.globalCompositeOperation = "lighter";
            // Accretion disc: two offset ellipses turning slowly.
            for (const [k, c] of [[1, bd.p.c1], [-1, bd.p.c2]]) {
                g.save();
                g.translate(bd.cx, bd.cy);
                g.rotate(a * k);
                g.scale(1, 0.42);
                blob(g, 0, 0, bd.hr * 6, c, 0.3);
                g.restore();
            }
            for (const d of bd.dust) {
                g.fillStyle = rgba(d.spd > 6 ? "#ffe9c4" : bd.p.c1, Math.min(0.9, 0.25 + d.spd * 0.07));
                g.fillRect(d.x, d.y, 1.6, 1.6);
            }
            g.restore();
            // Photon ring, then the hole itself: nothing gets out of there.
            g.save();
            g.strokeStyle = rgba("#ffd9a0", 0.75);
            g.lineWidth = 2.5;
            g.beginPath();
            g.arc(bd.cx, bd.cy, bd.hr * 1.16, 0, 6.2832);
            g.stroke();
            g.fillStyle = "#000000";
            g.beginPath();
            g.arc(bd.cx, bd.cy, bd.hr, 0, 6.2832);
            g.fill();
            g.restore();
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

/** A dust grain on a near-circular orbit, biased slightly inwards. */
function orbiter(bd) {
    const ang = Math.random() * 6.2832;
    const r = bd.hr * 2.4 + Math.random() * (bd.rMax - bd.hr * 2.4);
    // v = sqrt(GM/r) is the circular orbit; 0.92 of it makes the grain fall in.
    const v = Math.sqrt(bd.g0 / r) * 0.92;
    return {
        x: bd.cx + Math.cos(ang) * r,
        y: bd.cy + Math.sin(ang) * r,
        vx: -Math.sin(ang) * v,
        vy: Math.cos(ang) * v,
        spd: v,
    };
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
        id: "deep", name: "DEEP SPACE", tint: "#8be9ff", kind: "void", p: {},
        desc: "The sky the star field has all to itself: no gas, no world, nothing painted behind you. Wave 1 is fought in the only place with nothing in it.",
    },
    {
        id: "planet_blue", name: "BLUE MARBLE", tint: "#7fb6ff", kind: "planet",
        p: { cx: 0.16, cy: 0.86, r: 0.62, lit: 1, base: "#123a6b", hi: "#3f8fd8", land: "#4fb08a", atmo: "#8fd0ff", style: "marble", star: "#fff2c4" },
        desc: "A living world sitting low on the left, close enough to make out continents through the blue rim of its atmosphere. The star is off to one side, so the far half of it is unlit.",
    },
    {
        id: "nebula_violet", name: "VIOLET NEBULA", tint: "#c9a4ff", kind: "nebula",
        p: { c1: "#8a4fff", c2: "#ff4fa8" },
        desc: "Violet and pink gas stacked in soft layers, with dark dust lanes cutting across it and stars showing through wherever it thins out.",
    },
    {
        id: "belt", name: "ASTEROID BELT", tint: "#c7b8a8", kind: "belt",
        p: { base: "#6b6154", hi: "#c9bda8" },
        desc: "Rocks as far out as you can see. They are scenery and cannot be shot: the asteroids that can kill you are the near ones the wave spawns.",
    },
    {
        id: "blackhole", name: "EVENT HORIZON", tint: "#ffb35e", kind: "blackhole",
        p: { c1: "#ff9d3c", c2: "#5ecbff" },
        desc: "A singularity just above the arena with its accretion disc turning around it. The dust is on real orbits: grains spiral in, go bright as they pick up speed and are gone the moment they reach the horizon.",
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
        this.layer = null;
        this.painter = PAINTERS[def.kind] || PAINTERS.void;
        if (this.painter.init) {
            this.painter.init(this);
        }
        if (this.painter.paint) {
            this._bake();
        }
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
        // Everything here is far away: it is drawn dim so the enemies and
        // bullets in front of it keep every bit of their contrast.
        g.save();
        g.globalAlpha = 0.85;
        if (this.layer) {
            g.save();
            g.translate(0, Math.sin(this.t * 0.0016) * DRIFT);
            g.drawImage(this.layer, this.x0, this.y0, this.w, this.h);
            g.restore();
        }
        if (this.painter.live) {
            this.painter.live(this, g);
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
    g.fillStyle = BG_SCRIM;
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
