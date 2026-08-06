import json
import logging

from odoo import http
from odoo.exceptions import UserError
from odoo.http import request

_logger = logging.getLogger(__name__)

DIFFICULTIES = ("facil", "normal", "dificil", "experto")
NICKNAME_MAX = 24


class PingPongController(http.Controller):

    @http.route("/pingpong", type="http", auth="public", website=True, sitemap=True)
    def pingpong_game(self, **kwargs):
        """Render the full-screen game page.

        Client configuration travels as ``data-*`` attributes on the mount
        element rather than an inline ``<script>``, which some deployments
        block under a strict CSP.
        """
        return request.render("pingpong_3d.game_page", {
            "score_url": "/pingpong/score",
        })

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


class PingPongOnlineController(http.Controller):
    """Public endpoints for the online 1v1 rooms.

    Nobody has an account, so every route resolves the caller from the
    ``player_token`` the server issued when they created or joined a room. The
    client never supplies a session id, a slot or a role: authority is derived
    from the participant row, which is the only thing it cannot forge.
    """

    # ------------------------------------------------------------------ #
    # Helpers                                                            #
    # ------------------------------------------------------------------ #

    def _session_key(self):
        """A stable per-browser key, used for rate-limit bucketing only."""
        return request.session.sid or ""

    def _partner_id(self):
        user = request.env.user
        return user.partner_id.id if user and not user._is_public() else False

    def _clean_nickname(self, nickname):
        return (nickname or "").strip()[:NICKNAME_MAX]

    def _resolve(self, player_token):
        """Participant and room for a token, or (empty, empty)."""
        Participant = request.env["pingpong.participant"].sudo()
        participant = Participant.search([("token", "=", player_token or "")], limit=1)
        return participant, participant.session_id

    def _joined(self, session, participant):
        return {
            "ok": True,
            "player_token": participant.token,
            "session": session._info(participant),
        }

    # ------------------------------------------------------------------ #
    # Lobby                                                              #
    # ------------------------------------------------------------------ #

    @http.route("/pingpong/online/create", type="jsonrpc", auth="public")
    def create(self, nickname=None, **kwargs):
        Session = request.env["pingpong.session"].sudo()
        session = Session.create_room(
            self._session_key(), self._clean_nickname(nickname), self._partner_id()
        )
        participant = session._host()
        participant.touch()
        return self._joined(session, participant)

    @http.route("/pingpong/online/join", type="jsonrpc", auth="public")
    def join(self, code=None, nickname=None, **kwargs):
        Session = request.env["pingpong.session"].sudo()
        try:
            participant = Session.join_by_code(
                code, self._session_key(), self._clean_nickname(nickname), self._partner_id()
            )
        except UserError as error:
            return {"ok": False, "error": str(error)}
        participant.touch()
        return self._joined(participant.session_id, participant)

    @http.route("/pingpong/online/start", type="jsonrpc", auth="public")
    def start(self, player_token=None, **kwargs):
        participant, session = self._resolve(player_token)
        if not session:
            return {"ok": False, "error": "unknown_token"}
        try:
            session.start(participant)
        except UserError as error:
            return {"ok": False, "error": str(error)}
        return {"ok": True}

    @http.route("/pingpong/online/info", type="jsonrpc", auth="public")
    def info(self, player_token=None, **kwargs):
        participant, session = self._resolve(player_token)
        if not session:
            return {"ok": False, "error": "unknown_token"}
        participant.touch()
        return {"ok": True, "session": session._info(participant)}

    @http.route("/pingpong/online/leave", type="jsonrpc", auth="public")
    def leave(self, player_token=None, **kwargs):
        participant, session = self._resolve(player_token)
        if session:
            session.leave(participant)
        return {"ok": True}

    @http.route(
        "/pingpong/online/beacon_leave",
        type="http",
        auth="public",
        methods=["POST"],
        csrf=False,
        save_session=False,
    )
    def beacon_leave(self, **kwargs):
        """Leaving on tab close.

        ``navigator.sendBeacon`` cannot produce a JSON-RPC envelope, so this is a
        plain http route that hand-parses the body, the same way
        ``/pingpong/score`` already does.
        """
        try:
            payload = json.loads(request.httprequest.get_data() or b"{}")
        except ValueError:
            return request.make_response("", status=204)
        participant, session = self._resolve(payload.get("player_token"))
        if session:
            session.leave(participant)
        return request.make_response("", status=204)

    # ------------------------------------------------------------------ #
    # Live plane                                                         #
    # ------------------------------------------------------------------ #

    @http.route("/pingpong/online/ping", type="jsonrpc", auth="public", save_session=False)
    def ping(self, player_token=None, **kwargs):
        """Heartbeat, and the server's own clock for reference."""
        participant, session = self._resolve(player_token)
        if not session:
            return {"ok": False, "error": "unknown_token"}
        participant.touch()
        session.touch()
        peer = session._guest() if participant.role == "host" else session._host()
        return {
            "ok": True,
            "state": session.state,
            "opponent_online": bool(peer and peer.is_online),
            "host_score": session.host_score,
            "guest_score": session.guest_score,
        }

    @http.route("/pingpong/online/relay", type="jsonrpc", auth="public", save_session=False)
    def relay(self, player_token=None, t=None, p=None, **kwargs):
        """Forward one message to the other player.

        Deliberately does not write to the session or the participant. Odoo runs
        at REPEATABLE READ and retries serialization failures with up to seconds
        of backoff; if both players' messages updated the same row at these
        rates they would serialize against each other and that backoff would
        wreck the netcode. The heartbeat is the only thing that writes, and even
        that is throttled.
        """
        participant, session = self._resolve(player_token)
        if not session or session.state not in ("ready", "playing"):
            return {"ok": False}
        return {"ok": bool(session.relay(participant, t, p))}

    @http.route("/pingpong/online/point", type="jsonrpc", auth="public")
    def point(self, player_token=None, winner=None, reason=None, **kwargs):
        """The host reports who won a point, and why.

        Not the scoreboard: the server counts. This is the difference between a
        score that can be asserted and one that has to be earned a point at a
        time, and it is what makes ``/finish`` able to ignore the client
        entirely.
        """
        participant, session = self._resolve(player_token)
        if not session:
            return {"ok": False, "error": "unknown_token"}
        ok = session.record_point(participant, winner, reason)
        return {
            "ok": bool(ok),
            "host_score": session.host_score,
            "guest_score": session.guest_score,
        }

    @http.route("/pingpong/online/finish", type="jsonrpc", auth="public")
    def finish(self, player_token=None, hits=0, rallies=0, duration=0, **kwargs):
        """Close the match. Any score in the payload is ignored on purpose."""
        participant, session = self._resolve(player_token)
        if not session:
            return {"ok": False, "error": "unknown_token"}
        match = session.finish(participant, hits=hits, rallies=rallies, duration=duration)
        if not match:
            return {"ok": False, "error": "not_host"}
        return {
            "ok": True,
            "match_id": match.id,
            "host_score": session.host_score,
            "guest_score": session.guest_score,
        }
