/** @odoo-module **/
/**
 * The fleet, as five WWII silhouettes rather than five boxes.
 *
 * Every ship is built from the same parts — a hull, turrets, funnels, masts,
 * light AA — so the classes read as one navy instead of five unrelated models.
 * Sizes are in board cells: a ship `size` cells long is `size - 0.16` units, and
 * nothing here knows about the game rules, the grid or the payload.
 *
 * Ported from the `Battleship 3D` design prototype.
 */
import * as THREE from "@battleship_3d/lib/three.module";

// Painted steel, wood decks and gunmetal. Shared by every ship on the board:
// three.js keys its render batches on the material, so one set for the whole
// fleet is also the cheap way to draw it.
const SM = {
    hull: new THREE.MeshStandardMaterial({ name: "hullPlate", color: "#5c6771", roughness: 0.5, metalness: 0.52 }),
    hullLow: new THREE.MeshStandardMaterial({ name: "hullBelow", color: "#333c44", roughness: 0.62, metalness: 0.34 }),
    deck: new THREE.MeshStandardMaterial({ name: "deckWood", color: "#6d6151", roughness: 0.92, metalness: 0.06 }),
    steel: new THREE.MeshStandardMaterial({ name: "steel", color: "#77828a", roughness: 0.54, metalness: 0.46 }),
    gun: new THREE.MeshStandardMaterial({ name: "gunmetal", color: "#454f57", roughness: 0.38, metalness: 0.76 }),
    dark: new THREE.MeshStandardMaterial({ name: "darkTrim", color: "#2a3136", roughness: 0.7, metalness: 0.3 }),
    flight: new THREE.MeshStandardMaterial({ name: "flightDeck", color: "#4a4439", roughness: 0.95, metalness: 0.04 }),
    stripe: new THREE.MeshStandardMaterial({ name: "deckStripe", color: "#cfc9bb", roughness: 0.9 }),
};

/** Box and cylinder, positioned in one call: the two shapes everything is made of. */
function bx(w, h, d, mat, x, y, z) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
}

function cy(rt, rb, h, mat, x, y, z, seg = 14) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    return mesh;
}

/**
 * The hull: a waterline plan extruded twice.
 *
 * Once narrow and dark for what sits below the water, once full width for the
 * plating above it. The bow is a quadratic that closes the two sides, which is
 * what keeps these from reading as bricks from across the board.
 */
function hullBody(L, W, options = {}) {
    const {
        bow = W * 1.5, deckMat = SM.deck, freeboard = 0.26, draftH = 0.2, sheer = true,
    } = options;

    const plan = (width, taper) => {
        const hw = width / 2;
        const shape = new THREE.Shape();
        shape.moveTo(-L / 2 + 0.06, -hw);
        shape.lineTo(L / 2 - bow, -hw);
        shape.quadraticCurveTo(L / 2 + 0.04, -hw * taper, L / 2 + 0.02, 0);
        shape.quadraticCurveTo(L / 2 + 0.04, hw * taper, L / 2 - bow, hw);
        shape.lineTo(-L / 2 + 0.06, hw);
        shape.quadraticCurveTo(-L / 2 - 0.07, 0, -L / 2 + 0.06, -hw);
        return shape;
    };
    const extrude = (shape, depth, bevel) => new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelSize: bevel,
        bevelThickness: bevel,
        bevelSegments: 2,
        curveSegments: 14,
    });

    const group = new THREE.Group();
    const lowGeo = extrude(plan(W * 0.8, 0.18), draftH, 0.05);
    lowGeo.rotateX(-Math.PI / 2);
    lowGeo.translate(0, -draftH + 0.04, 0);
    const low = new THREE.Mesh(lowGeo, SM.hullLow);
    low.name = "hullBelow";
    group.add(low);

    const upGeo = extrude(plan(W, 0.26), freeboard, 0.04);
    upGeo.rotateX(-Math.PI / 2);
    upGeo.translate(0, 0.02, 0);
    const up = new THREE.Mesh(upGeo, SM.hull);
    up.name = "hull";
    up.castShadow = up.receiveShadow = true;
    group.add(up);

    const deck = bx(L - bow * 0.5, 0.035, W * 0.84, deckMat, -bow * 0.18, 0.02 + freeboard, 0);
    deck.name = "deck";
    group.add(deck);
    if (sheer) {
        group.add(bx(L * 0.3, 0.07, W * 0.9, SM.hull, L / 2 - L * 0.16, 0.04 + freeboard, 0));
        group.add(bx(L * 0.18, 0.05, W * 0.82, SM.hull, -L / 2 + L * 0.1, 0.03 + freeboard, 0));
    }
    return { group, top: 0.02 + freeboard };
}

