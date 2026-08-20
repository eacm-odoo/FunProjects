/** @odoo-module **/
/**
 * Ambience, not a rule: flights that cross the table, shoot at each other and
 * leave again.
 *
 * It owns nothing the game owns. There is no state to read, no cell to claim
 * and no callback into the board — a sortie is spawned on a timer, flies a
 * fixed path, and is dropped the moment it is off the table. Nothing in here
 * can decide a shot, a turn or a hull: the server still owns every rule, and a
 * player who turns the patrols off is playing exactly the same game.
 *
 * Everything it puts in the air (tracers, sparks, smoke) lives in its own group
 * and on its own tween list, exactly the way `scene.js` keeps its transients
 * apart from the meshes a payload builds — so a rebuilt table (`_teardown`)
 * never takes the air with it, and the air never leaves a peg behind.
 *
 * Ported from the `Aviones sobre el tablero` design prototype.
 */
import * as THREE from "@battleship_3d/lib/three.module";
import { planeMesh, disposePlane } from "./planes";

// Tracer and spark colours are the guns' — `scene.js` FLASH.
const FIRE = "#ffb552";
const CORE = "#fff3d0";
const SMOKE = "#5b6469";

const TRACER_MAT = new THREE.MeshBasicMaterial({ color: FIRE, transparent: true, opacity: 0.95, depthWrite: false });
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

class Plane {
    constructor(cls, side, { start, dir, speed, alt, weave, phase, role }) {
        this.mesh = planeMesh(cls, side);
        this.role = role;
        this.speed = speed;
        this.alt = alt;
        this.weave = weave;
        this.phase = phase;
        this.dir = dir.clone().normalize();
        this.side = new THREE.Vector3(-this.dir.z, 0, this.dir.x);
        this.start = start.clone();
        this.t = 0;
        this.hit = 0;      // seconds since it took rounds; 0 while healthy
        this.smoke = 0;    // countdown to the next puff of its trail
        this.burst = rnd(0.8, 2.2);
        this.gone = false;
        this.at(0);
    }

    /** Where it is at a given time: a line, weaved across and bobbed along. */
    at(t) {
        const p = this.start.clone().addScaledVector(this.dir, this.speed * t);
        p.addScaledVector(this.side, Math.sin(t * this.weave.f + this.phase) * this.weave.a);
        p.y = this.alt + Math.sin(t * 0.7 + this.phase) * 0.35;
        if (this.hit) {
            // Hit aircraft nose over and go down as they leave, which is the
            // whole story a spectator gets to see.
            p.y -= this.hit * this.hit * 1.6;
        }
        return p;
    }

    update(dt) {
        this.t += dt;
        if (this.hit) {
            this.hit += dt;
        }
        const p = this.at(this.t);
        const ahead = this.at(this.t + 0.08);
        const v = ahead.clone().sub(p);
        this.mesh.position.copy(p);
        this.mesh.rotation.y = Math.atan2(-v.z, v.x);
        this.mesh.rotation.x = -Math.atan2(v.y, Math.hypot(v.x, v.z));
        // Bank into the weave: the lateral acceleration of the path, read
        // straight off the sine that made it.
        const lat = -Math.sin(this.t * this.weave.f + this.phase) * this.weave.a * this.weave.f ** 2;
        this.mesh.rotation.z = THREE.MathUtils.clamp(lat * 0.5, -1.1, 1.1) + (this.hit ? this.hit * 0.5 : 0);
        for (const prop of this.mesh.userData.props) {
            prop.rotation.x += dt * 42;
        }
        return p;
    }

    muzzleWorld() {
        this.mesh.updateWorldMatrix(true, false);
        return this.mesh.localToWorld(this.mesh.userData.muzzle.clone());
    }
}

export class AirTraffic {
    /**
     * @param {THREE.Scene} scene
     * @param {object} [options]
     * @param {number} [options.reach] half-extent of the table, in board units
     * @param {number[]} [options.gap] seconds between sorties, min and max
     * @param {boolean} [options.enabled] whether new sorties are spawned at all
     */
    constructor(scene, { reach = 16, gap = [14, 26], enabled = true } = {}) {
        this.group = new THREE.Group();
        this.group.name = "air";
        scene.add(this.group);
        this.reach = reach;
        this.gap = gap;
        this.enabled = enabled;
        // How many sorties may share the sky. A duel has room for two; a
        // free-for-all is already drawing four seas and four fleets, so
        // `scene.js` turns this down rather than doubling the shadow pass.
        this.maxFlights = 2;
        this.flights = [];
        this.tweens = [];
        // Not immediately: the board is being framed and a payload is landing
        // on the first seconds, and a patrol crossing right then reads as part
        // of the game rather than as weather.
        this.next = rnd(5, 11);
    }

