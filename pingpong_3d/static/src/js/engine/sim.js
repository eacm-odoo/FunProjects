/** @odoo-module **/

import * as THREE from "../../../lib/three/three.module.js";

import {
    DIFFS,
    END_DELAY,
    HIT_COOL,
    HIT_RADIUS,
    PADDLE_Z,
    REASON,
    RESUME_DELAY,
    SERVE_DELAY,
    SHOT_SPEED,
    STEP_H,
    TH,
    WIN,
    other,
    shotDir,
    sideSign,
} from "./constants.js";
import { aimShot, integrateStep, makeStepResult } from "./physics.js";
import { hashSeed, mulberry32 } from "./rng.js";

/* Headless match simulation.
 *
 * No scene, no DOM, no Odoo. Everything the rest of the game needs comes out
 * through `onEvent`, and everything that goes in is a paddle pose or a serve
 * request. That is what lets the same class run as the local game, as the
 * authoritative host, and as the guest's local prediction.
 *
 * Phases: "serve" (ball parked, waiting), "rally" (ball live), "dead" (point
 * scored, waiting for the tick that resumes), "over".
 */
export class PingPongSim {
    /**
     * @param {object} [options]
     * @param {(event: object) => void} [options.onEvent]
     * @param {number} [options.matchPoint]
     * @param {number} [options.seed] match seed; omit for unseeded Math.random
     * @param {string} [options.difficulty] only used by an AI controller
     */
    constructor({ onEvent = () => {}, matchPoint = WIN, seed = null, difficulty = "normal" } = {}) {
        this._listener = onEvent;
        this.matchPoint = matchPoint;
        this.seed = seed;
        this.difficulty = difficulty;

        /* Only an authority awards points. A guest simulating ahead of the
           host is a prediction: it may draw a ball rolling on the floor for a
           moment, and the score arrives with the host's point event. */
        this.authoritative = true;
        /* Event types muted while replaying a rewind, so the cosmetic one-shots
           of re-simulated ticks are not announced twice. Points are never muted:
           a rewind can legitimately produce one. */
        this.mutedEvents = null;
        /* Ticks to hold a verdict that a late claim could still overturn. The
           host sets this from the measured round trip; a local match uses 0. */
        this.pointDelayTicks = 0;
        this.pendingPoint = null;
        // Every side has a controller; a human one only runs the contact test.
        this.controllers = [new HumanController(), new HumanController()];

        this.ball = {
            pos: new THREE.Vector3(),
            vel: new THREE.Vector3(),
            spin: new THREE.Vector3(),
        };
        this.paddle = [
            new THREE.Vector3(0, TH + 0.20, PADDLE_Z[0]),
            new THREE.Vector3(0, TH + 0.22, PADDLE_Z[1]),
        ];
        this.paddleVel = [new THREE.Vector3(), new THREE.Vector3()];

        this._res = makeStepResult();
        this._from = new THREE.Vector3();
        this._to = new THREE.Vector3();

        this.reset({ server: 0 });
    }

    onEvent(event) {
        if (this.mutedEvents && this.mutedEvents.has(event.type)) {
            return;
        }
        this._listener(event);
    }

    /** Start a fresh match. */
    reset({ server = 0, seed = this.seed } = {}) {
        this.seed = seed;
        this.tick = 0;
        this.score = [0, 0];
        this.server = server;
        this.pointIndex = 0;
        this.hits = 0;
        this.rallies = 0;
        this.phase = "serve";
        this.resumeAtTick = 0;
        this.endAtTick = 0;
        this.resetPoint();
    }

    /** Re-arm for the next point without touching the score. */
    resetPoint() {
        this.phase = "serve";
        this.lastHit = -1;
        this.serveBall = false;
        this.bouncedOwn = false;
        this.bouncedOpp = false;
        this.hitCool = [0, 0];
        this.pendingPoint = null;
        this.serveTimer = SERVE_DELAY;
        this.ball.vel.set(0, 0, 0);
        this.ball.spin.set(0, 0, 0);
        this._parkServeBall();
        this.rng = this.seed === null
            ? Math.random
            : mulberry32(hashSeed(this.seed, this.pointIndex));
    }

