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
import { list, setLanguage, t } from "../client/src/i18n.js";
import { XrCaptions } from "../client/src/xr/captions.js";
import { XrInteraction } from "../client/src/xr/interaction.js";
import { WALL_GAP, boardPlacement, isPlaceable, placementFor, surfaceKind } from "../client/src/xr/placement.js";
import { XR_FOVEATION, XR_SCALE, xrQuality } from "../client/src/xr/quality.js";
import { XrMenu } from "../client/src/xr/xr_menu.js";

function recorder() {
    const log = [];
    const interaction = new XrInteraction({
        onPlace: (source) => log.push(`place ${source}`),
        onTalkStart: () => log.push("talk"),
        onTalkEnd: () => log.push("send"),
        onGrabStart: (source) => log.push(`grab ${source}`),
        onGrabEnd: (source) => log.push(`drop ${source}`),
        onControl: (control) => log.push(`press ${control}`),
        onNodeDown: (source, node) => log.push(`hold ${node}`),
        onNodeUp: (source, node, { cancelled }) => log.push(`${cancelled ? "cancel" : "let go"} ${node}`),
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

test("teaching: trigger or pinch on a floating button presses it instead of talking", () => {
    const { interaction, log } = recorder();
    interaction.press("right", "select", { control: "move" });
    interaction.release("right", "select");
    assert.deepEqual(log, [], "buttons do nothing while placing");

    interaction.press("right", "select", { surface: true });
    interaction.release("right", "select");
    log.length = 0;
    assert.equal(interaction.press("right", "select", { control: "ask:0" }), "control");
    interaction.release("right", "select");
    assert.equal(interaction.press("right", "squeeze", { control: "ask:0" }), null, "the grip does not press");
    assert.deepEqual(log, ["press ask:0"]);
});

test("teaching: trigger or pinch on a node holds it instead of talking; the grip does nothing there", () => {
    const { interaction, log } = recorder();
    assert.equal(interaction.press("right", "select", { node: "glucosa" }), null, "nodes do nothing while placing");
    interaction.release("right", "select");

    interaction.press("right", "select", { surface: true });
    interaction.release("right", "select");
    log.length = 0;
    assert.equal(interaction.press("right", "select", { node: "glucosa" }), "node");
    // Letting go is what explores (or ends a move); it sends no recording.
    interaction.release("right", "select");
    assert.equal(interaction.press("left", "squeeze", { node: "glucosa" }), null);
    interaction.release("left", "squeeze");
    // The bar and the buttons come first, when the caller reports both.
    assert.equal(interaction.press("left", "select", { onHandle: true, node: "glucosa" }), "grab");
    interaction.release("left", "select");
    assert.equal(interaction.press("left", "select", { control: "move", node: "glucosa" }), "control");
    interaction.release("left", "select");
    assert.deepEqual(log, ["hold glucosa", "let go glucosa", "grab left", "drop left", "press move"]);

    // A or X while holding a node lets go of it without exploring.
    log.length = 0;
    interaction.press("right", "select", { node: "agua" });
    interaction.menu();
    assert.deepEqual(log, ["hold agua", "cancel agua", "mode placing"]);
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
    assert.equal(captions.currentText(), t("hint.placing"));
    captions.setHint("teaching");
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
    assert.equal(captions.currentText(), t("hint.teaching"));
    // Events from an older turn are ignored.
    captions.highlightStep(3, 1);
    assert.equal(captions.currentText(), t("hint.teaching"));
});

test("captions follow the language: hints and states are relabeled, sentences stay", () => {
    const captions = new XrCaptions();
    captions.setHint("teaching");
    try {
        setLanguage("en", { remember: false });
        captions.relabel();
        assert.match(captions.currentText(), /^Hold the trigger or pinch to ask/);
        captions.startTurn(1, null);
        captions.setStatus("thinking");
        captions.setQuestion(1, "What is an atom?");
        assert.equal(captions.currentText(), "“What is an atom?” Thinking…");
    } finally {
        setLanguage("es", { remember: false });
    }
    assert.equal(captions.currentText(), "«What is an atom?» Pensando…");
});

/** A stand-in for the canvas text sprites: Node has no canvas. */
function fakeLabel(text) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial());
    sprite.scale.set(0.3, text.length > 24 ? 0.07 : 0.04, 1);
    return sprite;
}

test("the side menu: a move button, and the suggested questions on demand", () => {
    const menu = new XrMenu({ createLabel: fakeLabel });
    menu.group.visible = true;
    menu.group.updateMatrixWorld(true);
    const visible = () => menu.buttons.filter((button) => button.holder.visible).map((button) => button.id);
    assert.deepEqual(visible(), ["move", "language", "level"]);

    menu.setSuggestionsVisible(true);
    menu.group.updateMatrixWorld(true);
    assert.deepEqual(visible(), ["move", "language", "level", "ask:0", "ask:1", "ask:2", "ask:3"]);
    assert.equal(menu.questionFor("ask:1"), list("suggestions")[1]);
    assert.equal(menu.questionFor("move"), null);
    assert.equal(menu.questionFor("language"), null);
    // A column without overlaps, from the top down.
    const ys = menu.buttons.map((button) => button.holder.position.y);
    assert.ok(ys.every((y, index) => index === 0 || y < ys[index - 1]));

    // A ray from in front, aimed at the fifth button, hits that one.
    const raycaster = new THREE.Raycaster();
    const target = menu.buttons[4].holder.getWorldPosition(new THREE.Vector3());
    raycaster.set(new THREE.Vector3(target.x, target.y, 1), new THREE.Vector3(0, 0, -1));
    assert.equal(menu.hit(raycaster).id, "ask:1");
    menu.toggleSuggestions();
    menu.group.updateMatrixWorld(true);
    assert.equal(menu.hit(raycaster), null, "hidden buttons cannot be pressed");
    menu.group.visible = false;
    raycaster.set(new THREE.Vector3(0, menu.buttons[0].holder.position.y, 1), new THREE.Vector3(0, 0, -1));
    assert.equal(menu.hit(raycaster), null);
});

test("the language button is named in the other language, and a switch rebuilds the menu", () => {
    const texts = [];
    const menu = new XrMenu({ createLabel: (text, accent) => { texts.push(text); return fakeLabel(text, accent); } });
    assert.deepEqual(texts.slice(0, 3), ["Mover al profesor", "English", "Nivel: Normal"]);
    menu.setSuggestionsVisible(true);
    try {
        setLanguage("en", { remember: false });
        texts.length = 0;
        menu.relabel();
        assert.deepEqual(texts.slice(0, 3), ["Move the teacher", "Español", "Level: Normal"]);
        assert.equal(menu.questionFor("ask:0"), "How does the water cycle work?");
        // Still open, and the old buttons are gone.
        assert.equal(menu.buttons.length, 7);
        assert.equal(menu.group.children.length, 7);
        assert.ok(menu.buttons.every((button) => button.holder.visible));
    } finally {
        setLanguage("es", { remember: false });
    }
});

test("questions about the user's sources lead the suggestions, rebuilt only when they change", () => {
    const menu = new XrMenu({ createLabel: fakeLabel });
    menu.setSuggestionsVisible(true);
    const question = "Explícame de qué trata «manual.pdf».";
    menu.setExtraQuestions([question]);
    assert.equal(menu.questionFor("ask:0"), question);
    assert.equal(menu.questionFor("ask:1"), list("suggestions")[0]);
    assert.equal(menu.buttons.length, 8);
    const buttons = menu.buttons;
    menu.setExtraQuestions([question]);
    assert.equal(menu.buttons, buttons, "the same questions do not rebuild the menu");
    menu.setExtraQuestions([]);
    assert.equal(menu.buttons.length, 7);
    assert.equal(menu.group.children.length, 7, "the old buttons are gone");
    assert.ok(menu.buttons.every((button) => button.holder.visible), "still open");
});

test("the Odoo AI button shows only when the server has it, and says whether it is on", () => {
    const texts = [];
    const menu = new XrMenu({ createLabel: (text, accent) => { texts.push(`${text}${accent ? " *" : ""}`); return fakeLabel(text, accent); } });
    assert.ok(!menu.buttons.some((button) => button.id === XrMenu.ODOO), "no button before the hello");

    texts.length = 0;
    menu.setOdoo({ available: true, on: false });
    assert.deepEqual(menu.buttons.slice(0, 4).map((button) => button.id), [XrMenu.MOVE, XrMenu.LANGUAGE, XrMenu.LEVEL, XrMenu.ODOO]);
    assert.equal(texts[3], "Odoo AI: no");
    assert.equal(menu.questionFor(XrMenu.ODOO), null, "a control, not a question");
    assert.ok(menu.buttons[3].holder.visible, "shown with the suggestions closed");

    const buttons = menu.buttons;
    menu.setOdoo({ available: true, on: false });
    assert.equal(menu.buttons, buttons, "the same state does not rebuild the menu");

    texts.length = 0;
    menu.setOdoo({ available: true, on: true });
    assert.equal(texts[3], "Odoo AI: sí *", "highlighted when on");

    menu.setOdoo({ available: false, on: true });
    assert.ok(!menu.buttons.some((button) => button.id === XrMenu.ODOO));
    assert.equal(menu.group.children.length, menu.buttons.length, "the old buttons are gone");
});

test("\"Volver a explicar\" shows while the diagram on screen can be said again", () => {
    const menu = new XrMenu({ createLabel: fakeLabel });
    assert.ok(!menu.buttons.some((button) => button.id === XrMenu.REPLAY));
    menu.setReplay(true);
    const replay = menu.buttons.find((button) => button.id === XrMenu.REPLAY);
    assert.ok(replay.holder.visible, "shown with the suggestions closed");
    assert.equal(menu.questionFor(XrMenu.REPLAY), null, "a control, not a question");
    const buttons = menu.buttons;
    menu.setReplay(true);
    assert.equal(menu.buttons, buttons, "the same state does not rebuild the menu");
    menu.setReplay(false);
    assert.ok(!menu.buttons.some((button) => button.id === XrMenu.REPLAY));
});

test("after a level change, the headset's button asks the explanation again at that level", () => {
    const texts = [];
    const menu = new XrMenu({ createLabel: (text, accent) => { texts.push(`${text}${accent ? " *" : ""}`); return fakeLabel(text, accent); } });
    menu.setReplay(true);
    assert.ok(texts.includes("Volver a explicar"));
    texts.length = 0;
    menu.setReplay(true, "kid");
    assert.ok(texts.includes("Explicar de nuevo: Niño *"), texts.join(" | "));
    const buttons = menu.buttons;
    menu.setReplay(true, "kid");
    assert.equal(menu.buttons, buttons, "the same state does not rebuild the menu");
});

test("the side menu stands on the teacher's other side, scaled like the diagram on a desk", () => {
    const lesson = new Lesson(new Teacher(), new DiagramView());
    lesson.placeAt({ x: 0, y: 0, z: 0 }, 0, "floor");
    lesson.group.updateWorldMatrix(true, true);
    const side = lesson.side.getWorldPosition(new THREE.Vector3());
    const board = lesson.board.getWorldPosition(new THREE.Vector3());
    assert.ok(side.x < 0 && board.x > 0, "buttons and diagram on opposite sides of the teacher");

    lesson.placeAt({ x: 0, y: 0.75, z: 0 }, 0, "desk");
    lesson.group.updateWorldMatrix(true, true);
    const sideScale = lesson.side.getWorldScale(new THREE.Vector3()).x;
    const boardScale = lesson.board.getWorldScale(new THREE.Vector3()).x;
    assert.ok(Math.abs(sideScale - boardScale) < 1e-9);
});

test("the headset draws sharper than three.js's defaults, and the URL can tune it", () => {
    assert.deepEqual(xrQuality(""), { scale: XR_SCALE, foveation: XR_FOVEATION });
    assert.ok(XR_SCALE > 1 && XR_FOVEATION < 1, "no sharper than three.js's defaults (scale 1, foveation 1)");
    assert.deepEqual(xrQuality("?xrscale=1.2&foveation=0"), { scale: 1.2, foveation: 0 });
    // Out of range is clamped; nonsense keeps the default.
    assert.deepEqual(xrQuality("?xrscale=9&foveation=-1"), { scale: 2, foveation: 0 });
    assert.deepEqual(xrQuality("?xrscale=abc&foveation="), { scale: XR_SCALE, foveation: XR_FOVEATION });
});

test("the diagram let go near a table stands on it facing the user, near a wall it hangs flat on it", () => {
    assert.equal(surfaceKind(1, 0.75), "table");
    assert.equal(surfaceKind(1, 0.02), null, "not on the floor");
    assert.equal(surfaceKind(0.05, 1.2), "wall");
    assert.equal(surfaceKind(0.6, 1), null, "not on a slope");

    const viewer = { x: 0, y: 1.6, z: 1 };
    const table = boardPlacement({ kind: "table", point: { x: 0, y: 0.75, z: -1 }, normal: { x: 0, y: 1, z: 0 }, viewer, lift: 0.3 });
    assert.deepEqual(table.position, { x: 0, y: 1.05, z: -1 });
    assert.ok(Math.abs(table.yaw) < 1e-9, "its front (+Z) faces the user");

    // A wall to the user's left, facing +X: the board hangs off it, its front facing out.
    const wall = boardPlacement({ kind: "wall", point: { x: -2, y: 1.4, z: 0 }, normal: { x: 1, y: 0.02, z: 0 }, viewer });
    assert.ok(Math.abs(wall.position.x - (-2 + WALL_GAP)) < 1e-9 && wall.position.y === 1.4);
    assert.ok(Math.abs(wall.yaw - Math.PI / 2) < 1e-9);
});

test("the level button names the level, and is highlighted unless it is normal", () => {
    const texts = [];
    const menu = new XrMenu({ createLabel: (text, accent) => { texts.push(`${text}${accent ? " *" : ""}`); return fakeLabel(text, accent); } });
    assert.ok(texts.includes("Nivel: Normal"));
    texts.length = 0;
    menu.setLevel("kid");
    assert.ok(texts.includes("Nivel: Niño *"));
    const buttons = menu.buttons;
    menu.setLevel("kid");
    assert.equal(menu.buttons, buttons, "the same level does not rebuild the menu");
    assert.equal(menu.questionFor(XrMenu.LEVEL), null, "a control, not a question");
});

test("under the sentence being said, the captions name where its facts come from", () => {
    const captions = new XrCaptions();
    captions.startTurn(1);
    captions.addSentence(1, 1, "Primero se crea el pedido.");
    captions.addSentence(1, 2, "Luego se confirma.");
    captions.addCitation(1, 2, { source: "Manual.pdf", pages: { from: 4, to: 4 } });
    captions.addCitation(1, 2, { source: "Manual.pdf", pages: { from: 4, to: 4 } });
    captions.addCitation(1, 2, { source: "Guía", pages: null });
    captions.highlightStep(1, 1);
    assert.equal(captions.currentSource(), "");
    captions.highlightStep(1, 2);
    assert.equal(captions.currentSource(), "Fuente: Manual.pdf, p. 4; Guía");
    captions.flash("Aviso");
    assert.equal(captions.currentSource(), "", "a warning hides it");

    // Said again: the citations come back with the sentences.
    const replay = new XrCaptions();
    replay.replayTurn(1, new Map([[1, "Uno."]]), new Map([[1, [{ source: "Manual.pdf", pages: { from: 2, to: 3 } }]]]));
    replay.highlightStep(1, 1);
    assert.equal(replay.currentSource(), "Fuente: Manual.pdf, pp. 2-3");
});
