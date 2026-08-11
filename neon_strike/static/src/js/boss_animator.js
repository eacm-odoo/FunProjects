/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - flight and combat animation for the 5 regular bosses.
 *
 * Ported from the "Bullet-hell boss animator" design study (`boss-animator.js`),
 * which arrived already respecting the render-only contract. Three deliberate
 * departures from it:
 *
 *   1. **The hulls stay the module's.** The study shipped its own character
 *      grids for all five bosses, but `boss0..boss4` already exist in
 *      `sprites.js`, tinted per catalogue and wired into the chassis variant,
 *      the hit flash and the glossary. Replacing them would be an art swap, not
 *      an animation. The animator is handed a sprite name and draws that.
 *   2. **No lance beam.** The engine already owns the LANCER beam: it
 *      telegraphes it (`warn` frames), damages with it and ships it in the
 *      snapshot as `bm`. Drawing a second one would show a beam where the
 *      hitbox is not.
 *   3. **No hit flash and no death dissolve.** `e.flash` already paints the
 *      white silhouette and travels as `f`; and a dissolve would need the
 *      corpse to outlive `killEnemy`, which is gameplay, not cosmetics.
 *
 * Everything is **render only**: the engine (or, on a guest, the host snapshot)
 * owns position, hit points, armour and every bullet. This reads state that
 * already travels and derives the rest from observed motion, so host and guest
 * animate the same fight with no new bytes on the bus.
 *
 * State cannot live on the enemy object: a guest rebuilds `this.enemies` from
 * scratch on every snapshot, so the engine keeps these animators in a map keyed
 * by boss index and feeds them (see `_updateBossAnims`).
 */

import { drawSprite, sprite, spriteSize } from "./sprites";

/**
 * Reference speeds are **read off the real AI** in `_updateBoss`, not carried
 * over from the study (its 1280-wide canvas made every one of them saturate
 * instantly at this scale). At 60 fps, 1 px per frame = 60 px/s:
 *
 *   DREADNOUGHT  x = W/2 + sin(t*0.016) * W*0.32   -> peak 0.32*680*0.016 ≈ 209 px/s
 *   WARDEN       x += sin(t*0.011) * 1.5           -> peak 90 px/s
 *   HIVE         x += sin(t*0.008) * 1.1           -> peak 66 px/s
 *   LANCER       dive vy = 7, hover |dx| <= 2.2    -> 420 px/s down, 132 across
 */
