/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - AEGIS-01 "Bulwark" motion profile (SIMULATION side).
 *
 * Ported from the "AEGIS-01 Study" design study (`aegis_motion.js`). This is
 * the one piece of a design study that is allowed to write a position: it runs
 * on the host, inside `_updateColossus`, and the result travels in the snapshot
 * like any other AI. The render side never calls it.
 *
 * What it replaces: AEGIS used to slide at a constant 30 px/s and flip its
 * direction instantly at the ends of a 210 px lane. A slab 850 px wide has to
 * decide to move. This gives it acceleration-limited travel with a real ease
 * out of and into every reversal, a capped pull toward the live ships, a brace
 * that plants the hull during the curtain telegraph, one deliberate shove
 * during the enrage beat, and a slow sag as the hull is chewed down.
 *
 * Deterministic, tick-driven, allocation-light: no `Math.random`, no rAF, no
 * timers, no window access. Time only enters through `dt`, so pause freezes it
 * and slow-mo (and the EMP `stun`, which drives `mv` to 0) slows it.
 *
 * Frame of reference (measured against the real arena, not the study canvas):
 *   field X   -115.6 .. 795.6   (911 wide, centre 340)   -- `fx0`/`fx1`, negative on the left
 *   field Y    -55.1 .. 595.1
 *   hull       850 x 258.7, hitbox 714 x 166
 *   lateral budget  +/-140 px from the field centre (the hull overhangs the
 *                   field edge by design; the camera pulls back to frame it)
 *   Y band     130 .. 205, because the curtain spawns at y + 82.8 and falls at
 *              144 px/s: every px of descent is reaction time taken away
 *
 * Signal ranges it produces at these numbers (dt = 1/60):
 *   |v|          0..36 px/s calm, 0..54 raged, up to 120 on the enrage shove
 *   step         <= 0.90 px calm, <= 2.00 px on the shove (`maxStepPx` = 10 is
 *                a guard for the animator, never a working limit)
 *   bias offset  -46..+46 px, slewed at <= 9 px/s, so it never reads as a chase
 *   brace ramp   0..1 in ~0.28 s, always full inside the 0.75 s telegraph
 *   y            150 (full hull) .. 180 (dead) minus a 5 px brace lift
 */

export const AEGIS_MOTION = {
    // Teleport guard: the animator drops its velocity on a bigger step.
    maxStepPx: 10,

    bounds: {
        lateralBudgetPx: 140,   // how far the hull centre may sit from field centre X
        yMin: 130,
        yMax: 205,
    },

    lane: {
        halfPx: 118,            // patrol half-width before the enrage
        halfPxRaged: 84,        // shorter and faster after it
    },

    speed: {
        cruise: 36,             // px/s
        cruiseRaged: 54,
        accel: 30,              // px/s^2, how fast it leans into a direction
        accelRaged: 46,
        brake: 26,              // px/s^2, weaker than accel on purpose: it
        brakeRaged: 40,         //   overshoots the end of the lane and settles
        reverseSpeedPx: 7,      // |v| under this at the lane end flips direction
        reverseSlackPx: 4,      // ...with this much positional slack
    },

    brace: {
        rampIn: 3.6,            // 1/s, reaches ~1 in 0.28 s of the 0.75 s tell
        rampOut: 2.2,
        decel: 90,              // px/s^2 used to kill lateral speed while bracing
        liftPx: -5,             // squares up by lifting: buys reaction time back
        creepPx: 2.5,           // px/s left over, so it never looks frozen
    },

    bias: {
        maxPx: 46,              // hard cap on the pull toward the ships
        ratePx: 9,              // px/s of slew on it -- this is what keeps it a wall
        deadPx: 12,             // ignore a centroid closer than this to centre
    },

    rage: {
        repoMaxPx: 90,          // one deliberate reposition, bounded
        repoSpeed: 120,
        repoAccel: 70,
        repoArrivePx: 6,
    },

    descend: {
        // Mirrors `COLOSSI[0].y`, the entrance target: the profile takes over
        // where the entrance stops, so the hull does not drift on arrival.
        restY: 150,
        sagPx: 30,              // extra descent at 0% hull
        ratePx: 6,              // px/s -- a crawl, for the reason in the header
    },
};

function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
}

/** Move `v` toward `target` by at most `maxDelta`. */
function approach(v, target, maxDelta) {
    const d = target - v;
    return v + (d > maxDelta ? maxDelta : d < -maxDelta ? -maxDelta : d);
}

export class AegisMotion {
    constructor(x, y) {
        this.reset(x == null ? 340 : x, y == null ? AEGIS_MOTION.descend.restY : y);
    }

    reset(x, y) {
        this.x = x;
        this.y = y;
        this.v = 0;             // lateral velocity, px/s
        this.dir = 1;           // patrol direction
        this.bias = 0;          // slewed pull toward the ships' centre of mass
        this.brace = 0;         // 0..1 curtain brace weight
        this.repoTarget = null;
        this.repoDone = false;
    }

