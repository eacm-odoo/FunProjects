# Neon Strike — Odoo 19 module

Neon space shooter (2D canvas + OWL 2) served from a **public `/neon` page**.
No account needed: type a nickname and play. It supports single player and
**remote co-op for up to 4 players** over the Odoo bus, with a single global
leaderboard stored through the ORM.

Built with Odoo · brand guide: https://www.odoo.com/page/brand-assets

## Requirements

- Odoo 19.0 Community (or Enterprise)
- Depends on `web`, `bus` and `website` — all core
- Zero external Python or JS dependencies, no CDN requests, no sound files

## Installation

1. Copy the module into your addons path:

```bash
cp -r neon_strike /path/to/odoo/custom_addons/
```

2. Start Odoo pointing at that path and install it:

```bash
./odoo-bin -d neon_dev \
    --addons-path=addons,/path/to/odoo/custom_addons \
    -i neon_strike \
    --dev=all
```

3. Open **/neon**, or use the *Neon Strike → Play* backend menu, or the
   **Neon Strike** entry in the website navigation. Turn the volume up 🔊

With `--dev=all`, changes to JS/SCSS/XML reload with a browser refresh. For
Python, view or security changes: `-u neon_strike`.

## How to play

Drag (or move the mouse) to fly your ship — fire is automatic. Capsules dropped
by downed enemies give **T** triple shot, **S** shield, **B** bomb and **+** an
extra life. In co-op, fly next to a downed ally to revive them. A boss shows up
every 4 waves. The **Ships and enemies** button in the menu opens a glossary of
every ship, enemy, boss, asteroid and capsule.

To play together: one player hits **Create match** and shares the room code; the
others paste it and hit **Join**. The host starts the match.

## What it includes

| Piece | Where | What it does |
|---|---|---|
| Game engine | `static/src/js/game_engine.js` | `NeonStrikeEngine`: physics, 6 enemy types, boss, asteroids, power-ups, combos, particles, synthesised audio (Web Audio). Roles `solo`/`host`/`guest` |
| Sprite bank | `static/src/js/sprites.js` | Pixel art as character grids, re-tinted at draw time and cached. 19 sprites |
| Glossary | `static/src/js/glossary.js` | Data-only catalogue feeding the in-menu "Ships and enemies" panel |
| Menu backdrop | `static/src/js/menu_backdrop.js` | Decorative "attract mode" behind the start menu |
| OWL component | `static/src/js/neon_strike_game.js` | `NeonStrikeGame`, mounted as a standalone OWL app on the public page |
| Templates | `static/src/xml/neon_strike_templates.xml` | Toolbar, menu, lobby, glossary and leaderboard |
| Styles | `static/src/scss/neon_strike.scss` | Odoo purple chrome with neon accents; animations respect `prefers-reduced-motion` |
| Page | `views/neon_strike_page.xml` | QWeb template behind `/neon`, full screen, no header/footer |
| Controllers | `controllers/main.py` | `GET /neon` plus the public JSON API (`/neon/create`, `join`, `start`, `input`, `state`, `score`, `solo_score`, `leave`, `scores`) |
| Models | `models/neon_strike_score.py` | `neon.strike.score`: score, wave, mode (solo/co-op), player count |
| | `models/neon_strike_match.py` | `neon.strike.match`: room code, access token, state, participants |
| | `models/neon_strike_participant.py` | `neon.strike.participant`: session token, nickname, slot, colour |
| | `models/ir_websocket.py` | Authorizes the match bus channel by capability |
| Views/menus | `views/neon_strike_views.xml` | Backend menu (Play / Leaderboard) and the score list |
| | `views/website_menu.xml` | "Neon Strike" entry in the public site navigation |
| Security | `security/ir.model.access.csv` | Internal users read scores; `base.group_system` manages everything |

## How multiplayer works

The match is **host-authoritative**: one browser simulates everything and
broadcasts a compact snapshot ~15 Hz through the Odoo bus; the guests render what
they receive and forward their pointer ~20 Hz. The simulation runs in a fixed
680×540 logical space so coordinates match on every machine, and the render is
scaled with letterboxing.

Identity is a **session token plus a nickname**, not `res.users` — the page is
public and everyone is the Odoo public user. The bus channel is
`neon_strike_match_<access_token>` and is authorized *by capability*: knowing the
token proves you were let into the room, since it is only handed out when you
create or join one.

This is deliberately not low-latency netcode. Each broadcast is a `bus.bus` row
plus a websocket push, which is fine for 2–4 players but would not scale further.

## How saving works

The client never touches the ORM directly: `call_kw` is `auth="user"` and the
page is public. Everything goes through JSON controllers with `auth="public"`
that operate with `sudo()` and resolve the player from the session token. Solo
runs post to `/neon/solo_score`; in co-op the host posts the team result to
`/neon/score`. Both land in `neon.strike.score`, which feeds the leaderboard shown
in the menu and the backend list.

## Development with Claude Code

The module includes a `CLAUDE.md` with architecture notes, commands, known
gotchas and a backlog. Open the module folder and run `claude` from there.

## License

LGPL-3. See `LICENSE`.
