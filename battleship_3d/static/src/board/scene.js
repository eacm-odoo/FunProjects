/** @odoo-module **/
/**
 * Pure three.js layer: owns the WebGL scene, both grids, ship meshes, pegs and
 * effects. It holds NO game rules — it renders the payload returned by
 * `battleship.game.read_state()` and reports cell picks back to the OWL component.
 */
import * as THREE from "@battleship_3d/lib/three.module";
import { OrbitControls } from "@battleship_3d/lib/OrbitControls";
import { shipMesh } from "./ships";
import { WaterSurface } from "./water";

export const SIZE = 10;
// Room between two boards. Four of them on one screen have to give some of it
// back, or the table stops fitting in the band the layout leaves for it.
const GAP = 6.4;
const GAP_MANY = 3.4;
const COLS = "ABCDEFGHIJ";
// Vertices per side of a water sheet. Displaced on the GPU, so it can afford a
// density the CPU never could — but there are several of these on screen at
// once, each half the size the design prototype's single board was, hence 160
// rather than its 220: same wave detail per cell, half again the vertices. Four
// boards halve it again rather than putting four times the water on the GPU.
const WATER_SEGMENTS = 160;
const WATER_SEGMENTS_MANY = 112;
// One sea per seat, told apart by colour and by the phase of their swell: a
// player who looks up mid-game should know whose water they are looking at
// before they read the plate.
const SEA = {
    a: { deep: "#0a2233", shallow: "#1d6a7e", sky: "#a9dbe8", phase: 0 },
    b: { deep: "#0d1a24", shallow: "#31586b", sky: "#bcd3dd", phase: 1.7 },
    c: { deep: "#141c26", shallow: "#4a5a72", sky: "#cbd2e0", phase: 3.1 },
    d: { deep: "#151821", shallow: "#5c5364", sky: "#ddd0d8", phase: 4.6 },
};
// Plinth, floor and wall, per seat. Built once and shared: a board is rebuilt
// whenever the table changes shape, and these outlive that.
const HULL = {
    a: { deep: "#0b2434", wall: "#0e2c3f", rim: "#241a20" },
    b: { deep: "#0c1d29", wall: "#102532", rim: "#16282b" },
    c: { deep: "#151d28", wall: "#1a2634", rim: "#20262e" },
    d: { deep: "#171922", shallow: "#1e1f2b", wall: "#1e1f2b", rim: "#2a2028" },
};
const HULL_MAT = Object.fromEntries(
    Object.entries(HULL).map(([side, c]) => [side, {
        deep: new THREE.MeshStandardMaterial({ name: "deep" + side, color: c.deep, roughness: 0.95 }),
        wall: new THREE.MeshStandardMaterial({ name: "wall" + side, color: c.wall, roughness: 0.9, side: THREE.DoubleSide }),
        rim: new THREE.MeshStandardMaterial({ name: "rim" + side, color: c.rim, roughness: 0.82, metalness: 0.12 }),
    }])
);
// What each seat's plate is written in, matching its water.
const TITLE_COLOR = { a: "#b98fad", b: "#63c6cb", c: "#c9b98a", d: "#c7a3b3" };
// The two things a board can be waiting for on your turn: amber while the sweep
// still owes it a shell, hotter on the one whose last shell hit and bought
// another. Nothing at all once it has been dealt with, which is the point —
// what is lit is what is left.
const GLOW = { owed: "#f2c14e", again: "#ff7a45" };
// How the halo breathes: period in ms, and the opacity it swings between. The
// bought shot beats about twice as fast as the owed one, so the two read apart
// from across the table without either of them blinking.
const GLOW_BEAT = { owed: [620, 0.16, 0.46], again: [300, 0.42, 0.9] };

// What a gun going off puts in the air. Warm, short-lived and unlit: a flash
// competing with the key light reads as a grey cone instead of as fire.
const FLASH = { core: "#fff3d0", fire: "#ffb552", smoke: "#cbd5d8" };
// How long a gun takes to train round, and how long it stays out of battery.
// Both together stay under VOLLEY_STEP, so one hull firing twice in a sweep is
// back in battery before it is asked for the second shell.
const TRAVERSE = 0.42;
const RECOIL = 0.34;

