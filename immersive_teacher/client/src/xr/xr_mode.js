/**
 * The headset mode: an immersive-ar session over the passthrough view.
 *
 * Each controller (or hand, on the Quest a pinch is a "select") gets a ray,
 * a hit-test source and a reticle. What a press does is decided by
 * XrInteraction; this module feeds it what each ray points at and carries
 * out the result: placing the lesson, talking, carrying the diagram,
 * exploring a node. The nearest of the bar, a button and a node along the ray
 * is the one it points at; pointing at a node with a question left open shows
 * that question in the captions.
 *
 * Heights are meters above the floor: the reference space is local-floor.
 */

import * as THREE from "three";

import { XrInteraction } from "./interaction.js";
import { DESK_MIN_HEIGHT, isPlaceable, placementFor } from "./placement.js";
import { XrMenu } from "./xr_menu.js";

const SESSION_INIT = Object.freeze({
    requiredFeatures: ["hit-test", "local-floor"],
    optionalFeatures: ["hand-tracking"],
});
/** A on the right controller, X on the left (xr-standard gamepad mapping). */
const MENU_BUTTON = 4;
/** B on the right controller, Y on the left. */
const SUGGESTIONS_BUTTON = 5;
const RAY_LENGTH = 2.5;
/** Where the first hint floats: ahead of the user and a little below the eyes. */
const HINT_DISTANCE = 1.1;
const HINT_DROP = 0.25;
const GRAB_FOLLOW_SECONDS = 0.05;
const RETICLE_OK = 0x4ADE80;
/** How long a node's open question stays in the captions once a ray points at it. */
const HOOK_CAPTION_SECONDS = 2.5;
const RETICLE_NO = 0x9AA5B1;

const RAY_GEOMETRY = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
const RAY_MATERIAL = new THREE.LineBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.55 });

const tmpMatrix = new THREE.Matrix4();
const tmpVector = new THREE.Vector3();
const tmpScale = new THREE.Vector3();

function createReticle() {
    const material = new THREE.MeshBasicMaterial({ color: RETICLE_OK, transparent: true, opacity: 0.9, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2), material);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.012, 16).rotateX(-Math.PI / 2), material);
    const reticle = new THREE.Group();
    reticle.add(ring, dot);
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    reticle.userData.material = material;
    return reticle;
}

