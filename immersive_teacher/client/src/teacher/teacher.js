/**
 * The teacher: a round character made of primitives, dressed as a teacher
 * (jacket over a shirt and tie, a pencil in the breast pocket, trousers and
 * shoes, hands with a thumb), that stands on the floor next to its diagram.
 * It breathes, blinks, keeps its eyes on whoever is watching,
 * moves its mouth with its own voice, glances (and points) at each part of
 * the diagram as it appears, and shows above its head what it is doing.
 *
 *     setState(state)        idle | listening | thinking | speaking | asleep
 *     react("confused")      a short shrug over the current state (after a failure)
 *     glanceAt(worldPoint)   look there for a moment, and point there with
 *                            the arm on that side a little longer
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
const OUTLINE = new THREE.SplineCurve(BODY_PROFILE.map(([r, y]) => new THREE.Vector2(r, y))).getPoints(64);
const BODY_HEIGHT = 1.1;
const NECK_Y = 1.06;
const SHOULDER_X = 0.215;
const SHOULDER_Y = 0.86;

/**
 * The clothes, as heights on the body and half widths seen from the front
 * (meters). Each layer stands a few millimeters off the one below it.
 */
const CLOTHES = Object.freeze({
    hemY: 0.3, // where the jacket ends
    jacketTopY: 1.04,
    jacket: 0.006,
    neckline: { tipY: 0.64, halfWidth: 0.085 }, // the jacket's V, open over the shirt
    vent: { topY: 0.44, halfWidth: 0.05 }, // the opening under the last button
    buttonsY: [0.56, 0.48],
    lapelWidth: 0.034,
    trousersTopY: 0.47,
});
/** Arms at rest: a little out to the sides and forward, so the hands show. */
const ARM_SPREAD = 0.17;
const ARM_FORWARD = 0.1;
const SLEEVE_LENGTH = 0.3;
const HAND_RADIUS = 0.05;
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
    jacket: 0x714B67,
    lapel: 0x5C3A55,
    shirt: 0xF4F0F5,
    tie: 0x017E84,
    trousers: 0x48434F,
    shoes: 0x4A2F24,
    pencil: 0xF5B700,
    eraser: 0xE88FA5,
    skin: 0xEDE7F0,
    features: 0x2B1D29,
    listening: 0xE5484D,
    thinking: 0xF5B700,
    speaking: 0x5FD4DA,
});

/**
 * Head and face per state. Angles in radians (pitch up is positive), brows and
 * lids as offsets, arms as an extra lift of both arms. Moving between states
 * eases from one pose to the next.
 */
const POSES = Object.freeze({
    idle: { pitch: 0, yaw: 0, roll: 0, brow: 0, browAsym: 0, lids: 0, arms: 0 },
    listening: { pitch: 0.04, yaw: 0, roll: 0.13, brow: 0.008, browAsym: 0, lids: 0, arms: 0 },
    thinking: { pitch: 0.24, yaw: 0.32, roll: -0.05, brow: 0.004, browAsym: 0.01, lids: 0.18, arms: 0 },
    speaking: { pitch: 0, yaw: 0, roll: 0, brow: 0.003, browAsym: 0, lids: 0, arms: 0 },
    asleep: { pitch: -0.38, yaw: 0, roll: 0.1, brow: -0.003, browAsym: 0, lids: 1, arms: 0 },
});

/** Short expressions laid over the state's pose. */
const REACTIONS = Object.freeze({
    // Head tilted, one brow up, a small shrug: "sorry, that did not work".
    confused: { seconds: 2.6, pose: { pitch: 0.02, yaw: 0.12, roll: -0.2, brow: 0.004, browAsym: -0.014, lids: 0.12, arms: 0.45 } },
});

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const tmpVector = new THREE.Vector3();
const tmpDirection = new THREE.Vector3();
const tmpEuler = new THREE.Euler();
const tmpRest = new THREE.Quaternion();
const tmpAim = new THREE.Quaternion();
/** The way an arm hangs from its shoulder, at rest. */
const ARM_DOWN = new THREE.Vector3(0, -1, 0);
/** How long the head turns to a new part of the diagram, and how long the arm points at it. */
const GLANCE_SECONDS = 1.2;
const POINT_SECONDS = 2.4;

