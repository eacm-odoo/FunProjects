import random
import uuid

from psycopg2 import errors as pgerrors

from odoo import api, fields, models
from odoo.exceptions import UserError

# No 0/O nor 1/I: room codes get read aloud and typed from memory.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_PREFIX = "PONG-"


class PingPongSession(models.Model):
    """An online 1v1 room.

    Called a session rather than a match because ``pingpong.match`` is already
    the history record. A session is the live thing: two players, a bus channel
    and the authoritative score while they play. It writes one
    ``pingpong.match`` when it ends.

    The game is public, so nobody has an Odoo account. A player is identified by
    a server-issued token, and the bus channel is authorised by capability:
    knowing the access token *is* the proof you belong here (see
    ``models/ir_websocket.py``).

    Every method here is called from ``controllers/main.py`` with ``sudo()``.
    """

    _name = "pingpong.session"
    _description = "Ping Pong 3D - Online Room"
    _order = "create_date desc"
    _rec_name = "code"

    MAX_PLAYERS = 2

    code = fields.Char(string="Code", required=True, index=True, copy=False)
    access_token = fields.Char(
        string="Token de acceso",
        required=True,
        index=True,
        copy=False,
        default=lambda self: uuid.uuid4().hex,
        help="Secret naming the bus channel: knowing it is the credential.",
    )
    state = fields.Selection(
        [
            ("waiting", "Esperando rival"),
            ("ready", "Listo"),
            ("playing", "En juego"),
            ("over", "Terminada"),
            ("abandoned", "Abandonada"),
        ],
        string="Estado",
        default="waiting",
        required=True,
        index=True,
    )
    is_public_queue = fields.Boolean(
        string="In Public Queue",
        default=False,
        index=True,
        help="Created by quick match: anyone in the queue can be paired.",
    )
    match_point = fields.Integer(string="Points To Win", required=True, default=11)
    rng_seed = fields.Integer(
        string="Semilla",
        required=True,
        default=lambda self: random.getrandbits(30),
        help="Both clients derive identical serves from it without negotiating.",
    )
    first_server = fields.Selection(
        [("host", "Host"), ("guest", "Guest")],
        string="First Serve",
        default="host",
        required=True,
    )
    participant_ids = fields.One2many(
        "pingpong.participant", "session_id", string="Jugadores"
    )
    # Stored, unlike neon_strike's, because quick match filters on it.
    player_count = fields.Integer(
        string="Nº jugadores", compute="_compute_player_count", store=True
    )
    host_score = fields.Integer(string="Host Score", default=0)
    guest_score = fields.Integer(string="Guest Score", default=0)
    started_at = fields.Datetime(string="Started At")
    ended_at = fields.Datetime(string="Ended At")
    last_activity = fields.Datetime(
        string="Last Signal",
        index=True,
        default=fields.Datetime.now,
        help="Touched by the heartbeat, never by the relay routes: writing this row "
             "at 25 messages per second would serialize the two requests against each other.",
    )
    match_ids = fields.One2many("pingpong.match", "session_id", string="Historial")

    _code_uniq = models.Constraint(
        "unique (code)", "The room code must be unique."
    )
    _access_token_uniq = models.Constraint(
        "unique (access_token)", "The access token must be unique."
    )
    _match_point_range = models.Constraint(
        "CHECK (match_point BETWEEN 3 AND 21)",
        "Points to win must be between 3 and 21.",
    )
    _queue_idx = models.Index(
        "(create_date) WHERE is_public_queue IS TRUE AND state = 'waiting'"
    )
    _reap_idx = models.Index("(state, last_activity)")

    @api.depends("participant_ids")
    def _compute_player_count(self):
        for session in self:
            session.player_count = len(session.participant_ids)

    # ------------------------------------------------------------------ #
    # Helpers                                                            #
    # ------------------------------------------------------------------ #

    def _channel(self):
        """Room channel. Keyed by the token, never by the id, which is guessable."""
        self.ensure_one()
        return "pingpong_session_%s" % self.access_token

    @api.model
    def _generate_code(self):
        for _dummy in range(30):
            code = CODE_PREFIX + "".join(random.choice(CODE_ALPHABET) for _i in range(4))
            if not self.sudo().search_count([("code", "=", code)], limit=1):
                return code
        return CODE_PREFIX + "".join(random.choice(CODE_ALPHABET) for _i in range(6))

    @api.model
    def create_room(self, session_key, nickname, partner_id=False, is_public_queue=False):
        """Create a room with its author as host.

        The code is generated optimistically and retried on collision. Two
        workers can pick the same one between the search and the insert; the
        unique constraint is the real guarantee, so the collision is caught here
        rather than surfacing as a validation error to a player.
        """
        for _attempt in range(5):
            try:
                with self.env.cr.savepoint():
                    session = self.create({
                        "code": self._generate_code(),
                        "is_public_queue": is_public_queue,
                        "state": "waiting",
                    })
            except pgerrors.UniqueViolation:
                continue
            session._add_participant(session_key, nickname, partner_id, slot=0)
            return session
        raise UserError(self.env._("Could not generate a free room code."))

    def _add_participant(self, session_key, nickname, partner_id=False, slot=0):
        self.ensure_one()
        return self.env["pingpong.participant"].create({
            "session_id": self.id,
            "token": uuid.uuid4().hex,
            "session_key": session_key,
            "nickname": nickname,
            "partner_id": partner_id or False,
            "slot": slot,
        })

    def _participant_of(self, token):
        self.ensure_one()
        return self.participant_ids.filtered(lambda p: p.token and p.token == token)[:1]

    def _host(self):
        self.ensure_one()
        return self.participant_ids.filtered(lambda p: p.slot == 0)[:1]

    def _guest(self):
        self.ensure_one()
        return self.participant_ids.filtered(lambda p: p.slot == 1)[:1]

    def _players_payload(self):
        self.ensure_one()
        return [
            {"slot": p.slot, "role": p.role, "name": p.name, "online": p.is_online}
            for p in self.participant_ids.sorted("slot")
        ]

    def _info(self, participant):
        """Everything the client needs to join the room, and nothing else."""
        self.ensure_one()
        return {
            "code": self.code,
            "state": self.state,
            "channel": self._channel(),
            "inbox": participant.inbox_channel() if participant else False,
            "slot": participant.slot if participant else False,
            "role": participant.role if participant else False,
            "match_point": self.match_point,
            "rng_seed": self.rng_seed,
            "first_server": self.first_server,
            "host_score": self.host_score,
            "guest_score": self.guest_score,
            "players": self._players_payload(),
        }

    def _notify_lobby(self):
        self.ensure_one()
        self.env["bus.bus"]._sendone(self._channel(), "pp_lobby", {
            "code": self.code,
            "state": self.state,
            "match_point": self.match_point,
            "players": self._players_payload(),
        })

    def touch(self):
        """Heartbeat. Throttled so it cannot become a write hotspot."""
        self.ensure_one()
        now = fields.Datetime.now()
        if not self.last_activity or (now - self.last_activity).total_seconds() > 4:
            self.last_activity = now

    # ------------------------------------------------------------------ #
    # API called from the public controllers                             #
    # ------------------------------------------------------------------ #

    @api.model
    def join_by_code(self, code, session_key, nickname, partner_id=False):
        """Take the free seat in the room with that code."""
        code = (code or "").strip().upper()
        if not code:
            raise UserError(self.env._("Type a room code."))
        if not code.startswith(CODE_PREFIX):
            code = CODE_PREFIX + code
        session = self.search([("code", "=", code)], limit=1)
        if not session:
            raise UserError(self.env._("There is no room with code %s.", code))
        if session.state in ("over", "abandoned"):
            raise UserError(self.env._("That room is already over."))
        if session.state == "playing":
            raise UserError(self.env._("That match already started."))
        if len(session.participant_ids) >= self.MAX_PLAYERS:
            raise UserError(self.env._("The room is full."))

        participant = session._add_participant(session_key, nickname, partner_id, slot=1)
        session.write({"state": "ready", "last_activity": fields.Datetime.now()})
        session._notify_lobby()
        return participant

    def start(self, participant):
        """The host puts the match in play.

        The server owns the shared time base and the seed. Letting the host
        announce them would mean trusting a client with the clock every
        rewind is measured against.
        """
        self.ensure_one()
        if participant.role != "host":
            raise UserError(self.env._("Only the host can start the match."))
        if self.state == "playing":
            return False
        if len(self.participant_ids) < self.MAX_PLAYERS:
            raise UserError(self.env._("Falta el rival."))

        now = fields.Datetime.now()
        self.write({"state": "playing", "started_at": now, "last_activity": now})
        self.env["bus.bus"]._sendone(self._channel(), "pp_start", {
            # Milliseconds since the epoch, plus a moment for the message to
            # land, so both clients anchor tick 0 to the same instant.
            "t0": int(now.timestamp() * 1000) + 1500,
            "seed": self.rng_seed,
            "match_point": self.match_point,
            "first_server": 0 if self.first_server == "host" else 1,
        })
        return True

    def leave(self, participant):
        """A player walks away.

        If the host goes the room is finished: there is no host migration, so
        there is nobody left to own the ball.
        """
        self.ensure_one()
        reason = "host_left" if participant.role == "host" else "guest_left"
        if participant.role == "host" or self.state == "playing":
            if self.state not in ("over", "abandoned"):
                self.write({"state": "abandoned", "ended_at": fields.Datetime.now()})
            self.env["bus.bus"]._sendone(self._channel(), "pp_end", {"reason": reason})
        else:
            participant.unlink()
            self.write({"state": "waiting"})
            self._notify_lobby()
        return True

    def relay(self, participant, message_type, payload):
        """Forward one peer message to the other player's private inbox.

        Two things happen here and both matter. The sender's role has to allow
        the message type -- only a host broadcasts state, only a guest claims a
        stroke -- and the payload is *rebuilt* from a whitelist rather than
        passed on as it arrived. Relaying a client dictionary verbatim would turn
        the inbox into a way of injecting arbitrary objects into the opponent's
        client.
        """
        self.ensure_one()
        # "slf" goes back to the sender. It is a diagnostic: it measures the
        # HTTP leg plus the bus delivery with one clock and no peer involved, so
        # a slow peer cannot be mistaken for slow plumbing.
        if message_type == "slf":
            peer = participant
        else:
            peer = self._guest() if participant.role == "host" else self._host()
        if not peer:
            return False
        builder = RELAY_TYPES.get(message_type)
        if builder is None:
            return False
        allowed_role = RELAY_ROLES.get(message_type)
        if allowed_role and participant.role != allowed_role:
            return False
        clean = builder(payload or {})
        if clean is None:
            return False
        self.env["bus.bus"]._sendone(peer.inbox_channel(), "pp_msg", {
            "t": message_type,
            "p": clean,
        })
        return True

    # ------------------------------------------------------------------ #
    # Authoritative score                                                #
    # ------------------------------------------------------------------ #

    def record_point(self, participant, winner, reason):
        """Count one point.

        The host reports *who won it and why*, never the scoreboard. The server
        keeps its own tally and increments it by exactly one, so by the time the
        match ends the score is already known here and no client figure is
        needed or trusted.
        """
        self.ensure_one()
        if participant.role != "host" or self.state != "playing":
            return False
        winner = 0 if _as_int(winner, 0, 1) == 0 else 1
        if self.host_score >= self.match_point or self.guest_score >= self.match_point:
            return False

        if winner == 0:
            self.host_score += 1
        else:
            self.guest_score += 1
        target = self._host() if winner == 0 else self._guest()
        if target:
            target.score = self.host_score if winner == 0 else self.guest_score

        over = self.host_score >= self.match_point or self.guest_score >= self.match_point
        self.env["bus.bus"]._sendone(self._channel(), "pp_score", {
            "host": self.host_score,
            "guest": self.guest_score,
            "winner": winner,
            "reason": _as_int(reason, 0, 99),
            "over": over,
        })
        return True

    def finish(self, participant, hits=0, rallies=0, duration=0.0):
        """Close the match and write the history row.

        Any score the client sends is ignored: the tally built by
        ``record_point`` is the one that gets stored.
        """
        self.ensure_one()
        if participant.role != "host":
            return False
        if self.state == "over":
            return self.match_ids[:1]

        host = self._host()
        guest = self._guest()
        now = fields.Datetime.now()
        match = self.env["pingpong.match"].create({
            "mode": "online",
            "session_id": self.id,
            "partner_id": host.partner_id.id or False,
            "player_nickname": host.nickname or "",
            "opponent_partner_id": guest.partner_id.id if guest else False,
            "opponent_nickname": guest.nickname if guest else "",
            "player_score": self.host_score,
            "machine_score": self.guest_score,
            "hits": _as_int(hits, 0, 9999),
            "rallies": _as_int(rallies, 0, 999),
            "duration": max(0.0, min(7200.0, float(duration or 0.0))),
            "finished_at": now,
        })
        self.write({"state": "over", "ended_at": now})
        self.env["bus.bus"]._sendone(self._channel(), "pp_end", {
            "reason": "finished",
            "host": self.host_score,
            "guest": self.guest_score,
            "match_id": match.id,
        })
        return match