const MAT = {
    sunk: new THREE.MeshStandardMaterial({ name: "sunk", color: "#3b464e", roughness: 0.9, metalness: 0.1 }),
    ghostOk: new THREE.MeshStandardMaterial({ name: "ghostOk", color: "#714B67", transparent: true, opacity: 0.55 }),
    ghostNo: new THREE.MeshStandardMaterial({ name: "ghostNo", color: "#C4472F", transparent: true, opacity: 0.45 }),
    miss: new THREE.MeshStandardMaterial({ name: "miss", color: "#eef3f5", roughness: 0.55 }),
    shell: new THREE.MeshStandardMaterial({ name: "shell", color: "#e9eef1", emissive: "#5b6a72", roughness: 0.4 }),
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
    constructor(container, { onPick, onImpact, onFire } = {}) {
        this.container = container;
        this.onPick = onPick || (() => {});
        // Called when a shell actually lands, which is where the sound of the
        // splash belongs — not a second earlier, when the gun went off.
        this.onImpact = onImpact || (() => {});
        // And called at the muzzle, which is where the report belongs.
        this.onFire = onFire || (() => {});
        this.tweens = [];
        this.shells = [];
        // Guns part-way through train → fire → recover. See `_advanceGuns`.
        this.guns = [];
        this.dir = "h";
        this.ghost = null;
        this.framed = false;

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

        // The table starts as a duel and is rebuilt the first time a payload
        // says otherwise: `_layout` is what owns how many boards there are.
        this.sides = [];
        this.boards = {};
        this._layout(["a", "b"]);
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
        this._teardown();
        this.controls.dispose();
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }

    /** Take every board off the table and give the GPU its memory back. */
    _teardown() {
        for (const side of this.sides) {
            const board = this.boards[side];
            board.water.dispose();
            // The plates hold a canvas texture each: dropping the mesh is not
            // enough, so they go out the way they came in.
            this._plate(board, "title", "", {});
            this._plate(board, "turn", "", {});
            // One material for the four bars of a halo, four geometries.
            board.halo.children.forEach((bar) => bar.geometry.dispose());
            board.haloMat.dispose();
            this.scene.remove(board.group);
        }
        this.sides = [];
        this.boards = {};
        // Every gun in the middle of a sequence belonged to a hull on a board
        // that has just gone off the table.
        this.guns = [];
    }

    /**
     * Build the table for a given set of seats.
     *
     * A duel puts two boards side by side; a free-for-all puts four in a
     * square. Changing modes is therefore not a resize — the boards are
     * different objects, with their own water — so this is the one place that
     * knows how to swap one table for another, and it does nothing at all when
     * the seats have not changed.
     */
    _layout(sides) {
        if (sides.length === this.sides.length && sides.every((s, i) => s === this.sides[i])) {
            return;
        }
        this._teardown();
        this.sides = [...sides];
        for (const side of this.sides) {
            this.boards[side] = this._board(side);
        }
        this.framed = false;
        this.fit();
    }

    /** Gap between boards, and how finely their water is cut. */
    get _gap() {
        return this.sides.length > 2 ? GAP_MANY : GAP;
    }

    /** Light up the cell under the pointer on one board, or none anywhere. */
    setHover(side, cell) {
        for (const key of this.sides) {
            this.boards[key].water.setHover(key === side ? cell : null);
        }
    }

    _board(side) {
        const group = new THREE.Group();
        group.name = "board_" + side;
        const S = SIZE;

        // The plinth is four rails and not one slab: a solid top at the rim
        // would sit in front of the troughs and cut the wave off.
        const hull = HULL_MAT[side];
        const rim = hull.rim;
        const T = 0.75;
        for (const [x, z, w, d] of [
            [0, S / 2 + T / 2, S + T * 2, T], [0, -(S / 2 + T / 2), S + T * 2, T],
            [S / 2 + T / 2, 0, T, S + T * 2], [-(S / 2 + T / 2), 0, T, S + T * 2],
        ]) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.9, d), rim);
            rail.position.set(x, -0.39, z);
            rail.castShadow = rail.receiveShadow = true;
            rail.name = "rim";
            group.add(rail);
        }

        // A halo lying along the top of those rails: four bars rather than a
        // plane, so it frames the water instead of covering it. It is dark
        // until `setGlow` gives it a colour, and `_tick` is what breathes it.
        const haloMat = new THREE.MeshBasicMaterial({
            name: "halo" + side, color: GLOW.owed, transparent: true,
            opacity: 0, depthWrite: false,
        });
        const halo = new THREE.Group();
        halo.name = "halo";
        halo.visible = false;
        for (const [x, z, w, d] of [
            [0, S / 2 + T / 2, S + T * 2, T], [0, -(S / 2 + T / 2), S + T * 2, T],
            [S / 2 + T / 2, 0, T, S + T * 2], [-(S / 2 + T / 2), 0, T, S + T * 2],
        ]) {
            // Clear of the rail top rather than flush with it: two coplanar
            // faces would fight over which of them the camera sees.
            const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, d), haloMat);
            bar.position.set(x, 0.11, z);
            halo.add(bar);
        }
        group.add(halo);

        // A well, not a sheet: a floor well below the deepest trough and four
        // walls at the rim, so a dipping wave only ever reveals more water.
        const floor = new THREE.Mesh(new THREE.BoxGeometry(S, 0.6, S), hull.deep);
        floor.position.y = -0.72;
        floor.name = "deep";
        group.add(floor);
        for (let i = 0; i < 4; i++) {
            const wall = new THREE.Mesh(new THREE.PlaneGeometry(S, 0.48), hull.wall);
            wall.position.set(
                i === 1 ? S / 2 : i === 3 ? -S / 2 : 0,
                -0.24,
                i === 0 ? S / 2 : i === 2 ? -S / 2 : 0
            );
            wall.rotation.y = (i * Math.PI) / 2;
            wall.name = "wall";
            group.add(wall);
        }

        // The surface itself: displaced and shaded on the GPU, grid included,
        // so the lines ride the swell instead of floating over it.
        const water = new WaterSurface({
            size: S,
            segments: this.sides.length > 2 ? WATER_SEGMENTS_MANY : WATER_SEGMENTS,
            ...SEA[side],
            light: [9, 18, 8],
        });
        group.add(water.mesh);

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

        // Transients live apart from the state-derived meshes: `render()` wipes
        // ships and markers on every payload, and a shell in the air or a
        // splash halfway through has nothing to do with the payload.
        const fx = new THREE.Group();
        fx.name = "fx";
        group.add(fx);

        // Two boards face each other across a gap; four sit in a square, in
        // seat order, reading left to right and then down — the same order the
        // panels under the canvas are in, so a board and its fleet are never
        // two different places on the screen.
        const step = S + this._gap;
        const index = this.sides.indexOf(side);
        const cols = this.sides.length > 2 ? 2 : this.sides.length;
        const rows = Math.ceil(this.sides.length / cols);
        group.position.set(
            ((index % cols) - (cols - 1) / 2) * step,
            0,
            (Math.floor(index / cols) - (rows - 1) / 2) * step
        );
        this.scene.add(group);
        // `ships` and `pegs` are what the swell carries each frame. `pending`
        // holds cells whose shell is still in the air: their marker is dropped
        // by the impact, not by the payload that announced the shot.
        // `glow` is which of the two halo states this board is in, or null for
        // a board with nothing to say: `_tick` reads it, nobody else does.
        return {
            side, group, fx, pick, water, halo, haloMat, glow: null,
            ships: [], pegs: [], pending: new Set(),
        };
    }

    /**
     * Write a line of text on the water in front of a board.
     *
     * Each plate is a texture of its own, so they are rebuilt only when the
     * words change: `render()` runs on every payload, and half of those say
     * nothing new about who the board belongs to or whose shot it expects.
     */
    _plate(board, slot, text, options) {
        if (board[slot]?.userData.text === text) {
            return;
        }
        if (board[slot]) {
            board.group.remove(board[slot]);
            board[slot].geometry.dispose();
            board[slot].material.map.dispose();
            board[slot].material.dispose();
            board[slot] = null;
        }
        if (!text) {
            return;
        }
        const { z, ...rest } = options;
        const mesh = textPlane(text, rest);
        mesh.userData.text = text;
        mesh.position.set(0, 0.02, z);
        board[slot] = mesh;
        board.group.add(mesh);
    }

    setTitle(side, text, color) {
        this._plate(this.boards[side], "title", text, {
            width: 6.4, w: 1024, px: 128, font: 800, size: 70, color, z: SIZE / 2 + 1,
        });
    }

    /**
     * Mark the grids the turn is waiting on, and only those.
     *
     * `marks` is a plate per side — `{ b: { text, color } }` — because a
     * free-for-all turn is owed a shell by every board still afloat and each of
     * them has its own thing to say. Sides left out of it are cleared. The
     * plates sit in front of the boards they point at and breathe (see
     * `_tick`), because a player who looks up from the fleet panel should find
     * their turn on the board itself rather than in a line of status text.
     */
    setTurn(marks) {
        for (const key of this.sides) {
            const mark = (marks || {})[key];
            this._plate(this.boards[key], "turn", mark?.text || "", {
                width: 4.2, w: 640, px: 128, font: 800, size: 66,
                color: mark?.color, z: SIZE / 2 + 2.05,
            });
        }
    }

    /**
     * Light a board up, or put it out.
     *
     * `mode` is "owed" for a board the turn has not been to yet, "again" for
     * the one a hit just bought another shell at, and null for everything else
     * — our own water, a board already dealt with, a fleet on the bottom, and
     * every board on the table while somebody else is shooting.
     */
    setGlow(side, mode) {
        const board = this.boards[side];
        board.glow = mode || null;
        board.halo.visible = !!mode;
        if (mode) {
            board.haloMat.color.set(GLOW[mode]);
        }
    }

    /** Rebuild ships + pegs from a read_state() payload. */
    render(state) {
        this.state = state;
        // How many boards there are is a property of the payload, so this is
        // the first thing that happens: everything below draws onto whatever
        // table the seats ask for.
        this._layout((state.seats || []).map((seat) => seat.side).filter(Boolean).length
            ? state.seats.map((seat) => seat.side)
            : ["a", "b"]);
        for (const side of this.sides) {
            const board = this.boards[side];
            [...board.group.children].forEach((child) => {
                if (child.userData.dynamic) {
                    board.group.remove(child);
                }
            });
            board.ships = [];
            board.pegs = [];
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
                mesh.userData.ship = ship;
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
                } else {
                    // Only a hull still afloat can answer a bearing.
                    this._rigGuns(mesh);
                }
                board.group.add(mesh);
                board.ships.push(mesh);
            }
            // Which cells took a hull comes from the payload, not from the shot
            // log: the log is a window on the last few dozen shells, and a
            // marker read out of it turned white again the moment its shot
            // scrolled off the end.
            const hitCells = new Set(state["hits_" + side] || []);
            for (const cell of state["shots_" + side]) {
                // A shell still on its way owns that cell: it drops its own
                // marker when it lands, so the payload does not get to put one
                // there half a second early.
                if (!board.pending.has(cell)) {
                    this.peg(side, cell, hitCells.has(cell));
                }
            }
        }
        // The grids keep their place whichever seat we hold: only the plate over
        // them says which one is ours. In a free-for-all it says whose the
        // others are too, because "enemy" stops being one thing.
        const seatOf = (side) => (state.seats || []).find((seat) => seat.side === side);
        const you = state.mode === "hotseat" ? state.current_player : state.you || "a";
        // A turn is a sweep — one shell at each board still afloat — and these
        // three lines are the whole of what the table says about it while it is
        // ours: which boards are still owed one, which of them the last shell
        // hit, and, by leaving them out, which are done with.
        const mine = state.state === "battle" && state.current_player === you;
        const owed = mine ? state.turn_pending || [] : [];
        const again = mine ? state.turn_again : null;
        // A board already dealt with is dimmed rather than lit, so what a player
        // has left to do is what they can see without counting pegs themselves.
        const swept = (side) => mine && side !== you && !owed.includes(side);
        const title = (side) => {
            const seat = seatOf(side);
            if (seat && seat.out) {
                return "OUT";
            }
            if (state.mode === "cpu") {
                return side === "a" ? "YOUR FLEET" : "ENEMY";
            }
            if (state.mode === "royale") {
                return side === state.you ? "YOUR WATERS" : (seat?.name || "").toUpperCase().slice(0, 14);
            }
            if (state.mode === "online") {
                return side === state.you ? "YOUR WATERS" : "ENEMY";
            }
            return side === "a" ? "PLAYER 1" : "PLAYER 2";
        };
        for (const side of this.sides) {
            const color = seatOf(side)?.out || swept(side) ? "#6b7580" : TITLE_COLOR[side];
            this.setTitle(side, title(side), color);
            this.setGlow(side, owed.includes(side) ? (side === again ? "again" : "owed") : null);
        }

        // And what the table is waiting for. On our turn that is one plate per
        // board the sweep still owes a shell to, so the boards themselves count
        // the turn down; the rest of the time it is a single plate naming the
        // gun, or our own water taking the incoming.
        if (state.state !== "battle") {
            this.setTurn(null);
        } else if (mine) {
            this.setTurn(Object.fromEntries(owed.map((side) => [
                side,
                side === again
                    ? { text: "FIRE AGAIN", color: GLOW.again }
                    : { text: "FIRE HERE", color: GLOW.owed },
            ])));
        } else if (state.mode === "royale") {
            this.setTurn({ [state.current_player]: { text: "ON THE GUN", color: "#e0805f" } });
        } else {
            this.setTurn({ [you]: { text: "INCOMING", color: "#e0805f" } });
        }
    }

    /** The marker left on a cell that has been fired at. It rides the swell. */
    peg(side, cell, isHit, grow = false) {
        const board = this.boards[side];
        const mesh = isHit
            ? new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.5, 18), MAT.hit)
            : new THREE.Mesh(new THREE.SphereGeometry(0.16, 18, 14), MAT.miss);
        mesh.position.set(cx(cell % SIZE), 0, cx(Math.floor(cell / SIZE)));
        mesh.userData.rest = isHit ? 0.5 : 0.08;
        mesh.name = isHit ? "hit_peg" : "miss_peg";
        mesh.castShadow = true;
        mesh.userData.dynamic = true;
        board.group.add(mesh);
        board.pegs.push(mesh);
        if (grow) {
            mesh.scale.setScalar(0.02);
            this._tween(board, mesh, 320, (o, k) => o.scale.setScalar(0.02 + (1 - (1 - k) ** 3) * 0.98), true);
        }
        return mesh;
    }

    // ------------------------------------------------------------- the gun end
    /**
     * Find the main battery of a hull and remember how to aim it.
     *
     * `ships.js` builds every class out of the same parts, so the guns are
     * already there: groups named "turret", plus the submarine's "deckGun". The
     * barrel length gives back the scale its turret was built at, which is what
     * puts the muzzle at the end of the barrel instead of at the gunhouse. A
     * carrier has neither, and is simply never the ship that answers.
     */
    _rigGuns(mesh) {
        const isBarrel = (o) => o.isMesh && o.geometry.type === "CylinderGeometry"
            && Math.abs(Math.abs(o.rotation.z) - Math.PI / 2) < 0.2;
        const guns = [];
        mesh.traverse((o) => {
            if (o.name !== "turret" && o.name !== "deckGun") {
                return;
            }
            const barrels = o.children.filter(isBarrel);
            if (!barrels.length) {
                return;
            }
            const length = barrels[0].geometry.parameters.height;
            guns.push({
                group: o,
                barrels,
                // Along the barrel, at its mouth, in the turret's own frame.
                muzzle: new THREE.Vector3(barrels[0].position.x + length / 2, barrels[0].position.y, 0),
                // `turret()` cuts its barrels at 0.36 of the scale it was asked
                // for, so the length reads back as the calibre of the gun.
                calibre: Math.max(0.55, length / 0.36),
            });
        });
        // The heaviest gun on the ship fires: the one built at the largest scale.
        guns.sort((p, q) => q.calibre - p.calibre);
        mesh.userData.guns = guns;
    }

    /** The hull that takes the shot: still afloat, armed, and nearest the target. */
    _shooter(side, targetWorld) {
        let best = null;
        for (const mesh of this.boards[side]?.ships || []) {
            if (mesh.userData.ship?.sunk || !mesh.userData.guns?.length) {
                continue;
            }
            const d = mesh.getWorldPosition(new THREE.Vector3()).distanceTo(targetWorld);
            if (!best || d < best.d) {
                best = { mesh, d };
            }
        }
        return best?.mesh || null;
    }

    /** The bearing of a world point from a hull, in the hull's own frame. */
    _bearing(ship, targetWorld) {
        const local = ship.worldToLocal(targetWorld.clone());
        return Math.atan2(-local.z, local.x);
    }

    /** Flash, smoke and glare at the muzzle, in `board`'s own frame. */
    _muzzleBlast(board, at, dir, calibre) {
        const s = calibre;
        const flash = new THREE.Mesh(
            new THREE.ConeGeometry(0.13 * s, 0.62 * s, 12, 1, true),
            new THREE.MeshBasicMaterial({
                color: FLASH.core, transparent: true, opacity: 1,
                depthWrite: false, side: THREE.DoubleSide,
            })
        );
        flash.name = "muzzleFlash";
        flash.position.copy(at);
        flash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        board.fx.add(flash);
        this._tween(board, flash, 190, (o, k) => {
            o.scale.set(1 + k * 1.5, 1 + k * 2.6, 1 + k * 1.5);
            o.material.color.set(k < 0.35 ? FLASH.core : FLASH.fire);
            o.material.opacity = (1 - k) ** 1.6;
        });

        // A hot ball at the mouth, then the smoke it leaves hanging.
        const ball = new THREE.Mesh(
            new THREE.SphereGeometry(0.15 * s, 12, 10),
            new THREE.MeshBasicMaterial({ color: FLASH.fire, transparent: true, opacity: 0.95, depthWrite: false })
        );
        ball.position.copy(at);
        board.fx.add(ball);
        this._tween(board, ball, 260, (o, k) => {
            o.scale.setScalar(1 + k * 1.9);
            o.material.opacity = 0.95 * (1 - k) ** 2;
        });

        for (let i = 0; i < 7; i++) {
            const puff = new THREE.Mesh(
                new THREE.SphereGeometry((0.07 + Math.random() * 0.06) * s, 8, 7),
                new THREE.MeshBasicMaterial({ color: FLASH.smoke, transparent: true, opacity: 0.5, depthWrite: false })
            );
            puff.position.copy(at).addScaledVector(dir, 0.1 + i * 0.06 * s);
            board.fx.add(puff);
            const drift = dir.clone().multiplyScalar(0.5 + Math.random() * 0.9)
                .add(new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.25 + Math.random() * 0.4, (Math.random() - 0.5) * 0.5));
            this._tween(board, puff, 1100 + i * 60, (o, k, dt) => {
                o.position.addScaledVector(drift, dt);
                drift.multiplyScalar(1 - dt * 1.6);
                o.scale.setScalar(1 + k * 2.4);
                o.material.opacity = 0.5 * (1 - k) ** 1.4;
            });
        }

        // A gun going off lights its own ship for a frame or two. Cheap, because
        // it is one light for a sixth of a second, and it is what sells the fire.
        const glare = new THREE.PointLight(FLASH.fire, 26 * s, 4.5 * s, 2);
        glare.position.copy(at);
        board.fx.add(glare);
        this._tween(board, glare, 170, (o, k) => {
            o.intensity = 26 * s * (1 - k) ** 2;
            if (k >= 1) {
                board.fx.remove(o);
            }
        }, true);

        // And the blast flattens the water under the muzzle.
        if (Math.abs(at.x) < SIZE / 2 && Math.abs(at.z) < SIZE / 2) {
            board.water.splash(at.x, at.z, 0.05 * s);
        }
    }

    /**
     * A shell in the air, from wherever it left to the cell it was aimed at.
     *
     * Everything else — the ring in the water, the column, the crown, the
     * droplets and the marker — happens when it lands. Until then the cell is
     * `pending`, so a state payload arriving in the meantime does not put the
     * marker down early.
     */
    _shell(board, cell, result, from, dur, lift, delay = 0) {
        const shell = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), MAT.shell);
        shell.name = "shell";
        shell.position.copy(from);
        shell.visible = !delay;
        board.fx.add(shell);
        this.shells.push({
            board, cell, result, mesh: shell, from,
            to: new THREE.Vector3(cx(cell % SIZE), 0, cx(Math.floor(cell / SIZE))),
            k: 0, dur, lift, wait: delay, isHit: result !== "miss",
        });
    }

    /**
     * Fire on `cell` of `side` — from the line of `from`, not from off the board.
     *
     * The sequence is three beats, and they are deliberately separate: the gun
     * trains round first, so the player sees WHICH ship answers; then it fires
     * — flash, smoke, recoil, and only at that instant does the shell exist —
     * and the shell flies from that muzzle to the far grid.
     *
     * A board with nothing visible on it to shoot with falls back to a shell
     * out of the sky, which is what every shot used to be: an enemy fleet is
     * hidden until it sinks, so their answering salvo has no gun to leave from.
     *
     * `delay` is what turns a server answer that resolved several shots at once
     * back into a sequence: the cell is claimed now, the gun trains later.
     */
    fire(side, cell, result, delay = 0, from = null) {
        const board = this.boards[side];
        board.pending.add(cell);
        if (!this.boards[from]) {
            return this._skyShell(board, cell, result, delay);
        }
        // The hull is picked when the gun starts training rather than here:
        // `render()` rebuilds every ship on the payload that announced this
        // shot, and that payload is applied before the shell is in the air.
        this.guns.push({ board, cell, result, from, t: -delay, phase: "aim" });
    }

    /** The old shot: a shell arcing in from off the corner of the board. */
    _skyShell(board, cell, result, delay = 0) {
        const x = cx(cell % SIZE);
        const z = cx(Math.floor(cell / SIZE));
        this._shell(board, cell, result, new THREE.Vector3(x - 5.5, 7.5, z + 6.5), 0.55, 2.6, delay);
    }

    /** Drop everything in the air: a different game is a different board. */
    clearTransients() {
        for (const side of this.sides) {
            const board = this.boards[side];
            board.fx.clear();
            board.pending.clear();
        }
        this.shells = [];
        this.guns = [];
        this.tweens = this.tweens.filter((tween) => tween.keep);
    }

    _impact(board, cell, x, z, isHit) {
        board.pending.delete(cell);
        // The ring the whole board feels, and the foam the shader draws with it.
        board.water.splash(x, z, isHit ? 0.15 : 0.105);

        const warm = isHit ? "#ffb46b" : "#dff0f5";
        const column = new THREE.Mesh(
            new THREE.CylinderGeometry(0.1, 0.3, 1.5, 16, 1, true),
            new THREE.MeshBasicMaterial({
                color: warm, transparent: true, opacity: 0.85,
                side: THREE.DoubleSide, depthWrite: false,
            })
        );
        column.position.set(x, 0.18, z);
        column.scale.set(0.5, 0.12, 0.5);
        board.fx.add(column);
        this._tween(board, column, 900, (o, k) => {
            o.scale.set(0.5 + k * 0.8, 0.12 + Math.sin(Math.min(1, k * 1.5) * Math.PI * 0.5) * 1.35, 0.5 + k * 0.8);
            o.position.y = 0.18 + k * 0.35;
            o.material.opacity = 0.85 * (1 - k) * (1 - k);
        });

        const crown = new THREE.Mesh(
            new THREE.RingGeometry(0.16, 0.3, 40),
            new THREE.MeshBasicMaterial({
                color: isHit ? "#ffd7b0" : "#eaf7fb", transparent: true, opacity: 0.8,
                side: THREE.DoubleSide, depthWrite: false,
            })
        );
        crown.rotation.x = -Math.PI / 2;
        crown.position.set(x, 0.07, z);
        board.fx.add(crown);
        this._tween(board, crown, 1100, (o, k) => {
            o.scale.setScalar(1 + k * 6.5);
            o.material.opacity = 0.8 * (1 - k);
        });

        for (let i = 0; i < 16; i++) {
            const drop = new THREE.Mesh(
                new THREE.SphereGeometry(0.045 + Math.random() * 0.035, 6, 5),
                new THREE.MeshBasicMaterial({
                    color: isHit && i % 3 ? "#C4472F" : warm, transparent: true, depthWrite: false,
                })
            );
            drop.position.set(x, 0.2, z);
            const a = Math.random() * Math.PI * 2;
            const speed = 0.7 + Math.random() * 1.5;
            const v = new THREE.Vector3(Math.cos(a) * speed, 2.2 + Math.random() * 2.2, Math.sin(a) * speed);
            board.fx.add(drop);
            this._tween(board, drop, 1000, (o, k, dt) => {
                o.position.addScaledVector(v, dt);
                v.y -= 8.5 * dt;
                o.material.opacity = 1 - k * k;
                if (o.position.y < 0 && v.y < 0) {
                    v.multiplyScalar(0);
                    o.position.y = 0;
                }
            });
        }

        this.peg(board.side, cell, isHit, true);
    }

    /** Run `fn(object, progress, dt)` for `ms`, then drop the object. */
    _tween(board, object, ms, fn, keep = false) {
        this.tweens.push({ board, object, dur: ms / 1000, t: 0, fn, keep });
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
            const hits = ray.intersectObjects(
                this.sides.map((side) => this.boards[side].pick), false
            );
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
        canvas.addEventListener("pointerleave", () => this.setHover(null, null));
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

    /** Frame every grid inside whatever band the layout leaves for the canvas. */
    fit() {
        // The same arithmetic `_board` places by, read back as an extent: two
        // boards make a wide strip, four make a square, and the margins leave
        // room for the coordinate letters and the plates in front.
        const step = SIZE + this._gap;
        const cols = this.sides.length > 2 ? 2 : Math.max(this.sides.length, 1);
        const rows = Math.ceil(Math.max(this.sides.length, 1) / cols);
        const halfX = ((cols - 1) * step) / 2 + SIZE / 2 + 1.5;
        const halfZ = ((rows - 1) * step) / 2 + SIZE / 2 + 2.2;
        const box = new THREE.Box3(
            new THREE.Vector3(-halfX, -0.4, -halfZ),
            new THREE.Vector3(halfX, 1.2, halfZ)
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

    /**
     * Train → fire → recover, one beat per frame.
     *
     * Every entry that comes in here has to end in a shell, whatever happens to
     * the hull that was going to fire it: the component counts the salvo down
     * by its impacts, and a shot that never lands leaves the board waiting for
     * it forever. So both ways out of the aim — no gun to fire, or a hull that
     * a fresh payload rebuilt underneath us — fall back to the sky shell.
     */
    _advanceGuns(dt) {
        for (let i = this.guns.length - 1; i >= 0; i--) {
            const g = this.guns[i];
            g.t += dt;
            if (g.t < 0) {
                continue;
            }
            if (g.phase === "aim") {
                g.targetWorld = g.board.group.localToWorld(
                    new THREE.Vector3(cx(g.cell % SIZE), 0, cx(Math.floor(g.cell / SIZE)))
                );
                g.ship = this._shooter(g.from, g.targetWorld);
                if (!g.ship) {
                    this.guns.splice(i, 1);
                    this._skyShell(g.board, g.cell, g.result);
                    continue;
                }
                g.own = this.boards[g.from];
                g.gun = g.ship.userData.guns[0];
                g.rest = g.gun.group.rotation.y;
                // Shortest way round, so a stern turret does not swing 350°.
                g.aim = this._bearing(g.ship, g.targetWorld);
                while (g.aim - g.rest > Math.PI) {
                    g.aim -= Math.PI * 2;
                }
                while (g.aim - g.rest < -Math.PI) {
                    g.aim += Math.PI * 2;
                }
                g.phase = "train";
                g.t = 0;
            }
            if (!g.ship.parent) {
                // The fleet was rebuilt mid-sequence: the shell is owed anyway.
                this.guns.splice(i, 1);
                this._skyShell(g.board, g.cell, g.result);
                continue;
            }
            const { ship, gun } = g;
            if (g.phase === "train") {
                const k = Math.min(1, g.t / TRAVERSE);
                const ease = k * k * (3 - 2 * k);
                gun.group.rotation.y = g.rest + (g.aim - g.rest) * ease;
                if (k < 1) {
                    continue;
                }
                // Loose. The muzzle is read off the trained gun, so the shell
                // and the flash leave the same point in the same direction.
                ship.updateWorldMatrix(true, true);
                const muzzleWorld = gun.group.localToWorld(gun.muzzle.clone());
                const backWorld = gun.group.localToWorld(gun.muzzle.clone().setX(gun.muzzle.x - 0.3));
                const dir = muzzleWorld.clone().sub(backWorld).normalize();
                this._muzzleBlast(g.own, g.own.group.worldToLocal(muzzleWorld.clone()), dir, gun.calibre);
                // The shell lives on the board it is going to land on, so its
                // arc is read in the same frame as the cell it is aimed at.
                const from = g.board.group.worldToLocal(muzzleWorld.clone());
                const span = from.distanceTo(new THREE.Vector3(cx(g.cell % SIZE), 0, cx(Math.floor(g.cell / SIZE))));
                // Both scale with the range: a board away is a longer, higher
                // arc than the far corner of the grid in front of the guns.
                this._shell(g.board, g.cell, g.result, from, Math.max(0.62, span * 0.045), 1.4 + span * 0.16);
                this.onFire({ ship, calibre: gun.calibre });
                g.phase = "recoil";
                g.t = 0;
                continue;
            }
            const k = Math.min(1, g.t / RECOIL);
            // Out of battery hard, back in slowly: the shape of the recoil is
            // most of what makes a gun feel heavy.
            const out = k < 0.18 ? k / 0.18 : (1 - (k - 0.18) / 0.82) ** 2;
            for (const barrel of gun.barrels) {
                barrel.position.x = barrel.userData.rest ??= barrel.position.x;
                barrel.position.x -= out * 0.11 * gun.calibre;
            }
            ship.userData.kick = out * 0.055;
            if (k >= 1) {
                ship.userData.kick = 0;
                this.guns.splice(i, 1);
            }
        }
    }

    _tick() {
        const now = performance.now();
        const dt = Math.min(0.05, (now - this.last) / 1000);
        this.last = now;

        for (const side of this.sides) {
            const board = this.boards[side];
            board.water.advance(dt, this.camera);
            for (const ship of board.ships) {
                board.water.float(ship);
                if (ship.userData.kick) {
                    // The hull leans away from its own broadside. After the
                    // float, because that is what sets the roll of a frame.
                    ship.rotation.x -= ship.userData.kick;
                }
            }
            for (const peg of board.pegs) {
                board.water.bob(peg, peg.userData.rest);
            }
            if (board.turn) {
                // Slow enough to read as breathing rather than as a blink.
                board.turn.material.opacity = 0.55 + 0.45 * Math.sin(now / 420);
            }
            if (board.glow) {
                const [beat, lo, hi] = GLOW_BEAT[board.glow];
                board.haloMat.opacity = lo + (hi - lo) * (0.5 + 0.5 * Math.sin(now / beat));
            }
            if (this.ghost?.side === side) {
                board.water.float(this.ghost.mesh);
            }
        }

        this._advanceGuns(dt);

        // Shells in the air. The arc is a straight lerp lifted by a sine: it
        // reads as a trajectory and lands exactly on the cell it was aimed at.
        for (let i = this.shells.length - 1; i >= 0; i--) {
            const shot = this.shells[i];
            if (shot.wait > 0) {
                shot.wait -= dt;
                shot.mesh.visible = shot.wait <= 0;
                continue;
            }
            shot.k += dt / shot.dur;
            if (shot.k >= 1) {
                shot.board.fx.remove(shot.mesh);
                shot.mesh.geometry.dispose();
                this.shells.splice(i, 1);
                this._impact(shot.board, shot.cell, shot.to.x, shot.to.z, shot.isHit);
                this.onImpact(shot.result);
                continue;
            }
            shot.mesh.position.lerpVectors(shot.from, shot.to, shot.k);
            shot.mesh.position.y += Math.sin(shot.k * Math.PI) * shot.lift;
        }

        for (let i = this.tweens.length - 1; i >= 0; i--) {
            const tween = this.tweens[i];
            tween.t += dt;
            const k = Math.min(1, tween.t / tween.dur);
            tween.fn(tween.object, k, dt);
            if (k >= 1) {
                if (!tween.keep) {
                    tween.board.fx.remove(tween.object);
                    tween.object.geometry.dispose();
                    tween.object.material.dispose();
                }
                this.tweens.splice(i, 1);
            }
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}
