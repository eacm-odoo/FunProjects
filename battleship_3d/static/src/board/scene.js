/** @odoo-module **/
/**
 * Pure three.js layer: owns the WebGL scene, both grids, ship meshes, pegs and
 * effects. It holds NO game rules — it renders the payload returned by
 * `battleship.game.read_state()` and reports cell picks back to the OWL component.
 */
import * as THREE from "@battleship_3d/lib/three.module";
import { OrbitControls } from "@battleship_3d/lib/OrbitControls";
import { shipMesh } from "./ships";
import { WaveField } from "./water";

export const SIZE = 10;
const GAP = 6.4;
const COLS = "ABCDEFGHIJ";
// Vertices per side of a water sheet. The height field is sampled once per
// vertex per frame, so this is the knob that decides what the sea costs.
const WATER_SEGMENTS = 48;

const MAT = {
    waterA: new THREE.MeshStandardMaterial({ name: "waterA", color: "#15384a", roughness: 0.3, metalness: 0.14 }),
    waterB: new THREE.MeshStandardMaterial({ name: "waterB", color: "#16283c", roughness: 0.3, metalness: 0.14 }),
    // Under the surface: what a wave trough opens onto.
    deepA: new THREE.MeshStandardMaterial({ name: "deepA", color: "#08202b", roughness: 0.9 }),
    deepB: new THREE.MeshStandardMaterial({ name: "deepB", color: "#0a1622", roughness: 0.9 }),
    rimA: new THREE.MeshStandardMaterial({ name: "rimA", color: "#2a2028", roughness: 0.85 }),
    rimB: new THREE.MeshStandardMaterial({ name: "rimB", color: "#16282b", roughness: 0.85 }),
    sunk: new THREE.MeshStandardMaterial({ name: "sunk", color: "#3b464e", roughness: 0.9, metalness: 0.1 }),
    ghostOk: new THREE.MeshStandardMaterial({ name: "ghostOk", color: "#714B67", transparent: true, opacity: 0.55 }),
    ghostNo: new THREE.MeshStandardMaterial({ name: "ghostNo", color: "#C4472F", transparent: true, opacity: 0.45 }),
    miss: new THREE.MeshStandardMaterial({ name: "miss", color: "#e8eef0", roughness: 0.6 }),
    hit: new THREE.MeshStandardMaterial({ name: "hit", color: "#C4472F", roughness: 0.4, emissive: "#4a140b" }),
};

const cx = (c) => -SIZE / 2 + c + 0.5;
export const coordOf = (cell) => COLS[cell % SIZE] + (Math.floor(cell / SIZE) + 1);

