/** @odoo-module **/

import * as THREE from "../../../lib/three/three.module.js";

import {
    HIT_COOL,
    HIT_RADIUS,
    PADDLE_X_LIMIT,
    PADDLE_Y_MAX,
    PADDLE_Y_MIN,
    PADDLE_Z,
    STEP_H,
    other,
    shotDir,
} from "../engine/constants.js";
import { StateRing } from "../engine/history.js";
import { ClockSync } from "./clock.js";
import {
    MSG,
    REJECT,
    decodeClaim,
    decodeInput,
    decodeSnapshot,
    encodeClaim,
    encodeInput,
    encodeSnapshot,
} from "./protocol.js";

/* Rates, in ticks of the 240 Hz simulation. Event driven rather than fast: the
 * ball follows a closed-form path between strokes, so a guest predicts it almost
 * exactly and only needs correcting when something discrete happens. A hit, a
 * bounce, a point or a serve is sent the instant it occurs; the periodic
 * snapshot is only there to stop small errors accumulating. */
const SNAPSHOT_EVERY = 24;        // 10 Hz
const INPUT_EVERY = 20;           // 12 Hz
const SAMPLE_EVERY = 4;           // record the paddle at 60 Hz
const SAMPLES_PER_MESSAGE = 4;

/* Rewind budget. 48 ticks is 200 ms, enough for a claim that crossed a normal
 * link; on a slow one the window follows the measured round trip, because a
 * window shorter than the link turns honest strokes into rejections. It cannot
 * exceed the history the ring actually holds. */
const REWIND_TICKS_MIN = 48;
const REWIND_TICKS_MAX = 220;
const FUTURE_SLACK_TICKS = 12;

/* Reconciliation thresholds, in metres. */
const DEADZONE = 0.008;
const DEADZONE_AFTER_HIT = 0.025;
const SOFT_LIMIT = 0.120;
const SNAP_LIMIT = 0.80;
const VEL_DEADZONE = 0.25;

const COSMETIC = new Set(["bounce", "net"]);
const GUEST_MUTED = new Set(["bounce", "net", "hit", "serve", "point", "end"]);

const PING_EVERY_MS = 5000;

/**
 * Binds an engine to a peer.
 *
 * Authority is split: the host owns the ball and the score, each side owns its
 * own paddle with no latency at all, and the guest predicts its own stroke and
 * has the host confirm it. That last part is what makes the game playable over a
 * link where a round trip is a sizeable fraction of one exchange.
 */
export class NetGame {
    /**
     * @param {import("../pingpong_engine.js").PingPongEngine} engine
     * @param {object} transport send/onMessage/close
     * @param {object} options
     * @param {"host"|"guest"} options.role
     * @param {(status: object) => void} [options.onStatus]
     */
    constructor(engine, transport, { role, onStatus = () => {} }) {
        this.engine = engine;
        this.sim = engine.sim;
        this.transport = transport;
        this.role = role;
        this.isHost = role === "host";
        this.onStatus = onStatus;

        this.localSide = engine.localSide;
        this.remoteSide = other(this.localSide);
        this.clock = engine.clock;

        this.ring = new StateRing(1.0);
        this.localSamples = [];
        this.remoteTarget = null;
        this.replaying = false;

        this.snapshotSeq = 0;
        this.inputSeq = 0;
        this.lastSnapshotSeq = -1;
        this.lastInputSeq = -1;
        this.lastAppliedTick = -1;
        this.lastHitTick = -Infinity;
        this.claimId = 0;
        this.openClaims = new Map();
        this.rewindTicks = REWIND_TICKS_MIN;

        this.stats = {
            snapshotsIn: 0, snapshotsOut: 0, stale: 0,
            claimsSent: 0, claimsAccepted: 0, claimsRejected: 0,
            corrections: 0, snaps: 0, worstError: 0, lastError: 0, errorSum: 0, errorCount: 0,
        };

        this.sync = new ClockSync((payload) => this.transport.send(MSG.PING, payload));
        this._pingTimer = null;
        this._statusTimer = null;
        this._tmp = new THREE.Vector3();

        engine.netHook = (event) => this.onSimEvent(event);
        engine.onStep = (tick) => this.onStep(tick);
        this._off = transport.onMessage((type, payload) => this.onMessage(type, payload));
    }

