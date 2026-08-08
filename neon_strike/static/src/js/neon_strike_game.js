/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details. */

import { Component, mount, onMounted, onWillUnmount, useEffect, useRef, useState, whenReady } from "@odoo/owl";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";
import { makeEnv, startServices } from "@web/env";
import { getTemplate } from "@web/core/templates";
import { NeonStrikeEngine } from "./game_engine";
import { MenuBackdrop } from "./menu_backdrop";
import { GLOSSARY } from "./glossary";
import { PERKS } from "./perks";
import { sprite } from "./sprites";

// Perk families shown in the glossary, in reading order.
const PERK_SECTIONS = [
    {
        kind: "passive",
        title: "PERMANENT PERKS · PASSIVE",
        note: "Always on. Every 5 cleared waves you are offered 3 and keep 1, for the rest of the run.",
    },
    {
        kind: "conditional",
        title: "PERMANENT PERKS · CONDITIONAL",
        note: "They only pay off in the right situation: low on lives, without a shield, up close, on a high combo…",
    },
    {
        kind: "active",
        title: "PERMANENT PERKS · ACTIVE",
        note: "Triggered by hand with the 1-4 keys, in the order you picked them up. Each one has its own cooldown.",
    },
];

// Network cadences (host broadcasts state, guest forwards its pointer).
const BROADCAST_MS = 66; // ~15 Hz
const INPUT_MS = 50; // ~20 Hz

export class NeonStrikeGame extends Component {
    static template = "neon_strike.Game";
    static props = { "*": true };

    setup() {
        this.bus = useService("bus_service");
        this.canvasRef = useRef("canvas");
        this.menuCanvasRef = useRef("menuCanvas");

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
            glossary: false, // ships and enemies panel over the menu
            match: null, // {id, code, is_host, slot, channel, participants, max_players, state}
        });

        this.engine = null;
        this.backdrop = null;
        // Glossary cards are rasterized once (see `glossaryGroups`).
        this._glossary = null;
        this._broadcastHandle = null;
        this._inputHandle = null;
        this._pendingInput = null;
        this._broadcasting = false;

        // Bus handlers (registered once, removed on unmount).
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

        // Create/destroy the engine when entering/leaving the game screen.
        useEffect(
            () => {
                if (this.state.screen === "game" && this.canvasRef.el) {
                    this._startEngine();
                }
                return () => this._stopEngine();
            },
            () => [this.state.screen]
        );

        // Animated menu backdrop: it only lives while the menu is visible, so no
        // rAF is left running during the match.
        useEffect(
            () => {
                if (this.state.screen === "menu" && this.menuCanvasRef.el) {
                    this.backdrop = new MenuBackdrop(this.menuCanvasRef.el);
                    this.backdrop.start();
                }
                return () => this._stopBackdrop();
            },
            () => [this.state.screen]
        );

        onMounted(() => this.loadScores());
        onWillUnmount(() => this._cleanup());
    }

    /* ------------------------------------------------------------------ */
    /* Glossary                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * Glossary groups with every card already rasterized to a data URL.
     * Computed once and cached: `toDataURL()` is not cheap and the getter runs
     * on every render of the panel.
     */
    get glossaryGroups() {
        if (!this._glossary) {
            this._glossary = GLOSSARY.map((group) => ({
                ...group,
                items: group.items.map((item) => ({
                    ...item,
                    src: sprite(item.sprite, item.tint, item.px, false).toDataURL(),
                })),
            }));
        }
        return this._glossary;
    }

    /**
     * The 50 perks grouped by family for the glossary. They carry no sprite,
     * so they are rendered as text cards tinted with the perk colour.
     */
    get perkGroups() {
        return PERK_SECTIONS.map((section) => ({
            ...section,
            items: PERKS.filter((p) => p.kind === section.kind).map((p) => ({
                ...p,
                cdLabel: p.cd ? Math.round(p.cd / 60) + " s cooldown" : "",
                coop: p.req === "coop",
            })),
        }));
    }

    toggleGlossary() {
        this.state.glossary = !this.state.glossary;
    }

    /** Close the glossary when clicking the dark backdrop, not the panel. */
    onGlossaryBackdrop(ev) {
        if (ev.target === ev.currentTarget) {
            this.state.glossary = false;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Leaderboard                                                         */
    /* ------------------------------------------------------------------ */

    async loadScores() {
        try {
            this.state.scores = await rpc("/neon/scores", {});
        } catch (e) {
            console.warn("Neon Strike: could not load the leaderboard", e);
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
            console.warn("Neon Strike: could not save the score", e);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Engine                                                              */
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
            onAction: (action) => this._sendAction(action),
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

    _stopBackdrop() {
        if (this.backdrop) {
            this.backdrop.destroy();
            this.backdrop = null;
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
            /* transient: retried on the next tick */
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
            /* transient */
        }
    }

    /**
     * Guest one-shot input (dash, active perk, upgrade picked). It does not go
     * through `_pendingInput`: that queue keeps only the last pointer and would
     * drop actions.
     */
    async _sendAction(action) {
        if (!this.state.match) {
            return;
        }
        try {
            // x/y are ignored by the host when `action` travels (see _onInput).
            await rpc("/neon/input", { match_id: this.state.match.id, x: 0, y: 0, action });
        } catch (e) {
            /* transient: the player can press again */
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
        if (this.state.role !== "host" || !this.engine || !payload) {
            return;
        }
        if (payload.a) {
            // One-shot action: it carries no usable pointer.
            this.engine.setRemoteAction(payload.slot, payload.a);
        } else {
            this.engine.setRemoteInput(payload.slot, payload.x, payload.y);
        }
    }

    _onEnd() {
        if (!this.state.match) {
            return;
        }
        this.state.error = "The host left the match.";
        this._leaveToMenu(false);
    }

    /* ------------------------------------------------------------------ */
    /* Screen navigation                                                   */
    /* ------------------------------------------------------------------ */

    _errMsg(e) {
        return (e && e.data && e.data.message) || (e && e.message) || "Error inesperado.";
    }

    _requireNick() {
        if (!(this.state.nickname || "").trim()) {
            this.state.error = "Type a nickname to play.";
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
            this.state.error = "Enter a match code.";
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
        this._stopBackdrop();
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
        return (n || 0).toLocaleString("en-US");
    }

    get isHost() {
        return this.state.match && this.state.match.is_host;
    }
}

/**
 * Bootstrap for the public `/neon` page: mounts the game as a standalone OWL app
 * (no webclient). It only acts when the page contains the anchor point, so
 * importing this module on other frontend pages mounts nothing.
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
