from datetime import timedelta

from odoo import api, fields, models

# A player is considered gone after this long without a heartbeat.
ONLINE_WINDOW = 15


class PingPongParticipant(models.Model):
    """One player in an online room.

    Identity is a server-issued ``token``, returned to the client exactly once
    and kept in `sessionStorage`. That is a deliberate departure from
    ``neon_strike``, which derives identity from the http session and therefore
    cannot tell two tabs of one browser apart -- which in turn makes local
    testing of a two-player game impossible.

    The http session key is recorded anyway, for rate-limit bucketing and for an
    optional strict binding check.
    """

    _name = "pingpong.participant"
    _description = "Ping Pong 3D - Jugador de una sala"
    _order = "session_id, slot"

    session_id = fields.Many2one(
        "pingpong.session",
        string="Sala",
        required=True,
        ondelete="cascade",
        index=True,
    )
    token = fields.Char(
        string="Token del jugador",
        required=True,
        index=True,
        copy=False,
        help="Credencial emitida por el servidor. Nunca la elige el cliente.",
    )
    session_key = fields.Char(
        string="Sesión HTTP",
        index=True,
        help="Solo para agrupar límites de tasa y para la vinculación opcional.",
    )
    nickname = fields.Char(string="Apodo")
    partner_id = fields.Many2one(
        "res.partner", string="Contacto", ondelete="set null", index=True
    )
    slot = fields.Integer(string="Puesto", required=True, default=0)
    role = fields.Selection(
        [("host", "Anfitrión"), ("guest", "Invitado")],
        string="Rol",
        compute="_compute_role",
        store=True,
    )
    name = fields.Char(string="Nombre", compute="_compute_name", store=True)
    score = fields.Integer(string="Puntos", default=0)
    last_seen = fields.Datetime(string="Visto por última vez", index=True)
    input_seq = fields.Integer(
        string="Última secuencia",
        default=0,
        help="Descarta entradas repetidas o desordenadas.",
    )

    _slot_uniq = models.Constraint(
        "unique (session_id, slot)",
        "Ese puesto ya está ocupado en la sala.",
    )
    _token_uniq = models.Constraint(
        "unique (token)", "Token de jugador duplicado."
    )
    _slot_range = models.Constraint(
        "CHECK (slot IN (0, 1))", "Puesto inválido."
    )

    @api.depends("slot")
    def _compute_role(self):
        for participant in self:
            participant.role = "host" if participant.slot == 0 else "guest"

    @api.depends("nickname", "partner_id.display_name", "slot")
    def _compute_name(self):
        for participant in self:
            participant.name = (
                participant.nickname
                or participant.partner_id.display_name
                or ("Anfitrión" if participant.slot == 0 else "Invitado")
            )

    @property
    def is_online(self):
        self.ensure_one()
        if not self.last_seen:
            return False
        return (fields.Datetime.now() - self.last_seen).total_seconds() < ONLINE_WINDOW

    def inbox_channel(self):
        """Private channel, one per player.

        The data plane does not go through the room channel. On a shared channel
        the host would receive its own snapshots back and each player would
        receive the other's paddle stream, which at these rates is pure waste and
        client-side filtering. With inboxes each side receives only what it needs.
        """
        self.ensure_one()
        return "pingpong_player_%s" % self.token

    def touch(self):
        """Heartbeat, throttled: this must not become a write hotspot."""
        self.ensure_one()
        now = fields.Datetime.now()
        if not self.last_seen or (now - self.last_seen) > timedelta(seconds=4):
            self.last_seen = now
