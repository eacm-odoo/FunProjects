/** @odoo-module **/
import {
    Component, onWillStart, onMounted, onWillUnmount, useEffect, useExternalListener, useRef,
    useState,
} from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { browser } from "@web/core/browser/browser";
import { _t } from "@web/core/l10n/translation";
import { BattleshipScene, SIZE, coordOf } from "./scene";
import { ShipViewer } from "./ship_viewer";
import { GLOSSARY, GLOSSARY_NOTE } from "./glossary";
import { sound } from "./sound";
import { api } from "./api";

const NICKNAME_KEY = "battleship_nickname";

/**
 * The board itself: a thin view over `battleship.game`.
 *
 * All rules live on the server; this component only draws state and sends
 * intents. It is used both by the backend client action and by the public
 * `/battleship` page, so it talks to the server through `api` and never
 * assumes the player is logged in.
 *
 * Online games add a second browser to the picture. It changes less than it
 * sounds: the server still owns every rule and still answers with a payload cut
 * for whoever asked, so the only new job here is knowing when to ask again. The
 * room's bus channel says "something moved" and this component reads the state
 * back — the notification itself carries no game data, because the channel is
 * shared with the opponent.
 */
export class BattleshipBoard extends Component {
    static template = "battleship_3d.Board";
    static props = { "*": true };

    setup() {
        this.notification = useService("notification");
        this.bus = useService("bus_service");
        this.canvasRef = useRef("canvas");
        this.glossaryRef = useRef("glossaryCanvas");
        this.glossary = GLOSSARY;
        this.glossaryNote = GLOSSARY_NOTE;
        this.ui = useState({
            game: null,
            selected: 0,
            dir: "h",
            soundOn: true,
            pass: null, // {title, text} while the hot-seat device is being passed
            busy: false,
            menu: null, // "online" while the room panel is open
            nickname: browser.localStorage.getItem(NICKNAME_KEY) || "",
            joinCode: "",
            error: "",
            codex: null, // name of the class shown in the glossary, or null
        });

        this.channel = null;
        this.onUpdate = (payload) => this.onRoomUpdate(payload);
        this.bus.subscribe("bs_update", this.onUpdate);
        useExternalListener(window, "keydown", (ev) => this.onKeyDown(ev));

        onWillStart(async () => {
            const gameId = this.props.action?.params?.game_id;
            this.setGame(gameId ? await api.state(gameId) : await api.newGame("cpu"));
        });

        onMounted(() => {
            this.scene = new BattleshipScene(this.canvasRef.el, {
                onPick: (pick, kind) => this.onPick(pick, kind),
            });
            this.scene.render(this.ui.game);
        });

        // The turntable only exists while the glossary is open: it is a second
        // WebGL context, and the board already holds one.
        useEffect(
            (el) => {
                if (!el) {
                    return;
                }
                this.viewer = new ShipViewer(el);
                this.viewer.show(this.codexEntry);
                return () => {
                    this.viewer.destroy();
                    this.viewer = null;
                };
            },
            () => [this.glossaryRef.el]
        );

        onWillUnmount(() => {
            this.bus.unsubscribe("bs_update", this.onUpdate);
            this.listenTo(null);
            this.scene?.destroy();
        });
    }

    // ---------------------------------------------------------------- state
    get game() {
        return this.ui.game;
    }

    get online() {
        return this.game.mode === "online";
    }

    /** Whose fleet is being placed right now, on this screen. */
    get placingSide() {
        return this.online ? this.game.you : this.game.setup_for;
    }

    get myTurn() {
        return !this.online || this.game.current_player === this.game.you;
    }

    /** Online, a locked fleet cannot be touched again while the other one is placed. */
    get locked() {
        return this.online && this.game.ready[this.game.you];
    }