/** Main battery: barbette, gunhouse and `barrels` guns pointing forward. */
function turret(scale, barrels, mat = SM.steel) {
    const group = new THREE.Group();
    group.add(cy(0.115 * scale, 0.135 * scale, 0.05 * scale, SM.steel, 0, 0.02 * scale, 0, 12));
    group.add(bx(0.21 * scale, 0.1 * scale, 0.25 * scale, mat, 0, 0.095 * scale, 0));
    group.add(bx(0.07 * scale, 0.08 * scale, 0.21 * scale, mat, 0.13 * scale, 0.09 * scale, 0));
    for (let i = 0; i < barrels; i++) {
        const barrel = cy(
            0.019 * scale, 0.023 * scale, 0.36 * scale, SM.gun,
            0.3 * scale, 0.105 * scale, (i - (barrels - 1) / 2) * 0.08 * scale, 10
        );
        barrel.rotation.z = Math.PI / 2;
        group.add(barrel);
    }
    group.name = "turret";
    return group;
}

function funnel(h, r, rake = 0.12) {
    const group = new THREE.Group();
    group.add(cy(r * 0.88, r, h, SM.hull, 0, h / 2, 0, 16));
    group.add(cy(r * 0.95, r * 0.95, 0.035, SM.dark, 0, h, 0, 16));
    group.rotation.z = -rake;
    group.name = "funnel";
    return group;
}

function mast(h, mat = SM.gun) {
    const group = new THREE.Group();
    group.add(cy(0.016, 0.03, h, mat, 0, h / 2, 0, 8));
    group.add(bx(0.02, 0.02, 0.34, mat, 0, h * 0.72, 0));
    group.add(bx(0.02, 0.02, 0.24, mat, 0, h * 0.9, 0));
    group.name = "mast";
    return group;
}

/** Light AA in pairs down both sides: what fills the empty deck. */
function aaGuns(group, L, y, w, count = 3) {
    for (let i = 0; i < count; i++) {
        const x = -L * 0.28 + i * (L * 0.26);
        for (const sign of [-1, 1]) {
            group.add(bx(0.07, 0.045, 0.07, SM.gun, x, y, sign * w));
            const barrel = cy(0.012, 0.014, 0.13, SM.gun, x + 0.06, y + 0.03, sign * w, 6);
            barrel.rotation.z = Math.PI / 2 - 0.35;
            group.add(barrel);
        }
    }
}

// ---------------------------------------------------------------------------
// The five classes
// ---------------------------------------------------------------------------

