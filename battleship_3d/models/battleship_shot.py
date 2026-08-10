from odoo import api, fields, models

COLS = "ABCDEFGHIJ"
SIZE = 10


class BattleshipShot(models.Model):
    _name = "battleship.shot"
    _description = "Battleship Shot"
    _order = "id desc"

    game_id = fields.Many2one("battleship.game", required=True, ondelete="cascade", index=True)
    shooter = fields.Selection([("a", "Side A"), ("b", "Side B")], required=True)
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
