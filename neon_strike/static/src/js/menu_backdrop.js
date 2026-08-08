/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - animated backdrop for the start menu ("attract mode").
 *
 * Reuses the in-game sprite bank so the menu looks like the same world as the
 * game: a parallax star field, drifting enemies and asteroids, and player ships
 * firing in the background. It is purely decorative: it does not simulate
 * anything, make sound, read input or talk to the bus. The composition
 * (additive halos, bullet trails, orange thruster) follows the reference scene
 * from the design project.
 *
 * When the user asks for less motion (prefers-reduced-motion) a single static
 * frame is painted instead of animating.
 */

import { drawSprite, pxFor } from "./sprites";

// Sprite -> tint, with the same colours the engine uses in game.
const FLOATERS = [
    { name: "drone0", tint: "#ff5d8f", r: 14 },
    { name: "drone1", tint: "#ff5d8f", r: 14 },
    { name: "speedy0", tint: "#ffd166", r: 10 },
    { name: "speedy1", tint: "#ffd166", r: 10 },
    { name: "tank0", tint: "#9b5de5", r: 20 },
    { name: "tank1", tint: "#9b5de5", r: 20 },
    { name: "sniper0", tint: "#4de3c1", r: 16 },
    { name: "kami0", tint: "#ff8f3d", r: 12 },
    { name: "rock0", tint: "#8a8faf", r: 22 },
    { name: "rock1", tint: "#8a8faf", r: 26 },
];
const SHIP_TINTS = ["#5ee1ff", "#ff8fb3", "#7bffb0", "#ffd166"];
const BG = "#05060e";

