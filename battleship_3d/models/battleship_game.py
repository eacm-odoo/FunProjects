import random

from odoo import api, fields, models
from odoo.exceptions import UserError
from odoo.tools.translate import _

SIZE = 10
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
        [("cpu", "vs CPU"), ("hotseat", "2 players (hot-seat)")],
        default="cpu", required=True,
    )
    state = fields.Selection(
        [("setup", "Placing fleets"), ("battle", "Battle"), ("done", "Finished")],
        default="setup", required=True,
    )
    setup_for = fields.Selection([("a", "Side A"), ("b", "Side B")], default="a")
    current_player = fields.Selection([("a", "Side A"), ("b", "Side B")], default="a")
    winner = fields.Selection([("a", "Side A"), ("b", "Side B")])
    # [{"name": str, "size": int, "cells": [int], "hits": int, "sunk": bool}]
    fleet_a = fields.Json(default=lambda self: self._new_fleet())
    fleet_b = fields.Json(default=lambda self: self._new_fleet())
    shots_a = fields.Json(default=list)  # cells fired AT side A
    shots_b = fields.Json(default=list)
    shot_ids = fields.One2many("battleship.shot", "game_id", string="Shot log")
    shot_count = fields.Integer(compute="_compute_shot_count")

    @api.depends("shot_ids")
    def _compute_shot_count(self):
        for game in self:
            game.shot_count = len(game.shot_ids)

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
    # placement
    # ------------------------------------------------------------------
    def action_place_ship(self, side, index, cell, direction):
        self.ensure_one()
        if self.state != "setup":
            raise UserError(_("Fleets are locked."))
        fleet = self._fleet(side)
        ship = fleet[index]
        cells = self._cells_for(cell, ship["size"], direction)
        if not cells or self._occupied(fleet, index) & set(cells):
            raise UserError(_("The %s does not fit there.") % ship["name"])
        ship["cells"] = cells
        self._write_fleet(side, fleet)
        return self.read_state()

    def action_random_fleet(self, side):
        self.ensure_one()
        fleet = self._new_fleet()
        for index, ship in enumerate(fleet):
            while True:
                direction = random.choice("hv")
                cells = self._cells_for(random.randrange(SIZE * SIZE), ship["size"], direction)
                if cells and not self._occupied(fleet, index) & set(cells):
                    ship["cells"] = cells
                    break
        self._write_fleet(side, fleet)
        return self.read_state()

    def action_ready(self):
        """Lock the fleet currently being placed; start the battle when both are set."""
        self.ensure_one()
        if any(not ship["cells"] for ship in self._fleet(self.setup_for)):
            raise UserError(_("Place every ship first."))
        if self.setup_for == "a":
            if self.mode == "cpu":
                self.action_random_fleet("b")
            else:
                self.setup_for = "b"
                return self.read_state()
        self.write({"state": "battle", "current_player": "a"})
        return self.read_state()

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
            self.write({"state": "done", "winner": shooter})
        return result

    def action_fire(self, cell):
        """Player shot. In CPU mode the CPU answers within the same call."""
        self.ensure_one()
        if self.state != "battle":
            raise UserError(_("The battle is not running."))
        shooter = self.current_player
        if self.mode == "cpu" and shooter != "a":
            raise UserError(_("It is not your turn."))
        result = self._resolve(shooter, cell)
        if self.state == "done":
            return self.read_state()
        if result == "miss":
            self.current_player = "b" if shooter == "a" else "a"
            if self.mode == "cpu" and self.current_player == "b":
                self._cpu_play()
        return self.read_state()

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
    def read_state(self):
        """Everything the OWL board needs — enemy ships are never leaked."""
        self.ensure_one()
        reveal_a = self.state == "done" or self.mode == "cpu" or self.setup_for == "a"
        reveal_b = self.state == "done" or (self.mode == "hotseat" and self.setup_for == "b")
        if self.state == "battle" and self.mode == "hotseat":
            reveal_a = self.current_player == "a"
            reveal_b = self.current_player == "b"

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
            "record": self.env["battleship.game"].read_record(self.session_token),
        }

    @api.model
    def read_record(self, session_token=None):
        """Win/loss tally of whoever owns the game: a user, or a browser."""
        owner = (
            [("session_token", "=", session_token)]
            if session_token
            else [("user_id", "=", self.env.uid), ("session_token", "=", False)]
        )
        games = self.search(owner + [("state", "=", "done")])
        return {
            "wins": len(games.filtered(lambda g: g.winner == "a")),
            "losses": len(games.filtered(lambda g: g.winner == "b")),
        }

    @api.model
    def action_new_game(self, mode="cpu", session_token=None):
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
