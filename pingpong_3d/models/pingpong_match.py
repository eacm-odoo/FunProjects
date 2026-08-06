from odoo import api, fields, models


class PingPongMatch(models.Model):
    _name = "pingpong.match"
    _description = "Partido de Ping Pong 3D"
    _order = "create_date desc"

    name = fields.Char(compute="_compute_name", store=True)
    partner_id = fields.Many2one(
        "res.partner",
        string="Jugador",
        ondelete="set null",
        index=True,
        help="Vacío cuando el partido lo jugó un visitante anónimo.",
    )
    difficulty = fields.Selection(
        [
            ("facil", "Fácil"),
            ("normal", "Normal"),
            ("dificil", "Difícil"),
            ("experto", "Experto"),
        ],
        string="Dificultad",
        required=True,
        default="normal",
        index=True,
    )
    player_score = fields.Integer(string="Puntos del jugador", required=True)
    machine_score = fields.Integer(string="Puntos de la máquina", required=True)
    hits = fields.Integer(string="Golpes")
    rallies = fields.Integer(string="Puntos jugados")
    won = fields.Boolean(string="Victoria", compute="_compute_won", store=True)
    margin = fields.Integer(string="Diferencia", compute="_compute_won", store=True)

    @api.depends("player_score", "machine_score")
    def _compute_won(self):
        for match in self:
            match.margin = match.player_score - match.machine_score
            match.won = match.player_score > match.machine_score

    @api.depends("partner_id", "player_score", "machine_score", "difficulty")
    def _compute_name(self):
        labels = dict(self._fields["difficulty"]._description_selection(self.env))
        for match in self:
            player = match.partner_id.display_name or "Visitante"
            match.name = "%s — %s-%s (%s)" % (
                player,
                match.player_score,
                match.machine_score,
                labels.get(match.difficulty, ""),
            )