    _parkServeBall() {
        // Slightly in front of the server's paddle, towards the table.
        const z = PADDLE_Z[this.server] + shotDir(this.server) * 0.12;
        this.ball.pos.set(this.paddle[this.server].x * 0.6, TH + 0.30, z);
    }

    // ---------------------------------------------------------------- input

    /**
     * Place a paddle. Velocity is supplied rather than derived: it carries the
     * smoothing the caller applied, which a resampled position cannot rebuild.
     */
    setPaddle(side, x, y, vx, vy) {
        this.paddle[side].set(x, y, PADDLE_Z[side]);
        this.paddleVel[side].set(vx, vy, 0);
    }

    /** True when the given side may serve right now. */
    canServe(side) {
        return this.phase === "serve" && this.server === side;
    }

    // ------------------------------------------------------------ stepping

    /** Advance exactly one fixed step. The tick always moves, the ball may not. */
    step() {
        this.tick++;

        if (this.phase === "over") {
            return;
        }

        if (this.phase === "dead") {
            if (this.endAtTick && this.tick >= this.endAtTick) {
                this._endMatch();
            } else if (this.resumeAtTick && this.tick >= this.resumeAtTick) {
                this.pointIndex++;
                this.resetPoint();
            }
            return;
        }

        if (this.phase === "serve") {
            this._parkServeBall();
            this.serveTimer -= STEP_H;
            const controller = this.controllers[this.server];
            if (controller && controller.autoServes && this.serveTimer <= 0) {
                this.serve(this.server);
            }
            return;
        }

        if (this.pendingPoint && this.tick >= this.pendingPoint.atTick) {
            const { winner, reason } = this.pendingPoint;
            this._commitPoint(winner, reason);
            return;
        }

        const prevZ = this.ball.pos.z;
        this.hitCool[0] = Math.max(0, this.hitCool[0] - STEP_H);
        this.hitCool[1] = Math.max(0, this.hitCool[1] - STEP_H);

        integrateStep(this.ball, STEP_H, this._res);
        this._applyStepResult(this._res);
        if (this.phase !== "rally") {
            return;
        }

        for (let side = 0; side < 2; side++) {
            const controller = this.controllers[side];
            if (controller) {
                controller.update(this, side, STEP_H, prevZ);
            }
            if (this.phase !== "rally") {
                return;
            }
        }
    }

    _applyStepResult(res) {
        if (res.bounceSide >= 0) {
            this.onEvent({ type: "bounce", side: res.bounceSide, x: res.bounceX, z: res.bounceZ });
            this._onBounce(res.bounceSide);
            if (this.phase !== "rally") {
                return;
            }
        }
        if (res.net) {
            this.onEvent({ type: "net" });
        }
        if (res.floor || res.gone) {
            this._resolveMiss();
        }
    }

    _onBounce(side) {
        if (this.lastHit < 0) {
            return;
        }
        const own = this.lastHit === side;
        if (this.serveBall) {
            if (own && !this.bouncedOwn) {
                this.bouncedOwn = true;         // legal first bounce of a serve
                return;
            }
            if (!own) {
                this.serveBall = false;
                this.bouncedOpp = true;
                return;
            }
            this._point(other(this.lastHit), REASON.NET_SERVE);
            return;
        }
        if (own) {
            this._point(other(this.lastHit), REASON.OWN_HALF);
            return;
        }
        if (this.bouncedOpp) {
            this._point(this.lastHit, REASON.DOUBLE_BOUNCE);
            return;
        }
        this.bouncedOpp = true;
    }

    _resolveMiss() {
        if (this.phase !== "rally") {
            return;
        }
        if (this.lastHit < 0) {
            this._point(other(this.server), REASON.LOST);
            return;
        }
        if (this.bouncedOpp) {
            this._point(this.lastHit, REASON.MISSED);
        } else {
            this._point(other(this.lastHit), REASON.OUT);
        }
    }