function textPlane(text, { width = 0.62, px = 128, font = 700, size = 72, color = "#fff", w = 128 } = {}) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = color;
    ctx.font = `${font} ${size}px Inter, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, w / 2, px / 2 + 4);
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(width, (width * px) / w),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
}

export class BattleshipScene {
    constructor(container, { onPick } = {}) {
        this.container = container;
        this.onPick = onPick || (() => {});
        this.effects = [];
        this.waves = new WaveField();
        this.dir = "h";
        this.ghost = null;
        this.framed = false;

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        this.renderer.domElement.style.touchAction = "none";
        container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color("#0b1418");
        this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        Object.assign(this.controls, {
            enableDamping: true, dampingFactor: 0.08,
            minDistance: 10, maxDistance: 90, maxPolarAngle: Math.PI * 0.47,
        });

        this.scene.add(new THREE.HemisphereLight("#9fd2dd", "#10202a", 0.65));
        const key = new THREE.DirectionalLight("#fff6ec", 1.5);
        key.position.set(9, 18, 8);
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        Object.assign(key.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 60 });
        this.scene.add(key);
        const fill = new THREE.DirectionalLight("#7fb8c8", 0.35);
        fill.position.set(-10, 8, -8);
        this.scene.add(fill);

        this.boards = { a: this._board("a"), b: this._board("b") };
        this._bindPointer();

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(container);
        this.resize();

        this.last = performance.now();
        this.renderer.setAnimationLoop(() => this._tick());
    }

    destroy() {
        this.resizeObserver.disconnect();
        this.renderer.setAnimationLoop(null);
        this.controls.dispose();
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }

    _board(side) {
        const group = new THREE.Group();
        group.name = "board_" + side;
        const S = SIZE;

        const base = new THREE.Mesh(new THREE.BoxGeometry(S + 1.2, 0.5, S + 1.2), side === "a" ? MAT.rimA : MAT.rimB);
        base.position.y = -0.36;
        base.receiveShadow = true;
        base.name = "base";
        group.add(base);

        // Something has to be under the surface once it starts moving, or a
        // trough shows the frame's background through the sea.
        const deep = new THREE.Mesh(new THREE.BoxGeometry(S, 0.3, S), side === "a" ? MAT.deepA : MAT.deepB);
        deep.position.y = -0.22;
        deep.name = "deep";
        group.add(deep);

        // The surface is a plane the wave field deforms every frame; it keeps
        // its flat vertices so the deformation is always applied to the rest
        // shape and never accumulates.
        const waterGeo = new THREE.PlaneGeometry(S, S, WATER_SEGMENTS, WATER_SEGMENTS);
        waterGeo.rotateX(-Math.PI / 2);
        const water = new THREE.Mesh(waterGeo, side === "a" ? MAT.waterA : MAT.waterB);
        water.receiveShadow = true;
        water.name = "water";
        water.userData.base = Float32Array.from(waterGeo.attributes.position.array);
        group.add(water);

        const pts = [];
        for (let i = 0; i <= S; i++) {
            const p = -S / 2 + i;
            pts.push(p, 0.075, -S / 2, p, 0.075, S / 2, -S / 2, 0.075, p, S / 2, 0.075, p);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: "#7fa8b4", transparent: true, opacity: 0.3 })));

        for (let i = 0; i < S; i++) {
            const col = textPlane(COLS[i], { color: "rgba(244,241,243,.55)" });
            col.position.set(-S / 2 + i + 0.5, 0.02, -S / 2 - 0.62);
            group.add(col);
            const row = textPlane(String(i + 1), { color: "rgba(244,241,243,.55)", size: 66 });
            row.position.set(-S / 2 - 0.62, 0.02, -S / 2 + i + 0.5);
            group.add(row);
        }

        const pick = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshBasicMaterial({ visible: false }));
        pick.rotation.x = -Math.PI / 2;
        pick.position.y = 0.03;
        pick.name = "pick";
        pick.userData.side = side;
        group.add(pick);

        group.position.x = side === "a" ? -(S / 2 + GAP / 2) : S / 2 + GAP / 2;
        this.scene.add(group);
        // `ships` is what the swell moves each frame: pegs and effects stay put.
        return { side, group, pick, water, ships: [] };
    }

    setTitle(side, text, color) {
        const board = this.boards[side];
        if (board.title) {
            board.group.remove(board.title);
        }
        board.title = textPlane(text, { width: 6.4, w: 1024, px: 128, font: 800, size: 70, color });
        board.title.position.set(0, 0.02, SIZE / 2 + 1);
        board.group.add(board.title);
    }

    /** Rebuild ships + pegs from a read_state() payload. */
    render(state) {
        this.state = state;
        for (const side of ["a", "b"]) {
            const board = this.boards[side];
            [...board.group.children].forEach((child) => {
                if (child.userData.dynamic) {
                    board.group.remove(child);
                }
            });
            board.ships = [];
            for (const ship of state["fleet_" + side]) {
                if (!ship.cells.length) {
                    continue;
                }
                const mesh = shipMesh(ship);
                mesh.userData.dynamic = true;
                const first = Math.min(...ship.cells);
                const horizontal = ship.cells.length < 2 || ship.cells[1] - ship.cells[0] === 1;
                mesh.position.set(
                    cx(first % SIZE) + (horizontal ? (ship.size - 1) / 2 : 0),
                    0,
                    cx(Math.floor(first / SIZE)) + (horizontal ? 0 : (ship.size - 1) / 2)
                );
                mesh.rotation.y = horizontal ? 0 : Math.PI / 2;
                if (ship.sunk) {
                    mesh.traverse((o) => {
                        if (o.isMesh) {
                            o.material = MAT.sunk;
                        }
                    });
                    // A wreck keeps riding the swell, only lower and listing:
                    // both are read back by the float step every frame.
                    mesh.userData.draft = -0.1;
                    mesh.userData.list = 0.13;
                }
                board.group.add(mesh);
                board.ships.push(mesh);
            }
            const hitCells = new Set(state["fleet_" + side].flatMap((s) => s.cells));
            for (const cell of state["shots_" + side]) {
                this.peg(side, cell, hitCells.has(cell) || this._isHit(state, side, cell));
            }
        }
        // The grids keep their place (A left, B right) whichever seat we hold:
        // only the plate over them says which one is ours.
        const title = (side) => {
            if (state.mode === "cpu") {
                return side === "a" ? "YOUR FLEET" : "ENEMY";
            }
            if (state.mode === "online") {
                return side === state.you ? "YOUR WATERS" : "ENEMY";
            }
            return side === "a" ? "PLAYER 1" : "PLAYER 2";
        };
        this.setTitle("a", title("a"), "#b98fad");
        this.setTitle("b", title("b"), "#63c6cb");
    }

    _isHit(state, side, cell) {
        return (state.log || []).some(
            (entry) => entry.result !== "miss" && entry.coord === coordOf(cell) &&
                entry.shooter !== side
        );
    }

    peg(side, cell, isHit, animate = false) {
        const mesh = isHit
            ? new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.5, 18), MAT.hit)
            : new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 14), MAT.miss);
        mesh.position.set(cx(cell % SIZE), isHit ? 0.55 : 0.1, cx(Math.floor(cell / SIZE)));
        mesh.name = isHit ? "hit_peg" : "miss_peg";
        mesh.castShadow = true;
        mesh.userData.dynamic = true;
        this.boards[side].group.add(mesh);
        if (animate) {
            mesh.scale.setScalar(0.01);
            const t0 = performance.now();
            const grow = () => {
                const t = Math.min(1, (performance.now() - t0) / 280);
                mesh.scale.setScalar(0.01 + (1 - (1 - t) ** 3) * 0.99);
                if (t < 1) {
                    requestAnimationFrame(grow);
                }
            };
            grow();
        }
    }

    splash(side, cell, isHit) {
        const board = this.boards[side];
        if (!isHit) {
            const ring = new THREE.Mesh(
                new THREE.RingGeometry(0.12, 0.2, 32),
                new THREE.MeshBasicMaterial({ color: "#cfe6ec", transparent: true, side: THREE.DoubleSide })
            );
            ring.rotation.x = -Math.PI / 2;
            ring.position.set(cx(cell % SIZE), 0.06, cx(Math.floor(cell / SIZE)));
            ring.userData.dynamic = true;
            board.group.add(ring);
            // The drawn ring is the foam; this is the water under it moving.
            this.waves.splash(side, ring.position.x, ring.position.z, 0.07);
            this.effects.push({ mesh: ring, t0: performance.now(), dur: 700, kind: "ripple", board });
            return;
        }
        const burst = new THREE.Group();
        burst.userData.dynamic = true;
        for (let i = 0; i < 10; i++) {
            const p = new THREE.Mesh(
                new THREE.SphereGeometry(0.07, 8, 6),
                new THREE.MeshBasicMaterial({ color: i % 3 ? "#ffb46b" : "#C4472F", transparent: true })
            );
            const a = Math.random() * Math.PI * 2;
            const sp = 0.5 + Math.random() * 0.9;
            p.userData.v = new THREE.Vector3(Math.cos(a) * sp, 1.4 + Math.random() * 1.4, Math.sin(a) * sp);
            burst.add(p);
        }
        burst.position.set(cx(cell % SIZE), 0.4, cx(Math.floor(cell / SIZE)));
        board.group.add(burst);
        this.waves.splash(side, burst.position.x, burst.position.z, 0.13);
        this.effects.push({ mesh: burst, t0: performance.now(), dur: 900, kind: "blast", board });
    }

    /**
     * Preview of the selected ship where the pointer is.
     *
     * The ghost is the real model of that class, so what you line up is what
     * you get. Its cell is remembered: rotating with R redraws it in place
     * instead of waiting for the pointer to move again.
     */
    showGhost(side, cell, ship, valid) {
        this.clearGhost();
        const size = typeof ship === "number" ? ship : ship.size;
        const mesh = shipMesh(ship);
        mesh.traverse((o) => {
            if (o.isMesh) {
                o.material = valid ? MAT.ghostOk : MAT.ghostNo;
                o.castShadow = false;
            }
        });
        mesh.userData.dynamic = true;
        const horizontal = this.dir === "h";
        mesh.position.set(
            cx(cell % SIZE) + (horizontal ? (size - 1) / 2 : 0),
            0,
            cx(Math.floor(cell / SIZE)) + (horizontal ? 0 : (size - 1) / 2)
        );
        mesh.rotation.y = horizontal ? 0 : Math.PI / 2;
        this.boards[side].group.add(mesh);
        this.ghost = { side, cell, ship, valid, mesh };
    }

    /** Draw the ghost again where it already is (after a rotation). */
    redrawGhost() {
        if (this.ghost) {
            const { side, cell, ship, valid } = this.ghost;
            this.showGhost(side, cell, ship, valid);
        }
    }

    clearGhost() {
        if (this.ghost) {
            this.boards[this.ghost.side].group.remove(this.ghost.mesh);
            this.ghost = null;
        }
    }

    _bindPointer() {
        const ray = new THREE.Raycaster();
        const ptr = new THREE.Vector2();
        const canvas = this.renderer.domElement;
        const at = (ev) => {
            const rect = canvas.getBoundingClientRect();
            ptr.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
            ptr.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
            ray.setFromCamera(ptr, this.camera);
            const hits = ray.intersectObjects([this.boards.a.pick, this.boards.b.pick], false);
            if (!hits.length) {
                return null;
            }
            const side = hits[0].object.userData.side;
            const p = this.boards[side].group.worldToLocal(hits[0].point.clone());
            const c = Math.floor(p.x + SIZE / 2);
            const r = Math.floor(p.z + SIZE / 2);
            if (c < 0 || c >= SIZE || r < 0 || r >= SIZE) {
                return null;
            }
            return { side, cell: r * SIZE + c };
        };
        canvas.addEventListener("pointermove", (ev) => this.onPick(at(ev), "move"));
        let down = null;
        canvas.addEventListener("pointerdown", (ev) => (down = { x: ev.clientX, y: ev.clientY }));
        canvas.addEventListener("pointerup", (ev) => {
            if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) {
                down = null;
                return;
            }
            down = null;
            this.onPick(at(ev), "click");
        });
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
        this.fit();
    }

    /** Frame both grids inside whatever band the layout leaves for the canvas. */
    fit() {
        const box = new THREE.Box3(
            new THREE.Vector3(-(SIZE + GAP / 2 + 1.4), -0.4, -(SIZE / 2 + 1.4)),
            new THREE.Vector3(SIZE + GAP / 2 + 1.4, 1.2, SIZE / 2 + 1.9)
        );
        const center = box.getCenter(new THREE.Vector3());
        const corners = [];
        for (const x of [box.min.x, box.max.x]) {
            for (const y of [box.min.y, box.max.y]) {
                for (const z of [box.min.z, box.max.z]) {
                    corners.push(new THREE.Vector3(x, y, z));
                }
            }
        }
        const dir = this.framed
            ? this.camera.position.clone().sub(this.controls.target).normalize()
            : new THREE.Vector3(0, 0.8, 0.62).normalize();
        this.controls.target.copy(center);
        let dist = 30;
        for (let i = 0; i < 5; i++) {
            this.camera.position.copy(center).addScaledVector(dir, dist);
            this.camera.lookAt(center);
            this.camera.updateMatrixWorld(true);
            this.camera.updateProjectionMatrix();
            let m = 0;
            for (const p of corners) {
                const q = p.clone().project(this.camera);
                m = Math.max(m, Math.abs(q.x), Math.abs(q.y));
            }
            dist *= m / 0.94;
        }
        this.camera.position.copy(center).addScaledVector(dir, dist);
        this.camera.lookAt(center);
        this.controls.update();
        this.framed = true;
    }

    _tick() {
        const now = performance.now();
        const dt = Math.min(0.05, (now - this.last) / 1000);
        this.last = now;
        this.waves.advance(dt);
        for (const side of ["a", "b"]) {
            const board = this.boards[side];
            this.waves.shape(side, board.water);
            for (const ship of board.ships) {
                this.waves.float(side, ship);
            }
            if (this.ghost?.side === side) {
                this.waves.float(side, this.ghost.mesh);
            }
        }
        for (let i = this.effects.length - 1; i >= 0; i--) {
            const e = this.effects[i];
            const k = (now - e.t0) / e.dur;
            if (k >= 1) {
                e.board.group.remove(e.mesh);
                this.effects.splice(i, 1);
                continue;
            }
            if (e.kind === "ripple") {
                e.mesh.scale.setScalar(1 + k * 7);
                e.mesh.material.opacity = 0.8 * (1 - k);
            } else {
                e.mesh.children.forEach((p) => {
                    p.position.addScaledVector(p.userData.v, dt);
                    p.userData.v.y -= 5.5 * dt;
                    p.material.opacity = 1 - k;
                });
            }
        }
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}