    get statusText() {
        const g = this.game;
        if (this.online) {
            if (g.state === "lobby") {
                return _t("Waiting for an opponent to join with the code.");
            }
            if (g.state === "setup") {
                return this.locked
                    ? _t("Fleet locked in — waiting for %s.", this.sideLabel(this.other))
                    : _t("Place your fleet.");
            }
            if (g.state === "done") {
                if (g.end_reason === "forfeit") {
                    return g.winner === g.you ? _t("Your opponent left.") : _t("You left.");
                }
                return g.winner === g.you ? _t("Victory.") : _t("Defeat.");
            }
            return this.myTurn
                ? _t("Your turn — fire at the enemy grid.")
                : _t("%s is aiming.", this.sideLabel(this.other));
        }
        if (g.state === "setup") {
            return _t("%s: place your fleet.", this.sideLabel(g.setup_for));
        }
        if (g.state === "done") {
            return g.mode === "cpu"
                ? (g.winner === "a" ? _t("Victory.") : _t("Defeat."))
                : _t("%s wins.", this.sideLabel(g.winner));
        }
        return _t("%s — fire at the opposing grid.", this.sideLabel(g.current_player));
    }

    get other() {
        return this.game.you === "a" ? "b" : "a";
    }

    sideLabel(side) {
        if (this.game.mode === "cpu") {
            return side === "a" ? _t("You") : _t("CPU");
        }
        if (this.online) {
            return side === this.game.you ? _t("You") : this.game.players[side];
        }
        return side === "a" ? _t("Player 1") : _t("Player 2");
    }

    fleetOf(side) {
        return this.game["fleet_" + side];
    }

    /** Header of the panel sitting under each grid. */
    panelTitle(side) {
        if (this.game.mode === "cpu") {
            return side === "a" ? _t("Your fleet") : _t("CPU fleet");
        }
        if (this.online) {
            return side === this.game.you
                ? _t("Your waters")
                : _t("%s waters", this.game.players[side]);
        }
        return side === "a" ? _t("Player 1 waters") : _t("Player 2 waters");
    }

    /** Locking a fleet only starts the battle when it is the last one left. */
    get readyLabel() {
        const g = this.game;
        const waits = this.online || (g.mode === "hotseat" && g.setup_for === "a");
        return waits ? _t("Lock in fleet") : _t("Start battle");
    }

    /** True while that grid is the one the player is allowed to touch. */
    canPlace(side) {
        return this.game.state === "setup" && side === this.placingSide && !this.locked;
    }

    // ------------------------------------------------------------- the room
    /**
     * Install a new state, and follow it onto the bus channel it belongs to.
     *
     * A rematch is a different room with a different channel, so subscribing
     * cannot be a one-off: every state that lands here says which channel it
     * came from, and this is the only place that has to agree with it.
     */
    setGame(state) {
        this.ui.game = state;
        this.listenTo(state.mode === "online" ? state.channel : null);
        return state;
    }

    listenTo(channel) {
        if (this.channel === channel) {
            return;
        }
        if (this.channel) {
            this.bus.deleteChannel(this.channel);
        }
        this.channel = channel;
        if (channel) {
            this.bus.addChannel(channel);
        }
    }

    /**
     * The opponent moved.
     *
     * The payload only says which room and why, so the answer is always to read
     * the state back through our own seat. `next_id` is the exception: it is
     * the rematch the other player just opened, and the room to follow them to.
     */
    async onRoomUpdate(payload) {
        const g = this.game;
        if (!g || !this.online || payload.id !== g.id) {
            return;
        }
        await this.apply(api.state(payload.next_id || g.id));
    }

