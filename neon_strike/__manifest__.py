# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
# UI palette follows Odoo brand assets: https://www.odoo.com/page/brand-assets
{
    "name": "Neon Strike",
    "version": "19.0.3.0.0",
    "category": "Productivity",
    "summary": "Shooter espacial neón cooperativo, jugable sin login en una página pública",
    "description": """
Neon Strike
===========
Juego arcade (canvas 2D + OWL 2) servido en una página pública de Odoo 19 (``/neon``),
jugable **sin cuenta**: entra con un apodo y a jugar.

* Cooperativo remoto de hasta 4 jugadores sobre el bus de Odoo (sala por código)
* Sin registro: identidad por token de sesión + apodo (jugadores anónimos)
* Vidas individuales por jugador y posibilidad de revivir a un aliado caído
* 4 tipos de enemigos con IA distinta, un jefe cada 4 oleadas y asteroides
* Audio 100% sintetizado con Web Audio API (sin archivos de sonido)
* Power-ups: triple disparo, escudo, bomba y vida extra
* Sistema de combos hasta x25, partículas, screen shake y slow-motion
* Marcador global único (individual y de equipo) en ``neon.strike.score``

Creado con Odoo. Guía de marca: https://www.odoo.com/page/brand-assets
""",
    "author": "Odoo",
    "website": "https://www.odoo.com",
    "license": "LGPL-3",
    "depends": ["web", "bus"],
    "data": [
        "security/ir.model.access.csv",
        "views/neon_strike_page.xml",
        "views/neon_strike_views.xml",
    ],
    "assets": {
        "web.assets_frontend": [
            "neon_strike/static/src/js/game_engine.js",
            "neon_strike/static/src/js/neon_strike_game.js",
            "neon_strike/static/src/xml/neon_strike_templates.xml",
            "neon_strike/static/src/scss/neon_strike.scss",
        ],
    },
    "application": True,
    "installable": True,
}
