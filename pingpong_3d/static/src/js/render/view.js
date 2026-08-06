/** @odoo-module **/

import * as THREE from "../../../lib/three/three.module.js";

import { HX, HZ, TH, sideSign } from "../engine/constants.js";
import { CAMS, TRAIL_POINTS, buildScene } from "./scene.js";

/* Everything visual, and nothing else.
 *
 * The camera and the pointer mapping are the only places that know which end
 * the local player sits at: the simulation always runs in the canonical world
 * where side 0 is +Z. Screen shake and the bounce ring live here too -- they
 * are per-viewer effects and have no business in replicated state.
 */
export class PingPongView {
    /**
     * @param {HTMLElement} container
     * @param {number} localSide which end the camera sits behind
     */
    constructor(container, localSide = 0) {
        this.parts = buildScene(container);
        this.localSide = localSide;
        this.sign = sideSign(localSide);
        this.camKey = "player";
        this.shake = 0;
        this.ringT = 0;
        this.trailPts = [];
        /* Reconciliation offset. When the host's state disagrees with what the
           guest predicted, the simulation adopts the truth at once but the ball
           on screen keeps its old position and slides across to the new one.
           A correction that teleports reads as broken physics; one that decays
           over ~120 ms is not noticed at all. */
        this.renderOffset = new THREE.Vector3();
        this.renderTau = 0.12;

        this._drawPos = new THREE.Vector3();
        this._tmpA = new THREE.Vector3();
        this._tmpB = new THREE.Vector3();
        this._axis = new THREE.Vector3();

        const cam = CAMS[this.camKey];
        this.parts.camera.position.set(this.sign * cam.pos[0], cam.pos[1], this.sign * cam.pos[2]);
        this.parts.camera.lookAt(this.sign * cam.look[0], cam.look[1], this.sign * cam.look[2]);
    }

    setCamera(key) {
        if (CAMS[key]) {
            this.camKey = key;
        }
    }

    cycleCamera() {
        const keys = Object.keys(CAMS);
        this.camKey = keys[(keys.indexOf(this.camKey) + 1) % keys.length];
        return CAMS[this.camKey].label;
    }

    /** Bounce marker, called from a simulation event. */
    bounceAt(x, z) {
        this.parts.ring.position.set(x, TH + 0.002, z);
        this.ringT = 1;
        this.shake = Math.max(this.shake, 0.12);
    }

    addShake(amount) {
        this.shake = Math.max(this.shake, amount);
    }

    /** Drop the trail, e.g. after a hard resynchronisation. */
    clearTrail() {
        this.trailPts.length = 0;
        this.renderOffset.set(0, 0, 0);
    }

    /**
     * Absorb a correction visually.
     *
     * @param {THREE.Vector3|null} offset where the ball was drawn minus where it
     *   now is; null clears any pending smoothing.
     * @param {number} [tau] decay constant in seconds
     */
    setRenderOffset(offset, tau = 0.12) {
        if (!offset) {
            this.renderOffset.set(0, 0, 0);
            return;
        }
        this.renderOffset.copy(offset).clampLength(0, 0.25);
        this.renderTau = tau;
    }

    resize(width, height) {
        if (!width || !height) {
            return;
        }
        this.parts.renderer.setSize(width, height, false);
        this.parts.camera.aspect = width / height;
        this.parts.camera.updateProjectionMatrix();
    }

