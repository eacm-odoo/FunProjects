/** @odoo-module **/
/**
 * The air, as WWII silhouettes rather than as darts.
 *
 * Built the way `ships.js` builds the fleet: every aircraft comes out of the
 * same parts — fuselage, wing, tail, canopy, cowling, propeller, markings — so
 * a fighter, an interceptor and a bomber read as one air force instead of three
 * unrelated models. Sizes are in board cells, like the ships: a fighter is
 * about a cell and a half across, which is what makes it read as an aircraft
 * over a 4 cell battleship rather than as a second ship in the sky.
 *
 * Palette, helpers and construction are the fleet's, on purpose — the same
 * painted steel and gunmetal, the same `bx`/`cy` pair. Nothing here knows about
 * the game rules, the grid or the payload.
 *
 * Ported from the `Aviones sobre el tablero` design prototype.
 */
import * as THREE from "@battleship_3d/lib/three.module";

// The fleet's materials, read one squadron at a time: side A flies the light
// steel the ships are plated in, side B the darker flight-deck grey. Nothing
// new is invented here — these are `ships.js`'s colours.
const P = {
    steel: "#77828a", hull: "#5c6771", gun: "#454f57", dark: "#2a3136",
    deck: "#6d6151", flight: "#4a4439", stripe: "#cfc9bb",
    glass: "#1b2a30", red: "#C4472F", plum: "#714B67",
};

const mat = (color, roughness, metalness) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness });

// One set of materials for the whole air force, shared by every aircraft ever
// spawned: three.js keys its render batches on the material, and a sortie is
// built and dropped every few seconds.
const AM = {
    a: { skin: mat(P.steel, 0.48, 0.55), under: mat(P.hull, 0.55, 0.4), mark: mat(P.plum, 0.6, 0.1) },
    b: { skin: mat(P.flight, 0.6, 0.35), under: mat(P.deck, 0.8, 0.12), mark: mat(P.red, 0.5, 0.1) },
};
const SM = {
    gun: mat(P.gun, 0.38, 0.76),
    dark: mat(P.dark, 0.7, 0.3),
    stripe: mat(P.stripe, 0.9, 0.05),
    glass: new THREE.MeshStandardMaterial({ color: P.glass, roughness: 0.18, metalness: 0.5 }),
    prop: new THREE.MeshStandardMaterial({
        color: P.dark, roughness: 0.5, metalness: 0.4, transparent: true, opacity: 0.55,
    }),
    disc: new THREE.MeshBasicMaterial({
        color: "#9fb0b6", transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false,
    }),
};

/** Box and cylinder, positioned in one call — the fleet's two shapes. */
function bx(w, h, d, m, x, y, z) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    return mesh;
}

function cy(rt, rb, h, m, x, y, z, seg = 12) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    return mesh;
}

/** Fuselage: a tube along +X, closed by a spinner at the nose. Nose is +X. */
function fuselage(L, r, skin) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(r, L - r * 2.2, 6, 16), skin);
    body.rotation.z = Math.PI / 2;
    body.castShadow = true;
    body.name = "fuselage";
    group.add(body);
    const taper = cy(r * 0.22, r * 0.86, L * 0.3, skin, -L * 0.42, 0, 0, 14);
    taper.rotation.z = Math.PI / 2;
    group.add(taper);
    return group;
}

/** Wing in two halves, with dihedral, so it does not read as a plank. */
function wing(span, chord, thick, m, x, y, sweep = 0.04, dihedral = 0.07) {
    const group = new THREE.Group();
    for (const sign of [-1, 1]) {
        const half = new THREE.Mesh(new THREE.BoxGeometry(chord, thick, span / 2), m);
        half.position.set(x - sweep * span * 0.25, 0, (sign * span) / 4);
        half.rotation.x = -sign * dihedral;
        half.castShadow = half.receiveShadow = true;
        group.add(half);
        // Rounded-off tip: a shorter, thinner chord outboard.
        const tip = new THREE.Mesh(new THREE.BoxGeometry(chord * 0.62, thick * 0.8, span * 0.06), m);
        tip.position.set(x - sweep * span * 0.5, sign * dihedral * span * 0.24, (sign * span) / 2);
        tip.castShadow = true;
        group.add(tip);
    }
    group.position.y = y;
    group.name = "wing";
    return group;
}