export const BOSS_ANIM = {
    global: {
        smoothing: 12,          // 1/s, exponential ease for boolean -> 0..1
        lowHpThreshold: 0.30,   // hp01 under which the damage shake starts
        lowHpShake: 2.4,        // px of shake at hp01 = 0
        lowHpShakeHz: 14,
        maxEffects: 48,         // hard cap on cosmetic effects
        // A step bigger than this is a teleport, not flight. For PRISM that is
        // the signal itself; for everyone else it is a guard.
        teleportPx: 60,
    },

    DREADNOUGHT: {
        swayRefSpeed: 180,      // px/s at which the lean saturates
        maxLean: 0.12,          // rad (~7 deg)
        breathHz: 0.55,
        breathAmp: 0.018,
        coreGlowHz: 1.15,
        coreGlowAmp: 0.35,
        thrusterHz: 11,
        thrusterLen: 12,        // px
        burstRingSpeed: 260,    // px/s outward
        burstRingLife: 0.45,    // s
        burstRingWidth: 4,      // px
        salvoFlashLife: 0.14,   // s
        salvoFlashLen: 22,      // px
        recoilPx: 5,            // px
        recoilTime: 0.18,       // s
    },

    WARDEN: {
        armourTravel: 26,       // px each plate slides out when the armour drops
        armourTime: 0.34,       // s for a full raise or drop
        curtainSpin: 0.95,      // rad/s the gap rotates
        curtainGap: 0.95,       // rad (~55 deg)
        curtainNodePx: 4,       // px block size
        curtainPulseHz: 1.6,
        exposedPulseHz: 3.2,    // core pulse during the hurt window
        exposedGlow: 0.55,
        fanFlashLife: 0.16,     // s
        breathHz: 0.4,
        breathAmp: 0.012,
        recoilPx: 3,
        recoilTime: 0.16,
    },

    LANCER: {
        chargeTime: 0.85,       // s the telegraph takes to fill
        diveRefSpeed: 420,      // px/s at which the dive stretch saturates
        diveStretchMax: 1.30,
        diveEnter: 210,         // px/s of downward speed that counts as diving
        afterimageEvery: 0.035, // s between trail samples
        afterimageLife: 0.22,   // s
        afterimageAlpha: 0.40,
        afterimageMax: 8,
        tiltRefSpeed: 180,      // px/s
        maxTilt: 0.22,          // rad (~13 deg)
    },

    HIVE: {
        bayTime: 0.26,          // s to open or close a door
        bayOpenHold: 0.34,      // s the doors stay open after a launch
        bayTravel: 5,           // px each door slides
        bayFlareLife: 0.25,     // s
        bayFlareLen: 16,        // px
        bobAmp: 3.2,            // px
        bobHz: 0.34,
        rimLights: 5,
        rimCycle: 1.7,          // s for one chase along the rim
        hullRollRef: 66,        // px/s
        maxRoll: 0.07,          // rad
        hangarGlowHz: 0.8,
    },

    PRISM: {
        blinkOutTime: 0.10,     // s of collapse (the engine teleports instantly,
                                //  so this plays on arrival, not before)
        blinkInTime: 0.16,      // s to materialise
        blinkScaleMin: 0.15,
        shockSpeed: 420,        // px/s
        shockLife: 0.55,        // s
        shockWidth: 5,          // px
        shockStartR: 30,        // px
        spiralArms: 3,
        spiralSpin: 2.2,        // rad/s
        spiralLength: 78,       // px measured from the centre
        spiralNodePx: 4,
        spiralNodeStep: 9,      // px between blocks along an arm
        spiralCurl: 1.5,        // rad of curl over the arm
        facetSpin: 0.85,        // rad/s
        coreGlowHz: 2.1,
        coreGlowAmp: 0.4,
    },
};

/** Tuning key per BOSSES index — the array order is wire format, so is this. */
export const BOSS_ANIM_KINDS = ["DREADNOUGHT", "WARDEN", "LANCER", "HIVE", "PRISM"];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const ease = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));

/** Pixel-quantised block, so the overlays land on the sprite's own grid. */
function pxRect(g, x, y, w, h, cell) {
    g.fillRect(
        Math.round(x / cell) * cell,
        Math.round(y / cell) * cell,
        Math.max(cell, Math.round(w / cell) * cell),
        Math.max(cell, Math.round(h / cell) * cell)
    );
}

/** Ring of blocks, optionally only over the arc [from, to]. */
function pxRing(g, cx, cy, r, blockPx, cell, from, to) {
    const a0 = from === undefined ? 0 : from;
    const a1 = to === undefined ? Math.PI * 2 : to;
    const steps = Math.max(8, Math.round(((a1 - a0) * r) / (blockPx * 0.85)));
    for (let i = 0; i < steps; i++) {
        const a = a0 + (a1 - a0) * (i / steps);
        pxRect(g, cx + Math.cos(a) * r - blockPx / 2, cy + Math.sin(a) * r - blockPx / 2,
            blockPx, blockPx, cell);
    }
}

