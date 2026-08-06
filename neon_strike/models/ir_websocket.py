# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo import models

MATCH_CHANNEL_PREFIX = "neon_strike_match_"


class IrWebsocket(models.AbstractModel):
    _inherit = "ir.websocket"

    def _build_bus_channel_list(self, channels):
        """Autoriza la suscripción al canal de una partida por *capacidad*: el
        canal incluye el ``access_token`` (uuid) de la partida, que solo conocen
        quienes la crearon o se unieron. Se permite si existe una partida con ese
        token; en caso contrario se descarta silenciosamente. Como el juego es
        público, no dependemos de ``env.user`` (todos serían el usuario público)."""
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
                # Token inválido -> se descarta.
                continue
            remaining.append(channel)
        return super()._build_bus_channel_list(remaining) + allowed
