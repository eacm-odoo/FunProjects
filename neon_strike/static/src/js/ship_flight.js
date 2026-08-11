/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - flight animation for the player hulls.
 *
 * Ported from the "Animaciones de naves para bullet hell" design study
 * (`ship-controller.js`), with one deliberate change: the original owned the
 * ship's position through a damped spring towards the pointer. Here the engine
 * (or, on a guest, the host's snapshot) owns the position, so this class only
 * *watches* how it changes and turns that into a pose:
 *
 *   - banking left/right, in 5 tilt steps with hysteresis, from lateral speed
 *   - engine flame that grows with forward thrust
 *   - retro-thrusters when braking
 *   - a barrel roll on brusque direction changes (and on a dash)
 *
 * It is **render only**, exactly like the camera zoom and the backdrop: it is
 * derived from motion every client can already see, so host and guest animate
 * the same flight without a single byte of it travelling over the bus.
 *
 * The tilt frames are not image files: `bankSprite` rasterizes them from the
 * hull's own pixel grid, which keeps the sprite bank the single source of hull
 * art and keeps the per-slot tint working (in co-op the colour is what tells
 * the four ships apart).
 */

import { bankSprite, spriteSize } from "./sprites";

export const SHIP_FLIGHT = {
    // Speeds (logical px/s) that reach a full bank / full thrust. They are
    // scaled for the 680-wide arena, not the design study's 1280-wide canvas.
    bankRef: 620,
    driveRef: 520,
    bankSmooth: 14,             // how fast the bank follows the speed
    driveSmooth: 12,

    maxTilt: 0.13,              // rad of residual rotation (the frames do the rest)
    shear: 0.10,                // horizontal cizalla: micro-perspective between frames
    bankSquash: 0.03,           // extra narrowing; raise it if you drop the frames
    pitchStretch: 0.14,         // stretched when accelerating, squashed when braking

    // Tilt frames [l2, l1, 0, r1, r2]: entering and leaving use different
    // thresholds so a hull sitting exactly on one does not flicker between two.
    frameEnter: 0.30,
    frameExit: 0.22,
    frameEnter2: 0.68,
    frameExit2: 0.58,

    // Barrel roll. These are measured against this engine's arena and its
    // pointer follow (680 px wide, 20% of the remaining distance per frame),
    // not the design study's much larger canvas and softer spring: a smooth
    // circle round the arena flips the bank at ~260 px/s and must never roll,
    // a deliberate hard weave flips it at 600+, a flick across the arena at
    // 5000+. The swing ceiling here is ~0.28, so the trigger sits just under it.
    rollEnabled: true,
    rollTrigger: 0.26,          // bank swing (0..2) that fires a barrel roll
    rollSpeed: 520,             // px/s of lateral speed below which it never fires
    rollDur: 0.40,              // seconds
    // Counted from the *end* of the roll, so sustained weaving punctuates with
    // a roll instead of living in one: at worst 0.40 rolling then 0.85 clear.
    rollCooldown: 0.85,
    // The roll never lets the hull collapse to a line. The design study could
    // afford scaleX going through 0 (nothing was shooting at it); here you have
    // to keep seeing where your hitbox is.
    rollFlat: 0.18,

    flameBase: 0.22,            // idle flame length, as a fraction of the hull
    flameGain: 0.85,            // extra length at full thrust
    retroGain: 0.55,            // retro-thruster size when braking
    glow: true,
    tailColor: "#fb28d0",       // neon pink at the tip of the flame
    // A step bigger than this is a teleport (respawn, arena resize), not
    // flight: it must not read as a full-speed turn.
    teleportPx: 150,
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (cur, tgt, lambda, dt) => cur + (tgt - cur) * (1 - Math.exp(-lambda * dt));
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

export class ShipFlight {
    /** @param {Object} [tuning] overrides on top of `SHIP_FLIGHT` */
    constructor(tuning = null) {
        this.t = Object.assign({}, SHIP_FLIGHT, tuning || {});
        this.reset();
    }

    /** Forget the current flight. Call it whenever the hull is teleported. */
    reset(x = null, y = null) {
        this.x = x;
        this.y = y;
        this.vx = 0;
        this.vy = 0;
        this.bank = 0;
        this.prevBank = 0;
        this.drive = 0;
        this.frameIdx = 2;
        this.roll = 0;          // 0..1 while a barrel roll lasts, 0 otherwise
        this.rollDir = 1;
        this.rollCd = 0;
        this.time = 0;
        return this;
    }

    /**
     * Feed the hull's observed motion. Called from the simulation (never from
     * the draw), so nothing animates while the game is paused.
     *
     * @param {number} x current position
     * @param {number} y
     * @param {number} dt seconds since the last call
     */
    observe(x, y, dt) {
        if (!(dt > 0)) {
            return this;
        }
        const t = this.t;
        this.time += dt;
        if (this.roll === 0 && this.rollCd > 0) {
            this.rollCd -= dt;
        }
        if (this.x === null) {
            this.x = x;
            this.y = y;
        } else {
            const dx = x - this.x;
            const dy = y - this.y;
            this.x = x;
            this.y = y;
            if (Math.abs(dx) > t.teleportPx || Math.abs(dy) > t.teleportPx) {
                this.vx = 0;
                this.vy = 0;
            } else {
                this.vx = dx / dt;
                this.vy = dy / dt;
            }
        }

        this.prevBank = this.bank;
        this.bank = damp(this.bank, clamp(this.vx / t.bankRef, -1, 1), t.bankSmooth, dt);
        this.drive = damp(this.drive, clamp(-this.vy / t.driveRef, -1, 1), t.driveSmooth, dt);
        this._pickFrame();

        if (t.rollEnabled && this.roll === 0 && this.rollCd <= 0) {
            const swing = (Math.abs(this.bank - this.prevBank) / Math.max(dt, 1e-4)) * 0.016;
            const flip = this.bank * this.prevBank < 0;
            if ((flip || swing > t.rollTrigger) && Math.abs(this.vx) > t.rollSpeed) {
                this.kickRoll(this.vx);
            }
        }
        if (this.roll > 0) {
            this.roll += dt / t.rollDur;
            if (this.roll >= 1) {
                this.roll = 0;
            }
        }
        return this;
    }

    /**
     * Pick the tilt frame (0..4) for the current bank, with hysteresis: it
     * takes more bank to enter a frame than to stay in it, so a hull sitting
     * right on a threshold does not flicker between two of them.
     */
    _pickFrame() {
        const t = this.t;
        const a = Math.abs(this.bank);
        const dir = this.bank < 0 ? -1 : 1;
        const cur = Math.abs(this.frameIdx - 2);
        let lvl;
        if (cur === 0) {
            lvl = a > t.frameEnter ? 1 : 0;
        } else if (cur === 1) {
            lvl = a > t.frameEnter2 ? 2 : (a < t.frameExit ? 0 : 1);
        } else {
            lvl = a < t.frameExit2 ? 1 : 2;
        }
        this.frameIdx = 2 + (lvl === 0 ? 0 : dir * lvl);
    }

    /**
     * Fire a barrel roll now, if one is not already running or cooling down.
     * The engine uses this for the dash, which is the brusque move the roll was
     * made for but is too short to be caught by the speed trigger.
     *
     * @param {number} dir sign of the roll (lateral direction of the move)
     * @returns {boolean} true if the roll actually started
     */
    kickRoll(dir) {
        if (!this.t.rollEnabled || this.roll > 0 || this.rollCd > 0) {
            return false;
        }
        this.roll = 1e-4;
        this.rollDir = Math.sign(dir) || 1;
        this.rollCd = this.t.rollCooldown;
        return true;
    }

    /** The resulting visual state. Public so another renderer could use it. */
    pose() {
        const t = this.t;
        const b = this.bank;
        // The roll turns the hull a full circle around its own axis: scaleX
        // going through 0 and negative is what reads as the far side coming up.
        const rollA = this.roll > 0 ? ease(this.roll) * Math.PI * 2 * this.rollDir : 0;
        let rollX = 1;
        if (this.roll > 0) {
            const c = Math.cos(rollA);
            rollX = Math.sign(c) * Math.max(t.rollFlat, Math.abs(c));
        }
        return {
            rot: b * t.maxTilt,
            shear: -b * t.shear,
            sx: (1 - Math.abs(b) * t.bankSquash) * rollX,
            sy: 1 + this.drive * t.pitchStretch,
            level: this.frameIdx - 2,
            thrust: Math.max(0, this.drive),
            brake: Math.max(0, -this.drive),
            rolling: this.roll > 0,
        };
    }

    /**
     * Draw the hull with its flame and thrusters. The caller is expected to
     * have translated the context to the ship's centre already (the engine
     * paints the dash halo and the shield ring around this).
     *
     * @param {CanvasRenderingContext2D} g
     * @param {Object} o
     * @param {string} o.sprite sprite bank name of the hull
     * @param {string} o.tint the ship colour, also the flame accent
     * @param {number} o.px logical pixel size of the sprite
     */
    draw(g, o) {
        const size = spriteSize(o.sprite);
        if (!size.w) {
            return;
        }
        const p = this.pose();
        const cv = bankSprite(o.sprite, o.tint, o.px, p.level);
        if (!cv) {
            return;
        }
        // Flame geometry comes from the flat hull box, so it does not jitter
        // when the tilt frame changes under it.
        const w = size.w * o.px;
        const h = size.h * o.px;

        g.save();
        g.rotate(p.rot);
        g.transform(1, 0, p.shear, 1, 0, 0);
        g.scale(p.sx, p.sy);
        this._flame(g, w, h, p, o.tint);
        this._retro(g, w, h, p, o.tint);
        g.imageSmoothingEnabled = false;
        g.drawImage(cv, -cv.width / 2, -cv.height / 2);
        if (p.rolling) {
            // Metallic glint as the hull turns through the light.
            g.globalCompositeOperation = "lighter";
            g.globalAlpha = 0.35 * Math.sin(this.roll * Math.PI);
            g.drawImage(cv, -cv.width / 2, -cv.height / 2);
            g.globalAlpha = 1;
            g.globalCompositeOperation = "source-over";
        }
        g.restore();
    }

    /** Engine flame, behind the hull: a soft glow plus a 3-step pixel core. */
    _flame(g, w, h, p, accent) {
        const t = this.t;
        // Two detuned sines: fast flicker without an audible period.
        const flick = 0.86 + 0.14 * Math.sin(this.time * 47) + 0.06 * Math.sin(this.time * 113);
        const len = h * (t.flameBase + t.flameGain * p.thrust) * flick;
        if (len <= 1) {
            return;
        }
        const bw = w * (0.16 + 0.09 * p.thrust);
        const y0 = h * 0.34;
        g.save();
        g.translate(-this.bank * w * 0.10, 0); // the flame trails off-centre when banked
        g.globalCompositeOperation = "lighter";
        if (t.glow) {
            g.globalAlpha = 0.30 + 0.3 * p.thrust;
            g.fillStyle = accent;
            g.beginPath();
            g.ellipse(0, y0 + len * 0.35, bw * 1.5, len * 0.75, 0, 0, 6.2832);
            g.fill();
        }
        g.globalAlpha = 1;
        const steps = [
            [1.00, 0.42, "#ffffff"],
            [0.72, 0.78, accent],
            [0.40, 1.00, t.tailColor],
        ];
        for (const [ws, ls, col] of steps) {
            g.fillStyle = col;
            g.fillRect((-bw * ws) / 2, y0, bw * ws, len * ls);
        }
        g.restore();
    }

    /** Retro-thrusters: two forward-facing jets that only show when braking. */
    _retro(g, w, h, p, accent) {
        if (p.brake < 0.04) {
            return;
        }
        const t = this.t;
        const flick = 0.8 + 0.2 * Math.sin(this.time * 61);
        const len = h * t.retroGain * p.brake * flick;
        const bw = w * 0.10;
        g.save();
        g.globalCompositeOperation = "lighter";
        for (const sgn of [-1, 1]) {
            const x = sgn * w * 0.30;
            g.globalAlpha = 0.35;
            g.fillStyle = accent;
            g.beginPath();
            g.ellipse(x, -h * 0.22 - len * 0.3, bw * 1.4, len * 0.8, 0, 0, 6.2832);
            g.fill();
            g.globalAlpha = 1;
            g.fillStyle = "#ffffff";
            g.fillRect(x - bw / 2, -h * 0.22 - len, bw, len);
            g.fillStyle = t.tailColor;
            g.fillRect(x - bw * 0.3, -h * 0.22 - len, bw * 0.6, len * 0.55);
        }
        g.restore();
    }
}
