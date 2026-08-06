/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details. */

import { Component, mount, onMounted, onWillUnmount, useEffect, useRef, useState, whenReady } from "@odoo/owl";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";
import { makeEnv, startServices } from "@web/env";
import { getTemplate } from "@web/core/templates";
import { NeonStrikeEngine } from "./game_engine";

// Cadencias de red (host difunde estado, guest reenvía su puntero).
const BROADCAST_MS = 66; // ~15 Hz
const INPUT_MS = 50; // ~20 Hz

export class NeonStrikeGame extends Component {
    static template = "neon_strike.Game";
    static props = { "*": true };

    setup() {
        this.bus = useService("bus_service");
        this.canvasRef = useRef("canvas");

        this.state = useState({
            muted: false,
            scores: [],
            last: null,
            screen: "menu", // menu | lobby | game
            role: "solo", // solo | host | guest
            nickname: "",
            joinCode: "",
            error: "",
            connecting: false,
            match: null, // {id, code, is_host, slot, channel, participants, max_players, state}
        });

        this.engine = null;
        this._broadcastHandle = null;
        this._inputHandle = null;
        this._pendingInput = null;
        this._broadcasting = false;

        // Manejadores del bus (registrados una vez, retirados al desmontar).
        this._handlers = {
            ns_lobby: (p) => this._onLobby(p),
            ns_start: (p) => this._onStart(p),
            ns_state: (p) => this._onState(p),
            ns_input: (p) => this._onInput(p),
            ns_end: (p) => this._onEnd(p),
        };
        for (const [type, cb] of Object.entries(this._handlers)) {
            this.bus.subscribe(type, cb);
        }

        // Crea/destruye el motor al entrar/salir de la pantalla de juego.
        useEffect(
            () => {
                if (this.state.screen === "game" && this.canvasRef.el) {
                    this._startEngine();
                }
                return () => this._stopEngine();
            },
            () => [this.state.screen]
        );

        onMounted(() => this.loadScores());
        onWillUnmount(() => this._cleanup());
    }

    /* ------------------------------------------------------------------ */
    /* Marcadores                                                          */
    /* ------------------------------------------------------------------ */

    async loadScores() {
        try {
            this.state.scores = await rpc("/neon/scores", {});
        } catch (e) {
            console.warn("Neon Strike: no se pudieron cargar los marcadores", e);
        }
    }