def _as_int(value, lo, hi, default=0):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def _ping(payload):
    return {
        "id": _as_int(payload.get("id"), 0, 1_000_000),
        "t0": _as_int(payload.get("t0"), 0, 2 ** 53),
    }


def _pong(payload):
    return {
        "id": _as_int(payload.get("id"), 0, 1_000_000),
        "t0": _as_int(payload.get("t0"), 0, 2 ** 53),
        "t1": _as_int(payload.get("t1"), 0, 2 ** 53),
    }


def _hello(_payload):
    return {}


# ---------------------------------------------------------------------- #
# WebRTC signalling                                                      #
#                                                                        #
# These two carry text rather than numbers, so the check is a type and a #
# length rather than a range. They cross the bus a handful of times while #
# the two browsers find each other, and then the bus goes quiet: the      #
# match itself travels peer to peer.                                     #
# ---------------------------------------------------------------------- #

def _sdp(payload):
    kind = payload.get("kind")
    if kind not in ("offer", "answer"):
        return None
    description = payload.get("sdp")
    if not isinstance(description, str) or not description or len(description) > 20000:
        return None
    return {"kind": kind, "sdp": description}


def _ice(payload):
    candidate = payload.get("candidate")
    if not isinstance(candidate, str) or len(candidate) > 1000:
        return None
    mid = payload.get("sdpMid")
    return {
        "candidate": candidate,
        "sdpMid": str(mid)[:64] if mid is not None else None,
        "sdpMLineIndex": _as_int(payload.get("sdpMLineIndex"), 0, 32),
    }


