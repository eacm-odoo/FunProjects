/** @odoo-module **/

import * as THREE from "../../../lib/three/three.module.js";

import { DIFFS, PADDLE_Z, TH, shotDir } from "./constants.js";
import { integrateStep, makeStepResult } from "./physics.js";

const PREDICT_STEP = 1 / 240;
const PREDICT_MAX = 900;
const AI_HIT_RADIUS = 0.12;

const scratch = {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    spin: new THREE.Vector3(),
};
const scratchRes = makeStepResult();

/**
 * Run a copy of the ball forward until it reaches `side`'s paddle plane.
 *
 * It integrates through the very same physics the match uses, so the machine
 * cannot be fooled by a discrepancy between a private copy and the real thing.
 *
 * @returns {{x: number, y: number, t: number, ok: boolean}|null}
 */
export function predictLanding(sim, side) {
    scratch.pos.copy(sim.ball.pos);
    scratch.vel.copy(sim.ball.vel);
    scratch.spin.copy(sim.ball.spin);

    const approach = -shotDir(side);
    const plane = PADDLE_Z[side] * approach;

    for (let i = 0; i < PREDICT_MAX; i++) {
        integrateStep(scratch, PREDICT_STEP, scratchRes);
        if (scratch.pos.z * approach >= plane) {
            return {
                x: scratch.pos.x,
                y: scratch.pos.y,
                t: i * PREDICT_STEP,
                ok: scratch.pos.y > TH - 0.05,
            };
        }
        if (scratch.pos.y < TH - 0.4) {
            return null;
        }
    }
    return null;
}

/** The machine. Reads the ball, moves its paddle, swings when it can reach. */
export class AiController {
    constructor(difficulty = "normal") {
        this.isAi = true;
        this.autoServes = true;
        this.difficulty = difficulty;
        this.target = new THREE.Vector3();
        this.delay = 0;
        this._ready = false;
    }

    update(sim, side, h, prevZ) {
        const diff = DIFFS[this.difficulty] || DIFFS.normal;
        const pad = sim.paddle[side];
        const approach = -shotDir(side);

        if (!this._ready) {
            this.target.set(0, TH + 0.22, PADDLE_Z[side]);
            this._ready = true;
        }

        const incoming = sim.ball.vel.z * approach > 0.2;
        if (incoming) {
            this.delay -= h;
            if (this.delay <= 0) {
                this.delay = diff.react;
                const landing = predictLanding(sim, side);
                if (landing && landing.ok) {
                    const rng = sim.rng;
                    const jx = (rng() * 2 - 1) * diff.err;
                    const jy = (rng() * 2 - 1) * diff.err * 0.5;
                    const reach = diff.reach + 0.25;
                    this.target.set(
                        Math.max(-reach, Math.min(reach, landing.x + jx)),
                        Math.max(TH + 0.10, Math.min(TH + 0.52, landing.y + jy)),
                        PADDLE_Z[side]
                    );
                }
            }
        } else {
            // Drift back towards the middle between rallies.
            this.target.set(this.target.x * 0.9, TH + 0.22, PADDLE_Z[side]);
        }

        const maxStep = diff.speed * h;
        const dx = this.target.x - pad.x;
        const dy = this.target.y - pad.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        let nx = pad.x;
        let ny = pad.y;
        if (dist > 1e-5) {
            const s = Math.min(1, maxStep / dist);
            nx += dx * s;
            ny += dy * s;
        }
        // The machine swings from position alone, so its paddle velocity stays
        // zero: hit() takes the AI branch for this side anyway.
        sim.setPaddle(side, nx, ny, 0, 0);

        sim.tryHit(side, prevZ, AI_HIT_RADIUS);
    }
}
