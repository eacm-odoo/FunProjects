import random
import uuid

from psycopg2 import errors as pgerrors

from odoo import api, fields, models
from odoo.exceptions import LockError, UserError
from odoo.tools.translate import _

SIZE = 10
# No 0/O nor 1/I: room codes are read aloud and typed from memory.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_PREFIX = "BSHP-"
FLEET = [
    ("Carrier", 5),
    ("Battleship", 4),
    ("Cruiser", 3),
    ("Submarine", 3),
    ("Destroyer", 2),
]
COLS = "ABCDEFGHIJ"
# Every seat a game can have. Two of them are used by every mode that came
# first; the free-for-all uses all four, and the extra two are the reason most
# of the code below asks `_seats()` instead of naming sides itself.
SIDES = ("a", "b", "c", "d")
SIDE_LABELS = [("a", "Side A"), ("b", "Side B"), ("c", "Side C"), ("d", "Side D")]
# Presence, in seconds. A seat is called quiet once nothing has been heard from
# it for AWAY_AFTER; the client beats every 15s, so that is three missed beats —
# enough slack for a slow network and for a browser throttling a hidden tab.
# PING_STEP is how stale a stored timestamp has to be before a beat rewrites it,
# so two players do not put a write on the table every few seconds each.
AWAY_AFTER = 45
PING_STEP = 5


