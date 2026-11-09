/**
 * The 3D diagram: nodes with a label, arrows that grow from their source, and
 * a title on top.
 *
 * A node with an `icon` (one emoji) is a medallion: a coin in the node's
 * color with the emoji on both faces, swaying gently. A node without one is a
 * primitive (sphere, box, cylinder, cone, capsule) turning slowly.
 *
 * Arrows follow the layout's route: straight, or curving through the lanes
 * the layout keeps for arrows that skip columns. Each arrow is a tube whose
 * vertices are rewritten in place while it grows or the diagram moves.
 *
 * `reveal()` adds the elements of one step. Every reveal recomputes the
 * layout of what is visible; nodes and arrows already on screen glide to
 * their new place, so the diagram visibly builds up as the teacher talks.
 */

import * as THREE from "three";

import { createEmojiTexture, createTextSprite, disposeSprite } from "./labels.js";
import { edgeKey, layoutDiagram } from "./layout.js";

const NODE_RADIUS = 0.055;
const MEDALLION_RADIUS = 0.062;
const MEDALLION_THICKNESS = 0.016;
/** Where an arrow starts and stops, from the center of its nodes. */
const EDGE_GAP = 0.072;
const APPEAR_SECONDS = 0.5;
const MOVE_SECONDS = 0.45;
const EDGE_GROW_SECONDS = 0.55;
const EDGE_DELAY_SECONDS = 0.2;
const ARROW_LENGTH = 0.035;
const SHAFT_RADIUS = 0.0055;
const EDGE_COLOR = 0xB8C2CC;
const TITLE_GAP = 0.13;
const EDGE_LABEL_OFFSET = 0.012;
/** Points along each arrow's route, and rings along its tube. */
const ROUTE_SAMPLES = 17;
const TUBE_SEGMENTS = 24;
const TUBE_SIDES = 8;

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// Scratch objects reused by every edge, every frame.
const tmpPoint = new THREE.Vector3();
const tmpTangent = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpBinormal = new THREE.Vector3();
const tmpQuaternion = new THREE.Quaternion();

const GEOMETRIES = {
    sphere: new THREE.SphereGeometry(NODE_RADIUS, 32, 16),
    box: new THREE.BoxGeometry(0.085, 0.085, 0.085),
    cylinder: new THREE.CylinderGeometry(0.042, 0.042, 0.1, 32),
    cone: new THREE.ConeGeometry(0.055, 0.1, 32),
    capsule: new THREE.CapsuleGeometry(0.036, 0.05, 8, 16),
};
// A coin standing up, facing +Z.
const MEDALLION_BODY = new THREE.CylinderGeometry(MEDALLION_RADIUS, MEDALLION_RADIUS, MEDALLION_THICKNESS, 40)
    .rotateX(Math.PI / 2);
const MEDALLION_FACE = new THREE.CircleGeometry(MEDALLION_RADIUS * 0.9, 40);
// Arrow head with its tip at the origin, pointing along +Y.
const HEAD_GEOMETRY = new THREE.ConeGeometry(0.016, ARROW_LENGTH, 16).translate(0, -ARROW_LENGTH / 2, 0);
const EDGE_MATERIAL = new THREE.MeshStandardMaterial({ color: EDGE_COLOR, roughness: 0.6 });

function easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function setSpriteOpacity(sprite, opacity) {
    sprite.material.opacity = opacity;
}

/** ROUTE_SAMPLES points from `start` to `end`, through `bends` if there are any. */
function sampleRoute(start, bends, end) {
    if (!bends.length) {
        return Array.from({ length: ROUTE_SAMPLES }, (_, i) => new THREE.Vector3().lerpVectors(start, end, i / (ROUTE_SAMPLES - 1)));
    }
    const curve = new THREE.CatmullRomCurve3([start.clone(), ...bends, end.clone()], false, "centripetal");
    return curve.getSpacedPoints(ROUTE_SAMPLES - 1);
}

