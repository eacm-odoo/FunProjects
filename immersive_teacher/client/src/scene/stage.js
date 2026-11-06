/**
 * Renderer, camera, lights and the frame loop, for the desktop view and the
 * headset.
 *
 * World units are meters with the floor at y = 0, the same as a WebXR
 * local-floor space, so what is placed here keeps its size in the headset.
 * In the headset the background and the grid go away (the room shows through)
 * and three.js drives the camera from the head pose.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export class Stage {
    /** @param {HTMLElement} container */
    constructor(container) {
        this.container = container;
        // alpha: the headset's passthrough shows wherever nothing is drawn.
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.xr.enabled = true;
        container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.background = new THREE.Color(0x101318);
        this.scene.background = this.background;

        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50);
        this.camera.position.set(0, 1.6, 2.5);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 1.2, 0);
        this.controls.enableDamping = true;
        this.controls.minDistance = 0.5;
        this.controls.maxDistance = 5;

        this.scene.add(new THREE.HemisphereLight(0xFFFFFF, 0x2A3440, 1.8));
        const sun = new THREE.DirectionalLight(0xFFFFFF, 1.8);
        sun.position.set(1.2, 3, 2);
        this.scene.add(sun);
        this.grid = new THREE.GridHelper(6, 24, 0x2A3240, 0x1B2028);
        this.scene.add(this.grid);

        /** @type {Set<(dt: number, frame?: XRFrame) => void>} */
        this.updaters = new Set();
        this.timer = new THREE.Timer();
        new ResizeObserver(() => this.#resize()).observe(container);
        this.#resize();
        this.renderer.setAnimationLoop((time, frame) => this.#frame(time, frame));
    }

    /** Switches between the desktop look and the headset's passthrough. */
    setXrPresenting(presenting) {
        this.scene.background = presenting ? null : this.background;
        this.grid.visible = !presenting;
        this.controls.enabled = !presenting;
        if (presenting) {
            // three.js moves this camera with the head (and changes its field
            // of view), so the desktop view is put back when the session ends.
            this.savedView = {
                position: this.camera.position.clone(),
                target: this.controls.target.clone(),
                fov: this.camera.fov,
            };
        } else if (this.savedView) {
            const { position, target, fov } = this.savedView;
            this.camera.quaternion.identity();
            this.camera.fov = fov;
            this.camera.zoom = 1;
            this.camera.updateProjectionMatrix();
            this.frame(target.toArray(), position.toArray());
            this.savedView = null;
            // three.js puts the canvas size back once the session is over (just
            // after this); the page layout may have changed meanwhile.
            setTimeout(() => this.#resize(), 0);
        }
    }

    add(object) {
        this.scene.add(object);
    }

    /** Points the camera at `target` from `position` (both [x, y, z], meters). */
    frame(target, position) {
        this.controls.target.set(...target);
        this.camera.position.set(...position);
        this.controls.update();
    }

    /** Calls `fn(dt, xrFrame)` every frame, before rendering. Returns a remover. */
    onUpdate(fn) {
        this.updaters.add(fn);
        return () => this.updaters.delete(fn);
    }

    #resize() {
        const { clientWidth: width, clientHeight: height } = this.container;
        // In a session the headset sets the size; the page may still reflow.
        if (!width || !height || this.renderer.xr.isPresenting) {
            return;
        }
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    #frame(time, frame) {
        this.timer.update(time);
        // Clamp: after a hidden tab, one giant step would skip every animation.
        const dt = Math.min(this.timer.getDelta(), 0.1);
        for (const update of this.updaters) {
            update(dt, frame);
        }
        if (!this.renderer.xr.isPresenting) {
            this.controls.update();
        }
        this.renderer.render(this.scene, this.camera);
    }
}
