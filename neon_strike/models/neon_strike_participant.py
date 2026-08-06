# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo import api, fields, models

# Paleta de naves por slot (misma que el motor JS SHIP_COLORS).
PARTICIPANT_COLORS = ["#5ee1ff", "#ff8fb3", "#7bffb0", "#ffd166"]


class NeonStrikeParticipant(models.Model):
    """Jugador dentro de una partida multijugador de Neon Strike.

    El juego es público (sin login): la identidad de cada jugador es un ``token``
    de sesión y un ``nickname`` que escribe él mismo. ``user_id`` solo se rellena
    si por casualidad hay un usuario de Odoo conectado. Cada participante ocupa un
    ``slot`` (0..3) que determina su nave y color.
    """

    _name = "neon.strike.participant"
    _description = "Neon Strike - Participante"
    _order = "match_id, slot"

    match_id = fields.Many2one(
        "neon.strike.match",
        string="Partida",
        required=True,
        ondelete="cascade",
        index=True,
    )
    token = fields.Char(string="Token de sesión", index=True)
    nickname = fields.Char(string="Apodo")
    user_id = fields.Many2one(
        "res.users",
        string="Usuario",
        ondelete="cascade",
    )
    slot = fields.Integer(string="Puesto", default=0)
    name = fields.Char(compute="_compute_name", store=True, string="Nombre")
    color = fields.Char(compute="_compute_color", string="Color")

    @api.depends("nickname", "user_id.name")
    def _compute_name(self):
        for participant in self:
            participant.name = participant.nickname or participant.user_id.name or "Jugador"

    @api.depends("slot")
    def _compute_color(self):
        for participant in self:
            slot = participant.slot or 0
            participant.color = PARTICIPANT_COLORS[slot % len(PARTICIPANT_COLORS)]
