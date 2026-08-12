from odoo import api, fields, models
from odoo.exceptions import UserError
from odoo.tools.translate import _

# A visitor with no account can write here, so the door is narrow: short fields,
# and a handful of reports per browser per hour. Nothing else stands between an
# open route and a table anybody may fill.
SUBJECT_LEN = 80
BODY_LEN = 2000
BURST = 5
BURST_HOURS = 1


class BattleshipFeedback(models.Model):
    _name = "battleship.feedback"
    _description = "Battleship Feedback"
    _order = "create_date desc"

    name = fields.Char(string="Subject", required=True)
    kind = fields.Selection(
        [("bug", "Bug"), ("idea", "Idea")], default="bug", required=True
    )
    description = fields.Text(required=True)
    state = fields.Selection(
        [("new", "New"), ("triaged", "Triaged"), ("done", "Done")],
        default="new", required=True,
    )
    # Who sent it, as far as anything can be told: a logged in user, or the
    # browser token of an anonymous player. Both are empty on nothing.
    user_id = fields.Many2one("res.users", readonly=True)
    session_token = fields.Char(index=True, readonly=True, copy=False)
    # What they were looking at. A bug report about a board is worth what the
    # board is worth, so the game travels with it.
    game_id = fields.Many2one("battleship.game", ondelete="set null", readonly=True)
    game_mode = fields.Selection(related="game_id.mode", store=True, readonly=True)

    @api.model
    def action_report(self, kind, subject, description, game_id=None, token=None, uid=False):
        """Take a report from the board, whoever is at it.

        The caller has already been resolved by the controller: `token` is the
        browser this came from and `uid` a real user behind it, if any. Neither
        is trusted for anything but attribution — a report grants no rights and
        reads nothing back.
        """
        subject = (subject or "").strip()[:SUBJECT_LEN]
        description = (description or "").strip()[:BODY_LEN]
        if not description:
            raise UserError(_("Say what happened, or what you would like to see."))
        if kind not in ("bug", "idea"):
            kind = "bug"
        self._check_burst(token, uid)
        self.sudo().create({
            "name": subject or description.split("\n")[0][:SUBJECT_LEN],
            "kind": kind,
            "description": description,
            "user_id": uid or False,
            "session_token": token or False,
            "game_id": game_id or False,
        })
        return True

    @api.model
    def _check_burst(self, token, uid):
        """One player, a few reports an hour. Enough for a session, not a flood."""
        if not token and not uid:
            return
        since = fields.Datetime.subtract(fields.Datetime.now(), hours=BURST_HOURS)
        author = [("session_token", "=", token)] if token else [("user_id", "=", uid)]
        recent = self.sudo().search_count(author + [("create_date", ">=", since)])
        if recent >= BURST:
            raise UserError(_("That is a lot of reports at once — try again later."))
