# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo import api, fields, models


class NeonStrikeFeedback(models.Model):
    """A bug report or an idea sent by a player from the public page.

    Written through ``/neon/feedback`` with ``sudo()``: the page is public and
    everybody is the Odoo public user, so the author is the session token plus
    the nickname they typed, exactly like scores. Nothing here is trusted, and
    the controller is the one that caps sizes and validates the screenshot.
    """

    _name = "neon.strike.feedback"
    _description = "Neon Strike - Player Feedback"
    _order = "create_date desc, id desc"
    _rec_name = "title"

    title = fields.Char(
        string="Subject",
        compute="_compute_title",
        store=True,
        help="First line of the message, so the list reads without opening each record.",
    )
    kind = fields.Selection(
        [("bug", "Bug"), ("idea", "Idea"), ("other", "Other")],
        string="Type",
        default="bug",
        required=True,
        index=True,
    )
    message = fields.Text(string="Message", required=True)
    image = fields.Image(string="Screenshot", max_width=1600, max_height=1600)
    image_filename = fields.Char(string="File Name")

    nickname = fields.Char(string="Nickname")
    user_id = fields.Many2one(
        "res.users", string="User", index=True, ondelete="set null",
        help="Filled in only when the player happened to be a logged-in user.",
    )
    token = fields.Char(
        string="Session Token", index=True,
        help="Anonymous author: lets you spot several reports from the same player.",
    )

    # Snapshot of the run the report was sent from; a bug report is worth
    # little without it.
    wave = fields.Integer(string="Wave")
    score = fields.Integer(string="Points")
    mode = fields.Selection(
        [("menu", "Menu"), ("solo", "Solo"), ("coop", "Co-op")],
        string="Sent From", default="menu",
    )
    perks = fields.Char(string="Perks", help="Perks the player was carrying, if any.")

    state = fields.Selection(
        [("new", "New"), ("open", "In Progress"), ("done", "Done"), ("wont", "Won't Do")],
        string="Status",
        default="new",
        required=True,
        index=True,
    )
    note = fields.Text(string="Internal Note")

    @api.depends("message", "kind")
    def _compute_title(self):
        for feedback in self:
            text = (feedback.message or "").strip().splitlines()
            first = text[0] if text else ""
            feedback.title = (first[:60] or "(no message)")
