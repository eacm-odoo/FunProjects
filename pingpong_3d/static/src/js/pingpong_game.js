/** @odoo-module **/

import { App, Component, onMounted, onWillUnmount, useRef, useState, whenReady } from "@odoo/owl";
import { getTemplate } from "@web/core/templates";
import { rpc } from "@web/core/network/rpc";

import { DIFFS, REASON, WIN, other } from "./engine/constants.js";
import { LoopbackLab } from "./loopback_lab.js";
import { BusTransport } from "./net/bus_transport.js";
import { NetGame } from "./net/netgame.js";
import { PingPongEngine } from "./pingpong_engine.js";

/* The page component.
 *
 * It owns the screens, the room and the server calls; the engine owns the
 * canvas and the match, and a NetGame owns the peer. The engine imports nothing
 * from Odoo, which is what lets the same code run against a fake transport in a
 * bench and against the bus here.
 */

const DIFF_BLURB = {
    facil: "Devuelve lento y con poco efecto",
    normal: "Ritmo de club, algo de liftado",
    dificil: "Rápido, coloca y castiga los fallos",
    experto: "Reacción casi perfecta y efecto pesado",
};

const NICKNAME_KEY = "pingpong_nickname";
const TOKEN_KEY = "pingpong_player_token";

export class PingPongGame extends Component {
    static template = "pingpong_3d.Game";
    static props = {
        scoreUrl: { type: String, optional: true },
    };
    static defaultProps = { scoreUrl: "" };

    setup() {
        this.bus = this.env.services && this.env.services.bus_service;
        this.matchPoint = WIN;
        this.engine = null;
        this.transport = null;
        this.toastTimer = null;
        this.channels = [];

        this.stageRef = useRef("stage");
        this.powVal = useRef("powVal");
        this.powBar = useRef("powBar");
        this.spinVal = useRef("spinVal");
        this.spinBar = useRef("spinBar");

        this.state = useState({
            screen: "menu",             // menu | lobby | playing | over
            mode: "solo",               // solo | online
            paused: false,
            busy: false,
            error: "",
            difficulty: "normal",
            nickname: readStored(NICKNAME_KEY) || "",
            joinCode: "",
            room: null,                 // {code, role, slot, players, state}
            rtt: 0,
            httpRtt: 0,
            superseded: 0,
            inFlight: 0,
            opponentGone: "",
            score: [0, 0],
            server: 0,
            camLabel: "jugador",
            toast: null,
            result: null,
        });

        // Side 0 is the +Z end on every machine; the host plays it, so a guest
        // sits at side 1 and only its camera and pointer are mirrored.
        this.localSide = 0;
        this.opponentName = "la máquina";

        this.difficulties = Object.entries(DIFFS).map(([key, diff]) => ({
            key,
            name: diff.name,
            blurb: DIFF_BLURB[key] || "",
        }));

        onMounted(() => {
            this._buildEngine("solo", 0);
            this._subscribeBus();
            // A shared /pingpong?room=PONG-XXXX link fills the code in, so the
            // invitee only has to press Unirse.
            const invited = new URLSearchParams(window.location.search).get("room");
            if (invited) {
                this.state.joinCode = invited.toUpperCase();
            }
            this._boundUnload = () => this._beaconLeave();
            window.addEventListener("pagehide", this._boundUnload);
        });

        onWillUnmount(() => {
            clearTimeout(this.toastTimer);
            window.removeEventListener("pagehide", this._boundUnload);
            this._leaveChannels();
            this._destroyEngine();
        });
    }

    // ------------------------------------------------------------ getters

    get remoteSide() {
        return other(this.localSide);
    }

    get difficultyName() {
        return DIFFS[this.state.difficulty].name;
    }

    get serverName() {
        return this.state.server === this.localSide ? "tú" : this.opponentName;
    }

    get opponentLabel() {
        return this.state.mode === "online" ? this.opponentName : "Máquina";
    }