    // ---------------------------------------------------------------- moves
    async apply(promise) {
        this.ui.busy = true;
        try {
            const before = this.game;
            const next = this.setGame(await promise);
            this.playFeedback(before, next);
            // A bus notification can land before the canvas is mounted.
            this.scene?.render(next);
            if (next.state === "done" && before.state !== "done") {
                this.lost(next) ? sound.lose() : sound.win();
            } else if (next.mode === "hotseat" && before.current_player !== next.current_player) {
                this.ui.pass = {
                    title: this.sideLabel(next.current_player),
                    text: _t("Pass the device, then continue."),
                };
            }
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "warning" });
        } finally {
            this.ui.busy = false;
        }
    }

    lost(state) {
        if (state.mode === "cpu") {
            return state.winner === "b";
        }
        return state.mode === "online" && state.winner !== state.you;
    }

    /** Sound + particles for every shot resolved since the last payload. */
    playFeedback(before, next) {
        if (!this.scene) {
            return;
        }
        const known = new Set((before.log || []).map((entry) => entry.shooter + entry.coord));
        for (const entry of (next.log || []).slice().reverse()) {
            if (known.has(entry.shooter + entry.coord)) {
                continue;
            }
            const side = entry.shooter === "a" ? "b" : "a";
            const cell = [...Array(SIZE * SIZE).keys()].find((c) => coordOf(c) === entry.coord);
            this.scene.splash(side, cell, entry.result !== "miss");
            if (entry.result === "sunk") {
                sound.sunk();
            } else if (entry.result === "hit") {
                sound.hit();
            } else {
                sound.miss();
            }
        }
    }

    // ---------------------------------------------------------------- input
    /**
     * Keyboard shortcuts while placing a fleet.
     *
     * R turns the selected ship, and 1-5 pick one straight from the keyboard —
     * including a ship that is already on the grid, which is how you move one
     * without clearing the rest of the fleet.
     */
    onKeyDown(ev) {
        const target = ev.target;
        const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
        if (typing || ev.ctrlKey || ev.metaKey || ev.altKey || !this.game) {
            return;
        }
        if (this.ui.codex) {
            if (ev.key === "Escape") {
                this.closeCodex();
            }
            return;
        }
        if (ev.key === "r" || ev.key === "R") {
            this.rotate();
            return;
        }
        const index = "12345".indexOf(ev.key);
        if (index !== -1) {
            this.selectShip(this.placingSide, index);
        }
    }

    onPick(pick, kind) {
        const g = this.game;
        if (this.ui.pass || this.ui.menu || this.ui.busy || !pick) {
            this.scene.clearGhost();
            return;
        }
        if (g.state === "setup") {
            // Includes the grid of a player who already locked their fleet in.
            if (!this.canPlace(pick.side)) {
                this.scene.clearGhost();
                return;
            }
            const ship = this.fleetOf(this.placingSide)[this.ui.selected];
            if (kind === "move") {
                this.scene.dir = this.ui.dir;
                this.scene.showGhost(pick.side, pick.cell, ship, true);
            } else {
                this.placeShip(pick.cell);
            }
            return;
        }
        if (kind !== "click" || g.state !== "battle") {
            return;
        }
        const enemy = this.online ? pick.side !== g.you : pick.side !== g.current_player;
        if (enemy && this.myTurn) {
            this.fire(pick.cell);
        }
    }

    placeShip(cell) {
        sound.place();
        const side = this.placingSide;
        this.apply(
            api.placeShip(this.game.id, side, this.ui.selected, cell, this.ui.dir)
        ).then(() => {
            const next = this.fleetOf(this.placingSide).findIndex((s) => !s.cells.length);
            this.ui.selected = next === -1 ? this.ui.selected : next;
        });
    }

    fire(cell) {
        return this.apply(api.fire(this.game.id, cell));
    }

    // -------------------------------------------------------------- toolbar
    /**
     * Pick the ship to place — including one already on the grid, which is how
     * a fleet gets rearranged: dropping it somewhere else moves it, it is not
     * a second copy.
     */
    selectShip(side, index) {
        if (!this.canPlace(side)) {
            return;
        }
        this.ui.selected = index;
        const ghost = this.scene?.ghost;
        if (ghost) {
            this.scene.showGhost(ghost.side, ghost.cell, this.fleetOf(side)[index], true);
        }
    }

    /** `sel` is the ship being placed, `done` one already on the grid. */
    shipClass(side, ship, index) {
        const placing = this.canPlace(side);
        return [
            ship.sunk ? "sunk" : "",
            placing && index === this.ui.selected ? "sel" : "",
            placing && !ship.sunk && ship.cells.length ? "done" : "",
        ].join(" ");
    }

    /** Turn the ship being placed 90°, and swing the preview with it. */
    rotate() {
        if (!this.canPlace(this.placingSide)) {
            return;
        }
        this.ui.dir = this.ui.dir === "h" ? "v" : "h";
        this.scene.dir = this.ui.dir;
        this.scene.redrawGhost();
    }

    randomFleet() {
        sound.place();
        return this.apply(api.randomFleet(this.game.id, this.placingSide));
    }

    ready() {
        this.scene.clearGhost();
        return this.apply(api.ready(this.game.id));
    }

    /**
     * Start over locally, or open the room panel.
     *
     * Walking away from an online room has to be said out loud: the opponent is
     * sitting in front of a board that would otherwise never move again.
     */
    async newGame(mode) {
        if (mode === "online") {
            this.ui.error = "";
            this.ui.menu = "online";
            return;
        }
        const room = this.online ? this.game.id : null;
        await this.apply(api.newGame(mode || (room ? "cpu" : this.game.mode)));
        if (room) {
            await api.leaveRoom(room).catch(() => {});
        }
    }

    toggleSound() {
        this.ui.soundOn = !this.ui.soundOn;
        sound.enabled = this.ui.soundOn;
        if (sound.enabled) {
            sound.place();
        }
    }

    continuePass() {
        this.ui.pass = null;
        this.scene.render(this.game);
    }

    // -------------------------------------------------------------- codex
    get codexEntry() {
        return this.glossary.find((s) => s.name === this.ui.codex) || this.glossary[0];
    }

    openCodex() {
        this.ui.codex = this.codexEntry.name;
    }

    closeCodex() {
        this.ui.codex = null;
    }

    /**
     * Swap the model on the turntable.
     *
     * The viewer outlives the selection — it is torn down only when the panel
     * closes — so this hands it the new hull rather than rebuilding the scene.
     */
    showShip(name) {
        this.ui.codex = name;
        this.viewer?.show(this.codexEntry);
    }

    // ----------------------------------------------------------- room panel
    async enterRoom(promise) {
        this.ui.error = "";
        this.ui.busy = true;
        try {
            browser.localStorage.setItem(NICKNAME_KEY, this.ui.nickname.trim());
            const state = this.setGame(await promise);
            this.ui.selected = 0;
            this.ui.menu = null;
            this.scene?.render(state);
        } catch (error) {
            this.ui.error = error.data?.message || error.message;
        } finally {
            this.ui.busy = false;
        }
    }

    createRoom() {
        return this.enterRoom(api.createRoom(this.ui.nickname));
    }

    joinRoom() {
        return this.enterRoom(api.joinRoom(this.ui.joinCode, this.ui.nickname));
    }

    closeMenu() {
        this.ui.menu = null;
        this.ui.error = "";
    }

    async copyCode() {
        // No clipboard over plain http: the code is on screen either way.
        if (!browser.navigator.clipboard?.writeText) {
            return;
        }
        await browser.navigator.clipboard.writeText(this.game.code);
        this.notification.add(_t("Code copied."), { type: "success" });
    }

    rematch() {
        return this.enterRoom(api.rematch(this.game.id));
    }

    /** Give up the room and fall back to a game against the CPU. */
    leaveRoom() {
        return this.newGame("cpu");
    }
}

// The backend action is a stub in web.assets_backend (see
// static/src/backend/battleship_action.js) that pulls this bundle on demand and
// then picks the board up here, so three.js never travels with the web client.
registry.category("lazy_components").add("battleship_3d.Board", BattleshipBoard);
