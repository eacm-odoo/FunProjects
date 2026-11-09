/**
 * The teacher's behaviour, without a renderer: three.js builds and moves the
 * scene graph fine in Node, only drawing needs WebGL.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as THREE from "three";

import { Status } from "../client/src/status.js";
import { Teacher } from "../client/src/teacher/teacher.js";

const FRAME = 1 / 60;
const IN_FRONT = new THREE.Vector3(0, 1.6, 2);

/** Runs `seconds` of frames; `each(teacher, t)` may inspect every frame. */
function run(teacher, seconds, input = {}, each = () => {}) {
    for (let t = 0; t < seconds; t += FRAME) {
        const frameInput = typeof input === "function" ? input(t) : input;
        teacher.update(FRAME, { viewer: IN_FRONT, ...frameInput });
        each(teacher, t);
    }
}

function visibleSigns(teacher) {
    return Object.entries(teacher.signs).filter(([, sign]) => sign.group.visible).map(([state]) => state);
}

test("it blinks every few seconds and opens its eyes again", () => {
    // random() = 0.5: the first blink comes after 4 s.
    const teacher = new Teacher({ random: () => 0.5 });
    const closedAt = [];
    run(teacher, 9, {}, (current, t) => {
        if (current.eyes[0].scale.y < 0.3) {
            closedAt.push(t);
        }
    });
    assert.ok(closedAt.length > 0, "never blinked");
    assert.ok(closedAt[0] > 3.9 && closedAt[0] < 4.2, `first blink at ${closedAt[0]}`);
    // A blink is short: the eyes are mostly closed for well under 0.2 s.
    const firstBlink = closedAt.filter((t) => t < closedAt[0] + 1);
    assert.ok(firstBlink.at(-1) - firstBlink[0] < 0.15);
    assert.equal(teacher.eyes[0].scale.y, 1);
});

test("the mouth follows the voice only while speaking", () => {
    const teacher = new Teacher();
    const voice = (t) => ({ voiceLevel: 0.2 * Math.max(0, Math.sin(2 * Math.PI * 5 * t)) });
    let widest = 0;
    run(teacher, 1, voice, (current) => {
        widest = Math.max(widest, current.mouth.scale.y);
    });
    assert.ok(widest < 0.005, "the mouth moved while idle");

    teacher.setState("speaking");
    widest = 0;
    run(teacher, 1, voice, (current) => {
        widest = Math.max(widest, current.mouth.scale.y);
    });
    assert.ok(widest > 0.025, `mouth opened only to ${widest}`);

    teacher.setState("idle");
    run(teacher, 0.8, voice);
    assert.ok(teacher.mouth.scale.y < 0.005);
});

test("the head turns to the viewer, and the body follows when the viewer walks around", () => {
    const teacher = new Teacher();
    const aside = new THREE.Vector3(2, 1.6, 0); // at its left, 90 degrees away
    for (let t = 0; t < 4; t += FRAME) {
        teacher.update(FRAME, { viewer: aside });
    }
    const facing = teacher.bodyYaw + teacher.headYaw;
    assert.ok(Math.abs(facing - Math.PI / 2) < 0.15, `faces ${facing} rad`);
    assert.ok(teacher.bodyYaw > 0.4, "the body did not turn");
    assert.ok(Math.abs(teacher.headYaw) <= 0.95);
});

test("the head follows the teacher's placement in the room", () => {
    const teacher = new Teacher();
    // Placed facing +X; the viewer straight in front of it is then at +X.
    teacher.group.rotation.y = Math.PI / 2;
    teacher.group.position.set(1, 0, 1);
    for (let t = 0; t < 2; t += FRAME) {
        teacher.update(FRAME, { viewer: new THREE.Vector3(3, 1.6, 1) });
    }
    assert.ok(Math.abs(teacher.bodyYaw) < 0.05, `body turned ${teacher.bodyYaw}`);
    assert.ok(Math.abs(teacher.headYaw) < 0.15);
});

test("each state shows its own sign above the head", () => {
    const teacher = new Teacher();
    run(teacher, 0.5);
    assert.deepEqual(visibleSigns(teacher), []);
    for (const state of ["listening", "thinking", "speaking"]) {
        teacher.setState(state);
        run(teacher, 0.8);
        assert.deepEqual(visibleSigns(teacher), [state]);
    }
    teacher.setState("idle");
    run(teacher, 0.8);
    assert.deepEqual(visibleSigns(teacher), []);
    assert.throws(() => teacher.setState("dancing"));
});

test("asleep, it closes its eyes and stops looking at the viewer", () => {
    const teacher = new Teacher({ random: () => 0.99 });
    teacher.setState("asleep");
    run(teacher, 2);
    assert.ok(teacher.eyes[0].scale.y < 0.15);
    assert.ok(teacher.headPitch < -0.25, "the head did not drop");
});

test("it glances and points at a new part of the diagram, then looks back", () => {
    const teacher = new Teacher();
    teacher.setState("speaking");
    run(teacher, 1);
    const [right, left] = teacher.arms;
    const rest = { right: right.shoulder.rotation.z, left: left.shoulder.rotation.z };
    assert.ok(left.finger.scale.y < 0.4, "the index finger is out at rest");
    teacher.glanceAt(new THREE.Vector3(1, 1.5, 0.1));
    run(teacher, 0.6);
    assert.ok(teacher.headYaw > 0.6, `head yaw ${teacher.headYaw}`);
    assert.equal(left.side, 1);
    assert.ok(left.shoulder.rotation.z > rest.left + 0.6, "the arm on that side did not rise");
    assert.ok(left.finger.scale.y > 0.9, "the pointing hand did not stretch its index finger");
    assert.ok(Math.abs(right.shoulder.rotation.z - rest.right) < 0.05, "the other arm moved");
    assert.ok(right.finger.scale.y < 0.4);

    run(teacher, 1.5);
    assert.ok(Math.abs(teacher.headYaw) < 0.15, `still looking away: ${teacher.headYaw}`);
    assert.ok(left.shoulder.rotation.z < rest.left + 0.1);
    assert.ok(left.finger.scale.y < 0.4);
});

test("after a failure it shrugs for a moment, then goes back to its state", () => {
    const teacher = new Teacher();
    teacher.setState("speaking");
    run(teacher, 1);
    teacher.react("confused");
    run(teacher, 1);
    assert.ok(teacher.pose.roll < -0.12, `head roll ${teacher.pose.roll}`);
    const [right, left] = teacher.arms;
    assert.ok(left.shoulder.rotation.z > 0.4 && right.shoulder.rotation.z < -0.4, "both arms up");
    // Palms turned out: each hand rotates toward its own side.
    assert.ok(left.hand.rotation.y > 0.8 && right.hand.rotation.y < -0.8, "the palms did not turn");
    run(teacher, 3);
    assert.equal(teacher.reaction, null);
    assert.ok(Math.abs(teacher.pose.roll) < 0.02);
    assert.throws(() => teacher.react("dancing"));
});

test("status listeners get the current state and every change, once", () => {
    const status = new Status();
    const seen = [];
    const stop = status.subscribe((state) => seen.push(state));
    status.set("ready");
    status.set("ready");
    status.set("thinking");
    stop();
    status.set("explaining");
    assert.deepEqual(seen, ["connecting", "ready", "thinking"]);
});
