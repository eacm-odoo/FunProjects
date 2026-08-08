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
    _description = "Ping Pong 3D - Room Player"
    _order = "session_id, slot"

    session_id = fields.Many2one(
        "pingpong.session",
        string="Room",
        required=True,
        ondelete="cascade",
        index=True,
    )
    token = fields.Char(
        string="Player Token",
        required=True,
        index=True,
        copy=False,
        help="Credential issued by the server. Never chosen by the client.",
    )
    session_key = fields.Char(
        string="HTTP Session",
        index=True,
        help="Only to group rate limits and for the optional binding.",
    )
    nickname = fields.Char(string="Apodo")
    partner_id = fields.Many2one(
        "res.partner", string="Contacto", ondelete="set null", index=True
    )
    slot = fields.Integer(string="Puesto", required=True, default=0)
    role = fields.Selection(
        [("host", "Host"), ("guest", "Guest")],
        string="Rol",
        compute="_compute_role",
        store=True,
    )
    name = fields.Char(string="Nombre", compute="_compute_name", store=True)
    score = fields.Integer(string="Score", default=0)
    last_seen = fields.Datetime(string="Last Seen", index=True)
    input_seq = fields.Integer(
        string="Last Sequence",
        default=0,
        help="Descarta entradas repetidas o desordenadas.",
    )

    _slot_uniq = models.Constraint(
        "unique (session_id, slot)",
        "That slot is already taken in the room.",
    )
    _token_uniq = models.Constraint(
        "unique (token)", "Duplicate player token."
    )
    _slot_range = models.Constraint(
        "CHECK (slot IN (0, 1))", "Invalid slot."
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
                or ("Host" if participant.slot == 0 else "Guest")
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