export class BossAnimator {
    /**
     * @param {number} k index into BOSSES (same order as BOSS_ANIM_KINDS)
     * @param {string} tint the boss colour from the catalogue
     */
    constructor(k, tint) {
        this.k = k;
        this.kind = BOSS_ANIM_KINDS[k] || BOSS_ANIM_KINDS[0];
        this.t = BOSS_ANIM[this.kind];
        this.g0 = BOSS_ANIM.global;
        this.tint = tint;
        this.effects = [];
        this.time = 0;
        this.x = null;
        this.y = null;
        this.vx = 0;
        this.vy = 0;
        this.lean = 0;
        this.breath = 0;
        this.shield01 = 0;
        this.charge01 = 0;
        this.bay01 = 0;
        this.bayHold = 0;
        this.stretch = 1;
        this.spin = 0;
        this.facet = 0;
        this.blink = 1;
        this.recoil = 0;
        this.shake = 0;
        this.lastAim = Math.PI / 2;
        this._trailT = 0;
    }

    /**
     * Advance the cosmetics from state the engine already owns.
     *
     * @param {number} dt seconds
     * @param {Object} s read-only view of the boss: x, y, hp01, armor, charging
     */
    observe(dt, s) {
        if (!(dt > 0)) {
            return this;
        }
        if (dt > 0.1) {
            dt = 0.1;
        }
        const t = this.t;
        const g = this.g0;
        this.time += dt;
        this.recoil = Math.max(0, this.recoil - dt / (t.recoilTime || 0.18));

        // --- observed motion: the engine moves bosses by writing x/y, so there
        // --- is no velocity to read. Deriving it works the same on a guest.
        let jumped = false;
        if (this.x === null) {
            this.x = s.x;
            this.y = s.y;
        } else {
            const dx = s.x - this.x;
            const dy = s.y - this.y;
            this.x = s.x;
            this.y = s.y;
            if (Math.abs(dx) > g.teleportPx || Math.abs(dy) > g.teleportPx) {
                jumped = true;
                this.vx = 0;
                this.vy = 0;
            } else {
                this.vx = dx / dt;
                this.vy = dy / dt;
            }
        }

        const hp01 = clamp01(s.hp01 == null ? 1 : s.hp01);
        const dmg = hp01 >= g.lowHpThreshold ? 0 : 1 - hp01 / g.lowHpThreshold;
        this.shake = dmg * g.lowHpShake;

        switch (this.kind) {
            case "DREADNOUGHT":
                this.lean = ease(this.lean,
                    clamp(this.vx / t.swayRefSpeed, -1, 1) * t.maxLean, g.smoothing, dt);
                this.breath = Math.sin(this.time * 6.2832 * t.breathHz);
                break;
            case "WARDEN":
                this.shield01 = ease(this.shield01, s.armor ? 1 : 0, 3 / t.armourTime, dt);
                this.spin = (this.spin + t.curtainSpin * dt) % 6.2832;
                this.breath = Math.sin(this.time * 6.2832 * t.breathHz);
                break;
            case "LANCER": {
                // `charging` is read off the beam the engine already owns, so it
                // is true on a guest too: beams travel in the snapshot.
                this.charge01 = ease(this.charge01, s.charging ? 1 : 0, 3 / t.chargeTime, dt);
                this.lean = ease(this.lean,
                    clamp(this.vx / t.tiltRefSpeed, -1, 1) * t.maxTilt, g.smoothing, dt);
                const diving = this.vy > t.diveEnter;
                this.stretch = ease(this.stretch,
                    1 + clamp01(Math.abs(this.vy) / t.diveRefSpeed) * (t.diveStretchMax - 1),
                    14, dt);
                if (diving) {
                    this._trailT += dt;
                    while (this._trailT >= t.afterimageEvery) {
                        this._trailT -= t.afterimageEvery;
                        let n = 0;
                        for (const e of this.effects) {
                            if (e.type === "trail") {
                                n++;
                            }
                        }
                        if (n < t.afterimageMax) {
                            this._push({
                                type: "trail", x: s.x, y: s.y, sy: this.stretch,
                                life: t.afterimageLife, max: t.afterimageLife,
                            });
                        }
                    }
                } else {
                    this._trailT = 0;
                }
                break;
            }
            case "HIVE":
                // The doors are held open by the launch cue, then close again.
                this.bayHold = Math.max(0, this.bayHold - dt);
                this.bay01 = ease(this.bay01, this.bayHold > 0 ? 1 : 0, 3 / t.bayTime, dt);
                this.lean = ease(this.lean,
                    clamp(this.vx / t.hullRollRef, -1, 1) * t.maxRoll, g.smoothing, dt);
                this.breath = Math.sin(this.time * 6.2832 * t.bobHz);
                break;
            case "PRISM":
                this.spin = (this.spin + t.spiralSpin * dt) % 6.2832;
                this.facet = (this.facet - t.facetSpin * dt) % 6.2832;
                // The engine teleports in a single frame, so the collapse cannot
                // play before the jump: the jump *is* the cue, and what plays is
                // the materialisation at the new position.
                if (jumped) {
                    // Hold the pinch fully closed for this frame. Easing away
                    // from 0 in the same call never lets the hull get below ~0.38
                    // scale, and the collapse is the whole point of a blink.
                    this.blink = 0;
                } else {
                    this.blink = ease(this.blink, 1, 3 / t.blinkInTime, dt);
                }
                break;
        }

        for (let i = this.effects.length - 1; i >= 0; i--) {
            const e = this.effects[i];
            e.life -= dt;
            if (e.speed) {
                e.r += e.speed * dt;
            }
            if (e.life <= 0) {
                this.effects.splice(i, 1);
            }
        }
        return this;
    }

