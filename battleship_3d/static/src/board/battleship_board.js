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
import { loadNavalFonts } from "./fonts";
import { sound } from "./sound";
import { api } from "./api";

const NICKNAME_KEY = "battleship_nickname";
// Gap between two shells of the same answer. The CPU resolves its whole turn
// inside the call that carries your shot, so without this the board would show
// four impacts in one frame — and the flight is 0.55s, so anything under that
// has them overlapping in the air.
const VOLLEY_STEP = 0.85;

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
        loadNavalFonts();
        this.notification = useService("notification");
        this.bus = useService("bus_service");
        this.canvasRef = useRef("canvas");
        this.glossaryRef = useRef("glossaryCanvas");
        this.inviteRef = useRef("invite");
        this.glossary = GLOSSARY;
        this.glossaryNote = GLOSSARY_NOTE;
        this.ui = useState({
            game: null,
            selected: 0,
            dir: "h",
            soundOn: true,
            pass: null, // {title, text} while the hot-seat device is being passed
            busy: false,
            menu: null, // "start" on the opening screen, "online" on the room panel
            backToStart: false, // the room panel was opened from the start screen
            nickname: browser.localStorage.getItem(NICKNAME_KEY) || "",
            joinCode: "",
            report: null, // {kind, subject, body} while the report card is open
            error: "",
            codex: null, // name of the class shown in the glossary, or null
            settling: false, // shells still in the air: hold the game-over card
        });

        // Shots on their way, and what is waiting for the last one to land.
        this.inFlight = 0;
        this.onSettled = null;

        this.channel = null;
        this.onUpdate = (payload) => this.onRoomUpdate(payload);
        this.bus.subscribe("bs_update", this.onUpdate);
        useExternalListener(window, "keydown", (ev) => this.onKeyDown(ev));

        onWillStart(async () => {
            if (this.props.roomCode) {
                await this.enterFromLink(this.props.roomCode);
                return;
            }
            const gameId = this.props.action?.params?.game_id;
            this.setGame(gameId ? await api.state(gameId) : await api.newGame("cpu"));
            // Nobody was sent here by a link or by the backend list: the board
            // opens on the start screen, over a game that is already waiting
            // behind it so picking a mode never costs a round trip.
            this.ui.menu = gameId ? null : "start";
        });

        onMounted(() => {
            this.scene = new BattleshipScene(this.canvasRef.el, {
                onPick: (pick, kind) => this.onPick(pick, kind),
                onImpact: (result) => this.onImpact(result),
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

    /**
     * The turn, spelled out over the board.
     *
     * Two players is where this matters: against the CPU every answer comes
     * back inside your own call, so the turn is never really away from you. The
     * rest of the time somebody is waiting on somebody, and a player who looks
     * up from their fleet should not have to work out which of the two it is.
     */
    get turnBanner() {
        const g = this.game;
        if (g.mode === "cpu") {
            return null;
        }
        if (this.online && g.state === "setup" && this.locked) {
            return {
                mine: false,
                title: _t("Waiting for %s", this.game.players[this.other]),
                text: _t("They are still placing their fleet."),
            };
        }
        if (g.state !== "battle") {
            return null;
        }
        if (!this.online) {
            return {
                mine: true,
                title: _t("%s, your turn", this.sideLabel(g.current_player)),
                text: _t("Fire at the opposing grid."),
            };
        }
        return this.myTurn
            ? { mine: true, title: _t("Your turn"), text: _t("Fire at the enemy grid.") }
            : {
                mine: false,
                title: _t("%s is aiming", this.game.players[this.other]),
                text: _t("Hold on."),
            };
    }

    /** True while a shot of ours would actually be taken. Drives the crosshair. */
    get aiming() {
        return this.game.state === "battle" && this.myTurn && !this.ui.settling && !this.ui.pass;
    }

    /** The tag next to a panel title while that side holds the turn. The dot in
     *  front of it is drawn by the stylesheet, not spelled here. */
    turnTag(side) {
        if (!this.online) {
            return _t("to fire");
        }
        return side === this.game.you ? _t("your turn") : _t("their turn");
    }

    /**
     * The panel of whoever the board is waiting on, so the turn is said twice.
     *
     * Lit when the side that has to act is ours and dimmed when it is not:
     * teal means "you" everywhere else on this screen, and a teal frame around
     * the opponent's fleet would say the opposite of what it means.
     */
    panelClass(side) {
        const g = this.game;
        if (g.mode === "cpu") {
            return "";
        }
        const acting = g.state === "battle"
            ? g.current_player === side
            : g.state === "setup" && side === this.placingSide && !this.locked;
        if (!acting) {
            return "";
        }
        return !this.online || side === g.you ? "o_bs_active" : "o_bs_waiting";
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

    /**
     * True when that fleet belongs to somebody at this screen.
     *
     * It is what tells the two plates at the bottom apart: ours lists ships by
     * name, the other one lists radar contacts. Hot-seat has no enemy in that
     * sense — both fleets are played from this chair, in turn — so both plates
     * read as ours.
     */
    isMine(side) {
        if (this.online) {
            return side === this.game.you;
        }
        return this.game.mode !== "cpu" || side === "a";
    }

    /** How much of a fleet is still up, for the header of its plate. */
    afloatLabel(side) {
        const fleet = this.fleetOf(side);
        const up = fleet.filter((ship) => !ship.sunk).length;
        return _t("%(up)s / %(total)s afloat", { up, total: fleet.length });
    }

    /** Shots taken so far in this game, both sides counted. */
    get salvoCount() {
        const g = this.game;
        return (g.shots_a || []).length + (g.shots_b || []).length;
    }

    get salvoLabel() {
        return _t("Salvo %s", this.salvoCount + 1);
    }

    /** What a line of the radio log says happened, in the log's own words. */
    logResult(entry) {
        if (entry.result === "sunk") {
            return _t("sunk");
        }
        return entry.result === "hit" ? _t("hit") : _t("water");
    }

    /**
     * The time stamped at the head of the radio log.
     *
     * Shots carry no timestamp of their own, so this is not a time per line:
     * it is when the sheet was last read, and it moves with every state that
     * lands here — which is exactly when a new line appears.
     */
    get clock() {
        const now = new Date();
        return String(now.getHours()).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0");
    }

    get soundLabel() {
        return this.ui.soundOn ? _t("Sound on") : _t("Sound off");
    }

    /** The line under the service record, on the start screen. */
    get dispatchLine() {
        const shots = this.salvoCount;
        if (!shots) {
            return _t("No dispatch on file. The sea is quiet.");
        }
        if (this.online && this.game.code) {
            return _t("Room %(code)s — %(shots)s salvos fired so far.", {
                code: this.game.code,
                shots,
            });
        }
        return _t("Game in progress — %s salvos fired so far.", shots);
    }

    /**
     * Shots and hits of whoever the final dispatch is written for.
     *
     * Online it is the player reading it, against the CPU it is always side A,
     * and hot-seat has nobody to write it for but the winner.
     */
    get endStats() {
        const g = this.game;
        const side = this.online ? g.you : g.mode === "cpu" ? "a" : g.winner;
        const enemy = side === "a" ? "b" : "a";
        return {
            shots: (g["shots_" + enemy] || []).length,
            hits: this.fleetOf(enemy).reduce((total, ship) => total + ship.hits, 0),
        };
    }

    get endReport() {
        const { shots, hits } = this.endStats;
        return _t("Fleet destroyed in %(shots)s salvos. %(hits)s of them found a hull.", {
            shots,
            hits,
        });
    }

    /** The rubber stamp across the bottom of the final dispatch. */
    get endStamp() {
        const g = this.game;
        if (g.end_reason === "forfeit") {
            return { lost: true, text: _t("Room closed") };
        }
        return this.lost(g)
            ? { lost: true, text: _t("Fleet lost") }
            : { lost: false, text: _t("Fleet sunk") };
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
        if (this.ui.game && this.ui.game.id !== state.id) {
            // A different game is a different board: nothing that was still in
            // the air belongs to it.
            this.scene?.clearTransients();
            this.inFlight = 0;
            this.onSettled = null;
            this.ui.settling = false;
        }
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
                // The salvo that ended it is still in the air: let it land
                // before the card comes down over the board.
                this.settle(() => (this.lost(next) ? sound.lose() : sound.win()));
            } else if (next.mode === "hotseat" && before.current_player !== next.current_player) {
                this.settle(() => {
                    this.ui.pass = {
                        title: this.sideLabel(next.current_player),
                        text: _t("Pass the device, then continue."),
                    };
                });
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

    /**
     * Fire everything the last payload resolved, in the order it happened.
     *
     * One call can carry several shots — the CPU answers inside the same call
     * as your own shot, and keeps firing while it hits — so they go out spaced
     * apart instead of all at once. The sound is not played here: it belongs to
     * the impact, and the impact is still seconds away.
     */
    playFeedback(before, next) {
        if (!this.scene) {
            return;
        }
        const known = new Set((before.log || []).map((entry) => entry.shooter + entry.coord));
        const fresh = (next.log || []).slice().reverse()
            .filter((entry) => !known.has(entry.shooter + entry.coord));
        fresh.forEach((entry, index) => {
            const side = entry.shooter === "a" ? "b" : "a";
            const cell = [...Array(SIZE * SIZE).keys()].find((c) => coordOf(c) === entry.coord);
            this.scene.splash(side, cell, entry.result, index * VOLLEY_STEP);
        });
        this.inFlight += fresh.length;
        this.ui.settling = this.inFlight > 0;
    }

    /** A shell landed. */
    onImpact(result) {
        if (result === "sunk") {
            sound.sunk();
        } else if (result === "hit") {
            sound.hit();
        } else {
            sound.miss();
        }
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (!this.inFlight) {
            this.ui.settling = false;
            const settled = this.onSettled;
            this.onSettled = null;
            settled?.();
        }
    }

    /** Run `fn` once nothing is in the air any more — now, if nothing is. */
    settle(fn) {
        if (this.inFlight) {
            this.onSettled = fn;
        } else {
            fn();
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
        if (this.ui.report) {
            if (ev.key === "Escape") {
                this.closeReport();
            }
            return;
        }
        if (this.ui.codex) {
            if (ev.key === "Escape") {
                this.closeCodex();
            }
            return;
        }
        // The start screen and the room panel are screens, not the board: the
        // placement shortcuts below belong to the grid behind them.
        if (this.ui.menu) {
            if (ev.key !== "Escape") {
                return;
            }
            if (this.ui.menu === "online") {
                this.closeMenu();
            } else if (this.game.state !== "setup") {
                this.closeStart();
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
        // `settling` covers the CPU's turn: its shells are already on their way
        // even though the payload says the turn is yours again.
        if (
            this.ui.pass || this.ui.menu || this.ui.codex || this.ui.report ||
            this.ui.busy || this.ui.settling || !pick
        ) {
            this.scene.clearGhost();
            this.scene.setHover(null, null);
            return;
        }
        if (g.state === "setup") {
            // Includes the grid of a player who already locked their fleet in.
            if (!this.canPlace(pick.side)) {
                this.scene.clearGhost();
                this.scene.setHover(null, null);
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
        if (g.state !== "battle") {
            this.scene.setHover(null, null);
            return;
        }
        // Only ever light up a cell that can actually be fired at: the
        // highlight is the crosshair, not a hover effect.
        const enemy = this.online ? pick.side !== g.you : pick.side !== g.current_player;
        const target = enemy && this.myTurn;
        this.scene.setHover(target ? pick.side : null, target ? pick.cell : null);
        if (target && kind === "click") {
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

    // --------------------------------------------------------- start screen
    /**
     * Leave the start screen for a game of `mode`.
     *
     * The board behind the screen is a real game, and a fresh one is exactly
     * what the player is asking for: if it already is that game, and nothing
     * has been fired from it yet, the button is only a door. Otherwise it opens
     * a new record, the same way the mode switch in the top bar does.
     */
    async startGame(mode) {
        if (this.game.mode !== mode || this.game.state !== "setup") {
            await this.newGame(mode);
        }
        this.closeStart();
    }

    /** The room panel, opened from the start screen and returning to it. */
    openOnline() {
        this.ui.backToStart = true;
        return this.newGame("online");
    }

    openStart() {
        this.ui.error = "";
        this.ui.menu = "start";
    }

    closeStart() {
        this.ui.menu = null;
        this.ui.backToStart = false;
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
            this.ui.backToStart = false;
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

    /**
     * Sit down in the room an invitation link points at.
     *
     * Opening the link is the whole handshake, so nothing is asked before the
     * seat is taken: the name is whatever this browser played under last, and
     * an empty one is a player the server names for us. A link that leads
     * nowhere — room full, finished, mistyped — leaves the visitor in front of
     * the room panel with the code already filled in, which is the one screen
     * where they can do something about it.
     */
    async enterFromLink(code) {
        try {
            this.setGame(await api.joinRoom(code, this.ui.nickname));
        } catch (error) {
            this.setGame(await api.newGame("cpu"));
            this.ui.joinCode = code;
            this.ui.menu = "online";
            this.ui.error = error.data?.message || error.message;
        }
    }

    /** Back where the room panel was opened from — the start screen, or the board. */
    closeMenu() {
        this.ui.menu = this.ui.backToStart ? "start" : null;
        this.ui.backToStart = false;
        this.ui.error = "";
    }

    get backLabel() {
        return this.ui.backToStart ? _t("Back to the menu") : _t("Back to the board");
    }

    /** Mobile browsers can hand the link straight to WhatsApp and friends. */
    get canShare() {
        return Boolean(browser.navigator.share);
    }

    get shareLabel() {
        return this.canShare ? _t("Share the link") : _t("Copy the link");
    }

    /**
     * Put the invitation where the opponent can be reached.
     *
     * The share sheet is the short way on a phone, and it is also the only one
     * that can reach an app directly; everywhere else this falls back to the
     * clipboard, and the link stays selectable on screen for the browsers that
     * allow neither (the clipboard API is gone over plain http).
     */
    async shareInvite() {
        const url = this.game.invite_url;
        if (this.canShare) {
            try {
                await browser.navigator.share({
                    title: _t("Battleship"),
                    text: _t("Come and play a game of Battleship against me."),
                    url,
                });
                return;
            } catch {
                // Sheet dismissed, or the browser refused it: copy instead.
            }
        }
        await this.copy(url, _t("Link copied — paste it to your opponent."));
    }

    copyCode() {
        return this.copy(this.game.code, _t("Code copied."));
    }

    async copy(text, message) {
        if (browser.navigator.clipboard?.writeText) {
            await browser.navigator.clipboard.writeText(text);
            this.notification.add(message, { type: "success" });
            return;
        }
        // No clipboard API — it is gone over plain http. The link is on screen
        // in a field, so selecting it puts copying one shortcut away; the code
        // is on screen too, but in a heading, and there it can only be read.
        if (this.inviteRef.el?.value === text) {
            this.inviteRef.el.select();
            this.notification.add(_t("Press Ctrl+C to copy the link."), { type: "info" });
        }
    }

    rematch() {
        return this.enterRoom(api.rematch(this.game.id));
    }

    // -------------------------------------------------------------- feedback
    /**
     * Time at the board, as a line rather than a number of seconds.
     *
     * It counts finished games only, exactly like the win/loss tally next to
     * it: a game still on the table has not been played yet, it is being
     * played, and a clock that ran while nobody was there would say otherwise.
     */
    get timePlayed() {
        const total = this.game.record.seconds || 0;
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        if (hours) {
            return _t("%sh %smin", hours, minutes);
        }
        return minutes ? _t("%smin", minutes) : _t("%ss", total);
    }

    openReport(kind) {
        this.ui.error = "";
        this.ui.report = { kind: kind || "bug", subject: "", body: "" };
    }

    setReportKind(kind) {
        this.ui.report.kind = kind;
    }

    closeReport() {
        this.ui.report = null;
        this.ui.error = "";
    }

    /** Send the report, and take the player straight back to the board. */
    async sendReport() {
        const report = this.ui.report;
        if (!report.body.trim()) {
            this.ui.error = _t("Say what happened, or what you would like to see.");
            return;
        }
        this.ui.busy = true;
        try {
            await api.feedback(report.kind, report.subject, report.body, this.game.id);
            this.ui.report = null;
            this.notification.add(_t("Thanks — it is in the backend."), { type: "success" });
        } catch (error) {
            this.ui.error = error.data?.message || error.message;
        } finally {
            this.ui.busy = false;
        }
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
