/** @odoo-module **/

/* Shared constants. SI units, y-up, table centred on the origin.
 *
 * Sides are numeric: 0 is the +Z end, 1 is the -Z end. That holds on every
 * machine and on the wire, so two peers can compare states directly. Only the
 * camera and the pointer mapping are mirrored, through SIDE_SIGN.
 */

export const TL = 2.74;              // table length
export const TW = 1.525;             // table width
export const TH = 0.76;              // table height
export const HX = TW / 2;
export const HZ = TL / 2;
export const NET_H = 0.1525;
export const NET_OVER = 0.1525;
export const NET_W = TW + NET_OVER * 2;

export const R = 0.02;               // ball radius
export const G = 9.81;
export const DRAG = 0.112;           // 0.5*rho*Cd*A/m
export const MAGNUS = 0.0016;        // accel = MAGNUS * (w x v)
export const E_TABLE = 0.86;         // restitution
export const SPIN_DECAY = 0.55;      // per second

/* Bounce spin transfer. The x kick is scaled by the direction of travel so the
   ball curves the same way for whoever struck it; without that, sidespin always
   bent towards the same absolute side. */
export const BOUNCE_SPIN_Z = 0.0052;
export const BOUNCE_SPIN_X = 0.0026;

export const WIN = 11;               // points to win a match

/* Global scale on the launch speed of every shot and serve. The solver raises
 * the arc to compensate, so shots stay legal at any of these values.
 *
 * Measured median time between hits, over seven simulated matches:
 *   1.00 -> 0.47 s   0.85 -> 0.56 s   0.78 -> 0.61 s   0.72 -> 0.65 s
 * Below about 0.72 rallies stop resolving: at 0.65 a match ran to 16k hits
 * because neither side could ever win a point. Keep it above that. */
export const SHOT_SPEED = 0.78;

/* Simulation. One fixed step, never derived from the frame rate: the old
   `dt / 6` made a 144 Hz client and a 60 Hz client diverge. */
export const STEP_H = 1 / 240;
export const MAX_STEPS_PER_FRAME = 30;

/* Paddle planes and reach. */
export const PADDLE_Z = [HZ - 0.10, -HZ + 0.10];
export const PADDLE_X_LIMIT = 0.80;
export const PADDLE_Y_MIN = TH + 0.05;
export const PADDLE_Y_MAX = TH + 0.55;
export const HIT_RADIUS = 0.115;
export const HIT_COOL = 0.14;

/* Point flow, in seconds; converted to ticks by the simulation so both peers
   resume on the very same tick instead of on their own timers. */
export const RESUME_DELAY = 1.15;
export const END_DELAY = 0.9;
export const SERVE_DELAY = 1.1;

export const DIFFS = {
    facil: { name: "Fácil", speed: 1.55, react: 0.34, err: 0.20, power: 0.80, spin: 0.35, reach: 0.30 },
    normal: { name: "Normal", speed: 2.35, react: 0.22, err: 0.115, power: 0.95, spin: 0.65, reach: 0.42 },
    dificil: { name: "Difícil", speed: 3.20, react: 0.14, err: 0.062, power: 1.08, spin: 0.95, reach: 0.52 },
    experto: { name: "Experto", speed: 4.20, react: 0.08, err: 0.030, power: 1.18, spin: 1.25, reach: 0.62 },
};

/** Direction the given side hits towards: side 0 aims at -Z, side 1 at +Z. */
export function shotDir(side) {
    return side === 0 ? -1 : 1;
}

/** +1 for the side the world was authored around, -1 for the mirrored end. */
export function sideSign(side) {
    return side === 0 ? 1 : -1;
}

export function other(side) {
    return side === 0 ? 1 : 0;
}

/** Reasons a point can end, kept as codes so each peer phrases them locally. */
export const REASON = {
    NET_SERVE: 1,       // serve did not clear properly
    OWN_HALF: 2,        // the ball landed on the hitter's own half
    DOUBLE_BOUNCE: 3,   // bounced twice on the receiver's half
    MISSED: 4,          // the receiver did not reach it
    OUT: 5,             // the hitter sent it out
    LOST: 6,            // nobody had hit it yet
};
