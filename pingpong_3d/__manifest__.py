{
    "name": "Ping Pong 3D",
    "summary": "Juego de ping pong 3D contra la máquina, con física realista y varias dificultades",
    "description": """
Ping Pong 3D
============

Juego de tenis de mesa en 3D (three.js) integrado en Odoo:

* Partido contra la máquina con cuatro dificultades (fácil, normal, difícil, experto).
* Física realista: gravedad, resistencia del aire, efecto Magnus, rebote con
  transferencia de efecto, red y reglas de bote.
* Control con el ratón: la posición coloca la pala y la velocidad del gesto
  define potencia y efecto (liftado, cortado, lateral).
* Los resultados de cada partido se guardan y se consultan desde el backend.

Página pública: /pingpong
""",
    "author": "Odoo Development Services",
    "website": "https://github.com/odoo/odoo",
    "category": "Extra Tools",
    "version": "19.0.3.0.0",
    "license": "LGPL-3",
    "depends": ["web", "bus", "website"],
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