    _push(e) {
        if (this.effects.length >= this.g0.maxEffects) {
            this.effects.shift();
        }
        this.effects.push(e);
    }

    /**
     * A cosmetic cue for something the engine just did. On the host these are
     * called from the boss AI; they reach a guest through the existing `ev`
     * event channel, which is what that channel is for. Deriving them from the
     * AI's own arithmetic instead (`floor(e.t) % 85 === 0`) would desync the
     * animation the first time anyone retunes a boss.
     *
     * @param {string} name burst | salvo | launch | blink
     * @param {Object} [d] payload: {a} aim angle, {x, y} departure point
     */
    emit(name, d) {
        const t = this.t;
        const o = d || {};
        if (name === "burst" && this.kind === "DREADNOUGHT") {
            this._push({
                type: "ring", r: this.halfW || 40, life: t.burstRingLife,
                max: t.burstRingLife, speed: t.burstRingSpeed, w: t.burstRingWidth,
            });
        } else if (name === "salvo") {
            const a = typeof o.a === "number" ? o.a : this.lastAim;
            this.lastAim = a;
            this.recoil = 1;
            const life = t.fanFlashLife || t.salvoFlashLife;
            this._push({ type: "muzzle", a, life, max: life });
        } else if (name === "launch" && this.kind === "HIVE") {
            // `c` is the bay offset as a fraction of the half-width, straight
            // from the AI (`off / e.r`), so the flare lands on the door that
            // actually opened instead of a fixed slot.
            this.bayHold = t.bayOpenHold;
            this._push({
                type: "bay", c: clamp(o.c == null ? 0 : o.c, -1, 1),
                life: t.bayFlareLife, max: t.bayFlareLife,
            });
        } else if (name === "blink" && this.kind === "PRISM") {
            this._push({
                type: "shock", x: o.x, y: o.y, r: t.shockStartR,
                life: t.shockLife, max: t.shockLife, speed: t.shockSpeed, w: t.shockWidth,
            });
        }
    }

