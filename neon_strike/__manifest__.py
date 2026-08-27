# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
# UI palette follows Odoo brand assets: https://www.odoo.com/page/brand-assets
{
    "name": "Neon Strike",
    "version": "19.0.14.0.0",
    "category": "Productivity",
    "summary": "Neon arcade space shooter, playable without a login on a public page",
    "description": """
Neon Strike
===========
Arcade game (2D canvas + OWL 2) served from a public Odoo 19 page (``/neon``),
playable **without an account**: pick a nickname and go.

* The arena is shaped like the window: a wide screen becomes playable room
  instead of black bars, with the classic 680x540 box as the floor
* No sign-up: identity is a session token + nickname (anonymous players)
* Pick your hull before the run: 4 pixel-art ships, cosmetic only
* Arcade flight animation: the hull banks through 5 tilt frames, the engine
  flame grows with the throttle, retro-thrusters fire when you brake and a hard
  change of direction (or a dash) throws in a barrel roll
* 26 places to fight in, one per wave: deep space, a black hole with real
  gravity on its dust, nebulae, a supernova, ringed giants, planet surfaces
  (lava, ice, ocean, jungle, desert, storms), a wormhole and more
* 6 enemy types with distinct AI, asteroids, and a rotating family of 5 bosses
  every 4 waves (dreadnought, warden, lancer, hive, prism)
* Remote co-op for up to 4 players over the Odoo bus (room by code), currently
  hidden in the UI while the netcode lag is worked on
* Individual lives per player, with the option to revive a downed ally
* Custom pixel art: one hull per player slot and enemy chassis variants
* In-menu glossary covering every ship, enemy, boss, capsule and perk
* 100% synthesised audio with the Web Audio API (no sound files)
* 14 pixel-art capsules: triple shot, shield, bomb, life, rapid fire, overcharge,
  piercing, homing, wingman, phase, freeze, overload, combo surge and payday
* 50 permanent perks: pick 1 of 3 every 5 waves and keep it for the whole run
* Free dash on the Space bar plus active perks bound to the 1-4 keys
* 5 colossal bosses that do not fit the arena: the camera pulls back to frame
  them, and AEGIS-01 now flies with weight -- it eases out of every reversal,
  leans toward whoever is still alive, plants itself before each curtain, opens
  a shutter over the hole it is about to leave and comes apart as it dies
* Bullet-hell fundamentals: the hitbox is a 6.5 px dot drawn on the hull (the
  ship sprite is five times wider), Shift focuses for precision movement and
  shows it, and skimming past enemy fire without being hit builds the combo
* Enemy fire is colour coded by what it does -- spread, aimed, lance, curtain --
  and every boss pattern telegraphs itself before it goes off, gap included
* Bombs are a stock you spend with X, not a capsule that detonates on pickup;
  bombed kills pay half and build no combo
* Bosses and colossi switch to a second, faster phase on a health threshold,
  announced with a beat where they hold fire
* Combo system up to x25, hitstop on impact, particles, screen shake and slow
  motion, plus a no-damage bonus for clearing a wave untouched
* Practice bench in the backend: pick any enemy, boss or colossus from the
  glossary and fight only that one, wave after wave, without touching the
  leaderboard
* In-game feedback panel: players report bugs or ideas with a screenshot, and
  it all lands in a backend menu with the wave and build they were on
* Single global leaderboard (solo and team) in ``neon.strike.score``
* Run timer stored with every score, and a Time Played pivot adding up how
  much time everyone has spent playing

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
        "views/neon_strike_feedback_views.xml",
        "views/website_menu.xml",
    ],
    "assets": {
        "web.assets_frontend": [
            "neon_strike/static/src/js/sprites.js",
            "neon_strike/static/src/js/ships.js",
            "neon_strike/static/src/js/ship_flight.js",
            "neon_strike/static/src/js/perks.js",
            "neon_strike/static/src/js/bosses.js",
            "neon_strike/static/src/js/boss_animator.js",
            "neon_strike/static/src/js/colossi.js",
            "neon_strike/static/src/js/aegis_motion.js",
            "neon_strike/static/src/js/colossus_animator.js",
            "neon_strike/static/src/js/backgrounds.js",
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