# Loose bounds. These are not gameplay rules -- the host validates those -- just
# a guarantee that whatever reaches the other client is a number of a plausible
# size, so a payload cannot be used to wedge the receiver.
MM = 100_000          # 100 m, in millimetres
SPIN = 20_000         # rad/s x10
TICK = 2 ** 31


def _ints(value, size, lo, hi):
    if not isinstance(value, (list, tuple)) or len(value) != size:
        return None
    return [_as_int(item, lo, hi) for item in value]


def _samples(value, limit=8):
    """A short trail of paddle poses: [ticks ago, x, y, vx, vy]."""
    if not isinstance(value, (list, tuple)):
        return []
    out = []
    for entry in value[:limit]:
        row = _ints(entry, 5, -MM, MM)
        if row is None:
            return None
        row[0] = _as_int(entry[0], 0, TICK)
        out.append(row)
    return out


def _snapshot(payload):
    ball = _ints(payload.get("b"), 9, -max(MM, SPIN), max(MM, SPIN))
    samples = _samples(payload.get("h"))
    score = _ints(payload.get("s"), 2, 0, 99)
    cooldown = _ints(payload.get("hc"), 2, 0, 5000)
    if ball is None or samples is None or score is None or cooldown is None:
        return None
    return {
        "k": _as_int(payload.get("k"), 0, 99),
        "q": _as_int(payload.get("q"), 0, TICK),
        "t": _as_int(payload.get("t"), 0, TICK),
        "b": ball,
        "h": samples,
        "ph": _as_int(payload.get("ph"), 0, 3),
        "sv": _as_int(payload.get("sv"), 0, 1),
        "lh": _as_int(payload.get("lh"), -1, 1, default=-1),
        "pi": _as_int(payload.get("pi"), 0, 999),
        "f": _as_int(payload.get("f"), 0, 7),
        "s": score,
        "hc": cooldown,
        "stm": _as_int(payload.get("stm"), -5000, 5000),
        "rt": _as_int(payload.get("rt"), -TICK, TICK),
        "et": _as_int(payload.get("et"), -TICK, TICK),
        "hi": _as_int(payload.get("hi"), 0, 99999),
        "ra": _as_int(payload.get("ra"), 0, 999),
        "hs": _as_int(payload.get("hs"), 0, 1),
    }