/** Tail: fin on the centreline, stabiliser across it. */
function tail(group, L, r, skin) {
    const x = -L * 0.44;
    group.add(bx(L * 0.16, r * 0.34, L * 0.42, skin, x, 0, 0));
    const fin = bx(L * 0.15, L * 0.19, r * 0.3, skin, x - L * 0.02, L * 0.1, 0);
    fin.name = "fin";
    group.add(fin);
    group.add(bx(L * 0.06, L * 0.05, r * 0.32, SM.stripe, x - L * 0.06, L * 0.14, 0));
}

/** Propeller: two blades and the disc they sweep, spun by `AirTraffic`. */
function propeller(r, x) {
    const group = new THREE.Group();
    group.position.x = x;
    group.add(cy(0.022, 0.05, 0.12, SM.gun, 0.03, 0, 0, 10).rotateZ(Math.PI / 2));
    for (let i = 0; i < 2; i++) {
        const blade = bx(0.03, r * 2, 0.055, SM.prop, 0, 0, 0);
        blade.rotation.x = (i * Math.PI) / 2;
        group.add(blade);
    }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 20), SM.disc);
    disc.rotation.y = Math.PI / 2;
    group.add(disc);
    group.name = "prop";
    return group;
}

/** Roundel on both wings, in the colour of the squadron. */
function markings(group, span, chord, y, m) {
    for (const sign of [-1, 1]) {
        const roundel = cy(span * 0.075, span * 0.075, 0.008, m, -chord * 0.05, y + 0.02, (sign * span) / 3.4, 16);
        group.add(roundel);
    }
}

function buildFighter(group, span, side) {
    const skin = AM[side];
    const L = span * 0.84;
    const r = span * 0.06;
    group.add(fuselage(L, r, skin.skin));
    group.add(wing(span, L * 0.2, r * 0.42, skin.skin, L * 0.04, -r * 0.35, 0.05, 0.075));
    tail(group, L, r, skin.skin);

    // Inline engine: a long cowl closing on a spinner.
    const cowl = cy(r * 0.72, r * 0.98, L * 0.24, skin.skin, L * 0.4, 0, 0, 14);
    cowl.rotation.z = Math.PI / 2;
    group.add(cowl);
    const spinner = cy(0.015, r * 0.6, r * 1.5, SM.dark, L * 0.52, 0, 0, 12);
    spinner.rotation.z = -Math.PI / 2;
    group.add(spinner);
    group.add(propeller(span * 0.2, L * 0.56));

    group.add(bx(L * 0.2, r * 0.7, r * 1.15, SM.glass, -L * 0.02, r * 0.7, 0)); // canopy
    group.add(bx(L * 0.1, r * 0.5, r * 1.0, skin.skin, -L * 0.13, r * 0.62, 0)); // spine
    group.add(bx(L * 0.13, r * 0.5, r * 0.9, skin.under, L * 0.16, -r * 0.85, 0)); // radiator
    for (const sign of [-1, 1]) { // wing guns
        const barrel = cy(0.012, 0.014, L * 0.14, SM.gun, L * 0.16, -r * 0.3, (sign * span) / 5, 6);
        barrel.rotation.z = Math.PI / 2;
        group.add(barrel);
    }
    markings(group, span, L * 0.2, -r * 0.32, skin.mark);
    group.userData.muzzle = new THREE.Vector3(L * 0.24, -r * 0.3, 0);
}

function buildInterceptor(group, span, side) {
    const skin = AM[side];
    const L = span * 0.76;
    const r = span * 0.075;
    group.add(fuselage(L, r, skin.skin));
    group.add(wing(span, L * 0.24, r * 0.4, skin.skin, L * 0.02, -r * 0.3, 0.02, 0.05));
    tail(group, L, r, skin.skin);

    // Radial engine: a barrel of a cowling, open at the front.
    const cowl = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 1.15, r * 1.05, L * 0.2, 16, 1, true), skin.skin
    );
    cowl.rotation.z = Math.PI / 2;
    cowl.position.x = L * 0.4;
    cowl.castShadow = true;
    group.add(cowl);
    group.add(cy(r * 0.75, r * 0.75, 0.03, SM.dark, L * 0.44, 0, 0, 14).rotateZ(Math.PI / 2));
    group.add(propeller(span * 0.21, L * 0.53));

    group.add(bx(L * 0.22, r * 0.62, r * 1.1, SM.glass, -L * 0.04, r * 0.66, 0));
    for (const sign of [-1, 1]) { // fixed spats
        group.add(bx(r * 0.9, r * 1.1, r * 0.5, skin.under, L * 0.06, -r * 1.3, (sign * span) / 6));
    }
    markings(group, span, L * 0.24, -r * 0.26, skin.mark);
    group.userData.muzzle = new THREE.Vector3(L * 0.3, 0, 0);
}

