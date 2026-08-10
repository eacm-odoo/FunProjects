# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
import base64
import binascii
import re
import time
import uuid

from odoo import http
from odoo.http import request

# Maximum nickname length (minimal anti-abuse validation).
NICK_MAX = 20

# --- Feedback limits -------------------------------------------------- #
# The endpoint is public, so everything it accepts is capped. This is not
# real anti-abuse (see the backlog): it just keeps an honest mistake or a
# bored player from filling the filestore.
FEEDBACK_MAX_CHARS = 4000
FEEDBACK_MAX_IMAGE = 3 * 1024 * 1024      # 3 MB decoded
FEEDBACK_MIN_GAP = 15                      # seconds between two reports
FEEDBACK_MAX_PER_SESSION = 20
FEEDBACK_KINDS = ("bug", "idea", "other")
# Accepted screenshots, with the magic bytes each one must actually start
# with: the declared mime type is not trusted.
IMAGE_MAGIC = {
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/gif": (b"GIF87a", b"GIF89a"),
    "image/webp": (b"RIFF",),
}
DATA_URL = re.compile(r"^data:(image/[a-z+]+);base64,(.+)$", re.DOTALL)


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
    def neon_score(self, match_id=None, score=0, wave=0, seconds=0, **kw):
        match = self._match(match_id)
        return match.submit_score(self._token(), score, wave, seconds) if match else False

    @http.route("/neon/leave", type="json", auth="public")
    def neon_leave(self, match_id=None, **kw):
        match = self._match(match_id)
        return match.leave(self._token()) if match else False

    @http.route("/neon/solo_score", type="json", auth="public")
    def neon_solo_score(self, nickname=None, score=0, wave=0, seconds=0, **kw):
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
            "duration": max(0, int(seconds or 0)) / 3600.0,
        })
        return True

    # ------------------------------------------------------------------ #
    # Feedback                                                            #
    # ------------------------------------------------------------------ #

    def _feedback_image(self, image):
        """Validate a data URL screenshot.

        @returns (base64_payload, filename) or (False, error message)
        """
        if not image:
            return False, None
        match = DATA_URL.match(image.strip())
        if not match:
            return False, "The screenshot must be an image."
        mime, payload = match.group(1), match.group(2)
        if mime not in IMAGE_MAGIC:
            return False, "Unsupported image format (use PNG, JPEG, GIF or WebP)."
        try:
            raw = base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError):
            return False, "The screenshot could not be read."
        if len(raw) > FEEDBACK_MAX_IMAGE:
            return False, "The screenshot is too big (3 MB max)."
        # Trust the bytes, not the header the client sent.
        if not any(raw.startswith(magic) for magic in IMAGE_MAGIC[mime]):
            return False, "That file is not really an image."
        if mime == "image/webp" and raw[8:12] != b"WEBP":
            return False, "That file is not really an image."
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}[mime]
        return payload, "screenshot.%s" % ext

    @http.route("/neon/feedback", type="json", auth="public")
    def neon_feedback(self, kind=None, message=None, image=None, nickname=None,
                      wave=0, score=0, mode=None, perks=None, **kw):
        """A player reports a bug or sends an idea from the public page."""
        message = (message or "").strip()
        if not message:
            return {"error": "Write something before sending."}
        now = time.time()
        if now - (request.session.get("neon_feedback_at") or 0) < FEEDBACK_MIN_GAP:
            return {"error": "Give it a few seconds before sending another one."}
        if (request.session.get("neon_feedback_count") or 0) >= FEEDBACK_MAX_PER_SESSION:
            return {"error": "That is enough feedback for one session, thanks!"}

        payload, filename = self._feedback_image(image)
        if payload is False and filename:
            return {"error": filename}

        request.env["neon.strike.feedback"].sudo().create({
            "kind": kind if kind in FEEDBACK_KINDS else "other",
            "message": message[:FEEDBACK_MAX_CHARS],
            "image": payload or False,
            "image_filename": filename or False,
            "nickname": self._clean_nick(nickname),
            "user_id": self._uid(),
            "token": self._token(),
            "wave": int(wave or 0),
            "score": int(score or 0),
            "mode": mode if mode in ("menu", "solo", "coop") else "menu",
            "perks": (perks or "")[:255] or False,
        })
        request.session["neon_feedback_at"] = now
        request.session["neon_feedback_count"] = (request.session.get("neon_feedback_count") or 0) + 1
        return {"ok": True}

    @http.route("/neon/scores", type="json", auth="public")
    def neon_scores(self, **kw):
        return request.env["neon.strike.score"].sudo().search_read(
            [],
            ["player_name", "score", "wave", "mode", "player_count", "duration"],
            limit=10,
            order="score desc, id asc",
        )