    // -------------------------------------------------------------- serving

    /**
     * Put the ball in play.
     *
     * @param {number} side
     * @param {object} [forced] replicated serve: {vel: [3], spin: [3]}
     */
    serve(side, forced = null) {
        if (this.phase !== "serve" || this.server !== side) {
            return false;
        }
        this.phase = "rally";
        this.serveBall = true;
        this.lastHit = side;
        this.bouncedOwn = false;
        this.bouncedOpp = false;

        if (forced) {
            this.ball.vel.fromArray(forced.vel);
            this.ball.spin.fromArray(forced.spin);
        } else {
            /* A serve derives its own generator from (match seed, point index)
               rather than the running one. Two peers then produce byte-identical
               serves without exchanging any parameter, and a rewind that replays
               the serve produces the same one again -- the running generator is
               not part of the saved state, so reusing it here would desync. */
            const rng = this.seed === null
                ? Math.random
                : mulberry32(hashSeed(this.seed, this.pointIndex + 1));
            const dir = shotDir(side);
            const isAi = Boolean(this.controllers[side] && this.controllers[side].isAi);
            const diff = DIFFS[this.difficulty] || DIFFS.normal;
            const tx = (rng() * 2 - 1) * 0.42;
            const tz = dir * (0.75 + rng() * 0.45);
            const speed = (5.6 + rng() * 0.9 + (isAi ? diff.power * 0.8 : 0)) * SHOT_SPEED;
            const spinX = dir * (30 + rng() * 70) * (isAi ? diff.spin : 0.6);
            this._from.copy(this.ball.pos);
            this._to.set(tx, TH, tz);
            aimShot(this._from, this._to, speed, 0.30, this.ball.vel);
            this.ball.spin.set(spinX, (rng() * 2 - 1) * 60, 0);
        }

        this.rallies++;
        this.onEvent({
            type: "serve",
            side,
            tick: this.tick,
            speed: this.ball.vel.length(),
            topspin: this.ball.spin.x * shotDir(side),
            vel: this.ball.vel.toArray(),
            spin: this.ball.spin.toArray(),
        });
        return true;
    }

    // --------------------------------------------------------------- hitting

    /** Contact test for one side, called once per step by its controller. */
    tryHit(side, prevZ, radius = HIT_RADIUS) {
        if (this.phase !== "rally" || this.hitCool[side] > 0) {
            return false;
        }
        // The ball approaches a side against that side's own shot direction.
        const approach = -shotDir(side);
        if (this.ball.vel.z * approach <= 0) {
            return false;
        }
        const pz = PADDLE_Z[side] * approach;
        if (!(prevZ * approach <= pz && this.ball.pos.z * approach >= pz - 0.02)) {
            return false;
        }
        const dx = this.ball.pos.x - this.paddle[side].x;
        const dy = this.ball.pos.y - this.paddle[side].y;
        if (dx * dx + dy * dy > radius * radius) {
            return false;
        }
        this.hit(side);
        return true;
    }

