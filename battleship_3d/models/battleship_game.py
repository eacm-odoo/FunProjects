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
    setup_for = fields.Selection([("a", "Side A"), ("b", "Side B")], default="a")
    current_player = fields.Selection([("a", "Side A"), ("b", "Side B")], default="a")
    winner = fields.Selection([("a", "Side A"), ("b", "Side B")])
    end_reason = fields.Selection(
        [("fleet", "Fleet destroyed"), ("forfeit", "Opponent left")]
    )
    # [{"name": str, "size": int, "cells": [int], "hits": int, "sunk": bool}]
    fleet_a = fields.Json(default=lambda self: self._new_fleet())
    fleet_b = fields.Json(default=lambda self: self._new_fleet())
    shots_a = fields.Json(default=list)  # cells fired AT side A
    shots_b = fields.Json(default=list)
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
    name_a = fields.Char()
    name_b = fields.Char()
    ready_a = fields.Boolean(help="Side A locked its fleet in.")
    ready_b = fields.Boolean()
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

    def _fleet(self, side):
        return list(self._json(self.fleet_a if side == "a" else self.fleet_b))

    def _write_fleet(self, side, fleet):
        self.write({"fleet_a" if side == "a" else "fleet_b": fleet})

    def _shots(self, side):
        return list(self._json(self.shots_a if side == "a" else self.shots_b))

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
        if token and token == self.token_a:
            return "a"
        if token and token == self.token_b:
            return "b"
        return None

    def _notify(self, reason, extra=None):
        """Tell the room something changed.

        The payload carries no game data on purpose: the channel is shared by
        both players, and each of them may only ever see their own fleet. What
        travels is a nudge, and every client answers it by reading the state
        back through its own seat.
        """
        self.ensure_one()
        if self.mode != "online" or not self.access_token:
            return
        payload = {"id": self.id, "reason": reason, "state": self.state}
        self.env["bus.bus"]._sendone(self._channel(), "bs_update", {**payload, **(extra or {})})

    @api.model
    def _open_room(self, values):
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
                        mode="online",
                        code=self._generate_code(),
                        access_token=uuid.uuid4().hex,
                    ))
            except pgerrors.UniqueViolation:
                continue
            game.name = _("Room %s") % game.code
            return game
        raise UserError(_("Could not get a free room code, try again."))

    @api.model
    def action_create_room(self, token, nickname=None, uid=False):
        """Open a room and take side A. The opponent joins with the code."""
        game = self._open_room({
            "state": "lobby",
            "user_id": uid or self.env.uid,
            "token_a": token,
            "name_a": (nickname or "").strip()[:32] or False,
        })
        return game.read_state("a")

    @api.model
    def action_join_room(self, code, token, nickname=None):
        """Take side B of the room with that code (or walk back into your own)."""
        code = (code or "").strip().upper()
        if not code:
            raise UserError(_("Enter a room code."))
        if not code.startswith(CODE_PREFIX):
            code = CODE_PREFIX + code
        game = self.search([("code", "=", code), ("mode", "=", "online")], limit=1)
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
        if game.token_b or game.state != "lobby":
            raise UserError(_("That room is not open any more."))
        game.write({
            "token_b": token,
            "name_b": (nickname or "").strip()[:32] or False,
            "state": "setup",
        })
        game._notify("join")
        return game.read_state("b")

    def action_leave(self, side):
        """Give up the room. An abandoned battle is a win for whoever stayed."""
        self.ensure_one()
        if self.mode != "online":
            return True
        if self.state == "lobby":
            # Nobody else is in yet, so the room can just go away.
            self.unlink()
            return True
        if self.state != "done":
            self.write({
                "state": "done",
                "winner": "b" if side == "a" else "a",
                "end_reason": "forfeit",
            })
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
        if self.mode != "online" or self.state != "done":
            raise UserError(_("That game is still running."))
        if not self.rematch_id:
            # Both players may click at once; only one of them opens the room.
            try:
                self.lock_for_update()
            except LockError:
                raise UserError(_("Your opponent is opening the rematch, try again."))
            self.invalidate_recordset(["rematch_id"])
        if not self.rematch_id:
            self.rematch_id = self._open_room({
                "state": "setup",
                "user_id": self.user_id.id,
                "token_a": self.token_a,
                "token_b": self.token_b,
                "name_a": self.name_a,
                "name_b": self.name_b,
            })
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
        if self.mode == "online" and (self.ready_a if side == "a" else self.ready_b):
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
        if self.mode == "online" and (self.ready_a if side == "a" else self.ready_b):
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
        locked is `setup_for`. Online, both players place at once behind their
        own screen and the battle only starts once the second one is done.
        """
        self.ensure_one()
        if self.state != "setup":
            raise UserError(_("Fleets are locked."))
        side = side if self.mode == "online" else self.setup_for
        if any(not ship["cells"] for ship in self._fleet(side)):
            raise UserError(_("Place every ship first."))
        if self.mode == "online":
            self.write({("ready_a" if side == "a" else "ready_b"): True})
            if self.ready_a and self.ready_b:
                self.write({"state": "battle", "current_player": "a"})
            self._notify("ready")
            return self.read_state(side)
        if self.setup_for == "a":
            if self.mode == "cpu":
                self.action_random_fleet("b")
            else:
                self.setup_for = "b"
                return self.read_state(side)
        self.write({"state": "battle", "current_player": "a"})
        return self.read_state(side)

    # ------------------------------------------------------------------
    # battle
    # ------------------------------------------------------------------
    def _resolve(self, shooter, cell):
        target = "b" if shooter == "a" else "a"
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
        self.write({("shots_a" if target == "a" else "shots_b"): shots})
        self._write_fleet(target, fleet)
        self.env["battleship.shot"].create({
            "game_id": self.id,
            "shooter": shooter,
            "cell": cell,
            "result": result,
            "ship_name": ship_name or False,
        })
        if all(ship["sunk"] for ship in fleet):
            self.write({"state": "done", "winner": shooter, "end_reason": "fleet"})
        return result

    def action_fire(self, cell, side=None):
        """Player shot. In CPU mode the CPU answers within the same call.

        `side` is who is firing, and it is only ever filled in by the online
        routes, which read it from the caller's seat and not from the request:
        the turn is the one rule a remote player would most like to break.
        """
        self.ensure_one()
        if self.state != "battle":
            raise UserError(_("The battle is not running."))
        shooter = self.current_player
        if self.mode == "cpu" and shooter != "a":
            raise UserError(_("It is not your turn."))
        if self.mode == "online" and side != shooter:
            raise UserError(_("It is not your turn."))
        result = self._resolve(shooter, cell)
        if self.state != "done" and result == "miss":
            self.current_player = "b" if shooter == "a" else "a"
            if self.mode == "cpu" and self.current_player == "b":
                self._cpu_play()
        self._notify("fire")
        return self.read_state(side)

    def _cpu_targets(self):
        """Neighbours of unsunk hits (target mode), else parity search (hunt mode)."""
        shots = set(self._shots("a"))
        fleet = self._fleet("a")
        wounded = [
            cell
            for ship in fleet
            if not ship["sunk"]
            for cell in ship["cells"]
            if cell in shots
        ]
        queue = []
        for cell in wounded:
            col, row = cell % SIZE, cell // SIZE
            for nxt, ok in (
                (cell - 1, col > 0), (cell + 1, col < SIZE - 1),
                (cell - SIZE, row > 0), (cell + SIZE, row < SIZE - 1),
            ):
                if ok and nxt not in shots:
                    queue.append(nxt)
        if queue:
            return queue
        return [
            c for c in range(SIZE * SIZE)
            if c not in shots and (c % SIZE + c // SIZE) % 2 == 0
        ] or [c for c in range(SIZE * SIZE) if c not in shots]

    def _cpu_play(self):
        """CPU keeps firing while it hits, exactly like a human turn."""
        while self.state == "battle" and self.current_player == "b":
            cell = random.choice(self._cpu_targets())
            if self._resolve("b", cell) == "miss":
                self.current_player = "a"

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
        reveal_a = self.state == "done" or self.mode == "cpu" or self.setup_for == "a"
        reveal_b = self.state == "done" or (self.mode == "hotseat" and self.setup_for == "b")
        if self.state == "battle" and self.mode == "hotseat":
            reveal_a = self.current_player == "a"
            reveal_b = self.current_player == "b"
        if self.mode == "online":
            reveal_a = self.state == "done" or viewer == "a"
            reveal_b = self.state == "done" or viewer == "b"

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

        return {
            "id": self.id,
            "mode": self.mode,
            "state": self.state,
            "setup_for": self.setup_for,
            "current_player": self.current_player,
            "winner": self.winner,
            "end_reason": self.end_reason,
            # Online only. `channel` carries the room secret, which both players
            # legitimately hold: it is how they subscribe to the bus.
            "you": viewer,
            "code": self.code,
            "invite_url": self._invite_url() if self.mode == "online" else False,
            "channel": self._channel() if self.mode == "online" else False,
            "ready": {"a": self.ready_a, "b": self.ready_b},
            "players": {
                "a": self.name_a or _("Player 1"),
                "b": self.name_b or _("Player 2"),
            },
            "joined": bool(self.token_b),
            "next_id": self.rematch_id.id,
            "fleet_a": fleet_payload(self._fleet("a"), reveal_a),
            "fleet_b": fleet_payload(self._fleet("b"), reveal_b),
            "shots_a": self._shots("a"),
            "shots_b": self._shots("b"),
            "log": [
                {
                    "shooter": s.shooter,
                    "coord": s.coord,
                    "result": s.result,
                    "ship_name": s.ship_name,
                }
                for s in self.shot_ids.sorted("id", reverse=True)[:20]
            ],
            "record": self.env["battleship.game"].read_record(
                (self.token_a if viewer == "a" else self.token_b)
                if self.mode == "online"
                else self.session_token
            ),
        }

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
        games = self.search(owner + [("mode", "!=", "online"), ("state", "=", "done")])
        wins = len(games.filtered(lambda g: g.winner == "a"))
        losses = len(games) - wins
        if session_token:
            online = self.search([
                ("mode", "=", "online"), ("state", "=", "done"),
                "|", ("token_a", "=", session_token), ("token_b", "=", session_token),
            ])
            for game in online:
                if game.winner == game._side_of(session_token):
                    wins += 1
                else:
                    losses += 1
            games |= online
        return {
            "wins": wins,
            "losses": losses,
            "games": len(games),
            "seconds": round(sum(games.mapped("duration")) * 3600),
        }

    @api.model
    def action_new_game(self, mode="cpu", session_token=None):
        if mode == "online":
            # Online needs a code and a seat: `action_create_room` is the door.
            raise UserError(_("Open a room to play online."))
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