    /**
     * One simulated tick.
     *
     * @param {number} dt seconds (the engine passes `mv / 60`)
     * @param {Object} s read-only host view: x, y, fx0, fx1, hp01, raged,
     *   holding, telK and the live ships (`[{x}]`, downed ones left out)
     * @returns {{x: number, y: number}} the new hull centre, already clamped
     */
    step(dt, s) {
        const T = AEGIS_MOTION;
        if (!(dt > 0)) {
            return { x: this.x, y: this.y };
        }
        if (dt > 0.1) {
            // A long hitch must not launch the slab across the field.
            dt = 0.1;
        }
        const fieldCx = (s.fx0 + s.fx1) * 0.5;
        const x0 = this.x;
        const y0 = this.y;

        // --- intent: a slewed, capped pull toward the live ships -------------
        let centroid = fieldCx;
        if (s.ships && s.ships.length) {
            let sum = 0;
            for (const sp of s.ships) {
                sum += sp.x;
            }
            centroid = sum / s.ships.length;
        }
        let want = centroid - fieldCx;
        if (want > -T.bias.deadPx && want < T.bias.deadPx) {
            want = 0;
        }
        want = clamp(want, -T.bias.maxPx, T.bias.maxPx);
        this.bias = approach(this.bias, want, T.bias.ratePx * dt);

        // --- brace: the 0.75 s the curtain telegraph gives us ----------------
        const rate = s.telK === "curtain" ? T.brace.rampIn : -T.brace.rampOut;
        this.brace = clamp(this.brace + rate * dt, 0, 1);

        // --- one deliberate reposition during the enrage beat ----------------
        if (s.holding && !this.repoDone) {
            if (this.repoTarget === null) {
                const laneHalf = T.lane.halfPxRaged;
                this.repoTarget = clamp(
                    clamp(centroid, this.x - T.rage.repoMaxPx, this.x + T.rage.repoMaxPx),
                    fieldCx - laneHalf, fieldCx + laneHalf
                );
            }
        } else if (!s.holding && this.repoTarget !== null) {
            this.repoTarget = null;
            this.repoDone = true;
        }

        const raged = !!s.raged;
        const cruise = raged ? T.speed.cruiseRaged : T.speed.cruise;
        const accel = raged ? T.speed.accelRaged : T.speed.accel;
        const brake = raged ? T.speed.brakeRaged : T.speed.brake;
        const laneHalf = raged ? T.lane.halfPxRaged : T.lane.halfPx;
        const laneCx = fieldCx + this.bias;

        let a = 0;
        let vCap = cruise;
        if (this.repoTarget !== null) {
            // The shove is still acceleration limited, it just gets a bigger
            // envelope: this is the one moment it is allowed to look urgent.
            const rem = this.repoTarget - this.x;
            const stop = (this.v * this.v) / (2 * T.rage.repoAccel);
            vCap = T.rage.repoSpeed;
            a = Math.abs(rem) <= Math.max(stop, T.rage.repoArrivePx)
                ? -Math.sign(this.v) * T.rage.repoAccel
                : Math.sign(rem) * T.rage.repoAccel;
        } else {
            const target = laneCx + this.dir * laneHalf;
            const rem = target - this.x;
            const stop = (this.v * this.v) / (2 * brake);
            if (this.v !== 0 && Math.sign(rem) !== Math.sign(this.v)) {
                a = Math.sign(rem) * accel;             // going the wrong way
            } else if (Math.abs(rem) <= stop) {
                a = -Math.sign(this.v) * brake;         // ease into the end
            } else {
                a = Math.sign(rem) * accel;             // ease out of it
            }
            if (Math.abs(rem) <= T.speed.reverseSlackPx
                    && Math.abs(this.v) <= T.speed.reverseSpeedPx) {
                this.dir = -this.dir;
            }
            if (this.brace > 0) {
                // Plant the hull, leaving a creep so it never freezes solid.
                const planted = -Math.sign(this.v) * T.brace.decel;
                a = a * (1 - this.brace) + planted * this.brace;
                vCap = cruise * (1 - this.brace) + T.brace.creepPx * this.brace;
            }
        }

        this.v = clamp(this.v + a * dt, -vCap, vCap);
        if (Math.abs(this.v) < 0.02) {
            this.v = 0;
        }
        this.x += this.v * dt;

        // --- vertical: bounded sag with hull loss, small lift on the brace ---
        const yTarget = clamp(
            T.descend.restY
                + T.descend.sagPx * (1 - clamp(s.hp01 == null ? 1 : s.hp01, 0, 1))
                + T.brace.liftPx * this.brace,
            T.bounds.yMin, T.bounds.yMax
        );
        this.y = approach(this.y, yTarget, T.descend.ratePx * dt);

        // --- clamps ----------------------------------------------------------
        const lo = fieldCx - T.bounds.lateralBudgetPx;
        const hi = fieldCx + T.bounds.lateralBudgetPx;
        if (this.x < lo) {
            this.x = lo;
            this.v = Math.max(0, this.v);
            this.dir = 1;
        } else if (this.x > hi) {
            this.x = hi;
            this.v = Math.min(0, this.v);
            this.dir = -1;
        }
        this.y = clamp(this.y, T.bounds.yMin, T.bounds.yMax);

        // The animator reads a bigger step as a teleport and drops its pose.
        const m = T.maxStepPx;
        this.x = clamp(this.x, x0 - m, x0 + m);
        this.y = clamp(this.y, y0 - m, y0 + m);
        return { x: this.x, y: this.y };
    }
}