    /** Cosmetic offsets around the engine-owned position. */
    pose() {
        const t = this.t;
        const sh = this.shake
            ? Math.sin(this.time * 6.2832 * this.g0.lowHpShakeHz) * this.shake
            : 0;
        let ox = sh;
        let oy = sh * 0.6;
        let sx = 1;
        let sy = 1;
        if (this.kind === "DREADNOUGHT" || this.kind === "WARDEN") {
            const b = 1 + this.breath * t.breathAmp;
            sx = b;
            sy = b;
            ox -= this.recoil * t.recoilPx * Math.cos(this.lastAim);
            oy -= this.recoil * t.recoilPx * Math.sin(this.lastAim);
        } else if (this.kind === "LANCER") {
            sy = this.stretch;
            sx = 1 / this.stretch;
        } else if (this.kind === "HIVE") {
            oy += this.breath * t.bobAmp;
        } else if (this.kind === "PRISM") {
            const b = t.blinkScaleMin + (1 - t.blinkScaleMin) * this.blink;
            sx = b;
            sy = b;
        }
        const alpha = this.kind === "PRISM" ? 0.15 + 0.85 * this.blink : 1;
        return { ox, oy, rot: this.lean, sx, sy, alpha };
    }

    /**
     * Draw the boss. The caller has NOT translated: everything here works in
     * arena coordinates, because half the effects sit at their own positions.
     *
     * @param {CanvasRenderingContext2D} g
     * @param {Object} o
     * @param {string} o.sprite hull name in the sprite bank
     * @param {number} o.px logical pixel size the engine draws the hull at
     * @param {number} o.x engine-owned centre — authoritative, so a cue that
     *   created this animator before the first `observe` still draws correctly
     * @param {number} o.y
     * @param {boolean} o.flash the engine's own hit flash
     */
    draw(g, o) {
        const size = spriteSize(o.sprite);
        if (!size.w) {
            return;
        }
        this.x = o.x;
        this.y = o.y;
        const cell = Math.max(1, Math.round(o.px));
        const w = size.w * o.px;
        const h = size.h * o.px;
        this.halfW = w / 2;
        const p = this.pose();

        g.save();
        g.imageSmoothingEnabled = false;
        this._behind(g, o, cell, w, h);

        if (p.alpha > 0.01) {
            g.save();
            g.globalAlpha = p.alpha;
            g.translate(this.x + p.ox, this.y + p.oy);
            g.rotate(p.rot);
            g.scale(p.sx, p.sy);
            if (this.kind === "WARDEN") {
                this._plates(g, cell, w, -1);
                this._plates(g, cell, w, 1);
            }
            drawSprite(g, o.sprite, 0, 0, { tint: this.tint, px: o.px, flash: o.flash });
            this._core(g, cell);
            g.restore();
        }

        this._front(g, o, cell, w, h);
        g.restore();
    }

    /* ---------------- effects under the hull ---------------- */

    _behind(g, o, cell, w, h) {
        const t = this.t;
        // LANCER dive afterimages.
        for (const e of this.effects) {
            if (e.type !== "trail") {
                continue;
            }
            const k = e.life / e.max;
            g.save();
            g.globalAlpha = t.afterimageAlpha * k * k;
            g.translate(e.x, e.y);
            g.scale(1 / e.sy, e.sy);
            drawSprite(g, o.sprite, 0, 0, { tint: this.tint, px: o.px });
            g.restore();
        }
        if (this.kind === "PRISM") {
            this._spiral(g, cell, w);
        }
        if (this.kind === "WARDEN") {
            this._curtain(g, cell, w);
        }
    }

    /* ---------------- effects over the hull ---------------- */

