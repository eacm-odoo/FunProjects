# Battleship 3D — Odoo 19.0 module

Turn-based Battleship on a three.js board, rendered by an OWL component.
Rules are **server-authoritative**: the browser never learns where the enemy
ships are until they sink.

It is played from two places, with the same component on both sides:

* the backend, menu **Battleship → Play** (client action `battleship_3d.board`);
* the public page **`/battleship`**, no account needed — an anonymous game
  belongs to the browser session that started it (`session_token`).

Three modes: **vs CPU**, **2 players hot-seat** (one device) and **online**, where
each player sits at their own machine.

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
├── models/ir_websocket.py      room channel authorised by access_token
├── controllers/main.py         /battleship page + the routes the board calls
├── security/                   ir.model.access.csv (base.group_user)
├── views/                      list/form for games, menus, public page, site menu
└── static/src/
    ├── backend/battleship_action.js stub client action, loads the game bundle
    ├── boot/battleship_public.js    same stub as an `owl-component` for /battleship
    ├── board/battleship_board.js    the board itself (registry "lazy_components")
    ├── board/api.js                 every server call the board makes
    ├── board/battleship_board.xml   QWeb template
    ├── board/battleship_board.scss  styling (Odoo purple #714B67 / teal #017E84)
    ├── board/scene.js               three.js layer — no game rules
    ├── board/ships.js               the five hulls, built from shared parts
    ├── board/water.js               swell + impact rings, and what floats on them
    ├── board/glossary.js            what each class is (data only)
    ├── board/ship_viewer.js         the glossary turntable, its own tiny scene
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
and `/battleship/room/{create,join,leave,rematch}` (`auth="public"`). The
controller resolves who owns a game — the logged in user, the session token for
an anonymous player, or one of the two seats of an online room — and anonymous
games run in `sudo()`. A game id alone is never enough to act on a game.

## Online mode

One player opens a room and gets a code (`BSHP-XXXX`); the other types it in.
From there both place their fleet at the same time, and the battle starts once
the second one locks in.

* **Seats.** A room has `token_a` / `token_b`, and each holds the browser token
  the session already carries. The client never sends an identity, so nothing it
  could forge would sit it down on the other side of the board. Every rule that
  used to be "side A is you" — whose turn it is, which fleet may be moved, who
  won — is checked against the caller's seat on the server.
* **Bus.** `bus.bus` notifications go out on `battleship_game_<access_token>`,
  authorised in `models/ir_websocket.py` by capability: knowing the token is the
  proof of belonging, because the only place it is ever handed out is the reply
  to opening or joining a room.
* **What travels.** The notification says which room moved and why, and nothing
  else. Both players share the channel, so a payload with the state in it would
  be a payload with the opponent's fleet in it: each client answers the nudge by
  reading the state back through its own seat, which is filtered as always.
* **Leaving.** Closing a room in the lobby deletes it. Leaving mid-battle ends
  the game as a win for whoever stayed (`end_reason = forfeit`).
* **Rematch.** A finished game is never reset — it is what the win/loss tally
  counts. "Rematch" opens a fresh room that inherits both seats, and the old
  channel is where the other tab hears about it (`rematch_id`).

## Ships and water

Both ported from the `Battleship 3D` design prototype.

`ships.js` builds each class from the same parts — hull, turrets, funnels,
masts, light AA — so a carrier, a battleship, a cruiser, a submarine and a
destroyer read as one navy. The class is chosen by name when the payload gives
one and by length when it does not, which is what an enemy ship looks like
until it sinks.

`water.js` is a height field, not a fluid: three travelling sine waves for the
swell, plus one decaying ring per impact. Everything that needs to know how high
the sea is samples the same function — the surface mesh deforms to it, and every
hull reads four points around itself (bow, stern, port, starboard) to get its
heave, pitch and roll. A wreck stays in the swell with a deeper draft and a
permanent list.

Placement: click a ship in the panel or press **1**-**5** to pick one — including
one already on the grid, which moves it — and **R** turns it 90°, redrawing the
preview where it stands.

**Ships** opens the fleet glossary: the five classes, one at a time, on a
turntable you can orbit, floating on the same swell as the board. It is the real
mesh, not a picture of one — `ship_viewer.js` builds a second small scene with
the same three lights and calls the same `shipMesh()`. One renderer for the
panel and one selection at a time, on purpose: five live cards would be five
WebGL contexts on a page that already holds one, and browsers do not hand those
out freely. The scene exists only while the panel is open (`useEffect` keyed on
the canvas).

## Model API

| Method | Purpose |
|---|---|
| `action_new_game(mode)` | create a local game (`cpu` / `hotseat`), returns `read_state()` |
| `action_create_room(token, nickname)` | open an online room, caller takes side A |
| `action_join_room(code, token, nickname)` | take side B of that room |
| `action_place_ship(side, index, cell, direction)` | place one ship, `direction` = `h`/`v` |
| `action_random_fleet(side)` | scatter a legal fleet |
| `action_ready(side)` | lock a fleet; starts the battle when both are set |
| `action_fire(cell, side)` | resolve a shot; in CPU mode the CPU answers in the same call |
| `action_leave(side)` / `action_rematch(side)` | give up a room / play again in a new one |
| `read_state(viewer)` | full client payload, cut for that seat — enemy positions filtered out |
| `read_record(session_token)` | win/loss tally of a user, or of a browser session |

Cells are `row * 10 + col`, 0-based, `A1` = 0.

## Known gaps (prototype)

* Hot-seat trusts the two humans to look away — no per-user record ACL.
* `/battleship/new` is public and unthrottled: every visitor who clicks "vs CPU"
  leaves a `battleship.game` row behind. Fine on a demo, worth a rate limit and
  a cleanup cron on anything public for long.
* An online player who simply closes the tab leaves the room hanging: there is
  no heartbeat, so the opponent waits until they give up and leave. A
  `last_activity` field plus a reaper cron is the way out, as in `pingpong_3d`.
* Rooms are never garbage collected, and a code is held forever by the game that
  drew it.
* No tests yet — `tests/test_battleship.py` is the obvious next file
  (placement collisions, turn order, CPU never repeats a cell, win detection).
* Ship record uses `fields.Json`; if you need reporting on positions, split it
  into a `battleship.ship` model.