    destroy() {
        clearInterval(this._pingTimer);
        clearInterval(this._statusTimer);
        if (this._off) {
            this._off();
        }
        this.engine.netHook = null;
        this.engine.onStep = null;
    }

    send(type, payload) {
        this.transport.send(type, payload);
    }

    // ------------------------------------------------------------- handshake

    /**
     * Measure the link before the first serve.
     *
     * Seven probes at 250 ms fit inside the countdown, so the sync costs nothing
     * anyone can see.
     */
    async warmUp({ probes = 7, spacingMs = 250 } = {}) {
        for (let i = 0; i < probes; i++) {
            this.sync.ping();
            await sleep(spacingMs);
        }
        this._pingTimer = setInterval(() => this.sync.ping(), PING_EVERY_MS);
        this._statusTimer = setInterval(() => this._pushStatus(), 1000);
        this._pushStatus();
    }

    /**
     * Put the match in play on the shared time base.
     *
     * Both roles call this with the very same parameters, which the server
     * decides and broadcasts on the room channel. Having the host announce them
     * would mean trusting a client with the clock every rewind is measured
     * against.
     */
    beginMatch({ t0, seed, matchPoint, firstServer }) {
        this.engine.startNetMatch({ t0, seed, matchPoint, server: firstServer });
        this._applyPointDelay();
    }

    // ------------------------------------------------------------- per tick

    onStep(tick) {
        this.ring.push(this.sim.getState());

        if (tick % SAMPLE_EVERY === 0) {
            const pad = this.sim.paddle[this.localSide];
            const vel = this.sim.paddleVel[this.localSide];
            this.localSamples.push([tick, pad.x, pad.y, vel.x, vel.y]);
            if (this.localSamples.length > SAMPLES_PER_MESSAGE * 3) {
                this.localSamples.shift();
            }
        }

        // Ease the peer's paddle towards its last reported pose. It arrives at
        // 12 Hz; stepping straight to it would look like a strobe.
        if (this.remoteTarget) {
            const pad = this.sim.paddle[this.remoteSide];
            const k = Math.min(1, STEP_H * 18);
            const nx = pad.x + (this.remoteTarget.x - pad.x) * k;
            const ny = pad.y + (this.remoteTarget.y - pad.y) * k;
            this.sim.setPaddle(this.remoteSide, nx, ny, this.remoteTarget.vx, this.remoteTarget.vy);
        }

        if (this.replaying) {
            return;
        }
        if (this.isHost && tick % SNAPSHOT_EVERY === 0) {
            this._sendSnapshot();
        }
        if (!this.isHost && tick % INPUT_EVERY === 0) {
            this._sendInput();
        }
    }

    _sendSnapshot() {
        this.snapshotSeq++;
        const samples = this.localSamples.slice(-SAMPLES_PER_MESSAGE);
        this.send(MSG.STATE, encodeSnapshot(this.sim, this.snapshotSeq, samples, this.localSide));
        this.stats.snapshotsOut++;
    }

    _sendInput() {
        this.inputSeq++;
        const samples = this.localSamples.slice(-SAMPLES_PER_MESSAGE);
        if (!samples.length) {
            return;
        }
        this.send(MSG.INPUT, encodeInput(this.inputSeq, this.sim.tick, samples));
    }

    // -------------------------------------------------------- engine events