/** Cumulative lengths along a polyline. */
function arcLengths(points) {
    const lengths = [0];
    for (let i = 1; i < points.length; i += 1) {
        lengths.push(lengths[i - 1] + points[i].distanceTo(points[i - 1]));
    }
    return lengths;
}

/** The point at arc length `s` along `points`, written into `out`; also its tangent. */
function pointAt(points, lengths, s, out, tangent) {
    const total = lengths[lengths.length - 1];
    const clamped = Math.min(Math.max(s, 0), total);
    let i = 1;
    while (i < lengths.length - 1 && lengths[i] < clamped) {
        i += 1;
    }
    const span = lengths[i] - lengths[i - 1] || 1;
    const t = (clamped - lengths[i - 1]) / span;
    out.lerpVectors(points[i - 1], points[i], t);
    tangent?.subVectors(points[i], points[i - 1]).normalize();
    return out;
}

/** An open tube of TUBE_SEGMENTS rings, filled in later by writeTube(). */
function createTubeGeometry() {
    const rings = TUBE_SEGMENTS + 1;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(rings * TUBE_SIDES * 3), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(rings * TUBE_SIDES * 3), 3));
    const index = [];
    for (let ring = 0; ring < TUBE_SEGMENTS; ring += 1) {
        for (let side = 0; side < TUBE_SIDES; side += 1) {
            const a = ring * TUBE_SIDES + side;
            const b = ring * TUBE_SIDES + ((side + 1) % TUBE_SIDES);
            const c = a + TUBE_SIDES;
            const d = b + TUBE_SIDES;
            index.push(a, c, b, b, c, d);
        }
    }
    geometry.setIndex(index);
    return geometry;
}

/** Rewrites the tube to run along `points` (TUBE_SEGMENTS + 1 of them). */
function writeTube(geometry, points) {
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    for (let ring = 0; ring < points.length; ring += 1) {
        const previous = points[Math.max(0, ring - 1)];
        const next = points[Math.min(points.length - 1, ring + 1)];
        tmpTangent.subVectors(next, previous).normalize();
        // The diagram is nearly flat in X/Y: Z is a steady reference for the ring.
        tmpNormal.crossVectors(tmpTangent, Math.abs(tmpTangent.z) > 0.9 ? Y_AXIS : Z_AXIS).normalize();
        tmpBinormal.crossVectors(tmpTangent, tmpNormal);
        for (let side = 0; side < TUBE_SIDES; side += 1) {
            const angle = (side / TUBE_SIDES) * Math.PI * 2;
            const nx = Math.cos(angle) * tmpNormal.x + Math.sin(angle) * tmpBinormal.x;
            const ny = Math.cos(angle) * tmpNormal.y + Math.sin(angle) * tmpBinormal.y;
            const nz = Math.cos(angle) * tmpNormal.z + Math.sin(angle) * tmpBinormal.z;
            const k = ring * TUBE_SIDES + side;
            normal.setXYZ(k, nx, ny, nz);
            position.setXYZ(k, points[ring].x + nx * SHAFT_RADIUS, points[ring].y + ny * SHAFT_RADIUS, points[ring].z + nz * SHAFT_RADIUS);
        }
    }
    position.needsUpdate = true;
    normal.needsUpdate = true;
}

export class DiagramView {
    /**
     * @param {object} [options]
     * @param {number} [options.maxWidth] meters
     * @param {number} [options.maxHeight] meters
     * @param {(worldPoint: THREE.Vector3) => void} [options.onReveal] where the
     *        elements of each new step will stand (the center of them), in world space
     */
    constructor({ maxWidth = 1.2, maxHeight = 0.8, onReveal = null } = {}) {
        this.layoutOptions = { maxWidth, maxHeight };
        this.onReveal = onReveal;
        this.group = new THREE.Group();
        this.group.name = "diagram";
        /** @type {Map<string, object>} */
        this.nodes = new Map();
        this.edges = [];
        this.title = null;
        this.titleY = { from: 0, to: 0, t: 1 };
        /** Extent of the nodes in the group's frame, null while empty. */
        this.bounds = null;
        this.time = 0;
        this.shaftPoints = Array.from({ length: TUBE_SEGMENTS + 1 }, () => new THREE.Vector3());
    }

