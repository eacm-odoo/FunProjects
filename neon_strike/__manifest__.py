# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
# UI palette follows Odoo brand assets: https://www.odoo.com/page/brand-assets
{
    "name": "Neon Strike",
    "version": "19.0.1.0.0",
    "category": "Productivity",
    "summary": "Shooter espacial neón dentro de Odoo, con marcadores guardados vía ORM",
    "description": """
Neon Strike
===========
Juego arcade (canvas 2D + OWL 2) integrado como acción cliente en el backend de Odoo 19.

* 4 tipos de enemigos con IA distinta y un jefe cada 4 oleadas
* Audio 100% sintetizado con Web Audio API (sin archivos de sonido)
* Power-ups: triple disparo, escudo, bomba y vida extra
* Sistema de combos hasta x15, partículas, screen shake y slow-motion
* Marcadores persistidos en el modelo ``neon.strike.score`` (leaderboard multi-usuario)

Creado con Odoo. Guía de marca: https://www.odoo.com/page/brand-assets
""",
    "author": "Odoo",
    "website": "https://www.odoo.com",
    "license": "LGPL-3",
    "depends": ["web"],
    "data": [
        "security/ir.model.access.csv",
        "views/neon_strike_views.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "neon_strike/static/src/js/game_engine.js",
            "neon_strike/static/src/js/neon_strike_game.js",
            "neon_strike/static/src/xml/neon_strike_templates.xml",
            "neon_strike/static/src/scss/neon_strike.scss",
        ],
    },
    "application": True,
    "installable": True,
}