    onSimEvent(event) {
        if (this.replaying) {
            return;
        }
        if (event.type === "hit") {
            this.lastHitTick = event.tick;
        }
        if (event.type === "hit" && event.side === this.localSide && !this.isHost) {
            this._sendClaim(event);
            return;
        }
        if (!this.isHost) {
            return;
        }
        // The host relays what a guest cannot derive on its own.
        if (event.type === "point") {
            this.send(MSG.EVENT, {
                e: "pt", tick: event.tick || this.sim.tick, winner: event.winner,
                reason: event.reason, score: event.score, server: event.server,
                resumeAtTick: event.resumeAtTick, endAtTick: event.endAtTick,
                pointIndex: this.sim.pointIndex,
            });
        } else if (event.type === "hit" && event.side === this.localSide) {
            /* The single most valuable message in the protocol.
             *
             * A guest predicts the host's return from a paddle pose that is a
             * round trip old, so its guess can be off by a metre by the time the
             * periodic snapshot lands. Sending the stroke the instant it happens
             * cuts that to half a round trip and makes the correction exact
             * rather than approximate. */
            this.send(MSG.EVENT, {
                e: "ht", tick: event.tick,
                p: event.outPos, v: event.outVel, w: event.outSpin,
            });
        } else if (event.type === "serve" && event.side === this.localSide) {
            this.send(MSG.EVENT, { e: "sv", tick: event.tick, side: event.side });
        } else if (event.type === "end") {
            this.send(MSG.EVENT, {
                e: "end", score: event.score, hits: event.hits, rallies: event.rallies,
            });
        }
    }

    /** The guest has struck the ball and already drawn it. Ask for a ruling. */
    _sendClaim(event) {
        this.claimId++;
        const claim = encodeClaim(
            this.claimId,
            event.tick,
            { pos: vec(event.prePos), vel: vec(event.preVel) },
            { x: event.paddle[0], y: event.paddle[1] },
            { x: event.paddleVel[0], y: event.paddleVel[1] },
            vec(event.outVel),
            vec(event.outSpin)
        );
        this.openClaims.set(this.claimId, event.tick);
        this.send(MSG.CLAIM, claim);
        this.stats.claimsSent++;
    }

    /** The guest serves locally; the host reproduces it from the shared seed. */
    claimServe(tick) {
        this.claimId++;
        this.send(MSG.CLAIM, { k: 1, id: this.claimId, t: tick, sv: 1 });
        this.stats.claimsSent++;
    }

    // ------------------------------------------------------------- messages

    onMessage(type, payload) {
        switch (type) {
            case MSG.PING:
                this.send(MSG.PONG, { id: payload.id, t0: payload.t0, t1: Date.now() });
                break;
            case MSG.PONG:
                this.sync.onPong(payload);
                this.clock.offset = this.isHost ? 0 : this.sync.offset;
                this._applyPointDelay();
                this._pushStatus();
                break;
            case MSG.STATE:
                this._onSnapshot(payload);
                break;
            case MSG.INPUT:
                this._onInput(payload);
                break;
            case MSG.CLAIM:
                this._onClaim(payload);
                break;
            case MSG.EVENT:
                this._onRemoteEvent(payload);
                break;
            default:
                break;
        }
    }

    _onInput(msg) {
        const { seq, samples } = decodeInput(msg);
        if (seq <= this.lastInputSeq) {
            this.stats.stale++;
            return;                                  // replayed or reordered
        }
        this.lastInputSeq = seq;
        const [, x, y, vx, vy] = samples[samples.length - 1];
        this.remoteTarget = { x, y, vx, vy };
        this.remoteSamples = samples;
    }

    // -------------------------------------------------- guest: reconcile

    _onSnapshot(msg) {
        if (msg.q <= this.lastSnapshotSeq) {
            this.stats.stale++;
            return;
        }
        this.lastSnapshotSeq = msg.q;
        this.stats.snapshotsIn++;

        const { state, paddle } = decodeSnapshot(msg);
        if (paddle.length) {
            const [, x, y, vx, vy] = paddle[paddle.length - 1];
            this.remoteTarget = { x, y, vx, vy };
        }

        // A reconnect delivers a burst of old snapshots at once. Without this
        // the ball rubber-bands hard.
        if (state.tick <= this.lastAppliedTick) {
            this.stats.stale++;
            return;
        }

        const now = this.sim.tick;
        const predicted = this.ring.get(state.tick);
        if (state.tick > now || !predicted) {
            this._adopt(state, now, true);
            return;
        }

        const posErr = distance(predicted.pos, state.pos);
        const velErr = distance(predicted.vel, state.vel);
        const discrete = predicted.lastHit !== state.lastHit
            || predicted.phase !== state.phase
            || predicted.score[0] !== state.score[0]
            || predicted.score[1] !== state.score[1];

        if (state.phase === "rally" && predicted.phase === "rally") {
            this.stats.lastError = posErr;
            this.stats.worstError = Math.max(this.stats.worstError, posErr);
            this.stats.errorSum += posErr;
            this.stats.errorCount++;
        }

        const deadzone = (now - this.lastHitTick) * STEP_H < 0.2 ? DEADZONE_AFTER_HIT : DEADZONE;
        if (!discrete && posErr < deadzone && velErr < VEL_DEADZONE) {
            this.lastAppliedTick = state.tick;
            return;                                  // close enough; leave it be
        }
        this._adopt(state, now, discrete || posErr >= SOFT_LIMIT, predicted);
    }

