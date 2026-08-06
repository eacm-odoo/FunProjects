/** @odoo-module **/

import { whenReady } from "@odoo/owl";
import { loadBundle } from "@web/core/assets";

/* Pull in the game bundle, and only on the game page.
 *
 * This file is the module's whole footprint in web.assets_frontend: a few
 * hundred bytes on every frontend page, instead of the couple of megabytes that
 * three.js weighs.
 *
 * It cannot be a `t-call-assets` in the page head. Odoo emits the module loader
 * (web.assets_frontend_minimal) as a deferred script and everything else
 * (web.assets_frontend_lazy) as a lazily fetched one, so a plain bundle tag in
 * the head runs before `odoo.define` even exists. Loading at runtime sidesteps
 * the ordering question entirely: by the time this runs, the loader and every
 * @web module are in place.
 */
whenReady(async () => {
    if (!document.querySelector(".o_pingpong_root")) {
        return;
    }
    await loadBundle("pingpong_3d.assets_game");
});