    /**
     * Apply a stroke. A human stroke is fully determined by the ball, the
     * paddle and the paddle velocity, which is what lets the host recompute a
     * guest's claimed shot and land on the same numbers the guest already drew.
     */
    hit(side) {
        const controller = this.controllers[side];
        const isAi = Boolean(controller && controller.isAi);
        const pad = this.paddle[side];
        const pv = this.paddleVel[side];
        const dir = shotDir(side);
        const sign = sideSign(side);
        const diff = DIFFS[this.difficulty] || DIFFS.normal;

        // Captured before the stroke rewrites them: a guest's claim has to
        // describe the ball it actually saw, not the one it produced.
        const prePos = this.ball.pos.toArray();
        const preVel = this.ball.vel.toArray();

        this.hits++;
        this.lastHit = side;
        this.serveBall = false;
        this.bouncedOwn = false;
        this.bouncedOpp = false;
        this.hitCool[side] = HIT_COOL;

        let speed;
        let topspin;
        let sidespin;
        let tx;
        let tz;
        let lift;
        if (isAi) {
            const rng = this.rng;
            speed = (6.0 + rng() * 1.3) * diff.power * SHOT_SPEED;
            topspin = Math.min(320, (50 + rng() * 180) * diff.spin);
            sidespin = (rng() * 2 - 1) * 150 * diff.spin;
            tx = (rng() * 2 - 1) * (0.30 + 0.34 * diff.spin);
            tz = dir * (0.55 + rng() * 0.7);
            lift = 0.20 + (topspin / 320) * 0.16 + Math.max(0, (TH + 0.16 - this.ball.pos.y) * 0.5);
        } else {
            const swing = Math.min(3.2, pv.length());
            speed = (5.8 + swing * 0.95 + Math.max(0, this.ball.vel.z * dir) * 0.10) * SHOT_SPEED;
            topspin = clamp(pv.y * 105 - (pad.y - (TH + 0.20)) * 80, -320, 320);
            // Sidespin follows what the player *sees*: their pointer is
            // mirrored on the far end, so the world velocity is too.
            sidespin = clamp(-sign * pv.x * 80, -200, 200);
            const off = this.ball.pos.x - pad.x;
            tx = clamp(pad.x * 1.1 - off * 1.6, -0.58, 0.58);
            tz = dir * (0.50 + Math.min(0.68, swing * 0.22));
            lift = 0.19 + (topspin / 320) * 0.15;
        }

        this._from.copy(this.ball.pos);
        this._to.set(tx, TH + 0.02, tz);
        aimShot(this._from, this._to, speed, lift, this.ball.vel);
        // Magnus is a = k*(w x v); with v along z, topspin needs w.x to share
        // the sign of v.z.
        this.ball.spin.set(dir * topspin, sidespin, 0);
        this.ball.pos.z += dir * 0.03;

        this.onEvent({
            type: "hit",
            side,
            tick: this.tick,
            speed: this.ball.vel.length(),
            topspin,
            prePos,
            preVel,
            paddle: [pad.x, pad.y],
            paddleVel: [pv.x, pv.y],
            outPos: this.ball.pos.toArray(),
            outVel: this.ball.vel.toArray(),
            outSpin: this.ball.spin.toArray(),
        });
        return true;
    }

    // --------------------------------------------------------------- scoring

    /**
     * A rally has ended.
     *
     * MISSED and OUT are the two verdicts a guest's claim can overturn: both
     * mean "nobody returned it", and a claim in flight says otherwise. The host
     * therefore holds them until the rewind window has closed. The ball keeps
     * rolling meanwhile, which nobody notices because the next serve is a
     * second away regardless.
     */
    _point(winner, reason) {
        if (this.phase !== "rally" || !this.authoritative || this.pendingPoint) {
            return;
        }
        const overturnable = reason === REASON.MISSED || reason === REASON.OUT;
        if (overturnable && this.pointDelayTicks > 0) {
            this.pendingPoint = { winner, reason, atTick: this.tick + this.pointDelayTicks };
            return;
        }
        this._commitPoint(winner, reason);
    }

    _commitPoint(winner, reason) {
        this.pendingPoint = null;
        this.score[winner]++;
        const total = this.score[0] + this.score[1];
        this.server = total % 2 === 0 ? 0 : 1;
        this.phase = "dead";

        const over = this.score[0] >= this.matchPoint || this.score[1] >= this.matchPoint;
        // Scheduled by tick, not by setTimeout: two peers must resume on the
        // very same step, and a timer cannot be paused or cancelled in sync.
        this.endAtTick = over ? this.tick + Math.round(END_DELAY / STEP_H) : 0;
        this.resumeAtTick = over ? 0 : this.tick + Math.round(RESUME_DELAY / STEP_H);

        this.onEvent({
            type: "point",
            winner,
            reason,
            score: [this.score[0], this.score[1]],
            server: this.server,
            resumeAtTick: this.resumeAtTick,
            endAtTick: this.endAtTick,
        });
    }