    /**
     * Take the host's state and re-derive the present from it.
     *
     * The ball on screen does not jump: the difference is held as a render
     * offset and decays over a few frames. Velocity and spin are adopted at
     * once, since neither is directly visible.
     */
    _adopt(state, targetTick, hard, predicted = null) {
        /* Only a live ball is worth easing across. Between points the ball is
           rolling loose or parked on a paddle, the two sides legitimately place
           it differently, and sliding it around would draw attention to
           something nobody is looking at. */
        const live = state.phase === "rally" && this.sim.phase === "rally";
        const drawnBefore = this._tmp.copy(this.sim.ball.pos).clone();

        this.sim.setState(state, { paddles: false });
        if (predicted) {
            this.sim.paddle[0].fromArray(predicted.paddle[0]);
            this.sim.paddle[1].fromArray(predicted.paddle[1]);
            this.sim.paddleVel[0].fromArray(predicted.paddleVel[0]);
            this.sim.paddleVel[1].fromArray(predicted.paddleVel[1]);
        }
        this._replayTo(targetTick, GUEST_MUTED);

        this.lastAppliedTick = state.tick;
        if (!live) {
            this.engine.view.setRenderOffset(null);
            return;
        }

        const offset = drawnBefore.sub(this.sim.ball.pos);
        this.stats.corrections++;
        if (offset.length() > SNAP_LIMIT) {
            this.stats.snaps++;
            this.engine.view.clearTrail();
            this.engine.view.setRenderOffset(null);
        } else {
            this.engine.view.setRenderOffset(offset, hard ? 0.06 : 0.12);
        }
    }

    /** Re-simulate from the current tick up to `targetTick`, in silence. */
    _replayTo(targetTick, muted) {
        this.replaying = true;
        this.sim.mutedEvents = muted;
        let guard = 0;
        while (this.sim.tick < targetTick && guard++ < 600) {
            const past = this.ring.get(this.sim.tick + 1);
            if (past) {
                this.sim.paddle[0].fromArray(past.paddle[0]);
                this.sim.paddle[1].fromArray(past.paddle[1]);
                this.sim.paddleVel[0].fromArray(past.paddleVel[0]);
                this.sim.paddleVel[1].fromArray(past.paddleVel[1]);
            }
            this.sim.step();
            this.ring.push(this.sim.getState());
        }
        this.sim.mutedEvents = null;
        this.replaying = false;
    }

    // ------------------------------------------------------ guest: rulings

    _onRemoteEvent(msg) {
        switch (msg.e) {
            case "pt":
                this._applyRemotePoint(msg);
                break;
            case "ht":
                this._applyRemoteHit(msg);
                break;
            case "sv":
                this._applyRemoteServe(msg);
                break;
            case "end":
                this.sim.phase = "over";
                this.sim.score[0] = msg.score[0];
                this.sim.score[1] = msg.score[1];
                this.engine.emit({
                    type: "end", score: msg.score, hits: msg.hits, rallies: msg.rallies,
                });
                break;
            case "hok":
                this.openClaims.delete(msg.id);
                this.stats.claimsAccepted++;
                break;
            case "hno":
                this.openClaims.delete(msg.id);
                this.stats.claimsRejected++;
                this.engine.emit({ type: "claim:rejected", reason: msg.r });
                break;
            default:
                break;
        }
    }

