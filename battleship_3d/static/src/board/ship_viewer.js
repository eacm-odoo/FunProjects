/** @odoo-module **/
/**
 * The turntable behind the glossary: one ship, alone on a patch of sea.
 *
 * A second, much smaller scene than the board's — it lights and floats the
 * model exactly the same way, so what the glossary shows is what you will be
 * looking at while you play, not an illustration of it. One renderer for the
 * whole panel: five live canvases would be five WebGL contexts on a page that
 * already has one.
 */
import * as THREE from "@battleship_3d/lib/three.module";
import { OrbitControls } from "@battleship_3d/lib/OrbitControls";
import { shipMesh } from "./ships";
import { WaterSurface } from "./water";

// Sea under the model, in board cells.
const PATCH = 8;
const PATCH_SEGMENTS = 120;

export class ShipViewer {
    constructor(container) {
        this.container = container;
        this.ship = null;

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        this.renderer.domElement.style.touchAction = "none";
        container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color("#0a161c");
        this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        Object.assign(this.controls, {
            enableDamping: true, dampingFactor: 0.08, enablePan: false,
            minDistance: 3, maxDistance: 26, maxPolarAngle: Math.PI * 0.49,
            autoRotate: true, autoRotateSpeed: 1.1,
        });

        // Same three lights as the board, at the same angles.
        this.scene.add(new THREE.HemisphereLight("#9fd2dd", "#10202a", 0.65));
        const key = new THREE.DirectionalLight("#fff6ec", 1.5);
        key.position.set(6, 12, 5);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 40 });
        this.scene.add(key);
        const fill = new THREE.DirectionalLight("#7fb8c8", 0.35);
        fill.position.set(-7, 6, -6);
        this.scene.add(fill);

        this.scene.add(this._sea());

        // The turntable is a parent group: spinning the ship itself would move
        // the heading the swell is sampled along, and it would pitch sideways.
        this.pivot = new THREE.Group();
        this.scene.add(this.pivot);

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(container);
        this.resize();

        this.last = performance.now();
        this.renderer.setAnimationLoop(() => this._tick());
    }

    /** The same sea as the board, in a smaller well and without the grid. */
    _sea() {
        const group = new THREE.Group();
        const floor = new THREE.Mesh(
            new THREE.BoxGeometry(PATCH, 0.6, PATCH),
            new THREE.MeshStandardMaterial({ color: "#0b2434", roughness: 0.95 })
        );
        floor.position.y = -0.72;
        group.add(floor);

        this.water = new WaterSurface({ size: PATCH, segments: PATCH_SEGMENTS, light: [6, 12, 5] });
        this.water.uniforms.uGrid.value = 0;
        group.add(this.water.mesh);
        return group;
    }

    /** Put a class on the turntable, framed for its length. */
    show(entry) {
        this.clear();
        this.ship = shipMesh(entry);
        this.pivot.add(this.ship);

        const distance = entry.size * 1.5 + 3.2;
        this.camera.position.set(distance * 0.62, distance * 0.42, distance * 0.66);
        this.controls.target.set(0, 0.2, 0);
        this.controls.update();
    }

    clear() {
        if (!this.ship) {
            return;
        }
        this.pivot.remove(this.ship);
        // Materials are shared by the whole fleet — only the geometry built for
        // this hull goes with it.
        this.ship.traverse((o) => o.geometry?.dispose());
        this.ship = null;
    }

    resize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (!w || !h) {
            return;
        }
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    destroy() {
        this.resizeObserver.disconnect();
        this.renderer.setAnimationLoop(null);
        this.clear();
        this.water.dispose();
        this.controls.dispose();
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }

    _tick() {
        const now = performance.now();
        const dt = Math.min(0.05, (now - this.last) / 1000);
        this.last = now;
        this.water.advance(dt, this.camera);
        if (this.ship) {
            this.water.float(this.ship);
        }
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}
