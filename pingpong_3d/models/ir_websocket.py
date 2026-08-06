from odoo import models

SESSION_CHANNEL_PREFIX = "pingpong_session_"
PLAYER_CHANNEL_PREFIX = "pingpong_player_"


class IrWebsocket(models.AbstractModel):
    _inherit = "ir.websocket"

    def _build_bus_channel_list(self, channels):
        """Authorise the game's channels by capability, not by user.

        Everyone playing is the public user, so there is nothing in ``env.user``
        to check against. What each channel name carries instead is a secret: a
        room's ``access_token`` or a player's ``token``. Knowing one is the proof
        that you were let in, because the only place either is ever handed out is
        the reply to creating or joining a room.

        Two details worth keeping:

        * A finished room stops granting a subscription, so a token left in an
          old tab does not keep a channel open forever.
        * Channels we do not recognise are passed on to ``super()``. Forgetting
          that is the easy mistake here, and it would silently break Discuss and
          every other bus consumer on the same page.
        """
        channels = list(channels)
        allowed = []
        remaining = []
        for channel in channels:
            if not isinstance(channel, str):
                remaining.append(channel)
                continue

            if channel.startswith(SESSION_CHANNEL_PREFIX):
                token = channel[len(SESSION_CHANNEL_PREFIX):]
                if token and self.env["pingpong.session"].sudo().search_count([
                    ("access_token", "=", token),
                    ("state", "not in", ("over", "abandoned")),
                ], limit=1):
                    allowed.append(channel)
                continue                      # unknown token: dropped in silence

            if channel.startswith(PLAYER_CHANNEL_PREFIX):
                token = channel[len(PLAYER_CHANNEL_PREFIX):]
                if token and self.env["pingpong.participant"].sudo().search_count(
                    [("token", "=", token)], limit=1
                ):
                    allowed.append(channel)
                continue

            remaining.append(channel)
        return super()._build_bus_channel_list(remaining) + allowed
