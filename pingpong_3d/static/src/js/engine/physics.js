/** @odoo-module **/

import * as THREE from "../../../lib/three/three.module.js";

import {
    BOUNCE_SPIN_X,
    BOUNCE_SPIN_Z,
    DRAG,
    E_TABLE,
    G,
    HX,
    HZ,
    MAGNUS,
    NET_H,
    NET_W,
    R,
    SPIN_DECAY,
    TH,
} from "./constants.js";

/* Pure ball physics: gravity, quadratic drag, Magnus, table bounce, net and
 * floor. It owns no game rules and touches no scene and no DOM -- it reports
 * what happened and the simulation decides what it means.
 *
 * The scratch vectors are private. They used to be shared with the render loop,
 * which worked by luck and would stop working the moment a guest re-simulates
 * inside a network callback.
 */
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/** Result of one step, reused between calls to keep the loop allocation-free. */
export function makeStepResult() {
    return { bounceSide: -1, bounceX: 0, bounceZ: 0, net: false, floor: false, gone: false };
}

/**
 * Launch from `from` so the ball lands near `to`.
 *
 * @param {THREE.Vector3} from
 * @param {THREE.Vector3} to
 * @param {number} speed horizontal speed
 * @param {number} lift extra rise
 * @param {THREE.Vector3} out written in place
 */
export function aimShot(from, to, speed, lift, out) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    // Math.sqrt is exact per IEEE-754; Math.hypot is not guaranteed to agree
    // across engines, and this sits on the replicated path.
    const d = Math.max(0.35, Math.sqrt(dx * dx + dz * dz));
    const t = d / speed;
    const vy = (to.y - from.y + 0.5 * G * t * t) / t + lift * 3.2;
    out.set((dx / d) * speed, vy, (dz / d) * speed);
}

/**
 * Advance the ball by one fixed step.
 *
 * @param {{pos: THREE.Vector3, vel: THREE.Vector3, spin: THREE.Vector3}} ball
 * @param {number} h step size in seconds
 * @param {object} res result object from makeStepResult, written in place
 */
export function integrateStep(ball, h, res) {
    res.bounceSide = -1;
    res.net = false;
    res.floor = false;
    res.gone = false;

    const v = ball.vel;
    const p = ball.pos;
    const speed = v.length();

    tmpA.set(0, -G, 0);
    tmpB.copy(v).multiplyScalar(-DRAG * speed);
    tmpA.add(tmpB);
    tmpB.copy(ball.spin).cross(v).multiplyScalar(MAGNUS);
    tmpA.add(tmpB);
    v.addScaledVector(tmpA, h);
    ball.spin.multiplyScalar(1 - SPIN_DECAY * h);

    const prevZ = p.z;
    const prevY = p.y;
    p.addScaledVector(v, h);

    const surf = TH + R;
    if (p.y <= surf && prevY > surf - 1e-4 && v.y < 0 && Math.abs(p.x) <= HX && Math.abs(p.z) <= HZ) {
        p.y = surf;
        v.y = -v.y * E_TABLE;
        // Spin to tangential kick. Topspin accelerates, backspin brakes; the
        // sideways kick follows the direction of travel so it mirrors properly.
        v.z += ball.spin.x * BOUNCE_SPIN_Z;
        v.x += ball.spin.y * BOUNCE_SPIN_X * Math.sign(v.z);
        ball.spin.x *= 0.55;
        ball.spin.y *= 0.72;
        res.bounceSide = p.z > 0 ? 0 : 1;
        res.bounceX = p.x;
        res.bounceZ = p.z;
    }

    if (prevZ * p.z <= 0 && Math.abs(p.x) <= NET_W / 2 + R && p.y < TH + NET_H + R * 0.6) {
        p.z = prevZ > 0 ? R * 0.9 : -R * 0.9;
        v.z *= -0.22;
        v.x *= 0.35;
        v.y *= 0.35;
        ball.spin.multiplyScalar(0.3);
        res.net = true;
    }

    if (p.y <= R + 0.001) {
        p.y = R + 0.001;
        v.y = -v.y * 0.4;
        v.x *= 0.75;
        v.z *= 0.75;
        res.floor = true;
    }

    if (Math.abs(p.z) > 4.2 || Math.abs(p.x) > 3.2) {
        res.gone = true;
    }
}
