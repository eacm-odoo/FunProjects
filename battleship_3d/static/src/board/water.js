/** @odoo-module **/
/**
 * Living water: the sea surface, on the GPU.
 *
 * The swell is four travelling sines plus one decaying ring per impact, and it
 * is written **twice on purpose** — once in GLSL, where a 220x220 sheet is
 * displaced and shaded every frame for free, and once in JS, where the ships
 * and the shot markers ask how high the water is under them. The two have to
 * agree or hulls float above their own reflection, so they sit in this file
 * next to each other: change one, change the other.
 *
 * What the GPU does that the CPU could not afford: fresnel and specular off the
 * real wave normal, sun glitter, foam at the impact, and the grid drawn *on the
 * surface* so the lines ride the swell instead of hovering over it.
 *
 * Ported from the `Tablero Agua Viva` design prototype.
 */
import * as THREE from "@battleship_3d/lib/three.module";

// Rings alive at once. They go in a fixed uniform array, so this is a hard cap:
// a new impact past it recycles the oldest slot.
const MAX_RIPPLES = 12;
// A ring is unreadable well before it stops being evaluated.
const RIPPLE_LIFE = 4;
const RIPPLE_SPEED = 2.55;
// How far in from the rim the swell is flattened, so no gap opens at the wall.
const SHORE = 0.55;

const WAVES_GLSL = /* glsl */`
float waves(vec2 p, float t, float ph, float amp) {
    return (sin(p.x * 0.85 + t * 1.15 + ph) * 0.030
          + sin(p.y * 1.20 - t * 0.85 + ph * 2.0) * 0.024
          + sin((p.x * 0.6 + p.y * 0.8) + t * 1.75 + ph) * 0.014
          + sin((p.x * 1.9 - p.y * 1.3) - t * 2.30 + ph * 3.0) * 0.007) * amp;
}`;

/** The same four sines, for whatever needs to float on them. */
function waves(x, z, t, ph, amp) {
    return (Math.sin(x * 0.85 + t * 1.15 + ph) * 0.030
        + Math.sin(z * 1.20 - t * 0.85 + ph * 2) * 0.024
        + Math.sin(x * 0.6 + z * 0.8 + t * 1.75 + ph) * 0.014
        + Math.sin(x * 1.9 - z * 1.3 - t * 2.3 + ph * 3) * 0.007) * amp;
}

function smoothstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

const vertexShader = (half) => /* glsl */`
uniform float uTime, uAmp, uPhase, uRipN;
uniform vec4 uRip[${MAX_RIPPLES}];
varying vec3 vPos;
varying vec3 vNrm;
varying float vFoam;
varying float vCrest;
${WAVES_GLSL}

/** x: how much the rings lift the water here, y: how much foam they leave. */
vec2 rip(vec2 p, float t) {
    vec2 hf = vec2(0.0);
    for (int i = 0; i < ${MAX_RIPPLES}; i++) {
        if (float(i) >= uRipN) break;
        vec4 r = uRip[i];
        float age = t - r.z;
        if (age < 0.0 || age > ${RIPPLE_LIFE.toFixed(1)}) continue;
        float d = length(p - r.xy);
        float s = d - age * ${RIPPLE_SPEED};
        float env = exp(-age * 1.05) * exp(-s * s * 3.0);
        hf.x += r.w * env * cos(s * 5.6);
        // Written as 1 - smoothstep rather than with the edges swapped: GLSL
        // leaves smoothstep undefined when edge0 >= edge1.
        hf.y += r.w * 7.0 * exp(-age * 1.5) * exp(-s * s * 13.0)
              + r.w * 2.6 * exp(-age * 0.75) * (1.0 - smoothstep(0.0, 0.62, d));
    }
    return hf;
}

vec2 field(vec2 p, float t) {
    vec2 hf = rip(p, t);
    return vec2(waves(p, t, uPhase, uAmp) + hf.x, hf.y);
}

void main() {
    vec2 p = position.xz;
    vec2 c = field(p, uTime);
    // Flatten the swell into the wall so a trough never opens a gap at the rim.
    vec2 m = 1.0 - smoothstep(${(half - SHORE).toFixed(2)}, ${half.toFixed(2)}, abs(p));
    float mm = min(m.x, m.y);
    float h = c.x * mm;
    // Normal by finite difference: cheaper than an analytic derivative of a sum
    // of sines plus rings, and indistinguishable at this scale.
    float e = 0.07;
    float hx = field(p + vec2(e, 0.0), uTime).x * mm;
    float hz = field(p + vec2(0.0, e), uTime).x * mm;
    vNrm = normalize(vec3(-(hx - h) / e, 1.0, -(hz - h) / e));
    vFoam = c.y;
    vCrest = h;
    vPos = vec3(position.x, h, position.z);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(vPos, 1.0);
}`;