export class XrMode {
    /**
     * @param {object} options
     * @param {import("../scene/stage.js").Stage} options.stage
     * @param {import("../scene/lesson.js").Lesson} options.lesson
     * @param {import("./captions.js").XrCaptions} options.captions
     * @param {XrMenu} options.menu buttons beside the teacher
     * @param {() => void} options.onTalkStart
     * @param {() => void} options.onTalkEnd
     * @param {(question: string) => void} options.onAsk a suggested question was picked
     * @param {() => void} [options.onSwitchLanguage] the language button was pressed
     * @param {() => void} [options.onToggleOdoo] the Odoo AI button was pressed
     * @param {(id: string) => void} [options.onExplore] a node of the diagram, or BACK_ID, was pressed
     * @param {() => void} [options.onReplay] "Volver a explicar" was pressed
     * @param {(active: boolean) => void} [options.onSessionChange]
     */
    constructor({
        stage, lesson, captions, menu, onTalkStart, onTalkEnd, onAsk, onSwitchLanguage = () => {}, onToggleOdoo = () => {},
        onExplore = () => {}, onReplay = () => {}, onSessionChange = () => {},
    }) {
        this.stage = stage;
        this.renderer = stage.renderer;
        this.lesson = lesson;
        this.captions = captions;
        this.menu = menu;
        this.onAsk = onAsk;
        this.onSwitchLanguage = onSwitchLanguage;
        this.onToggleOdoo = onToggleOdoo;
        this.onReplay = onReplay;
        this.onSessionChange = onSessionChange;
        this.session = null;
        this.grab = null;
        this.hintPlaced = false;
        /** The user's head this frame, from the viewer pose (meters, local-floor). */
        this.head = new THREE.Vector3();
        this.headForward = new THREE.Vector3(0, 0, -1);
        this.hasHead = false;
        this.raycaster = new THREE.Raycaster();
        this.interaction = new XrInteraction({
            onPlace: (source) => this.#place(source),
            onTalkStart,
            onTalkEnd,
            onGrabStart: (source) => this.#startGrab(source),
            onGrabEnd: () => {
                this.grab = null;
            },
            onControl: (control) => this.#pressControl(control),
            onExplore,
            onModeChange: (mode) => this.captions.setHint(mode),
        });
        this.inputs = [0, 1].map((index) => this.#createInput(index));
        /** Nodes some ray pointed at in the last frame. */
        this.hoveredNodes = new Set();
    }

    /** True when this browser (or the emulator) can open an immersive-ar session. */
    static async isSupported() {
        try {
            return Boolean(await navigator.xr?.isSessionSupported("immersive-ar"));
        } catch {
            return false;
        }
    }

    get active() {
        return this.session !== null;
    }

    get mode() {
        return this.interaction.mode;
    }

    /** Opens the session. Call it from a click: browsers require a user gesture. */
    async enter() {
        if (this.session) {
            return;
        }
        const session = await navigator.xr.requestSession("immersive-ar", SESSION_INIT);
        this.session = session;
        session.addEventListener("end", () => this.#onEnd(), { once: true });
        this.renderer.xr.setReferenceSpaceType("local-floor");
        await this.renderer.xr.setSession(session);
        this.stage.setXrPresenting(true);
        // Nothing stands in the room until the user picks a place.
        this.lesson.group.visible = false;
        this.lesson.setHandleVisible(true);
        this.hintPlaced = false;
        this.hasHead = false;
        this.captions.setHint("placing");
        this.captions.group.visible = true;
        this.onSessionChange(true);
    }

    async exit() {
        await this.session?.end();
    }

    /** Once per frame, with the XRFrame three.js passes to the animation loop. */
    update(dt, frame) {
        if (!this.session || !frame) {
            return;
        }
        const referenceSpace = this.renderer.xr.getReferenceSpace();
        this.#readHead(frame, referenceSpace);
        const placing = this.interaction.mode === "placing";
        const handleReady = this.lesson.group.visible && !placing;
        this.menu.group.visible = handleReady;
        this.#faceViewer(this.menu.group, this.lesson.side);
        this.lesson.group.updateWorldMatrix(true, true);
        let anyOnHandle = false;
        const hovered = new Set();
        const hoveredNodes = new Set();

        for (const input of this.inputs) {
            if (!input.source) {
                continue;
            }
            input.hit = this.#hitTest(input, frame, referenceSpace);

            this.raycaster.setFromXRController(input.controller);
            const handleHit = handleReady
                ? this.raycaster.intersectObject(this.lesson.handleHitArea, false)[0]
                : undefined;
            const controlHit = this.menu.hit(this.raycaster);
            const nodeHit = handleReady ? this.lesson.diagram.hit(this.raycaster) : null;
            // Whatever is nearer along the ray wins.
            const [nearest] = [
                handleHit && { kind: "handle", distance: handleHit.distance },
                controlHit && { kind: "control", id: controlHit.id, distance: controlHit.distance },
                nodeHit && { kind: "node", id: nodeHit.id, distance: nodeHit.distance },
            ].filter(Boolean).sort((a, b) => a.distance - b.distance);
            input.onHandle = nearest?.kind === "handle";
            input.control = nearest?.kind === "control" ? nearest.id : null;
            input.node = nearest?.kind === "node" ? nearest.id : null;
            anyOnHandle ||= input.onHandle;
            if (input.control) {
                hovered.add(input.control);
            }
            if (input.node) {
                hoveredNodes.add(input.node);
            }

            input.reticle.visible = placing && Boolean(input.hit);
            if (input.reticle.visible) {
                input.reticle.matrix.copy(input.hit.matrix);
                // A smaller ring on a desk: the teacher will be small there too.
                if (input.hit.position.y >= DESK_MIN_HEIGHT) {
                    input.reticle.matrix.scale(tmpScale.setScalar(0.6));
                }
                input.reticle.userData.material.color.setHex(input.hit.placeable ? RETICLE_OK : RETICLE_NO);
            }
            const surfaceDistance = input.hit ? this.raycaster.ray.origin.distanceTo(input.hit.position) : RAY_LENGTH;
            input.ray.scale.z = nearest?.distance ?? (placing ? surfaceDistance : RAY_LENGTH);

            const buttons = input.source.gamepad?.buttons;
            const menuPressed = Boolean(buttons?.[MENU_BUTTON]?.pressed);
            if (menuPressed && !input.menuWasPressed) {
                this.interaction.menu();
            }
            input.menuWasPressed = menuPressed;
            const suggestionsPressed = Boolean(buttons?.[SUGGESTIONS_BUTTON]?.pressed);
            if (suggestionsPressed && !input.suggestionsWasPressed && this.interaction.mode === "teaching") {
                this.menu.toggleSuggestions();
            }
            input.suggestionsWasPressed = suggestionsPressed;
        }

        this.menu.setHover(hovered);
        this.#hoverNodes(hoveredNodes);
        this.lesson.setHandleHighlight(this.grab ? 1 : anyOnHandle ? 0.6 : 0);
        this.#updateGrab(dt);
        this.#placeCaptions();
    }

    /**
     * The head pose straight from this frame. The three.js camera only takes
     * the head pose while rendering, so before the first render it still has
     * the desktop view: placing anything from it would put it behind the user.
     */
    #readHead(frame, referenceSpace) {
        const pose = frame.getViewerPose(referenceSpace);
        if (!pose) {
            return;
        }
        const matrix = tmpMatrix.fromArray(pose.transform.matrix);
        this.head.setFromMatrixPosition(matrix);
        this.headForward.set(0, 0, -1).transformDirection(matrix);
        this.hasHead = true;
    }

    #createInput(index) {
        const controller = this.renderer.xr.getController(index);
        const ray = new THREE.Line(RAY_GEOMETRY, RAY_MATERIAL);
        ray.scale.z = RAY_LENGTH;
        ray.visible = false;
        controller.add(ray);
        this.stage.scene.add(controller);
        const reticle = createReticle();
        this.stage.scene.add(reticle);

        const input = {
            id: `input${index}`,
            controller,
            ray,
            reticle,
            source: null,
            hitTestSource: null,
            hit: null,
            onHandle: false,
            control: null,
            node: null,
            menuWasPressed: false,
            suggestionsWasPressed: false,
        };
        controller.addEventListener("connected", (event) => this.#connect(input, event.data));
        controller.addEventListener("disconnected", () => this.#disconnect(input));
        controller.addEventListener("selectstart", () => this.#press(input, "select"));
        controller.addEventListener("selectend", () => this.interaction.release(input.id, "select"));
        controller.addEventListener("squeezestart", () => this.#press(input, "squeeze"));
        controller.addEventListener("squeezeend", () => this.interaction.release(input.id, "squeeze"));
        return input;
    }

    #connect(input, source) {
        if (!this.session || source.targetRayMode !== "tracked-pointer") {
            return; // gaze and screen taps have no ray to aim with
        }
        input.source = source;
        input.id = `${source.handedness}-${source.hand ? "hand" : "controller"}`;
        input.ray.visible = true;
        this.session.requestHitTestSource({ space: source.targetRaySpace })
            .then((hitTestSource) => {
                if (input.source === source) {
                    input.hitTestSource = hitTestSource;
                } else {
                    hitTestSource.cancel();
                }
            })
            .catch((error) => console.warn("No hit-test for this input:", error));
    }

    #disconnect(input) {
        if (input.source) {
            this.interaction.lost(input.id);
        }
        input.hitTestSource?.cancel();
        input.hitTestSource = null;
        input.source = null;
        input.hit = null;
        input.onHandle = false;
        input.control = null;
        input.node = null;
        input.ray.visible = false;
        input.reticle.visible = false;
        if (this.grab?.input === input) {
            this.grab = null;
        }
    }

    #press(input, button) {
        if (!input.source) {
            return;
        }
        const action = this.interaction.press(input.id, button, {
            onHandle: input.onHandle,
            surface: Boolean(input.hit?.placeable),
            control: input.control,
            node: input.node,
        });
        if (action) {
            this.#pulse(input, action === "talk" ? 0.3 : 0.6, 40);
        }
    }

    #hitTest(input, frame, referenceSpace) {
        if (!input.hitTestSource) {
            return null;
        }
        const pose = frame.getHitTestResults(input.hitTestSource)[0]?.getPose(referenceSpace);
        if (!pose) {
            return null;
        }
        const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
        // The hit pose's Y axis is the surface normal.
        const normalY = matrix.elements[5];
        return { matrix, position: new THREE.Vector3().setFromMatrixPosition(matrix), placeable: isPlaceable(normalY) };
    }

