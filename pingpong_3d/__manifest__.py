{
    "name": "Ping Pong 3D",
    "summary": "3D ping pong against the machine, with realistic physics and several difficulties",
    "description": """
Ping Pong 3D
============

3D table tennis game (three.js) integrated into Odoo:

* Match against the machine with four difficulties (easy, normal, hard, expert).
* Realistic physics: gravity, air drag, Magnus effect, bounce with
  transferencia de efecto, red y reglas de bote.
* Mouse control: the position places the paddle and the gesture speed
  define potencia y efecto (liftado, cortado, lateral).
* Every match result is stored and can be reviewed from the backend.
* Online 1 on 1 (bus + WebRTC) is in the code but hidden in the UI while the
  lag is being worked on: see MULTIPLAYER_ENABLED in pingpong_game.js.

Public page: /pingpong
""",
    "author": "Odoo Development Services",
    "website": "https://github.com/odoo/odoo",
    "category": "Extra Tools",
    "version": "19.0.3.1.0",
    "license": "LGPL-3",
    # mail comes in through website anyway, but the online mode reads
    # mail.ice.server for its STUN/TURN configuration, so it is declared.
    "depends": ["web", "bus", "mail", "website"],
    "data": [
        "security/ir.model.access.csv",
        "views/pingpong_templates.xml",
        "views/pingpong_match_views.xml",
        "views/pingpong_session_views.xml",
        "views/website_menu.xml",
    ],
    # web.assets_frontend only gets the loader stub, because it is downloaded on
    # every page of the website. The game itself -- three.js above all -- lives
    # in a dedicated bundle that the stub fetches at runtime, and only on the
    # game page.
    "assets": {
        "web.assets_frontend": [
            "pingpong_3d/static/src/boot/pingpong_boot.scss",
            "pingpong_3d/static/src/boot/pingpong_boot.js",
        ],
        "pingpong_3d.assets_game": [
            "pingpong_3d/static/lib/three/three.core.js",
            "pingpong_3d/static/lib/three/three.module.js",
            "pingpong_3d/static/src/scss/pingpong.scss",
            "pingpong_3d/static/src/js/**/*.js",
            "pingpong_3d/static/src/xml/**/*.xml",
        ],
    },
    "installable": True,
    "application": True,
    "auto_install": False,
}
