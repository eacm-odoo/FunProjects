/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details. */

import { Component, onMounted, onWillUnmount, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { NeonStrikeEngine } from "./game_engine";

export class NeonStrikeGame extends Component {
    static template = "neon_strike.Game";
    static props = { "*": true };

    setup() {
        this.orm = useService("orm");
        this.canvasRef = useRef("canvas");
        this.state = useState({
            muted: false,
            scores: [],
            last: null,
        });

        onMounted(() => {
            this.engine = new NeonStrikeEngine(this.canvasRef.el, {
                onGameOver: (res) => this.onGameOver(res),
            });
            this.engine.start();
            this.loadScores();
        });

        onWillUnmount(() => {
            if (this.engine) {
                this.engine.destroy();
            }
        });
    }

    async loadScores() {
        try {
            this.state.scores = await this.orm.searchRead(
                "neon.strike.score",
                [],
                ["player_name", "score", "wave", "create_date"],
                { limit: 10, order: "score desc, id asc" }
            );
        } catch (e) {
            console.warn("Neon Strike: no se pudieron cargar los marcadores", e);
        }
    }

    async onGameOver({ score, wave }) {
        this.state.last = { score, wave };
        if (!score) {
            return;
        }
        try {
            await this.orm.create("neon.strike.score", [{ score, wave }]);
            await this.loadScores();
        } catch (e) {
            console.warn("Neon Strike: no se pudo guardar la puntuación", e);
        }
    }

    toggleMute() {
        this.state.muted = !this.state.muted;
        this.engine.setMuted(this.state.muted);
    }

    restart() {
        this.engine.restartToMenu();
    }

    fmt(n) {
        return (n || 0).toLocaleString("es-MX");
    }
}

registry.category("actions").add("neon_strike.game_action", NeonStrikeGame);
