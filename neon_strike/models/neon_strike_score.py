# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo import api, fields, models


class NeonStrikeScore(models.Model):
    """Score of a Neon Strike game.

    One record is created when a game ends. The game is public (no login): the
    player is identified by a nickname. ``user_id`` is only filled in when the
    player happened to be a logged-in Odoo user. The leaderboard is global and
    unique.
    """

    _name = "neon.strike.score"
    _description = "Neon Strike - Score"
    _order = "score desc, id asc"
    _rec_name = "player_name"

    user_id = fields.Many2one(
        "res.users",
        string="User",
        index=True,
        ondelete="cascade",
    )
    nickname = fields.Char(string="Nickname")
    player_name = fields.Char(
        compute="_compute_player_name", store=True, string="Name",
    )
    score = fields.Integer(string="Points", required=True)
    wave = fields.Integer(string="Wave Reached")
    mode = fields.Selection(
        [("solo", "Solo"), ("coop", "Co-op")],
        string="Mode",
        default="solo",
        required=True,
    )
    player_count = fields.Integer(string="Players", default=1)
    match_id = fields.Many2one(
        "neon.strike.match",
        string="Match",
        ondelete="set null",
    )

    @api.depends("nickname", "user_id.name")
    def _compute_player_name(self):
        for score in self:
            score.player_name = score.nickname or score.user_id.name or "Player"