    _endMatch() {
        this.phase = "over";
        this.onEvent({
            type: "end",
            score: [this.score[0], this.score[1]],
            hits: this.hits,
            rallies: this.rallies,
        });
    }

    // ----------------------------------------------------------- state I/O

    /**
     * Snapshot for the rewind ring buffer. Plain data, no vectors shared.
     *
     * The paddles belong in here: replaying a rewind has to re-run the contact
     * tests, and those read the paddle pose of the tick being replayed, not the
     * one the paddle happens to hold now.
     */
    getState() {
        return {
            tick: this.tick,
            phase: this.phase,
            pos: this.ball.pos.toArray(),
            vel: this.ball.vel.toArray(),
            spin: this.ball.spin.toArray(),
            paddle: [this.paddle[0].toArray(), this.paddle[1].toArray()],
            paddleVel: [this.paddleVel[0].toArray(), this.paddleVel[1].toArray()],
            score: [this.score[0], this.score[1]],
            server: this.server,
            pointIndex: this.pointIndex,
            lastHit: this.lastHit,
            serveBall: this.serveBall,
            bouncedOwn: this.bouncedOwn,
            bouncedOpp: this.bouncedOpp,
            hitCool: [this.hitCool[0], this.hitCool[1]],
            serveTimer: this.serveTimer,
            resumeAtTick: this.resumeAtTick,
            endAtTick: this.endAtTick,
            pendingPoint: this.pendingPoint && { ...this.pendingPoint },
            hits: this.hits,
            rallies: this.rallies,
        };
    }

    setState(s, { paddles = true } = {}) {
        this.tick = s.tick;
        this.phase = s.phase;
        this.ball.pos.fromArray(s.pos);
        this.ball.vel.fromArray(s.vel);
        this.ball.spin.fromArray(s.spin);
        if (paddles && s.paddle) {
            this.paddle[0].fromArray(s.paddle[0]);
            this.paddle[1].fromArray(s.paddle[1]);
            this.paddleVel[0].fromArray(s.paddleVel[0]);
            this.paddleVel[1].fromArray(s.paddleVel[1]);
        }
        this.score[0] = s.score[0];
        this.score[1] = s.score[1];
        this.server = s.server;
        this.pointIndex = s.pointIndex;
        this.lastHit = s.lastHit;
        this.serveBall = s.serveBall;
        this.bouncedOwn = s.bouncedOwn;
        this.bouncedOpp = s.bouncedOpp;
        this.hitCool[0] = s.hitCool[0];
        this.hitCool[1] = s.hitCool[1];
        this.serveTimer = s.serveTimer;
        this.resumeAtTick = s.resumeAtTick;
        this.endAtTick = s.endAtTick;
        this.pendingPoint = s.pendingPoint ? { ...s.pendingPoint } : null;
        this.hits = s.hits;
        this.rallies = s.rallies;
    }

    /** True while the ball is parked on the server's paddle. */
    get servePending() {
        return this.phase === "serve";
    }
}

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

/**
 * A side driven from outside the simulation: a local pointer, or a peer over
 * the network. All it does per step is the contact test; the paddle pose
 * arrives through setPaddle.
 */
export class HumanController {
    constructor() {
        this.isAi = false;
        this.autoServes = false;
    }

    update(sim, side, h, prevZ) {
        sim.tryHit(side, prevZ);
    }
}

/**
 * A side whose strokes are decided elsewhere.
 *
 * The host uses this for the guest: running a contact test locally as well
 * would hit the ball twice, once on the host's guess of where the guest's
 * paddle is and once when the guest's own claim is accepted.
 */
export class RemoteController {
    constructor() {
        this.isAi = false;
        this.autoServes = false;
    }

    update() {}
}
