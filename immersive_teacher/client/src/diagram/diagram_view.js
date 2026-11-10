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
 *
 * Going deeper into a node (see exploration.js):
 *
 *   hit() / setHover()  what a ray or the mouse points at: a node (once the
 *                       diagram is `interactive`) or the "‹ parent" label
 *   focus(id)           the other nodes shrink away, the arrows pull back, and
 *                       the chosen node glides to the center with a pulse;
 *                       the deeper answer then builds up around it
 *   show(diagram)       back to a finished diagram: nodes it shares with what
 *                       is on screen glide to their place, the rest pop in or
 *                       out
 *   setMarks()          a beating "?" on nodes with a question left open, a
 *                       green ring and "✓" on the ones already explored
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
/** Leaving: nodes shrink one after the other, arrows pull back, the title fades. */
const VANISH_SECONDS = 0.35;
const VANISH_STAGGER = 0.04;
const EDGE_RETRACT_SECONDS = 0.3;
const TITLE_FADE_SECONDS = 0.3;
/** The chosen node swells once on its way to the center. */
const PULSE_SECONDS = 0.6;
const PULSE_SCALE = 0.35;
const HOVER_SECONDS = 0.08;
const HOVER_SCALE = 0.12;
/** Where a node's badge sits, from its center (top right). */
const BADGE_OFFSET = 0.056;
/** The "‹ parent" label, above the title line. */
const BACK_GAP = 0.09;
const BACK_MAX_CHARS = 32;
/** What the rays and the mouse hit for the "‹ parent" label. */
export const BACK_ID = "<back>";

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
// Invisible boxes the rays hit: a node's body and its label, and the "‹ parent" label.
const NODE_HIT_GEOMETRY = new THREE.BoxGeometry(0.17, 0.2, 0.08).translate(0, -0.03, 0);
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const HIT_MATERIAL = new THREE.MeshBasicMaterial();
// The ring around an explored node, facing the viewer like the medallions.
const RING_GEOMETRY = new THREE.TorusGeometry(0.08, 0.0045, 8, 48);
const RING_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x4ADE80 });
const BADGES = Object.freeze({
    hook: { text: "?", color: "#101318", background: "#F5B700" },
    explored: { text: "✓", color: "#FFFFFF", background: "#2F8F3A" },
});

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

function approach(current, target, seconds, dt) {
    return current + (target - current) * (1 - Math.exp(-dt / seconds));
}