function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class MenuBackdrop {
    /** @param {HTMLCanvasElement} canvas */
    constructor(canvas) {
        this.cv = canvas;
        this.g = canvas.getContext("2d");
        this.raf = 0;
        this.last = 0;
        this.W = 0;
        this.H = 0;
        this.dpr = 1;
        this.stars = [];
        this.floats = [];
        this.ships = [];
        this.reduced =
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        this._ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.resize()) : null;
        this._loop = () => {
            const now = performance.now();
            // Normalised to 60 fps so it does not run twice as fast on 120 Hz screens.
            const dt = Math.min(3, (now - this.last) / 16.667) || 1;
            this.last = now;
            this.step(dt);
            this.render();
            this.raf = requestAnimationFrame(this._loop);
        };
    }

    start() {
        this.resize();
        if (this._ro) {
            this._ro.observe(this.cv);
        }
        if (this.reduced) {
            this.render();
            return;
        }
        this.last = performance.now();
        this.raf = requestAnimationFrame(this._loop);
    }

    destroy() {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        if (this._ro) {
            this._ro.disconnect();
        }
    }

    resize() {
        const w = this.cv.clientWidth;
        const h = this.cv.clientHeight;
        if (!w || !h) {
            return;
        }
        this.dpr = Math.min(2, window.devicePixelRatio || 1);
        this.cv.width = Math.round(w * this.dpr);
        this.cv.height = Math.round(h * this.dpr);
        this.W = w;
        this.H = h;
        // The menu is wider than the game's logical space (680): without this the
        // sprites would look tiny. Clamped so they do not blow up on 4K.
        this.zoom = Math.max(1, Math.min(1.6, w / 680));
        this._populate();
        if (this.reduced) {
            this.render();
        }
    }

    _populate() {
        const W = this.W;
        const H = this.H;
        // Density by area: same look on mobile and on a big screen.
        const nStars = Math.max(40, Math.min(220, Math.round((W * H) / 5200)));
        this.stars = [];
        for (let i = 0; i < nStars; i++) {
            this.stars.push({ x: Math.random() * W, y: Math.random() * H, z: Math.random() });
        }
        const nFloats = Math.max(5, Math.min(14, Math.round((W * H) / 46000)));
        this.floats = [];
        for (let i = 0; i < nFloats; i++) {
            this.floats.push(this._mkFloat(Math.random() * H));
        }
        const nShips = W < 620 ? 2 : 4;
        this.ships = [];
        for (let i = 0; i < nShips; i++) {
            this.ships.push({
                slot: i % SHIP_TINTS.length,
                tint: SHIP_TINTS[i % SHIP_TINTS.length],
                bx: ((i + 0.5) / nShips) * W,
                y: H - 70,
                amp: 16 + Math.random() * 22,
                ph: Math.random() * 6.2832,
                fire: Math.floor(Math.random() * 46),
                bullets: [],
            });
        }
    }

    _mkFloat(y) {
        const f = FLOATERS[Math.floor(Math.random() * FLOATERS.length)];
        const rock = f.name.startsWith("rock");
        return {
            def: f,
            x: 20 + Math.random() * Math.max(1, this.W - 40),
            y,
            vy: 0.25 + Math.random() * 0.6,
            drift: (Math.random() - 0.5) * 0.5,
            rot: rock ? Math.random() * 6.2832 : 0,
            vr: rock ? (Math.random() - 0.5) * 0.012 : 0,
            ph: Math.random() * 6.2832,
        };
    }

    step(dt) {
        const W = this.W;
        const H = this.H;
        for (const s of this.stars) {
            s.y += (0.3 + s.z * 1.2) * dt;
            if (s.y > H) {
                s.y = -4;
                s.x = Math.random() * W;
            }
        }
        for (let i = 0; i < this.floats.length; i++) {
            const f = this.floats[i];
            f.y += f.vy * dt;
            f.x += Math.sin(f.ph + f.y * 0.01) * f.drift * dt;
            f.rot += f.vr * dt;
            if (f.y > H + 60) {
                this.floats[i] = this._mkFloat(-60);
            }
        }
        for (const sp of this.ships) {
            sp.ph += 0.011 * dt;
            sp.fire -= dt;
            if (sp.fire <= 0) {
                sp.fire = 40 + Math.random() * 18;
                sp.bullets.push({ x: sp.bx + Math.sin(sp.ph) * sp.amp, y: sp.y - 20 });
            }
            for (let i = sp.bullets.length - 1; i >= 0; i--) {
                sp.bullets[i].y -= 6 * dt;
                if (sp.bullets[i].y < -30) {
                    sp.bullets.splice(i, 1);
                }
            }
        }
    }

    _halo(x, y, r, tint) {
        const g = this.g;
        g.save();
        g.globalCompositeOperation = "lighter";
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, rgba(tint, 0.16));
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.beginPath();
        g.arc(x, y, r, 0, 6.2832);
        g.fill();
        g.restore();
    }

    render() {
        const g = this.g;
        const W = this.W;
        const H = this.H;
        if (!W || !H) {
            return;
        }
        g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        g.fillStyle = BG;
        g.fillRect(0, 0, W, H);

        for (const s of this.stars) {
            g.fillStyle = "rgba(200,220,255," + (0.15 + s.z * 0.5) + ")";
            g.fillRect(s.x | 0, s.y | 0, 2, 2 + s.z * 4);
        }

        // The backdrop is dimmed so the menu card stays dominant.
        g.save();
        g.globalAlpha = 0.72;
        for (const f of this.floats) {
            const d = f.def;
            this._halo(f.x, f.y, d.r * 2.4 * this.zoom, d.tint);
            drawSprite(g, d.name, f.x, f.y, {
                tint: d.tint,
                px: pxFor(d.name, d.r * 2 * this.zoom),
                rot: f.rot,
            });
        }

        for (const sp of this.ships) {
            const x = sp.bx + Math.sin(sp.ph) * sp.amp;
            for (const b of sp.bullets) {
                g.save();
                g.globalCompositeOperation = "lighter";
                g.fillStyle = "rgba(94,225,255,0.3)";
                g.fillRect(b.x - 3, b.y, 6, 18);
                g.fillStyle = "#d8f8ff";
                g.fillRect(b.x - 1.5, b.y + 2, 3, 14);
                g.restore();
            }
            g.save();
            g.globalCompositeOperation = "lighter";
            g.fillStyle = "rgba(255,170,70,0.9)";
            g.fillRect(x - 5, sp.y + 16, 4, 14);
            g.fillRect(x + 1, sp.y + 16, 4, 14);
            g.restore();
            this._halo(x, sp.y, 34 * this.zoom, sp.tint);
            drawSprite(g, "ship" + sp.slot, x, sp.y, {
                tint: sp.tint,
                px: pxFor("ship0", 30 * this.zoom),
            });
        }
        g.restore();
    }
}
