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

import { bankSprite, canvasBounds, spriteSize } from "./sprites";

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

/* ------------------------------------------------------------------ */
/* The glossary card                                                   */
/* ------------------------------------------------------------------ */

/**
 * The flight a card flies: a lateral weave under a spiking envelope, with a
 * slower climb and brake beneath it, so the card shows every part of the
 * animation the blurb promises -- all five tilt frames, the flame growing, the
 * retros firing, and a barrel roll now and then.
 *
 * The envelope exists because of what a **measurement** said, and the first
 * attempt here is worth recording: a plain sine weave peaking at 672 px/s --
 * comfortably over `rollSpeed` -- rolled exactly **zero** times in 20 seconds.
 * Two reasons, and neither is visible by reading the trigger. The `swing` term
 * is bounded by the damping at ~0.20 against a `rollTrigger` of 0.26, so it is
 * very nearly unreachable and the *flip* is the trigger that actually matters;
 * and a flip only counts while `|vx| > rollSpeed`, which needs the bank to
 * still be crossing zero once the speed has already built the other way. On a
 * gentle weave the bank crosses at ~260 px/s and nothing fires. Only a weave
 * fast enough to leave the bank behind rolls at all -- and one fast enough to
 * roll *continuously* is worse than one that never does, because the roll is
 * meant to punctuate. Hence the envelope: gentle most of the time, one hard
 * flick when it spikes.
 *
 * Measured over 30 s at these numbers: **6 rolls, rolling 8% of the time,
 * |vx| calm below 300 px/s for 46% of it**, and the five tilt frames used
 * 11/25/28/25/11%.
 *
 * `ay` is smaller than it wants to be for a reason that is not about flight:
 * the flame grows with thrust and the card's canvas is cut to what the loop
 * paints, so a hull that pushes hard makes a *taller card* and therefore a
 * *smaller hull* once the 118 px art box has scaled it. At 90 the box is 1.80x
 * the hull and the hull lands at 66 px; at 55 it is 1.56x and 76 px, which is
 * where the enemies' cards sit, and thrust still peaks at 0.30 -- enough for
 * the flame to visibly swell and the retros to fire.
 */
const CARD_PATH = { ax: 140, wx: 9, wm: 0.65, envPow: 8, envBase: 0.28, ay: 55, wy: 2.9 };

/** Frames of a card's loop sampled to find the box its art needs. */
const CARD_FRAMES = 480;

/**
 * The card art for the catalogue: the hull flying, on a canvas cut to what the
 * whole loop paints. Same contract as `fryCard` and `droneCard` -- a size and
 * one function that paints a frame -- so the glossary drives all of them off
 * one rAF without knowing what kind of thing it is looking at.
 *
 * The one difference is that this animation has **state**: `ShipFlight`
 * integrates, so a frame is not a pure function of the clock. The card owns its
 * own instance and steps it with the elapsed time, and the probe pass that
 * measures the canvas uses a second one so the card starts from a clean hull.
 *
 * @param {Object} o `{ sprite, tint, px }` from the catalogue entry
 * @returns {Object} `{ width, height, draw(g, t) }`, sizes in device pixels
 */
export function shipCard(o) {
    const name = o.sprite;
    const size = spriteSize(name);
    const px = o.px;
    // Room for the roll, the flame and the retros; the box is cut to what the
    // loop actually painted, so this only has to be generous.
    const margin = 14;
    const W = Math.round((size.w + 2 * margin) * px);
    const H = Math.round((size.h + 2 * margin) * px);
    const step = (flight, g, sec, dt, cx, cy) => {
        const P = CARD_PATH;
        const env = P.envBase + (1 - P.envBase) * Math.pow(Math.abs(Math.sin(sec * P.wm)), P.envPow);
        flight.observe(
            P.ax * env * Math.sin(sec * P.wx),
            P.ay * Math.sin(sec * P.wy),
            dt
        );
        g.save();
        g.translate(cx, cy);
        flight.draw(g, { sprite: name, tint: o.tint, px });
        g.restore();
    };
    const probe = document.createElement("canvas");
    probe.width = W;
    probe.height = H;
    const pg = probe.getContext("2d");
    const measure = new ShipFlight();
    for (let i = 0; i < CARD_FRAMES; i++) {
        step(measure, pg, i / 60, 1 / 60, W / 2, H / 2);
    }
    const box = canvasBounds(probe, Math.round(px)) || { x: 0, y: 0, w: W, h: H };
    const ox = W / 2 - box.x;
    const oy = H / 2 - box.y;
    const flight = new ShipFlight();
    let last = 0;
    return {
        width: box.w,
        height: box.h,
        draw(g, t) {
            // The clock arrives in 60 fps frames; a gap (a hidden tab, a slow
            // patch) is clamped rather than integrated, or the hull teleports.
            const dt = Math.min(0.05, Math.max(0, (t - last) / 60));
            last = t;
            step(flight, g, t / 60, dt, ox, oy);
        },
    };
}
