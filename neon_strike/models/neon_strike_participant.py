# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo import api, fields, models

# Ship palette per slot (same as SHIP_COLORS in the JS engine).
PARTICIPANT_COLORS = ["#5ee1ff", "#ff8fb3", "#7bffb0", "#ffd166"]


class NeonStrikeParticipant(models.Model):
    """Player inside a Neon Strike multiplayer match.

    The game is public (no login): each player's identity is a session ``token``
    plus a ``nickname`` they type themselves. ``user_id`` is only filled in when
    a logged-in Odoo user happens to be playing. Each participant takes a
    ``slot`` (0..3) that determines their ship and colour.
    """

    _name = "neon.strike.participant"
    _description = "Neon Strike - Participant"
    _order = "match_id, slot"

    match_id = fields.Many2one(
        "neon.strike.match",
        string="Match",
        required=True,
        ondelete="cascade",
        index=True,
    )
    token = fields.Char(string="Session Token", index=True)
    nickname = fields.Char(string="Nickname")
    user_id = fields.Many2one(
        "res.users",
        string="User",
        ondelete="cascade",
    )
    slot = fields.Integer(string="Slot", default=0)
    name = fields.Char(compute="_compute_name", store=True, string="Name")
    color = fields.Char(compute="_compute_color", string="Color")

    @api.depends("nickname", "user_id.name")
    def _compute_name(self):
        for participant in self:
            participant.name = participant.nickname or participant.user_id.name or "Player"

    @api.depends("slot")
    def _compute_color(self):
        for participant in self:
            slot = participant.slot or 0
            participant.color = PARTICIPANT_COLORS[slot % len(PARTICIPANT_COLORS)]