function buildCarrier(group, L) {
    const W = 0.74;
    const hull = hullBody(L, W, { bow: W * 1.2, deckMat: SM.steel, freeboard: 0.3, draftH: 0.22, sheer: false });
    group.add(hull.group);
    const dy = hull.top + 0.16;

    group.add(bx(L * 0.92, 0.16, W * 0.92, SM.hull, -0.04, hull.top + 0.08, 0)); // hangar sides
    const deck = bx(L * 0.99, 0.06, W + 0.22, SM.flight, -0.01, dy, 0.02);
    deck.name = "flightDeck";
    group.add(deck);
    for (let i = 0; i < 7; i++) {
        group.add(bx(L * 0.07, 0.012, 0.05, SM.stripe, -L * 0.42 + i * (L * 0.14), dy + 0.035, 0.02));
    }
    for (const sign of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
            group.add(bx(0.05, 0.16, 0.05, SM.dark, -L * 0.3 + i * (L * 0.2), hull.top + 0.08, sign * (W * 0.5 + 0.08)));
        }
    }

    const island = new THREE.Group();
    island.position.set(-L * 0.04, dy + 0.03, 0.3);
    island.add(bx(0.42, 0.17, 0.22, SM.steel, 0, 0.085, 0));
    island.add(bx(0.3, 0.12, 0.18, SM.steel, 0.02, 0.23, 0));
    island.add(bx(0.16, 0.07, 0.14, SM.dark, 0.06, 0.33, 0));
    const stack = funnel(0.26, 0.085, 0.3);
    stack.position.set(-0.16, 0.17, 0.02);
    island.add(stack);
    const tower = mast(0.4);
    tower.position.set(-0.02, 0.36, 0);
    island.add(tower);
    island.name = "island";
    group.add(island);

    for (let i = 0; i < 2; i++) {
        const plane = new THREE.Group();
        plane.position.set(-L * 0.3 - i * 0.5, dy + 0.09, -0.14 + i * 0.05);
        plane.rotation.y = 0.25 - i * 0.5;
        plane.add(bx(0.3, 0.06, 0.07, SM.dark, 0, 0, 0));
        plane.add(bx(0.09, 0.022, 0.4, SM.steel, 0.02, 0.02, 0));
        plane.add(bx(0.06, 0.07, 0.015, SM.steel, -0.14, 0.04, 0));
        plane.name = "aircraft";
        group.add(plane);
    }
    aaGuns(group, L, hull.top + 0.04, W * 0.5 + 0.06, 3);
}

function buildBattleship(group, L) {
    const W = 0.72;
    const hull = hullBody(L, W, { bow: W * 1.4, freeboard: 0.28, draftH: 0.22 });
    group.add(hull.group);
    const d = hull.top + 0.04;

    // Two forward triples, the second one firing over the first.
    [[L * 0.3, 0], [L * 0.15, 0.08]].forEach(([x, lift], i) => {
        const gun = turret(1.05, 3);
        gun.position.set(x, d + lift, 0);
        group.add(gun);
        if (i === 1) {
            group.add(bx(0.34, 0.09, W * 0.6, SM.hull, x, d + 0.045, 0)); // barbette
        }
    });
    const aft = turret(1.05, 3);
    aft.position.set(-L * 0.34, d, 0);
    aft.rotation.y = Math.PI;
    group.add(aft);

    const bridge = new THREE.Group(); // pagoda mast
    bridge.position.set(L * 0.01, d, 0);
    bridge.add(bx(0.62, 0.16, W * 0.68, SM.steel, -0.04, 0.08, 0));
    bridge.add(bx(0.4, 0.16, 0.34, SM.steel, 0.04, 0.24, 0));
    bridge.add(bx(0.26, 0.14, 0.26, SM.steel, 0.06, 0.39, 0));
    bridge.add(bx(0.18, 0.09, 0.2, SM.dark, 0.07, 0.5, 0));
    bridge.add(cy(0.05, 0.07, 0.3, SM.steel, -0.02, 0.6, 0, 10));
    bridge.add(bx(0.05, 0.05, 0.3, SM.gun, -0.02, 0.74, 0));
    bridge.name = "bridge";
    group.add(bridge);

    const fore = funnel(0.34, 0.12, 0.14);
    fore.position.set(-L * 0.13, d + 0.1, 0);
    group.add(fore);
    const aftFunnel = funnel(0.3, 0.105, 0.18);
    aftFunnel.position.set(-L * 0.24, d + 0.1, 0);
    group.add(aftFunnel);
    group.add(bx(0.5, 0.13, W * 0.6, SM.steel, -L * 0.18, d + 0.065, 0));
    const main = mast(0.44);
    main.position.set(-L * 0.3, d + 0.12, 0);
    group.add(main);

    for (const sign of [-1, 1]) {
        for (const x of [L * 0.04, -L * 0.08]) {
            const secondary = turret(0.6, 2);
            secondary.position.set(x, d + 0.06, sign * (W * 0.38));
            secondary.rotation.y = sign * 1.2;
            group.add(secondary);
        }
    }
    aaGuns(group, L, d + 0.02, W * 0.48, 3);
}