    async onGameOver({ score, wave }) {
        this.state.last = { score, wave };
        if (this.state.role === "guest") {
            return;
        }
        if (!score) {
            return;
        }
        try {
            if (this.state.role === "host" && this.state.match) {
                await rpc("/neon/score", { match_id: this.state.match.id, score, wave });
            } else {
                await rpc("/neon/solo_score", { nickname: this.state.nickname, score, wave });
            }
            await this.loadScores();
        } catch (e) {
            console.warn("Neon Strike: no se pudo guardar la puntuación", e);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Motor                                                               */
    /* ------------------------------------------------------------------ */

    _namesBySlot(participants) {
        const names = [];
        for (const p of participants || []) {
            names[p.slot] = p.name;
        }
        return names;
    }

    _startEngine() {
        if (this.engine) {
            return;
        }
        const role = this.state.role;
        const match = this.state.match;
        const slots = match ? match.participants.map((p) => p.slot) : null;
        this.engine = new NeonStrikeEngine(this.canvasRef.el, {
            role,
            players: slots ? slots.length : 1,
            slots,
            localSlot: match ? match.slot : 0,
            names: match ? this._namesBySlot(match.participants) : null,
            onGameOver: (res) => this.onGameOver(res),
            onLocalInput: (x, y) => this._queueInput(x, y),
        });
        this.engine.setMuted(this.state.muted);
        this.engine.start();
        if (role === "host") {
            this.engine.beginPlay();
            this._broadcastHandle = setInterval(() => this._broadcast(), BROADCAST_MS);
        } else if (role === "guest") {
            this._inputHandle = setInterval(() => this._flushInput(), INPUT_MS);
        }
    }

    _stopEngine() {
        if (this._broadcastHandle) {
            clearInterval(this._broadcastHandle);
            this._broadcastHandle = null;
        }
        if (this._inputHandle) {
            clearInterval(this._inputHandle);
            this._inputHandle = null;
        }
        this._pendingInput = null;
        if (this.engine) {
            this.engine.destroy();
            this.engine = null;
        }
    }

    async _broadcast() {
        if (!this.engine || !this.state.match || this._broadcasting) {
            return;
        }
        this._broadcasting = true;
        try {
            await rpc("/neon/state", {
                match_id: this.state.match.id,
                snapshot: this.engine.snapshot(),
            });
        } catch (e) {
            /* transitorio: reintentamos en el siguiente tick */
        } finally {
            this._broadcasting = false;
        }
    }

    _queueInput(x, y) {
        if (!this.state.match) {
            return;
        }
        this._pendingInput = { x: Math.round(x), y: Math.round(y) };
    }

    async _flushInput() {
        if (!this._pendingInput || !this.state.match) {
            return;
        }
        const payload = this._pendingInput;
        this._pendingInput = null;
        try {
            await rpc("/neon/input", { match_id: this.state.match.id, x: payload.x, y: payload.y });
        } catch (e) {
            /* transitorio */
        }
    }

    /* ------------------------------------------------------------------ */
    /* Bus                                                                 */
    /* ------------------------------------------------------------------ */

    _isMine(payload) {
        return payload && this.state.match && payload.id === this.state.match.id;
    }

    _onLobby(payload) {
        if (!this._isMine(payload)) {
            return;
        }
        this.state.match.participants = payload.participants;
        this.state.match.state = payload.state;
    }

    _onStart(payload) {
        if (!this._isMine(payload)) {
            return;
        }
        this.state.match.state = "playing";
        if (this.state.screen !== "game") {
            this.state.screen = "game";
        }
    }

    _onState(snapshot) {
        if (this.state.role === "guest" && this.engine) {
            this.engine.applySnapshot(snapshot);
        }
    }

    _onInput(payload) {
        if (this.state.role === "host" && this.engine && payload) {
            this.engine.setRemoteInput(payload.slot, payload.x, payload.y);
        }
    }

    _onEnd() {
        if (!this.state.match) {
            return;
        }
        this.state.error = "El anfitrión abandonó la partida.";
        this._leaveToMenu(false);
    }

    /* ------------------------------------------------------------------ */
    /* Navegación de pantallas                                             */
    /* ------------------------------------------------------------------ */

    _errMsg(e) {
        return (e && e.data && e.data.message) || (e && e.message) || "Error inesperado.";
    }

    _requireNick() {
        if (!(this.state.nickname || "").trim()) {
            this.state.error = "Escribe un apodo para jugar.";
            return false;
        }
        return true;
    }

    startSolo() {
        this.state.error = "";
        this.state.role = "solo";
        this.state.match = null;
        this.state.screen = "game";
    }

    async createMatch() {
        if (!this._requireNick()) {
            return;
        }
        this.state.error = "";
        this.state.connecting = true;
        try {
            const info = await rpc("/neon/create", { nickname: this.state.nickname });
            this._enterMatch(info, info.is_host ? "host" : "guest");
        } catch (e) {
            this.state.error = this._errMsg(e);
        } finally {
            this.state.connecting = false;
        }
    }

    onCodeKeydown(ev) {
        if (ev.key === "Enter") {
            this.joinMatch();
        }
    }

    async joinMatch() {
        if (!this._requireNick()) {
            return;
        }
        const code = (this.state.joinCode || "").trim();
        if (!code) {
            this.state.error = "Introduce un código de partida.";
            return;
        }
        this.state.error = "";
        this.state.connecting = true;
        try {
            const info = await rpc("/neon/join", { code, nickname: this.state.nickname });
            this._enterMatch(info, info.is_host ? "host" : "guest");
        } catch (e) {
            this.state.error = this._errMsg(e);
        } finally {
            this.state.connecting = false;
        }
    }

    _enterMatch(info, role) {
        this.state.match = info;
        this.state.role = role;
        this.bus.addChannel(info.channel);
        this.state.screen = info.state === "playing" ? "game" : "lobby";
    }

    async startMatch() {
        if (!this.state.match) {
            return;
        }
        try {
            await rpc("/neon/start", { match_id: this.state.match.id });
            this.state.match.state = "playing";
            this.state.screen = "game";
        } catch (e) {
            this.state.error = this._errMsg(e);
        }
    }

    async leaveMatch() {
        await this._leaveToMenu(true);
    }

    async _leaveToMenu(callLeave) {
        const match = this.state.match;
        this._stopEngine();
        if (match) {
            this.bus.deleteChannel(match.channel);
            if (callLeave) {
                try {
                    await rpc("/neon/leave", { match_id: match.id });
                } catch (e) {
                    /* ignore */
                }
            }
        }
        this.state.match = null;
        this.state.role = "solo";
        this.state.screen = "menu";
        this.loadScores();
    }

    async backToMenu() {
        if (this.state.role === "solo") {
            this._stopEngine();
            this.state.screen = "menu";
            this.loadScores();
        } else {
            await this.leaveMatch();
        }
    }

    _cleanup() {
        this._stopEngine();
        for (const [type, cb] of Object.entries(this._handlers || {})) {
            this.bus.unsubscribe(type, cb);
        }
        const match = this.state.match;
        if (match) {
            this.bus.deleteChannel(match.channel);
            rpc("/neon/leave", { match_id: match.id }).catch(() => {});
        }
    }

    /* ------------------------------------------------------------------ */
    /* Toolbar                                                             */
    /* ------------------------------------------------------------------ */

    toggleMute() {
        this.state.muted = !this.state.muted;
        if (this.engine) {
            this.engine.setMuted(this.state.muted);
        }
    }

    restart() {
        if (this.engine && this.state.role !== "guest") {
            this.engine.restartToMenu();
        }
    }

    fmt(n) {
        return (n || 0).toLocaleString("es-MX");
    }

    get isHost() {
        return this.state.match && this.state.match.is_host;
    }
}

/**
 * Bootstrap de la página pública `/neon`: monta el juego como app OWL standalone
 * (sin webclient). Solo actúa si la página contiene el punto de anclaje, de modo
 * que importar este módulo en otras páginas frontend no monta nada.
 */
whenReady(async () => {
    const root = document.querySelector(".o_neon_strike_root");
    if (!root) {
        return;
    }
    const env = makeEnv();
    await startServices(env);
    await mount(NeonStrikeGame, root, {
        env,
        getTemplate,
        dev: env.debug,
    });
});