def _input(payload):
    samples = _samples(payload.get("p"))
    if samples is None:
        return None
    return {
        "k": _as_int(payload.get("k"), 0, 99),
        "i": _as_int(payload.get("i"), 0, TICK),
        "t": _as_int(payload.get("t"), 0, TICK),
        "p": samples,
    }


def _claim(payload):
    base = {
        "k": _as_int(payload.get("k"), 0, 99),
        "id": _as_int(payload.get("id"), 0, TICK),
        "t": _as_int(payload.get("t"), 0, TICK),
    }
    if payload.get("sv"):
        base["sv"] = 1
        return base
    ball = _ints(payload.get("b"), 6, -MM, MM)
    paddle = _ints(payload.get("p"), 4, -MM, MM)
    out = _ints(payload.get("o"), 6, -max(MM, SPIN), max(MM, SPIN))
    if ball is None or paddle is None or out is None:
        return None
    base.update({"b": ball, "p": paddle, "o": out})
    return base


def _event(payload):
    kind = payload.get("e")
    common = {"e": kind, "tick": _as_int(payload.get("tick"), 0, TICK)}
    if kind == "ht":
        # Metres and rad/s, not the millimetres the rest of the wire uses: this
        # event is applied straight onto the ball, so it keeps the simulation's
        # own units. `_floats` also strips NaN and infinity, which are the two
        # values that would quietly poison the receiver's physics.
        return dict(common,
                    p=_floats(payload.get("p")),
                    v=_floats(payload.get("v")),
                    w=_floats(payload.get("w"), limit=SPIN))
    if kind == "sv":
        return dict(common, side=_as_int(payload.get("side"), 0, 1))
    if kind == "pt":
        score = _ints(payload.get("score"), 2, 0, 99)
        if score is None:
            return None
        return dict(
            common,
            winner=_as_int(payload.get("winner"), 0, 1),
            reason=_as_int(payload.get("reason"), 0, 99),
            score=score,
            server=_as_int(payload.get("server"), 0, 1),
            resumeAtTick=_as_int(payload.get("resumeAtTick"), 0, TICK),
            endAtTick=_as_int(payload.get("endAtTick"), 0, TICK),
            pointIndex=_as_int(payload.get("pointIndex"), 0, 999),
        )
    if kind == "end":
        score = _ints(payload.get("score"), 2, 0, 99)
        if score is None:
            return None
        return dict(common, score=score,
                    hits=_as_int(payload.get("hits"), 0, 99999),
                    rallies=_as_int(payload.get("rallies"), 0, 999))
    if kind in ("hok", "hno"):
        return dict(common, id=_as_int(payload.get("id"), 0, TICK),
                    r=_as_int(payload.get("r"), 0, 99), t=_as_int(payload.get("t"), 0, TICK))
    return None


def _floats(value, limit=1000.0):
    if not isinstance(value, (list, tuple)):
        return [0.0, 0.0, 0.0]
    out = []
    for item in value[:3]:
        try:
            number = float(item)
        except (TypeError, ValueError):
            number = 0.0
        if number != number or number in (float("inf"), float("-inf")):
            number = 0.0                     # NaN and infinity are not positions
        out.append(max(-limit, min(limit, number)))
    while len(out) < 3:
        out.append(0.0)
    return out


# Message types the relay accepts, and how each one is rebuilt.
RELAY_TYPES = {
    "png": _ping,
    "slf": _ping,
    "pog": _pong,
    "hlo": _hello,
    "sdp": _sdp,
    "ice": _ice,
    "st": _snapshot,
    "in": _input,
    "cl": _claim,
    "ev": _event,
}

# Which side may send what. Only a host owns the ball and rules on strokes; only
# a guest reports its own paddle and claims a hit.
RELAY_ROLES = {
    "st": "host",
    "ev": "host",
    "in": "guest",
    "cl": "guest",
}
