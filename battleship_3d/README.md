# Battleship 3D — Odoo 19.0 module

Turn-based Battleship on a three.js board, rendered by an OWL component.
Rules are **server-authoritative**: the browser never learns where the enemy
ships are until they sink.

It is played from two places, with the same component on both sides:

* the backend, menu **Battleship → Play** (client action `battleship_3d.board`);
* the public page **`/battleship`**, no account needed — an anonymous game
  belongs to the browser session that started it (`session_token`).

## Install

1. Copy `battleship_3d/` into your addons path. three.js is already vendored in
   `static/src/lib/` (see its README for how it was produced).
2. `odoo-bin -u battleship_3d -d <db>` (or Apps → Update Apps List → Battleship 3D).
3. Menu **Battleship → Play**, or open `/battleship`.

## Layout

```
battleship_3d/
├── models/battleship_game.py   game state, placement, firing, CPU AI, read_state()
├── models/battleship_shot.py   immutable shot history (one record per shot)
├── controllers/main.py         /battleship page + the routes the board calls
├── security/                   ir.model.access.csv (base.group_user)
├── views/                      list/form for games, menus, public page, site menu
└── static/src/
    ├── backend/battleship_action.js stub client action, loads the game bundle
    ├── boot/battleship_public.js    same stub as an `owl-component` for /battleship
    ├── board/battleship_board.js    the board itself (registry "lazy_components")
    ├── board/api.js                 the six server calls the board makes
    ├── board/battleship_board.xml   QWeb template
    ├── board/battleship_board.scss  styling (Odoo purple #714B67 / teal #017E84)
    ├── board/scene.js               three.js layer — no game rules
    ├── board/sound.js               WebAudio SFX, no assets
    └── lib/                         vendored three.js + OrbitControls
```

## Assets

three.js is a couple of megabytes, so it is not in `web.assets_backend` nor in
`web.assets_frontend`: both only carry a `LazyComponent` stub, which fetches
`battleship_3d.assets_game` the first time somebody opens the game.

On the public page the board is mounted as an `owl-component`, which the
frontend interaction service instantiates inside the app the page already runs.
Starting a second OWL app there would mean a second `startServices()`, and the
services register global things — the notification container for one — that only
tolerate being registered once.

## Routes

The board never calls `call_kw`: a visitor has no rights on `battleship.game`,
so every action goes through `/battleship/{new,state,place,random,ready,fire}`
(`auth="public"`). The controller resolves who owns a game — the logged in user,
or the session token for an anonymous player — and anonymous games run in
`sudo()`. A game id alone is never enough to act on a game.

## Model API

| Method | Purpose |
|---|---|
| `action_new_game(mode)` | create a game (`cpu` / `hotseat`), returns `read_state()` |
| `action_place_ship(side, index, cell, direction)` | place one ship, `direction` = `h`/`v` |
| `action_random_fleet(side)` | scatter a legal fleet |
| `action_ready()` | lock the fleet being placed; starts the battle when both are set |
| `action_fire(cell)` | resolve a shot; in CPU mode the CPU answers in the same call |
| `read_state()` | full client payload, enemy positions filtered out |
| `read_record(session_token)` | win/loss tally of a user, or of a browser session |

Cells are `row * 10 + col`, 0-based, `A1` = 0.

## Known gaps (prototype)

* Hot-seat trusts the two humans to look away — no per-user record ACL.
* `/battleship/new` is public and unthrottled: every visitor who clicks "vs CPU"
  leaves a `battleship.game` row behind. Fine on a demo, worth a rate limit and
  a cleanup cron on anything public for long.
* No bus/websocket, so hot-seat is single-device only; a two-session mode would
  need `bus.bus` notifications on `battleship.game`.
* No tests yet — `tests/test_battleship.py` is the obvious next file
  (placement collisions, turn order, CPU never repeats a cell, win detection).
* Ship record uses `fields.Json`; if you need reporting on positions, split it
  into a `battleship.ship` model.
