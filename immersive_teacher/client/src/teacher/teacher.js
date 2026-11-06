/**
 * The teacher: a character made of primitives that stands on the floor next
 * to its diagram. It breathes, blinks, keeps its eyes on whoever is watching,
 * moves its mouth with its own voice, glances (and points) at each part of
 * the diagram as it appears, and shows above its head what it is doing.
 *
 *     setState(state)        idle | listening | thinking | speaking | asleep
 *     glanceAt(worldPoint)   look and point there for a moment
 *     update(dt, { viewer, voiceLevel })   once per frame
 *
 * Units are meters, the group's origin is between its feet and it faces +Z at
 * rest, so the headset can drop the group on a floor point as is (and scale it
 * down to stand on a desk). Only the inner body turns to follow the viewer;
 * the group itself stays where it was placed.
 */

import * as THREE from "three";

import { LipSync } from "./lip_sync.js";

export const TEACHER_STATES = Object.freeze(["idle", "listening", "thinking", "speaking", "asleep"]);

/**
 * Body outline as (radius, height) points, turned around the vertical axis: a
 * flat base to stand on, a little narrower at the shoulders, a rounded top.
 */
const BODY_PROFILE = [
    [0, 0], [0.2, 0], [0.25, 0.015], [0.27, 0.06], [0.27, 0.25], [0.255, 0.55],
    [0.235, 0.8], [0.205, 0.93], [0.15, 1.03], [0.08, 1.085], [0, 1.1],
];
const BODY_HEIGHT = 1.1;
const NECK_Y = 1.06;
const SHOULDER_X = 0.215;
const SHOULDER_Y = 0.86;
const HEAD_RADIUS = 0.185;
/** Head center above the neck pivot, so a nod turns around the neck. */
const HEAD_Y = 0.2;
const EYE_HEIGHT = NECK_Y + HEAD_Y + 0.2 * HEAD_RADIUS;
const INDICATOR_Y = NECK_Y + HEAD_Y + HEAD_RADIUS + 0.13;

/** How far the head turns on its own, relative to the body (radians). */
const HEAD_YAW_LIMIT = 0.95;
const HEAD_PITCH_LIMIT = 0.45;
/** The body only turns once the viewer is further than this to a side. */
const BODY_DEAD_ZONE = 0.5;
const BODY_TURN_SECONDS = 0.9;
const HEAD_TURN_SECONDS = 0.16;
const POSE_SECONDS = 0.35;
const FADE_SECONDS = 0.12;

const BLINK = Object.freeze({ close: 0.07, hold: 0.03, open: 0.08, minGap: 2, maxGap: 6, doubleChance: 0.15 });

const COLORS = Object.freeze({
    body: 0x714B67,
    collar: 0x017E84,
    head: 0xEDE7F0,
    features: 0x2B1D29,
    listening: 0xE5484D,
    thinking: 0xF5B700,
    speaking: 0x5FD4DA,
});

/**
 * Head and face per state. Angles in radians (pitch up is positive), brows and
 * lids as offsets. Moving between states eases from one pose to the next.
 */
const POSES = Object.freeze({
    idle: { pitch: 0, yaw: 0, roll: 0, brow: 0, browAsym: 0, lids: 0 },
    listening: { pitch: 0.04, yaw: 0, roll: 0.13, brow: 0.008, browAsym: 0, lids: 0 },
    thinking: { pitch: 0.24, yaw: 0.32, roll: -0.05, brow: 0.004, browAsym: 0.01, lids: 0.18 },
    speaking: { pitch: 0, yaw: 0, roll: 0, brow: 0.003, browAsym: 0, lids: 0 },
    asleep: { pitch: -0.38, yaw: 0, roll: 0.1, brow: -0.003, browAsym: 0, lids: 1 },
});

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const tmpVector = new THREE.Vector3();

function approach(current, target, seconds, dt) {
    return current + (target - current) * (1 - Math.exp(-dt / seconds));
}