    /**
     * Draw one frame.
     *
     * @param {import("../engine/sim.js").PingPongSim} sim
     * @param {number} dt seconds since the previous frame
     */
    draw(sim, dt) {
        const p = this.parts;

        if (this.renderOffset.lengthSq() > 1e-8) {
            this.renderOffset.multiplyScalar(Math.exp(-dt / this.renderTau));
            if (this.renderOffset.lengthSq() < 1e-8) {
                this.renderOffset.set(0, 0, 0);
            }
        }
        const pos = this._drawPos.copy(sim.ball.pos).add(this.renderOffset);

        p.ball.position.copy(pos);

        const spin = sim.ball.spin;
        if (spin.lengthSq() > 1e-4) {
            this._axis.copy(spin).normalize();
            p.ballMesh.rotateOnWorldAxis(this._axis, Math.min(0.6, spin.length() * dt * 0.35));
            p.seam.rotation.copy(p.ballMesh.rotation);
            p.seam2.rotation.copy(p.ballMesh.rotation);
            p.seam2.rotateY(Math.PI / 2);
        }

        const overTable = pos.y > TH && Math.abs(pos.x) <= HX && Math.abs(pos.z) <= HZ;
        p.marker.position.set(pos.x, overTable ? TH + 0.0025 : 0.003, pos.z);
        p.marker.material.opacity = 0.30 * Math.max(0.15, 1 - (pos.y - TH) * 0.9);

        for (let side = 0; side < 2; side++) {
            const group = p.paddles[side];
            const vel = sim.paddleVel[side];
            group.position.copy(sim.paddle[side]);
            const rx = -0.32 - clamp(vel.y * 0.14, -0.5, 0.5);
            const ry = clamp(-vel.x * 0.16, -0.5, 0.5);
            const rz = clamp(vel.x * 0.2, -0.6, 0.6);
            // The far paddle is the mirror image of the near one.
            if (side === 0) {
                group.rotation.set(rx, ry, rz);
            } else {
                group.rotation.set(-rx, ry, -rz);
            }
        }

        this._drawTrail(pos, sim.phase);

        if (this.ringT > 0) {
            this.ringT = Math.max(0, this.ringT - dt * 2.6);
            const s = 1 + (1 - this.ringT) * 5.5;
            p.ring.scale.set(s, s, s);
            p.ring.material.opacity = this.ringT * 0.7;
        }

        this._moveCamera(sim, dt, pos);
        p.renderer.render(p.scene, p.camera);
    }

    _drawTrail(pos, phase) {
        const p = this.parts;
        this.trailPts.unshift(pos.clone());
        if (this.trailPts.length > TRAIL_POINTS) {
            this.trailPts.length = TRAIL_POINTS;
        }
        const arr = p.trailGeo.attributes.position.array;
        for (let i = 0; i < TRAIL_POINTS; i++) {
            const pt = this.trailPts[Math.min(i, this.trailPts.length - 1)] || pos;
            arr[i * 3] = pt.x;
            arr[i * 3 + 1] = pt.y;
            arr[i * 3 + 2] = pt.z;
        }
        p.trailGeo.attributes.position.needsUpdate = true;
        p.trail.material.opacity = phase === "rally" ? 0.45 : 0.12;
    }

    _moveCamera(sim, dt, ballPos) {
        const p = this.parts;
        const cam = CAMS[this.camKey];
        const sign = this.sign;
        this.shake = Math.max(0, this.shake - dt * 2.2);

        // Authored in the near player's frame, then mirrored into the world.
        // The sway and look-ahead terms survive the mirror unchanged, because
        // the two sign flips cancel.
        const sway = this.camKey === "player" ? sim.paddle[this.localSide].x * 0.22 : 0;
        this._tmpA.set(sign * cam.pos[0] + sway, cam.pos[1], sign * cam.pos[2]);
        p.camera.position.lerp(this._tmpA, Math.min(1, dt * 4));
        p.camera.position.x += (Math.random() - 0.5) * this.shake * 0.02;
        p.camera.position.y += (Math.random() - 0.5) * this.shake * 0.02;

        const lookAhead = this.camKey === "player" ? ballPos.x * 0.18 : 0;
        this._tmpB.set(sign * cam.look[0] + lookAhead, cam.look[1], sign * cam.look[2]);
        p.camera.lookAt(this._tmpB);
    }

    dispose() {
        this.trailPts.length = 0;
        this.parts.dispose();
    }
}

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}