    /** Highlights the nodes the rays point at; a newly pointed one shows its open question. */
    #hoverNodes(ids) {
        for (const id of ids) {
            const hook = this.hoveredNodes.has(id) ? null : this.lesson.diagram.nodeData(id)?.hook;
            if (hook) {
                this.captions.flash(hook, HOOK_CAPTION_SECONDS);
            }
        }
        this.hoveredNodes = ids;
        this.lesson.diagram.setHover(ids);
    }

    /** Without a microphone the suggested questions are the way to ask. */
    showSuggestions() {
        this.menu.setSuggestionsVisible(true);
    }

    #pressControl(control) {
        if (control === XrMenu.MOVE) {
            this.interaction.menu();
            return;
        }
        if (control === XrMenu.LANGUAGE) {
            this.onSwitchLanguage();
            return;
        }
        if (control === XrMenu.ODOO) {
            this.onToggleOdoo();
            return;
        }
        if (control === XrMenu.REPLAY) {
            this.onReplay();
            return;
        }
        const question = this.menu.questionFor(control);
        if (question) {
            this.onAsk(question);
        }
    }

    /** Turns `object` (a child of `parent`, inside the lesson) to face the user, upright. */
    #faceViewer(object, parent) {
        if (!this.hasHead) {
            return;
        }
        const position = parent.getWorldPosition(tmpVector);
        const worldYaw = Math.atan2(this.head.x - position.x, this.head.z - position.z);
        object.rotation.set(0, worldYaw - this.lesson.group.rotation.y, 0);
    }

    #findInput(sourceId) {
        return this.inputs.find((input) => input.id === sourceId);
    }

    #place(sourceId) {
        const hit = this.#findInput(sourceId)?.hit;
        if (!hit) {
            return;
        }
        const { position, yaw, layout } = placementFor(hit.position, this.head);
        this.lesson.placeAt(position, yaw, layout);
        this.lesson.group.visible = true;
    }

    #startGrab(sourceId) {
        const input = this.#findInput(sourceId);
        if (!input) {
            return;
        }
        this.raycaster.setFromXRController(input.controller);
        const hit = this.raycaster.intersectObject(this.lesson.handleHitArea, false)[0];
        if (!hit) {
            return;
        }
        const board = this.lesson.board.getWorldPosition(new THREE.Vector3());
        this.grab = { input, distance: hit.distance, offset: board.sub(hit.point) };
    }

    /** The board follows the ray at the grab distance, upright and turned to the viewer. */
    #updateGrab(dt) {
        if (!this.grab) {
            return;
        }
        const { input, distance, offset } = this.grab;
        this.raycaster.setFromXRController(input.controller);
        const target = this.raycaster.ray.at(distance, new THREE.Vector3()).add(offset);
        const worldYaw = Math.atan2(this.head.x - target.x, this.head.z - target.z);
        const local = this.lesson.group.worldToLocal(target);
        const board = this.lesson.board;
        board.position.lerp(local, 1 - Math.exp(-dt / GRAB_FOLLOW_SECONDS));
        board.rotation.set(0, worldYaw - this.lesson.group.rotation.y, 0);
    }

    /** Before the lesson is placed, in front of the user; then under the diagram. */
    #placeCaptions() {
        const captions = this.captions.group;
        if (!this.interaction.placed) {
            if (this.hintPlaced || !this.hasHead) {
                return;
            }
            const forward = tmpVector.copy(this.headForward).setY(0);
            if (forward.lengthSq() < 1e-6) {
                forward.set(0, 0, -1);
            }
            forward.normalize();
            captions.position.copy(this.head).addScaledVector(forward, HINT_DISTANCE);
            captions.position.y -= HINT_DROP;
            captions.scale.setScalar(1);
            this.hintPlaced = true;
            return;
        }
        const handle = this.lesson.handle;
        handle.getWorldPosition(captions.position);
        const scale = this.lesson.board.getWorldScale(tmpScale).x;
        captions.position.y -= 0.06 * scale;
        captions.scale.setScalar(scale);
    }

    #pulse(input, intensity, milliseconds) {
        try {
            input.source?.gamepad?.hapticActuators?.[0]?.pulse?.(intensity, milliseconds);
        } catch {
            // Haptics are a nicety; hands have none.
        }
    }

    #onEnd() {
        this.interaction.reset();
        for (const input of this.inputs) {
            this.#disconnect(input);
        }
        this.session = null;
        this.grab = null;
        this.#hoverNodes(new Set());
        this.stage.setXrPresenting(false);
        this.lesson.setHandleVisible(false);
        this.menu.group.visible = false;
        this.captions.group.visible = false;
        this.onSessionChange(false);
    }
}
