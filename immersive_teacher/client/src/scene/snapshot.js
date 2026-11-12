/**
 * The picture of a shared exploration, for the link's preview card (see the
 * server's share_page.js): the teacher, from the waist up, pointing at the
 * diagram the link opens at. 1200 x 630 like LinkedIn's cards, as a JPEG.
 *
 * It is drawn apart from what is on screen, with a teacher and a diagram of
 * its own (every node grown, each one where the user left it), through the
 * page's renderer and in one go: the screen does not change. That teacher
 * and diagram are made once and kept for the next picture.
 */

import * as THREE from "three";

import { DiagramView } from "../diagram/diagram_view.js";
import { Teacher } from "../teacher/teacher.js";
import { Lesson } from "./lesson.js";

export const SNAPSHOT_WIDTH = 1200;
export const SNAPSHOT_HEIGHT = 630;
/** Drawn this many times larger, then scaled down: sharper labels and edges. */
const SUPERSAMPLE = 2;
const JPEG_QUALITY = 0.86;
const FOV_DEGREES = 30;
/** Room around what is framed. */
const MARGIN = 1.08;
/** Long enough for every node, arrow and badge to finish appearing. */
const SETTLE_SECONDS = 2.5;
/** The arm is up and the head back on the viewer by then (see Teacher.glanceAt). */
const POINT_SECONDS = 1.5;
const STEP_SECONDS = 1 / 30;
/** The part of the teacher in the picture, in the lesson's frame (meters): head, arms and the chest. */
const TEACHER_FRAME = Object.freeze({ minX: -0.34, maxX: 0.34, minY: 0.78, maxY: 1.55 });
const CAPTION_FONT = "600 26px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const CAPTION_COLOR = "rgba(232, 237, 242, 0.78)";

export class Snapshot {
    /**
     * @param {THREE.WebGLRenderer} renderer the page's
     * @param {THREE.Color} background the desktop view's
     */
    constructor(renderer, background) {
        this.renderer = renderer;
        this.background = background;
        this.studio = null;
    }

    #studio() {
        if (!this.studio) {
            const scene = new THREE.Scene();
            scene.background = this.background;
            scene.add(new THREE.HemisphereLight(0xFFFFFF, 0x2A3440, 1.8));
            const sun = new THREE.DirectionalLight(0xFFFFFF, 1.8);
            sun.position.set(1.2, 3, 2);
            scene.add(sun);
            // Its blink never comes in the second and a half it lives.
            const teacher = new Teacher({ random: () => 0.5 });
            const diagram = new DiagramView();
            const lesson = new Lesson(teacher, diagram);
            lesson.setHandleVisible(false);
            scene.add(lesson.group);
            const camera = new THREE.PerspectiveCamera(FOV_DEGREES, SNAPSHOT_WIDTH / SNAPSHOT_HEIGHT, 0.05, 20);
            this.studio = { scene, teacher, diagram, lesson, camera };
        }
        return this.studio;
    }

    /**
     * @param {object} diagram as the server sent it
     * @param {{path?: object[], hooks?: string[], explored?: Iterable<string>, pins?: Map<string, object>}} [marks]
     *        as on screen (see DiagramView.show)
     * @param {string} [caption] written small in a corner: the app's name
     * @returns {string|null} the JPEG in base64; null in the headset, where the renderer is the session's
     */
    take(diagram, { path = [], hooks = [], explored = [], pins = new Map() } = {}, caption = "") {
        if (this.renderer.xr.isPresenting) {
            return null;
        }
        const { scene, teacher, diagram: view, lesson, camera } = this.#studio();
        view.clear();
        view.show(diagram, { path, hooks, explored: [...explored], pins });
        for (let time = 0; time < SETTLE_SECONDS; time += STEP_SECONDS) {
            view.update(STEP_SECONDS);
            lesson.update(STEP_SECONDS);
        }
        scene.updateMatrixWorld(true);

        // The whole diagram and the teacher's upper half, seen from the front.
        const board = new THREE.Box3().setFromObject(view.group);
        const framed = board.clone().union(new THREE.Box3(
            new THREE.Vector3(TEACHER_FRAME.minX, TEACHER_FRAME.minY, 0),
            new THREE.Vector3(TEACHER_FRAME.maxX, TEACHER_FRAME.maxY, 0),
        ));
        const center = framed.getCenter(new THREE.Vector3());
        const size = framed.getSize(new THREE.Vector3());
        const tan = Math.tan(THREE.MathUtils.degToRad(FOV_DEGREES / 2));
        const distance = Math.max(size.y / 2 / tan, size.x / 2 / (tan * camera.aspect)) * MARGIN + size.z / 2;
        camera.position.set(center.x, center.y, center.z + distance);
        camera.lookAt(center);
        camera.updateMatrixWorld();

        teacher.glanceAt(board.getCenter(new THREE.Vector3()));
        for (let time = 0; time < POINT_SECONDS; time += STEP_SECONDS) {
            teacher.update(STEP_SECONDS, { viewer: camera.position });
        }
        return this.#render(scene, camera, caption);
    }

    /** One frame at the picture's size on the page's canvas, copied out before the screen ever shows it. */
    #render(scene, camera, caption) {
        const { renderer } = this;
        const size = renderer.getSize(new THREE.Vector2());
        const pixelRatio = renderer.getPixelRatio();
        const target = renderer.getRenderTarget();
        const canvas = document.createElement("canvas");
        canvas.width = SNAPSHOT_WIDTH;
        canvas.height = SNAPSHOT_HEIGHT;
        const context = canvas.getContext("2d");
        try {
            renderer.setRenderTarget(null);
            renderer.setPixelRatio(1);
            renderer.setSize(SNAPSHOT_WIDTH * SUPERSAMPLE, SNAPSHOT_HEIGHT * SUPERSAMPLE, false);
            renderer.render(scene, camera);
            context.imageSmoothingQuality = "high";
            context.drawImage(renderer.domElement, 0, 0, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);
        } finally {
            renderer.setPixelRatio(pixelRatio);
            renderer.setSize(size.x, size.y, false);
            renderer.setRenderTarget(target);
        }
        if (caption) {
            // Bottom right: under the diagram, where nothing is drawn.
            context.font = CAPTION_FONT;
            context.fillStyle = CAPTION_COLOR;
            context.textAlign = "right";
            context.textBaseline = "bottom";
            context.fillText(caption, SNAPSHOT_WIDTH - 36, SNAPSHOT_HEIGHT - 28);
        }
        return canvas.toDataURL("image/jpeg", JPEG_QUALITY).split(",")[1] ?? null;
    }
}
