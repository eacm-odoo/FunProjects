# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
import random
import uuid

from odoo import api, fields, models
from odoo.exceptions import UserError

# Alfabeto sin caracteres ambiguos (0/O, 1/I) para los codigos de sala.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class NeonStrikeMatch(models.Model):
    """Partida multijugador de Neon Strike (co-op remoto sobre el bus de Odoo).

    El juego es *público*: nadie necesita cuenta de Odoo. Cada jugador se
    identifica con un ``token`` de sesión y un apodo. Un jugador crea la partida y
    actua de *host* (corre la simulacion en su navegador y difunde el estado por el
    bus); los demas se unen con el codigo, envian su puntero y renderizan el estado
    recibido. La autoridad real (empezar, difundir estado, guardar marcador) se
    valida aqui comparando el token del host, no solo por ACL.

    Todos los metodos se invocan desde ``controllers/main.py`` con ``sudo()``.
    """

    _name = "neon.strike.match"
    _description = "Neon Strike - Partida"
    _order = "create_date desc"
    _rec_name = "code"

    MAX_PLAYERS = 4

    code = fields.Char(string="Código", required=True, index=True, copy=False)
    access_token = fields.Char(
        string="Token de acceso",
        required=True,
        index=True,
        copy=False,
        default=lambda self: uuid.uuid4().hex,
        help="Secreto usado en el nombre del canal de bus (capacidad de suscripción).",
    )
    host_token = fields.Char(string="Token del anfitrión", index=True)
    host_user_id = fields.Many2one(
        "res.users",
        string="Anfitrión",
        ondelete="cascade",
        help="Solo informativo: se rellena si el anfitrión resultó ser un usuario conectado.",
    )
    state = fields.Selection(
        [("lobby", "Sala de espera"), ("playing", "En juego"), ("over", "Terminada")],
        string="Estado",
        default="lobby",
        required=True,
    )
    participant_ids = fields.One2many(
        "neon.strike.participant", "match_id", string="Participantes"
    )
    player_count = fields.Integer(
        string="Nº jugadores", compute="_compute_player_count"
    )

    _sql_constraints = [
        ("code_uniq", "unique(code)", "El código de partida debe ser único."),
        ("access_token_uniq", "unique(access_token)", "El token de acceso debe ser único."),
    ]

    @api.depends("participant_ids")
    def _compute_player_count(self):
        for match in self:
            match.player_count = len(match.participant_ids)

    # ------------------------------------------------------------------ #
    # Helpers internos                                                    #
    # ------------------------------------------------------------------ #

    def _channel(self):
        """Canal de bus de esta partida (autorizado en ir.websocket por token)."""
        self.ensure_one()
        return "neon_strike_match_%s" % self.access_token

    def _generate_code(self):
        for _dummy in range(30):
            code = "NEON-" + "".join(random.choice(CODE_ALPHABET) for _i in range(4))
            if not self.sudo().search_count([("code", "=", code)]):
                return code
        # Fallback improbable: codigo mas largo.
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
        """Lista de participantes (ordenada por slot) para OWL y el lobby."""
        self.ensure_one()
        return [
            {"slot": p.slot, "name": p.name, "color": p.color}
            for p in self.participant_ids.sorted("slot")
        ]

    def _info(self, token):
        """Diccionario de estado de la partida para el cliente OWL."""
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
    # API llamada desde los controladores públicos (/neon/*)             #
    # ------------------------------------------------------------------ #

    @api.model
    def create_match(self, token, nickname, uid=False):
        """Crea una partida y añade al jugador actual como host (slot 0)."""
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
        """Une al jugador actual a la partida con ese código."""
        code = (code or "").strip().upper()
        if not code:
            raise UserError(self.env._("Introduce un código de partida."))
        match = self.search([("code", "=", code)], limit=1)
        if not match:
            raise UserError(self.env._("No existe una partida con el código %s.", code))
        if match.state != "lobby":
            raise UserError(self.env._("La partida ya empezó o terminó."))
        if not match._participant_of(token):
            if len(match.participant_ids) >= self.MAX_PLAYERS:
                raise UserError(self.env._(
                    "La partida está llena (máx. %s jugadores).", self.MAX_PLAYERS
                ))
            used = set(match.participant_ids.mapped("slot"))
            slot = next(i for i in range(self.MAX_PLAYERS) if i not in used)
            match._add_participant(token, nickname, uid, slot)
            match._notify_lobby()
        return match._info(token)

    def start(self, token):
        """El host arranca la partida."""
        self.ensure_one()
        if not self._is_host(token):
            raise UserError(self.env._("Solo el anfitrión puede empezar la partida."))
        if self.state != "lobby":
            raise UserError(self.env._("La partida no está en la sala de espera."))
        self.state = "playing"
        self.env["bus.bus"]._sendone(self._channel(), "ns_start", {"id": self.id})
        return True

    def player_input(self, token, x, y):
        """Un guest reenvía su puntero al canal (lo consume el host).

        El ``slot`` se deriva del participante autenticado por token (no se
        confía en el cliente) para que nadie pueda mover la nave de otro.
        """
        self.ensure_one()
        participant = self._participant_of(token)
        if not participant:
            return False
        self.env["bus.bus"]._sendone(self._channel(), "ns_input", {
            "slot": participant.slot,
            "x": x,
            "y": y,
        })
        return True

    def broadcast_state(self, token, snapshot):
        """El host difunde un snapshot del estado del juego."""
        self.ensure_one()
        if not self._is_host(token):
            return False
        self.env["bus.bus"]._sendone(self._channel(), "ns_state", snapshot)
        return True

    def submit_score(self, token, score, wave):
        """El host guarda el marcador de equipo al terminar la partida."""
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
        """El jugador actual abandona la partida."""
        self.ensure_one()
        if self._is_host(token):
            if self.state != "over":
                self.state = "over"
            self.env["bus.bus"]._sendone(self._channel(), "ns_end", {"reason": "host_left"})
        else:
            self._participant_of(token).unlink()
            self._notify_lobby()
        return True
