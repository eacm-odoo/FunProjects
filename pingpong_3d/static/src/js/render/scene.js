/** @odoo-module **/

import * as THREE from "../../../lib/three/three.module.js";

import { HX, HZ, NET_H, NET_W, PADDLE_Z, R, TH, TL, TW } from "../engine/constants.js";

export const TRAIL_POINTS = 46;

export const CAMS = {
    player: { pos: [0, 1.95, 3.15], look: [0, 0.88, -0.20], label: "jugador" },
    alta: { pos: [0, 3.10, 2.45], look: [0, 0.80, -0.10], label: "alta" },
    lateral: { pos: [3.15, 1.85, 1.55], look: [0, 0.88, 0], label: "lateral" },
};

/**
 * Build the whole three.js scene and hand back the handles the view needs.
 *
 * Everything created here is tracked so `dispose()` can release it. Without
 * that, every mount/unmount leaks a WebGL context and browsers cap at about
 * sixteen of them.
 *
 * @param {HTMLElement} container the canvas is appended here
 */
export function buildScene(container) {
    const geometries = [];
    const materials = [];

    const geo = (g) => {
        geometries.push(g);
        return g;
    };
    const mat = (m) => {
        materials.push(m);
        return m;
    };

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#141017");
    scene.fog = new THREE.Fog("#141017", 8, 22);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.05, 100);

    scene.add(new THREE.HemisphereLight("#cfd6e6", "#2a2130", 0.85));
    const key = new THREE.DirectionalLight("#ffffff", 2.3);
    key.position.set(2.4, 5.2, 2.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -2.4;
    key.shadow.camera.right = 2.4;
    key.shadow.camera.top = 3.0;
    key.shadow.camera.bottom = -3.0;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 12;
    key.shadow.bias = -0.0006;
    scene.add(key);
    const rim = new THREE.DirectionalLight("#8fb8ff", 0.7);
    rim.position.set(-3, 2.6, -3.5);
    scene.add(rim);

    const M = {
        cloth: mat(new THREE.MeshStandardMaterial({ color: "#1d5a86", roughness: 0.86, metalness: 0.02 })),
        line: mat(new THREE.MeshStandardMaterial({ color: "#f4f6f8", roughness: 0.7 })),
        frame: mat(new THREE.MeshStandardMaterial({ color: "#171317", roughness: 0.55, metalness: 0.25 })),
        metal: mat(new THREE.MeshStandardMaterial({ color: "#8d8f96", roughness: 0.38, metalness: 0.85 })),
        net: mat(new THREE.MeshStandardMaterial({ color: "#e8e9ee", roughness: 0.9, transparent: true, opacity: 0.55, side: THREE.DoubleSide })),
        ball: mat(new THREE.MeshStandardMaterial({ color: "#fff4d6", roughness: 0.42, metalness: 0.0, emissive: "#3a2b12", emissiveIntensity: 0.35 })),
        seam: mat(new THREE.MeshStandardMaterial({ color: "#d8a03a", roughness: 0.5 })),
        rubber0: mat(new THREE.MeshStandardMaterial({ color: "#714B67", roughness: 0.78 })),
        rubber1: mat(new THREE.MeshStandardMaterial({ color: "#017E84", roughness: 0.78 })),
        blade: mat(new THREE.MeshStandardMaterial({ color: "#c99a63", roughness: 0.62 })),
        grip: mat(new THREE.MeshStandardMaterial({ color: "#2a2228", roughness: 0.75 })),
        floor: mat(new THREE.MeshStandardMaterial({ color: "#221b26", roughness: 0.95 })),
    };

    const floor = new THREE.Mesh(geo(new THREE.CircleGeometry(11, 64)), M.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // ------------------------------------------------------------ table
    const table = new THREE.Group();
    scene.add(table);
    const top = new THREE.Mesh(geo(new THREE.BoxGeometry(TW, 0.03, TL)), M.cloth);
    top.position.y = TH - 0.015;
    top.receiveShadow = true;
    top.castShadow = true;
    table.add(top);

    const addLine = (w, l, x, z) => {
        const m = new THREE.Mesh(geo(new THREE.BoxGeometry(w, 0.004, l)), M.line);
        m.position.set(x, TH + 0.001, z);
        table.add(m);
    };
    addLine(0.02, TL, -HX + 0.01, 0);
    addLine(0.02, TL, HX - 0.01, 0);
    addLine(TW, 0.02, 0, -HZ + 0.01);
    addLine(TW, 0.02, 0, HZ - 0.01);
    addLine(0.015, TL, 0, 0);

    for (const s of [-1, 1]) {
        const apron = new THREE.Mesh(geo(new THREE.BoxGeometry(0.06, TH - 0.03, 0.06)), M.frame);
        apron.position.set(0, (TH - 0.03) / 2, s * (HZ - 0.06));
        table.add(apron);
        for (const sx of [-1, 1]) {
            const leg = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.028, 0.032, TH - 0.04, 20)), M.metal);
            leg.position.set(sx * (HX - 0.12), (TH - 0.04) / 2, s * (HZ - 0.22));
            leg.castShadow = true;
            table.add(leg);
        }
        const rail = new THREE.Mesh(geo(new THREE.BoxGeometry(TW - 0.16, 0.05, 0.05)), M.frame);
        rail.position.set(0, TH - 0.22, s * (HZ - 0.22));
        table.add(rail);
    }

    const netMesh = new THREE.Mesh(geo(new THREE.PlaneGeometry(NET_W, NET_H)), M.net);
    netMesh.position.set(0, TH + NET_H / 2, 0);
    table.add(netMesh);
    const netTape = new THREE.Mesh(geo(new THREE.BoxGeometry(NET_W, 0.014, 0.008)), M.line);
    netTape.position.set(0, TH + NET_H, 0);
    table.add(netTape);
    for (const sx of [-1, 1]) {
        const post = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.011, 0.011, NET_H + 0.02, 16)), M.metal);
        post.position.set((sx * NET_W) / 2, TH + (NET_H + 0.02) / 2, 0);
        table.add(post);
    }

    // ---------------------------------------------------------- paddles
    function makePaddle(rubber) {
        const g = new THREE.Group();
        const blade = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.083, 0.083, 0.008, 40)), M.blade);
        blade.rotation.x = Math.PI / 2;
        blade.castShadow = true;
        g.add(blade);
        for (const s of [-1, 1]) {
            const rb = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.081, 0.081, 0.004, 40)), rubber);
            rb.rotation.x = Math.PI / 2;
            rb.position.z = s * 0.0062;
            rb.castShadow = true;
            g.add(rb);
        }
        const neck = new THREE.Mesh(geo(new THREE.BoxGeometry(0.032, 0.05, 0.012)), M.blade);
        neck.position.y = -0.096;
        g.add(neck);
        const handle = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.019, 0.023, 0.10, 20)), M.grip);
        handle.position.y = -0.165;
        handle.castShadow = true;
        g.add(handle);
        scene.add(g);
        return g;
    }
    const paddles = [makePaddle(M.rubber0), makePaddle(M.rubber1)];
    paddles[0].position.set(0, TH + 0.20, PADDLE_Z[0]);
    paddles[1].position.set(0, TH + 0.22, PADDLE_Z[1]);

    // ------------------------------------------------------------- ball
    const ball = new THREE.Group();
    const ballMesh = new THREE.Mesh(geo(new THREE.SphereGeometry(R, 40, 28)), M.ball);
    ballMesh.castShadow = true;
    ball.add(ballMesh);
    const seam = new THREE.Mesh(geo(new THREE.TorusGeometry(R * 0.995, 0.0016, 8, 48)), M.seam);
    ball.add(seam);
    const seam2 = new THREE.Mesh(geo(new THREE.TorusGeometry(R * 0.995, 0.0016, 8, 48)), M.seam);
    seam2.rotation.y = Math.PI / 2;
    ball.add(seam2);
    scene.add(ball);

    const trailGeo = geo(new THREE.BufferGeometry());
    trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3));
    const trail = new THREE.Line(trailGeo, mat(new THREE.LineBasicMaterial({ color: "#ffd98a", transparent: true, opacity: 0.5 })));
    trail.frustumCulled = false;
    scene.add(trail);

    const ring = new THREE.Mesh(
        geo(new THREE.RingGeometry(0.02, 0.028, 40)),
        mat(new THREE.MeshBasicMaterial({ color: "#ffe9b0", transparent: true, opacity: 0, side: THREE.DoubleSide }))
    );
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);

    const marker = new THREE.Mesh(
        geo(new THREE.CircleGeometry(0.028, 28)),
        mat(new THREE.MeshBasicMaterial({ color: "#000", transparent: true, opacity: 0.28 }))
    );
    marker.rotation.x = -Math.PI / 2;
    scene.add(marker);

    function dispose() {
        for (const g of geometries) {
            g.dispose();
        }
        for (const m of materials) {
            m.dispose();
        }
        geometries.length = 0;
        materials.length = 0;
        scene.clear();
        renderer.dispose();
        renderer.forceContextLoss();
        if (renderer.domElement.parentNode) {
            renderer.domElement.parentNode.removeChild(renderer.domElement);
        }
    }

    return {
        renderer,
        scene,
        camera,
        paddles,
        ball,
        ballMesh,
        seam,
        seam2,
        trail,
        trailGeo,
        ring,
        marker,
        dispose,
    };
}
