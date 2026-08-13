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
├── models/battleship_feedback.py  bugs and ideas sent from the board
├── models/ir_websocket.py      room channel authorised by access_token
├── controllers/main.py         /battleship page + the routes the board calls
├── migrations/                 back-fills date_end on games finished before 4.0
├── security/                   ir.model.access.csv (base.group_user)
├── views/                      list/form for games and feedback, menus, public page
└── static/src/
    ├── backend/battleship_action.js stub client action, loads the game bundle
    ├── boot/battleship_public.js    same stub as an `owl-component` for /battleship
    ├── board/battleship_board.js    the board itself (registry "lazy_components")
    ├── board/api.js                 every server call the board makes
    ├── board/battleship_board.xml   QWeb template
    ├── board/battleship_board.scss  the chrome: steel plates and signals paper
    ├── board/fonts.js               pulls the four faces the chrome is set in
    ├── board/scene.js               three.js layer — no game rules
    ├── board/ships.js               the five hulls, built from shared parts
    ├── board/water.js               the sea: one wave field, in GLSL and in JS
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

`/battleship` serves the page, and `/battleship/join/<code>` serves the same page
pointed at a room: the code reaches the board as the `roomCode` prop and it joins
on start. `/battleship/feedback` takes bug reports and ideas from either place.

The board never calls `call_kw`: a visitor has no rights on `battleship.game`,
so every action goes through `/battleship/{new,state,place,random,ready,fire}`
and `/battleship/room/{create,join,leave,rematch}` (`auth="public"`). The
controller resolves who owns a game — the logged in user, the session token for
an anonymous player, or one of the two seats of an online room — and anonymous
games run in `sudo()`. A game id alone is never enough to act on a game.

## Online mode

One player opens a room and gets a code (`BSHP-XXXX`) and an invitation link;
the other opens the link, or types the code. From there both place their fleet at
the same time, and the battle starts once the second one locks in.

* **Invitation.** The link is `<base url>/battleship/join/<code>`, and opening it
  is the whole handshake: the visitor lands on the board, takes the free seat
  under the name their browser last played with, and never sees a form. It is
  worth exactly what the code is worth — it opens a room while it is empty, and
  a link to a room that is full, finished or gone drops the visitor on the room
  panel with the error, not on a 404. The seat itself is still the browser
  token, so a link that leaks cannot take a seat somebody is sitting in.
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
* **Going quiet.** Two browsers over a bus have no way of saying goodbye — a
  closed tab, a dead network and a shut laptop look identical from the server —
  so each seat writes `seen_a`/`seen_b` every 15s (`/battleship/room/ping`) and
  the same call answers with whether the other one still is. Three missed beats
  (`AWAY_AFTER`, 45s) and the board says so: a brass banner over the water in
  place of the turn one, plus a notification the moment it flips either way.
  It decides nothing — nobody forfeits for being quiet, and the room waits as
  long as the player at it is willing to. The beat runs only while a room is
  open (`syncHeartbeat`), and the wording is "has not answered", not
  "disconnected", because that is all the server can honestly tell.
* **Rematch.** A finished game is never reset — it is what the win/loss tally
  counts. "Rematch" opens a fresh room that inherits both seats, and the old
  channel is where the other tab hears about it (`rematch_id`).
* **Whose turn, and what is left of it.** Two players means waiting for
  somebody, and four means a turn with several shells in it, so it is said in
  five places at once: a banner over the water, the panel of the side being
  waited on, a halo along the rim of every board the turn still owes a shell to
  (`scene.setGlow`), a `FIRE HERE` plate on each of those same boards
  (`scene.setTurn`), and the crosshair, which only appears while a click would
  really fire. A board already dealt with drops all of it and dims its name
  plate, so what is lit is what is left. None of it is state of its own — it all
  reads `turn_pending` and `turn_again` against the seat this screen holds.
