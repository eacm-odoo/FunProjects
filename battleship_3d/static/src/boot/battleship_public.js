/** @odoo-module **/
import { Component, xml } from "@odoo/owl";
import { LazyComponent } from "@web/core/assets";
import { registry } from "@web/core/registry";

/**
 * What `<owl-component name="battleship_3d.board"/>` mounts on /battleship.
 *
 * Going through the public component registry, rather than starting a second
 * OWL app on the page, is what keeps the board inside the env the frontend
 * already built: its services are started once, by the public root, and
 * starting another set of them registers globals like the notification
 * container twice.
 *
 * Like its backend twin (static/src/backend/battleship_action.js) this stub is
 * all that travels in web.assets_frontend: three.js only comes down when
 * somebody actually opens the page.
 *
 * Whatever the page put in the `props` attribute is handed over untouched —
 * `roomCode` when the visitor followed an invitation link.
 */
export class BattleshipPublic extends Component {
    static template = xml`
        <LazyComponent bundle="'battleship_3d.assets_game'" Component="'battleship_3d.Board'"
                       props="props"/>
    `;
    static components = { LazyComponent };
    static props = { "*": true };
}

registry.category("public_components").add("battleship_3d.board", BattleshipPublic);
