from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    """Give games that were already over a plausible end date.

    `date_end` is new, so every game finished before this version has none and
    counts as no time at the board at all. The last write to a finished game is
    the shot that ended it, give or take a rematch link — the closest thing to
    an end that was ever recorded. Writing it through the ORM is what gets
    `duration` computed along with it.
    """
    env = api.Environment(cr, SUPERUSER_ID, {})
    games = env["battleship.game"].search([
        ("state", "=", "done"), ("date_end", "=", False),
    ])
    for game in games:
        game.date_end = game.write_date
