from odoo import api, fields, models
from odoo.exceptions import ValidationError


class PingPongMatch(models.Model):
    """A finished match, whether against the machine or against a person.

    One record per match, not per player: a record each way would double the row
    count and quietly break the ``sum=`` totals in the list view. For an online
    match the ``player_*`` side is the host and ``machine_score`` is the guest's
    score, which is why the label changed but the field name did not. Renaming it
    would have broken every existing view, filter and stored value for no gain.
    """

    _name = "pingpong.match"
    _description = "Partido de Ping Pong 3D"
    _order = "create_date desc"

    name = fields.Char(compute="_compute_name", store=True)
    mode = fields.Selection(
        [("solo", "Contra la máquina"), ("online", "Online 1v1")],
        string="Modo",
        required=True,
        default="solo",
        index=True,
    )
    partner_id = fields.Many2one(
        "res.partner",
        string="Jugador",
        ondelete="set null",
        index=True,
        help="Vacío cuando el partido lo jugó un visitante anónimo.",
    )
    opponent_partner_id = fields.Many2one(
        "res.partner",
        string="Rival",
        ondelete="set null",
        index=True,
        help="Solo en online, y solo si el rival tenía sesión iniciada.",
    )
    player_nickname = fields.Char(string="Apodo del jugador")
    opponent_nickname = fields.Char(string="Apodo del rival")
    player_name = fields.Char(compute="_compute_player_names", store=True, string="Jugador")
    opponent_name = fields.Char(compute="_compute_player_names", store=True, string="Rival")
    difficulty = fields.Selection(
        [
            ("facil", "Fácil"),
            ("normal", "Normal"),
            ("dificil", "Difícil"),
            ("experto", "Experto"),
        ],
        string="Dificultad",
        # Optional since online matches have none. Odoo drops the NOT NULL on
        # upgrade, and existing rows keep their value.
        required=False,
        default="normal",
        index=True,
    )
    session_id = fields.Many2one(
        "pingpong.session",
        string="Sala",
        ondelete="set null",
        index=True,
        readonly=True,
        help="Sala online que produjo este resultado. Vacío en modo máquina.",
    )
    player_score = fields.Integer(string="Puntos del jugador", required=True)
    machine_score = fields.Integer(string="Puntos del rival", required=True)
    hits = fields.Integer(string="Golpes")
    rallies = fields.Integer(string="Puntos jugados")
    duration = fields.Float(string="Duración", help="En segundos.")
    finished_at = fields.Datetime(string="Terminado")
    won = fields.Boolean(string="Victoria", compute="_compute_won", store=True)
    margin = fields.Integer(string="Diferencia", compute="_compute_won", store=True)
    winner_side = fields.Selection(
        [("player", "Jugador"), ("opponent", "Rival"), ("draw", "Empate")],
        string="Ganador",
        compute="_compute_won",
        store=True,
    )

    _scores_positive = models.Constraint(
        "CHECK (player_score >= 0 AND machine_score >= 0)",
        "Los marcadores no pueden ser negativos.",
    )

    @api.constrains("mode", "difficulty")
    def _check_difficulty(self):
        for match in self:
            if match.mode == "solo" and not match.difficulty:
                raise ValidationError(
                    self.env._("Un partido contra la máquina necesita una dificultad.")
                )

    @api.depends("player_score", "machine_score")
    def _compute_won(self):
        for match in self:
            match.margin = match.player_score - match.machine_score
            match.won = match.player_score > match.machine_score
            if match.player_score > match.machine_score:
                match.winner_side = "player"
            elif match.player_score < match.machine_score:
                match.winner_side = "opponent"
            else:
                match.winner_side = "draw"

    @api.depends("mode", "partner_id.display_name", "player_nickname",
                 "opponent_partner_id.display_name", "opponent_nickname")
    def _compute_player_names(self):
        for match in self:
            match.player_name = (
                match.partner_id.display_name or match.player_nickname or "Visitante"
            )
            if match.mode == "online":
                match.opponent_name = (
                    match.opponent_partner_id.display_name
                    or match.opponent_nickname
                    or "Rival"
                )
            else:
                match.opponent_name = "Máquina"

    @api.depends("mode", "player_name", "opponent_name", "player_score",
                 "machine_score", "difficulty")
    def _compute_name(self):
        labels = dict(self._fields["difficulty"]._description_selection(self.env))
        for match in self:
            if match.mode == "online":
                match.name = "%s vs %s — %s-%s (Online)" % (
                    match.player_name,
                    match.opponent_name,
                    match.player_score,
                    match.machine_score,
                )
            else:
                match.name = "%s — %s-%s (%s)" % (
                    match.player_name,
                    match.player_score,
                    match.machine_score,
                    labels.get(match.difficulty, ""),
                )
