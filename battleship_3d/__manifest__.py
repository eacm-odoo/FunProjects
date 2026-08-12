{
    "name": "Battleship 3D",
    "summary": "Turn-based Battleship played on a 3D board, in the backend and on a public page",
    "description": """
Turn-based Battleship
=====================

Server-authoritative Battleship game (10x10, classic 5-ship fleet) with a
three.js board rendered as an OWL component.

* vs CPU (hunt/target AI, solved server side), 2 players hot-seat, or 2 players
  remote: one opens a room, the other joins with the code, and the two boards
  keep in step over the Odoo bus
* five WWII ship models riding a simulated swell: shells raise rings the whole
  fleet rolls on, and a glossary that shows each class on a 3D turntable
* manual or random fleet placement, ships can be re-picked and turned 90°
* full shot history per game
* win/loss record per player
* playable from the backend menu, and from the public page /battleship without
  an account (the game is bound to the browser session)
""",
    "version": "19.0.3.0.0",
    "category": "Tools/Games",
    "license": "LGPL-3",
    "author": "Odoo Development Services",
    "website": "https://www.odoo.com",
    # `website` is required to publish /battleship in the site navigation
    # (`website.menu` record), same as pingpong_3d and neon_strike do. `bus`
    # carries the room notifications of an online game (see
    # models/ir_websocket.py).
    "depends": ["base", "web", "bus", "website"],
    "data": [
        "security/ir.model.access.csv",
        "views/battleship_game_views.xml",
        "views/battleship_menus.xml",
        "views/battleship_page.xml",
        "views/website_menu.xml",
    ],
    # Neither the backend nor the frontend bundle carries the game: three.js is
    # a couple of megabytes and has no business being downloaded on every page.
    # Both sides ship a stub that fetches `battleship_3d.assets_game` when the
    # board is actually opened.
    "assets": {
        "web.assets_backend": [
            "battleship_3d/static/src/backend/**/*",
        ],
        "web.assets_frontend": [
            "battleship_3d/static/src/boot/battleship_boot.scss",
            "battleship_3d/static/src/boot/battleship_public.js",
        ],
        "battleship_3d.assets_game": [
            "battleship_3d/static/src/lib/three.core.js",
            "battleship_3d/static/src/lib/three.module.js",
            "battleship_3d/static/src/lib/OrbitControls.js",
            "battleship_3d/static/src/board/**/*",
        ],
    },
    "application": True,
    "installable": True,
}