function buildBomber(group, span, side) {
    const skin = AM[side];
    const L = span * 0.78;
    const r = span * 0.055;
    group.add(fuselage(L, r, skin.skin));
    group.add(wing(span, L * 0.17, r * 0.42, skin.skin, 0, r * 0.1, 0.03, 0.04));

    // Twin fins on a broad stabiliser.
    group.add(bx(L * 0.14, r * 0.3, L * 0.34, skin.skin, -L * 0.44, 0, 0));
    for (const sign of [-1, 1]) {
        group.add(bx(L * 0.12, L * 0.13, r * 0.26, skin.skin, -L * 0.45, L * 0.07, sign * L * 0.15));
    }

    for (const sign of [-1, 1]) { // engine nacelles
        const z = (sign * span) / 4.4;
        const nacelle = cy(r * 0.8, r * 0.95, L * 0.28, skin.skin, L * 0.1, r * 0.06, z, 12);
        nacelle.rotation.z = Math.PI / 2;
        group.add(nacelle);
        group.add(cy(r * 0.7, r * 0.7, 0.03, SM.dark, L * 0.24, r * 0.06, z, 12).rotateZ(Math.PI / 2));
        const prop = propeller(span * 0.14, L * 0.29);
        prop.position.set(L * 0.29, r * 0.06, z);
        group.add(prop);
    }

    group.add(bx(L * 0.16, r * 0.9, r * 1.5, SM.glass, L * 0.34, r * 0.25, 0)); // glass nose
    group.add(bx(L * 0.2, r * 0.75, r * 1.4, SM.glass, L * 0.04, r * 0.85, 0)); // cockpit
    const turret = cy(r * 0.7, r * 0.75, r * 0.7, SM.glass, -L * 0.16, r * 1.05, 0, 12); // dorsal turret
    turret.name = "turret";
    group.add(turret);
    const barrel = cy(0.014, 0.016, L * 0.12, SM.gun, -L * 0.22, r * 1.2, 0, 6);
    barrel.rotation.z = Math.PI / 2 + 0.25;
    group.add(barrel);
    markings(group, span, L * 0.17, r * 0.12, skin.mark);
    group.userData.muzzle = new THREE.Vector3(-L * 0.28, r * 1.2, 0);
}

const BUILDERS = { Fighter: buildFighter, Interceptor: buildInterceptor, Bomber: buildBomber };
const SPAN = { Fighter: 2.1, Interceptor: 2.0, Bomber: 3.3 };

/**
 * One aircraft, nose along +X, wings across Z — the axes the ships use, so a
 * yaw is a heading here too.
 */
export function planeMesh(cls = "Fighter", side = "a") {
    const group = new THREE.Group();
    group.rotation.order = "YXZ"; // yaw is the heading, roll rides on top of it
    const span = SPAN[cls] || SPAN.Fighter;
    (BUILDERS[cls] || BUILDERS.Fighter)(group, span, side);
    const props = [];
    group.traverse((o) => {
        if (o.isMesh) {
            o.castShadow = true;
        }
        if (o.name === "prop") {
            props.push(o);
        }
    });
    Object.assign(group.userData, { cls, side, span, props });
    return group;
}

/**
 * Give an airframe back to the GPU.
 *
 * Materials are shared by the whole air force and outlive every aircraft, so
 * only the geometries — one per part, built with the plane — go out here.
 */
export function disposePlane(mesh) {
    mesh.traverse((o) => {
        if (o.isMesh) {
            o.geometry.dispose();
        }
    });
}

export const PLANE_CLASSES = Object.keys(BUILDERS);