const fragmentShader = (half) => /* glsl */`
uniform vec3 uDeep, uShallow, uSky, uGridCol, uAccent;
uniform vec3 uCam, uLight;
uniform float uTime, uGrid, uHoverX, uHoverZ;
varying vec3 vPos;
varying vec3 vNrm;
varying float vFoam;
varying float vCrest;

void main() {
    vec3 n = normalize(vNrm);
    vec3 V = normalize(uCam - vPos);
    vec3 L = normalize(uLight);
    float diff = max(dot(n, L), 0.0);
    float fres = pow(1.0 - max(dot(n, V), 0.0), 3.5);
    float spec = pow(max(dot(normalize(L + V), n), 0.0), 260.0);

    // Deeper towards the walls: the eye reads it as a body of water rather
    // than a sheet.
    vec2 q = abs(vPos.xz) / ${half.toFixed(1)};
    float edge = smoothstep(0.55, 1.0, max(q.x, q.y));

    vec3 col = mix(uDeep, uShallow, 0.22 + diff * 0.85);
    col = mix(col, uDeep * 0.72, edge * 0.55);
    col += uSky * fres * 0.42;
    col += vec3(1.0) * spec * 1.35;

    // Two scrolling lattices, beaten against each other: sun glitter.
    float g1 = sin(vPos.x * 7.3 + uTime * 1.6) * sin(vPos.z * 6.1 - uTime * 1.15);
    float g2 = sin(vPos.x * 13.7 - uTime * 2.2) * sin(vPos.z * 11.3 + uTime * 1.9);
    float glint = pow(max(g1 * 0.6 + g2 * 0.4, 0.0), 6.0);
    col += uSky * glint * (0.10 + diff * 0.18);
    col += uShallow * smoothstep(0.006, 0.03, vCrest) * 0.20;

    // Grid on the surface, so the lines ride the swell. Cells are one unit and
    // their edges fall on whole coordinates, so fract(p) is how far across a
    // cell we are and the line is drawn where that reaches an edge.
    vec2 dCell = abs(fract(vPos.xz) - 0.5);
    vec2 w = fwidth(vPos.xz) * 1.4;
    float line = 1.0 - min(smoothstep(0.0, w.x, 0.5 - dCell.x), smoothstep(0.0, w.y, 0.5 - dCell.y));
    col = mix(col, uGridCol, clamp(line, 0.0, 1.0) * 0.42 * uGrid);

    vec2 cell = floor(vPos.xz + ${half.toFixed(1)});
    float hov = (abs(cell.x - uHoverX) < 0.5 && abs(cell.y - uHoverZ) < 0.5) ? 1.0 : 0.0;
    col = mix(col, uAccent, hov * 0.28);

    col = mix(col, vec3(0.93, 0.98, 1.0), clamp(vFoam, 0.0, 1.0) * 0.9);
    gl_FragColor = vec4(col, 1.0);
}`;

/**
 * One sea: the mesh, its uniforms, and the height field behind both.
 *
 * There is one of these per grid. `phase` is what stops two boards side by side
 * from rippling in lockstep, which would read as a single flat sheet.
 */
