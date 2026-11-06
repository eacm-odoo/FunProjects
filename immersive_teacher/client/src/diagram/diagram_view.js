/**
 * The 3D diagram: nodes as primitives with a label, edges as arrows that grow
 * from their source, and a title on top.
 *
 * `reveal()` adds the elements of one step. Every reveal recomputes the
 * layout of what is visible, and the nodes already on screen glide to their
 * new place, so the diagram visibly builds up as the teacher talks.
 */

import * as THREE from "three";

import { createTextSprite, disposeSprite } from "./labels.js";
import { layoutDiagram } from "./layout.js";

const NODE_RADIUS = 0.055;
const APPEAR_SECONDS = 0.5;
const MOVE_SECONDS = 0.45;
const EDGE_GROW_SECONDS = 0.55;
const EDGE_DELAY_SECONDS = 0.2;
const ARROW_LENGTH = 0.035;
const EDGE_COLOR = 0xB8C2CC;
const TITLE_GAP = 0.13;
const EDGE_LABEL_OFFSET = 0.012;

const Y_AXIS = new THREE.Vector3(0, 1, 0);
// Scratch objects reused by every edge, every frame.
const tmpDirection = new THREE.Vector3();
const tmpOrigin = new THREE.Vector3();
const tmpQuaternion = new THREE.Quaternion();

const GEOMETRIES = {
    sphere: new THREE.SphereGeometry(NODE_RADIUS, 32, 16),
    box: new THREE.BoxGeometry(0.085, 0.085, 0.085),
    cylinder: new THREE.CylinderGeometry(0.042, 0.042, 0.1, 32),
    cone: new THREE.ConeGeometry(0.055, 0.1, 32),
    capsule: new THREE.CapsuleGeometry(0.036, 0.05, 8, 16),
};
// Unit-length shaft with its base at the origin, scaled along Y to the edge length.
const SHAFT_GEOMETRY = new THREE.CylinderGeometry(0.0055, 0.0055, 1, 8).translate(0, 0.5, 0);
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
    }

    clear() {
        for (const node of this.nodes.values()) {
            node.material.dispose();
            disposeSprite(node.label);
        }
        for (const edge of this.edges) {
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
            : edges.map((edge) => new THREE.Vector3().addVectors(edge.from.to, edge.to.to).multiplyScalar(0.5));
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
        for (const node of this.nodes.values()) {
            node.appear = Math.min(1, node.appear + dt / APPEAR_SECONDS);
            const scale = Math.max(0.0001, easeOutBack(node.appear));
            node.group.scale.setScalar(scale);
            setSpriteOpacity(node.label, Math.min(1, node.appear * 1.6));

            node.move = Math.min(1, node.move + dt / MOVE_SECONDS);
            node.group.position.lerpVectors(node.from, node.to, easeInOutCubic(node.move));
            node.mesh.rotation.y += dt * 0.35;
        }
        for (const edge of this.edges) {
            edge.wait -= dt;
            if (edge.wait <= 0) {
                edge.grow = Math.min(1, edge.grow + dt / EDGE_GROW_SECONDS);
            }
            this.#placeEdge(edge);
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
        const material = new THREE.MeshStandardMaterial({
            color,
            roughness: 0.45,
            metalness: 0.05,
            emissive: color,
            emissiveIntensity: 0.12,
        });
        const mesh = new THREE.Mesh(GEOMETRIES[data.shape] ?? GEOMETRIES.box, material);
        mesh.rotation.set(0.25, Math.random() * Math.PI, 0);
        const label = createTextSprite(data.label, { anchor: [0.5, 1], onTop: true });
        label.position.y = -NODE_RADIUS - 0.022;
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
            material,
            label,
            appear: 0,
            move: 1,
            placed: false,
            from: new THREE.Vector3(),
            to: new THREE.Vector3(),
        };
    }

    #createEdge(data, from, to) {
        const shaft = new THREE.Mesh(SHAFT_GEOMETRY, EDGE_MATERIAL);
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
        return { data, from, to, shaft, head, label, grow: 0, wait };
    }

    #placeEdge(edge) {
        const start = edge.from.group.position;
        const end = edge.to.group.position;
        const direction = tmpDirection.subVectors(end, start);
        const distance = direction.length();
        const gap = NODE_RADIUS + 0.012;
        const usable = distance - gap * 2;
        if (edge.grow <= 0 || usable <= ARROW_LENGTH) {
            edge.shaft.visible = false;
            edge.head.visible = false;
            if (edge.label) {
                setSpriteOpacity(edge.label, 0);
            }
            return;
        }
        direction.divideScalar(distance);
        const length = usable * easeInOutCubic(edge.grow);
        const origin = tmpOrigin.copy(start).addScaledVector(direction, gap);
        const quaternion = tmpQuaternion.setFromUnitVectors(Y_AXIS, direction);

        edge.shaft.visible = true;
        edge.shaft.position.copy(origin);
        edge.shaft.quaternion.copy(quaternion);
        edge.shaft.scale.set(1, Math.max(0.0001, length - ARROW_LENGTH * 0.9), 1);

        edge.head.visible = length > ARROW_LENGTH;
        edge.head.position.copy(origin).addScaledVector(direction, length);
        edge.head.quaternion.copy(quaternion);

        if (edge.label) {
            // Beside the line, never on it: offset along the normal that points
            // up (or right, for a vertical edge) and anchor the sprite on that side.
            let nx = -direction.y;
            let ny = direction.x;
            if (ny < -1e-3 || (Math.abs(ny) <= 1e-3 && nx < 0)) {
                nx = -nx;
                ny = -ny;
            }
            const norm = Math.hypot(nx, ny) || 1;
            nx /= norm;
            ny /= norm;
            edge.label.position.copy(origin).addScaledVector(direction, usable / 2);
            edge.label.position.x += nx * EDGE_LABEL_OFFSET;
            edge.label.position.y += ny * EDGE_LABEL_OFFSET;
            edge.label.center.set(0.5 - nx * 0.5, 0.5 - ny * 0.5);
            setSpriteOpacity(edge.label, edge.grow);
        }
    }

    #relayout() {
        const nodes = [...this.nodes.values()].map((node) => node.data);
        const edges = this.edges.map((edge) => edge.data);
        const { positions, bounds } = layoutDiagram(nodes, edges, this.layoutOptions);
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
        const titleTarget = bounds.maxY + TITLE_GAP;
        this.titleY = {
            from: this.title ? this.title.position.y : titleTarget,
            to: titleTarget,
            t: this.title ? 0 : 1,
        };
    }
}
