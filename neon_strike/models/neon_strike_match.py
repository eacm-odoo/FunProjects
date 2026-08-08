# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
import random
import uuid

from odoo import api, fields, models
from odoo.exceptions import UserError

# Alphabet without ambiguous characters (0/O, 1/I) for room codes.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class NeonStrikeMatch(models.Model):
    """Neon Strike multiplayer match (remote co-op over the Odoo bus).

    The game is *public*: nobody needs an Odoo account. Each player is
    identified by a session ``token`` and a nickname. One player creates the
    match and acts as the *host* (runs the simulation in their browser and
    broadcasts the state over the bus); the others join with the code, send
    their pointer and render the state they receive. Real authority (start,
    broadcast state, save the score) is validated here by comparing the host
    token, not by ACL alone.

    Every method is called from ``controllers/main.py`` with ``sudo()``.
    """

    _name = "neon.strike.match"
    _description = "Neon Strike - Match"
    _order = "create_date desc"
    _rec_name = "code"

    MAX_PLAYERS = 4

    code = fields.Char(string="Code", required=True, index=True, copy=False)
    access_token = fields.Char(
        string="Access Token",
        required=True,
        index=True,
        copy=False,
        default=lambda self: uuid.uuid4().hex,
        help="Secret used in the bus channel name (subscription capability).",
    )
    host_token = fields.Char(string="Host Token", index=True)
    host_user_id = fields.Many2one(
        "res.users",
        string="Host",
        ondelete="cascade",
        help="Informational only: filled in when the host happened to be a logged-in user.",
    )
    state = fields.Selection(
        [("lobby", "Lobby"), ("playing", "Playing"), ("over", "Over")],
        string="State",
        default="lobby",
        required=True,
    )
    participant_ids = fields.One2many(
        "neon.strike.participant", "match_id", string="Participants"
    )
    player_count = fields.Integer(
        string="Player Count", compute="_compute_player_count"
    )

    _sql_constraints = [
        ("code_uniq", "unique(code)", "The match code must be unique."),
        ("access_token_uniq", "unique(access_token)", "The access token must be unique."),
    ]

    @api.depends("participant_ids")
    def _compute_player_count(self):
        for match in self:
            match.player_count = len(match.participant_ids)

    # ------------------------------------------------------------------ #
    # Internal helpers                                                    #
    # ------------------------------------------------------------------ #

    def _channel(self):
        """Bus channel of this match (authorized in ir.websocket by token)."""
        self.ensure_one()
        return "neon_strike_match_%s" % self.access_token

    def _generate_code(self):
        for _dummy in range(30):
            code = "NEON-" + "".join(random.choice(CODE_ALPHABET) for _i in range(4))
            if not self.sudo().search_count([("code", "=", code)]):
                return code
        # Unlikely fallback: longer code.
        return "NEON-" + "".join(random.choice(CODE_ALPHABET) for _i in range(6))

    def _add_participant(self, token, nickname, uid, slot):
        self.ensure_one()
        return self.env["neon.strike.participant"].create({
            "match_id": self.id,
            "token": token,
            "nickname": nickname,
            "user_id": uid or False,
            "slot": slot,
        })

    def _participant_of(self, token):
        self.ensure_one()
        return self.participant_ids.filtered(lambda p: p.token and p.token == token)[:1]

    def _is_host(self, token):
        self.ensure_one()
        return bool(self.host_token) and self.host_token == token

    def _participants_payload(self):
        """Participant list (sorted by slot) for OWL and the lobby."""
        self.ensure_one()
        return [
            {"slot": p.slot, "name": p.name, "color": p.color}
            for p in self.participant_ids.sorted("slot")
        ]

    def _info(self, token):
        """Match state dictionary for the OWL client."""
        self.ensure_one()
        mine = self._participant_of(token)
        return {
            "id": self.id,
            "code": self.code,
            "state": self.state,
            "is_host": self._is_host(token),
            "host_slot": 0,
            "slot": mine.slot if mine else 0,
            "channel": self._channel(),
            "max_players": self.MAX_PLAYERS,
            "participants": self._participants_payload(),
        }

    def _notify_lobby(self):
        self.ensure_one()
        self.env["bus.bus"]._sendone(self._channel(), "ns_lobby", {
            "id": self.id,
            "state": self.state,
            "participants": self._participants_payload(),
        })

    # ------------------------------------------------------------------ #
    # API called from the public controllers (/neon/*)                    #
    # ------------------------------------------------------------------ #

    @api.model
    def create_match(self, token, nickname, uid=False):
        """Create a match and add the current player as host (slot 0)."""
        match = self.create({
            "code": self._generate_code(),
            "host_token": token,
            "host_user_id": uid or False,
            "state": "lobby",
        })
        match._add_participant(token, nickname, uid, 0)
        return match._info(token)

    @api.model
    def join_by_code(self, code, token, nickname, uid=False):
        """Join the current player to the match with that code."""
        code = (code or "").strip().upper()
        if not code:
            raise UserError(self.env._("Enter a match code."))
        match = self.search([("code", "=", code)], limit=1)
        if not match:
            raise UserError(self.env._("There is no match with code %s.", code))
        if match.state != "lobby":
            raise UserError(self.env._("The match already started or is over."))
        if not match._participant_of(token):
            if len(match.participant_ids) >= self.MAX_PLAYERS:
                raise UserError(self.env._(
                    "The match is full (max. %s players).", self.MAX_PLAYERS
                ))
            used = set(match.participant_ids.mapped("slot"))
            slot = next(i for i in range(self.MAX_PLAYERS) if i not in used)
            match._add_participant(token, nickname, uid, slot)
            match._notify_lobby()
        return match._info(token)

    def start(self, token):
        """The host starts the match."""
        self.ensure_one()
        if not self._is_host(token):
            raise UserError(self.env._("Only the host can start the match."))
        if self.state != "lobby":
            raise UserError(self.env._("The match is not in the lobby."))
        self.state = "playing"
        self.env["bus.bus"]._sendone(self._channel(), "ns_start", {"id": self.id})
        return True

    def player_input(self, token, x, y, action=None):
        """A guest forwards its pointer to the channel (consumed by the host).

        The ``slot`` is derived from the participant authenticated by token (the
        client is not trusted) so that nobody can move someone else's ship.

        ``action`` carries the one-shot inputs that are not a pointer: ``dash``,
        ``act<n>`` (active perk) and ``perk<n>`` (upgrade picked between waves).
        Everything the host validates again on its side.
        """
        self.ensure_one()
        participant = self._participant_of(token)
        if not participant:
            return False
        payload = {
            "slot": participant.slot,
            "x": x,
            "y": y,
        }
        if action:
            payload["a"] = str(action)[:16]
        self.env["bus.bus"]._sendone(self._channel(), "ns_input", payload)
        return True

    def broadcast_state(self, token, snapshot):
        """The host broadcasts a snapshot of the game state."""
        self.ensure_one()
        if not self._is_host(token):
            return False
        self.env["bus.bus"]._sendone(self._channel(), "ns_state", snapshot)
        return True

    def submit_score(self, token, score, wave):
        """The host saves the team score when the match ends."""
        self.ensure_one()
        if not self._is_host(token):
            return False
        host = self._participant_of(token)
        count = len(self.participant_ids) or 1
        self.env["neon.strike.score"].create({
            "user_id": host.user_id.id or False,
            "nickname": host.name,
            "score": int(score or 0),
            "wave": int(wave or 0),
            "mode": "coop" if count > 1 else "solo",
            "player_count": count,
            "match_id": self.id,
        })
        if self.state != "over":
            self.state = "over"
        return True

    def leave(self, token):
        """The current player leaves the match."""
        self.ensure_one()
        if self._is_host(token):
            if self.state != "over":
                self.state = "over"
            self.env["bus.bus"]._sendone(self._channel(), "ns_end", {"reason": "host_left"})
        else:
            self._participant_of(token).unlink()
            self._notify_lobby()
        return True