/** Same id, same look: a node of the diagram shown next can stay on screen and glide. */
function sameLook(a, b) {
    return a.id === b.id && a.label === b.label && a.icon === b.icon && a.color === b.color && a.shape === b.shape;
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
        /** Height of the title line right now, null while empty. */
        this.titleYNow = null;
        /** Extent of the nodes in the group's frame, null while empty. */
        this.bounds = null;
        this.time = 0;
        this.shaftPoints = Array.from({ length: TUBE_SEGMENTS + 1 }, () => new THREE.Vector3());
        /** Nodes, arrows and titles on their way out, disposed once gone. */
        this.leaving = [];
        /** The "‹ parent" label, null at the top of a chain. */
        this.back = null;
        /** Whether hit() reports nodes: once the diagram is finished. */
        this.interactive = false;
    }

    clear() {
        for (const node of this.nodes.values()) {
            this.#disposeNode(node);
        }
        for (const edge of this.edges) {
            this.#disposeEdge(edge);
        }
        for (const item of this.leaving) {
            this.#disposeLeaving(item);
        }
        if (this.title) {
            disposeSprite(this.title);
        }
        this.#setBack(null);
        this.group.clear();
        this.nodes.clear();
        this.edges = [];
        this.leaving = [];
        this.title = null;
        this.titleY = { from: 0, to: 0, t: 1 };
        this.titleYNow = null;
        this.bounds = null;
        this.interactive = false;
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
        this.title.userData.text = text;
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

    /**
     * Starts going deeper into node `id`: everything else leaves, and the node
     * glides to the center, where the deeper answer will build up around it.
     *
     * @param {string} id
     * @param {string|null} [parentTitle] for the "‹ parent" label
     * @returns {boolean} false when that node is not on screen (the diagram is then empty)
     */
    focus(id, parentTitle = null) {
        const kept = this.nodes.get(id) ?? null;
        let order = 0;
        for (const node of this.nodes.values()) {
            if (node !== kept) {
                this.#dismissNode(node, order * VANISH_STAGGER);
                order += 1;
            }
        }
        for (const edge of this.edges) {
            this.#dismissEdge(edge);
        }
        this.edges = [];
        this.nodes = kept ? new Map([[id, kept]]) : new Map();
        this.#dismissTitle();
        this.#setBack(parentTitle);
        this.interactive = false;
        if (kept) {
            this.#setBadge(kept, null);
            kept.hoverTarget = 0;
            kept.pulse = PULSE_SECONDS;
        }
        this.#relayout();
        if (kept) {
            this.group.updateWorldMatrix(true, false);
            this.onReveal?.(this.group.localToWorld(kept.to.clone()));
        }
        return Boolean(kept);
    }

    /**
     * Shows a finished diagram (as `done` sent it) in place of what is on
     * screen. A node with the same id and look stays and glides to its place.
     *
     * @param {{title: string, nodes: object[], edges: object[]}} diagram
     * @param {object} [options]
     * @param {string|null} [options.parentTitle] for the "‹ parent" label
     * @param {Iterable<string>} [options.hooks] nodes that get a "?"
     * @param {Iterable<string>} [options.explored] nodes that get a "✓"
     */
    show(diagram, { parentTitle = null, hooks = [], explored = [] } = {}) {
        const current = this.nodes;
        this.nodes = new Map();
        for (const data of diagram.nodes) {
            const node = current.get(data.id);
            if (node && sameLook(node.data, data)) {
                node.data = data;
                node.hoverTarget = 0;
                current.delete(data.id);
                this.nodes.set(data.id, node);
            } else {
                this.nodes.set(data.id, this.#createNode(data));
            }
        }
        let order = 0;
        for (const node of current.values()) {
            this.#dismissNode(node, order * VANISH_STAGGER);
            order += 1;
        }
        for (const edge of this.edges) {
            this.#dismissEdge(edge);
        }
        this.edges = [];
        for (const data of diagram.edges) {
            const from = this.nodes.get(data.from);
            const to = this.nodes.get(data.to);
            if (from && to) {
                this.edges.push(this.#createEdge(data, from, to));
            }
        }
        if (this.title?.userData.text !== diagram.title) {
            this.#dismissTitle();
            if (diagram.title) {
                this.setTitle(diagram.title);
            }
        }
        this.#setBack(parentTitle);
        this.setMarks({ hooks, explored });
        this.#relayout();
        this.interactive = true;
    }

    /** The badges: "?" on `hooks`, "✓" and a ring on `explored` (which wins). */
    setMarks({ hooks = [], explored = [] } = {}) {
        const open = new Set(hooks);
        const done = new Set(explored);
        for (const node of this.nodes.values()) {
            const id = node.data.id;
            this.#setBadge(node, done.has(id) ? "explored" : open.has(id) ? "hook" : null);
        }
    }

    /**
     * @param {THREE.Raycaster} raycaster
     * @returns {{id: string, distance: number}|null} the nearest node (only while
     *          `interactive`) or BACK_ID for the "‹ parent" label
     */
    hit(raycaster) {
        const targets = [];
        if (this.interactive) {
            for (const node of this.nodes.values()) {
                if (node.appear > 0.5) {
                    targets.push(node.hitArea);
                }
            }
        }
        if (this.back) {
            targets.push(this.back.hitArea);
        }
        if (!targets.length) {
            return null;
        }
        const [nearest] = raycaster.intersectObjects(targets, false);
        return nearest ? { id: nearest.object.userData.id, distance: nearest.distance } : null;
    }

    /** @param {Set<string>} ids what some ray or the mouse points at right now */
    setHover(ids) {
        for (const node of this.nodes.values()) {
            node.hoverTarget = ids.has(node.data.id) ? 1 : 0;
        }
        if (this.back) {
            this.back.hoverTarget = ids.has(BACK_ID) ? 1 : 0;
        }
    }

    /** The node's data (its label, its hook) by id, or null. */
    nodeData(id) {
        return this.nodes.get(id)?.data ?? null;
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
            node.hover = approach(node.hover, node.hoverTarget, HOVER_SECONDS, dt);
            node.pulse = Math.max(0, node.pulse - dt);
            const pulse = node.pulse > 0 ? 1 + PULSE_SCALE * Math.sin(Math.PI * (1 - node.pulse / PULSE_SECONDS)) : 1;
            const scale = Math.max(0.0001, easeOutBack(node.appear)) * (1 + HOVER_SCALE * node.hover) * pulse;
            node.group.scale.setScalar(scale);
            node.materials[0].emissiveIntensity = 0.12 + 0.3 * node.hover;
            setSpriteOpacity(node.label, Math.min(1, node.appear * 1.6));

            node.move = Math.min(1, node.move + dt / MOVE_SECONDS);
            node.group.position.lerpVectors(node.from, node.to, easeInOutCubic(node.move));
            if (node.medallion) {
                // Sway, never edge-on: the emoji stays readable.
                node.mesh.rotation.y = Math.sin(this.time * 0.9 + node.phase) * 0.4;
            } else {
                node.mesh.rotation.y += dt * 0.35;
            }
            if (node.badge) {
                // The "?" beats, to be noticed; the "✓" stays still.
                const beat = node.badgeKind === "hook" ? 1 + 0.16 * Math.max(0, Math.sin(this.time * 4 + node.phase)) : 1;
                node.badge.scale.copy(node.badge.userData.size).multiplyScalar(beat);
                setSpriteOpacity(node.badge, Math.min(1, node.badge.material.opacity + dt / APPEAR_SECONDS));
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
        this.leaving = this.leaving.filter((item) => !this.#updateLeaving(item, dt));

        this.titleY.t = Math.min(1, this.titleY.t + dt / MOVE_SECONDS);
        const k = easeInOutCubic(this.titleY.t);
        this.titleYNow = this.titleY.from + (this.titleY.to - this.titleY.from) * k;
        if (this.title) {
            this.title.position.y = this.titleYNow;
            this.title.userData.fade = Math.min(1, this.title.userData.fade + dt / APPEAR_SECONDS);
            setSpriteOpacity(this.title, this.title.userData.fade);
        }
        if (this.back) {
            const back = this.back;
            back.fade = Math.min(1, back.fade + dt / APPEAR_SECONDS);
            back.hover = approach(back.hover, back.hoverTarget, HOVER_SECONDS, dt);
            setSpriteOpacity(back.sprite, back.fade * (0.75 + 0.25 * back.hover));
            back.holder.scale.setScalar(1 + 0.06 * back.hover);
            back.holder.position.y = this.titleYNow + BACK_GAP;
        }
    }

    /** One frame of something leaving; true once it is gone and disposed. */
    #updateLeaving(item, dt) {
        if (item.node) {
            item.wait -= dt;
            if (item.wait > 0) {
                return false;
            }
            item.vanish = Math.min(1, item.vanish + dt / VANISH_SECONDS);
            const k = 1 - easeInOutCubic(item.vanish);
            item.node.group.scale.setScalar(Math.max(0.0001, item.scale * k));
            setSpriteOpacity(item.node.label, k);
        } else if (item.edge) {
            item.edge.grow = Math.max(0, item.edge.grow - dt / EDGE_RETRACT_SECONDS);
            this.#placeEdge(item.edge);
            item.vanish = item.edge.grow <= 0 ? 1 : 0;
        } else {
            item.vanish = Math.min(1, item.vanish + dt / TITLE_FADE_SECONDS);
            setSpriteOpacity(item.sprite, item.opacity * (1 - item.vanish));
        }
        if (item.vanish < 1) {
            return false;
        }
        this.#disposeLeaving(item);
        return true;
    }

    #dismissNode(node, wait) {
        node.hoverTarget = 0;
        this.leaving.push({ node, wait, vanish: 0, scale: node.group.scale.x });
    }

    #dismissEdge(edge) {
        this.leaving.push({ edge, vanish: 0 });
    }

    #dismissTitle() {
        if (this.title) {
            this.leaving.push({ sprite: this.title, vanish: 0, opacity: this.title.material.opacity });
            this.title = null;
        }
    }

    #disposeLeaving(item) {
        if (item.node) {
            this.group.remove(item.node.group);
            this.#disposeNode(item.node);
        } else if (item.edge) {
            this.group.remove(item.edge.shaft, item.edge.head);
            if (item.edge.label) {
                this.group.remove(item.edge.label);
            }
            this.#disposeEdge(item.edge);
        } else {
            this.group.remove(item.sprite);
            disposeSprite(item.sprite);
        }
    }

    #disposeNode(node) {
        for (const material of node.materials) {
            material.map?.dispose();
            material.dispose();
        }
        disposeSprite(node.label);
        if (node.badge) {
            disposeSprite(node.badge);
        }
    }

    #disposeEdge(edge) {
        edge.shaft.geometry.dispose();
        if (edge.label) {
            disposeSprite(edge.label);
        }
    }

    /** Puts the "?" or the "✓" (with its ring) on a node, or takes it off with null. */
    #setBadge(node, kind) {
        if (node.badgeKind === kind) {
            return;
        }
        if (node.badge) {
            node.group.remove(node.badge);
            disposeSprite(node.badge);
            node.badge = null;
        }
        if (node.ring) {
            node.group.remove(node.ring);
            node.ring = null;
        }
        node.badgeKind = kind;
        if (!kind) {
            return;
        }
        const { text, color, background } = BADGES[kind];
        const badge = createTextSprite(text, { lineHeight: 0.036, maxChars: 0, color, background, weight: 800, onTop: true });
        badge.renderOrder = 3;
        badge.position.set(BADGE_OFFSET, BADGE_OFFSET, 0.02);
        badge.userData.size = badge.scale.clone();
        setSpriteOpacity(badge, 0);
        node.badge = badge;
        node.group.add(badge);
        if (kind === "explored") {
            node.ring = new THREE.Mesh(RING_GEOMETRY, RING_MATERIAL);
            node.group.add(node.ring);
        }
    }

    /** The "‹ parent" label above the title, or none with null. */
    #setBack(title) {
        if (this.back) {
            this.group.remove(this.back.holder);
            disposeSprite(this.back.sprite);
            this.back = null;
        }
        if (!title) {
            return;
        }
        const text = title.length > BACK_MAX_CHARS ? `${title.slice(0, BACK_MAX_CHARS - 1).trimEnd()}…` : title;
        const sprite = createTextSprite(`‹ ${text}`, {
            lineHeight: 0.032,
            maxChars: 0,
            weight: 600,
            color: "#CFD8E3",
            background: "rgba(16, 19, 24, 0.7)",
            anchor: [0.5, 0],
            onTop: true,
        });
        sprite.renderOrder = 2;
        setSpriteOpacity(sprite, 0);
        const hitArea = new THREE.Mesh(UNIT_BOX, HIT_MATERIAL);
        hitArea.scale.set(sprite.scale.x, sprite.scale.y, 0.03);
        hitArea.position.y = sprite.scale.y / 2;
        hitArea.visible = false;
        hitArea.userData.id = BACK_ID;
        const holder = new THREE.Group();
        holder.name = "back";
        holder.add(sprite, hitArea);
        holder.position.y = (this.titleYNow ?? this.titleY.to) + BACK_GAP;
        this.group.add(holder);
        this.back = { holder, sprite, hitArea, fade: 0, hover: 0, hoverTarget: 0 };
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
        const hitArea = new THREE.Mesh(NODE_HIT_GEOMETRY, HIT_MATERIAL);
        hitArea.visible = false;
        hitArea.userData.id = data.id;
        const group = new THREE.Group();
        group.name = `node:${data.id}`;
        group.add(mesh, label, hitArea);
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
            hitArea,
            appear: 0,
            move: 1,
            placed: false,
            from: new THREE.Vector3(),
            to: new THREE.Vector3(),
            hover: 0,
            hoverTarget: 0,
            pulse: 0,
            badge: null,
            badgeKind: null,
            ring: null,
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
            from: this.titleYNow ?? titleTarget,
            to: titleTarget,
            t: this.titleYNow === null ? 1 : 0,
        };
    }
}
