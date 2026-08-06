# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo import api, fields, models


class NeonStrikeScore(models.Model):
    """Puntuación de una partida de Neon Strike.

    Cada registro se crea al terminar una partida. El juego es público (sin
    login): el jugador se identifica por un apodo. ``user_id`` solo se rellena si
    resultó ser un usuario de Odoo conectado. El leaderboard es global y único.
    """

    _name = "neon.strike.score"
    _description = "Neon Strike - Puntuación"
    _order = "score desc, id asc"
    _rec_name = "player_name"

    user_id = fields.Many2one(
        "res.users",
        string="Usuario",
        index=True,
        ondelete="cascade",
    )
    nickname = fields.Char(string="Apodo")
    player_name = fields.Char(
        compute="_compute_player_name", store=True, string="Nombre",
    )
    score = fields.Integer(string="Puntos", required=True)
    wave = fields.Integer(string="Oleada alcanzada")
    mode = fields.Selection(
        [("solo", "Individual"), ("coop", "Cooperativo")],
        string="Modo",
        default="solo",
        required=True,
    )
    player_count = fields.Integer(string="Jugadores", default=1)
    match_id = fields.Many2one(
        "neon.strike.match",
        string="Partida",
        ondelete="set null",
    )

    @api.depends("nickname", "user_id.name")
    def _compute_player_name(self):
        for score in self:
            score.player_name = score.nickname or score.user_id.name or "Jugador"