    clear() {
        for (const node of this.nodes.values()) {
            for (const material of node.materials) {
                material.map?.dispose();
                material.dispose();
            }
            disposeSprite(node.label);
        }
        for (const edge of this.edges) {
            edge.shaft.geometry.dispose();
            if (edge.label) {
                disposeSprite(edge.label);
            }
        }
        if (this.title) {
            disposeSprite(this.title);
        }
        this.group.clear();
        this.nodes.clear();
        this.edges = [];
        this.title = null;
        this.bounds = null;
    }

    setTitle(text) {
        if (this.title) {
            this.group.remove(this.title);
            disposeSprite(this.title);
        }
        this.title = createTextSprite(text, {
            lineHeight: 0.06,
            maxChars: 0,
            weight: 700,
            background: null,
            anchor: [0.5, 0],
        });
        this.title.position.y = this.titleY.to;
        setSpriteOpacity(this.title, 0);
        this.title.userData.fade = 0;
        this.group.add(this.title);
    }

    /**
     * Adds the elements of one step. Edges whose nodes are not on screen yet
     * are skipped (the server never sends those).
     *
     * @param {{nodes?: object[], edges?: object[]}} elements
     */
    reveal({ nodes = [], edges = [] }) {
        const added = [];
        for (const data of nodes) {
            if (!this.nodes.has(data.id)) {
                const node = this.#createNode(data);
                this.nodes.set(data.id, node);
                added.push(node);
            }
        }
        const addedEdges = [];
        for (const data of edges) {
            const from = this.nodes.get(data.from);
            const to = this.nodes.get(data.to);
            if (from && to) {
                const edge = this.#createEdge(data, from, to);
                this.edges.push(edge);
                addedEdges.push(edge);
            }
        }
        this.#relayout();
        this.#announce(added, addedEdges);
    }

