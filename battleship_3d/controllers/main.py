import uuid

from odoo import http
from odoo.exceptions import UserError
from odoo.http import request
from odoo.tools.translate import _

MODES = ("cpu", "hotseat")
SIDES = ("a", "b")
DIRECTIONS = ("h", "v")
SIZE = 10
FLEET_SIZE = 5


class BattleshipController(http.Controller):
    """Server side of the board, shared by the backend action and /battleship.

    A visitor with no account has no rights whatsoever on ``battleship.game``,
    so their games run in ``sudo()`` and are tied to a token kept in their
    session: the public user is the same record for everybody, and the token is
    the only thing that tells two anonymous players apart. Logged in users keep
    playing under their own rights, and their games carry no token.
    """

    # ------------------------------------------------------------------ #
    # Helpers                                                             #
    # ------------------------------------------------------------------ #

    def _is_public(self):
        return request.env.user._is_public()

    def _token(self):
        """Stable per-browser token of a player (created on first use).

        Anonymous players are told apart by nothing else. Logged in ones get
        one too, because an online room seats two browsers and its seats are
        held by tokens rather than by users.
        """
        token = request.session.get("battleship_token")
        if not token:
            token = uuid.uuid4().hex
            request.session["battleship_token"] = token
        return token

    def _games(self):
        """The model in the privilege scope of the caller."""
        Game = request.env["battleship.game"]
        return Game.sudo() if self._is_public() else Game

    def _game(self, game_id):
        """The requested game, provided the caller is allowed to play it.

        For an anonymous player that means the game carries their token; the id
        alone is never enough, otherwise one visitor could fire on another
        one's board. An online room is owned by neither browser in particular:
        what authorises the call there is holding one of its two seats, so it
        is looked up first and always in ``sudo()`` — the guest has no rights
        on a record somebody else created.
        """
        game_id = self._as_int(game_id, 0, 2 ** 31)
        room = request.env["battleship.game"].sudo().search([
            ("id", "=", game_id),
            ("mode", "=", "online"),
            "|", ("token_a", "=", self._token()), ("token_b", "=", self._token()),
        ], limit=1)
        if room:
            return room
        domain = [("id", "=", game_id), ("mode", "!=", "online")]
        if self._is_public():
            domain.append(("session_token", "=", self._token()))
        game = self._games().search(domain, limit=1)
        if not game:
            raise UserError(_("That game is not available."))
        return game

    def _side(self, game):
        """Which seat the caller holds, for an online game. None otherwise."""
        return game._side_of(self._token()) if game.mode == "online" else None

    def _as_int(self, value, low, high):
        try:
            value = int(value)
        except (TypeError, ValueError):
            raise UserError(_("Invalid value."))
        if not low <= value <= high:
            raise UserError(_("Invalid value."))
        return value

    def _as_choice(self, value, choices):
        if value not in choices:
            raise UserError(_("Invalid value."))
        return value

    # ------------------------------------------------------------------ #
    # Public page                                                         #
    # ------------------------------------------------------------------ #

    # `website=True` marks the route as frontend, which is what puts `website`
    # in the render context; `web.frontend_layout` inherits `website.layout`
    # once the website module is installed and fails without it.
    @http.route("/battleship", type="http", auth="public", website=True, sitemap=True)
    def battleship_page(self, **kwargs):
        # Make sure the session (and its token) exists before the first game is
        # created, so the game can be bound to this browser.
        if self._is_public():
            self._token()
        return request.render("battleship_3d.page", {})

    # ------------------------------------------------------------------ #
    # Board                                                               #
    # ------------------------------------------------------------------ #

    @http.route("/battleship/new", type="jsonrpc", auth="public")
    def new_game(self, mode="cpu", **kwargs):
        token = self._token() if self._is_public() else None
        return self._games().action_new_game(self._as_choice(mode, MODES), token)

    @http.route("/battleship/state", type="jsonrpc", auth="public")
    def state(self, game_id=None, **kwargs):
        game = self._game(game_id)
        return game.read_state(self._side(game))

    @http.route("/battleship/place", type="jsonrpc", auth="public")
    def place_ship(self, game_id=None, side=None, index=None, cell=None, direction=None, **kwargs):
        game = self._game(game_id)
        return game.action_place_ship(
            self._side(game) or self._as_choice(side, SIDES),
            self._as_int(index, 0, FLEET_SIZE - 1),
            self._as_int(cell, 0, SIZE * SIZE - 1),
            self._as_choice(direction, DIRECTIONS),
        )

    @http.route("/battleship/random", type="jsonrpc", auth="public")
    def random_fleet(self, game_id=None, side=None, **kwargs):
        game = self._game(game_id)
        return game.action_random_fleet(self._side(game) or self._as_choice(side, SIDES))

    @http.route("/battleship/ready", type="jsonrpc", auth="public")
    def ready(self, game_id=None, **kwargs):
        game = self._game(game_id)
        return game.action_ready(self._side(game))

    @http.route("/battleship/fire", type="jsonrpc", auth="public")
    def fire(self, game_id=None, cell=None, **kwargs):
        game = self._game(game_id)
        return game.action_fire(self._as_int(cell, 0, SIZE * SIZE - 1), self._side(game))

    # ------------------------------------------------------------------ #
    # Online rooms                                                        #
    # ------------------------------------------------------------------ #

    # The seat a player holds is their browser token, which never leaves the
    # server: the client sends no identity at all, so there is nothing it could
    # forge to sit down at somebody else's side of the board.

    @http.route("/battleship/room/create", type="jsonrpc", auth="public")
    def create_room(self, nickname=None, **kwargs):
        uid = False if self._is_public() else request.env.uid
        return request.env["battleship.game"].sudo().action_create_room(
            self._token(), nickname, uid
        )

    @http.route("/battleship/room/join", type="jsonrpc", auth="public")
    def join_room(self, code=None, nickname=None, **kwargs):
        return request.env["battleship.game"].sudo().action_join_room(
            code, self._token(), nickname
        )

    @http.route("/battleship/room/leave", type="jsonrpc", auth="public")
    def leave_room(self, game_id=None, **kwargs):
        game = self._game(game_id)
        return game.action_leave(self._side(game))

    @http.route("/battleship/room/rematch", type="jsonrpc", auth="public")
    def rematch(self, game_id=None, **kwargs):
        game = self._game(game_id)
        return game.action_rematch(self._side(game))
