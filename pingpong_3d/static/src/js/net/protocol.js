/** @odoo-module **/

/* Wire format.
 *
 * Integers only, short keys. Positions and velocities travel in millimetres,
 * spin in tenths of a radian per second: a millimetre over a 2.74 m table is far
 * below anything visible, and it roughly halves the payload. A snapshot lands
 * around 200 bytes.
 *
 * Every message carries the schema version `k`, so a client left open across a
 * deploy can recognise that it no longer understands the other side.
 */

export const SCHEMA = 1;

export const MSG = {
    PING: "png",
    SELF: "slf",
    PONG: "pog",
    HELLO: "hlo",
    START: "sta",
    STATE: "st",
    INPUT: "in",
    CLAIM: "cl",
    EVENT: "ev",
};

const PHASES = ["serve", "rally", "dead", "over"];

const F_SERVE_BALL = 1;
const F_BOUNCED_OWN = 2;
const F_BOUNCED_OPP = 4;

const mm = (v) => Math.round(v * 1000);
const unmm = (v) => v / 1000;
const spin = (v) => Math.round(v * 10);
const unspin = (v) => v / 10;

/**
 * Pack the authoritative state, plus a short trail of the host's own paddle.
 *
 * The paddle sub-samples are what let the receiver rebuild a smooth path from a
 * low message rate, and they mean a single lost message does not erase the peak
 * of a swing.
 *
 * @param {import("../engine/sim.js").PingPongSim} sim
 * @param {number} seq monotone snapshot sequence
 * @param {Array} paddleSamples entries of [tick, x, y, vx, vy]
 * @param {number} hostSide which side the host plays
 */
export function encodeSnapshot(sim, seq, paddleSamples, hostSide) {
    const b = sim.ball;
    return {
        k: SCHEMA,
        q: seq,
        t: sim.tick,
        b: [
            mm(b.pos.x), mm(b.pos.y), mm(b.pos.z),
            mm(b.vel.x), mm(b.vel.y), mm(b.vel.z),
            spin(b.spin.x), spin(b.spin.y), spin(b.spin.z),
        ],
        h: paddleSamples.map(([tick, x, y, vx, vy]) => [
            sim.tick - tick, mm(x), mm(y), mm(vx), mm(vy),
        ]),
        ph: PHASES.indexOf(sim.phase),
        sv: sim.server,
        lh: sim.lastHit,
        pi: sim.pointIndex,
        f: (sim.serveBall ? F_SERVE_BALL : 0)
            | (sim.bouncedOwn ? F_BOUNCED_OWN : 0)
            | (sim.bouncedOpp ? F_BOUNCED_OPP : 0),
        s: [sim.score[0], sim.score[1]],
        hc: [Math.round(sim.hitCool[0] * 1000), Math.round(sim.hitCool[1] * 1000)],
        stm: Math.round(sim.serveTimer * 1000),
        rt: sim.resumeAtTick ? sim.resumeAtTick - sim.tick : 0,
        et: sim.endAtTick ? sim.endAtTick - sim.tick : 0,
        hi: sim.hits,
        ra: sim.rallies,
        hs: hostSide,
    };
}

/**
 * @returns {{state: object, paddle: Array}} a state accepted by sim.setState,
 *   and the host's paddle samples as absolute ticks.
 */
export function decodeSnapshot(msg) {
    const state = {
        tick: msg.t,
        phase: PHASES[msg.ph],
        pos: [unmm(msg.b[0]), unmm(msg.b[1]), unmm(msg.b[2])],
        vel: [unmm(msg.b[3]), unmm(msg.b[4]), unmm(msg.b[5])],
        spin: [unspin(msg.b[6]), unspin(msg.b[7]), unspin(msg.b[8])],
        score: [msg.s[0], msg.s[1]],
        server: msg.sv,
        pointIndex: msg.pi,
        lastHit: msg.lh,
        serveBall: Boolean(msg.f & F_SERVE_BALL),
        bouncedOwn: Boolean(msg.f & F_BOUNCED_OWN),
        bouncedOpp: Boolean(msg.f & F_BOUNCED_OPP),
        hitCool: [msg.hc[0] / 1000, msg.hc[1] / 1000],
        serveTimer: msg.stm / 1000,
        resumeAtTick: msg.rt ? msg.t + msg.rt : 0,
        endAtTick: msg.et ? msg.t + msg.et : 0,
        hits: msg.hi,
        rallies: msg.ra,
    };
    const paddle = msg.h.map(([dt, x, y, vx, vy]) => [
        msg.t - dt, unmm(x), unmm(y), unmm(vx), unmm(vy),
    ]);
    return { state, paddle, hostSide: msg.hs };
}

/** Guest paddle batch. */
export function encodeInput(seq, tick, samples) {
    return {
        k: SCHEMA,
        i: seq,
        t: tick,
        p: samples.map(([t, x, y, vx, vy]) => [tick - t, mm(x), mm(y), mm(vx), mm(vy)]),
    };
}

export function decodeInput(msg) {
    return {
        seq: msg.i,
        samples: msg.p.map(([dt, x, y, vx, vy]) => [
            msg.t - dt, unmm(x), unmm(y), unmm(vx), unmm(vy),
        ]),
    };
}

/**
 * A guest's claim that it struck the ball.
 *
 * `o` is the shot the guest already drew. The host recomputes the stroke from
 * its own ball and the claimed paddle and ignores `o` for anything but a
 * divergence metric, which is what makes a doctored shot pointless.
 */
export function encodeClaim(id, tick, ball, paddle, paddleVel, outVel, outSpin) {
    return {
        k: SCHEMA,
        id,
        t: tick,
        b: [mm(ball.pos.x), mm(ball.pos.y), mm(ball.pos.z),
            mm(ball.vel.x), mm(ball.vel.y), mm(ball.vel.z)],
        p: [mm(paddle.x), mm(paddle.y), mm(paddleVel.x), mm(paddleVel.y)],
        o: [mm(outVel.x), mm(outVel.y), mm(outVel.z),
            spin(outSpin.x), spin(outSpin.y), spin(outSpin.z)],
    };
}

export function decodeClaim(msg) {
    return {
        id: msg.id,
        tick: msg.t,
        pos: [unmm(msg.b[0]), unmm(msg.b[1]), unmm(msg.b[2])],
        vel: [unmm(msg.b[3]), unmm(msg.b[4]), unmm(msg.b[5])],
        paddle: [unmm(msg.p[0]), unmm(msg.p[1])],
        paddleVel: [unmm(msg.p[2]), unmm(msg.p[3])],
        outVel: [unmm(msg.o[0]), unmm(msg.o[1]), unmm(msg.o[2])],
        outSpin: [unspin(msg.o[3]), unspin(msg.o[4]), unspin(msg.o[5])],
    };
}

/** Why a claim was turned down. Numeric so each peer phrases it locally. */
export const REJECT = {
    WINDOW: 1,       // outside the rewind window
    NO_HISTORY: 2,   // the host no longer holds that tick
    STALE_POINT: 3,  // belongs to a point that is already over
    COOLDOWN: 4,     // too soon after the previous accepted stroke
    DIRECTION: 5,    // the ball was not travelling towards that side
    BALL_APART: 6,   // the claimed ball is nowhere near the host's
    PADDLE_ILLEGAL: 7,   // outside the legal box
    PADDLE_JUMP: 8,  // too far from the last reported pose
    NO_CONTACT: 9,   // the paddle did not reach the ball
};
