# CLAUDE.md — Neon Strike (Odoo 19 module)

Context for Claude Code. Read this before touching the code.

## What this is

Odoo 19.0 Community module running a space shooter (2D canvas, OWL 2) on a **public `/neon` page** published in the website menu (same as `pingpong_3d`), playable **without a login**: type a nickname and play. It supports **remote co-op for up to 4 players** over the Odoo bus (room by code, host-authoritative) on top of the single-player mode. Each player's identity is a **session token + nickname** (not `res.users`). Single global leaderboard in `neon.strike.score`. No external dependencies beyond `web`, `bus` and `website`.

The run structure is roguelite: **every 5 cleared waves each player keeps 1 of 3 permanent perks** (50 of them) until they die, a **boss every 4 waves** and a **colossal boss every 10** that is wider than the arena and pulls the camera back.

## Architecture

- `static/src/js/game_engine.js` — `NeonStrikeEngine(canvas, {onGameOver, onLocalInput, onAction, role, players, localSlot, names, hotseat})` class. ALL gameplay lives here: rAF loop, physics, enemies (drone/speedy/tank/**sniper**/**kami**/**5 bosses**/**5 colossi**), **asteroids** (`rocks`), power-ups (T/S/B/L), **perks + dash + actives**, **beams**, combos (capped at x25), particles, screen shake, slow-mo, synthesised audio. **N ships** in `this.ships` (array by slot), individual lives, going down (`down`) and reviving by flying next to the others. Simulated in a logical space **shaped like the window** (`_fitArena`, floor 680×540) and constant for the whole match, so coordinates are identical on every machine (the host's size travels in the snapshot). Roles:
  - `solo` — local single-player simulation.
  - `host` — simulates everything; `snapshot()` serialises a compact state to broadcast; applies remote input with `setRemoteInput(slot, tx, ty)`.
  - `guest` — does not simulate; `applySnapshot(snap)` and renders; reports its pointer via `onLocalInput`.
  It imports nothing from Odoo: agnostic and testable.
- `static/src/js/perks.js` — The **50 permanent perks** as data (`PERKS`, `PERK_INDEX`, `MAX_ACTIVES`, `rollOffers`). Each one carries `kind` (passive/conditional/active), `mods` (numbers summed into `ship.mods`) and/or `flags` (behaviour switches the engine branches on), plus `cd` for actives and `req: "coop"` for the two that need a second player. **The array order is the wire format** (the snapshot sends indexes): append at the end, never insert in the middle. Adding a perk = one entry here + the branch in `game_engine.js` if it carries a flag.
- `static/src/js/bosses.js` — The **5 regular bosses** as data (`BOSSES`, `bossForWave`): sprite, tint, collision radius and `hp`/`val` multipliers over the shared boss formula, plus the blurb reused by the glossary. They rotate on the waves that are a multiple of 4; `bossForWave` skips the ones a colossus takes over (multiples of 20) **without losing its place in the rotation**, so all five actually show up. Their AI lives in `_updateBoss` + `_bossWarden/_bossLancer/_bossHive/_bossPrism`, keyed by index.
- `static/src/js/boss_animator.js` — `BossAnimator` + `BOSS_ANIM`: the **animation of the 5 regular bosses**, ported from the "Bullet-hell boss animator" design study. **Render only**, same contract as [ship_flight.js](static/src/js/ship_flight.js). Per boss: DREADNOUGHT leans into its sweep, breathes, runs two rear plumes and throws a burst ring plus a recoiling muzzle flash; WARDEN's armour plates slide out and dim as the shield drops while a gapped curtain rotates and the core pulses through the hurt window; LANCER tilts, stretches into its dive and leaves afterimages; HIVE bobs, chases a light along the rim and flares the bay that actually opened; PRISM collapses to a pinch on every teleport, leaves a shockwave behind and spins a three-armed spiral. **State lives in `engine._bossAnims`, keyed by boss index, never on the enemy** — a guest rebuilds `this.enemies` from every snapshot, which would reset the pose ~15 times a second. `_updateBossAnims` runs from **both** `update()` (after `_updateBeams`, because the LANCER charge glow reads their `warn`) and `_guestUpdate()`. Three deliberate departures from the study: the hulls stay `boss0..boss4` (its own five grids would be an art swap, not an animation), **no lance beam** (the engine owns it, telegraph and hitbox, and it travels as `bm` — a second one would draw light where the damage is not) and **no hit flash or death dissolve** (`e.flash` already does the first and travels as `f`; the second would need the corpse to outlive `killEnemy`, which is gameplay). Reference speeds were **read off the real AI**, not carried over: the study's 90 px/s saturated instantly against a dreadnought that sweeps at 209.
- `static/src/js/colossi.js` — The **5 colossal bosses** as data (`COLOSSI`, `colossusForWave`): sprite, tint, logical width (all wider than the 680 arena), camera `zoom`, hit points, score value and the blurb reused by the glossary. Their AI lives in `_updateColossus` keyed by index, same order. **AEGIS-01 no longer uses `speed`**: it flies `aegis_motion.js`, and `descend.restY` there mirrors its `y`.
- `static/src/js/aegis_motion.js` — `AegisMotion` + `AEGIS_MOTION`: the **motion profile of AEGIS-01**, ported from the "AEGIS-01 Study" design study. This is the one thing a design study is allowed to write a position with: it runs on the **host**, inside `_updateColossus`, and the result travels in the snapshot like any other AI. It replaces a constant 30 px/s slide that flipped direction instantly at the ends of a 210 px lane with acceleration-limited travel (the brake is deliberately weaker than the accel, so it overshoots and settles), a pull toward the centre of mass of the **live** ships capped at 46 px and slewed at 9 px/s so it never becomes a chase, a brace that plants the hull for the 0.75 s of the curtain telegraph and lifts it 5 px, one bounded shove during the enrage beat, and a 30 px sag as the hull is chewed down — bounded, because the curtain spawns at `y + 82.8` and falls at 144 px/s, so every px of descent is reaction time taken off the player. Deterministic and `dt`-driven (`mv / 60`), so pause freezes it, slow-mo slows it and an EMP `stun` stops it dead. Measured over a 120 s fight: |v| peaks at 58 px/s, a tick never moves the hull a whole pixel, x stays inside ±140 px of the field centre and y inside 146-180.
- `static/src/js/colossus_animator.js` — `ColossusAnimator` + `COLOSSUS_ANIM` + `COLOSSUS_ANIM_KINDS`: the **animation of the colossi**, from the same study. **Render only**, same contract as [boss_animator.js](static/src/js/boss_animator.js). Only **AEGIS** has a section so far; `COLOSSUS_ANIM_KINDS` is what decides, and any colossus without one falls through to the plain hull draw. It leans into its drift (capped at 0.028 rad — a slab 828 px wide pulls apart past ~0.03), breathes harder as it takes damage, recoils on the salvo and flashes the two barrels at ±187 px, lights the bottom edge cell by cell as the curtain leaves it, hangs plumes off the lowest cell of each column tilted against the drift, burns out 30% of its dark cells and vents sparks under 30% hull, and — the one that matters — **opens a shutter over the hole in the next curtain**, because `gap` is decided one curtain ahead and travels as `gp`. State lives in `engine._colossusAnims`, keyed by colossus index, never on the enemy; `_updateColossusAnims` runs from **both** `update()` and `_guestUpdate()`, and `_colossusCue` mirrors the one-shots (`curtain`, `salvo`, `rage`) as `cfx` events. Four departures from the study: the hull stays `colossus0` from the sprite bank (the study painted its own grid cell by cell; here the cached raster is one `drawImage` and only the cells an effect changes are painted on top — 261 draw calls a frame at worst instead of 2576), **no lance** (the study gave AEGIS an eye firing a column of light; the engine has no such attack and a beam with no hitbox shows light where the damage is not), **no hit flash** (a colossus is under fire every frame) and the **enrage beat is an envelope started by the `rage` cue**, because `e.hold` does not travel.
- `static/src/js/ships.js` — The 4 flyable hulls as data (`SHIPS`, `SHIP_COLORS`, `hullIndex`): sprite, tint and the blurb reused by the glossary and by the menu picker. **Cosmetic only** — every hull flies, shoots and takes damage the same. The player picks one in the menu (kept in `localStorage` under `neon_strike_hull`) and it reaches the engine as `hulls[slot]`; `_hullFor`/`_tintFor` resolve it. The colour follows the hull when you are alone but goes back to the slot palette with 2+ ships, because in co-op the colour is what tells the ships apart. **The array order is wire format**: `SHIP_COLORS` is indexed by slot by both the engine and `neon.strike.participant.color` (Python), and the hull travels in the snapshot as `hl`. Append at the end.
- `static/src/js/ship_flight.js` — `ShipFlight` + `SHIP_FLIGHT`: the **flight animation** of the player hulls, ported from the "Animaciones de naves para bullet hell" design study. **Render only**, like the camera zoom and the backdrop: the engine owns the position and this only *watches* how it changes (`observe(x, y, dt)`), turning motion into banking (5 tilt frames with hysteresis), an engine flame that grows with the throttle, retro-thrusters when braking and a barrel roll on brusque reversals. `observe` is called from the **simulation** (`_moveShip` on host/solo, `_guestUpdate` on a guest), never from the draw, so a paused game freezes the pose; because it is derived from a position both roles already have, host and guest animate the same flight with **zero bytes on the bus**. `drawShip` only reads it. All the numbers live in `SHIP_FLIGHT` and were **re-measured for this arena** (680 px wide, pointer follow of 20% per frame), not carried over from the study's much larger canvas: a smooth circle flips the bank at ~260 px/s and must not roll, a hard weave at 600+, a flick across the arena at 5000+, and the bank-swing ceiling here is ~0.28. `rollFlat` stops the roll from ever collapsing the hull to a line — the study could afford that, a bullet hell cannot.
- `static/src/js/backgrounds.js` — The **27 places** a run flies through (`BACKGROUNDS`, `backgroundForWave`, `Backdrop`): deep space, nebulae, a black hole, a wormhole, a supernova, a pulsar, planet flybys, six planet surfaces (gas/ice/lava/ocean/jungle/desert/storm), a ship graveyard, an orbital station, an asteroid belt… One per wave, **in order, cycling**. `backgroundForWave` is pure, which is what lets host and guests paint the same sky with **zero bytes on the bus**; the backdrop is never simulated and never enters the snapshot. Each entry names a `kind` (the painter) plus params, so 27 places come out of 18 painters. A painter may implement `init` (state), `paint` (static art, **baked once** into an offscreen canvas at half resolution), `update` + `live` (per-frame). Only put in `live` what genuinely moves: it runs at 60 fps behind the whole game. Painters draw in **logical arena coordinates**, over the box the camera reaches when it pulls back for a colossus. The black hole is the one thing here with real physics: Newtonian pull on its dust, softened at short range, with anything crossing the horizon respawning at the rim.
- `static/src/js/sprites.js` — Pixel art sprite bank. Each sprite is a character grid (1 char = 1 logical pixel); symmetric ones are written at half width and mirrored (`mir: true`). Indices `4/5/6` are **tint**: re-coloured at draw time with the ship/enemy colour, so one hull serves the 4 slots and the enemy variants. API: `sprite(name, tint, px, flash)` (rasterized canvas, cached by name+colour+scale+flash), `drawSprite(g, name, x, y, {tint, px, flash, rot, alpha})`, `spriteSize(name)`, `spriteGrid(name)` (the expanded character grid, mirroring resolved — shared and cached on the definition, so **read only**; `colossus_animator.js` uses it to know which cells an effect may touch), `pxFor(name, target)`, `bankSprite(name, tint, px, level)`. **The tilt frames are not image files**: `bankSprite` builds them from the hull's own pixel grid, one logical pixel column at a time (columns compressed towards the centre, each scaled vertically by how near that side now is), which is what keeps the sprite bank the single source of hull art and keeps the per-slot tint working — 20 PNGs could do neither. Levels are -2..2, level 0 returns the flat sprite, and the result is cached like `sprite()`. Imports nothing: usable outside Odoo. Sprites: `ship0..3`, `drone0/1`, `speedy0/1`, `tank0/1`, `sniper0`, `kami0`, `boss0`, `colossus0..4` (84-100 px grids, drawn 780-1000 logical px wide), `pupT/pupS/pupB/pupL`, `rock0/1`. Power-ups carry the glyph (T/S/bomb/+) drawn in the grid itself, so the sprite name is `"pup" + p.t` and the tint comes from `PUP_COLORS`: adding a power-up type means touching both places.
- `static/src/js/glossary.js` — `GLOSSARY`: data-only catalogue (groups → cards with `sprite`, `tint`, `px`, `label`, `sub`, `desc`) feeding the "Ships, enemies and powers" panel in the menu. The **colossal boss group is generated from `colossi.js`**, and the perk section is built in the OWL component (`perkGroups`) straight from `PERKS`, so neither can drift from the engine. The tints are the engine's and the `desc` lines describe the **real AI** in `game_engine.js`: if you change behaviour (HP, points, firing pattern), review this file. It covers all 19 sprites in the bank.
- `static/src/js/menu_backdrop.js` — `MenuBackdrop(canvas)` class (`start()`/`destroy()`): animated backdrop for the start menu in "attract mode". Parallax star field + drifting enemies/asteroids + the 4 ships firing, all through `sprites.js`. It is **decorative**: it does not simulate, make sound, read input or touch the bus; it deliberately does not reuse `NeonStrikeEngine` (that would drag in audio, input and game over). It scales sprites with `zoom = clamp(width/680, 1, 1.6)` because the menu is wider than the game's logical space. Honours `prefers-reduced-motion` by painting a single frame.
- `static/src/js/neon_strike_game.js` — OWL component `NeonStrikeGame` (template `neon_strike.Game`). Screens `state.screen` = `menu | lobby | game`. Uses `rpc` (to `/neon/*`) and `bus_service` (NOT `orm`: `call_kw` is `auth="user"`). Creates/destroys the engine with `useEffect` when entering/leaving `game`. The host broadcasts a snapshot ~15 Hz (`/neon/state`); the guest forwards its pointer ~20 Hz (`/neon/input`). Subscribes to `ns_lobby|ns_start|ns_state|ns_input|ns_end`. It is **not** a client action: at the end of the file a `whenReady` mounts the component as a standalone OWL app (`makeEnv`+`startServices`+`mount` with `getTemplate`) on `.o_neon_strike_root` if present.
- `controllers/main.py` — `NeonStrikeController` (`http.Controller`). `GET /neon` (`auth="public"`, `website=True`, `sitemap=True`) renders `neon_strike.page` and makes sure the session token exists. JSON routes `auth="public"` (`/neon/create|join|start|input|state|score|solo_score|leave|scores`) operating with `sudo()` and resolving the player from `request.session["neon_token"]`.
- `static/src/xml/neon_strike_templates.xml` — OWL templates: `neon_strike.Game` (toolbar + menu with **nickname input** / lobby / game), `neon_strike.Glossary` and `neon_strike.Leaderboard`. `t-out` (not `t-esc`). The glossary is a **layer over the menu** (`state.glossary`), not another screen: that way it does not touch the `menu|lobby|game` state machine nor the engine and backdrop `useEffect`s.
- `views/neon_strike_page.xml` — QWeb `neon_strike.page`: uses `t-call="web.frontend_layout"` (only depends on `web`; brings frontend assets + session info) and contains `.o_neon_strike_root` (positioned full screen by CSS). Adds `generator`/`author` = Odoo meta via `additional_head` and removes the chrome with `no_header`/`no_footer`.
- `static/src/scss/neon_strike.scss` — Styles. `body.o_neon_strike_page`/`.o_neon_strike_root` full screen. Odoo purple `#714B67` (brand assets: https://www.odoo.com/page/brand-assets) in the toolbar/panels; dark stage. Menu/lobby/nickname/co-op badge styles. **Neon chrome**: `ns-scanline` (animated strip along the bottom edge of the toolbar), `ns-flicker` (logo glow) and `ns-pulse` (breathing glow on the primary CTA), plus the `ns-neon-button` mixin that gives `.ns_btn`/`.ns_cta` a light sweep on hover. All of it is switched off under `prefers-reduced-motion` at the end of the file.
- `models/neon_strike_feedback.py` — `neon.strike.feedback`: bug reports and ideas sent from the public page (`kind`, `message`, `image` as `fields.Image`, `state` for triage, `note`). It also stores the **context of the run** (`wave`, `score`, `mode`, `perks`) and the author as `nickname` + session `token`, same identity model as scores. Backend menu *Neon Strike → Feedback*.
- `models/neon_strike_score.py` — `neon.strike.score`: `user_id` (optional), `nickname`, `player_name` (computed stored: nickname or user name), `score`, `wave`, `mode` (solo/coop), `player_count`, `duration`, `play_time`, `match_id`. `_order = "score desc, id asc"`. **`duration` is in hours** (Float, `float_time` widget) even though the client sends seconds: the controllers divide by 3600. `play_time` is computed stored as `duration * player_count`, so summing it over every record is the total **human** time played (a 10 min run for 4 counts as 40 min) — that is the internal statistic, surfaced as the list footer sum and the *Time Played* pivot menu.
- `models/neon_strike_match.py` — `neon.strike.match`: `code`, `access_token` (uuid, channel), `host_token`, `host_user_id` (optional/informational), `state` (lobby/playing/over), `participant_ids`, `MAX_PLAYERS=4`. API called by the controllers (with a token): `create_match`, `join_by_code`, `start`, `player_input`, `broadcast_state`, `submit_score`, `leave`. `_channel()` = `neon_strike_match_<access_token>`. Authority (start/broadcast/submit host only) is validated by comparing `host_token`.
- `models/neon_strike_participant.py` — `neon.strike.participant`: `match_id`, `token`, `nickname`, `user_id` (optional), `slot`, `name` (computed: nickname or user), `color` (computed by slot). Colours = the engine's SHIP_COLORS.
- `models/ir_websocket.py` — inherits `ir.websocket`, overrides `_build_bus_channel_list` to authorize `neon_strike_match_<access_token>` **by capability**: allowed when a match with that token exists (does not depend on `env.user`, everyone is the public user).
- **The public feedback endpoint is the only place the game accepts a file**: `/neon/feedback` caps the message (4000 chars) and the screenshot (3 MB decoded), throttles per session (15 s between reports, 20 per session) and, most importantly, **validates the bytes, not the declared mime type** (`IMAGE_MAGIC`) — an SVG, an HTML data URL or an executable renamed to `.png` are all rejected. If you add a format, add its magic bytes too.
- **The engine's key listener is on `window`**, so it sees keys typed in the UI around the canvas. `_keyDown` bails out on `INPUT`/`TEXTAREA`/`contentEditable` targets: without that, typing a space in the feedback box dashes the ship and never reaches the textarea.
- **Odoo 19 search views**: the group-by block is a **bare `<group>`**. `string` and `expand` are gone (`<group expand="0" string="Group By">` fails module load with *Invalid view ... definition*); the RNG in `odoo/addons/base/rng/common.rng` is the authority and no core view uses them any more. Date filters use the domain literals (`[('create_date', '>=', 'today')]`), not `datetime.datetime.combine(context_today(), ...)`.
- **Verifying views offline**: the Odoo 19 worktree is readable at `~/odev/worktrees/19.0/odoo`, and `odoo/addons/base/rng/*.rng` describes every arch. Neither `lxml` nor `xmllint` is available in the sandbox, so a full RelaxNG pass is not possible — read the grammar and compare against a real core view of the same type before shipping an arch change.
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

Done: **remote co-op up to 4 (Odoo bus, room by code)** (hidden, see above), individual lives + revive, asteroids, combo x25, team score, **public `/neon` page without login (nickname + session token)**, pixel art sprites, in-menu glossary, animated menu backdrop, **hull picker**, **27 backgrounds, one per wave**, **flight animation (banking, flame, retro-thrusters, barrel roll)**, **per-boss animation**, **bullet-hell layer (small hitbox + focus + grazing, telegraphs, bullet colour code, boss phases, hitstop, bomb stock, risk scoring)**.

- **Boss cosmetic cues travel as `bfx` on the `ev` channel**: `_bossCue(e, name, data)` fires the local effect and mirrors it to the guests, for the three things that cannot be observed from position alone (dreadnought burst, aimed salvo, hive launch) plus the prism shockwave. The alternative — deriving them on the guest from the AI's own arithmetic (`floor(e.t) % 85 === 0`) — would desync the animation the first time anyone retunes a boss. `_playEvent` creates the animator on demand, because the cue can arrive in the same snapshot that introduces the boss.

- **The menu backdrop still flies flat**: `menu_backdrop.js` draws its four attract-mode ships with `drawSprite`, so they do not bank. Wiring `ShipFlight` in there is easy (it needs nothing from the engine) but it was deliberately left out of the flight-animation change.

0. **Co-op lag** (blocks putting multiplayer back in the UI): the ~15 Hz snapshot
   over the bus is what makes it feel bad. Interpolation (below) is part of it,
   but so is snapshot size and the RPC round trip per input.
1. **Entity interpolation on the guest**: today enemies/bullets are drawn straight from the snapshot (~15 Hz, a bit choppy); interpolate between the last two snapshots.
2. **Host migration**: if the host closes, the match ends; allow handing the role to another participant.
3. **Cleaning up old matches**: a cron deleting `neon.strike.match` in state `over` or abandoned (today they pile up as garbage since it is public).
4. **Anti-abuse**: rate limiting / validation in the public controllers (today anyone can create matches and post scores).
5. **Difficulties**: easy/normal/brutal selector scaling `wave*factor` in spawns and boss HP.
6. **Progression chart**: graph/pivot view over `neon.strike.score`.
7. **Achievements** and **tests** (`TransactionCase` + `HttpCase`/JS tour over `/neon`).
8. **Perk synergies / rarity**: today every perk is equally likely and stacking is unbounded; tiers or exclusions would deepen the builds.
9. **Reroll or banish** in the perk phase, and showing what your team-mates picked.

## Perks, dash and colossi (added in 19.0.5.0.0)

- **Perk phase**: after clearing a wave where `wave >= nextPerkWave` (steps of 5), `_openPerkPhase()` switches `state` to `"perk"`, rolls 3 offers **per ship** and freezes the field. Everyone picks (`pickPerk(slot, index)`); after `PERK_TIMEOUT` (20 s) the pending ones take the first card. Perks are per run: `reset()` wipes `ship.perks`.
- **Derived ship state**: `_recalcPerks(sp)` rebuilds `sp.mods` (numbers) and `sp.flags` (booleans) from `sp.perks`; nothing else may write them. Conditional perks are resolved live in `_fireDelay`, `_bulletDmg` and `_impactDmg`, never baked into the ship.
- **Dash (Space)**: free for everyone, no perk needed. `sp.dash > 0` means **intangible** — `hurtShip` and every collision check bail out. Six perks modify it (cooldown, charges, trail, ram, reflect, refund).
- **Actives (1-4)**: `sp.actives` is derived from the perks in pick order, capped at `MAX_ACTIVES`; `useActive(slot, i)` checks the cooldown and `_fireActive` does the work.
- **Remote input**: dash, actives and perk picks are **one-shot actions**. They travel in the `action` field of `/neon/input` (`dash`, `act<n>`, `perk<n>`) and the host applies them through `setRemoteAction`. The x/y in that payload is ignored, because the pointer queue keeps only the last position and would drop actions.
- **Camera**: `this.zoom` is a **render-only** concern (plus `_ptr`, which must invert the same `scale * zoom`). `_fitZoom` computes it **from the local canvas** so the playable field (and the whole boss hull, with a little air) exactly fills that screen — each client frames its own window, and nothing about the camera travels over the bus. It is recomputed on `resize()`. The HUD is drawn in its own unzoomed transform (`hudOx/hudOy`) so it never shrinks.
- **The playable field is dynamic**: `this.field` (read off the colossus, `COLOSSI[k].field`, 1.34-1.5) widens X by that factor and Y by `_fieldY` (60% of it, because screens are wide and that is what ends up filling them) widens the arena while one is alive, and `fx0/fx1/fy0/fy1` are the live bounds — **they can be negative**. Every "did it leave the field" check (ship clamp, bullets, enemy bullets, rocks bouncing, capsules, enemies falling out) and the AEGIS curtain / VULCAN rock barrage use those, never `0..W/H`. Both `zoom` and `field` snap to their target once within 0.002, otherwise the exponential easing leaves the walls fractionally off forever.
- **Wave pacing**: `spawnWave` **queues** the wave in `this.pending` and `_updateSpawns` releases it, bringing the next spawn forward whenever the field drops under `minAlive` (`3 + players + wave/5`, capped at 11). Do not go back to parking the whole wave above the top of the screen: the tail took ~12 s to fly in and the wave could not end until it did. Two more valves: stragglers get `e.rush` (1.9x speed) once the queue is empty and the wave is old, and a boss on its own gets a thin escort stream.
- **Run timer**: `engine.playMs` counts **wall clock**, not frames (`_tickClock`), so a 30 fps machine reports the same duration as a 60 fps one. It only advances while `playing` and not paused, which leaves out the pause screen and the perk phase, and single gaps are clamped to 100 ms so a backgrounded tab does not count as play time. It reaches the server through `onGameOver({seconds})` → `/neon/score` / `/neon/solo_score`.
- **Pause**: `Esc` (or the toolbar button) → `togglePause()` → the `pause` action, so a guest asks the host instead of freezing only itself. `_loopFn` returns right after the pause check, meaning **nothing** ticks while paused; the state travels as `pz` in the snapshot and `_setPaused` fires the `onPause` callback the OWL toolbar listens to.
- **All enemy damage goes through `_damageEnemy(e, dmg, killer)`**: it is the only place that applies WARDEN's armour (x0.35) and calls `killEnemy`. Never write `e.hp -=` anywhere else, or a new damage source will quietly ignore the armour.
- **Boss variety**: `mkEnemy("boss")` reads `bossForWave` and copies the radius, tint, hull and payout from `BOSSES[k]`; the sprite comes from `ENEMY_SPRITES.boss` (generated from the same catalogue) via the usual `e.v` variant. `k` travels as `ck` in the snapshot and `armor` as `ar`, so the guest rebuilds the right hull and draws the shield ring.
- **Supply drops**: a boss fight kills the capsule flow (no small fry, no drops). `_updateSupply` drops one every ~7 s while `_bossPresent()`, and every boss sheds one per 25% of health lost (`e.dropAt`). Both use `dropPup(x, y, true)`, which rolls on the `supply` weights.
- **14 capsule types**: the original T/S/B/L plus R rapid, V overcharge, P piercing, H homing, D wingman, G phase, F freeze, X overload, C combo and Y payday. Adding one means four places: a `pup<X>` sprite, an entry in `PUP_COLORS`, a weight in **both** `PUP_TABLE` rows and a branch in `_applyPup` (+ `PUP_BUFFS`/`BUFF_KEYS` if it is timed). The timed ones live in `ship.buffs` (frames left) and are read **next to** `mods`/`flags`, which stay perks-only; they refresh instead of stacking and travel as the `bf` bitmask in the snapshot, so `BUFF_KEYS` is wire format — append only.
- **Colossus hull**: `d.hp + wave * 28`, halved-ish base so the wave term carries the growth — meeting the same colossus on a later cycle (they repeat every 50 waves) is a real step up. Tuned for roughly 15-28 s solo on the first encounter.
- **A colossus never uses the `flash` sprite**: it is hit every frame, so the white silhouette would leave it permanently washed out (and it would double the sprite cache for a ~850x260 canvas). Its hit feedback is the impact burst plus the top health bar.
- **Colossus hitbox is a box** (`hw`/`hh`), not a circle: use `_enemyHit(e, x, y, pad)` for bullets and ships. `e.r` stays as a rough circle for splashes, trails and the black hole. `_isBoss(e)` covers boss + colossus wherever the old `type === "boss"` check meant "big".
- **Beams** (`this.beams`) always telegraph first (`warn` frames of a dashed sight line) and only then damage. `src` anchors them to a hull so they follow it; they are removed when the owner dies (`killEnemy`) and on the perk phase.
- **Balance numbers live in the data files**, not the engine: perk `mods` in `perks.js`, colossus `hp`/`zoom`/`w` in `colossi.js`. Colossus hit points were tuned for a 25-45 s fight with a reasonable build (`hp + wave * 20 + 50% per extra player`).

## Bullet-hell layer (added in 19.0.11.0.0)

The game had every system a shmup needs except the ones that make one readable
and fair. This is that pass, and most of it is a contract between what the
player is shown and what the simulation does.

- **The hitbox is `SHIP_HIT_R` (6.5) and nothing else.** It used to be 16.5 for
  bullets, 13 for hulls, 12 for rocks and 8 for beams -- four different shapes,
  all of them at least as wide as the 32 px sprite, i.e. the opposite of the
  genre. Every one of them now goes through **`_hitR(sp)`**, so there is a
  single circle to learn, and `_drawHitbox` draws it. If you add a new threat,
  measure it against `_hitR`, never against a literal.
- **The dot is drawn even while the hull blinks.** `drawShip` used to `return`
  early during invulnerability; it now skips only the hull, so where you are is
  never ambiguous. The blink itself doubles in rhythm for the last ~25 frames
  and an arc drains around the ship: the old flat 4-on/4-off was identical on
  the first frame of the window and on the last, which is what made "I was hit
  right after my invulnerability" feel like the game cheating.
- **`_setInv(sp, frames)` is the only way to start an invulnerability window**,
  because it also records `invMax`, which is what the arc and the blink ramp
  read. Never write `sp.inv =` directly.
- **Focus (Shift)**: `sp.focus` multiplies the movement lerp by `FOCUS_FACTOR`
  and switches the hitbox to its explicit form. It is the one *held* input in
  the game: host/solo read `this.keys.shift` every frame in `update()`, and a
  guest -- whose channel only carries one-shot actions -- sends `focus1`/`focus0`
  edges, with `fc` mirrored in the snapshot so a lost edge is visible.
- **Grazing**: the enemy-bullet loop already walked every bullet against every
  ship, so the graze test is a second radius on the same distance. `b.gz` is a
  per-ship bitmask so a bullet counts once, and it is skipped while dashing or
  invulnerable (otherwise the safest move would also be the best-scoring one).
  Every `GRAZE_PER_COMBO` grazes is a combo step: that is the payment for
  flying into a pattern instead of camping the bottom of the arena.
- **`EB_KINDS` is the bullet vocabulary** (spread / aimed / lance / curtain).
  `_eb(x, y, vx, vy, k)` takes the kind at the point of fire and it travels as
  the 3rd slot of `eb` in the snapshot -- **wire format, append only**. Adding a
  pattern means choosing its kind; adding a kind means an entry here plus the
  line in the glossary note that teaches it.
- **`_every(e, key, period, mv)` replaced `Math.floor(e.t) % n === 0`.** The old
  form fired two or three frames in a row whenever `e.t` advanced by less than
  1 per frame, which is exactly what slow motion (0.35) and Time Warp (0.4) do:
  the radial burst tripled itself right after you were hit. Never go back to
  the modulo. `first` seeds the countdown (the old `% 55 === 27` offsets), and
  the boss base seeds `a1: 70` so nothing fires untelegraphed on arrival.
- **Telegraphs**: `_tel(e, left, kind)` turns the frames left on a pattern timer
  into `tel` (0..1) and `telK`, and `_drawTelegraph` draws it. Call `_tel`
  *before* `_every` consumes the timer. The strongest warning wins, so a boss
  running three timers still shows one cue. `tl`/`tk` travel in the snapshot:
  a guest does not simulate, and deriving the telegraph from the AI's own
  arithmetic would drift the first time anyone retunes a boss -- the same
  argument that already justifies `bfx`.
- **The curtain gap is decided one curtain ahead** (AEGIS and WARDEN), so the
  telegraph can point at it and `gp` can carry it. Where the hole is *is* the
  attack. The marker is deliberately narrower (52) than the real gap (62-66):
  what it points at is always safe. AEGIS has a second reader for it: the
  shutter `colossus_animator.js` opens on the hull above the hole, clamped to
  the hull edge when the gap falls past it (the hull is 828 px, the field 911).
- **Boss phases are a health threshold, not a stopwatch.** `_bossRage(e, mv, at)`
  flips `raged` at `BOSS_RAGE_AT` / `COLOSSUS_RAGE_AT`, sets `hold` (a beat with
  no fire) and fires a `rage` event. It is deliberately **not** a `bfx` cue:
  `BossAnimator.emit` has no pose for it and the bus is the thing that makes
  co-op feel bad. Both health bars now draw a tick at the threshold.
- **Hitstop** (`this.hitstop`) freezes the whole simulation for a few frames on
  an impact, checked in `_loopFn` before the slow-motion clock. It never runs on
  a guest (it would only stutter the interpolation) and is skipped while
  `bombing`, or a bomb sweeping thirty hulls would stop the game thirty times.
- **Bombs are a stock**: `sp.bombs`, spent with X (`useBomb`), refilled by the B
  capsule. `bomb()` sets `this.bombing`, which `killEnemy` reads to pay half and
  skip the combo -- a bomb is a way out, not a scoring move.
- **Risk pricing**: point-blank kills pay up to +50%, clearing a wave untouched
  pays a bonus in `spawnWave`, and being touched at all clears `waveClean` and
  the banked grazes. The `Y` capsule was multiplied by the combo outright (at
  wave 30 with x25 a single capsule paid more than a boss); it now scales with
  it. `C` went from +6 combo to +3 now that grazing feeds the same ladder.
- **Density has peaks and valleys again.** The spawn logic is built so pressure
  never drops *inside* a wave, which leaves the gaps *between* them as the only
  place to breathe: 26 frames -> 48, and 110 after a boss. `killEnemy` also
  clears `ebullets` when a boss dies -- dying to a wreck's leftovers during the
  celebration slow motion was the least fair death in the game. In exchange the
  in-wave ceiling was raised (`minAlive` 11 -> 14, drip floor 10 -> 7), which it
  had been hitting since wave 24.
- **Small fry scale in hull, not only in speed** (`_hp` in `mkEnemy`, one step
  per type). They used to keep the same 1-4 hp for a whole run while the player
  stacked damage perks every 5 waves, so past wave ~25 a wave was longer but
  never harder.
- **`deaths` is persisted** (`neon.strike.score.deaths`, through `/neon/score`
  and `/neon/solo_score`): the same score with two deaths and with twenty are
  not the same run. It also softens the next waves a little (`relief` in
  `spawnWave`), as a floor under the spiral where you die, lose the combo, and
  die again to the wave you were already struggling with.
- **`BG_SCRIM`** is a veil drawn between the backdrop and the play field. Nine
  of the 27 places paint in the same warm reds as enemy fire and scatter 1-3 px
  motes the exact size of a bullet core, all in `lighter`: on the lava world or
  under a supernova a shot and the scenery were literally the same pixels.

Balance knobs, if this needs retuning: `SHIP_HIT_R`, `GRAZE_R`,
`GRAZE_PER_COMBO`, `FOCUS_FACTOR`, `TELEGRAPH_FRAMES`, the `HITSTOP_*` set, the
`_hp` steps in `mkEnemy` and the `500 * wave` in the no-damage bonus.

## Multiplayer, temporarily hidden

Remote co-op is **hidden, not removed**: the snapshot broadcast lags too much on
a real connection. `MULTIPLAYER_ENABLED = false` in `neon_strike_game.js` is the
only switch — it gates the UI (create match, join code, lobby, the room label in
the toolbar, the co-op wording) and the bus subscription. Controllers, models,
bus channels, `ir.websocket` and the host/guest engine roles are all untouched
and still tested by flipping the flag back to `true`. `pingpong_3d` carries the
same flag with the same meaning (there it also hides the `?net=loopback` bench).
When co-op comes back, the one thing that needs wiring is the **hull choice**:
today only the local player's hull reaches the engine, so on a host the other
ships fall back to the default hull. It has to travel through the lobby
(`neon.strike.participant`) next to the nickname.

## Known gotchas

- **The side panel owns its overflow**: `.ns_leaderboard` is `min-height: 0` + `overflow-y: auto` and `.ns_body` clips. Without that, a full leaderboard plus the hint block is taller than the column, spills out of `.o_neon_strike_root` (fixed, `overflow: hidden`) and takes the canvas down with it. The row cap is also enforced client-side (`MAX_SCORES`, `topScores`), not only by the `/neon/scores` query.
- **`.ns_btn` is global, not the toolbar's**: it is used in the toolbar but also in "Join" (menu), "Leave" (lobby) and "Close" (glossary). It must be defined at the `.o_neon_strike` level; if it is only nested inside `.ns_toolbar`, elsewhere it falls back to Bootstrap's `.btn` and comes out dark text on a dark panel (invisible button). The toolbar variant wins by specificity, not by order.
- **Sprites and multiplayer**: the chassis variant (`e.v` on enemies, `rk.v` on asteroids) is rolled when the entity is created and **travels in the snapshot**; otherwise host and guest would see different hulls. Same for `rt` (kamikaze rotation) and `am` (sniper charge), which the guest cannot recompute because it does not simulate. Asteroids no longer carry the `spin` polygon in the snapshot: they are drawn with `rock0/rock1`.
- **Sprite orientation**: player ships face up and enemies face down, exactly as the grid is written. When rotating the kamikaze, `Math.PI/2` is subtracted because its hull points at +Y, not +X.
- The `AudioContext` requires a user gesture: it is initialised on `pointerdown` (the `audio()` method). Do not move it to `onMounted`.
- **The logical space is fixed per match, not fixed at 680×540**: the whole simulation uses `this.W/H`; the render scales to the canvas (`resize()` computes `scale/ox/oy`) and input maps physical→logical in `_ptr`. `_fitArena` shapes the arena like the window (`BASE_W`/`BASE_H` = the old 680×540 as the floor, aspect clamped to `MIN_ASPECT`..`MAX_ASPECT`) so a wide screen gets playable room instead of black bars: **only the long side grows**, the short one keeps its base size. Anything derived from the size is rebuilt by `_onArenaResized` (field bounds, star field, backdrop, ships clamped back inside). The host/guest invariant is still there and is what makes this safe: the arena travels in the snapshot as `aw`/`ah`, a **guest never sizes its own** (`resize()` skips `_fitArena` for it) and adopts the host's in `applySnapshot`. Enemy counts per wave were deliberately *not* scaled with the width: the extra room is dodging room, and scaling spawns would tilt a global leaderboard by screen size. The colossus zoom does **not** change the arena: the camera simply shows more world around it (the purple frame is the field boundary, now drawn on every frame).
- **Host-authoritative**: only the host simulates. The guest is pure render; its `update()` is `_guestUpdate` (interpolates ship positions, regenerates local particles/audio from `snapshot.ev`). Do not put game logic in the guest branch.
- **Bus cost**: the host broadcasts ~15 Hz and each guest sends input ~20 Hz via RPC (each send = one `bus.bus` row + a websocket push). Acceptable for 2–4 players in dev; this is not low-latency netcode.
- **`website=True` on `/neon` is mandatory**: `web.frontend_layout` is inherited by `portal.frontend_layout` and, in turn, by `website.layout`, which uses `website.id` unguarded. That `website` only enters the render context if `request.is_frontend` is True, and that is decided by `routing.get('website')` (`http_routing/models/ir_http.py`). With `website=False` the page fails with `KeyError: 'website'` on any DB that has `website` installed. The flag is harmless if `website` is not there.
- **Public without login**: there is no `orm`/`call_kw` on the client (that is `auth="user"`). Everything goes through JSON controllers `auth="public"` with `sudo()`. Identity is `request.session["neon_token"]` (uuid), NOT `res.users`.
- **Channel by capability**: the channel is `neon_strike_match_<access_token>` (the match uuid). `_build_bus_channel_list` allows it when a match with that token exists; knowing the token means you joined. Do not use the `id` in the channel (it is guessable).
- **Standalone mounting**: the game is mounted with `mount(...)` on `.o_neon_strike_root` in `whenReady` (it is not a client action). It needs `bus_service` and `rpc` to be in `web.assets_frontend`.
- `player_name`/`participant.name` are **computed stored** (nickname or `user_id.name`): do not write them directly.
- The leaderboard uses `t-out` (not `t-esc`, deprecated in OWL 2).
- Odoo 19 API used from memory (source not mounted): `bus.bus._sendone`, `bus_service.addChannel/subscribe/unsubscribe`, `ir.websocket._build_bus_channel_list`, `mountComponent`/`makeEnv`/`startServices`/`getTemplate`, `<t t-call-assets ... t-js/t-css>`. Verify signatures when testing against a real 19.0.