    get isHost() {
        return Boolean(this.state.room && this.state.room.role === "host");
    }

    get canStart() {
        return this.isHost && this.state.room.players.length >= 2;
    }

    get shareUrl() {
        if (!this.state.room) {
            return "";
        }
        return `${window.location.origin}/pingpong?room=${this.state.room.code}`;
    }

    // ------------------------------------------------------- engine plumbing

    _buildEngine(role, localSide) {
        this._destroyEngine();
        this.localSide = localSide;
        this.engine = new PingPongEngine(this.stageRef.el, {
            role,
            localSide,
            difficulty: this.state.difficulty,
            matchPoint: this.matchPoint,
            onEvent: (event) => this.onEngineEvent(event),
        });
        this.engine.start();
    }

    _destroyEngine() {
        if (this.engine) {
            this.engine.destroy();          // also disposes its NetGame
            this.engine = null;
        }
        if (this.transport) {
            this.transport.close();
            this.transport = null;
        }
    }

    // --------------------------------------------------------------- solo

    setDifficulty(key) {
        this.state.difficulty = key;
    }

    startSolo() {
        if (this.engine.role !== "solo") {
            this._buildEngine("solo", 0);
        }
        this.state.mode = "solo";
        this.opponentName = "la máquina";
        this.state.screen = "playing";
        this.state.paused = false;
        this.state.result = null;
        this.engine.startMatch({ difficulty: this.state.difficulty, server: 0 });
        this.syncScore();
        this.toast("¡A jugar!", "Pulsa Espacio para sacar", 1400);
    }

    // ------------------------------------------------------------- online

    async createRoom() {
        await this._enterRoom("/pingpong/online/create", { nickname: this.state.nickname });
    }

    async joinRoom() {
        const code = (this.state.joinCode || "").trim().toUpperCase();
        if (!code) {
            this.state.error = "Escribe un código de sala.";
            return;
        }
        await this._enterRoom("/pingpong/online/join", {
            code,
            nickname: this.state.nickname,
        });
    }

    async _enterRoom(route, params) {
        this.state.busy = true;
        this.state.error = "";
        try {
            const result = await rpc(route, params);
            if (!result.ok) {
                this.state.error = result.error || "No se pudo entrar en la sala.";
                return;
            }
            storeValue(NICKNAME_KEY, this.state.nickname);
            storeValue(TOKEN_KEY, result.player_token);
            this.playerToken = result.player_token;
            this._applyRoom(result.session);
            this._joinChannels(result.session);
            this.state.screen = "lobby";
        } catch (error) {
            this.state.error = String(error.message || error);
        } finally {
            this.state.busy = false;
        }
    }

    _applyRoom(session) {
        this.state.room = {
            code: session.code,
            state: session.state,
            role: session.role,
            slot: session.slot,
            channel: session.channel,
            inbox: session.inbox,
            players: session.players || [],
        };
        this.matchPoint = session.match_point || WIN;
        const peer = (session.players || []).find((p) => p.slot !== session.slot);
        this.opponentName = (peer && peer.name) || "tu rival";
    }

    async startOnlineMatch() {
        this.state.busy = true;
        try {
            const result = await rpc("/pingpong/online/start", {
                player_token: this.playerToken,
            });
            if (!result.ok) {
                this.state.error = result.error || "No se pudo empezar.";
            }
        } finally {
            this.state.busy = false;
        }
    }

    async leaveRoom() {
        const token = this.playerToken;
        this._leaveChannels();
        this.state.room = null;
        this.state.screen = "menu";
        this.state.mode = "solo";
        this.state.opponentGone = "";
        this._buildEngine("solo", 0);
        if (token) {
            this.playerToken = null;
            clearStored(TOKEN_KEY);
            await rpc("/pingpong/online/leave", { player_token: token }).catch(() => {});
        }
    }