    /**
     * The score is the host's to declare.
     *
     * Applied at the guest's current tick rather than rewound into place: the
     * ball is irrelevant once a rally is dead, and `resumeAtTick` is an absolute
     * tick on the shared clock, so both sides come back to life on the same step
     * with no timer involved.
     */
    _applyRemotePoint(msg) {
        if (msg.pointIndex < this.sim.pointIndex) {
            return;                                  // already moved past it
        }
        this.sim.score[0] = msg.score[0];
        this.sim.score[1] = msg.score[1];
        this.sim.server = msg.server;
        this.sim.phase = "dead";
        this.sim.pendingPoint = null;
        this.sim.resumeAtTick = msg.resumeAtTick;
        this.sim.endAtTick = msg.endAtTick;
        this.engine.emit({
            type: "point", winner: msg.winner, reason: msg.reason,
            score: msg.score, server: msg.server,
        });
    }

    /**
     * The host struck the ball. Put that stroke exactly where it happened.
     *
     * The guest had predicted a return of its own from a stale paddle pose; this
     * replaces it with the real one, rewound to the tick it occurred on, and
     * re-derives the present from there. Whatever the prediction got wrong is
     * absorbed by the render offset rather than snapping.
     */
    _applyRemoteHit(msg) {
        const target = this.sim.tick;
        const wasLive = this.sim.phase === "rally";
        const drawn = this._tmp.copy(this.sim.ball.pos).clone();
        const stored = this.ring.get(msg.tick);

        if (stored) {
            this.sim.setState(stored);
        }
        this.sim.ball.pos.fromArray(msg.p);
        this.sim.ball.vel.fromArray(msg.v);
        this.sim.ball.spin.fromArray(msg.w);
        this.sim.lastHit = this.remoteSide;
        this.sim.serveBall = false;
        this.sim.bouncedOwn = false;
        this.sim.bouncedOpp = false;
        this.sim.hitCool[this.remoteSide] = HIT_COOL;
        this.sim.phase = "rally";

        if (stored && msg.tick < target) {
            this._replayTo(target, GUEST_MUTED);
        }
        this.lastHitTick = msg.tick;

        const offset = drawn.sub(this.sim.ball.pos);
        if (!wasLive) {
            this.engine.view.setRenderOffset(null);
        } else if (offset.length() > SNAP_LIMIT) {
            this.engine.view.clearTrail();
            this.engine.view.setRenderOffset(null);
            this.stats.snaps++;
        } else {
            this.engine.view.setRenderOffset(offset, 0.06);
        }
        if (wasLive) {
            this.stats.corrections++;
        }
        this.engine.view.addShake(0.16);
    }

    _applyRemoteServe(msg) {
        if (this.sim.phase !== "serve" || this.sim.server !== msg.side) {
            return;
        }
        const target = this.sim.tick;
        const stored = this.ring.get(msg.tick);
        if (stored && msg.tick < target) {
            this.sim.setState(stored);
            this.sim.serve(msg.side);
            this._replayTo(target, GUEST_MUTED);
        } else {
            this.sim.serve(msg.side);
        }
    }

    // -------------------------------------------------------- host: rulings