    /**
     * A sortie: a duel, never a lone aircraft. Either a pair — one of each
     * side, trading fire on the same bearing — or two on one, the odd side
     * outnumbered. Both sides shoot: nobody takes rounds from nowhere.
     */
    launch() {
        const heading = rnd(0, Math.PI * 2);
        const dir = new THREE.Vector3(Math.cos(heading), 0, Math.sin(heading));
        const across = new THREE.Vector3(-dir.z, 0, dir.x);
        const out = this.reach + 4;
        const alt = rnd(3.8, 5.6);
        const speed = rnd(4.2, 5.8);
        const offset = rnd(-this.reach * 0.22, this.reach * 0.22);
        const base = dir.clone().multiplyScalar(-out).addScaledVector(across, offset);

        // 1 v 1, or 2 v 1 with either side outnumbered.
        const two = Math.random() < 0.45 ? pick(["a", "b"]) : null;
        const count = { a: two === "a" ? 2 : 1, b: two === "b" ? 2 : 1 };
        const flight = { planes: [], t: 0 };

        const build = (side, index) => {
            const lonely = count[side] === 1;
            const cls = side === "b"
                ? pick(["Fighter", "Interceptor"])
                : pick(lonely ? ["Fighter", "Interceptor", "Bomber"] : ["Fighter", "Interceptor"]);
            // The two sides enter staggered along the bearing and abreast of
            // each other, close enough to be read as one fight.
            const along = (side === "a" ? 0 : -rnd(4.5, 7)) - index * rnd(1.6, 3);
            const lateral = (side === "a" ? rnd(-1, 1) : rnd(-1.4, 1.4)) + index * rnd(1.8, 3.2);
            const plane = new Plane(cls, side, {
                start: base.clone().addScaledVector(dir, along).addScaledVector(across, lateral),
                dir,
                speed: speed * (side === "b" ? 1.04 : 1) * rnd(0.99, 1.02),
                alt: alt + rnd(-0.5, 1.1),
                weave: { a: rnd(1.3, 2.8), f: rnd(0.55, 1.1) },
                phase: rnd(0, 6),
                role: side,
            });
            flight.planes.push(plane);
        };
        for (const side of ["a", "b"]) {
            for (let i = 0; i < count[side]; i++) {
                build(side, i);
            }
        }
        for (const plane of flight.planes) {
            this.group.add(plane.mesh);
        }
        this.flights.push(flight);
        return flight;
    }

    /**
     * Who this aircraft can shoot at: the nearest live enemy of the flight
     * that is inside range and roughly ahead of the nose, so the shot always
     * comes from something the spectator can see.
     */
    _target(flight, plane) {
        let best = null;
        let bestRange = 15;
        for (const other of flight.planes) {
            if (other.gone || other.role === plane.role) {
                continue;
            }
            const to = other.mesh.position.clone().sub(plane.mesh.position);
            const range = to.length();
            if (range > bestRange || range < 1.2) {
                continue;
            }
            const nose = new THREE.Vector3(1, 0, 0).applyQuaternion(plane.mesh.quaternion);
            if (to.normalize().dot(nose) < 0.45) {
                continue;
            }
            best = other;
            bestRange = range;
        }
        return best;
    }

