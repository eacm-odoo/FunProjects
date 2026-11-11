/**
 * The mouse (or a tap) on the desktop view's canvas: a node of a finished
 * diagram, or a label of the path above it, lights up under the pointer and a
 * click picks it. Dragging a node moves it: it stays where it is dropped.
 *
 * Dragging anywhere else orbits the camera (OrbitControls), so only a press
 * that ends where it started counts as a click, and a press on a node turns
 * the orbit off until it is released.
 */

import * as THREE from "three";

import { crumbTurn } from "../diagram/diagram_view.js";

/** Further than this between press and release, in CSS pixels, is a drag. */
const CLICK_SLOP_PX = 6;

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {THREE.Camera} options.camera
 * @param {import("../diagram/diagram_view.js").DiagramView} options.diagram
 * @param {{enabled: boolean}} [options.controls] the camera's orbit, off while a node is dragged
 * @param {() => boolean} [options.isActive] false while the headset draws the scene
 * @param {(id: string) => void} options.onPick a node id, or a crumbId()
 */
export function bindNodePicker({ canvas, camera, diagram, controls = null, isActive = () => true, onPick }) {
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const plane = new THREE.Plane();
    const planePoint = new THREE.Vector3();
    const planeNormal = new THREE.Vector3();
    let pressed = null;
    let hovered = null;

    function aim(event) {
        const rect = canvas.getBoundingClientRect();
        pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(pointer, camera);
    }

    function pick(event) {
        aim(event);
        return diagram.hit(raycaster)?.id ?? null;
    }

    /** Where the pointer meets the diagram's plane, in the diagram's frame; null when it misses. */
    function pointOnDiagram(event) {
        aim(event);
        diagram.group.updateWorldMatrix(true, false);
        diagram.group.getWorldPosition(planePoint);
        planeNormal.set(0, 0, 1).transformDirection(diagram.group.matrixWorld);
        plane.setFromNormalAndCoplanarPoint(planeNormal, planePoint);
        const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
        return hit ? diagram.group.worldToLocal(hit) : null;
    }

    function setHovered(id) {
        if (id === hovered) {
            return;
        }
        hovered = id;
        diagram.setHover(new Set(id ? [id] : []));
        canvas.style.cursor = id ? "pointer" : "";
    }

    function endPress() {
        if (pressed?.drag && controls) {
            controls.enabled = true;
        }
        pressed = null;
    }

    // In the capture phase, so the orbit is off before OrbitControls sees the press.
    canvas.addEventListener("pointerdown", (event) => {
        pressed = null;
        if (event.button !== 0) {
            return;
        }
        pressed = { x: event.clientX, y: event.clientY, drag: null, moved: false };
        const id = isActive() ? pick(event) : null;
        const start = id && crumbTurn(id) === null ? pointOnDiagram(event) : null;
        if (start) {
            pressed.drag = { id, offset: diagram.nodePosition(id).sub(start) };
            if (controls) {
                controls.enabled = false;
            }
            canvas.setPointerCapture?.(event.pointerId);
        }
    }, { capture: true });

    canvas.addEventListener("pointermove", (event) => {
        if (pressed?.drag) {
            const far = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > CLICK_SLOP_PX;
            pressed.moved ||= far;
            const point = pressed.moved ? pointOnDiagram(event) : null;
            if (point) {
                diagram.moveNode(pressed.drag.id, point.add(pressed.drag.offset));
                canvas.style.cursor = "grabbing";
            }
            return;
        }
        // While the camera moves: no hover.
        setHovered(isActive() && !pressed && event.pointerType === "mouse" ? pick(event) : null);
    });
    canvas.addEventListener("pointerleave", () => {
        if (!pressed?.drag) {
            setHovered(null);
        }
    });
    canvas.addEventListener("pointercancel", () => endPress());
    canvas.addEventListener("pointerup", (event) => {
        const start = pressed;
        endPress();
        if (!start || !isActive()) {
            return;
        }
        if (start.drag?.moved || start.moved) {
            canvas.style.cursor = "";
            hovered = null;
            return;
        }
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX) {
            return;
        }
        const id = pick(event);
        if (id) {
            setHovered(null);
            onPick(id);
        }
    });
}