* **The shot a hit buys.** When the last shell hit and that board is still owed
  one, it is the shell waiting to be fired, and it says so louder than the rest:
  `turn_again` names the board, its halo and its `FIRE AGAIN` plate beat about
  twice as fast, and its fleet panel wears an amber `fire again` tag. It is a
  signpost and not a rule — the sweep may be fired in whatever order the player
  likes, and the server only insists that every board gets its one shell.

## Interface

North Atlantic, 1943. Everything a player reads is one of two materials, and the
two are never mixed on the same surface: **painted steel** carries live state —
orders, fleets, buttons — and **signals paper** carries what has already
happened — the radio log, the service record, the final dispatch. That is why
the game-over card is paper and the room panel is not.

The board opens on a **start screen** rather than straight on a grid: the title,
the three ways to play, and the commander's file with the win/loss tally on it.
It sits over a game the server has already created, so picking a mode is a door
and not a wait. The final dispatch has a **Menu** button back to it, and Esc
closes it once there is a board worth going back to.

**See the wreckage** on the final dispatch pushes it aside and leaves the board
on screen. It is the only moment worth looking at the whole thing: `read_state`
stops hiding fleets once a game is over, so both navies are on the water with
every hit and every miss on them. The dispatch is one Esc away throughout, the
bottom bar stays live, and any new game clears the flag (`setGame`).

Across the bridge: the wordmark and the mode switch, the **orders** strip (the
one line that has to be read the moment it changes, so nothing else in that row
is allowed to grow into it), the record, and the radio log. Under the water, one
plate per grid — ours lists ships by name, the other lists radar contacts,
which is exactly what the server sends (`isMine`).

`fonts.js` pulls Big Shoulders Display, Special Elite and the two IBM Plex faces
at runtime instead of shipping them: the board is the only screen that uses
them, and every rule names a fallback stack, so a browser that never reaches
Google Fonts gets a plainer board and not a broken one.

## Free-for-all

Four boards on one table, `mode = royale`. It is a room like the duel is — a
code, a bus channel, a seat per browser token — with three seats to give instead
of one, and it does not start itself: whoever opened it presses **Sail now**, and
every chair still empty at that moment goes to the admiralty (`cpu_sides`). One
human is therefore enough, four is the most, and anybody who arrives before the
room sails gets the next free seat (`_free_seat`).

The rules, and where they live:

* **Everybody shoots everybody, every turn.** A turn is a sweep of the table:
  one shell at each board still afloat, not one shell at one board of your
  choosing. `action_fire` takes a `target` — which board was clicked — and
  `_firing_at` checks it against `_pending_targets`: not your own, not one that
  is already out, and not one this turn has been to already. A duel never sends
  a target, because it has only one answer.
* **A square can only be fired at once, by anybody.** This needed no new code.
  `shots_<side>` has always been "cells fired *at* that side", from whoever, so
  the check that stopped a player firing at the same square twice already stops
  the whole table doing it.
* **A hit buys another shell, on that board** — the same rule the duel has,
  read one grid at a time. `turn_cleared` is the boards the sweep is done with,
  and `_advance_turn` only crosses one off when the shell misses or the fleet
  goes down; the turn moves once nothing is pending. A duel is the same code
  with one board in the sweep, which is why it still ends on the first miss.
  `_next_player` then walks the seats in order and skips everybody who is out,
  so a four-way quietly becomes a three-way and then a duel without the
  rotation ever being rewritten. `read_state` ships the sweep as `turn_pending`,
  which is what the client lights a crosshair on and counts down in the banner.
* **Last one afloat wins.** `_end_if_settled` closes the game the moment one
  seat is left; `_is_out` is a fleet on the bottom *or* a player who walked away
  (`left_sides`). Walking out of a free-for-all is not a win for anybody — the
  others are in the middle of a game with each other.

Seats were the part that had to change everywhere. Nothing counts sides any more:
`_seats()` answers how many a mode has, `_is_room()` whether browsers meet in it,
and the per-side columns (`fleet_`, `shots_`, `token_`, `name_`, `ready_`,
`seen_`) go up to `d`. The payload carries a `seats` list — side, name, cpu, out,
ready — and the client draws one panel per entry, so nothing in the UI knows how
many players a mode has either.

