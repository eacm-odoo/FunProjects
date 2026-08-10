/** @odoo-module **/
import { Component, xml } from "@odoo/owl";
import { LazyComponent } from "@web/core/assets";
import { registry } from "@web/core/registry";

/**
 * Client action `battleship_3d.board`.
 *
 * This stub is the module's whole footprint in web.assets_backend. The board,
 * its renderer and three.js live in `battleship_3d.assets_game`, which weighs a
 * couple of megabytes and is fetched the first time somebody opens the game
 * instead of on every backend page.
 */
export class BattleshipAction extends Component {
    static template = xml`
        <LazyComponent bundle="'battleship_3d.assets_game'"
                       Component="'battleship_3d.Board'"
                       props="props"/>
    `;
    static components = { LazyComponent };
    static props = { "*": true };
}

registry.category("actions").add("battleship_3d.board", BattleshipAction);