    _beaconLeave() {
        if (!this.playerToken || !navigator.sendBeacon) {
            return;
        }
        // `pagehide` rather than `beforeunload`: the latter is unreliable on
        // mobile and skipped for the back/forward cache.
        navigator.sendBeacon(
            "/pingpong/online/beacon_leave",
            new Blob([JSON.stringify({ player_token: this.playerToken })],
                     { type: "application/json" })
        );
    }

    copyCode() {
        if (navigator.clipboard && this.state.room) {
            navigator.clipboard.writeText(this.state.room.code).catch(() => {});
            this.toast("Código copiado", this.state.room.code, 900);
        }
    }

    // ------------------------------------------------------------- the bus

    _subscribeBus() {
        if (!this.bus) {
            return;
        }
        this._onLobby = (payload) => this._handleLobby(payload);
        this._onScore = (payload) => this._handleScore(payload);
        this._onStart = (payload) => this._handleStart(payload);
        this._onEnd = (payload) => this._handleEnd(payload);
        this._onPeer = (payload) => this.transport && this.transport.receive(payload);
        this.bus.subscribe("pp_lobby", this._onLobby);
        this.bus.subscribe("pp_score", this._onScore);
        this.bus.subscribe("pp_start", this._onStart);
        this.bus.subscribe("pp_end", this._onEnd);
        this.bus.subscribe("pp_msg", this._onPeer);
    }

    _joinChannels(session) {
        if (!this.bus) {
            return;
        }
        this._leaveChannels();
        for (const channel of [session.channel, session.inbox]) {
            if (channel) {
                this.bus.addChannel(channel);
                this.channels.push(channel);
            }
        }
    }

    _leaveChannels() {
        if (this.bus) {
            for (const channel of this.channels) {
                this.bus.deleteChannel(channel);
            }
        }
        this.channels = [];
    }

    _handleLobby(payload) {
        if (!this.state.room || payload.code !== this.state.room.code) {
            return;
        }
        this.state.room = { ...this.state.room, state: payload.state, players: payload.players };
        const peer = payload.players.find((p) => p.slot !== this.state.room.slot);
        this.opponentName = (peer && peer.name) || "tu rival";
    }

    /**
     * The server has put the match in play.
     *
     * Both peers receive the same message on the room channel, so both anchor
     * their clock to the same instant and derive the same tick from it. The
     * countdown is simply the gap between now and that instant.
     */
    async _handleStart(payload) {
        if (!this.state.room) {
            return;
        }
        const role = this.state.room.role;
        const localSide = role === "host" ? 0 : 1;
        this._buildEngine(role, localSide);

        this.transport = new BusTransport({ rpc, playerToken: this.playerToken });
        this.engine.net = new NetGame(this.engine, this.transport, {
            role,
            onStatus: (status) => {
                this.state.rtt = status.rtt;
                this.state.httpRtt = status.httpRtt;
                this.state.superseded = status.superseded;
                this.state.inFlight = status.inFlight;
            },
        });

        this.state.mode = "online";
        this.state.screen = "playing";
        this.state.result = null;
        this.state.opponentGone = "";
        this.toast("Sincronizando…", "midiendo la latencia", 1200);

        // The clock probes fit inside the gap before tick 0, so the sync costs
        // nothing anybody can see.
        await this.engine.net.warmUp({ probes: 5, spacingMs: 200 });
        this.engine.net.beginMatch({
            t0: payload.t0,
            seed: payload.seed,
            matchPoint: payload.match_point,
            firstServer: payload.first_server,
        });
        this.syncScore();
        this.toast("¡A jugar!", "Pulsa Espacio para sacar", 1400);
    }

    /**
     * The authoritative score.
     *
     * Both clients already move their own scoreboard from the host's point
     * event; this is the server's tally, and it wins. No toast: the peer event
     * owns the announcement and its timing.
     */
    _handleScore(payload) {
        if (!this.state.room || !this.engine) {
            return;
        }
        const sim = this.engine.sim;
        sim.score[0] = payload.host;
        sim.score[1] = payload.guest;
        this.state.score = [payload.host, payload.guest];
    }