function wrapAngle(angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/** White square with a soft round alpha: the floor shadow and the speaking glow. */
function createSoftDiscTexture(size = 64) {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const dx = ((x + 0.5) / size) * 2 - 1;
            const dy = ((y + 0.5) / size) * 2 - 1;
            const edge = clamp(1 - Math.hypot(dx, dy), 0, 1);
            const i = (y * size + x) * 4;
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = Math.round(edge * edge * (3 - 2 * edge) * 255);
        }
    }
    const texture = new THREE.DataTexture(data, size, size);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
}

/** A spot on the head's surface, turned to face out of it. */
function placeOnHead(object, x, y, inset = 0) {
    const z = Math.sqrt(HEAD_RADIUS ** 2 - x * x - y * y) - inset;
    object.position.set(x, HEAD_Y + y, z);
    object.quaternion.setFromUnitVectors(Z_AXIS, tmpVector.set(x, y, z).normalize());
    object.userData.restY = object.position.y;
}

function unlit(color, options = {}) {
    return new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, ...options });
}

export class Teacher {
    /**
     * @param {object} [options]
     * @param {() => number} [options.random] for tests
     */
    constructor({ random = Math.random } = {}) {
        this.random = random;
        this.group = new THREE.Group();
        this.group.name = "teacher";
        this.state = "idle";
        this.time = 0;
        this.breathPhase = 0;
        this.bodyYaw = 0;
        this.headYaw = 0;
        this.headPitch = 0;
        this.mouthOpen = 0;
        this.pose = { ...POSES.idle };
        this.lipSync = new LipSync();
        this.blink = { wait: this.#nextBlinkGap(), t: -1 };
        this.glance = { world: new THREE.Vector3(), remaining: 0, side: 1 };
        this.pointing = 0;

        this.#build();
    }

    setState(state) {
        if (!TEACHER_STATES.includes(state)) {
            throw new Error(`Unknown teacher state: ${state}`);
        }
        this.state = state;
    }

    /** Looks at `worldPoint` (and points at it) for `seconds`, then back at the viewer. */
    glanceAt(worldPoint, seconds = 1.2) {
        this.glance.world.copy(worldPoint);
        this.glance.remaining = seconds;
        this.glance.side = 0; // picked on the next update, from where the point is
    }

    /**
     * @param {number} dt seconds since the last frame
     * @param {object} [input]
     * @param {THREE.Vector3} [input.viewer] world position of the viewer's eyes
     * @param {number} [input.voiceLevel] loudness of the teacher's voice right now
     */
    update(dt, { viewer = null, voiceLevel = 0 } = {}) {
        this.time += dt;
        const pose = POSES[this.state];
        for (const key of Object.keys(this.pose)) {
            this.pose[key] = approach(this.pose[key], pose[key], POSE_SECONDS, dt);
        }
        this.#breathe(dt);
        this.mouthOpen = this.lipSync.update(this.state === "speaking" ? voiceLevel : 0, dt);
        this.#updateFace(dt);
        this.group.updateWorldMatrix(true, false);
        const viewerLocal = viewer ? this.group.worldToLocal(tmpVector.copy(viewer)).clone() : null;
        this.#look(dt, viewerLocal);
        this.#updateArms(dt);
        this.#updateIndicators(dt, viewerLocal);
    }

    #build() {
        // A soft shadow on the floor: in the headset it is what makes the
        // teacher stand in the room instead of floating in front of it.
        this.discTexture = createSoftDiscTexture();
        const shadow = new THREE.Mesh(
            new THREE.CircleGeometry(0.34, 40),
            new THREE.MeshBasicMaterial({ color: 0x000000, map: this.discTexture, transparent: true, opacity: 0.45, depthWrite: false }),
        );
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.002;
        shadow.renderOrder = -1;
        this.group.add(shadow);

        this.body = new THREE.Group();
        this.group.add(this.body);

        const bodyMaterial = new THREE.MeshStandardMaterial({ color: COLORS.body, roughness: 0.55 });
        const featureMaterial = new THREE.MeshStandardMaterial({ color: COLORS.features, roughness: 0.35 });

        // Breathing scales the torso from its base, so it grows upward.
        this.torso = new THREE.Group();
        const outline = new THREE.SplineCurve(BODY_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)));
        const torsoMesh = new THREE.Mesh(new THREE.LatheGeometry(outline.getPoints(48), 40), bodyMaterial);
        const collar = new THREE.Mesh(
            new THREE.TorusGeometry(0.13, 0.028, 12, 40),
            new THREE.MeshStandardMaterial({ color: COLORS.collar, roughness: 0.5 }),
        );
        collar.rotation.x = Math.PI / 2;
        collar.position.y = NECK_Y + 0.005;
        this.torso.add(torsoMesh, collar);
        this.body.add(this.torso);

        this.arms = [-1, 1].map((side) => {
            const shoulder = new THREE.Group();
            shoulder.position.set(side * SHOULDER_X, SHOULDER_Y, 0);
            const arm = new THREE.Mesh(
                new THREE.CapsuleGeometry(0.05, 0.26, 6, 14).translate(0, -0.18, 0),
                bodyMaterial,
            );
            shoulder.add(arm);
            this.body.add(shoulder);
            return { side, shoulder };
        });

        this.headPivot = new THREE.Group();
        this.headPivot.position.y = NECK_Y;
        this.headPivot.rotation.order = "YXZ";
        const head = new THREE.Mesh(
            new THREE.SphereGeometry(HEAD_RADIUS, 40, 24),
            new THREE.MeshStandardMaterial({ color: COLORS.head, roughness: 0.6 }),
        );
        head.position.y = HEAD_Y;
        this.headPivot.add(head);

        const R = HEAD_RADIUS;
        const eyeGeometry = new THREE.SphereGeometry(0.028, 20, 12);
        const glintGeometry = new THREE.SphereGeometry(0.0075, 10, 6);
        const glintMaterial = new THREE.MeshBasicMaterial({ color: 0xFFFFFF });
        this.eyes = [-1, 1].map((side) => {
            const eye = new THREE.Group();
            placeOnHead(eye, side * 0.37 * R, 0.2 * R, 0.008);
            const ball = new THREE.Mesh(eyeGeometry, featureMaterial);
            ball.scale.set(0.85, 1.25, 0.55);
            const glint = new THREE.Mesh(glintGeometry, glintMaterial);
            glint.position.set(0.008, 0.013, 0.012);
            eye.add(ball, glint);
            this.headPivot.add(eye);
            return eye;
        });

        const browGeometry = new THREE.CapsuleGeometry(0.007, 0.034, 4, 8).rotateZ(Math.PI / 2);
        this.brows = [-1, 1].map((side) => {
            const brow = new THREE.Mesh(browGeometry, featureMaterial);
            placeOnHead(brow, side * 0.37 * R, 0.52 * R, 0.002);
            brow.userData.side = side;
            this.headPivot.add(brow);
            return brow;
        });

        this.mouth = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), featureMaterial);
        placeOnHead(this.mouth, 0, -0.33 * R, 0.004);
        this.headPivot.add(this.mouth);
        this.body.add(this.headPivot);

        this.#buildIndicators();
    }

    #buildIndicators() {
        this.indicators = new THREE.Group();
        this.indicators.position.y = INDICATOR_Y;
        this.body.add(this.indicators);

        const listening = new THREE.Group();
        const ringMaterial = unlit(COLORS.listening);
        const dotMaterial = unlit(COLORS.listening);
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.042, 0.056, 48), ringMaterial);
        const dot = new THREE.Mesh(new THREE.CircleGeometry(0.02, 32), dotMaterial);
        listening.add(ring, dot);

        const thinking = new THREE.Group();
        const thinkingMaterial = unlit(COLORS.thinking);
        const dotGeometry = new THREE.SphereGeometry(0.016, 16, 8);
        const dots = [0, 1, 2].map(() => new THREE.Mesh(dotGeometry, thinkingMaterial));
        thinking.add(...dots);

        const speaking = new THREE.Group();
        const glowMaterial = new THREE.SpriteMaterial({
            map: this.discTexture,
            color: COLORS.speaking,
            transparent: true,
            depthWrite: false,
        });
        const glow = new THREE.Sprite(glowMaterial);
        speaking.add(glow);

        this.signs = {
            listening: { group: listening, weight: 0, ring, materials: [ringMaterial, dotMaterial] },
            thinking: { group: thinking, weight: 0, dots, materials: [thinkingMaterial] },
            speaking: { group: speaking, weight: 0, glow, materials: [glowMaterial] },
        };
        for (const sign of Object.values(this.signs)) {
            sign.group.visible = false;
            this.indicators.add(sign.group);
        }
    }

    #nextBlinkGap() {
        return BLINK.minGap + (BLINK.maxGap - BLINK.minGap) * this.random();
    }

    /** How closed a blink keeps the eyes right now: 0 open, 1 shut. */
    #blinkClosure(dt) {
        const blink = this.blink;
        if (blink.t < 0) {
            blink.wait -= dt;
            if (blink.wait > 0) {
                return 0;
            }
            blink.t = 0;
        }
        blink.t += dt;
        const { close, hold, open } = BLINK;
        if (blink.t < close) {
            return blink.t / close;
        }
        if (blink.t < close + hold) {
            return 1;
        }
        if (blink.t < close + hold + open) {
            return 1 - (blink.t - close - hold) / open;
        }
        blink.t = -1;
        // Now and then two blinks in a row, as people do.
        blink.wait = this.random() < BLINK.doubleChance ? 0.12 : this.#nextBlinkGap();
        return 0;
    }

    #breathe(dt) {
        const breathsPerSecond = this.state === "asleep" ? 0.16 : 0.24;
        this.breathPhase = (this.breathPhase + dt * breathsPerSecond * 2 * Math.PI) % (2 * Math.PI);
        const breath = Math.sin(this.breathPhase);
        this.breath = breath;
        this.torso.scale.set(1 + 0.008 * breath, 1 + 0.012 * breath, 1 + 0.008 * breath);
        this.headPivot.position.y = NECK_Y + BODY_HEIGHT * 0.012 * breath;
    }

    #updateFace(dt) {
        const closure = Math.max(this.#blinkClosure(dt), this.pose.lids);
        for (const eye of this.eyes) {
            eye.scale.y = Math.max(0.1, 1 - 0.9 * closure);
        }
        for (const brow of this.brows) {
            const asym = brow.userData.side > 0 ? this.pose.browAsym : 0;
            // Brows lift a touch on stressed syllables.
            brow.position.y = brow.userData.restY + this.pose.brow + asym + 0.004 * this.mouthOpen;
        }
        const open = this.mouthOpen;
        this.mouth.scale.set(0.04 - 0.01 * open, 0.0045 + 0.028 * open, 0.012);
    }

    /**
     * Head toward the viewer (or the glance target); the body turns only when
     * the head alone would not get there.
     * @param {THREE.Vector3|null} viewerLocal viewer in the group's frame
     */
    #look(dt, viewerLocal) {
        const asleep = this.state === "asleep";
        if (viewerLocal && !asleep) {
            const towardViewer = Math.atan2(viewerLocal.x, viewerLocal.z);
            const offset = wrapAngle(towardViewer - this.bodyYaw);
            const excess = Math.sign(offset) * Math.max(0, Math.abs(offset) - BODY_DEAD_ZONE);
            this.bodyYaw = wrapAngle(this.bodyYaw + excess * (1 - Math.exp(-dt / BODY_TURN_SECONDS)));
            this.body.rotation.y = this.bodyYaw;
        }

        let target = asleep ? null : viewerLocal;
        if (this.glance.remaining > 0) {
            this.glance.remaining -= dt;
            const point = this.group.worldToLocal(tmpVector.copy(this.glance.world));
            if (!this.glance.side) {
                // Which hand points: the one on the point's side of the body.
                const bodyX = point.x * Math.cos(this.bodyYaw) - point.z * Math.sin(this.bodyYaw);
                this.glance.side = bodyX >= 0 ? 1 : -1;
            }
            if (!asleep) {
                target = point;
            }
        }

        let yaw = 0;
        let pitch = 0;
        if (target) {
            yaw = wrapAngle(Math.atan2(target.x, target.z) - this.bodyYaw);
            pitch = Math.atan2(target.y - EYE_HEIGHT, Math.hypot(target.x, target.z));
        }
        // A little drift, so the head is never perfectly still.
        const t = this.time;
        yaw += 0.05 * Math.sin(t * 0.37) + 0.025 * Math.sin(t * 0.91 + 1);
        pitch += 0.03 * Math.sin(t * 0.53 + 2);
        yaw += this.pose.yaw;
        pitch += this.pose.pitch - 0.05 * this.mouthOpen; // small nods while talking
        yaw = clamp(yaw, -HEAD_YAW_LIMIT, HEAD_YAW_LIMIT);
        pitch = clamp(pitch, -HEAD_PITCH_LIMIT, HEAD_PITCH_LIMIT);
        this.headYaw = approach(this.headYaw, yaw, HEAD_TURN_SECONDS, dt);
        this.headPitch = approach(this.headPitch, pitch, HEAD_TURN_SECONDS, dt);
        this.headPivot.rotation.set(-this.headPitch, this.headYaw, this.pose.roll);
    }

    #updateArms(dt) {
        const pointing = this.glance.remaining > 0 && this.state !== "asleep";
        this.pointing = approach(this.pointing, pointing ? 1 : 0, 0.2, dt);
        for (const { side, shoulder } of this.arms) {
            const raise = side === this.glance.side ? this.pointing : 0;
            // Out to the side and a bit forward, toward the diagram.
            shoulder.rotation.set(-0.35 * raise, 0, side * (0.14 + 0.015 * this.breath + 0.95 * raise));
        }
    }

    #updateIndicators(dt, viewerLocal) {
        if (viewerLocal) {
            // The signs always face the viewer, whatever the head is doing.
            this.indicators.rotation.y = wrapAngle(Math.atan2(viewerLocal.x, viewerLocal.z) - this.bodyYaw);
        }
        for (const [state, sign] of Object.entries(this.signs)) {
            sign.weight = approach(sign.weight, this.state === state ? 1 : 0, FADE_SECONDS, dt);
            sign.group.visible = sign.weight > 0.01;
            sign.group.scale.setScalar(0.6 + 0.4 * sign.weight);
        }
        const t = this.time;

        const listening = this.signs.listening;
        if (listening.group.visible) {
            const pulse = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 1.3);
            listening.ring.scale.setScalar(1 + 0.25 * pulse);
            listening.materials[0].opacity = listening.weight * (0.95 - 0.5 * pulse);
            listening.materials[1].opacity = listening.weight;
        }

        const thinking = this.signs.thinking;
        if (thinking.group.visible) {
            thinking.materials[0].opacity = thinking.weight;
            thinking.dots.forEach((dot, index) => {
                const angle = t * (2 * Math.PI / 1.4) + index * (2 * Math.PI / 3);
                // A tilted orbit: from the front it reads as circling, not as sliding.
                dot.position.set(0.065 * Math.cos(angle), 0.024 * Math.sin(angle), 0.065 * Math.sin(angle));
                dot.scale.setScalar(0.8 + 0.25 * (0.5 + 0.5 * Math.sin(angle)));
            });
        }

        const speaking = this.signs.speaking;
        if (speaking.group.visible) {
            speaking.glow.scale.setScalar(0.12 + 0.1 * this.mouthOpen);
            speaking.materials[0].opacity = speaking.weight * (0.35 + 0.5 * this.mouthOpen);
        }
    }
}
