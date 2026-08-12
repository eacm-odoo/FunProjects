from odoo import models

CHANNEL_PREFIX = "battleship_game_"


class IrWebsocket(models.AbstractModel):
    _inherit = "ir.websocket"

    def _build_bus_channel_list(self, channels):
        """Authorise a room's channel by capability, not by user.

        Both players of an online game may be the public user, so there is
        nothing in ``env.user`` to check against. The channel name carries the
        room's ``access_token`` instead, and knowing it is the proof of being
        let in: the only place it is ever handed out is the reply to opening or
        joining a room.

        A finished room keeps granting its channel, because that is where the
        rematch is announced. What it does not grant is anything else: an
        unknown token is dropped in silence, and channels this module does not
        recognise are passed on to ``super()`` — forgetting that would quietly
        break Discuss and every other bus consumer on the same page.
        """
        channels = list(channels)
        allowed = []
        remaining = []
        for channel in channels:
            if isinstance(channel, str) and channel.startswith(CHANNEL_PREFIX):
                token = channel[len(CHANNEL_PREFIX):]
                if token and self.env["battleship.game"].sudo().search_count(
                    [("access_token", "=", token)], limit=1
                ):
                    allowed.append(channel)
                continue
            remaining.append(channel)
        return super()._build_bus_channel_list(remaining) + allowed
