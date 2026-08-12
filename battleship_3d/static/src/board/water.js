/** @odoo-module **/
/**
 * The sea: one height field, two boards floating on it.
 *
 * There is no fluid simulation here — a shot does not move water into the next
 * cell. What there is is a sum of three travelling sine waves for the swell,
 * plus a decaying ring per impact, sampled wherever anything needs to know how
 * high the water is: the water mesh deforms to it, and every ship reads four
 * points around itself to sit in it. Cheap enough to run per frame, and it is
 * the same function on both sides, so a shell landing where a ship is bobbing
 * always agrees with what the eye expects.
 *
 * Ported from the `Battleship 3D` design prototype.
 */

// A ring is dead well before this, but it stays in the list until it is.
const RIPPLE_LIFE = 2.5;
// Rings travel outwards this fast, in board cells per second.
const RIPPLE_SPEED = 2.6;

export class WaveField {
    constructor() {
        this.t = 0;
        this.hits = [];
    }

    /**
     * Height of the water at a point of a board, right now.
     *
     * The two boards get a different phase so they never ripple in unison,
     * which is what would make the pair read as one flat sheet.
     */
    heightAt(side, x, z) {
        const t = this.t;
        const phase = side === "a" ? 0 : 1.7;
        let h = Math.sin(x * 0.85 + t * 1.15 + phase) * 0.028
            + Math.sin(z * 1.2 - t * 0.85 + phase * 2) * 0.022
            + Math.sin(x * 0.6 + z * 0.8 + t * 1.75 + phase) * 0.013;
        for (const hit of this.hits) {
            if (hit.side !== side) {
                continue;
            }
            const age = t - hit.t0;
            if (age < 0 || age > 2.4) {
                continue;
            }
            // Distance to the ring's current radius: the gaussian keeps the
            // wave a crest instead of the whole disc rising.
            const d = Math.hypot(x - hit.x, z - hit.z) - age * RIPPLE_SPEED;
            h += hit.amp * Math.exp(-age * 1.4) * Math.exp(-d * d * 2.4) * Math.cos(d * 5.4);
        }
        return h;
    }

    /** Something landed: send a ring out from there. */
    splash(side, x, z, amp) {
        this.hits.push({ side, x, z, amp, t0: this.t });
    }

    advance(dt) {
        this.t += dt;
        for (let i = this.hits.length - 1; i >= 0; i--) {
            if (this.t - this.hits[i].t0 > RIPPLE_LIFE) {
                this.hits.splice(i, 1);
            }
        }
    }

    /**
     * Push the height field into a water mesh.
     *
     * The mesh keeps its flat grid in `userData.base`, because the vertices
     * being deformed are the same ones that would be read back as the new rest
     * position, and the surface would drift away over a few hundred frames.
     */
    shape(side, mesh) {
        const position = mesh.geometry.attributes.position;
        const base = mesh.userData.base;
        for (let i = 0; i < position.count; i++) {
            position.setY(i, this.heightAt(side, base[i * 3], base[i * 3 + 2]));
        }
        position.needsUpdate = true;
        mesh.geometry.computeVertexNormals();
    }

    /**
     * Sit a ship in the swell.
     *
     * Four samples: bow and stern give the pitch, port and starboard the roll.
     * Reading them in the ship's own frame is what makes a ship placed north to
     * south pitch along its length rather than roll across it.
     */
    float(side, mesh) {
        const half = Math.max(0.3, (mesh.userData.size || 3) * 0.5 - 0.25);
        const beam = mesh.userData.beam || 0.34;
        const yaw = mesh.rotation.y;
        const fx = Math.cos(yaw);
        const fz = -Math.sin(yaw);
        const lx = Math.sin(yaw);
        const lz = Math.cos(yaw);
        const { x, z } = mesh.position;

        const bow = this.heightAt(side, x + fx * half, z + fz * half);
        const stern = this.heightAt(side, x - fx * half, z - fz * half);
        const port = this.heightAt(side, x + lx * beam, z + lz * beam);
        const starboard = this.heightAt(side, x - lx * beam, z - lz * beam);

        mesh.position.y = (bow + stern) * 0.5 * 0.9 + (mesh.userData.draft || 0);
        // A hull is stiffer than the water it sits in: both angles are damped
        // rather than following the slope exactly.
        mesh.rotation.z = Math.atan2(bow - stern, half * 2) * 0.8 + (mesh.userData.list || 0);
        mesh.rotation.x = -Math.atan2(port - starboard, beam * 2) * 0.55;
    }
}
