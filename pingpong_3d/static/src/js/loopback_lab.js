/** @odoo-module **/

import { Component, onMounted, onWillUnmount, useRef, useState } from "@odoo/owl";

import { WIN } from "./engine/constants.js";
import { NetGame } from "./net/netgame.js";
import { LoopbackLink } from "./net/transport.js";
import { PingPongEngine } from "./pingpong_engine.js";

/**
 * Host and guest, side by side in one tab, over a link you can degrade.
 *
 * Reached with `/pingpong?net=loopback`. Every part of the netcode runs for
 * real here except the transport, which is the point: this is where the
 * expensive bugs are cheap to find, before any of it depends on a server.
 *
 * Watch the guest pane. With the slider at zero the two views should be
 * indistinguishable; at 100 ms they should still look like one game, with the
 * correction figures staying small and the rejection rate near zero.
 */
export class LoopbackLab extends Component {
    static template = "pingpong_3d.LoopbackLab";
    static props = {};

    setup() {
        this.hostRef = useRef("hostStage");
        this.guestRef = useRef("guestStage");

        this.state = useState({
            latency: 50,
            jitter: 15,
            loss: 2,
            started: false,
            host: emptyStats(),
            guest: emptyStats(),
        });

        onMounted(() => this._build());
        onWillUnmount(() => this._teardown());
    }

    _build() {
        this.link = new LoopbackLink({
            latencyMs: this.state.latency,
            jitterMs: this.state.jitter,
            lossRate: this.state.loss / 100,
        });

        this.hostEngine = new PingPongEngine(this.hostRef.el, {
            role: "host", localSide: 0, matchPoint: WIN, onEvent: () => {},
        });
        this.guestEngine = new PingPongEngine(this.guestRef.el, {
            role: "guest", localSide: 1, matchPoint: WIN, onEvent: () => {},
        });
        // Only one of them may read the pointer, or both paddles follow the
        // same hand and neither side is being played by anybody.
        this.guestEngine._onPointerMove = () => {};

        this.hostEngine.net = new NetGame(this.hostEngine, this.link.a, { role: "host" });
        this.guestEngine.net = new NetGame(this.guestEngine, this.link.b, { role: "guest" });

        this.hostEngine.start();
        this.guestEngine.start();

        this._statsTimer = setInterval(() => this._refresh(), 250);
        this._begin();
    }

    async _begin() {
        await Promise.all([
            this.hostEngine.net.warmUp({ probes: 5, spacingMs: 120 }),
            this.guestEngine.net.warmUp({ probes: 5, spacingMs: 120 }),
        ]);
        // No server here, so the lab plays the part: one set of parameters,
        // handed to both peers.
        const params = {
            t0: Date.now() + 300,
            seed: Math.floor(Math.random() * 1e9),
            matchPoint: WIN,
            firstServer: 0,
        };
        this.hostEngine.net.beginMatch(params);
        this.guestEngine.net.beginMatch(params);
        this.state.started = true;
    }

    onLink() {
        this.link.configure({
            latencyMs: Number(this.state.latency),
            jitterMs: Number(this.state.jitter),
            lossRate: Number(this.state.loss) / 100,
        });
    }

    _refresh() {
        this.state.host = readStats(this.hostEngine);
        this.state.guest = readStats(this.guestEngine);
    }

    _teardown() {
        clearInterval(this._statsTimer);
        this.hostEngine.destroy();
        this.guestEngine.destroy();
        this.link.close();
    }
}

function emptyStats() {
    return { score: "0 — 0", tick: 0, rtt: 0, claims: 0, rejects: 0, rejectRate: "0%",
             corrections: 0, snaps: 0, lastError: 0, worstError: 0 };
}

function readStats(engine) {
    const sim = engine.sim;
    const net = engine.net;
    const s = net.stats;
    const claims = s.claimsAccepted + s.claimsRejected;
    return {
        score: `${sim.score[0]} — ${sim.score[1]}`,
        tick: sim.tick,
        rtt: Math.round(net.sync.rtt),
        claims,
        rejects: s.claimsRejected,
        rejectRate: claims ? `${((s.claimsRejected / claims) * 100).toFixed(1)}%` : "—",
        corrections: s.corrections,
        snaps: s.snaps,
        lastError: Math.round(s.lastError * 1000),
        worstError: Math.round(s.worstError * 1000),
    };
}