    /** A short burst of tracer from `from` towards `to`, and what it may cost. */
    _burst(from, to) {
        const origin = from.muzzleWorld();
        const target = to.at(to.t + 0.25);
        const dir = target.clone().sub(origin).normalize();
        const hits = Math.random() < 0.3;
        for (let i = 0; i < 4; i++) {
            const spread = 0.02;
            const aim = dir.clone().add(new THREE.Vector3(
                rnd(-spread, spread), rnd(-spread, spread), rnd(-spread, spread)
            )).normalize();
            const tracer = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.035, 0.035), TRACER_MAT.clone());
            tracer.position.copy(origin).addScaledVector(aim, 0.3);
            tracer.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), aim);
            this.group.add(tracer);
            const speed = 46;
            const life = 0.55;
            const wait = i * 0.055;
            const struck = hits && i === 3;
            this._tween(tracer, life + wait, (o, k, dt) => {
                if (k * (life + wait) < wait) {
                    o.visible = false;
                    return;
                }
                o.visible = true;
                o.position.addScaledVector(aim, speed * dt);
                o.material.opacity = 0.95 * (1 - k) ** 0.7;
                if (struck && k > 0.72 && !o.userData.done) {
                    o.userData.done = true;
                    this._spark(to);
                }
            });
        }
    }

    /** Rounds finding the airframe: a flash on it, and a trail from then on. */
    _spark(plane) {
        const at = plane.mesh.position.clone();
        const flash = new THREE.Mesh(
            new THREE.SphereGeometry(0.2, 10, 8),
            new THREE.MeshBasicMaterial({ color: CORE, transparent: true, depthWrite: false })
        );
        flash.position.copy(at);
        this.group.add(flash);
        this._tween(flash, 0.22, (o, k) => {
            o.scale.setScalar(1 + k * 2.2);
            o.material.color.set(k < 0.4 ? CORE : FIRE);
            o.material.opacity = (1 - k) ** 1.5;
        });
        for (let i = 0; i < 8; i++) {
            const bit = new THREE.Mesh(
                new THREE.BoxGeometry(0.07, 0.05, 0.05),
                new THREE.MeshBasicMaterial({ color: i % 3 ? FIRE : "#c9d3d6", transparent: true, depthWrite: false })
            );
            bit.position.copy(at);
            const v = new THREE.Vector3(rnd(-3, 3), rnd(-1, 3), rnd(-3, 3));
            this.group.add(bit);
            this._tween(bit, 0.9, (o, k, dt) => {
                o.position.addScaledVector(v, dt);
                v.y -= 7 * dt;
                o.material.opacity = 1 - k * k;
            });
        }
        if (!plane.hit) {
            plane.hit = 0.001;
        }
    }

    /** One puff of the trail a hit aircraft leaves behind it. */
    _puff(plane) {
        const puff = new THREE.Mesh(
            new THREE.SphereGeometry(rnd(0.1, 0.2), 8, 7),
            new THREE.MeshBasicMaterial({
                color: plane.hit < 0.7 ? FIRE : SMOKE, transparent: true, opacity: 0.55, depthWrite: false,
            })
        );
        puff.position.copy(plane.mesh.position);
        this.group.add(puff);
        const drift = plane.dir.clone().multiplyScalar(-1.2)
            .add(new THREE.Vector3(rnd(-0.3, 0.3), rnd(0.1, 0.5), rnd(-0.3, 0.3)));
        this._tween(puff, rnd(1.6, 2.6), (o, k, dt) => {
            o.position.addScaledVector(drift, dt);
            o.scale.setScalar(1 + k * 3.4);
            o.material.opacity = 0.55 * (1 - k) ** 1.3;
        });
    }

    _tween(object, seconds, fn) {
        this.tweens.push({ object, dur: seconds, t: 0, fn });
    }

    /** Take one transient off the table and give the GPU its memory back. */
    _drop(object) {
        this.group.remove(object);
        object.geometry.dispose();
        object.material.dispose();
    }

    /** Off the table and out of the story. */
    _spent(plane) {
        const p = plane.mesh.position;
        if (p.y < -3) {
            return true;
        }
        // Only ever spent on the way out: an aircraft still closing on the
        // table can start well outside the ring without being culled.
        const outbound = p.dot(plane.dir) > 0;
        return outbound && Math.hypot(p.x, p.z) > this.reach + 9;
    }

    /**
     * How far out the sorties are flown, in board units.
     *
     * A duel and a free-for-all are not the same table: the ring the aircraft
     * enter and leave on has to grow with it, or four boards get overflown down
     * the middle and never along the edges.
     */
    setReach(reach) {
        this.reach = reach;
    }

    update(dt) {
        if (this.enabled) {
            this.next -= dt;
            if (this.next <= 0 && this.flights.length < this.maxFlights) {
                this.launch();
                this.next = rnd(this.gap[0], this.gap[1]);
            }
        }

        for (let i = this.flights.length - 1; i >= 0; i--) {
            const flight = this.flights[i];
            flight.t += dt;
            for (const plane of flight.planes) {
                plane.update(dt);
                if (plane.hit) {
                    plane.smoke -= dt;
                    if (plane.smoke <= 0) {
                        this._puff(plane);
                        plane.smoke = 0.07;
                    }
                }
                plane.burst -= dt;
                if (plane.burst <= 0) {
                    plane.burst = rnd(0.9, 2.1);
                    const target = this._target(flight, plane);
                    if (target) {
                        this._burst(plane, target);
                    }
                }
            }
            for (const plane of flight.planes) {
                if (!plane.gone && this._spent(plane)) {
                    plane.gone = true;
                    this.group.remove(plane.mesh);
                    // A sortie every few seconds, a couple of dozen parts each:
                    // an airframe that is not given back is a leak with a clock
                    // on it, so the geometries go out with the aircraft.
                    disposePlane(plane.mesh);
                }
            }
            if (flight.planes.every((p) => p.gone)) {
                this.flights.splice(i, 1);
            }
        }

        for (let i = this.tweens.length - 1; i >= 0; i--) {
            const tween = this.tweens[i];
            tween.t += dt;
            const k = Math.min(1, tween.t / tween.dur);
            tween.fn(tween.object, k, dt);
            if (k >= 1) {
                this._drop(tween.object);
                this.tweens.splice(i, 1);
            }
        }
    }

    /** Everything in the air, at once: the board is going away. */
    dispose() {
        for (const flight of this.flights) {
            for (const plane of flight.planes) {
                if (!plane.gone) {
                    disposePlane(plane.mesh);
                }
            }
        }
        for (const tween of this.tweens) {
            this._drop(tween.object);
        }
        this.flights = [];
        this.tweens = [];
        this.group.clear();
        this.group.parent?.remove(this.group);
    }
}
