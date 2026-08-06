/** @odoo-module **/

import { AiController } from "./engine/ai.js";
import {
    MAX_STEPS_PER_FRAME,
    PADDLE_X_LIMIT,
    PADDLE_Y_MAX,
    PADDLE_Y_MIN,
    TH,
    WIN,
    other,
    sideSign,
} from "./engine/constants.js";
import { PingPongSim, RemoteController } from "./engine/sim.js";
import { MatchClock } from "./net/clock.js";
import { PingPongView } from "./render/view.js";

const POINTER_SMOOTH = 17;
const PADDLE_VEL_BLEND = 0.25;

/**
 * The game as a whole: simulation, rendering, input and the frame loop, with a
 * lifecycle that can actually be torn down.
 *
 * It imports nothing from Odoo. The component around it owns the UI and the
 * server calls, and a NetGame owns the peer; everything this class needs to say
 * comes out through `onEvent`.
 *
 * Time comes from a MatchClock rather than an accumulator, in every mode. Two
 * peers anchored to the same instant then derive the same tick from the same
 * moment, which is what lets a guest index its own history by the tick a host
 * snapshot carries.
 */
export class PingPongEngine {
    /**
     * @param {HTMLElement} container
     * @param {object} [options]
     * @param {"solo"|"host"|"guest"} [options.role]
     * @param {number} [options.localSide] which end the local player is on
     * @param {string} [options.difficulty]
     * @param {number} [options.matchPoint]
     * @param {number} [options.seed]
     * @param {(event: object) => void} [options.onEvent]
     */
    constructor(container, {
        role = "solo",
        localSide = 0,
        difficulty = "normal",
        matchPoint = WIN,
        seed = null,
        onEvent = () => {},
    } = {}) {
        this.container = container;
        this.role = role;
        this.localSide = localSide;
        this.remoteSide = other(localSide);
        this.sign = sideSign(localSide);
        this.onEvent = onEvent;

        /* Hooks a NetGame plugs into. Left null in a local match. */
        this.netHook = null;
        this.onStep = null;
        this.net = null;

        this.active = false;
        this.paused = false;
        this.lastFrame = 0;
        this.rafId = 0;

        this.pointer = { x: 0, y: 0 };
        this.clock = new MatchClock();

        this.sim = new PingPongSim({
            matchPoint,
            seed,
            difficulty,
            onEvent: (event) => this._onSimEvent(event),
        });
        if (role === "solo") {
            this.sim.controllers[this.remoteSide] = new AiController(difficulty);
        } else if (role === "host") {
            // The guest's strokes arrive as claims; a local contact test here
            // would hit the same ball a second time.
            this.sim.controllers[this.remoteSide] = new RemoteController();
        } else if (role === "guest") {
            // A guest predicts, it does not rule: the score is the host's.
            this.sim.authoritative = false;
        }

        this.view = new PingPongView(container, localSide);

        this._boundPointerMove = (ev) => this._onPointerMove(ev);
        this._boundKeyDown = (ev) => this._onKeyDown(ev);
        window.addEventListener("pointermove", this._boundPointerMove);
        window.addEventListener("keydown", this._boundKeyDown);

        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(container);
        this._resize();

        if (window.odoo && window.odoo.debug) {
            window.__PP = this;
        }
    }

    // -------------------------------------------------------------- control

    start() {
        if (this.rafId) {
            return;
        }
        this.lastFrame = Date.now();
        this.rafId = requestAnimationFrame(() => this._frame());
    }

    /** Begin a local match. */
    startMatch({ difficulty = this.sim.difficulty, server = 0, seed = this.sim.seed } = {}) {
        this.sim.difficulty = difficulty;
        const ai = this.sim.controllers[this.remoteSide];
        if (ai && ai.isAi) {
            ai.difficulty = difficulty;
        }
        this.sim.reset({ server, seed });
        this.clock.start();
        this.active = true;
        this.paused = false;
    }

    /** Begin a networked match on a time base both peers share. */
    startNetMatch({ t0, seed, matchPoint = this.sim.matchPoint, server = 0 }) {
        this.sim.matchPoint = matchPoint;
        this.sim.reset({ server, seed });
        this.clock.start(t0);
        this.active = true;
        this.paused = false;
        this.emit({ type: "match:start" });
    }

    stopMatch() {
        this.active = false;
        this.paused = false;
        this.clock.stop();
    }

    setPaused(paused) {
        if (paused === this.paused) {
            return;
        }
        this.paused = paused;
        if (paused) {
            this.clock.pauseAt(Date.now());
        } else {
            this.clock.resume(Date.now());
        }
    }

