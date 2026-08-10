/** @odoo-module **/
import { Component, onWillStart, onMounted, onWillUnmount, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";
import { BattleshipScene, SIZE, coordOf } from "./scene";
import { sound } from "./sound";
import { api } from "./api";

/**
 * The board itself: a thin view over `battleship.game`.
 *
 * All rules live on the server; this component only draws state and sends
 * intents. It is used both by the backend client action and by the public
 * `/battleship` page, so it talks to the server through `api` and never
 * assumes the player is logged in.
 */
export class BattleshipBoard extends Component {
    static template = "battleship_3d.Board";
    static props = { "*": true };

    setup() {
        this.notification = useService("notification");
        this.canvasRef = useRef("canvas");
        this.ui = useState({
            game: null,
            selected: 0,
            dir: "h",
            soundOn: true,
            pass: null, // {title, text} while the hot-seat device is being passed
            busy: false,
        });

        onWillStart(async () => {
            const gameId = this.props.action?.params?.game_id;
            this.ui.game = gameId ? await api.state(gameId) : await api.newGame("cpu");
        });

        onMounted(() => {
            this.scene = new BattleshipScene(this.canvasRef.el, {
                onPick: (pick, kind) => this.onPick(pick, kind),
            });
            this.scene.render(this.ui.game);
        });

        onWillUnmount(() => this.scene?.destroy());
    }

    // ---------------------------------------------------------------- state
    get game() {
        return this.ui.game;
    }

    get mySide() {
        return this.game.state === "setup" ? this.game.setup_for : this.game.current_player;
    }

    get statusText() {
        const g = this.game;
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

    sideLabel(side) {
        if (this.game.mode === "cpu") {
            return side === "a" ? _t("You") : _t("CPU");
        }
        return side === "a" ? _t("Player 1") : _t("Player 2");
    }

    fleetOf(side) {
        return this.game["fleet_" + side];
    }

    async apply(promise, { animateFrom } = {}) {
        this.ui.busy = true;
        try {
            const before = this.game;
            const next = await promise;
            this.ui.game = next;
            this.playFeedback(before, next, animateFrom);
            this.scene.render(next);
            if (next.state === "done") {
                (next.mode === "cpu" && next.winner === "b") ? sound.lose() : sound.win();
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

    /** Sound + particles for every shot resolved by the last server call. */
    playFeedback(before, next) {
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
    onPick(pick, kind) {
        const g = this.game;
        if (this.ui.pass || this.ui.busy || !pick) {
            this.scene.clearGhost();
            return;
        }
        if (g.state === "setup" && pick.side === g.setup_for) {
            const ship = this.fleetOf(g.setup_for)[this.ui.selected];
            if (kind === "move") {
                this.scene.dir = this.ui.dir;
                this.scene.showGhost(pick.side, pick.cell, ship.size, true);
            } else {
                this.placeShip(pick.cell);
            }
            return;
        }
        if (kind === "click" && g.state === "battle" && pick.side !== g.current_player) {
            this.fire(pick.cell);
        }
    }

    placeShip(cell) {
        sound.place();
        this.apply(
            api.placeShip(this.game.id, this.game.setup_for, this.ui.selected, cell, this.ui.dir)
        ).then(() => {
            const next = this.fleetOf(this.game.setup_for).findIndex((s) => !s.cells.length);
            this.ui.selected = next === -1 ? this.ui.selected : next;
        });
    }

    fire(cell) {
        return this.apply(api.fire(this.game.id, cell));
    }

    // -------------------------------------------------------------- toolbar
    selectShip(index) {
        if (this.game.state === "setup") {
            this.ui.selected = index;
        }
    }

    rotate() {
        this.ui.dir = this.ui.dir === "h" ? "v" : "h";
        this.scene.dir = this.ui.dir;
    }

    randomFleet() {
        sound.place();
        return this.apply(api.randomFleet(this.game.id, this.game.setup_for));
    }

    ready() {
        this.scene.clearGhost();
        return this.apply(api.ready(this.game.id));
    }

    newGame(mode) {
        return this.apply(api.newGame(mode || this.game.mode));
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
}

// The backend action is a stub in web.assets_backend (see
// static/src/backend/battleship_action.js) that pulls this bundle on demand and
// then picks the board up here, so three.js never travels with the web client.
registry.category("lazy_components").add("battleship_3d.Board", BattleshipBoard);