    /**
     * Rule on a guest's claim.
     *
     * The host rewinds to the claimed tick, checks the claim against the ball it
     * had there, and then **recomputes the stroke itself** from its own ball and
     * the claimed paddle. The shot the guest sent is only kept as a divergence
     * metric. That removes the whole class of doctored-shot cheats, and because
     * the stroke is deterministic the result matches what the guest already drew,
     * so accepting costs no visible correction.
     */
    _onClaim(msg) {
        if (!this.isHost) {
            return;
        }
        const side = this.remoteSide;
        const now = this.sim.tick;
        const tick = msg.t;

        const reject = (code) => {
            this.stats.claimsRejected++;
            this.send(MSG.EVENT, { e: "hno", id: msg.id, r: code });
        };

        if (tick > now + FUTURE_SLACK_TICKS || tick < now - this.rewindTicks) {
            reject(REJECT.WINDOW);
            return;
        }
        const stored = this.ring.get(Math.min(tick, now));
        if (!stored) {
            reject(REJECT.NO_HISTORY);
            return;
        }
        if (msg.sv) {
            this._acceptServe(stored, now, msg.id);
            return;
        }

        const claim = decodeClaim(msg);
        if (stored.phase !== "rally") {
            reject(REJECT.STALE_POINT);
            return;
        }
        if (stored.hitCool[side] > 0) {
            reject(REJECT.COOLDOWN);
            return;
        }
        // The ball has to have been on its way to that end.
        const approach = -shotDir(side);
        if (stored.vel[2] * approach <= 0) {
            reject(REJECT.DIRECTION);
            return;
        }
        if (distance(stored.pos, claim.pos) > 0.10) {
            reject(REJECT.BALL_APART);
            return;
        }
        const [px, py] = claim.paddle;
        if (Math.abs(px) > PADDLE_X_LIMIT + 0.02 || py < PADDLE_Y_MIN - 0.02 || py > PADDLE_Y_MAX + 0.02) {
            reject(REJECT.PADDLE_ILLEGAL);
            return;
        }
        // A paddle cannot teleport: compare with the pose the guest last sent.
        if (this.remoteTarget) {
            const jump = Math.hypot(px - this.remoteTarget.x, py - this.remoteTarget.y);
            if (jump > 0.35) {
                reject(REJECT.PADDLE_JUMP);
                return;
            }
        }
        const dx = stored.pos[0] - px;
        const dy = stored.pos[1] - py;
        const reach = HIT_RADIUS + 0.05;             // the guest predicted, allow for it
        if (dx * dx + dy * dy > reach * reach) {
            reject(REJECT.NO_CONTACT);
            return;
        }

        this.sim.setState(stored);
        this.sim.setPaddle(side, px, py, claim.paddleVel[0], claim.paddleVel[1]);
        this.sim.hitCool[side] = 0;
        this.sim.hit(side);
        this._replayTo(now, COSMETIC);
        this.stats.claimsAccepted++;
        this.send(MSG.EVENT, { e: "hok", id: msg.id, t: tick });
        this._sendSnapshot();                        // let the guest confirm at once
    }

    _acceptServe(stored, now, id) {
        if (stored.phase !== "serve" || stored.server !== this.remoteSide) {
            this.stats.claimsRejected++;
            this.send(MSG.EVENT, { e: "hno", id, r: REJECT.STALE_POINT });
            return;
        }
        this.sim.setState(stored);
        this.sim.serve(this.remoteSide);             // same seed, same serve
        this._replayTo(now, COSMETIC);
        this.stats.claimsAccepted++;
        this.send(MSG.EVENT, { e: "hok", id, t: stored.tick });
        this._sendSnapshot();
    }

    // ---------------------------------------------------------------- misc

    /**
     * Size the two windows that depend on the link.
     *
     * The rewind window has to outlast a claim in flight, and the verdict delay
     * has to outlast the rewind window: awarding a point before a valid claim
     * could still arrive is what makes a guest's return vanish.
     */
    _applyPointDelay() {
        if (!this.isHost) {
            this.sim.pointDelayTicks = 0;
            return;
        }
        const oneWayMs = this.sync.rtt / 2;
        this.rewindTicks = Math.max(
            REWIND_TICKS_MIN,
            Math.min(REWIND_TICKS_MAX, Math.ceil((oneWayMs * 1.6) / 1000 / STEP_H))
        );
        this.sim.pointDelayTicks = this.rewindTicks + Math.round(0.03 / STEP_H);
    }

    _pushStatus() {
        // `rtt` is the peer round trip: two HTTP legs plus two bus deliveries.
        // `httpRtt` is one HTTP leg on its own, when the transport can measure
        // it. The difference is what the bus costs, and it is the only way to
        // tell a slow link from a busy server.
        const transport = this.transport;
        this.onStatus({
            rtt: Math.round(this.sync.rtt),
            httpRtt: transport && transport.httpRtt ? transport.httpRtt : 0,
            inFlight: transport ? transport.inFlight || 0 : 0,
            superseded: transport ? transport.superseded || 0 : 0,
            offset: Math.round(this.sync.offset),
            ready: this.sync.ready,
            stats: this.stats,
        });
    }
}

function vec(array) {
    return new THREE.Vector3(array[0], array[1], array[2]);
}

function distance(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
