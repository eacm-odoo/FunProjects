# CLAUDE.md — Neon Strike (Odoo 19 module)

Context for Claude Code. Read this before touching the code.

## What this is

Odoo 19.0 Community module running a space shooter (2D canvas, OWL 2) on a **public `/neon` page** published in the website menu (same as `pingpong_3d`), playable **without a login**: type a nickname and play. It supports **remote co-op for up to 4 players** over the Odoo bus (room by code, host-authoritative) on top of the single-player mode. Each player's identity is a **session token + nickname** (not `res.users`). Single global leaderboard in `neon.strike.score`. No external dependencies beyond `web`, `bus` and `website`.

## Architecture

- `static/src/js/game_engine.js` — `NeonStrikeEngine(canvas, {onGameOver, onLocalInput, role, players, localSlot, names, hotseat})` class. ALL gameplay lives here: rAF loop, physics, enemies (drone/speedy/tank/**sniper**/**kami**/boss), **asteroids** (`rocks`), power-ups (T/S/B/L), combos (capped at x25), particles, screen shake, slow-mo, synthesised audio. **N ships** in `this.ships` (array by slot), individual lives, going down (`down`) and reviving by flying next to the others. Simulated in a **fixed 680×540 logical space** (render scaled with letterboxing) so coordinates are identical on every machine. Roles:
  - `solo` — local single-player simulation.
  - `host` — simulates everything; `snapshot()` serialises a compact state to broadcast; applies remote input with `setRemoteInput(slot, tx, ty)`.
  - `guest` — does not simulate; `applySnapshot(snap)` and renders; reports its pointer via `onLocalInput`.
  It imports nothing from Odoo: agnostic and testable.