function approach(current, target, seconds, dt) {
    return current + (target - current) * (1 - Math.exp(-dt / seconds));
}

function wrapAngle(angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

/** Radius of the bare body at height `y` (above its rounded foot). */
function bodyRadiusAt(y) {
    for (let i = 1; i < OUTLINE.length; i += 1) {
        const below = OUTLINE[i - 1];
        const above = OUTLINE[i];
        if (above.y >= y && below.y <= y && above.y > below.y) {
            return lerp(below.x, above.x, (y - below.y) / (above.y - below.y));
        }
    }
    return 0;
}

/** The body outline up to height `y`, `offset` meters out: a layer that covers it. */
function outlineBelow(y, offset) {
    const points = OUTLINE.filter((point) => point.y < y);
    points.push(new THREE.Vector2(bodyRadiusAt(y), y));
    return points.map((point) => new THREE.Vector2(point.x + offset, point.y));
}

/** Angle around the body (0 at the front, toward +X) of a point `x` meters to the side. */
function angleAt(x, radius) {
    return Math.asin(clamp(x / radius, -1, 1));
}

/**
 * A piece of cloth on the body: the band between two heights, `offset(y)`
 * meters out of the body, covering the angles `span(y, radius)` returns at
 * each height. Normals come from the body's shape, so the piece shades like
 * the body under it.
 */
function bodyPatch(bottom, top, span, { offset, rows = 12, columns = 8 }) {
    const radiusAt = (y) => bodyRadiusAt(y) + offset(y);
    const positions = [];
    const normals = [];
    for (let i = 0; i <= rows; i += 1) {
        const y = lerp(bottom, top, i / rows);
        const radius = radiusAt(y);
        const slope = (radiusAt(y + 0.002) - radiusAt(y - 0.002)) / 0.004;
        const [from, to] = span(y, radius);
        for (let j = 0; j <= columns; j += 1) {
            const angle = lerp(from, to, j / columns);
            const sin = Math.sin(angle);
            const cos = Math.cos(angle);
            positions.push(radius * sin, y, radius * cos);
            const length = Math.hypot(1, slope);
            normals.push(sin / length, -slope / length, cos / length);
        }
    }
    const indices = [];
    const stride = columns + 1;
    for (let i = 0; i < rows; i += 1) {
        for (let j = 0; j < columns; j += 1) {
            const a = i * stride + j;
            indices.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    return geometry;
}

/** A patch on the front of the body between x = span(y)[0] and span(y)[1], seen from the front. */
function frontPatch(bottom, top, span, offset, rows = 8) {
    return bodyPatch(bottom, top, (y, radius) => span(y).map((x) => angleAt(x, radius)), {
        offset: () => offset,
        rows,
        columns: 6,
    });
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
        this.glance = { world: new THREE.Vector3(), remaining: 0 };
        /** What the arm on `side` points at (1 its left, -1 its right; 0 until picked). */
        this.point = { world: new THREE.Vector3(), remaining: 0, side: 1 };
        this.pointing = 0;
        this.reaction = null;

        this.#build();
    }

    setState(state) {
        if (!TEACHER_STATES.includes(state)) {
            throw new Error(`Unknown teacher state: ${state}`);
        }
        this.state = state;
    }

    /** Plays a short expression (see REACTIONS) over whatever the teacher is doing. */
    react(name) {
        const reaction = REACTIONS[name];
        if (!reaction) {
            throw new Error(`Unknown teacher reaction: ${name}`);
        }
        this.reaction = { pose: reaction.pose, remaining: reaction.seconds };
    }

    /**
     * Looks at `worldPoint` for `seconds`, then back at the viewer; the arm on
     * that side points at it a little longer, aimed at the point itself.
     */
    glanceAt(worldPoint, seconds = GLANCE_SECONDS) {
        this.glance.world.copy(worldPoint);
        this.glance.remaining = seconds;
        this.point.world.copy(worldPoint);
        this.point.remaining = Math.max(seconds, POINT_SECONDS);
        this.point.side = 0; // picked on the next update, from where the point is
    }

    /**
     * @param {number} dt seconds since the last frame
     * @param {object} [input]
     * @param {THREE.Vector3} [input.viewer] world position of the viewer's eyes
     * @param {number} [input.voiceLevel] loudness of the teacher's voice right now
     */
    update(dt, { viewer = null, voiceLevel = 0 } = {}) {
        this.time += dt;
        if (this.reaction) {
            this.reaction.remaining -= dt;
            if (this.reaction.remaining <= 0 || this.state === "asleep") {
                this.reaction = null;
            }
        }
        const pose = this.reaction ? this.reaction.pose : POSES[this.state];
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

        const cloth = (color, options = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...options });
        this.materials = {
            jacket: cloth(COLORS.jacket, { side: THREE.DoubleSide }),
            lapel: cloth(COLORS.lapel),
            shirt: cloth(COLORS.shirt, { roughness: 0.6 }),
            tie: cloth(COLORS.tie, { roughness: 0.45 }),
            trousers: cloth(COLORS.trousers),
            shoes: cloth(COLORS.shoes, { roughness: 0.35 }),
            skin: new THREE.MeshStandardMaterial({ color: COLORS.skin, roughness: 0.6 }),
        };
        const featureMaterial = new THREE.MeshStandardMaterial({ color: COLORS.features, roughness: 0.35 });

        this.#buildTorso();
        this.#buildArms();

        this.headPivot = new THREE.Group();
        this.headPivot.position.y = NECK_Y;
        this.headPivot.rotation.order = "YXZ";
        const head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS, 40, 24), this.materials.skin);
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

    /** The bare body is the shirt; trousers, jacket, tie and the rest are layers on it. */
    #buildTorso() {
        const { materials } = this;
        // Breathing scales the torso from its base, so it grows upward.
        this.torso = new THREE.Group();
        this.body.add(this.torso);
        const add = (geometry, material) => this.torso.add(new THREE.Mesh(geometry, material));

        add(new THREE.LatheGeometry(OUTLINE, 48), materials.shirt);
        add(new THREE.LatheGeometry(outlineBelow(CLOTHES.trousersTopY, 0.003), 48), materials.trousers);

        const { neckline, vent, jacketTopY, hemY } = CLOTHES;
        const necklineHalf = (y) => neckline.halfWidth * clamp((y - neckline.tipY) / (jacketTopY - neckline.tipY), 0, 1);
        const ventHalf = (y) => vent.halfWidth * clamp((vent.topY - y) / (vent.topY - hemY), 0, 1);
        // The jacket flares a little at the hem, like the skirt of a blazer.
        const jacketOffset = (y) => CLOTHES.jacket + 0.006 * clamp(1 - (y - hemY) / 0.1, 0, 1);
        const jacketSpan = (y, radius) => {
            const open = angleAt(Math.max(necklineHalf(y), ventHalf(y)), radius);
            return [open, 2 * Math.PI - open];
        };
        add(bodyPatch(hemY, jacketTopY, jacketSpan, { offset: jacketOffset, rows: 40, columns: 64 }), materials.jacket);

        // The tie runs under the jacket (its layer is lower), so the jacket
        // hides it where the V closes; the knot stands out a little more.
        const tieHalf = (y) => lerp(0.03, 0.013, clamp((y - 0.7) / 0.3, 0, 1));
        add(frontPatch(0.58, 1.0, (y) => [-tieHalf(y), tieHalf(y)], 0.003, 12), materials.tie);
        const knotHalf = (y) => lerp(0.013, 0.021, (y - 0.995) / 0.04);
        add(frontPatch(0.995, 1.035, (y) => [-knotHalf(y), knotHalf(y)], 0.008, 4), materials.tie);

        // Lapels along the V: narrow at the bottom, widest across the chest.
        const lapelWidth = (y) => {
            const s = clamp((y - neckline.tipY) / (jacketTopY - neckline.tipY), 0, 1);
            return CLOTHES.lapelWidth * (s < 0.7 ? lerp(0.2, 1, s / 0.7) : lerp(1, 0.4, (s - 0.7) / 0.3));
        };
        for (const side of [-1, 1]) {
            const span = (y) => {
                const inner = necklineHalf(y);
                return side > 0 ? [inner, inner + lapelWidth(y)] : [-inner - lapelWidth(y), -inner];
            };
            add(frontPatch(neckline.tipY, jacketTopY, span, CLOTHES.jacket + 0.003, 16), materials.lapel);
            // The shirt collar's points, on each side of the knot.
            const collar = (y) => {
                const s = (y - 0.965) / 0.075;
                const ends = [side * lerp(0.05, 0.012, s), side * lerp(0.05, 0.075, s)];
                return side > 0 ? ends : ends.reverse();
            };
            add(frontPatch(0.965, 1.04, collar, 0.011, 6), materials.shirt);
        }

        const buttonGeometry = new THREE.SphereGeometry(0.011, 14, 8);
        for (const y of CLOTHES.buttonsY) {
            const button = new THREE.Mesh(buttonGeometry, materials.lapel);
            button.position.set(0, y, bodyRadiusAt(y) + jacketOffset(y) + 0.002);
            button.scale.z = 0.45;
            this.torso.add(button);
        }

        // Breast pocket on its left, with a pencil in it.
        add(frontPatch(0.858, 0.87, () => [0.088, 0.148], CLOTHES.jacket + 0.003, 1), materials.lapel);
        this.torso.add(this.#pencil(0.104, 0.87));

        // Shoe tips peeking out from under the round body.
        const shoeGeometry = new THREE.SphereGeometry(1, 24, 10, 0, 2 * Math.PI, 0, Math.PI / 2);
        for (const side of [-1, 1]) {
            const shoe = new THREE.Mesh(shoeGeometry, materials.shoes);
            shoe.position.set(side * 0.1, 0, 0.19);
            shoe.scale.set(0.085, 0.05, 0.13);
            this.body.add(shoe);
        }
    }

    /** A pencil standing in the breast pocket, `x` meters to the side, its lower end at `y`. */
    #pencil(x, y) {
        const radius = bodyRadiusAt(y) + CLOTHES.jacket;
        const slope = (bodyRadiusAt(y + 0.02) - bodyRadiusAt(y - 0.02)) / 0.04;
        const holder = new THREE.Group();
        holder.rotation.y = angleAt(x, radius);
        const pencil = new THREE.Group();
        pencil.position.set(0, y, radius + 0.008);
        pencil.rotation.x = Math.atan(slope); // leans back with the chest
        const wood = new THREE.Mesh(
            new THREE.CylinderGeometry(0.0065, 0.0065, 0.04, 6).translate(0, 0.02, 0),
            new THREE.MeshStandardMaterial({ color: COLORS.pencil, roughness: 0.5 }),
        );
        const eraser = new THREE.Mesh(
            new THREE.CylinderGeometry(0.0065, 0.0065, 0.009, 12).translate(0, 0.0445, 0),
            new THREE.MeshStandardMaterial({ color: COLORS.eraser, roughness: 0.8 }),
        );
        pencil.add(wood, eraser);
        holder.add(pencil);
        return holder;
    }

    /** Sleeves ending in a shirt cuff, and round hands whose index finger comes out to point. */
    #buildArms() {
        const { materials } = this;
        const sleeveGeometry = new THREE.CapsuleGeometry(0.05, SLEEVE_LENGTH - 0.1, 6, 16).translate(0, -SLEEVE_LENGTH / 2, 0);
        const cuffGeometry = new THREE.CylinderGeometry(0.045, 0.045, 0.026, 20).translate(0, -SLEEVE_LENGTH + 0.008, 0);
        const palmGeometry = new THREE.SphereGeometry(HAND_RADIUS, 20, 14);
        const thumbGeometry = new THREE.CapsuleGeometry(0.014, 0.022, 4, 10);
        const fingerGeometry = new THREE.CapsuleGeometry(0.0125, 0.036, 4, 10).translate(0, -0.03, 0);
        this.arms = [-1, 1].map((side) => {
            const shoulder = new THREE.Group();
            shoulder.position.set(side * SHOULDER_X, SHOULDER_Y, 0);
            // The palm faces the body; the thumb is on the front.
            const hand = new THREE.Group();
            hand.position.y = -SLEEVE_LENGTH - HAND_RADIUS + 0.008;
            const palm = new THREE.Mesh(palmGeometry, materials.skin);
            palm.scale.set(0.78, 1, 0.92);
            const thumb = new THREE.Mesh(thumbGeometry, materials.skin);
            thumb.position.set(-side * 0.008, 0.002, 0.04);
            thumb.rotation.x = -0.6;
            const finger = new THREE.Mesh(fingerGeometry, materials.skin);
            finger.position.set(0, -0.024, 0.014);
            hand.add(palm, thumb, finger);
            shoulder.add(new THREE.Mesh(sleeveGeometry, materials.jacket), new THREE.Mesh(cuffGeometry, materials.shirt), hand);
            this.body.add(shoulder);
            return { side, shoulder, hand, finger };
        });
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
            if (!asleep) {
                target = this.group.worldToLocal(tmpVector.copy(this.glance.world));
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
        const point = this.point;
        point.remaining = Math.max(0, point.remaining - dt);
        const pointing = point.remaining > 0 && this.state !== "asleep";
        this.pointing = approach(this.pointing, pointing ? 1 : 0, 0.2, dt);
        // The point in the body's frame: the body turns toward the viewer on its own.
        this.body.updateWorldMatrix(true, false);
        const local = this.body.worldToLocal(tmpVector.copy(point.world));
        if (!point.side) {
            // Which hand points: the one on the point's side of the body.
            point.side = local.x >= 0 ? 1 : -1;
        }
        const shrug = clamp(this.pose.arms / REACTIONS.confused.pose.arms, 0, 1);
        for (const { side, shoulder, hand, finger } of this.arms) {
            const raise = side === point.side ? this.pointing : 0;
            // At rest out to the side and a bit forward; both arms a little up for a shrug.
            const lift = this.pose.arms;
            const forward = ARM_FORWARD + 0.3 * this.pose.arms;
            tmpEuler.set(-forward, 0, side * (ARM_SPREAD + 0.015 * this.breath + lift));
            tmpRest.setFromEuler(tmpEuler);
            if (raise > 0.001) {
                // Pointing: the arm turns from hanging down to the line from its shoulder to the point.
                tmpDirection.subVectors(local, shoulder.position);
                if (tmpDirection.lengthSq() < 1e-6) {
                    tmpDirection.set(side, 0, 1);
                }
                tmpAim.setFromUnitVectors(ARM_DOWN, tmpDirection.normalize());
                shoulder.quaternion.slerpQuaternions(tmpRest, tmpAim, raise);
            } else {
                shoulder.quaternion.copy(tmpRest);
            }
            // The pointing hand stretches its index finger; in a shrug the palms turn out.
            finger.scale.y = lerp(0.35, 1, raise);
            hand.rotation.y = side * 1.3 * shrug;
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