export class WaterSurface {
    constructor({
        size = 10,
        segments = 200,
        phase = 0,
        deep = "#0a2233",
        shallow = "#1d6a7e",
        sky = "#a9dbe8",
        grid = "#b7d8e2",
        accent = "#714B67",
        light = [9, 18, 8],
    } = {}) {
        this.size = size;
        this.half = size / 2;
        this.phase = phase;
        this.amp = 1;
        this.t = 0;
        // Ring buffer: `rips[i]` is bookkeeping for the uniform at the same index.
        this.rips = [];
        this._local = new THREE.Vector3();

        this.uniforms = {
            uTime: { value: 0 },
            uAmp: { value: 1 },
            uPhase: { value: phase },
            uRipN: { value: 0 },
            uRip: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4()) },
            uDeep: { value: new THREE.Color(deep) },
            uShallow: { value: new THREE.Color(shallow) },
            uSky: { value: new THREE.Color(sky) },
            uGridCol: { value: new THREE.Color(grid) },
            uAccent: { value: new THREE.Color(accent) },
            uCam: { value: new THREE.Vector3() },
            uLight: { value: new THREE.Vector3(...light) },
            uGrid: { value: 1 },
            uHoverX: { value: -9 },
            uHoverZ: { value: -9 },
        };

        // A hair wider than the well, so the seam at the wall never shows.
        const geometry = new THREE.PlaneGeometry(size + 0.04, size + 0.04, segments, segments);
        geometry.rotateX(-Math.PI / 2);
        this.mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
            vertexShader: vertexShader(this.half),
            fragmentShader: fragmentShader(this.half),
            uniforms: this.uniforms,
        }));
        this.mesh.name = "water";
    }

    // ------------------------------------------------------------------ field
    /** Height of the water at a point of this board, right now. */
    heightAt(x, z) {
        let h = waves(x, z, this.t, this.phase, this.amp);
        for (let i = 0; i < this.rips.length; i++) {
            const r = this.uniforms.uRip.value[i];
            const age = this.t - r.z;
            if (age < 0 || age > RIPPLE_LIFE) {
                continue;
            }
            const d = Math.hypot(x - r.x, z - r.y);
            const s = d - age * RIPPLE_SPEED;
            h += r.w * Math.exp(-age * 1.05) * Math.exp(-s * s * 3) * Math.cos(s * 5.6);
        }
        return h * this._shore(x, z);
    }

    /** The same flattening the vertex shader applies near the walls. */
    _shore(x, z) {
        const mx = 1 - smoothstep(this.half - SHORE, this.half, Math.abs(x));
        const mz = 1 - smoothstep(this.half - SHORE, this.half, Math.abs(z));
        return Math.min(mx, mz);
    }

    /** Something landed here: send a ring out from it. */
    splash(x, z, amp = 0.105) {
        let slot = this.rips.length;
        if (slot >= MAX_RIPPLES) {
            // All slots busy: the oldest ring is the one nobody will miss.
            slot = 0;
            for (let i = 1; i < this.rips.length; i++) {
                if (this.rips[i].t0 < this.rips[slot].t0) {
                    slot = i;
                }
            }
        }
        this.rips[slot] = { t0: this.t };
        this.uniforms.uRip.value[slot].set(x, z, this.t, amp);
        this.uniforms.uRipN.value = this.rips.length;
    }

    /** Highlight one cell under the pointer, or none. */
    setHover(cell) {
        const on = Number.isInteger(cell);
        this.uniforms.uHoverX.value = on ? cell % this.size : -9;
        this.uniforms.uHoverZ.value = on ? Math.floor(cell / this.size) : -9;
    }

    // ----------------------------------------------------------- what floats
    /**
     * Sit a ship in the swell.
     *
     * Four samples: bow and stern give the pitch, port and starboard the roll.
     * Reading them in the ship's own frame is what makes a ship placed north to
     * south pitch along its length rather than roll across it.
     */
    float(mesh) {
        const half = Math.max(0.3, (mesh.userData.size || 3) * 0.5 - 0.25);
        const beam = mesh.userData.beam || 0.34;
        const yaw = mesh.rotation.y;
        const fx = Math.cos(yaw);
        const fz = -Math.sin(yaw);
        const lx = Math.sin(yaw);
        const lz = Math.cos(yaw);
        const { x, z } = mesh.position;

        const bow = this.heightAt(x + fx * half, z + fz * half);
        const stern = this.heightAt(x - fx * half, z - fz * half);
        const port = this.heightAt(x + lx * beam, z + lz * beam);
        const starboard = this.heightAt(x - lx * beam, z - lz * beam);

        mesh.position.y = (bow + stern) * 0.5 * 0.9 + (mesh.userData.draft || 0);
        // A hull is stiffer than the water under it: both angles are damped
        // rather than following the slope exactly.
        mesh.rotation.z = Math.atan2(bow - stern, half * 2) * 0.8 + (mesh.userData.list || 0);
        mesh.rotation.x = -Math.atan2(port - starboard, beam * 2) * 0.55;
    }

    /** Bob a marker (a peg, a buoy) on the surface. */
    bob(mesh, rest = 0) {
        mesh.position.y = rest + this.heightAt(mesh.position.x, mesh.position.z);
    }

    // ------------------------------------------------------------------ frame
    advance(dt, camera) {
        this.t += dt;
        this.uniforms.uTime.value = this.t;
        // The shader works in the board's own space, and the boards are offset
        // from the origin: a world camera would light the second one wrong.
        this.uniforms.uCam.value.copy(this.mesh.worldToLocal(this._local.copy(camera.position)));
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }
}
