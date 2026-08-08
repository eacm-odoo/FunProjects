# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
# UI palette follows Odoo brand assets: https://www.odoo.com/page/brand-assets
{
    "name": "Neon Strike",
    "version": "19.0.5.0.0",
    "category": "Productivity",
    "summary": "Co-op neon space shooter, playable without a login on a public page",
    "description": """
Neon Strike
===========
Arcade game (2D canvas + OWL 2) served from a public Odoo 19 page (``/neon``),
playable **without an account**: pick a nickname and go.

* Remote co-op for up to 4 players over the Odoo bus (room by code)
* No sign-up: identity is a session token + nickname (anonymous players)
* Individual lives per player, with the option to revive a downed ally
* 6 enemy types with distinct AI, a boss every 4 waves and asteroids
* Custom pixel art: one hull per player slot and enemy chassis variants
* In-menu glossary covering every ship, enemy, boss, capsule and perk
* 100% synthesised audio with the Web Audio API (no sound files)
* Pixel-art capsule power-ups: triple shot, shield, bomb and extra life
* 50 permanent perks: pick 1 of 3 every 5 waves and keep it for the whole run
* Free dash on the Space bar plus active perks bound to the 1-4 keys
* 5 colossal bosses that do not fit the arena: the camera pulls back to frame them
* Combo system up to x25, particles, screen shake and slow motion
* Single global leaderboard (solo and team) in ``neon.strike.score``

Built with Odoo. Brand guide: https://www.odoo.com/page/brand-assets
""",
    "author": "Odoo",
    "website": "https://www.odoo.com",
    "license": "LGPL-3",
    # `website` is required to publish /neon in the site navigation
    # (`website.menu` record), same as pingpong_3d does.
    "depends": ["web", "bus", "website"],
    "data": [
        "security/ir.model.access.csv",
        "views/neon_strike_page.xml",
        "views/neon_strike_views.xml",
        "views/website_menu.xml",
    ],
    "assets": {
        "web.assets_frontend": [
            "neon_strike/static/src/js/sprites.js",
            "neon_strike/static/src/js/perks.js",
            "neon_strike/static/src/js/colossi.js",
            "neon_strike/static/src/js/menu_backdrop.js",
            "neon_strike/static/src/js/glossary.js",
            "neon_strike/static/src/js/game_engine.js",
            "neon_strike/static/src/js/neon_strike_game.js",
            "neon_strike/static/src/xml/neon_strike_templates.xml",
            "neon_strike/static/src/scss/neon_strike.scss",
        ],
    },
    "application": True,
    "installable": True,
}