function buildCruiser(group, L) {
    const W = 0.62;
    const hull = hullBody(L, W, { bow: W * 1.5, freeboard: 0.24, draftH: 0.18 });
    group.add(hull.group);
    const d = hull.top + 0.04;

    [[L * 0.3, 0], [L * 0.12, 0.07]].forEach(([x, lift]) => {
        const gun = turret(0.9, 2);
        gun.position.set(x, d + lift, 0);
        group.add(gun);
    });
    const aft = turret(0.9, 2);
    aft.position.set(-L * 0.33, d, 0);
    aft.rotation.y = Math.PI;
    group.add(aft);

    const bridge = new THREE.Group();
    bridge.position.set(-L * 0.04, d, 0);
    bridge.add(bx(0.5, 0.15, W * 0.68, SM.steel, 0, 0.075, 0));
    bridge.add(bx(0.3, 0.13, 0.28, SM.steel, 0.05, 0.215, 0));
    bridge.add(bx(0.16, 0.08, 0.18, SM.dark, 0.07, 0.32, 0));
    bridge.name = "bridge";
    group.add(bridge);

    const main = mast(0.4);
    main.position.set(-L * 0.1, d + 0.1, 0);
    group.add(main);
    const stack = funnel(0.32, 0.115, 0.2);
    stack.position.set(-L * 0.19, d + 0.08, 0);
    group.add(stack);
    group.add(bx(0.34, 0.1, W * 0.55, SM.steel, -L * 0.2, d + 0.05, 0));

    const crane = new THREE.Group(); // stern crane over the floatplane pad
    crane.position.set(-L * 0.44, d, 0.02);
    crane.add(cy(0.03, 0.04, 0.26, SM.gun, 0, 0.13, 0, 8));
    const jib = cy(0.018, 0.018, 0.3, SM.gun, 0.1, 0.24, 0, 6);
    jib.rotation.z = 1.05;
    crane.add(jib);
    crane.name = "crane";
    group.add(crane);
    aaGuns(group, L, d + 0.02, W * 0.44, 2);
}

function buildSubmarine(group, L) {
    const R = 0.19;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(R, L - R * 2.6, 8, 20), SM.hull);
    body.rotation.z = Math.PI / 2;
    body.position.y = 0.02;
    body.castShadow = body.receiveShadow = true;
    body.name = "pressureHull";
    group.add(body);

    const bowCone = cy(0.02, R * 0.92, 0.34, SM.hull, L / 2 - 0.08, 0.02, 0, 18);
    bowCone.rotation.z = -Math.PI / 2;
    group.add(bowCone);
    group.add(bx(L * 0.84, 0.07, 0.2, SM.dark, -0.02, 0.16, 0)); // deck casing

    const tower = new THREE.Group();
    tower.position.set(-L * 0.04, 0.19, 0);
    tower.add(bx(0.4, 0.18, 0.22, SM.steel, 0, 0.09, 0));
    tower.add(bx(0.24, 0.09, 0.17, SM.steel, -0.02, 0.22, 0));
    tower.add(cy(0.014, 0.014, 0.26, SM.gun, 0.04, 0.38, 0.03, 6)); // periscopes
    tower.add(cy(0.02, 0.02, 0.2, SM.gun, -0.04, 0.35, -0.03, 6));
    const aa = cy(0.014, 0.016, 0.13, SM.gun, -0.16, 0.3, 0, 6);
    aa.rotation.z = 0.5;
    tower.add(aa);
    tower.name = "conningTower";
    group.add(tower);

    const deckGun = new THREE.Group();
    deckGun.position.set(L * 0.22, 0.2, 0);
    deckGun.add(cy(0.06, 0.07, 0.05, SM.steel, 0, 0.025, 0, 10));
    const barrel = cy(0.015, 0.017, 0.28, SM.gun, 0.11, 0.07, 0, 8);
    barrel.rotation.z = Math.PI / 2 - 0.1;
    deckGun.add(barrel);
    deckGun.name = "deckGun";
    group.add(deckGun);

    group.add(bx(0.16, 0.02, 0.5, SM.steel, -L / 2 + 0.12, 0.02, 0)); // stern planes
    group.add(bx(0.14, 0.26, 0.02, SM.steel, -L / 2 + 0.08, 0.05, 0)); // rudder
    group.add(bx(0.13, 0.02, 0.34, SM.steel, L / 2 - 0.5, -0.04, 0)); // bow planes
}