    _front(g, o, cell, w, h) {
        const t = this.t;
        for (const e of this.effects) {
            const k = clamp01(e.life / e.max);
            g.save();
            g.globalCompositeOperation = "lighter";
            g.fillStyle = this.tint;
            if (e.type === "ring") {
                g.globalAlpha = k * 0.9;
                pxRing(g, this.x, this.y, e.r, e.w, cell);
            } else if (e.type === "shock") {
                g.globalAlpha = k * k * 0.85;
                pxRing(g, e.x, e.y, e.r, e.w, cell);
                g.globalAlpha = k * k * 0.35;
                pxRing(g, e.x, e.y, e.r * 0.7, Math.max(cell, e.w - cell), cell);
            } else if (e.type === "muzzle") {
                const len = (t.salvoFlashLen || 20) * (0.4 + 0.6 * k);
                g.globalAlpha = k;
                // The spread mirrors what the AI actually fires: a triple for the
                // dreadnought, a five-shot fan for the warden.
                const spread = this.kind === "WARDEN"
                    ? [-0.34, -0.17, 0, 0.17, 0.34]
                    : [-0.22, 0, 0.22];
                const r0 = w * 0.34;
                for (const off of spread) {
                    const a = e.a + off;
                    for (let d = r0; d < r0 + len; d += cell) {
                        pxRect(g, this.x + Math.cos(a) * d - cell,
                            this.y + Math.sin(a) * d - cell, cell * 2, cell * 2, cell);
                    }
                }
            } else if (e.type === "bay") {
                const bx = this.x + (w / 2) * e.c;
                const by = this.y + cell * 3;
                g.globalAlpha = k;
                for (let d = 0; d < t.bayFlareLen * k; d += cell) {
                    pxRect(g, bx - cell, by + d, cell * 2, cell * 2, cell);
                }
            }
            g.restore();
        }
        if (this.kind === "DREADNOUGHT") {
            this._thrusters(g, cell, w);
        }
        if (this.kind === "HIVE") {
            this._rimLights(g, cell, w);
        }
    }

    /* ---------------- per-boss pieces ---------------- */

    /** Core glow, drawn in the hull's own transform. */
    _core(g, cell) {
        const t = this.t;
        let glow = 0;
        if (this.kind === "DREADNOUGHT" || this.kind === "PRISM") {
            glow = 0.5 + 0.5 * Math.sin(this.time * 6.2832 * t.coreGlowHz) * t.coreGlowAmp;
        } else if (this.kind === "WARDEN") {
            // Brightest while the shield is down: that is the hurt window, and
            // the glow is what tells the player to spend it.
            const exposed = 1 - this.shield01;
            glow = exposed * (0.45 + 0.55 * Math.abs(
                Math.sin(this.time * 6.2832 * t.exposedPulseHz))) * t.exposedGlow;
        } else if (this.kind === "LANCER") {
            glow = this.charge01 * 0.8;
        } else if (this.kind === "HIVE") {
            glow = 0.25 + 0.25 * Math.sin(this.time * 6.2832 * t.hangarGlowHz);
        }
        if (glow <= 0.01) {
            return;
        }
        g.save();
        g.globalCompositeOperation = "lighter";
        g.fillStyle = this.tint;
        const r = cell * 3;
        g.globalAlpha = clamp01(glow) * 0.55;
        pxRect(g, -r, -r, r * 2, r * 2, cell);
        g.globalAlpha = clamp01(glow) * 0.3;
        pxRect(g, -r * 1.7, -r * 1.7, r * 3.4, r * 3.4, cell);
        g.restore();
    }

    /** WARDEN armour plate: hugs the hull when raised, slides out and dims. */
    _plates(g, cell, w, side) {
        const t = this.t;
        const cv = sprite("bossPlate", this.tint, cell, false);
        if (!cv) {
            return;
        }
        const out = (1 - this.shield01) * t.armourTravel;
        g.save();
        g.globalAlpha = 0.35 + 0.65 * this.shield01;
        g.drawImage(cv, side * (w * 0.3 + out) - cv.width / 2, -cv.height / 2);
        g.restore();
    }

    /** WARDEN curtain: a ring with one rotating gap — the gap is the way in. */
    _curtain(g, cell, w) {
        const t = this.t;
        if (this.shield01 < 0.02) {
            return;
        }
        const half = t.curtainGap / 2;
        const pulse = 0.6 + 0.4 * Math.sin(this.time * 6.2832 * t.curtainPulseHz);
        g.save();
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = this.shield01 * 0.75 * pulse;
        g.fillStyle = this.tint;
        pxRing(g, this.x, this.y, w * 0.72, t.curtainNodePx, cell,
            this.spin + half, this.spin - half + 6.2832);
        g.restore();
    }