    /** Serve, if the local player is the one holding the ball. */
    requestServe() {
        if (!this.running || !this.sim.canServe(this.localSide)) {
            return false;
        }
        const tick = this.sim.tick;
        const served = this.sim.serve(this.localSide);
        if (served && this.net && !this.net.isHost) {
            this.net.claimServe(tick);
        }
        return served;
    }

    cycleCamera() {
        return this.view.cycleCamera();
    }

    /** Push an event to the UI without it coming from the simulation. */
    emit(event) {
        this.onEvent(event);
    }

    get running() {
        return this.active && !this.paused && this.sim.phase !== "over";
    }

    // ---------------------------------------------------------------- input

    _onPointerMove(ev) {
        this.pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
        this.pointer.y = (ev.clientY / window.innerHeight) * 2 - 1;
    }

    _onKeyDown(ev) {
        if (ev.code === "Space") {
            ev.preventDefault();
            if (!this.requestServe()) {
                this.onEvent({ type: "ui:space" });
            }
            return;
        }
        if (ev.key === "p" || ev.key === "P") {
            this.onEvent({ type: "ui:pause" });
            return;
        }
        if (ev.key === "c" || ev.key === "C") {
            this.onEvent({ type: "ui:camera", label: this.cycleCamera() });
        }
    }

    /**
     * Map the pointer onto the local paddle.
     *
     * Mirrored for the far end so that moving the mouse right always moves the
     * paddle right on screen, whichever side you are on. The velocity keeps its
     * smoothing because that is what feeds shot power and spin, and a resampled
     * position could not reconstruct it.
     */
    _updateLocalPaddle(dt) {
        const side = this.localSide;
        const tx = this.sign * clamp(this.pointer.x * 1.05, -PADDLE_X_LIMIT, PADDLE_X_LIMIT);
        const ty = clamp(TH + 0.38 - this.pointer.y * 0.40, PADDLE_Y_MIN, PADDLE_Y_MAX);

        const pad = this.sim.paddle[side];
        const prevX = pad.x;
        const prevY = pad.y;
        const k = Math.min(1, dt * POINTER_SMOOTH);
        const nx = prevX + (tx - prevX) * k;
        const ny = prevY + (ty - prevY) * k;

        const inv = 1 / Math.max(dt, 1e-3);
        const vel = this.sim.paddleVel[side];
        const vx = ((nx - prevX) * inv) * PADDLE_VEL_BLEND + vel.x * (1 - PADDLE_VEL_BLEND);
        const vy = ((ny - prevY) * inv) * PADDLE_VEL_BLEND + vel.y * (1 - PADDLE_VEL_BLEND);

        this.sim.setPaddle(side, nx, ny, vx, vy);
    }

    // ----------------------------------------------------------------- loop

    _frame() {
        this.rafId = requestAnimationFrame(() => this._frame());
        const now = Date.now();
        const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
        this.lastFrame = now;

        if (this.running) {
            this._updateLocalPaddle(dt);
            const target = this.clock.tickAt(now);
            let steps = 0;
            while (this.sim.tick < target && steps < MAX_STEPS_PER_FRAME) {
                this.sim.step();
                steps++;
                if (this.onStep) {
                    this.onStep(this.sim.tick);
                }
            }
            if (this.sim.tick < target) {
                // A backgrounded tab is not worth catching up on: skip the gap
                // rather than burning a second of CPU replaying it.
                this.clock.anchorTo(this.sim.tick, now);
            }
        }

        this.view.draw(this.sim, dt);
    }

    _resize() {
        const rect = this.container.getBoundingClientRect();
        this.view.resize(rect.width, rect.height);
    }

    // --------------------------------------------------------------- events

    _onSimEvent(event) {
        switch (event.type) {
            case "bounce":
                this.view.bounceAt(event.x, event.z);
                break;
            case "net":
                this.view.addShake(0.35);
                break;
            case "hit":
                this.view.addShake(event.side === this.localSide ? 0.28 : 0.16);
                break;
            default:
                break;
        }
        if (this.netHook) {
            this.netHook(event);
        }
        this.onEvent(event);
    }

    // ------------------------------------------------------------- teardown

    destroy() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = 0;
        }
        window.removeEventListener("pointermove", this._boundPointerMove);
        window.removeEventListener("keydown", this._boundKeyDown);
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this.net) {
            this.net.destroy();
            this.net = null;
        }
        this.view.dispose();
        if (window.__PP === this) {
            delete window.__PP;
        }
    }
}

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}