    _handleEnd(payload) {
        if (!this.state.room) {
            return;
        }
        if (payload.reason === "finished") {
            this._showOnlineResult(payload);
            return;
        }
        this.state.opponentGone = payload.reason === "host_left"
            ? "El anfitrión cerró la sala."
            : "Tu rival se fue.";
        if (this.engine) {
            this.engine.stopMatch();
        }
    }

    // ------------------------------------------------------------- actions

    toMenu() {
        if (this.state.room) {
            this.leaveRoom();
            return;
        }
        this.engine.stopMatch();
        this.state.screen = "menu";
        this.state.paused = false;
        this.state.result = null;
    }

    setPaused(paused) {
        // Pausing is local to a solo match. Online, one player cannot stop the
        // other's clock, so the key is simply ignored.
        if (this.state.screen !== "playing" || this.state.mode === "online") {
            return;
        }
        this.state.paused = paused;
        this.engine.setPaused(paused);
    }

    cycleCamera() {
        this.state.camLabel = this.engine.cycleCamera();
    }

    // -------------------------------------------------------------- events

    onEngineEvent(event) {
        switch (event.type) {
            case "serve":
            case "hit":
                if (event.side === this.localSide) {
                    this.pulse(event.speed, event.topspin);
                }
                break;
            case "net":
                this.toast("¡Red!", "", 700);
                break;
            case "point":
                this.syncScore();
                this._reportPoint(event);
                this.toast(
                    event.winner === this.localSide ? "Punto para ti" : `Punto para ${this.opponentName}`,
                    this.reasonText(event.reason, event.winner),
                    1200
                );
                break;
            case "end":
                this.onMatchEnd(event);
                break;
            case "ui:space":
                if (this.state.screen === "menu" && this.state.mode === "solo") {
                    this.startSolo();
                }
                break;
            case "ui:pause":
                this.setPaused(!this.state.paused);
                break;
            case "ui:camera":
                this.state.camLabel = event.label;
                break;
            default:
                break;
        }
    }

    /** Only the host reports, and it reports the verdict, never the score. */
    _reportPoint(event) {
        if (this.state.mode !== "online" || !this.isHost) {
            return;
        }
        rpc("/pingpong/online/point", {
            player_token: this.playerToken,
            winner: event.winner,
            reason: event.reason,
        }).catch(() => {});
    }

    syncScore() {
        const sim = this.engine.sim;
        this.state.score = [sim.score[0], sim.score[1]];
        this.state.server = sim.server;
    }

    onMatchEnd(event) {
        const mine = event.score[this.localSide];
        const theirs = event.score[this.remoteSide];
        this.state.screen = "over";
        this.state.paused = false;
        this.state.result = {
            won: mine > theirs,
            mine,
            theirs,
            hits: event.hits,
            rallies: event.rallies,
        };
        if (this.state.mode === "solo") {
            this.reportScore(event);
        } else if (this.isHost) {
            rpc("/pingpong/online/finish", {
                player_token: this.playerToken,
                hits: event.hits,
                rallies: event.rallies,
                duration: this.engine.sim.tick / 240,
            }).catch(() => {});
        }
    }

    /** The server closed the match: show its figures, not ours. */
    _showOnlineResult(payload) {
        const mine = this.localSide === 0 ? payload.host : payload.guest;
        const theirs = this.localSide === 0 ? payload.guest : payload.host;
        this.state.screen = "over";
        this.state.paused = false;
        this.state.result = {
            won: mine > theirs,
            mine,
            theirs,
            hits: this.engine ? this.engine.sim.hits : 0,
            rallies: this.engine ? this.engine.sim.rallies : 0,
        };
        if (this.engine) {
            this.engine.stopMatch();
        }
    }

    // ----------------------------------------------------------------- UI

