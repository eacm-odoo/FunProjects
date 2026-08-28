/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - VULCAN "Forge Titan" walk profile (SIMULATION side).
 *
 * Ported from the "VULCAN Animation Sheet" design study, and the second piece
 * of a design study allowed to write a position (see `aegis_motion.js` for the
 * first and for why that is the exception rather than the rule): it runs on the
 * host, inside `_updateColossus`, and the result travels in the snapshot like
 * any other AI. The render side never calls it.
 *
 * What it replaces: `e.x += e.vx * mv * 0.55` -- a flat 24.75 px/s that flipped
 * direction on the frame it touched either end of a 210 px lane. That is the
 * exact pattern the AEGIS port was written to get rid of, and on the one
 * colossus whose catalogue entry calls it *a walking foundry* it was the least
 * defensible: the sheet's first note about VULCAN is "debe sentirse PESADO.
 * Aceleración lenta, asentamiento seco. Nada flotante."
 *
 * So: acceleration limited travel with a brake deliberately weaker than the
 * accelerator (it overshoots the end of the lane and settles into it), feet
 * that **plant** for the phases the sheet plants them for -- the overheat, the
 * vent and the volley charge, which is also what makes the vent window read as
 * the machine stopping -- a limp once the hull is under the rage threshold, and
 * the same bounded sag with hull loss AEGIS has.
 *
 * There is deliberately **no pull toward the ships**. AEGIS's catalogue entry
 * promises it leans toward whoever is still flying and its profile delivers
 * that; VULCAN's promises a machine walking its lane and shooting the arena
 * rather than the player, and the two colossi should not move the same way.
 *
 * Deterministic, tick-driven, allocation-light: no `Math.random`, no rAF, no
 * timers, no window access. Time only enters through `dt`, so pause freezes it
 * and slow-mo (and the EMP `stun`, which drives `mv` to 0) slows it.
 *
 * Frame of reference (measured against the real arena, not the study canvas):
 *   field X   -136 .. 816   (952 wide, centre 340)  -- `fx0`/`fx1`
 *   hull      800 x 323.8, hitbox 672 x 207
 *   Y band    145 .. 200, mirroring `COLOSSI[2].y`
 *
 * Signal ranges it produces at these numbers (dt = 1/60):
 *   |v|          0..25 px/s walking, 0..18 limping, 0 while planted
 *   step         <= 0.42 px, so the animator's gait never jumps a stride
 *   plant ramp   0..1 in ~0.4 s, always full inside a 35 frame charge
 *   y            160 (full hull) .. 186 (dead), plus a 4 px settle on the vent
 */

export const VULCAN_MOTION = {
    // Teleport guard: the animator drops its velocity on a bigger step.
    maxStepPx: 10,

    bounds: {
        lateralBudgetPx: 132,
        yMin: 145,
        yMax: 200,
    },

    lane: {
        halfPx: 112,
        halfPxRaged: 88,        // it covers less ground once it is limping
    },

    speed: {
        cruise: 25,             // px/s -- what the old constant slide produced
        cruiseRaged: 18,
        accel: 14,              // px/s^2: 1.8 s to reach cruise. It is a foundry.
        accelRaged: 11,
        brake: 10,              // weaker than accel on purpose: it overshoots
        brakeRaged: 8,          //   the end of the lane and settles into it
        reverseSpeedPx: 5,
        reverseSlackPx: 5,
    },

    plant: {
        rampIn: 2.6,            // 1/s, full inside the 35 frame volley charge
        rampOut: 1.8,
        decel: 60,              // px/s^2 used to kill the walk while planting
        settlePx: 4,            // it sinks onto its feet rather than stopping flat
    },

    descend: {
        // Mirrors `COLOSSI[2].y`, the entrance target: the profile takes over
        // where the entrance stops, so the hull does not drift on arrival.
        restY: 160,
        sagPx: 26,
        ratePx: 5,              // px/s -- a crawl
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

export class VulcanMotion {
    constructor(x, y) {
        this.reset(x == null ? 340 : x, y == null ? VULCAN_MOTION.descend.restY : y);
    }

    reset(x, y) {
        this.x = x;
        this.y = y;
        this.v = 0;             // lateral velocity, px/s
        this.dir = 1;
        this.plant = 0;         // 0..1 feet planted
    }

    /**
     * One simulated tick.
     *
     * @param {number} dt seconds (the engine passes `mv / 60`)
     * @param {Object} s read-only host view: x, fx0, fx1, hp01, raged and
     *      `planted` (the phases the sheet stops the walk for)
     * @returns {{x: number, y: number}} the new hull centre, already clamped
     */
    step(dt, s) {
        const T = VULCAN_MOTION;
        if (!(dt > 0)) {
            return { x: this.x, y: this.y };
        }
        if (dt > 0.1) {
            // A long hitch must not launch the hull across the field.
            dt = 0.1;
        }
        const fieldCx = (s.fx0 + s.fx1) * 0.5;
        const x0 = this.x;
        const y0 = this.y;

        const rate = s.planted ? T.plant.rampIn : -T.plant.rampOut;
        this.plant = clamp(this.plant + rate * dt, 0, 1);

        const raged = !!s.raged;
        const cruise = raged ? T.speed.cruiseRaged : T.speed.cruise;
        const accel = raged ? T.speed.accelRaged : T.speed.accel;
        const brake = raged ? T.speed.brakeRaged : T.speed.brake;
        const laneHalf = raged ? T.lane.halfPxRaged : T.lane.halfPx;

        const target = fieldCx + this.dir * laneHalf;
        const rem = target - this.x;
        const stop = (this.v * this.v) / (2 * brake);
        let a;
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
        let vCap = cruise;
        if (this.plant > 0) {
            // Plant the feet. Unlike AEGIS's brace this leaves no creep: the
            // sheet is explicit that it does not walk while it vents, and the
            // hull going still is most of what makes the window readable.
            const planted = -Math.sign(this.v) * T.plant.decel;
            a = a * (1 - this.plant) + planted * this.plant;
            vCap = cruise * (1 - this.plant);
        }

        this.v = clamp(this.v + a * dt, -vCap, vCap);
        if (Math.abs(this.v) < 0.02) {
            this.v = 0;
        }
        this.x += this.v * dt;

        // Vertical: bounded sag with hull loss, and it sinks onto its feet as
        // they plant instead of stopping bolt upright.
        const yTarget = clamp(
            T.descend.restY
                + T.descend.sagPx * (1 - clamp(s.hp01 == null ? 1 : s.hp01, 0, 1))
                + T.plant.settlePx * this.plant,
            T.bounds.yMin, T.bounds.yMax
        );
        this.y = approach(this.y, yTarget, T.descend.ratePx * dt);

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