    /** Tells onReveal where the new elements stand once the layout settles. */
    #announce(nodes, edges) {
        if (!this.onReveal) {
            return;
        }
        const points = nodes.length
            ? nodes.map((node) => node.to)
            : edges.map((edge) => edge.route.to[Math.floor(ROUTE_SAMPLES / 2)]);
        if (!points.length) {
            return;
        }
        const center = new THREE.Vector3();
        for (const point of points) {
            center.add(point);
        }
        center.divideScalar(points.length);
        this.group.updateWorldMatrix(true, false);
        this.onReveal(this.group.localToWorld(center));
    }

    /** Advances every animation; call once per frame. */
    update(dt) {
        this.time += dt;
        for (const node of this.nodes.values()) {
            node.appear = Math.min(1, node.appear + dt / APPEAR_SECONDS);
            const scale = Math.max(0.0001, easeOutBack(node.appear));
            node.group.scale.setScalar(scale);
            setSpriteOpacity(node.label, Math.min(1, node.appear * 1.6));

            node.move = Math.min(1, node.move + dt / MOVE_SECONDS);
            node.group.position.lerpVectors(node.from, node.to, easeInOutCubic(node.move));
            if (node.medallion) {
                // Sway, never edge-on: the emoji stays readable.
                node.mesh.rotation.y = Math.sin(this.time * 0.9 + node.phase) * 0.4;
            } else {
                node.mesh.rotation.y += dt * 0.35;
            }
        }
        for (const edge of this.edges) {
            edge.wait -= dt;
            if (edge.wait <= 0) {
                edge.grow = Math.min(1, edge.grow + dt / EDGE_GROW_SECONDS);
            }
            edge.route.t = Math.min(1, edge.route.t + dt / MOVE_SECONDS);
            if (!edge.settled) {
                this.#placeEdge(edge);
                // Grown and in place: nothing changes until the next relayout.
                edge.settled = edge.grow >= 1 && edge.route.t >= 1;
            }
        }
        if (this.title) {
            this.titleY.t = Math.min(1, this.titleY.t + dt / MOVE_SECONDS);
            const k = easeInOutCubic(this.titleY.t);
            this.title.position.y = this.titleY.from + (this.titleY.to - this.titleY.from) * k;
            this.title.userData.fade = Math.min(1, this.title.userData.fade + dt / APPEAR_SECONDS);
            setSpriteOpacity(this.title, this.title.userData.fade);
        }
    }

    #createNode(data) {
        const color = new THREE.Color(data.color);
        const body = new THREE.MeshStandardMaterial({
            color,
            roughness: 0.45,
            metalness: 0.05,
            emissive: color,
            emissiveIntensity: 0.12,
        });
        let mesh;
        const materials = [body];
        if (data.icon) {
            const texture = createEmojiTexture(data.icon, data.color);
            const faceMaterial = new THREE.MeshStandardMaterial({
                map: texture,
                emissive: 0xFFFFFF,
                emissiveMap: texture,
                emissiveIntensity: 0.35,
                roughness: 0.55,
            });
            materials.push(faceMaterial);
            const front = new THREE.Mesh(MEDALLION_FACE, faceMaterial);
            front.position.z = MEDALLION_THICKNESS / 2 + 0.0006;
            const back = new THREE.Mesh(MEDALLION_FACE, faceMaterial);
            back.position.z = -front.position.z;
            back.rotation.y = Math.PI; // reads the right way round from behind
            mesh = new THREE.Group();
            mesh.add(new THREE.Mesh(MEDALLION_BODY, body), front, back);
        } else {
            mesh = new THREE.Mesh(GEOMETRIES[data.shape] ?? GEOMETRIES.box, body);
            mesh.rotation.set(0.25, Math.random() * Math.PI, 0);
        }
        const label = createTextSprite(data.label, { anchor: [0.5, 1], onTop: true });
        label.position.y = -(data.icon ? MEDALLION_RADIUS : NODE_RADIUS) - 0.022;
        label.renderOrder = 2;
        const group = new THREE.Group();
        group.name = `node:${data.id}`;
        group.add(mesh, label);
        group.scale.setScalar(0.0001);
        this.group.add(group);
        return {
            data,
            group,
            mesh,
            materials,
            medallion: Boolean(data.icon),
            phase: Math.random() * Math.PI * 2,
            label,
            appear: 0,
            move: 1,
            placed: false,
            from: new THREE.Vector3(),
            to: new THREE.Vector3(),
        };
    }

    #createEdge(data, from, to) {
        const shaft = new THREE.Mesh(createTubeGeometry(), EDGE_MATERIAL);
        shaft.frustumCulled = false; // its vertices move every frame
        const head = new THREE.Mesh(HEAD_GEOMETRY, EDGE_MATERIAL);
        shaft.visible = false;
        head.visible = false;
        this.group.add(shaft, head);
        let label = null;
        if (data.label) {
            label = createTextSprite(data.label, {
                lineHeight: 0.024,
                maxChars: 0,
                color: "#CFD8E3",
                background: "rgba(16, 19, 24, 0.6)",
                weight: 400,
                onTop: true,
            });
            label.renderOrder = 1;
            setSpriteOpacity(label, 0);
            this.group.add(label);
        }
        // Wait until both ends have popped in before growing.
        const wait = Math.max(0, (1 - Math.min(from.appear, to.appear)) * APPEAR_SECONDS) + EDGE_DELAY_SECONDS;
        return {
            data,
            from,
            to,
            shaft,
            head,
            label,
            grow: 0,
            wait,
            settled: false,
            // `from` and `to` hold sampled routes; `current` is drawn.
            route: { from: [], to: [], current: [], t: 1, new: true },
        };
    }

    #placeEdge(edge) {
        const { route } = edge;
        const k = easeInOutCubic(route.t);
        for (let i = 0; i < ROUTE_SAMPLES; i += 1) {
            route.current[i].lerpVectors(route.from[i], route.to[i], k);
        }
        const points = route.current;
        const lengths = arcLengths(points);
        const usable = lengths[lengths.length - 1] - EDGE_GAP * 2;
        if (edge.grow <= 0 || usable <= ARROW_LENGTH) {
            edge.shaft.visible = false;
            edge.head.visible = false;
            if (edge.label) {
                setSpriteOpacity(edge.label, 0);
            }
            return;
        }
        const length = usable * easeInOutCubic(edge.grow);
        const start = EDGE_GAP;
        const tip = EDGE_GAP + length;
        const shaftEnd = tip - ARROW_LENGTH * 0.9;

        edge.shaft.visible = shaftEnd > start;
        if (edge.shaft.visible) {
            for (let i = 0; i <= TUBE_SEGMENTS; i += 1) {
                pointAt(points, lengths, start + ((shaftEnd - start) * i) / TUBE_SEGMENTS, this.shaftPoints[i]);
            }
            writeTube(edge.shaft.geometry, this.shaftPoints);
        }

        edge.head.visible = length > ARROW_LENGTH;
        pointAt(points, lengths, tip, edge.head.position, tmpTangent);
        edge.head.quaternion.copy(tmpQuaternion.setFromUnitVectors(Y_AXIS, tmpTangent));

        if (edge.label) {
            // Beside the arrow at its middle, never on it: offset along the
            // normal that points up (or right, for a vertical stretch).
            pointAt(points, lengths, EDGE_GAP + usable / 2, tmpPoint, tmpTangent);
            let nx = -tmpTangent.y;
            let ny = tmpTangent.x;
            if (ny < -1e-3 || (Math.abs(ny) <= 1e-3 && nx < 0)) {
                nx = -nx;
                ny = -ny;
            }
            const norm = Math.hypot(nx, ny) || 1;
            nx /= norm;
            ny /= norm;
            edge.label.position.copy(tmpPoint);
            edge.label.position.x += nx * EDGE_LABEL_OFFSET;
            edge.label.position.y += ny * EDGE_LABEL_OFFSET;
            edge.label.center.set(0.5 - nx * 0.5, 0.5 - ny * 0.5);
            setSpriteOpacity(edge.label, edge.grow);
        }
    }

    #relayout() {
        const nodes = [...this.nodes.values()].map((node) => node.data);
        const edges = this.edges.map((edge) => edge.data);
        const { positions, routes, bounds } = layoutDiagram(nodes, edges, this.layoutOptions);
        this.bounds = nodes.length ? bounds : null;
        for (const node of this.nodes.values()) {
            const target = positions.get(node.data.id);
            if (!node.placed) {
                // New nodes pop in where they belong; only existing ones glide.
                node.to.set(target.x, target.y, target.z);
                node.from.copy(node.to);
                node.group.position.copy(node.to);
                node.placed = true;
                continue;
            }
            node.from.copy(node.group.position);
            node.to.set(target.x, target.y, target.z);
            node.move = 0;
        }
        for (const edge of this.edges) {
            const bends = (routes.get(edgeKey(edge.data)) ?? []).map((p) => new THREE.Vector3(p.x, p.y, p.z));
            const target = sampleRoute(edge.from.to, bends, edge.to.to);
            const { route } = edge;
            if (route.new) {
                // A new arrow starts on its final route; it grows instead of gliding.
                route.from = target.map((p) => p.clone());
                route.current = target.map((p) => p.clone());
                route.new = false;
                route.t = 1;
            } else {
                route.from = route.current.map((p) => p.clone());
                route.t = 0;
            }
            route.to = target;
            edge.settled = false;
        }
        const titleTarget = bounds.maxY + TITLE_GAP;
        this.titleY = {
            from: this.title ? this.title.position.y : titleTarget,
            to: titleTarget,
            t: this.title ? 0 : 1,
        };
    }
}
