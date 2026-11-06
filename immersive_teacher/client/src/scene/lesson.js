/**
 * The teacher and its diagram as one group. The group's origin is the
 * teacher's feet, so placing the lesson means putting that point on a surface
 * (the desktop view does it once; the headset does it with a hit-test).
 *
 * The diagram hangs on a "board": the diagram itself plus a bar under it that
 * can be grabbed in the headset to carry the diagram somewhere else.
 *
 * Two layouts:
 *   floor  a teacher about 1.45 m tall, the diagram at reading height (1.4 m)
 *   desk   a small teacher on the table, and a diagram larger than the
 *          teacher's scale would give, about 0.35 m over the table, so the
 *          labels can still be read from a chair
 */

import * as THREE from "three";

/** Height of the diagram's center: comfortable to read standing in front of it. */
export const READING_HEIGHT = 1.4;
/** From the teacher's center to the diagram's, to its left (the viewer's right). */
export const DIAGRAM_OFFSET_X = 0.95;

export const LESSON_LAYOUTS = Object.freeze({
    floor: Object.freeze({ scale: 1, board: [DIAGRAM_OFFSET_X, READING_HEIGHT, 0], boardScale: 1 }),
    // World sizes on a desk: teacher 0.5 m, diagram center 0.5 m to its side
    // and 0.35 m over the table, diagram at 0.56 of its full size.
    desk: Object.freeze({ scale: 0.35, board: [1.45, 1.0, 0], boardScale: 1.6 }),
});

/** Gap between the lowest node and the handle, in board meters. */
const HANDLE_GAP = 0.13;
const HANDLE_MOVE_SECONDS = 0.3;

function approach(current, target, seconds, dt) {
    return current + (target - current) * (1 - Math.exp(-dt / seconds));
}

export class Lesson {
    /**
     * @param {import("../teacher/teacher.js").Teacher} teacher
     * @param {import("../diagram/diagram_view.js").DiagramView} diagram
     */
    constructor(teacher, diagram) {
        this.teacher = teacher;
        this.diagram = diagram;
        this.group = new THREE.Group();
        this.group.name = "lesson";
        this.board = new THREE.Group();
        this.board.name = "board";
        this.board.add(diagram.group);
        this.#buildHandle();
        this.group.add(teacher.group, this.board);
        this.layout = "floor";
        this.applyLayout("floor");
    }

    /** Puts the lesson on a surface point, turned by `yaw` (radians) around the vertical. */
    placeAt(position, yaw, layout) {
        this.group.position.set(position.x, position.y, position.z);
        this.group.rotation.set(0, yaw, 0);
        this.applyLayout(layout);
    }

    /** Sizes the lesson for the floor or a desk, and puts the board back next to the teacher. */
    applyLayout(layout) {
        const spec = LESSON_LAYOUTS[layout];
        if (!spec) {
            throw new Error(`Unknown lesson layout: ${layout}`);
        }
        this.layout = layout;
        this.group.scale.setScalar(spec.scale);
        this.board.position.set(...spec.board);
        this.board.rotation.set(0, 0, 0);
        this.board.scale.setScalar(spec.boardScale);
    }

    /** The bar under the diagram: only useful (and shown) in the headset. */
    setHandleVisible(visible) {
        this.handle.visible = visible;
    }

    /** Hover feedback on the bar: brighter while a ray points at it or it is held. */
    setHandleHighlight(level) {
        this.handleTarget = level;
    }

    update(dt) {
        // The handle follows the bottom of the diagram as the diagram grows.
        const bounds = this.diagram.bounds;
        const bottom = bounds ? bounds.minY - HANDLE_GAP : -0.15;
        this.handle.position.y = approach(this.handle.position.y, bottom, HANDLE_MOVE_SECONDS, dt);
        this.handleGlow = approach(this.handleGlow, this.handleTarget, 0.08, dt);
        this.handleMaterial.opacity = 0.45 + 0.5 * this.handleGlow;
        this.handleBar.scale.setScalar(1 + 0.15 * this.handleGlow);
    }

    #buildHandle() {
        this.handle = new THREE.Group();
        this.handle.name = "handle";
        this.handle.position.y = -0.15;
        this.handleMaterial = new THREE.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.45, depthWrite: false });
        this.handleBar = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.013, 0.2, 4, 12).rotateZ(Math.PI / 2),
            this.handleMaterial,
        );
        // A larger invisible box is what the rays hit: a thin bar is hard to aim at.
        this.handleHitArea = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.1, 0.1), new THREE.MeshBasicMaterial());
        this.handleHitArea.visible = false;
        this.handle.add(this.handleBar, this.handleHitArea);
        this.handle.visible = false;
        this.handleGlow = 0;
        this.handleTarget = 0;
        this.board.add(this.handle);
    }
}
