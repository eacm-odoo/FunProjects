# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo import models

MATCH_CHANNEL_PREFIX = "neon_strike_match_"


class IrWebsocket(models.AbstractModel):
    _inherit = "ir.websocket"

    def _build_bus_channel_list(self, channels):
        """Authorize subscription to a match channel by *capability*: the channel
        embeds the match ``access_token`` (uuid), known only to whoever created
        or joined it. It is allowed when a match with that token exists, and
        silently dropped otherwise. Since the game is public we cannot rely on
        ``env.user`` (everyone would be the public user)."""
        channels = list(channels)
        allowed = []
        remaining = []
        for channel in channels:
            if isinstance(channel, str) and channel.startswith(MATCH_CHANNEL_PREFIX):
                token = channel[len(MATCH_CHANNEL_PREFIX):]
                if token and self.env["neon.strike.match"].sudo().search_count(
                    [("access_token", "=", token)], limit=1
                ):
                    allowed.append(channel)
                # Invalid token -> dropped.
                continue
            remaining.append(channel)
        return super()._build_bus_channel_list(remaining) + allowed
