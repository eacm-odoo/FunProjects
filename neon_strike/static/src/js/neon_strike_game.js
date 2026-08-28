/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details. */

import { Component, mount, onMounted, onWillUnmount, useEffect, useRef, useState, whenReady } from "@odoo/owl";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";
import { makeEnv, startServices } from "@web/env";
import { getTemplate } from "@web/core/templates";
import { backdropThumb } from "./backgrounds";
import { NeonStrikeEngine } from "./game_engine";
import { MenuBackdrop } from "./menu_backdrop";
import { GLOSSARY } from "./glossary";
import { PERKS } from "./perks";
import { SHIPS, hullIndex } from "./ships";
import { sprite } from "./sprites";

/**
 * Remote co-op is **hidden, not removed**: the netcode is a snapshot broadcast
 * over the bus and it lags badly on a real connection. Everything (controllers,
 * models, bus channels, the host/guest engine roles) stays in place; this flag
 * only decides whether the UI offers it. Flip it back to `true` once the lag is
 * sorted out. See the "Multiplayer, temporarily hidden" note in CLAUDE.md.
 */
const MULTIPLAYER_ENABLED = false;

// Where the chosen hull is remembered between runs.
const HULL_KEY = "neon_strike_hull";

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

// Rows the leaderboard shows. `/neon/scores` already caps its query, but the
// panel sits in a fixed-height column: keep the ceiling on this side too so a
// wider payload can never push the game area out of the viewport.
const MAX_SCORES = 10;

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
            ship: this._savedHull(), // hull id, see ships.js
            joinCode: "",
            error: "",
            connecting: false,
            glossary: false, // ships and enemies panel over the menu
            // Practice mode, reached from the backend *Practice* menu
            // (`/neon?practice=1`): the glossary turns into a target picker and
            // the run spawns nothing but the one you click. Off on the public
            // page, which is why it is gated on the query string and not on a
            // button anybody can find.
            picker: false,
            practice: null,      // descriptor from the glossary item
            practiceLabel: "",
            paused: false,
            // Feedback panel (bug reports and ideas), layered like the glossary.
            feedback: false,
            fb: {
                kind: "bug",
                message: "",
                image: null,      // data URL, already downscaled
                sending: false,
                error: "",
                sent: false,
            },
            match: null, // {id, code, is_host, slot, channel, participants, max_players, state}
        });

        if (this._practiceRequested()) {
            this.state.picker = true;
            this.state.glossary = true;
        }

        this.engine = null;
        this.backdrop = null;
        // Glossary cards are rasterized once (see `glossaryGroups`).
        this._glossary = null;
        this._broadcastHandle = null;
        this._inputHandle = null;
        this._pendingInput = null;
        this._broadcasting = false;

        // Bus handlers (registered once, removed on unmount). With co-op hidden
        // nothing can ever reach a room, so there is nothing to listen to.
        this._handlers = {
            ns_lobby: (p) => this._onLobby(p),
            ns_start: (p) => this._onStart(p),
            ns_state: (p) => this._onState(p),
            ns_input: (p) => this._onInput(p),
            ns_end: (p) => this._onEnd(p),
        };
        if (MULTIPLAYER_ENABLED) {
            for (const [type, cb] of Object.entries(this._handlers)) {
                this.bus.subscribe(type, cb);
            }
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
    /* Hull picker                                                         */
    /* ------------------------------------------------------------------ */

    /** Hull chosen last time, or the first one. localStorage may be blocked. */
    _savedHull() {
        try {
            const id = window.localStorage.getItem(HULL_KEY);
            return SHIPS[hullIndex(id)].id;
        } catch (e) {
            return SHIPS[0].id;
        }
    }

    /** Did the backend open us in practice mode (`/neon?practice=1`)? */
    _practiceRequested() {
        try {
            return new URLSearchParams(window.location.search).get("practice") === "1";
        } catch (e) {
            return false;
        }
    }

    /**
     * Start a run against one glossary target. The descriptor travels straight
     * to the engine; nothing else about the run changes, so what you are
     * watching is the real AI and not a rehearsal of it.
     */
    startPractice(item) {
        this.state.practice = item.practice;
        this.state.practiceLabel = item.label;
        this.state.glossary = false;
        this.startSolo();
    }

    /** The picker cards, rasterized once (same reason as `glossaryGroups`). */
    get shipCards() {
        if (!this._shipCards) {
            this._shipCards = SHIPS.map((s) => ({
                ...s,
                src: sprite(s.sprite, s.tint, 6, false).toDataURL(),
            }));
        }
        return this._shipCards;
    }

    pickShip(id) {
        this.state.ship = id;
        try {
            window.localStorage.setItem(HULL_KEY, id);
        } catch (e) {
            /* private browsing: the choice just does not survive the session */
        }
    }

    /* ------------------------------------------------------------------ */
    /* Glossary                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * Glossary groups with every card already rasterized to a data URL.
     * Computed once and cached: `toDataURL()` is not cheap, painting the 27
     * places even less so, and the getter runs on every render of the panel.
     */
    get glossaryGroups() {
        if (!this._glossary) {
            this._glossary = GLOSSARY.map((group) => ({
                ...group,
                items: group.items.map((item) => ({
                    ...item,
                    // A place is a painted still, everything else a sprite.
                    src: item.bg
                        ? backdropThumb(item.bg).toDataURL()
                        : sprite(item.sprite, item.tint, item.px, false).toDataURL(),
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

    /* ------------------------------------------------------------------ */
    /* Feedback                                                            */
    /* ------------------------------------------------------------------ */

    openFeedback() {
        Object.assign(this.state.fb, { error: "", sent: false });
        this.state.feedback = true;
        // Solo: freeze the run while they type, nobody wants to die writing a
        // bug report. In co-op we leave it alone: one player's panel must not
        // pause the whole room.
        if (this.state.screen === "game" && this.state.role === "solo" && this.engine && !this.engine.paused) {
            this.engine.togglePause();
            this._fbPaused = true;
        }
    }

    closeFeedback() {
        this.state.feedback = false;
        if (this._fbPaused && this.engine && this.engine.paused) {
            this.engine.togglePause();
        }
        this._fbPaused = false;
    }

    onFeedbackBackdrop(ev) {
        if (ev.target === ev.currentTarget) {
            this.closeFeedback();
        }
    }

    setFeedbackKind(kind) {
        this.state.fb.kind = kind;
    }

    /**
     * Downscale a data URL so a 4K screenshot does not travel (and does not sit
     * in the filestore) at full size. JPEG at 0.82 is plenty for a bug report.
     */
    _shrinkImage(dataURL, maxSide = 1280) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                if (scale === 1 && dataURL.length < 900000) {
                    resolve(dataURL);
                    return;
                }
                const cv = document.createElement("canvas");
                cv.width = Math.round(img.width * scale);
                cv.height = Math.round(img.height * scale);
                cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
                resolve(cv.toDataURL("image/jpeg", 0.82));
            };
            img.onerror = () => resolve(null);
            img.src = dataURL;
        });
    }

    async onFeedbackFile(ev) {
        const file = ev.target.files && ev.target.files[0];
        ev.target.value = "";  // let the same file be picked again after a remove
        if (!file) {
            return;
        }
        if (!/^image\//.test(file.type)) {
            this.state.fb.error = "That file is not an image.";
            return;
        }
        if (file.size > 12 * 1024 * 1024) {
            this.state.fb.error = "That image is too big.";
            return;
        }
        const dataURL = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
        });
        const shrunk = dataURL && (await this._shrinkImage(dataURL));
        if (!shrunk) {
            this.state.fb.error = "That image could not be read.";
            return;
        }
        this.state.fb.image = shrunk;
        this.state.fb.error = "";
    }

    /** Grab what is on the game canvas right now: the point of a bug report. */
    async attachScreenshot() {
        const canvas = this.canvasRef.el;
        if (!canvas) {
            return;
        }
        try {
            this.state.fb.image = await this._shrinkImage(canvas.toDataURL("image/png"));
            this.state.fb.error = "";
        } catch (e) {
            this.state.fb.error = "The screenshot could not be taken.";
        }
    }

    clearFeedbackImage() {
        this.state.fb.image = null;
    }

    get canScreenshot() {
        return this.state.screen === "game" && !!this.canvasRef.el;
    }

    async sendFeedback() {
        const fb = this.state.fb;
        if (fb.sending) {
            return;
        }
        if (!fb.message.trim()) {
            fb.error = "Write something before sending.";
            return;
        }
        fb.sending = true;
        fb.error = "";
        // Context of the run: a report without it is hard to act on.
        const engine = this.engine;
        const ship = engine && engine.ships ? engine.ships.find((s) => s.slot === engine.localSlot) : null;
        try {
            const res = await rpc("/neon/feedback", {
                kind: fb.kind,
                message: fb.message.trim(),
                image: fb.image || false,
                nickname: this.state.nickname,
                wave: engine ? engine.wave : 0,
                score: engine ? engine.score : 0,
                mode: this.state.screen === "game" ? (this.state.match ? "coop" : "solo") : "menu",
                perks: ship ? ship.perks.join(", ") : "",
            });
            if (res && res.error) {
                fb.error = res.error;
            } else {
                fb.sent = true;
                fb.message = "";
                fb.image = null;
            }
        } catch (e) {
            fb.error = this._errMsg(e);
        } finally {
            fb.sending = false;
        }
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

    async onGameOver({ score, wave, seconds, deaths }) {
        this.state.last = { score, wave, seconds, deaths };
        if (this.state.role === "guest") {
            return;
        }
        // A practice run is a test bench, not a run: it never reaches the board.
        if (this.state.practice) {
            return;
        }
        if (!score) {
            return;
        }
        try {
            if (this.state.role === "host" && this.state.match) {
                await rpc("/neon/score", { match_id: this.state.match.id, score, wave, seconds, deaths });
            } else {
                await rpc("/neon/solo_score", { nickname: this.state.nickname, score, wave, seconds, deaths });
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
        // Only the local player's hull is known here. In co-op the others would
        // have to travel through the lobby; while multiplayer is hidden they
        // simply fall back to the default hull.
        const hulls = [];
        hulls[match ? match.slot : 0] = hullIndex(this.state.ship);
        this.engine = new NeonStrikeEngine(this.canvasRef.el, {
            role,
            players: slots ? slots.length : 1,
            slots,
            localSlot: match ? match.slot : 0,
            names: match ? this._namesBySlot(match.participants) : null,
            hulls,
            practice: this.state.practice,
            onGameOver: (res) => this.onGameOver(res),
            onLocalInput: (x, y) => this._queueInput(x, y),
            onAction: (action) => this._sendAction(action),
            onPause: (paused) => {
                this.state.paused = paused;
            },
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
        this.state.paused = false;
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
            // Dropped here and not on `restart`, so restarting keeps fighting
            // the same target while Play goes back to a normal run.
            this.state.practice = null;
            this.state.practiceLabel = "";
            // Straight back to the picker: the whole point of the mode is to
            // look at the same thing again with one click.
            this.state.glossary = this.state.picker;
            this.state.screen = "menu";
            this.loadScores();
        } else {
            await this.leaveMatch();
        }
    }

    _cleanup() {
        this._stopEngine();
        this._stopBackdrop();
        if (MULTIPLAYER_ENABLED) {
            for (const [type, cb] of Object.entries(this._handlers || {})) {
                this.bus.unsubscribe(type, cb);
            }
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

    /** Same path as the Esc key: on a guest it is a request to the host. */
    togglePause() {
        if (this.engine) {
            this.engine.togglePause();
        }
    }

    fmt(n) {
        return (n || 0).toLocaleString("en-US");
    }

    /** Leaderboard cell: the stored duration is in hours, shown as m:ss. */
    fmtTime(hours) {
        return NeonStrikeEngine.formatTime((hours || 0) * 3600);
    }

    /** The only rows the leaderboard template iterates: the best MAX_SCORES. */
    get topScores() {
        return this.state.scores.slice(0, MAX_SCORES);
    }

    /** False while co-op is hidden: every multiplayer control keys off this. */
    get multiplayer() {
        return MULTIPLAYER_ENABLED;
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