function buildDestroyer(group, L) {
    const W = 0.54;
    const hull = hullBody(L, W, { bow: W * 1.6, freeboard: 0.22, draftH: 0.16 });
    group.add(hull.group);
    const d = hull.top + 0.04;

    const fore = turret(0.8, 2);
    fore.position.set(L * 0.3, d + 0.05, 0);
    group.add(fore);
    group.add(bx(0.3, 0.08, W * 0.62, SM.hull, L * 0.3, d + 0.025, 0));
    const aft = turret(0.7, 1);
    aft.position.set(-L * 0.36, d, 0);
    aft.rotation.y = Math.PI;
    group.add(aft);

    const bridge = new THREE.Group();
    bridge.position.set(L * 0.06, d, 0);
    bridge.add(bx(0.36, 0.14, W * 0.66, SM.steel, 0, 0.07, 0));
    bridge.add(bx(0.2, 0.11, 0.22, SM.steel, 0.03, 0.195, 0));
    bridge.add(bx(0.12, 0.06, 0.14, SM.dark, 0.04, 0.28, 0));
    bridge.name = "bridge";
    group.add(bridge);

    const main = mast(0.36);
    main.position.set(-0.02, d + 0.1, 0);
    group.add(main);
    const f1 = funnel(0.26, 0.09, 0.2);
    f1.position.set(-L * 0.07, d + 0.06, 0);
    group.add(f1);
    const f2 = funnel(0.24, 0.08, 0.22);
    f2.position.set(-L * 0.2, d + 0.06, 0);
    group.add(f2);

    const tubes = new THREE.Group(); // torpedo tubes amidships, trained to port
    tubes.position.set(-L * 0.13, d + 0.09, 0);
    for (let i = -1; i <= 1; i++) {
        const tube = cy(0.032, 0.032, 0.3, SM.gun, 0, 0.03, i * 0.075, 10);
        tube.rotation.z = Math.PI / 2;
        tubes.add(tube);
    }
    tubes.rotation.y = 0.35;
    tubes.name = "torpedoTubes";
    group.add(tubes);

    for (const sign of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
            group.add(cy(0.035, 0.035, 0.08, SM.dark, -L * 0.44 + i * 0.09, d + 0.05, sign * 0.1, 8));
        }
    }
    aaGuns(group, L, d + 0.02, W * 0.4, 2);
}

const BUILDERS = {
    Carrier: buildCarrier,
    Battleship: buildBattleship,
    Cruiser: buildCruiser,
    Submarine: buildSubmarine,
    Destroyer: buildDestroyer,
};

// How deep each class rides, and how wide it is for the roll in `water.js`.
const DRAFT = { Submarine: -0.05 };
const BEAM = { Carrier: 0.42, Destroyer: 0.28 };

/**
 * The mesh of one ship of the payload.
 *
 * `read_state()` hides the name of an enemy ship until it sinks, so the class
 * is picked by name when there is one and by length when there is not — an
 * unidentified 5 is still drawn as a carrier, which is what it will turn out to
 * be anyway.
 */
export function shipMesh(ship) {
    const size = typeof ship === "number" ? ship : ship.size;
    const named = typeof ship === "object" && BUILDERS[ship.name] ? ship.name : null;
    const cls = named || (size >= 5 ? "Carrier" : size === 4 ? "Battleship" : size === 2 ? "Destroyer" : "Cruiser");

    const group = new THREE.Group();
    group.rotation.order = "YXZ"; // yaw stays the heading while the swell rolls it
    BUILDERS[cls](group, size - 0.16);
    group.traverse((o) => {
        if (o.isMesh) {
            o.castShadow = o.receiveShadow = true;
        }
    });
    Object.assign(group.userData, {
        cls,
        size,
        draft: DRAFT[cls] || 0,
        beam: BEAM[cls] || 0.34,
    });
    return group;
}
