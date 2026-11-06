/**
 * The headset's logic without a headset: what each press does, where the
 * lesson goes, how it is sized, and what the captions say.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as THREE from "three";

import { DiagramView } from "../client/src/diagram/diagram_view.js";
import { LESSON_LAYOUTS, Lesson } from "../client/src/scene/lesson.js";
import { Teacher } from "../client/src/teacher/teacher.js";
import { HINTS, XrCaptions } from "../client/src/xr/captions.js";
import { XrInteraction } from "../client/src/xr/interaction.js";
import { isPlaceable, placementFor } from "../client/src/xr/placement.js";

function recorder() {
    const log = [];
    const interaction = new XrInteraction({
        onPlace: (source) => log.push(`place ${source}`),
        onTalkStart: () => log.push("talk"),
        onTalkEnd: () => log.push("send"),
        onGrabStart: (source) => log.push(`grab ${source}`),
        onGrabEnd: (source) => log.push(`drop ${source}`),
        onModeChange: (mode) => log.push(`mode ${mode}`),
    });
    return { interaction, log };
}

test("placing: trigger or pinch on a surface puts the lesson there, elsewhere does nothing", () => {
    const { interaction, log } = recorder();
    assert.equal(interaction.press("right", "select", { surface: false }), null);
    interaction.release("right", "select");
    assert.equal(interaction.press("right", "squeeze", { surface: true }), null, "the grip does not place");
    interaction.release("right", "squeeze");
    assert.deepEqual(log, []);

    assert.equal(interaction.press("right", "select", { surface: true }), "place");
    // Releasing the press that placed it must not send a recording.
    interaction.release("right", "select");
    assert.deepEqual(log, ["place right", "mode teaching"]);
});

test("teaching: hold to talk, release to send; one talker at a time", () => {
    const { interaction, log } = recorder();
    interaction.press("right", "select", { surface: true });
    interaction.release("right", "select");
    log.length = 0;

    assert.equal(interaction.press("right", "select"), "talk");
    assert.equal(interaction.press("left", "select"), null, "the other hand cannot start a second recording");
    interaction.release("left", "select");
    interaction.release("right", "select");
    assert.deepEqual(log, ["talk", "send"]);
    assert.equal(interaction.press("left", "squeeze"), null, "the grip alone does not talk");
});

test("teaching: aiming at the bar grabs with trigger, pinch or grip, and never talks", () => {
    const { interaction, log } = recorder();
    interaction.press("left", "select", { surface: true });
    interaction.release("left", "select");
    log.length = 0;

    assert.equal(interaction.press("left", "select", { onHandle: true }), "grab");
    assert.equal(interaction.press("right", "squeeze", { onHandle: true }), null, "one grab at a time");
    interaction.release("right", "squeeze");
    // While carrying the diagram with one hand, the other can still talk.
    assert.equal(interaction.press("right", "select"), "talk");
    interaction.release("left", "select");
    interaction.release("right", "select");
    assert.deepEqual(log, ["grab left", "talk", "drop left", "send"]);

    log.length = 0;
    assert.equal(interaction.press("right", "squeeze", { onHandle: true }), "grab");
    interaction.release("right", "squeeze");
    assert.deepEqual(log, ["grab right", "drop right"]);
});

test("A or X goes back to placing, lets go of everything, and cancels once placed", () => {
    const { interaction, log } = recorder();
    interaction.menu();
    assert.equal(interaction.mode, "placing", "nothing to cancel before the first placement");

    interaction.press("right", "select", { surface: true });
    interaction.release("right", "select");
    interaction.press("right", "select");
    log.length = 0;
    interaction.menu();
    assert.deepEqual(log, ["send", "mode placing"]);
    interaction.release("right", "select");
    assert.deepEqual(log, ["send", "mode placing"], "the release after the menu does nothing more");

    interaction.menu();
    assert.equal(interaction.mode, "teaching", "a second A/X keeps the current place");
});

test("a controller that disappears lets go of what it held", () => {
    const { interaction, log } = recorder();
    interaction.press("left", "select", { surface: true });
    interaction.release("left", "select");
    interaction.press("left", "squeeze", { onHandle: true });
    interaction.press("right", "select");
    log.length = 0;
    interaction.lost("left");
    assert.deepEqual(log, ["drop left"]);
    interaction.reset();
    assert.deepEqual(log, ["drop left", "send", "mode placing"]);
    assert.equal(interaction.placed, false);
});

test("placement: floor or desk by height, turned to face the viewer, flat surfaces only", () => {
    const floor = placementFor({ x: 0, y: 0.01, z: -2 }, { x: 0, y: 1.6, z: 0 });
    assert.equal(floor.layout, "floor");
    assert.ok(Math.abs(floor.yaw) < 1e-9, "straight ahead: no turn");

    const desk = placementFor({ x: 1, y: 0.74, z: 0 }, { x: 0, y: 1.2, z: 0 });
    assert.equal(desk.layout, "desk");
    // The lesson faces +Z at rest; turned by -90 degrees it faces -X, toward the viewer.
    assert.ok(Math.abs(desk.yaw + Math.PI / 2) < 1e-9);

    assert.ok(isPlaceable(1));
    assert.ok(isPlaceable(0.9));
    assert.ok(!isPlaceable(0.5), "a steep slope");
    assert.ok(!isPlaceable(0), "a wall");
});

test("the lesson stands where it is placed, at floor or desk size, facing the viewer", () => {
    const lesson = new Lesson(new Teacher(), new DiagramView());
    const viewer = new THREE.Vector3(0, 1.2, 0);
    const { position, yaw, layout } = placementFor({ x: 0, y: 0.75, z: -1 }, viewer);
    lesson.placeAt(position, yaw, layout);
    lesson.group.updateWorldMatrix(true, true);

    const feet = lesson.teacher.group.getWorldPosition(new THREE.Vector3());
    assert.ok(feet.distanceTo(new THREE.Vector3(0, 0.75, -1)) < 1e-9);
    const teacherScale = lesson.teacher.group.getWorldScale(new THREE.Vector3()).x;
    assert.ok(Math.abs(teacherScale - LESSON_LAYOUTS.desk.scale) < 1e-9);

    // The board ends up beside the teacher, about 0.35 m over the desk, and
    // bigger than the teacher's scale alone would make it.
    const board = lesson.board.getWorldPosition(new THREE.Vector3());
    assert.ok(Math.abs(board.y - (0.75 + 0.35)) < 1e-9, `board at ${board.y}`);
    assert.ok(Math.abs(board.z + 1) < 1e-9, "beside, not in front or behind");
    assert.ok(lesson.board.getWorldScale(new THREE.Vector3()).x > 0.5);

    // Back on the floor, everything returns to full size and the board to its place.
    lesson.board.position.set(3, 3, 3);
    lesson.placeAt({ x: 0, y: 0, z: -2 }, 0, "floor");
    lesson.group.updateWorldMatrix(true, true);
    assert.deepEqual(lesson.board.getWorldPosition(new THREE.Vector3()).toArray(), [0.95, 1.4, -2]);
    assert.throws(() => lesson.applyLayout("ceiling"));
});

test("the grab bar follows the bottom of the diagram", () => {
    const diagram = new DiagramView();
    const lesson = new Lesson(new Teacher(), diagram);
    diagram.bounds = { minX: -0.3, maxX: 0.3, minY: -0.25, maxY: 0.25 };
    for (let i = 0; i < 120; i += 1) {
        lesson.update(1 / 60);
    }
    assert.ok(Math.abs(lesson.handle.position.y - (-0.25 - 0.13)) < 0.005);
    assert.equal(lesson.handle.visible, false, "hidden on the desktop");
});

test("captions: warnings first, then the sentence, then the state, then the hint", () => {
    const captions = new XrCaptions();
    assert.equal(captions.currentText(), HINTS.placing);
    captions.setHint(HINTS.teaching);
    captions.setStatus("listening");
    assert.match(captions.currentText(), /Te escucho/);

    captions.startTurn(4, null);
    captions.setStatus("thinking");
    captions.setQuestion(4, "¿Qué es un átomo?");
    assert.equal(captions.currentText(), "«¿Qué es un átomo?» Pensando…");

    captions.addSentence(4, 1, "Un átomo es la parte más pequeña de un elemento.");
    captions.setStatus("explaining");
    captions.highlightStep(4, 1);
    assert.equal(captions.currentText(), "Un átomo es la parte más pequeña de un elemento.");

    captions.showNote(4, "Deepgram tardó demasiado: sigo en texto.");
    assert.match(captions.currentText(), /tardó demasiado/);
    captions.update(7);
    assert.equal(captions.currentText(), "Un átomo es la parte más pequeña de un elemento.");

    captions.finishTurn(4);
    captions.setStatus("ready");
    assert.equal(captions.currentText(), HINTS.teaching);
    // Events from an older turn are ignored.
    captions.highlightStep(3, 1);
    assert.equal(captions.currentText(), HINTS.teaching);
});