    toast(main, sub = "", ms = 1100) {
        this.state.toast = { main, sub };
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            this.state.toast = null;
        }, ms);
    }

    /**
     * Power and spin meters, written straight to the DOM.
     *
     * These fire on every stroke and carry no state anyone else reads, so they
     * skip the reactivity and the re-render that would come with it.
     */
    pulse(speed, topspin) {
        if (!this.powVal.el) {
            return;
        }
        this.powVal.el.textContent = speed.toFixed(1) + " m/s";
        const power = Math.min(1, speed / 16);
        this.powBar.el.style.left = "0%";
        this.powBar.el.style.width = (power * 100).toFixed(0) + "%";

        const spin = Math.max(-1, Math.min(1, topspin / 320));
        this.spinVal.el.textContent = Math.abs(spin) < 0.08 ? "plano" : (spin > 0 ? "liftado" : "cortado");
        this.spinBar.el.style.left = spin > 0 ? "50%" : (50 + spin * 50) + "%";
        this.spinBar.el.style.width = Math.abs(spin) * 50 + "%";
    }

    /** Point reasons travel as codes so each side can phrase them locally. */
    reasonText(reason, winner) {
        const loserIsLocal = other(winner) === this.localSide;
        switch (reason) {
            case REASON.NET_SERVE:
                return "Saque nulo";
            case REASON.OWN_HALF:
                return loserIsLocal ? "La bola cayó en tu propio campo" : "Cayó en su propio campo";
            case REASON.DOUBLE_BOUNCE:
                return "Doble bote — sin devolución";
            case REASON.MISSED:
                return loserIsLocal ? "No llegaste" : `${this.opponentLabel} no llegó`;
            case REASON.OUT:
                return loserIsLocal ? "Tu bola se fue fuera" : `Bola fuera de ${this.opponentName}`;
            default:
                return "Bola perdida";
        }
    }

    reportScore(event) {
        if (!this.props.scoreUrl) {
            return;
        }
        fetch(this.props.scoreUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                difficulty: this.state.difficulty,
                player_score: event.score[this.localSide],
                machine_score: event.score[this.remoteSide],
                hits: event.hits,
                rallies: event.rallies,
            }),
        }).catch(() => {});
    }
}

function readStored(key) {
    try {
        return window.sessionStorage.getItem(key);
    } catch {
        return null;
    }
}

function storeValue(key, value) {
    try {
        window.sessionStorage.setItem(key, value);
    } catch {
        // Private browsing with storage disabled: not worth failing over.
    }
}

function clearStored(key) {
    try {
        window.sessionStorage.removeItem(key);
    } catch {
        // as above
    }
}

/**
 * Reuse the environment the public frontend already built.
 *
 * `web/legacy/js/public/public_root.js` calls `makeEnv()` and `startServices()`
 * on every frontend page and publishes the result on `Component.env`. Starting
 * the services a second time re-runs every service's `start()`, and the
 * notification service then fails to re-register `NotificationContainer` in the
 * `main_components` registry. So: wait for that env, never build a second one.
 */
async function getFrontendEnv(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (!(Component.env && Component.env.services && Object.keys(Component.env.services).length)) {
        if (Date.now() > deadline) {
            // The page can still render; only service-backed features are lost.
            console.warn("pingpong_3d: frontend services never came up, mounting bare");
            return { services: {}, debug: Boolean(odoo.debug) };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return Component.env;
}

/**
 * Mount the game as a standalone OWL app on the public page. Importing this
 * module on any other frontend page does nothing, because the anchor is absent.
 */
whenReady(async () => {
    const root = document.querySelector(".o_pingpong_root");
    if (!root) {
        return;
    }
    const env = await getFrontendEnv();
    // `?net=loopback` swaps the game for the two-pane netcode bench.
    const lab = new URLSearchParams(window.location.search).get("net") === "loopback";
    const Root = lab ? LoopbackLab : PingPongGame;
    const app = new App(Root, {
        env,
        getTemplate,
        dev: Boolean(env.debug),
        props: lab ? {} : { scoreUrl: root.dataset.scoreUrl || "" },
    });
    await app.mount(root);
});