    /** PRISM: three curling arms of blocks, counter-spun by `facet`. */
    _spiral(g, cell, w) {
        const t = this.t;
        if (this.blink < 0.05) {
            return;
        }
        const r0 = w * 0.4;
        g.save();
        g.globalCompositeOperation = "lighter";
        g.fillStyle = this.tint;
        for (let arm = 0; arm < t.spiralArms; arm++) {
            const base = this.spin + (arm / t.spiralArms) * 6.2832;
            for (let d = r0; d < r0 + t.spiralLength; d += t.spiralNodeStep) {
                const k = (d - r0) / t.spiralLength;
                const a = base + k * t.spiralCurl;
                g.globalAlpha = this.blink * (0.95 - 0.55 * k);
                const sz = t.spiralNodePx * (1 - 0.35 * k);
                pxRect(g, this.x + Math.cos(a) * d - sz / 2,
                    this.y + Math.sin(a) * d - sz / 2, sz, sz, cell);
            }
        }
        g.restore();
    }

    /** DREADNOUGHT: two rear plumes. Bosses face +Y, so they sit above it. */
    _thrusters(g, cell, w) {
        const t = this.t;
        const f = 0.55 + 0.45 * Math.sin(this.time * 6.2832 * t.thrusterHz);
        const len = t.thrusterLen * f;
        g.save();
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = 0.8;
        g.fillStyle = this.tint;
        for (const s of [-0.38, 0.38]) {
            for (let d = 0; d < len; d += cell) {
                const pw = cell * (2 - d / Math.max(len, 1));
                pxRect(g, this.x + (w / 2) * s - pw / 2, this.y - w * 0.34 - d, pw, cell, cell);
            }
        }
        g.restore();
    }

    /** HIVE: a light chasing along the rim, so the carrier reads as powered. */
    _rimLights(g, cell, w) {
        const t = this.t;
        const half = w / 2;
        const phase = (this.time % t.rimCycle) / t.rimCycle;
        g.save();
        g.globalCompositeOperation = "lighter";
        g.fillStyle = this.tint;
        const n = t.rimLights * 2;
        for (let i = 0; i < n; i++) {
            const u = i / (n - 1);
            const lx = this.x - half * 0.86 + u * half * 1.72;
            const ly = this.y + cell * 1.5 + Math.abs(u - 0.5) * cell * 3
                + this.bay01 * t.bayTravel;
            const k = (u + phase) % 1;
            g.globalAlpha = 0.25 + 0.75 * Math.pow(1 - Math.abs(k - 0.5) * 2, 3);
            pxRect(g, lx - cell / 2, ly, cell, cell, cell);
        }
        g.restore();
    }
}

/* =============================================================================
 * DERIVED SIGNAL RANGES — so thresholds can be checked without running Odoo.
 * Re-measured against this engine's AI, not the design study's canvas.
 *
 *   lean       DREADNOUGHT ±0.12 rad, saturates at 180 px/s (AI peaks at 209)
 *              LANCER      ±0.22 rad, saturates at 180 px/s (hover peaks at 132)
 *              HIVE        ±0.07 rad, saturates at  66 px/s (AI peaks at  66)
 *   breath     -1..1 sine; ±1.8% scale (DREADNOUGHT), ±1.2% (WARDEN)
 *   stretch    LANCER 1.00 hovering, 1.30 cap; the dive runs at 420 px/s
 *   shield01   0..1, 95% of a transition in ~0.34 s
 *   charge01   0..1, ~0.85 s to 95% while the engine's beam is telegraphing
 *   bay01      0..1, opens in ~0.26 s, held 0.34 s per launch
 *   blink      0..1, reset to 0 on a detected teleport, back to 1 in ~0.16 s
 *   shake      0 while hp01 >= 0.30, rising to 2.4 px at hp01 = 0
 *   recoil     0..1 over 0.18 s; peak hull offset 5 px (3 for WARDEN)
 *   effects    <= 12 in normal play; hard cap 48
 * ========================================================================== */
