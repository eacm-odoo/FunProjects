/**
 * The mouse (or a tap) on the desktop view's canvas: a node of a finished
 * diagram, or the "‹ parent" label, lights up under the pointer and a click
 * picks it.
 *
 * Dragging orbits the camera (OrbitControls), so only a press that ends
 * where it started counts as a click.
 */

import * as THREE from "three";

/** Further than this between press and release, in CSS pixels, is a drag. */
const CLICK_SLOP_PX = 6;

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {THREE.Camera} options.camera
 * @param {import("../diagram/diagram_view.js").DiagramView} options.diagram
 * @param {() => boolean} [options.isActive] false while the headset draws the scene
 * @param {(id: string) => void} options.onPick a node id, or BACK_ID
 */
export function bindNodePicker({ canvas, camera, diagram, isActive = () => true, onPick }) {
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pressed = null;
    let hovered = null;

    function pick(event) {
        const rect = canvas.getBoundingClientRect();
        pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(pointer, camera);
        return diagram.hit(raycaster)?.id ?? null;
    }

    function setHovered(id) {
        if (id === hovered) {
            return;
        }
        hovered = id;
        diagram.setHover(new Set(id ? [id] : []));
        canvas.style.cursor = id ? "pointer" : "";
    }

    canvas.addEventListener("pointermove", (event) => {
        // While dragging, the camera moves: no hover.
        setHovered(isActive() && !pressed && event.pointerType === "mouse" ? pick(event) : null);
    });
    canvas.addEventListener("pointerleave", () => setHovered(null));
    canvas.addEventListener("pointerdown", (event) => {
        pressed = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    });
    canvas.addEventListener("pointerup", (event) => {
        const start = pressed;
        pressed = null;
        if (!start || !isActive() || Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX) {
            return;
        }
        const id = pick(event);
        if (id) {
            setHovered(null);
            onPick(id);
        }
    });
}
