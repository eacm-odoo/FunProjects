import json
import logging

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)

DIFFICULTIES = ("facil", "normal", "dificil", "experto")


class PingPongController(http.Controller):

    @http.route("/pingpong", type="http", auth="public", website=True, sitemap=True)
    def pingpong_game(self, **kwargs):
        """Render the full-screen game page."""
        return request.render("pingpong_3d.game_page", {})

    @http.route(
        "/pingpong/score",
        type="http",
        auth="public",
        methods=["POST"],
        csrf=False,
        save_session=False,
    )
    def pingpong_score(self, **kwargs):
        """Store the result of a finished match.

        The browser posts a plain JSON body, so the payload is read from the raw
        request instead of relying on Odoo's JSON-RPC envelope.
        """
        try:
            payload = json.loads(request.httprequest.get_data() or b"{}")
        except ValueError:
            return request.make_json_response({"ok": False, "error": "bad_payload"}, status=400)

        difficulty = payload.get("difficulty")
        if difficulty not in DIFFICULTIES:
            return request.make_json_response({"ok": False, "error": "bad_difficulty"}, status=400)

        def as_int(key, maximum):
            try:
                return max(0, min(maximum, int(payload.get(key) or 0)))
            except (TypeError, ValueError):
                return 0

        values = {
            "difficulty": difficulty,
            "player_score": as_int("player_score", 99),
            "machine_score": as_int("machine_score", 99),
            "hits": as_int("hits", 9999),
            "rallies": as_int("rallies", 999),
        }
        user = request.env.user
        if user and not user._is_public():
            values["partner_id"] = user.partner_id.id

        match = request.env["pingpong.match"].sudo().create(values)
        return request.make_json_response({"ok": True, "id": match.id, "won": match.won})
