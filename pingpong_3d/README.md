# Ping Pong 3D (Odoo 19.0 Community)

3D table tennis game against the machine, served as an Odoo website page, with
results stored in a model you can review from the backend.

## Installation

    cp -r pingpong_3d /path/to/odoo/addons/
    odoo-bin -d mydb -i pingpong_3d

Then open **/pingpong** or the *Ping Pong 3D -> Play* menu.

## Structure

    pingpong_3d/
    |- __manifest__.py                 version 19.0.2.0.0, depends on web, bus and website
    |- controllers/main.py             /pingpong, /pingpong/score and the /pingpong/online/* routes
    |- models/pingpong_match.py        pingpong.match model, win and margin computed
    |- models/pingpong_session.py      online room: code, channel token, score
    |- models/pingpong_participant.py  player of a room, with its own token
    |- models/ir_websocket.py          authorizes bus channels by capability
    |- security/ir.model.access.csv    read for internal users, write for admins
    |- views/pingpong_templates.xml    QWeb template of the full-screen page
    |- views/pingpong_match_views.xml  list / form / graph / search + menus
    |- views/pingpong_session_views.xml  live rooms (for debugging only)
    |- views/website_menu.xml          "Ping Pong" entry in the website menu
    \- static/
       |- lib/three/                   three.js 0.184 vendored (MIT, see LICENSE)
       \- src/
          |- scss/pingpong.scss        HUD and screens (Odoo palette), all under .o_pingpong_root
          |- boot/pingpong_boot.js  loads the game bundle only on its page
          |- xml/pingpong_game_templates.xml  OWL templates of the screens
          |- xml/pingpong_lab_templates.xml   template of the netcode bench
          \- js/
             |- pingpong_game.js       OWL component and page mounting
             |- pingpong_engine.js     facade: simulation + view + input + loop
             |- loopback_lab.js        bench: host and guest in one tab
             |- engine/constants.js    measurements, difficulties, fixed step, reason codes
             |- engine/rng.js          seeded PRNG (mulberry32) for replicable serves
             |- engine/physics.js      pure integration: gravity, drag, Magnus, bounce
             |- engine/sim.js          headless match: phases, hits, scoring
             |- engine/ai.js           landing prediction and the machine controller
             |- engine/history.js      circular state buffer, indexed by tick
             |- net/protocol.js        wire format (integers: mm and rad/s x10)
             |- net/clock.js           MatchClock (time -> tick) and ClockSync (NTP)
             |- net/transport.js       transport interface and loopback link
             |- net/netgame.js         snapshots, claims, rewind, reconciliation
             |- net/bus_transport.js   transport over the bus (fallback and signalling)
             |- net/rtc_transport.js   peer-to-peer transport and the hybrid that upgrades to it
             |- render/scene.js        three.js scene construction and its dispose
             \- render/view.js         per-frame drawing, camera and effects

## Technical notes

* **three.js 0.184 is vendored** in `static/lib/three/` (`three.module.js` and
  `three.core.js`, MIT). They carry the `/** @odoo-module **/` header so Odoo's
  transpiler turns them into `odoo.define` modules; the game imports them with
  `import * as THREE from "../../lib/three/three.module.js"`. They must be the
  **non-minified** builds: the transpiler is line-anchored and does not process a
  single-line bundle. There is no request to a CDN.
* The game assets live in their own bundle, `pingpong_3d.assets_game`, loaded only
  by the game page. They are not in `web.assets_frontend` because three.js is
  ~2 MB of source and would be downloaded across the whole site.
* All the CSS is nested under `.o_pingpong_root`, and the generic classes are
  named `o_pp_*`. The original sheet was written for a standalone document and
  carried a global `*` reset and classes (`.btn`, `.card`, `.row`, `.hidden`) that
  clash with Bootstrap.
* Loading happens in two steps for a specific reason. Odoo emits the module
  loader (`web.assets_frontend_minimal`) as a `defer` script and the rest
  (`web.assets_frontend_lazy`) lazily from JS, so a `t-call-assets` in the
  `<head>` would run **before `odoo.define` exists**. That is why
  `pingpong_boot.js` lives in `web.assets_frontend` and requests the game bundle
  with `loadBundle()` at runtime, once the loader and the `@web` modules are there.
* The interface is a **standalone OWL app** mounted on `.o_pingpong_root`. It
  reuses the `env` the public frontend already built and published in
  `Component.env` (`web/legacy/js/public/public_root.js`). Do **not** call
  `startServices()` again: it re-runs every service's `start()` and the
  notification one fails when re-registering `NotificationContainer`.
* The engine lives as long as the page does, not one instance per screen: the
  menu and the end screen are layers over the already-rendered table, and
  recreating the WebGL context on every change would leak contexts for nothing.
* The power and spin meters are written straight to the DOM with `t-ref`: they
  update on every hit and nobody else reads them, so they do not go through
  reactivity.
* The saving route uses `type="http"` + `request.make_json_response` instead of
  the JSON-RPC wrapper, to accept a `fetch` with `Content-Type: application/json`
  from the game itself. It is public and sanitises the received values (range and
  difficulty).
* Physics runs at a **real fixed step** of 1/240 s with an accumulator and a tick
  counter. It used to be 6 substeps per frame, so the step size depended on FPS
  and a client at 144 Hz and one at 60 Hz diverged. With the fixed step, a match's
  event stream is identical from 24 to 240 fps.
* Sides are numeric: **0 is the +Z end and 1 the -Z end**, the same on both
  machines. Only the camera and the mouse mapping are flipped. The physics is
  equivariant under mirroring: the same hit played from either end produces exact
  mirror trajectories. It did not use to be — side spin always curved towards the
  same absolute side, no matter who had hit it.
* Serves use a PRNG seeded by (match seed, point number), so two clients can
  reproduce the same serve. In machine mode there is no seed and `Math.random` is
  used.

## Online mode (in progress)

Split authority: the host simulates the ball and scores, **each side owns its own
paddle with no latency**, and the guest predicts its own hit while the host
confirms it. Without that last part the game is not playable when a round trip is
an appreciable fraction of a rally.

* **Shared time base.** Both ends derive their tick from the same instant
  (`MatchClock` + NTP-style `ClockSync` over the transport itself), so their
  counters match by construction and the guest can index its history with the tick
  carried by a host snapshot.
* **Event-driven.** 10 Hz of base snapshots and 12 Hz of batched paddles, plus an
  **immediate** message on every hit, serve and point. The host's hit message is
  the most valuable in the protocol: without it the median correction on the guest
  is 469 mm, with it it drops to 43 mm.
* **Hit claim.** The guest hits and draws it instantly; the host rewinds to the
  claimed tick and **recomputes the shot itself** from its own ball and the claimed
  paddle. The shot the guest sent is only kept as a metric. That removes the whole
  class of "made-to-measure shot" cheats and, because the hit is deterministic,
  accepting costs no visible correction.
* **Delayed verdict.** "Did not reach" and "out" are the only two faults a claim
  can revoke, so the host holds them back while the rewind window is still open.
  The window and the delay are sized from the measured RTT: a window shorter than
  the link turns legitimate hits into rejections.
* **Test bench**: `/pingpong?net=loopback` mounts host and guest side by side with
  latency, jitter and loss sliders. All the netcode runs for real except the
  transport.
* **Identity without an account.** The server issues a `token` per player and
  returns it exactly once; the client stores it in `sessionStorage`, i.e. per tab.
  This is a deliberate departure from `neon_strike`, which derives identity from
  the HTTP session and therefore cannot tell two tabs of the same browser apart,
  making it impossible to test a two-player game locally.
* **Channels authorized by capability.** Every player is the public user, so there
  is nothing to check on `env.user`. What the channel name carries is a secret —
  the room `access_token` or the player `token` — and knowing it is the proof you
  were let in, because the only place they are handed out is the response to
  creating or joining. A finished room stops granting subscription, and channels
  belonging to others are passed to `super()`: forgetting that would break Discuss
  on the same page.
* **Two planes.** The room channel (`pingpong_session_<token>`) carries control —
  lobby, start, score, end. Each player also has a private mailbox
  (`pingpong_player_<token>`) for the data, so the host does not get its own
  snapshots back nor the guest the other's paddle stream.
* **The server owns the start.** `/pingpong/online/start` fixes `t0` and the seed
  and broadcasts them over the room channel; both clients anchor their tick to the
  same instant. If the host announced it, we would be trusting a client with the
  clock every rewind is measured against.
* **Nothing is forwarded verbatim.** `/pingpong/online/relay` rebuilds every
  payload from a per-type allowlist (`RELAY_TYPES` in the room model). Forwarding
  the client's dictionary would turn the mailbox into a way to inject arbitrary
  objects into the opponent's client.
* **The server keeps the score.** The host reports through
  `/pingpong/online/point` *who won the point and why*, never the score; the
  server increments its own count one at a time. By the time
  `/pingpong/online/finish` arrives, the result is already known on the server and
  the figure the client sends **is ignored**. That is the difference between a
  score that is claimed and one that has to be earned point by point.
* **Each type has one allowed sender.** Only the host broadcasts state and events;
  only the guest sends its paddle and claims a hit (`RELAY_ROLES`).
* **Relay routes do not write.** Odoo works in REPEATABLE READ and retries
  serialization failures with waits of up to seconds; if both players' messages
  updated the same row at these rates they would serialize against each other and
  that backoff would wreck the netcode. Only the heartbeat writes, and it is
  throttled.

Measured over full simulated matches (26 messages/s per match in every case, and
the score always matching on both ends):

| RTT   | mean error | median correction | claim rejection |
|-------|------------|-------------------|-----------------|
| 0 ms  | 4 mm       | 3 mm              | 2.3 %           |
| 20 ms | 4 mm       | 8 mm              | 2.3 %           |
| 100 ms| 30 mm      | 43 mm             | 2.2 %           |
| 200 ms| 96 mm      | 61 mm             | 2.0 %           |
| 300 ms| 130 mm     | 45 mm             | 5-15 %          |

Above ~250 ms RTT the experience degrades noticeably; that is where the player
should be warned rather than matched automatically.

### Why the data does not go over the bus

Measured on an Odoo.sh build with one worker, with the client at 59 fps:

| | Idle bus | Bus during a match |
|---|---|---|
| Delivery | ~30 ms | ~380 ms |

HTTP stayed at ~89 ms and stable, the client healthy, and **cutting 35% of the
messages changed nothing**. The cost is neither the size nor the rate: it is that
every delivered notification runs a full ORM query (`bus.bus._poll`) in the gevent
process, which is cooperative and shared by the whole instance.

That is why the data plane leaves the server. It works like this:

1. The match **starts over the bus** and is playable from the first second.
2. In parallel an `RTCDataChannel` is negotiated (`{ordered:false, maxRetransmits:0}`),
   with signalling over the same relay. The STUN/TURN servers come from
   `mail.ice.server`, which Discuss already configures.
3. When the channel opens, `HybridTransport` switches on its own. `NetGame` never
   notices: it holds one transport and never knows which way its messages went.
4. If negotiation fails — symmetric NAT, corporate network — play continues on the
   bus. There is nothing to do and nothing to announce.

The channel is **unordered and without retransmission** on purpose: the netcode
already discards old snapshots by sequence number, so resending one that is
already stale would only delay the one that matters.

Without TURN configured, a percentage of pairs will not get a direct connection
and will stay on the bus. The HUD indicator shows `p2p` when the direct link is
active.

## Suggested next steps

* **Quick match**: a public queue pairing whoever is waiting. The model already
  carries `is_public_queue` and race-free pairing is designed with
  `try_lock_for_update`, which emits `FOR UPDATE SKIP LOCKED`.
* **Cleanup**: a cron closing abandoned rooms (`state` in `waiting`/`ready` with no
  signal, or `playing` with a player gone) and deleting old ones. Today they pile
  up as garbage, which is what happens with a public endpoint.
* **Rate limits** on the public routes: today anyone can create rooms unchecked.
  Odoo core ships nothing reusable for this.
* **Claiming a win by walkover**: if the opponent has gone 15 s without a
  heartbeat, the one left should be able to close the match in their favour, with
  the server validating it against `last_seen` and not against what the client
  says.
* **Reconnection** after an F5: the token lives in `sessionStorage` and `/info`
  already returns the whole room, so what is mostly missing is the interface part.
* Public ranking (`/pingpong/ranking`) with the best results per difficulty.
* Sound and a replay of the last point.
