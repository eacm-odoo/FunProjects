# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
import uuid

from odoo import http
from odoo.http import request

# Maximum nickname length (minimal anti-abuse validation).
NICK_MAX = 20


class NeonStrikeController(http.Controller):
    """Public entry points for Neon Strike (play without an Odoo account).

    Each player's identity is a session ``token`` (uuid) plus the nickname they
    type. All ORM logic runs with ``sudo()``; host authority is validated in the
    model by comparing the token, not by ACL.
    """

    # ------------------------------------------------------------------ #
    # Helpers                                                             #
    # ------------------------------------------------------------------ #

    def _token(self):
        """Stable session token of the player (created on first use)."""
        token = request.session.get("neon_token")
        if not token:
            token = uuid.uuid4().hex
            request.session["neon_token"] = token
        return token

    def _uid(self):
        """User id when there is a real login; False for anonymous players."""
        return request.session.uid or False

    def _clean_nick(self, nickname):
        nickname = (nickname or "").strip()
        return (nickname or "Player")[:NICK_MAX]

    def _match(self, match_id):
        if not match_id:
            return request.env["neon.strike.match"]
        return request.env["neon.strike.match"].sudo().browse(int(match_id)).exists()

    # ------------------------------------------------------------------ #
    # Public page                                                         #
    # ------------------------------------------------------------------ #

    # `website=True` marks the route as frontend: that is what makes
    # `request.is_frontend` True and puts `website` in the render context,
    # which `website.layout` requires (it inherits the `web.frontend_layout`
    # chain). Without the flag, rendering the frontend layout blows up with
    # KeyError: 'website'.
    # `sitemap=True` publishes the page in the site sitemap.
    @http.route("/neon", type="http", auth="public", website=True, sitemap=True)
    def neon_page(self, **kw):
        # Make sure the session token exists before serving the game.
        self._token()
        return request.render("neon_strike.page")

    # ------------------------------------------------------------------ #
    # JSON API (called with rpc() from the OWL component)                 #
    # ------------------------------------------------------------------ #

    @http.route("/neon/create", type="json", auth="public")
    def neon_create(self, nickname=None, **kw):
        return request.env["neon.strike.match"].sudo().create_match(
            self._token(), self._clean_nick(nickname), self._uid()
        )

    @http.route("/neon/join", type="json", auth="public")
    def neon_join(self, code=None, nickname=None, **kw):
        return request.env["neon.strike.match"].sudo().join_by_code(
            code, self._token(), self._clean_nick(nickname), self._uid()
        )

    @http.route("/neon/start", type="json", auth="public")
    def neon_start(self, match_id=None, **kw):
        match = self._match(match_id)
        return match.start(self._token()) if match else False

    @http.route("/neon/input", type="json", auth="public")
    def neon_input(self, match_id=None, x=0, y=0, action=None, **kw):
        match = self._match(match_id)
        return match.player_input(self._token(), x, y, action) if match else False

    @http.route("/neon/state", type="json", auth="public")
    def neon_state(self, match_id=None, snapshot=None, **kw):
        match = self._match(match_id)
        return match.broadcast_state(self._token(), snapshot or {}) if match else False

    @http.route("/neon/score", type="json", auth="public")
    def neon_score(self, match_id=None, score=0, wave=0, **kw):
        match = self._match(match_id)
        return match.submit_score(self._token(), score, wave) if match else False

    @http.route("/neon/leave", type="json", auth="public")
    def neon_leave(self, match_id=None, **kw):
        match = self._match(match_id)
        return match.leave(self._token()) if match else False

    @http.route("/neon/solo_score", type="json", auth="public")
    def neon_solo_score(self, nickname=None, score=0, wave=0, **kw):
        score = int(score or 0)
        if not score:
            return False
        request.env["neon.strike.score"].sudo().create({
            "user_id": self._uid(),
            "nickname": self._clean_nick(nickname),
            "score": score,
            "wave": int(wave or 0),
            "mode": "solo",
            "player_count": 1,
        })
        return True

    @http.route("/neon/scores", type="json", auth="public")
    def neon_scores(self, **kw):
        return request.env["neon.strike.score"].sudo().search_read(
            [],
            ["player_name", "score", "wave", "mode", "player_count"],
            limit=10,
            order="score desc, id asc",
        )