On the table itself, `scene.js` no longer owns two boards: `_layout(sides)`
builds them for whatever seats the payload names, two in a row or four in a
square, and rebuilds when that changes (they carry their own water, so it is not
a resize). Four sheets of water would be four times the vertices, hence the
smaller `WATER_SEGMENTS_MANY` and the tighter `GAP_MANY`. The shot log gained a
`target` column for the same reason the boards did: four grids share one set of
coordinates, so J8 no longer says whose J8.

## Ships and water

Both ported from the `Battleship 3D` design prototype.

`ships.js` builds each class from the same parts — hull, turrets, funnels,
masts, light AA — so a carrier, a battleship, a cruiser, a submarine and a
destroyer read as one navy. The class is chosen by name when the payload gives
one and by length when it does not, which is what an enemy ship looks like
until it sinks.

`water.js` is a height field, not a fluid: four travelling sine waves for the
swell, plus one decaying ring per impact (twelve at a time, oldest recycled).

It is written **twice on purpose**. The GLSL copy displaces and shades a 200x200
sheet per board — fresnel, specular off the real wave normal, sun glitter, foam
at the impact, and the grid drawn *on the surface* so the lines ride the swell.
The JS copy answers the one question the CPU still has to ask: how high is the
water under this hull. Every ship reads four points around itself (bow, stern,
port, starboard) for its heave, pitch and roll, and every shot marker bobs on
the same field. **The two copies have to agree** — they sit next to each other in
that file for exactly that reason.

Each grid is a well, not a sheet: four rails instead of a slab, a floor below
the deepest trough and walls at the rim, and the swell flattened into the walls,
so a dipping wave never reveals anything but more water. The two seas run at
different phases and tints, or they would read as one sheet cut in half.

One thing this cost: the surface is a `ShaderMaterial`, so it does not receive
shadows — ships no longer cast onto the sea. Getting them back means pulling
three.js's shadowmap chunks into the shader.

A shot is a shell, not a state change: it arcs in from off the board, and the
ring, the splash column, the crown, the droplets, the sound and the marker all
happen when it lands. The cell is `pending` until then, so a payload arriving
mid-flight does not drop the marker half a second early.

One server call can carry several shots — the CPU answers inside the call that
carries yours, and keeps firing while it hits — so the client spaces them out
(`VOLLEY_STEP`) instead of resolving the whole turn in one frame. While anything
is in the air the board is `settling`: input is refused, and the game-over card
waits, because the salvo that ended the game is the part worth watching.

Placement: click a ship in the panel or press **1**-**5** to pick one — including
one already on the grid, which moves it — and **R** turns it 90°, redrawing the
preview where it stands. During a battle the cell under the pointer lights up,
but only when it is one you may actually fire at.

**Glossary** opens the fleet glossary: the five classes, one at a time, on a
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
| `read_record(session_token)` | wins, losses, games played and seconds at the board, for a user or a browser session |
| `battleship.feedback.action_report(kind, subject, description, ...)` | file a bug or an idea |

Cells are `row * 10 + col`, 0-based, `A1` = 0.

## Counters and feedback

A game stamps `date_end` the moment it is declared over — `write()` does it, so
the three places that end a game cannot forget — and `duration` (hours, stored,
summable) follows from `create_date`. Both counters read finished games only, in
the backend list footer and in the board's own Record panel: a game still on the
table has not been played yet, and a room left open forever was never played at
all. Grouping the list by mode, player or month splits count and time without a
report of its own.

"Report" on the board writes a `battleship.feedback` record — bug or idea, with
the game attached, under the Battleship menu. The route is `auth="public"`, so
it is deliberately narrow: an 80 character subject, a 2000 character body, and
five reports per browser per hour. The game only travels with the report if the
sender is allowed to be playing it, which is the same check every move goes
through.

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