- `static/src/js/sprites.js` — Pixel art sprite bank. Each sprite is a character grid (1 char = 1 logical pixel); symmetric ones are written at half width and mirrored (`mir: true`). Indices `4/5/6` are **tint**: re-coloured at draw time with the ship/enemy colour, so one hull serves the 4 slots and the enemy variants. API: `sprite(name, tint, px, flash)` (rasterized canvas, cached by name+colour+scale+flash), `drawSprite(g, name, x, y, {tint, px, flash, rot, alpha})`, `spriteSize(name)`, `pxFor(name, target)`. Imports nothing: usable outside Odoo. Sprites: `ship0..3`, `drone0/1`, `speedy0/1`, `tank0/1`, `sniper0`, `kami0`, `boss0`, `pupT/pupS/pupB/pupL`, `rock0/1`. Power-ups carry the glyph (T/S/bomb/+) drawn in the grid itself, so the sprite name is `"pup" + p.t` and the tint comes from `PUP_COLORS`: adding a power-up type means touching both places.
- `static/src/js/glossary.js` — `GLOSSARY`: data-only catalogue (groups → cards with `sprite`, `tint`, `px`, `label`, `sub`, `desc`) feeding the "Ships and enemies" panel in the menu. The tints are the engine's and the `desc` lines describe the **real AI** in `game_engine.js`: if you change behaviour (HP, points, firing pattern), review this file. It covers all 19 sprites in the bank.
- `static/src/js/menu_backdrop.js` — `MenuBackdrop(canvas)` class (`start()`/`destroy()`): animated backdrop for the start menu in "attract mode". Parallax star field + drifting enemies/asteroids + the 4 ships firing, all through `sprites.js`. It is **decorative**: it does not simulate, make sound, read input or touch the bus; it deliberately does not reuse `NeonStrikeEngine` (that would drag in audio, input and game over). It scales sprites with `zoom = clamp(width/680, 1, 1.6)` because the menu is wider than the game's logical space. Honours `prefers-reduced-motion` by painting a single frame.
- `static/src/js/neon_strike_game.js` — OWL component `NeonStrikeGame` (template `neon_strike.Game`). Screens `state.screen` = `menu | lobby | game`. Uses `rpc` (to `/neon/*`) and `bus_service` (NOT `orm`: `call_kw` is `auth="user"`). Creates/destroys the engine with `useEffect` when entering/leaving `game`. The host broadcasts a snapshot ~15 Hz (`/neon/state`); the guest forwards its pointer ~20 Hz (`/neon/input`). Subscribes to `ns_lobby|ns_start|ns_state|ns_input|ns_end`. It is **not** a client action: at the end of the file a `whenReady` mounts the component as a standalone OWL app (`makeEnv`+`startServices`+`mount` with `getTemplate`) on `.o_neon_strike_root` if present.
- `controllers/main.py` — `NeonStrikeController` (`http.Controller`). `GET /neon` (`auth="public"`, `website=True`, `sitemap=True`) renders `neon_strike.page` and makes sure the session token exists. JSON routes `auth="public"` (`/neon/create|join|start|input|state|score|solo_score|leave|scores`) operating with `sudo()` and resolving the player from `request.session["neon_token"]`.
- `static/src/xml/neon_strike_templates.xml` — OWL templates: `neon_strike.Game` (toolbar + menu with **nickname input** / lobby / game), `neon_strike.Glossary` and `neon_strike.Leaderboard`. `t-out` (not `t-esc`). The glossary is a **layer over the menu** (`state.glossary`), not another screen: that way it does not touch the `menu|lobby|game` state machine nor the engine and backdrop `useEffect`s.
- `views/neon_strike_page.xml` — QWeb `neon_strike.page`: uses `t-call="web.frontend_layout"` (only depends on `web`; brings frontend assets + session info) and contains `.o_neon_strike_root` (positioned full screen by CSS). Adds `generator`/`author` = Odoo meta via `additional_head` and removes the chrome with `no_header`/`no_footer`.
- `static/src/scss/neon_strike.scss` — Styles. `body.o_neon_strike_page`/`.o_neon_strike_root` full screen. Odoo purple `#714B67` (brand assets: https://www.odoo.com/page/brand-assets) in the toolbar/panels; dark stage. Menu/lobby/nickname/co-op badge styles. **Neon chrome**: `ns-scanline` (animated strip along the bottom edge of the toolbar), `ns-flicker` (logo glow) and `ns-pulse` (breathing glow on the primary CTA), plus the `ns-neon-button` mixin that gives `.ns_btn`/`.ns_cta` a light sweep on hover. All of it is switched off under `prefers-reduced-motion` at the end of the file.
- `models/neon_strike_score.py` — `neon.strike.score`: `user_id` (optional), `nickname`, `player_name` (computed stored: nickname or user name), `score`, `wave`, `mode` (solo/coop), `player_count`, `match_id`. `_order = "score desc, id asc"`.
- `models/neon_strike_match.py` — `neon.strike.match`: `code`, `access_token` (uuid, channel), `host_token`, `host_user_id` (optional/informational), `state` (lobby/playing/over), `participant_ids`, `MAX_PLAYERS=4`. API called by the controllers (with a token): `create_match`, `join_by_code`, `start`, `player_input`, `broadcast_state`, `submit_score`, `leave`. `_channel()` = `neon_strike_match_<access_token>`. Authority (start/broadcast/submit host only) is validated by comparing `host_token`.
- `models/neon_strike_participant.py` — `neon.strike.participant`: `match_id`, `token`, `nickname`, `user_id` (optional), `slot`, `name` (computed: nickname or user), `color` (computed by slot). Colours = the engine's SHIP_COLORS.
- `models/ir_websocket.py` — inherits `ir.websocket`, overrides `_build_bus_channel_list` to authorize `neon_strike_match_<access_token>` **by capability**: allowed when a match with that token exists (does not depend on `env.user`, everyone is the public user).
- `views/neon_strike_views.xml` — `ir.actions.act_url` to `/neon` (the "Play" menu opens the page) + `ir.actions.act_window` for the leaderboard + menus. List with `mode`/`player_count`. Odoo 19 uses `<list>`, NOT `<tree>`.
- `views/website_menu.xml` — `website.menu` record "Neon Strike" → `/neon` under `website.main_menu` (same pattern as `pingpong_3d/views/website_menu.xml`). This is what makes the game reachable from the public site navigation.
- `security/ir.model.access.csv` — score: `group_user` read; match/participant/score admin: `group_system`. The public does NOT go through the ORM directly (everything goes through controllers with `sudo()`), so there is no `group_user` ACL for match/participant and no record rules.

## Commands

```bash
# Install / first time
./odoo-bin -d neon_dev --addons-path=addons,/path/custom_addons -i neon_strike --dev=all

# After Python / XML view / security changes
./odoo-bin -d neon_dev --addons-path=... -u neon_strike --dev=all

# JS/SCSS/OWL templates: with --dev=all just refresh the browser
```

Quick check without starting Odoo:
```bash
python3 -m py_compile models/*.py __manifest__.py
python3 -c "import ast; ast.literal_eval(open('__manifest__.py').read().split('{',1)[0] and open('__manifest__.py').read()[open('__manifest__.py').read().index('{'):])"
node --check <(cat static/src/js/game_engine.js)  # copy to .mjs if it fails on ESM
```

## Project conventions

- Standard header in every file: `Part of Odoo. See LICENSE file...` — keep it in new files.
- Odoo branding is mandatory in generated UI/documents (purple #714B67, link to brand assets, author "Odoo" in the manifest). Do not remove it.
- Manifest version: `19.0.x.y.z` — bump the third digit for features, the fourth for fixes.
- JS: ES modules with `/** @odoo-module **/`, OWL 2 (hooks `onMounted`/`onWillUnmount`, `useState`, `useRef`, `useService`).
- The engine must NOT import anything from `@web/*`: keep the engine/component separation.
- All UI text, comments and docstrings in English.

## Backlog of ideas (by priority)

Done: **remote co-op up to 4 (Odoo bus, room by code)**, individual lives + revive, asteroids, combo x25, team score, **public `/neon` page without login (nickname + session token)**, pixel art sprites, in-menu glossary, animated menu backdrop.

1. **Entity interpolation on the guest**: today enemies/bullets are drawn straight from the snapshot (~15 Hz, a bit choppy); interpolate between the last two snapshots.
2. **Host migration**: if the host closes, the match ends; allow handing the role to another participant.
3. **Cleaning up old matches**: a cron deleting `neon.strike.match` in state `over` or abandoned (today they pile up as garbage since it is public).
4. **Anti-abuse**: rate limiting / validation in the public controllers (today anyone can create matches and post scores).
5. **Difficulties**: easy/normal/brutal selector scaling `wave*factor` in spawns and boss HP.
6. **Progression chart**: graph/pivot view over `neon.strike.score`.
7. **Achievements** and **tests** (`TransactionCase` + `HttpCase`/JS tour over `/neon`).

## Known gotchas

- **`.ns_btn` is global, not the toolbar's**: it is used in the toolbar but also in "Join" (menu), "Leave" (lobby) and "Close" (glossary). It must be defined at the `.o_neon_strike` level; if it is only nested inside `.ns_toolbar`, elsewhere it falls back to Bootstrap's `.btn` and comes out dark text on a dark panel (invisible button). The toolbar variant wins by specificity, not by order.
- **Sprites and multiplayer**: the chassis variant (`e.v` on enemies, `rk.v` on asteroids) is rolled when the entity is created and **travels in the snapshot**; otherwise host and guest would see different hulls. Same for `rt` (kamikaze rotation) and `am` (sniper charge), which the guest cannot recompute because it does not simulate. Asteroids no longer carry the `spin` polygon in the snapshot: they are drawn with `rock0/rock1`.
- **Sprite orientation**: player ships face up and enemies face down, exactly as the grid is written. When rotating the kamikaze, `Math.PI/2` is subtracted because its hull points at +Y, not +X.
- The `AudioContext` requires a user gesture: it is initialised on `pointerdown` (the `audio()` method). Do not move it to `onMounted`.
- **Fixed 680×540 logical space**: the whole simulation uses fixed `this.W/H`; the render scales to the canvas (`resize()` computes `scale/ox/oy`) and input maps physical→logical in `_ptr`. Do NOT tie `W/H` back to the container size: it would break host/guest coherence.
- **Host-authoritative**: only the host simulates. The guest is pure render; its `update()` is `_guestUpdate` (interpolates ship positions, regenerates local particles/audio from `snapshot.ev`). Do not put game logic in the guest branch.
- **Bus cost**: the host broadcasts ~15 Hz and each guest sends input ~20 Hz via RPC (each send = one `bus.bus` row + a websocket push). Acceptable for 2–4 players in dev; this is not low-latency netcode.
- **`website=True` on `/neon` is mandatory**: `web.frontend_layout` is inherited by `portal.frontend_layout` and, in turn, by `website.layout`, which uses `website.id` unguarded. That `website` only enters the render context if `request.is_frontend` is True, and that is decided by `routing.get('website')` (`http_routing/models/ir_http.py`). With `website=False` the page fails with `KeyError: 'website'` on any DB that has `website` installed. The flag is harmless if `website` is not there.
- **Public without login**: there is no `orm`/`call_kw` on the client (that is `auth="user"`). Everything goes through JSON controllers `auth="public"` with `sudo()`. Identity is `request.session["neon_token"]` (uuid), NOT `res.users`.
- **Channel by capability**: the channel is `neon_strike_match_<access_token>` (the match uuid). `_build_bus_channel_list` allows it when a match with that token exists; knowing the token means you joined. Do not use the `id` in the channel (it is guessable).
- **Standalone mounting**: the game is mounted with `mount(...)` on `.o_neon_strike_root` in `whenReady` (it is not a client action). It needs `bus_service` and `rpc` to be in `web.assets_frontend`.
- `player_name`/`participant.name` are **computed stored** (nickname or `user_id.name`): do not write them directly.
- The leaderboard uses `t-out` (not `t-esc`, deprecated in OWL 2).
- Odoo 19 API used from memory (source not mounted): `bus.bus._sendone`, `bus_service.addChannel/subscribe/unsubscribe`, `ir.websocket._build_bus_channel_list`, `mountComponent`/`makeEnv`/`startServices`/`getTemplate`, `<t t-call-assets ... t-js/t-css>`. Verify signatures when testing against a real 19.0.
