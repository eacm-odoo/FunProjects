# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo import fields, models


class NeonStrikeScore(models.Model):
    """Puntuación de una partida de Neon Strike.

    Cada registro se crea desde el cliente (OWL) al terminar una partida.
    El jugador es siempre el usuario conectado (default), de modo que el
    leaderboard es multi-usuario sin configuración extra.
    """

    _name = "neon.strike.score"
    _description = "Neon Strike - Puntuación"
    _order = "score desc, id asc"
    _rec_name = "player_name"

    user_id = fields.Many2one(
        "res.users",
        string="Jugador",
        required=True,
        index=True,
        ondelete="cascade",
        default=lambda self: self.env.user,
    )
    player_name = fields.Char(
        related="user_id.name", store=True, string="Nombre",
    )
    score = fields.Integer(string="Puntos", required=True)
    wave = fields.Integer(string="Oleada alcanzada")
