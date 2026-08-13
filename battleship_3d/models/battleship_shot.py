from odoo import api, fields, models

COLS = "ABCDEFGHIJ"
SIZE = 10
SIDE_LABELS = [("a", "Side A"), ("b", "Side B"), ("c", "Side C"), ("d", "Side D")]


class BattleshipShot(models.Model):
    _name = "battleship.shot"
    _description = "Battleship Shot"
    _order = "id desc"

    game_id = fields.Many2one("battleship.game", required=True, ondelete="cascade", index=True)
    shooter = fields.Selection(SIDE_LABELS, required=True)
    # Whose water it landed in. A duel could work this out from `shooter` and
    # never stored it; a free-for-all has three answers, and the log is read
    # back by players who need to know which board a shell was aimed at.
    target = fields.Selection(SIDE_LABELS)
    cell = fields.Integer(required=True)
    coord = fields.Char(compute="_compute_coord", store=True)
    result = fields.Selection(
        [("miss", "Miss"), ("hit", "Hit"), ("sunk", "Sunk")], required=True
    )
    ship_name = fields.Char()

    @api.depends("cell")
    def _compute_coord(self):
        for shot in self:
            shot.coord = "%s%s" % (COLS[shot.cell % SIZE], shot.cell // SIZE + 1)