def coord(cell):
    return "%s%s" % (COLS[cell % SIZE], cell // SIZE + 1)


class BattleshipGame(models.Model):
    _name = "battleship.game"
    _description = "Battleship Game"
    _order = "create_date desc"

    name = fields.Char(default=lambda self: _("New game"), required=True)
    user_id = fields.Many2one("res.users", default=lambda self: self.env.user, required=True)
    # Owner of a game started from the public /battleship page: visitors share
    # the same public user, so the browser session is what tells them apart.
    # Empty for games played from the backend, which belong to `user_id`.
    session_token = fields.Char(index=True, copy=False)
    mode = fields.Selection(
        [
            ("cpu", "vs CPU"),
            ("hotseat", "2 players (hot-seat)"),
            ("online", "2 players (online)"),
            ("royale", "Free-for-all (4 boards)"),
        ],
        default="cpu", required=True,
    )
    state = fields.Selection(
        [
            ("lobby", "Waiting for opponent"),
            ("setup", "Placing fleets"),
            ("battle", "Battle"),
            ("done", "Finished"),
        ],
        default="setup", required=True,
    )
    setup_for = fields.Selection(SIDE_LABELS, default="a")
    current_player = fields.Selection(SIDE_LABELS, default="a")
    winner = fields.Selection(SIDE_LABELS)
    end_reason = fields.Selection(
        [("fleet", "Fleet destroyed"), ("forfeit", "Opponent left")]
    )
    # [{"name": str, "size": int, "cells": [int], "hits": int, "sunk": bool}]
    fleet_a = fields.Json(default=lambda self: self._new_fleet())
    fleet_b = fields.Json(default=lambda self: self._new_fleet())
    fleet_c = fields.Json(default=lambda self: self._new_fleet())
    fleet_d = fields.Json(default=lambda self: self._new_fleet())
    shots_a = fields.Json(default=list)  # cells fired AT side A, by anybody
    shots_b = fields.Json(default=list)
    shots_c = fields.Json(default=list)
    shots_d = fields.Json(default=list)
    # Seats the admiralty is playing, and seats that are no longer in the game
    # without their fleet having been sunk — somebody who walked out of a
    # free-for-all while two others were still shooting at each other.
    cpu_sides = fields.Json(default=list)
    left_sides = fields.Json(default=list)
    # A turn is one shell at every rival still afloat, so it takes several calls
    # to play. This is how far through that sweep the seat holding the turn is:
    # the boards it is done with. It is emptied whenever the gun changes hands.
    turn_cleared = fields.Json(default=list)
    shot_ids = fields.One2many("battleship.shot", "game_id", string="Shot log")
    shot_count = fields.Integer(compute="_compute_shot_count")
    # A game is over when somebody has won or walked away, and that is the only
    # moment worth timing from `create_date`. A room nobody ever came back to
    # has no end and counts as no time played, which is the honest reading: it
    # was not played, it was left open.
    date_end = fields.Datetime(readonly=True, copy=False)
    duration = fields.Float(
        compute="_compute_duration", store=True, aggregator="sum",
        help="Hours between the first move and the end of the game.",
    )

    # ------------------------------------------------------------------
    # online rooms
    # ------------------------------------------------------------------
    # An online game is the same record as any other, plus what it takes for two
    # browsers to meet: a code they type at each other, a secret naming the bus
    # channel, and one token per seat. Nobody needs an Odoo account, so a player
    # is whoever holds the token of a seat — the same browser token the public
    # page already issues (see `controllers/main.py`).
    code = fields.Char(index=True, copy=False, help="Code the opponent types to join.")
    access_token = fields.Char(
        index=True, copy=False,
        help="Secret naming the bus channel: knowing it is the subscription capability.",
    )
    token_a = fields.Char(index=True, copy=False, help="Browser token holding side A.")
    token_b = fields.Char(index=True, copy=False, help="Browser token holding side B.")
    token_c = fields.Char(index=True, copy=False, help="Browser token holding side C.")
    token_d = fields.Char(index=True, copy=False, help="Browser token holding side D.")
    name_a = fields.Char()
    name_b = fields.Char()
    name_c = fields.Char()
    name_d = fields.Char()
    ready_a = fields.Boolean(help="Side A locked its fleet in.")
    ready_b = fields.Boolean()
    ready_c = fields.Boolean()
    ready_d = fields.Boolean()
    # Two browsers meeting over a bus have no way of saying goodbye: a closed
    # tab, a dead network and a shut laptop all look the same from here. So each
    # seat leaves a sign of life behind every few seconds and the other one
    # reads it. Nothing is ever decided on these two columns — a room is never
    # forfeited because somebody went quiet, it is only said out loud.
    seen_a = fields.Datetime(copy=False, help="Last sign of life from side A.")
    seen_b = fields.Datetime(copy=False, help="Last sign of life from side B.")
    seen_c = fields.Datetime(copy=False, help="Last sign of life from side C.")
    seen_d = fields.Datetime(copy=False, help="Last sign of life from side D.")
    rematch_id = fields.Many2one(
        "battleship.game", copy=False, ondelete="set null",
        help="Room that replaced this one when the players asked for a rematch.",
    )

    _code_uniq = models.Constraint("unique (code)", "The room code must be unique.")
    _access_token_uniq = models.Constraint(
        "unique (access_token)", "The access token must be unique."
    )

    @api.depends("shot_ids")
    def _compute_shot_count(self):
        for game in self:
            game.shot_count = len(game.shot_ids)

    @api.depends("create_date", "date_end")
    def _compute_duration(self):
        for game in self:
            done = game.create_date and game.date_end
            game.duration = (game.date_end - game.create_date).total_seconds() / 3600 if done else 0

    def write(self, vals):
        """Stamp the end of a game wherever it is declared over.

        A fleet can go down in `_resolve`, a room can be walked out of in
        `action_leave`, and both write `state`. The clock is stopped here so
        that it cannot be forgotten in a third place later on.
        """
        if vals.get("state") == "done" and "date_end" not in vals:
            vals = dict(vals, date_end=fields.Datetime.now())
        return super().write(vals)

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    @api.model
    def _new_fleet(self):
        return [
            {"name": name, "size": size, "cells": [], "hits": 0, "sunk": False}
            for name, size in FLEET
        ]

    # ------------------------------------------------------------------
    # seats
    # ------------------------------------------------------------------
    # Every mode before the free-for-all had exactly two sides and could name
    # them. Four boards means the number of players is a property of the game,
    # so nothing below counts seats itself: it asks.
    def _seats(self):
        """The sides this game is played with, in turn order."""
        self.ensure_one()
        return list(SIDES) if self.mode == "royale" else ["a", "b"]

    def _is_room(self):
        """A game two or more browsers meet in, rather than one screen's game.

        Rooms are the ones with a code, a bus channel, a seat per token and a
        heartbeat; `cpu` and `hotseat` have none of that and never will.
        """
        self.ensure_one()
        return self.mode in ("online", "royale")

    def _is_cpu(self, side):
        """True when the admiralty is playing that seat.

        `cpu_sides` is the general answer and the only one a free-for-all uses.
        The `cpu` mode predates it and says the same thing by its name, which is
        also what keeps games created before this field from going quiet.
        """
        self.ensure_one()
        return side in self._json(self.cpu_sides) or (self.mode == "cpu" and side == "b")

    def _is_out(self, side):
        """Out of the game: fleet on the bottom, or walked away from the table."""
        self.ensure_one()
        if side in self._json(self.left_sides):
            return True
        fleet = self._fleet(side)
        return bool(fleet) and all(ship["sunk"] for ship in fleet)

    def _alive_sides(self):
        return [side for side in self._seats() if not self._is_out(side)]

    def _first_player(self):
        """Who opens the shooting: the first seat, or the first one still in it."""
        self.ensure_one()
        return next((side for side in self._seats() if not self._is_out(side)), "a")

    def _next_player(self, after):
        """Whose turn it is once `after` is done, skipping everybody who is out.

        Returns None when there is nobody left to hand the turn to, which is the
        same thing as the game being over.
        """
        self.ensure_one()
        seats = self._seats()
        order = seats[seats.index(after) + 1:] + seats[:seats.index(after)]
        return next((side for side in order if not self._is_out(side)), None)

    def _pending_targets(self, shooter):
        """Boards `shooter` still owes a shell before the turn moves on.

        The sweep is never stored as a list of targets, only as the boards
        already dealt with, so a fleet that goes down or a player who walks out
        halfway through drops out of the turn on their own.
        """
        self.ensure_one()
        cleared = set(self._json(self.turn_cleared))
        return [
            side for side in self._alive_sides()
            if side != shooter and side not in cleared
        ]

    def _set_turn(self, side):
        """Hand the gun to `side`, with a whole sweep in front of it."""
        self.ensure_one()
        self.write({"current_player": side, "turn_cleared": []})

    def _fleet(self, side):
        return list(self._json(self["fleet_%s" % side]))

    def _write_fleet(self, side, fleet):
        self.write({"fleet_%s" % side: fleet})

    def _shots(self, side):
        return list(self._json(self["shots_%s" % side]))

    def _json(self, value):
        """An empty Json field is stored as NULL and reads back as False.

        `shots_a` starts out empty on every game, so nothing that reads these
        fields can hand them straight to `list()`.
        """
        return value or []

    def _occupied(self, fleet, ignore_index=None):
        taken = set()
        for i, ship in enumerate(fleet):
            if i != ignore_index:
                taken.update(ship["cells"])
        return taken

    def _cells_for(self, cell, size, direction):
        col, row = cell % SIZE, cell // SIZE
        cells = []
        for i in range(size):
            c = col + (i if direction == "h" else 0)
            r = row + (i if direction == "v" else 0)
            if c >= SIZE or r >= SIZE:
                return None
            cells.append(r * SIZE + c)
        return cells

    # ------------------------------------------------------------------
    # online rooms
    # ------------------------------------------------------------------
    def _channel(self):
        """Bus channel of the room, keyed by the token and never by the id.

        Ids are guessable; the token is what `ir.websocket` checks before
        letting a browser subscribe (see `models/ir_websocket.py`).
        """
        self.ensure_one()
        return "battleship_game_%s" % self.access_token

    def _invite_url(self):
        """Link that seats whoever opens it in this room.

        It carries the code and nothing else: the seat is still taken by the
        browser token the join route issues, so a link that leaks is worth no
        more than the code itself — it opens the room while it is empty, and
        stops working the moment somebody sits down.
        """
        self.ensure_one()
        return "%s/battleship/join/%s" % (self.get_base_url(), self.code)

    @api.model
    def _generate_code(self):
        for _dummy in range(30):
            code = CODE_PREFIX + "".join(random.choice(CODE_ALPHABET) for _i in range(4))
            if not self.sudo().search_count([("code", "=", code)], limit=1):
                return code
        return CODE_PREFIX + "".join(random.choice(CODE_ALPHABET) for _i in range(6))

    def _side_of(self, token):
        """Which seat that browser token holds, if any."""
        self.ensure_one()
        if not token:
            return None
        return next((side for side in self._seats() if self["token_%s" % side] == token), None)

    def _free_seat(self):
        """The first seat nobody is sitting in, or None when the room is full."""
        self.ensure_one()
        return next((side for side in self._seats() if not self["token_%s" % side]), None)

    # ------------------------------------------------------------------
    # presence
    # ------------------------------------------------------------------
    def action_ping(self, side):
        """Leave a sign of life on a seat, and read the other one's.

        The beat that keeps a seat alive is also the question about the
        opponent: one small call every few seconds answers both, and a client
        that stops asking is exactly the client the answer is about.

        It never touches the game. A player who went quiet has not lost, has not
        left and has not forfeited — the room waits for them exactly as long as
        the other player is willing to.
        """
        self.ensure_one()
        if not self._is_room() or side not in self._seats():
            return False
        now = fields.Datetime.now()
        seen = self["seen_%s" % side]
        # One write per player every few seconds is a lot of writes for a row
        # that nobody reads that often: skip the beats that would only repeat
        # what the column already says.
        if not seen or (now - seen).total_seconds() >= PING_STEP:
            self.write({"seen_%s" % side: now})
        return [
            self._presence_of(other) for other in self._seats()
            if other != side and self["token_%s" % other]
        ]

    def _presence_of(self, side):
        """How long ago that seat was last heard from, and whether that is long.

        An empty seat is not away, it is empty: a lobby has one player in it by
        definition, and saying the others went quiet would be a lie about people
        who never arrived. A seat the admiralty is playing is never away either
        — it is right here, in this process.
        """
        self.ensure_one()
        seen = self["seen_%s" % side]
        if not self._is_room() or not self["token_%s" % side] or not seen:
            return {"seat": side, "away": False, "seconds": 0}
        seconds = max(0, int((fields.Datetime.now() - seen).total_seconds()))
        return {"seat": side, "away": seconds >= AWAY_AFTER, "seconds": seconds}

    def _notify(self, reason, extra=None):
        """Tell the room something changed.

        The payload carries no game data on purpose: the channel is shared by
        both players, and each of them may only ever see their own fleet. What
        travels is a nudge, and every client answers it by reading the state
        back through its own seat.
        """
        self.ensure_one()
        if not self._is_room() or not self.access_token:
            return
        payload = {"id": self.id, "reason": reason, "state": self.state}
        self.env["bus.bus"]._sendone(self._channel(), "bs_update", {**payload, **(extra or {})})

    @api.model
    def _open_room(self, values, mode="online"):
        """Create a room with a free code.

        The code is drawn optimistically: two workers can pick the same one
        between the search and the insert, and the unique index is the only real
        guarantee. The collision is caught here rather than in a player's face.
        """
        for _attempt in range(5):
            try:
                with self.env.cr.savepoint():
                    game = self.create(dict(
                        values,
                        mode=mode,
                        code=self._generate_code(),
                        access_token=uuid.uuid4().hex,
                    ))
            except pgerrors.UniqueViolation:
                continue
            game.name = _("Room %s") % game.code
            return game
        raise UserError(_("Could not get a free room code, try again."))

    @api.model
    def action_create_room(self, token, nickname=None, uid=False, mode="online"):
        """Open a room and take side A. The others join with the code."""
        # Sitting down is itself a sign of life: without it a seat taken by
        # somebody who closes the tab straight away would stay silent forever
        # without ever counting as quiet.
        game = self._open_room({
            "state": "lobby",
            "user_id": uid or self.env.uid,
            "token_a": token,
            "name_a": (nickname or "").strip()[:32] or False,
            "seen_a": fields.Datetime.now(),
        }, mode="royale" if mode == "royale" else "online")
        return game.read_state("a")

    @api.model
    def action_join_room(self, code, token, nickname=None):
        """Take the first free seat of that room (or walk back into your own).

        Which seat that is depends on the room: a duel has one to give, a
        free-for-all has three, and either way the caller does not get to pick.
        """
        code = (code or "").strip().upper()
        if not code:
            raise UserError(_("Enter a room code."))
        if not code.startswith(CODE_PREFIX):
            code = CODE_PREFIX + code
        game = self.search([("code", "=", code), ("mode", "in", ("online", "royale"))], limit=1)
        if not game:
            raise UserError(_("There is no room with code %s.") % code)
        # Two people can be typing the same code at the same time, and the seat
        # would go to whoever wrote last while the other one thought they were
        # in. The row lock is what makes taking it a decision, not a race.
        try:
            game.lock_for_update()
        except LockError:
            raise UserError(_("Somebody else is joining that room, try again."))
        game.invalidate_recordset()
        side = game._side_of(token)
        if side:
            return game.read_state(side)
        seat = game._free_seat()
        if not seat or game.state != "lobby":
            raise UserError(_("That room is not open any more."))
        values = {
            "token_%s" % seat: token,
            "name_%s" % seat: (nickname or "").strip()[:32] or False,
            "seen_%s" % seat: fields.Datetime.now(),
        }
        # A duel is full at two and starts itself. A free-for-all keeps its
        # doors open: it is whoever opened it who decides when to sail, because
        # they are the only one who knows whether anybody else is coming.
        if game.mode == "online":
            values["state"] = "setup"
        game.write(values)
        game._notify("join")
        return game.read_state(seat)

    def action_start(self, side):
        """Sail with whoever turned up; the admiralty takes the empty seats.

        Only the player who opened the room can call it, and only from the
        lobby. One human is enough — the other three boards are then played from
        here, which is also what makes a free-for-all worth opening at all when
        nobody else is around.
        """
        self.ensure_one()
        if self.mode != "royale":
            raise UserError(_("That room starts on its own."))
        if side != "a":
            raise UserError(_("Only the player who opened the room can start it."))
        if self.state != "lobby":
            raise UserError(_("The room has already sailed."))
        cpu = [seat for seat in self._seats() if not self["token_%s" % seat]]
        self.write({"state": "setup", "cpu_sides": cpu})
        for seat in cpu:
            # The admiralty places its fleets the moment it sits down: there is
            # nobody to wait for on those boards.
            self.action_random_fleet(seat)
            self.write({"ready_%s" % seat: True})
        self._notify("start")
        return self.read_state(side)

    def action_leave(self, side):
        """Give up the room.

        In a duel there is one other player and the game is theirs. In a
        free-for-all, walking out only takes that seat off the table: the others
        are in the middle of a game with each other, and it is not anybody's win
        until one of them is the last one left.
        """
        self.ensure_one()
        if not self._is_room():
            return True
        if self.state == "lobby":
            if self.mode == "royale" and side != "a":
                # Somebody who was waiting in a room that has not sailed: they
                # give the seat back and the room stays open.
                self.write({
                    "token_%s" % side: False,
                    "name_%s" % side: False,
                    "seen_%s" % side: False,
                })
                self._notify("left")
                return True
            # The room goes away with whoever opened it. Anybody sitting in it
            # is told first: the record is about to stop existing, and their
            # board would otherwise simply stop answering.
            self._notify("closed")
            self.unlink()
            return True
        if self.state == "done":
            return True
        if self.mode == "online":
            self.write({
                "state": "done",
                "winner": "b" if side == "a" else "a",
                "end_reason": "forfeit",
            })
            self._notify("left")
            return True
        self.write({"left_sides": self._json(self.left_sides) + [side]})
        self._end_if_settled(fallback=side)
        if self.state == "battle" and self.current_player == side:
            # They walked out holding the turn: it has to go somewhere.
            self._pass_turn(side)
        self._notify("left")
        return True

    def action_rematch(self, side):
        """Play again with the same opponent, in a brand new room.

        The finished game is left alone — it is what the win/loss tally counts —
        so the rematch is a fresh record that inherits the seats. Both players
        may click at once, hence `rematch_id`: the second click follows the link
        instead of opening a third room.
        """
        self.ensure_one()
        if not self._is_room() or self.state != "done":
            raise UserError(_("That game is still running."))
        if not self.rematch_id:
            # Both players may click at once; only one of them opens the room.
            try:
                self.lock_for_update()
            except LockError:
                raise UserError(_("Your opponent is opening the rematch, try again."))
            self.invalidate_recordset(["rematch_id"])
        if not self.rematch_id:
            now = fields.Datetime.now()
            values = {
                "state": "setup",
                "user_id": self.user_id.id,
                # Whoever the admiralty was playing for, it plays for again:
                # a rematch is the same table, not a new negotiation.
                "cpu_sides": self._json(self.cpu_sides),
            }
            for seat in self._seats():
                values["token_%s" % seat] = self["token_%s" % seat]
                values["name_%s" % seat] = self["name_%s" % seat]
                # Every seat is inherited, so every seat starts the new room as
                # present: nobody has been asked to prove anything yet, and
                # their beat will speak for them soon enough.
                values["seen_%s" % seat] = now
            self.rematch_id = self._open_room(values, mode=self.mode)
            for seat in self._json(self.cpu_sides):
                self.rematch_id.action_random_fleet(seat)
                self.rematch_id.write({"ready_%s" % seat: True})
            # The other tab is still listening on the old channel: that is the
            # only place it can learn where the rematch lives.
            self._notify("rematch", {"next_id": self.rematch_id.id})
        return self.rematch_id.read_state(side)

    # ------------------------------------------------------------------
    # placement
    # ------------------------------------------------------------------
    def action_place_ship(self, side, index, cell, direction):
        self.ensure_one()
        if self.state != "setup":
            raise UserError(_("Fleets are locked."))
        if self._is_room() and self["ready_%s" % side]:
            raise UserError(_("Your fleet is locked in."))
        fleet = self._fleet(side)
        ship = fleet[index]
        cells = self._cells_for(cell, ship["size"], direction)
        if not cells or self._occupied(fleet, index) & set(cells):
            raise UserError(_("The %s does not fit there.") % ship["name"])
        ship["cells"] = cells
        self._write_fleet(side, fleet)
        return self.read_state(side)

    def action_random_fleet(self, side):
        self.ensure_one()
        if self._is_room() and self["ready_%s" % side]:
            raise UserError(_("Your fleet is locked in."))
        fleet = self._new_fleet()
        for index, ship in enumerate(fleet):
            while True:
                direction = random.choice("hv")
                cells = self._cells_for(random.randrange(SIZE * SIZE), ship["size"], direction)
                if cells and not self._occupied(fleet, index) & set(cells):
                    ship["cells"] = cells
                    break
        self._write_fleet(side, fleet)
        return self.read_state(side)

    def action_ready(self, side=None):
        """Lock a fleet in.

        Hot-seat and CPU games place one fleet at a time, so the side being
        locked is `setup_for`. In a room every player places at once behind
        their own screen, and the battle only starts once the last of them is
        done — two of them in a duel, up to four in a free-for-all, and the
        admiralty's seats were ready before anybody sat down.
        """
        self.ensure_one()
        if self.state != "setup":
            raise UserError(_("Fleets are locked."))
        side = side if self._is_room() else self.setup_for
        if any(not ship["cells"] for ship in self._fleet(side)):
            raise UserError(_("Place every ship first."))
        if self._is_room():
            self.write({"ready_%s" % side: True})
            # Somebody who walked out during the placing is not being waited
            # for: their seat is already off the table, and a fleet that will
            # never be locked in would otherwise hold up everybody else.
            if all(self["ready_%s" % seat] or self._is_out(seat) for seat in self._seats()):
                self.write({"state": "battle"})
                self._set_turn(self._first_player())
                # Side A may be one of the admiralty's own in a room that was
                # started by somebody who then left the lobby.
                self._cpu_turns()
            self._notify("ready")
            return self.read_state(side)
        if self.setup_for == "a":
            if self.mode == "cpu":
                self.action_random_fleet("b")
            else:
                self.setup_for = "b"
                return self.read_state(side)
        self.write({"state": "battle"})
        self._set_turn("a")
        return self.read_state(side)

    # ------------------------------------------------------------------
    # battle
    # ------------------------------------------------------------------
    def _resolve(self, shooter, target, cell):
        """One shell, on somebody's water.

        `shots_<target>` is every cell that board has taken, from anybody: two
        players cannot fire at the same square in a free-for-all, because the
        second one would be firing into a hole that is already there. It is the
        same list a duel keeps, which is why the rule needed no new code.
        """
        shots = self._shots(target)
        if cell in shots:
            raise UserError(_("That cell was already fired at."))
        shots.append(cell)
        fleet = self._fleet(target)
        result, ship_name = "miss", False
        for ship in fleet:
            if cell in ship["cells"]:
                ship["hits"] += 1
                ship["sunk"] = ship["hits"] >= ship["size"]
                result = "sunk" if ship["sunk"] else "hit"
                ship_name = ship["name"]
                break
        self.write({"shots_%s" % target: shots})
        self._write_fleet(target, fleet)
        self.env["battleship.shot"].create({
            "game_id": self.id,
            "shooter": shooter,
            "target": target,
            "cell": cell,
            "result": result,
            "ship_name": ship_name or False,
        })
        self._end_if_settled()
        return result

    def _end_if_settled(self, reason="fleet", fallback=None):
        """Close the game once there is nobody left to fight.

        Last one afloat takes it. `fallback` covers the one case where nobody
        is left at all — the last player walking away from a table they had
        already cleared — so the game still has a name on it.
        """
        self.ensure_one()
        if self.state == "done":
            return False
        alive = self._alive_sides()
        if len(alive) > 1:
            return False
        self.write({
            "state": "done",
            "winner": alive[0] if alive else fallback,
            "end_reason": reason,
        })
        return True

    def _pass_turn(self, after):
        """Hand the turn to the next player still afloat, then let the CPU play.

        Everybody who is out is skipped, so a free-for-all quietly turns into a
        duel and then into a winner without the rotation ever being rewritten.
        """
        self.ensure_one()
        nxt = self._next_player(after)
        if not nxt:
            return
        self._set_turn(nxt)
        self._cpu_turns()

    def _advance_turn(self, shooter, target, result):
        """Book a resolved shell against the shooter's sweep.

        A hit buys another shell on the same board, so a target is only crossed
        off the sweep when the shell misses — or when the board goes down, since
        one that is out cannot be fired at again. The turn moves on once there
        is nothing left to sweep, which in a duel is the first miss and in a
        free-for-all is a miss on each of the other boards.

        Nothing here plays a CPU seat: the caller does that once its own shell
        is booked, so the admiralty never fires from inside another seat's call.
        """
        self.ensure_one()
        if self.state == "done":
            return
        if result == "miss" or self._is_out(target):
            self.turn_cleared = self._json(self.turn_cleared) + [target]
        if self._pending_targets(shooter):
            return
        nxt = self._next_player(shooter)
        if nxt:
            self._set_turn(nxt)

    def action_fire(self, cell, side=None, target=None):
        """Player shot. Seats the admiralty holds answer within the same call.

        `side` is who is firing, and it is only ever filled in by the room
        routes, which read it from the caller's seat and not from the request:
        the turn is the one rule a remote player would most like to break.

        `target` is whose water the shell lands in. A duel has only one answer
        and works it out itself; a free-for-all lets the player choose the order
        the sweep is fired in, so there the client says which board was clicked
        and the server checks it is one this turn still owes a shell to.

        One call is one shell, not one turn: a free-for-all turn is a sweep of
        the whole table and takes at least one call per rival to play out. What
        it takes to end it lives in `_advance_turn`.
        """
        self.ensure_one()
        if self.state != "battle":
            raise UserError(_("The battle is not running."))
        shooter = self.current_player
        if self.mode == "cpu" and shooter != "a":
            raise UserError(_("It is not your turn."))
        if self._is_room() and side != shooter:
            raise UserError(_("It is not your turn."))
        target = self._firing_at(shooter, target)
        self._advance_turn(shooter, target, self._resolve(shooter, target, cell))
        # Whoever the turn landed on, if anybody: a no-op unless it is a CPU.
        self._cpu_turns()
        self._notify("fire")
        return self.read_state(side)

    def _firing_at(self, shooter, target):
        """Whose board a shot is allowed to land on.

        A board already swept this turn is as closed as a board that is out: a
        second shell at it would be one the sweep never granted, and it would
        come out of somebody else's share of the turn.
        """
        self.ensure_one()
        if self.mode != "royale":
            return "b" if shooter == "a" else "a"
        if target == shooter:
            raise UserError(_("You cannot fire at your own fleet."))
        if target not in self._pending_targets(shooter):
            if target in self._alive_sides():
                raise UserError(_("You already fired at that fleet this turn."))
            raise UserError(_("That fleet is out of the game."))
        return target

    # ------------------------------------------------------------------
    # the admiralty
    # ------------------------------------------------------------------
    def _cpu_queue(self, target):
        """Cells next to a hit that has not sunk yet, on that board."""
        shots = set(self._shots(target))
        queue = []
        for ship in self._fleet(target):
            if ship["sunk"]:
                continue
            for cell in ship["cells"]:
                if cell not in shots:
                    continue
                col, row = cell % SIZE, cell // SIZE
                for nxt, ok in (
                    (cell - 1, col > 0), (cell + 1, col < SIZE - 1),
                    (cell - SIZE, row > 0), (cell + SIZE, row < SIZE - 1),
                ):
                    if ok and nxt not in shots:
                        queue.append(nxt)
        return queue

    def _cpu_hunt(self, target):
        """The parity search: every other square, which no ship can hide between."""
        shots = set(self._shots(target))
        free = [c for c in range(SIZE * SIZE) if c not in shots]
        return [c for c in free if (c % SIZE + c // SIZE) % 2 == 0] or free

    def _cpu_shot(self, shooter):
        """A board and a cell for a seat the admiralty is playing.

        It only ever picks from what the turn still owes a shell to, so it walks
        the same sweep a player does. Which board it opens first is still its
        own call, and a board it has already wounded goes first — the same
        hunt-and-target the CPU has always played, one grid at a time.
        """
        self.ensure_one()
        targets = self._pending_targets(shooter)
        if not targets:
            return None, None
        wounded = [side for side in targets if self._cpu_queue(side)]
        target = random.choice(wounded or targets)
        cells = self._cpu_queue(target) or self._cpu_hunt(target)
        return (target, random.choice(cells)) if cells else (None, None)

    def _cpu_turns(self):
        """Play every seat the admiralty holds, until a human is up again.

        One loop over shells rather than over turns: `_advance_turn` is what
        knows when a sweep is finished and the gun moves, so the same rules the
        players are held to are the ones the admiralty plays by. The guard is
        not a rule, it is a promise that a worker cannot be wedged by one: no
        game has more shells in it than there are cells on the table.
        """
        self.ensure_one()
        for _shell in range(len(self._seats()) * SIZE * SIZE):
            if self.state != "battle" or not self._is_cpu(self.current_player):
                return
            shooter = self.current_player
            target, cell = self._cpu_shot(shooter)
            if target is None:
                # Nothing left to shoot at: the game is over, or about to be.
                nxt = self._next_player(shooter)
                if self._end_if_settled() or not nxt:
                    return
                self._set_turn(nxt)
                continue
            self._advance_turn(shooter, target, self._resolve(shooter, target, cell))

    # ------------------------------------------------------------------
    # client payload
    # ------------------------------------------------------------------
    def read_state(self, viewer=None):
        """Everything the OWL board needs — enemy ships are never leaked.

        `viewer` is the seat the payload is built for, and it only means
        something online, where the two players read the same record from two
        browsers: each of them gets their own fleet and an empty grid where the
        other one's ships are.
        """
        self.ensure_one()
        seats = self._seats()
        reveal = {side: self.state == "done" for side in seats}
        if self._is_room():
            # Everybody reads the same record from their own browser, so each of
            # them gets their own fleet and empty water where the others are.
            if viewer in seats:
                reveal[viewer] = True
        elif self.mode == "cpu":
            reveal["a"] = True
        else:
            # Hot-seat: whoever is at the screen right now, and nobody else.
            here = self.current_player if self.state == "battle" else self.setup_for
            reveal[here] = True

        def fleet_payload(fleet, reveal):
            return [
                {
                    "name": ship["name"] if reveal or ship["sunk"] else "Ship %s" % ship["size"],
                    "size": ship["size"],
                    "hits": ship["hits"],
                    "sunk": ship["sunk"],
                    "cells": ship["cells"] if (reveal or ship["sunk"]) else [],
                }
                for ship in fleet
            ]

        state = {
            "id": self.id,
            "mode": self.mode,
            "state": self.state,
            "setup_for": self.setup_for,
            "current_player": self.current_player,
            # The boards the seat on the gun still owes a shell to this turn.
            # The client fires at nothing else, and counts the sweep down with
            # it; everybody reads the same list, whether it is their turn or not.
            "turn_pending": (
                self._pending_targets(self.current_player) if self.state == "battle" else []
            ),
            "winner": self.winner,
            "end_reason": self.end_reason,
            # Rooms only. `channel` carries the room secret, which every player
            # in it legitimately holds: it is how they subscribe to the bus.
            "you": viewer,
            "code": self.code,
            "invite_url": self._invite_url() if self._is_room() else False,
            "channel": self._channel() if self._is_room() else False,
            # The table itself: who is at each board, and what has become of
            # them. The client draws one panel per entry and nothing else has to
            # know how many players a mode has.
            "seats": [
                {
                    "side": side,
                    "name": self["name_%s" % side] or self._seat_name(side),
                    "cpu": self._is_cpu(side),
                    "taken": bool(self["token_%s" % side]) or self._is_cpu(side),
                    "ready": self["ready_%s" % side],
                    "out": self._is_out(side),
                }
                for side in seats
            ],
            "ready": {side: self["ready_%s" % side] for side in seats},
            "players": {side: self["name_%s" % side] or self._seat_name(side) for side in seats},
            "joined": bool(self.token_b),
            # Which of the other seats have stopped answering, so a board that
            # is read back after a bus nudge says so without waiting for a beat.
            "away": [
                self._presence_of(side) for side in seats
                if side != viewer and self["token_%s" % side]
            ] if self._is_room() and viewer else [],
            "next_id": self.rematch_id.id,
            "log": [
                {
                    "shooter": s.shooter,
                    "target": s.target or ("b" if s.shooter == "a" else "a"),
                    "coord": s.coord,
                    "result": s.result,
                    "ship_name": s.ship_name,
                }
                for s in self.shot_ids.sorted("id", reverse=True)[:20]
            ],
            "record": self.env["battleship.game"].read_record(
                self["token_%s" % viewer]
                if self._is_room() and viewer in seats
                else self.session_token
            ),
        }
        for side in seats:
            state["fleet_%s" % side] = fleet_payload(self._fleet(side), reveal[side])
            state["shots_%s" % side] = self._shots(side)
        return state

    def _seat_name(self, side):
        """What to call a seat nobody has named."""
        self.ensure_one()
        if self._is_cpu(side):
            return _("Admiralty %s") % side.upper()
        return _("Player %s") % (self._seats().index(side) + 1)

    @api.model
    def read_record(self, session_token=None):
        """Tally of whoever owns the game: a user, or a browser.

        Local games are always played from side A, so winning is `winner == a`.
        Online, the same browser sits on either side depending on whether it
        opened the room or joined it, so its games count from its own seat.

        Games played and time at the board count the same records the win/loss
        tally does — finished ones — so the four numbers always add up on
        screen: a game still running is not a game played yet.
        """
        owner = (
            [("session_token", "=", session_token)]
            if session_token
            else [("user_id", "=", self.env.uid), ("session_token", "=", False)]
        )
        rooms = ("online", "royale")
        games = self.search(owner + [("mode", "not in", rooms), ("state", "=", "done")])
        wins = len(games.filtered(lambda g: g.winner == "a"))
        losses = len(games) - wins
        if session_token:
            # A room seats the same browser wherever there was space, so its
            # games count from whichever seat it took — including the two the
            # free-for-all added.
            played = self.search([
                ("mode", "in", rooms), ("state", "=", "done"),
                "|", "|", "|",
                ("token_a", "=", session_token), ("token_b", "=", session_token),
                ("token_c", "=", session_token), ("token_d", "=", session_token),
            ])
            for game in played:
                if game.winner == game._side_of(session_token):
                    wins += 1
                else:
                    losses += 1
            games |= played
        return {
            "wins": wins,
            "losses": losses,
            "games": len(games),
            "seconds": round(sum(games.mapped("duration")) * 3600),
        }

    @api.model
    def action_new_game(self, mode="cpu", session_token=None):
        if mode in ("online", "royale"):
            # Those need a code and a seat: `action_create_room` is the door.
            raise UserError(_("Open a room to play with other people."))
        game = self.create({
            "mode": mode,
            "name": _("Game %s") % fields.Datetime.now(),
            "session_token": session_token or False,
        })
        return game.read_state()

    def action_open_board(self):
        self.ensure_one()
        return {
            "type": "ir.actions.client",
            "tag": "battleship_3d.board",
            "name": self.name,
            "params": {"game_id": self.id},
        }
