/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - game engine (2D canvas + synthesised Web Audio).
 * No external dependencies: the OWL component only instantiates this class.
 *
 * Supports N ships (up to 4) with individual lives, going down and reviving. It
 * can run in three roles:
 *   - "solo":  local single-player simulation (mouse/touch).
 *   - "host":  simulates the whole match and exposes snapshot() to broadcast.
 *   - "guest": does not simulate; renders the received snapshot (applySnapshot)
 *              and reports its pointer through onLocalInput.
 * The game always runs in a fixed logical space (LW x LH) so coordinates are
 * identical on every machine; the render is scaled to the canvas.
 */

// Relative import (not `@neon_strike/...`): Odoo resolves it the same way and
// the engine keeps loading as native ESM outside Odoo (the design sprite gallery).
import { drawSprite, pxFor, spriteSize } from "./sprites";
import { MAX_ACTIVES, PERKS, PERK_INDEX, rollOffers } from "./perks";
import { BOSSES, bossForWave } from "./bosses";
import { COLOSSI, colossusForWave } from "./colossi";
import { SHIPS, SHIP_COLORS } from "./ships";
import { ShipFlight } from "./ship_flight";
import { Backdrop, backgroundForWave } from "./backgrounds";
const REVIVE_FRAMES = 120;
const COMBO_MAX = 25;

// Arena. The logical space is still fixed *per match* (everything is simulated
// in it, and in co-op the host's one travels in the snapshot), but it is sized
// to the window instead of always being 680x540 and letterboxed: a wide screen
// gets room on the sides rather than black bars. It never goes below the
// classic box, so no window can make the playable area smaller than it was.
const BASE_W = 680;
const BASE_H = 540;
// Beyond these the arena stops following the window: on an ultrawide the ships
// would end up as specks, and the vertical travel time (which is the actual
// difficulty knob) would drift too far from what the waves are tuned for.
const MIN_ASPECT = 0.85;
const MAX_ASPECT = 2.1;

// Perk phase: every PERK_WAVES cleared waves each ship keeps 1 of 3 perks.
const PERK_WAVES = 5;
const PERK_OPTIONS = 3;
// Co-op safety net: if somebody does not choose, the first option is taken.
const PERK_TIMEOUT = 1200;
// Dash (Space): frames of travel, cooldown and speed of the burst.
const DASH_FRAMES = 11;
const DASH_CD = 105;
const DASH_SPEED = 15;
// Neutral modifiers of a ship with no perks. `_recalcPerks` rebuilds this
// object by summing the `mods` of every perk owned.
const BASE_MODS = {
    fireRate: 0, dmg: 0, bulletSpeed: 0, side: 0, pierce: 0,
    crit: 0, critMul: 0, moveSpeed: 0, hitbox: 0, lives: 0, maxLives: 0,
    inv: 0, magnet: 0, luck: 0, scoreMul: 0, dashCd: 0, dashCharges: 0,
};

// Sprite per enemy type. Types with two entries alternate chassis based on
// `e.v` (variant fixed when the enemy is created and carried in the snapshot).
const ENEMY_SPRITES = {
    drone: ["drone0", "drone1"],
    speedy: ["speedy0", "speedy1"],
    tank: ["tank0", "tank1"],
    sniper: ["sniper0"],
    kami: ["kami0"],
    // The boss family is indexed by `e.k`, see BOSSES.
    boss: BOSSES.map((b) => b.sprite),
};
const ROCK_SPRITES = ["rock0", "rock1"];
// Colour per power-up type. The `pup<T>` sprite is tinted with it, so the two
// always go together: adding a capsule means a sprite + a colour + an effect in
// `_applyPup` + a weight in PUP_TABLE.
const PUP_COLORS = {
    T: "#5ee1ff", S: "#7bffb0", B: "#ffb347", L: "#ff8fb3",
    R: "#ffd166", V: "#ff8f3d", P: "#c9a4ff", H: "#4de3c1", D: "#8be9ff",
    G: "#e2e0ff", F: "#8bd0ff", X: "#ffe066", C: "#ff6fa5", Y: "#ffcc33",
};
// Drop weights. `supply` is what a boss fight drops: more firepower and fewer
// situational ones, because there you need to keep up the damage.
const PUP_TABLE = {
    normal: { T: 10, S: 12, B: 7, L: 6, R: 8, V: 7, P: 6, H: 6, D: 5, G: 6, F: 5, X: 5, C: 6, Y: 5 },
    supply: { T: 14, S: 13, B: 6, L: 5, R: 13, V: 11, P: 8, H: 8, D: 7, G: 9, F: 4, X: 4, C: 3, Y: 3 },
};
// Timed capsules: frames the buff lasts on the ship that grabbed it.
const PUP_BUFFS = { R: 600, V: 600, P: 540, H: 600, D: 900, G: 240 };
// Order of `ship.buffs` in the snapshot bitmask (never reorder, append only).
const BUFF_KEYS = ["R", "V", "P", "H", "D", "G"];
// Ship pixel size: a 16 px grid -> ~32 logical px wide.
const SHIP_PX = pxFor("ship0", 30);
const PUP_PX = pxFor("pupT", 30);
// The simulation ticks in 60 fps frames (`ts`); the flight animation wants
// seconds, and going through `ts` is what makes it slow down with slow motion.
const FRAME_SECONDS = 1 / 60;

export class NeonStrikeEngine {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Object} callbacks
     * @param {function} [callbacks.onGameOver] - ({score, wave, best})
     * @param {function} [callbacks.onLocalInput] - (tx, ty) local pointer (guest)
     * @param {"solo"|"host"|"guest"} [callbacks.role="solo"]
     * @param {number} [callbacks.players=1] - number of ships
     * @param {number} [callbacks.localSlot=0] - locally controlled slot
     * @param {string[]} [callbacks.names] - name per slot
     * @param {number[]} [callbacks.hulls] - chosen hull index per slot (SHIPS)
     * @param {boolean} [callbacks.hotseat=false] - second ship on keyboard (WASD)
     */
    constructor(canvas, callbacks = {}) {
        this.cv = canvas;
        this.g = canvas.getContext("2d");
        this.cb = callbacks;

        this.role = callbacks.role || "solo";
        // Explicit slot list (multiplayer); if missing, derived as 0..players-1.
        // Slots may be NON contiguous if somebody left the lobby.
        this.slots = callbacks.slots && callbacks.slots.length ? callbacks.slots : null;
        this.players = Math.max(1, callbacks.players || (this.slots ? this.slots.length : 1));
        this.localSlot = callbacks.localSlot || 0;
        this.names = callbacks.names || null;
        // Hull picked by each player. Cosmetic only: every hull flies the same.
        this.hulls = callbacks.hulls || null;
        this.hotseat = !!callbacks.hotseat;

        this.state = "start";
        this.paused = false;
        this.muted = false;
        this.AC = null;

        // Logical space. Sized to the window by `_fitArena` (on the guest, by
        // the host's snapshot) and constant from there on.
        this.W = BASE_W;
        this.H = BASE_H;
        this.dpr = 1;
        this.scale = 1;
        this.ox = 0;
        this.oy = 0;
        // Camera: 1 = the arena fills the canvas. A colossal boss pulls it back
        // (zoom < 1) so its whole hull fits and the room around it is shown.
        this.zoom = 1;
        this.zoomTo = 1;
        // Visible margin in logical px outside the arena, recomputed on render.
        this.viewMX = 0;
        this.viewMY = 0;
        // Playable field: 1 = the plain W x H arena. A colossus stretches it
        // (the camera is already pulled back, so that room becomes playable and
        // you get somewhere to dodge to). `fx0/fx1/fy0/fy1` are the live bounds
        // and may go negative; everything that leaves the field uses them.
        this.field = 1;
        this.fieldTo = 1;
        this.fx0 = 0;
        this.fx1 = this.W;
        this.fy0 = 0;
        this.fy1 = this.H;
        // Supply drops while a boss is up (otherwise you fight it with the
        // plain shot: no small fry means no capsules).
        this.supplyT = 0;
        // Wave pacing: enemies queue up here and are released in a steady
        // stream instead of being parked far above the screen.
        this.pending = [];
        this.spawnT = 0;
        this.waveAge = 0;
        this.escortT = 0;

        this.frame = 0;
        this.slowMo = 0;
        // How long this run has actually been played, in ms of wall clock. It
        // only advances while `playing` and not paused, so the pause screen and
        // the upgrade screen do not inflate it. Frames would be wrong here: a
        // 30 fps machine would report half the time of a 60 fps one.
        this.playMs = 0;
        this._clock = 0;

        this.ships = [];
        this.bullets = [];
        this.ebullets = [];
        this.enemies = [];
        this.rocks = [];
        this.parts = [];
        this.pops = [];
        this.pups = [];
        this.stars = [];
        // Scenery behind the star field. Derived from the wave (see
        // `_syncBackground`), never simulated and never sent over the bus.
        this.bg = null;
        this._events = [];
        // Entities created by perks (dash trails, turrets, singularities, decoys).
        this.trails = [];
        this.turrets = [];
        this.holes = [];
        this.decoys = [];
        // Arc Capacitor bolts: cosmetic, they live one blink (also on guests).
        this.zaps = [];
        // Colossus beams (telegraphed, then lethal).
        this.beams = [];
        // Global timers driven by actives: frozen bullets and slowed enemies.
        this.freezeT = 0;
        this.warpT = 0;
        // Perk phase: {offers: {slot: [idx]}, picks: {slot: idx}, t}. Null while
        // playing. The state machine goes playing -> perk -> playing.
        this.perkPhase = null;
        this.nextPerkWave = PERK_WAVES;
        // Incremental id per enemy: a piercing bullet must not hit twice.
        this._eid = 0;

        this.score = 0;
        this.best = 0;
        this.wave = 0;
        this.combo = 1;
        this.comboT = 0;
        this.shake = 0;
        this.flashT = 0;
        this.waveDelay = 0;
        this.rockT = 200;
        this.bossAlive = false;
        this.keys = {};

        this._raf = null;
        this._loop = this._loopFn.bind(this);
        this._pd = (e) => this._pointerDown(e);
        this._pm = (e) => this._pointerMove(e);
        // Space (dash) and 1..4 (actives) are always bound, not only in hotseat:
        // WASD is the only thing gated by `hotseat`.
        this._kd = (e) => this._keyDown(e);
        this._ku = (e) => { this.keys[(e.key || "").toLowerCase()] = false; };
        this.cv.addEventListener("pointerdown", this._pd);
        this.cv.addEventListener("pointermove", this._pm);
        window.addEventListener("keydown", this._kd);
        window.addEventListener("keyup", this._ku);
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(this.cv.parentElement);

        this.resize();
        this.initStars();
        this._initShips();
    }

    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                           */
    /* ------------------------------------------------------------------ */

    start() {
        if (!this._raf) {
            this._raf = requestAnimationFrame(this._loop);
        }
    }

    destroy() {
        if (this._raf) {
            cancelAnimationFrame(this._raf);
            this._raf = null;
        }
        this._ro.disconnect();
        this.cv.removeEventListener("pointerdown", this._pd);
        this.cv.removeEventListener("pointermove", this._pm);
        window.removeEventListener("keydown", this._kd);
        window.removeEventListener("keyup", this._ku);
        if (this.AC) {
            try {
                this.AC.close();
            } catch (e) {
                /* AudioContext already closed */
            }
        }
    }

    /**
     * Advance the play clock from the wall clock. Gaps longer than a frame or
     * two (tab in the background, a stall) are clamped, otherwise leaving the
     * page open would count as play time.
     */
    _tickClock() {
        const now = typeof performance !== "undefined" && performance.now
            ? performance.now()
            : Date.now();
        const dt = this._clock ? now - this._clock : 0;
        this._clock = now;
        if (this.state === "playing" && !this.paused && dt > 0) {
            this.playMs += Math.min(dt, 100);
        }
    }

    /** Length of the current run in whole seconds. */
    playSeconds() {
        return Math.round(this.playMs / 1000);
    }

    /** m:ss for the HUD (h:mm:ss once a run goes past the hour). */
    static formatTime(seconds) {
        const s = Math.max(0, Math.round(seconds || 0));
        const parts = [Math.floor(s / 60) % 60, s % 60];
        if (s >= 3600) {
            parts.unshift(Math.floor(s / 3600));
        }
        return parts
            .map((v, i) => (i === 0 ? String(v) : String(v).padStart(2, "0")))
            .join(":");
    }

    setMuted(muted) {
        this.muted = muted;
        if (!muted) {
            this.audio();
        }
    }

    /** Esc / toolbar. On a guest it asks the host, who owns the simulation. */
    togglePause() {
        if (this.state !== "playing") {
            return;
        }
        this._localAction("pause");
    }

    _setPaused(paused) {
        if (this.paused === paused) {
            return;
        }
        this.paused = paused;
        if (this.cb.onPause) {
            this.cb.onPause(paused);
        }
    }

    restartToMenu() {
        this.reset();
        this.state = "start";
    }

    /** Start a game (host/solo). Guests get the state through snapshots. */
    beginPlay() {
        this.reset();
        this._setPaused(false);
        this.state = "playing";
    }

    resize() {
        const el = this.cv.parentElement;
        if (!el) {
            return;
        }
        const cw = Math.max(1, el.clientWidth || this.W);
        const ch = Math.max(1, el.clientHeight || this.H);
        this.dpr = window.devicePixelRatio || 1;
        this.cv.width = cw * this.dpr;
        this.cv.height = ch * this.dpr;
        this.cssW = cw;
        this.cssH = ch;
        // A guest renders the host's arena, which arrives in the snapshot: it
        // must never size its own, or the two would simulate different worlds.
        if (this.role !== "guest" && this._fitArena(cw, ch)) {
            this._onArenaResized();
        }
        this.scale = Math.min(cw / this.W, ch / this.H);
        this._applyCamera();
        // The zoom is derived from the canvas: snap it to the new fit.
        this._updateCamera(1000);
    }

    /**
     * Shape the logical arena like the window, so the game fills the screen
     * instead of sitting inside black bars. Only one side grows: the short one
     * keeps its base size, which is what stops a wide window from also making
     * everything smaller once the render is scaled.
     *
     * @returns {boolean} true if the arena actually changed size
     */
    _fitArena(cw, ch) {
        const a = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, cw / ch));
        const w = a >= BASE_W / BASE_H ? Math.round(BASE_H * a) : BASE_W;
        const h = a >= BASE_W / BASE_H ? BASE_H : Math.round(BASE_W / a);
        if (w === this.W && h === this.H) {
            return false;
        }
        this.W = w;
        this.H = h;
        return true;
    }

    /**
     * Everything derived from the arena size, rebuilt after it changes: field
     * bounds, star field, backdrop, and the ships pulled back inside the walls
     * (a window that gets narrower can leave them outside).
     */
    _onArenaResized() {
        this._applyField();
        this.initStars();
        this.bg = null;
        this._syncBackground();
        for (const sp of this.ships) {
            sp.x = sp.tx = Math.max(this.fx0 + 20, Math.min(this.fx1 - 20, sp.x));
            sp.y = sp.ty = Math.max(this.fy0 + 20, Math.min(this.fy1 - 20, sp.y));
            // Being clamped back inside is not flying: drop the current pose so
            // a resize does not read as a full-speed turn.
            sp.flight.reset(sp.x, sp.y);
        }
    }

    /**
     * Recompute the placement of the arena inside the canvas for the current
     * zoom. `viewMX/viewMY` is how much world is visible outside the arena:
     * that is where a colossus overflows.
     */
    _applyCamera() {
        const cw = this.cssW || this.W;
        const ch = this.cssH || this.H;
        const eff = this.scale * this.zoom;
        this.ox = (cw - this.W * eff) / 2;
        this.oy = (ch - this.H * eff) / 2;
        // The HUD ignores the zoom: it always sits on the unscaled arena box.
        this.hudOx = (cw - this.W * this.scale) / 2;
        this.hudOy = (ch - this.H * this.scale) / 2;
        this.viewMX = Math.max(0, (cw / eff - this.W) / 2);
        this.viewMY = Math.max(0, (ch / eff - this.H) / 2);
    }

    /**
     * Zoom that frames the whole playable field plus the boss hull inside this
     * canvas. It is deliberately computed from the local canvas: the zoom is a
     * render concern, so each client fills its own screen, while the field (the
     * simulated part) stays canvas-independent and identical everywhere.
     */
    _fitZoom(boss) {
        const cw = this.cssW || this.W;
        const ch = this.cssH || this.H;
        let needW = this.W * this.fieldTo;
        let needH = this.H * this._fieldY(this.fieldTo);
        if (boss) {
            // A little air around the hull so it never touches the edges.
            needW = Math.max(needW, boss.w * 1.06);
            needH = Math.max(needH, boss.h * 1.15);
        }
        const z = Math.min(cw / (needW * this.scale), ch / (needH * this.scale));
        // Never zoom in past 1: the arena is the reference frame.
        return Math.min(1, Math.round(z * 1000) / 1000);
    }

    /**
     * Ease camera and field towards their target (called every frame, on the
     * host and on the guest). The field is read off the live colossus; the zoom
     * follows from it, so nobody has to send a camera over the wire.
     */
    _updateCamera(ts) {
        const boss = this.enemies.find((e) => e.type === "colossus");
        this.fieldTo = boss ? boss.field || 1 : 1;
        this.zoomTo = this._fitZoom(boss);
        // The easing is exponential, so it never quite lands: snap once it is
        // close enough, otherwise the walls keep a fractional offset forever.
        if (this.zoom !== this.zoomTo) {
            this.zoom = Math.abs(this.zoom - this.zoomTo) < 0.002
                ? this.zoomTo
                : this.zoom + (this.zoomTo - this.zoom) * Math.min(1, 0.045 * ts);
            this._applyCamera();
        }
        if (this.field !== this.fieldTo) {
            this.field = Math.abs(this.field - this.fieldTo) < 0.002
                ? this.fieldTo
                : this.field + (this.fieldTo - this.field) * Math.min(1, 0.04 * ts);
            this._applyField();
        }
    }

    /**
     * Vertical growth of the field. It is deliberately smaller than the
     * horizontal one: screens are wide, so a wider-than-tall field is what
     * ends up actually filling them once the camera pulls back.
     */
    _fieldY(f) {
        return 1 + (f - 1) * 0.6;
    }

    /** Recompute the playable bounds for the current `field` factor. */
    _applyField() {
        const mx = (this.W * (this.field - 1)) / 2;
        const my = (this.H * (this._fieldY(this.field) - 1)) / 2;
        this.fx0 = -mx;
        this.fx1 = this.W + mx;
        this.fy0 = -my;
        this.fy1 = this.H + my;
    }

    _loopFn() {
        this.frame++;
        this._tickClock();
        const ts = this.slowMo > 0 ? 0.35 : 1;
        if (this.slowMo > 0) {
            this.slowMo--;
        }
        if (this.paused) {
            // Frozen: no simulation, no interpolation. Only the overlay moves.
            this.render();
            this._raf = requestAnimationFrame(this._loop);
            return;
        }
        if (this.role === "guest") {
            this._guestUpdate(ts);
        } else {
            this.update(ts);
        }
        this._updateCamera(ts);
        this.render();
        this._raf = requestAnimationFrame(this._loop);
    }

    /* ------------------------------------------------------------------ */
    /* Synthesised audio                                                   */
    /* ------------------------------------------------------------------ */

    audio() {
        try {
            if (!this.AC) {
                this.AC = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (this.AC.state === "suspended") {
                this.AC.resume();
            }
        } catch (e) {
            /* browser without Web Audio */
        }
    }

    tone(f, dur, type, vol, slide) {
        if (this.muted || !this.AC) {
            return;
        }
        try {
            const o = this.AC.createOscillator();
            const gn = this.AC.createGain();
            const t = this.AC.currentTime;
            o.type = type;
            o.frequency.setValueAtTime(f, t);
            if (slide) {
                o.frequency.exponentialRampToValueAtTime(slide, t + dur);
            }
            gn.gain.setValueAtTime(vol, t);
            gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
            o.connect(gn);
            gn.connect(this.AC.destination);
            o.start(t);
            o.stop(t + dur);
        } catch (e) {
            /* noop */
        }
    }

    noise(dur, vol, freq) {
        if (this.muted || !this.AC) {
            return;
        }
        try {
            const n = Math.floor(this.AC.sampleRate * dur);
            const buf = this.AC.createBuffer(1, n, this.AC.sampleRate);
            const d = buf.getChannelData(0);
            for (let i = 0; i < n; i++) {
                d[i] = (Math.random() * 2 - 1) * (1 - i / n);
            }
            const s = this.AC.createBufferSource();
            s.buffer = buf;
            const f = this.AC.createBiquadFilter();
            f.type = "lowpass";
            f.frequency.value = freq || 1200;
            const gn = this.AC.createGain();
            gn.gain.value = vol;
            s.connect(f);
            f.connect(gn);
            gn.connect(this.AC.destination);
            s.start();
        } catch (e) {
            /* noop */
        }
    }

    sShoot() { this.tone(760, 0.07, "square", 0.04, 320); }
    sBoom() { this.noise(0.32, 0.3, 900); this.tone(130, 0.28, "sawtooth", 0.14, 40); }
    sBigBoom() { this.noise(0.6, 0.4, 600); this.tone(90, 0.5, "sawtooth", 0.2, 30); }
    sHit() { this.noise(0.35, 0.35, 500); this.tone(80, 0.3, "sawtooth", 0.18, 35); }
    sPup() {
        this.tone(523, 0.09, "square", 0.08);
        setTimeout(() => this.tone(659, 0.09, "square", 0.08), 80);
        setTimeout(() => this.tone(880, 0.14, "square", 0.09), 160);
    }
    sWave() { this.tone(220, 0.25, "triangle", 0.1, 440); }
    sTick() { this.tone(1200, 0.03, "square", 0.03); }

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    glow(hex, a) {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }

    initStars() {
        this.stars = [];
        // The field covers more than the arena: when the camera pulls back for
        // a colossus, the space around the arena must not be empty.
        const mx = this.W * 0.55;
        const my = this.H * 0.55;
        // Density, not a fixed count: a wider arena must not look emptier.
        const n = Math.round((190 * this.W * this.H) / (BASE_W * BASE_H));
        for (let i = 0; i < n; i++) {
            this.stars.push({
                x: -mx + Math.random() * (this.W + mx * 2),
                y: -my + Math.random() * (this.H + my * 2),
                z: Math.random() * 2 + 0.5,
                s: Math.random() * 1.4 + 0.4,
            });
        }
    }

    /**
     * Point the backdrop at the place this wave is fought in. Cheap to call on
     * every frame: it only rebuilds when the wave moves to another place, which
     * is what lets the guest drive it straight off the snapshot.
     */
    _syncBackground() {
        const def = backgroundForWave(this.wave || 1);
        if (this.bg && this.bg.def === def) {
            return;
        }
        const first = !this.bg;
        this.bg = new Backdrop(def, this.W, this.H);
        if (!first && this.wave >= 1 && this.state === "playing") {
            this.pop(this.W / 2, 74, def.name, def.tint, 15, 90);
        }
    }

    pop(x, y, txt, color, size, life) {
        this.pops.push({
            x, y, txt, color,
            size: size || 14,
            life: life || 55,
            ml: life || 55,
            vy: -0.6,
        });
    }

    burst(x, y, color, n, pw) {
        for (let i = 0; i < n; i++) {
            const a = Math.random() * 6.2832;
            const v = Math.random() * (pw || 4) + 1;
            this.parts.push({
                x, y,
                vx: Math.cos(a) * v,
                vy: Math.sin(a) * v,
                r: Math.random() * 2.5 + 1,
                c: color,
                life: Math.random() * 30 + 20,
                ml: 50,
            });
        }
    }

    /** Record a cosmetic event to replay on the guests. */
    _ev(obj) {
        if (this.role === "host") {
            this._events.push(obj);
        }
    }

    _playEvent(ev) {
        if (ev.k === "boom") {
            this.burst(ev.x, ev.y, ev.c || "#ffffff", ev.b ? 70 : 22, ev.b ? 7 : 4.5);
            this.burst(ev.x, ev.y, "#ffffff", ev.b ? 24 : 6, 3);
            if (ev.b) { this.sBigBoom(); } else { this.sBoom(); }
        } else if (ev.k === "hit") {
            this.burst(ev.x, ev.y, ev.c || "#5ee1ff", 40, 6);
            this.sHit();
        } else if (ev.k === "pup") {
            this.burst(ev.x, ev.y, "#7bffb0", 14, 3);
            this.sPup();
        } else if (ev.k === "wave") {
            this.sWave();
        } else if (ev.k === "bomb") {
            this.sBigBoom();
        } else if (ev.k === "zap") {
            this.zaps.push({ x1: ev.x, y1: ev.y, x2: ev.x2, y2: ev.y2, life: 8 });
        }
    }

    /* ------------------------------------------------------------------ */
    /* Ships                                                               */
    /* ------------------------------------------------------------------ */

    /**
     * Hull the player flies. Cosmetic: it changes the sprite, never the stats.
     * The colour follows the hull when you are alone, but goes back to the slot
     * palette in co-op, where the colour is what tells four ships apart.
     */
    _hullFor(slot) {
        const h = this.hulls && this.hulls[slot];
        return Math.max(0, Math.min(SHIPS.length - 1, h | 0));
    }

    _tintFor(slot, hull) {
        return this.players > 1 ? SHIP_COLORS[slot % SHIP_COLORS.length] : SHIPS[hull].tint;
    }

    mkShip(slot) {
        const hull = this._hullFor(slot);
        return {
            slot,
            hull,
            name: (this.names && this.names[slot]) || "J" + (slot + 1),
            color: this._tintFor(slot, hull),
            x: 0, y: 0, tx: 0, ty: 0,
            // Flight animation (bank, flame, retro, barrel roll). Render only:
            // it watches the motion below, never causes it, and never travels
            // in the snapshot.
            flight: new ShipFlight(),
            inv: 0, shield: 0,
            weapon: "single", weaponT: 0, fireT: 0,
            lives: 3, down: false, reviveProgress: 0,
            // Timed capsule buffs (frames left). They stack on top of the
            // perks: `mods`/`flags` are perks only, these are read next to them.
            buffs: { R: 0, V: 0, P: 0, H: 0, D: 0, G: 0 },
            // --- Perks kept for the whole run (wiped by `reset()`) ---------
            perks: [],                    // perk ids in pick order
            mods: Object.assign({}, BASE_MODS),
            flags: {},                    // flag name -> true
            actives: [],                  // [{id, cd, cdMax}] bound to keys 1..4
            // --- Dash (Space), available with no perks --------------------
            dash: 0,                      // frames of dash left
            dashCd: 0,
            dashCharges: 1,
            dashMax: 1,
            dashVx: 0,
            dashVy: -1,
            dashKills: 0,
            // --- Per-perk timers/counters --------------------------------
            droneA: Math.random() * 6.2832, // Drone Wing orbit
            droneT: 0,
            regenT: 0,                    // Nano Weave
            hurtT: 0,                      // Adrenaline
            odT: 0,                        // Overdrive
            standT: 0,                     // Last Stand used this wave
            phoenixUsed: false,
            volley: 0,                     // Broadside alternation
        };
    }

    /* ------------------------------------------------------------------ */
    /* Perks                                                               */
    /* ------------------------------------------------------------------ */

    /** Rebuild `mods`/`flags`/`actives` of a ship from the perks it owns. */
    _recalcPerks(sp) {
        const mods = Object.assign({}, BASE_MODS);
        const flags = {};
        const actives = [];
        for (const id of sp.perks) {
            const perk = PERKS[PERK_INDEX[id]];
            if (!perk) {
                continue;
            }
            for (const [k, v] of Object.entries(perk.mods || {})) {
                mods[k] = (mods[k] || 0) + v;
            }
            for (const f of perk.flags || []) {
                flags[f] = true;
            }
            if (perk.kind === "active") {
                // Keep the cooldown already ticking if the perk is not new.
                const prev = sp.actives.find((a) => a.id === id);
                actives.push({ id, cd: prev ? prev.cd : 0, cdMax: perk.cd || 600 });
            }
        }
        sp.mods = mods;
        sp.flags = flags;
        sp.actives = actives.slice(0, MAX_ACTIVES);
        sp.dashMax = 1 + mods.dashCharges;
        sp.dashCharges = Math.min(sp.dashMax, Math.max(sp.dashCharges, 1));
    }

    _maxLives(sp) {
        return 5 + sp.mods.maxLives;
    }

    /** Give a perk to a ship and apply its immediate effects. */
    _grantPerk(sp, index) {
        const perk = PERKS[index];
        if (!perk || sp.perks.includes(perk.id)) {
            return;
        }
        sp.perks.push(perk.id);
        this._recalcPerks(sp);
        if (perk.mods && perk.mods.lives) {
            sp.lives = Math.min(this._maxLives(sp), sp.lives + perk.mods.lives);
        }
        sp.dashCharges = sp.dashMax;
        this.pop(sp.x, sp.y - 34, perk.name, perk.tint, 15, 80);
        this.burst(sp.x, sp.y, perk.tint, 22, 4);
    }

    /* ------------------------------------------------------------------ */
    /* Perk phase (between waves)                                          */
    /* ------------------------------------------------------------------ */

    /** Open the choice screen: 3 offers per ship, everything else paused. */
    _openPerkPhase() {
        const offers = {};
        for (const sp of this.ships) {
            offers[sp.slot] = rollOffers(sp, { players: this.players }, PERK_OPTIONS);
        }
        this.perkPhase = { offers, picks: {}, t: PERK_TIMEOUT };
        this.state = "perk";
        this.ebullets = [];
        this.beams = [];
        this.sPup();
        this._ev({ k: "wave" });
    }

    /** Register the choice of a slot (local or remote). Idempotent. */
    pickPerk(slot, index) {
        const ph = this.perkPhase;
        if (!ph || ph.picks[slot] != null) {
            return;
        }
        const offer = ph.offers[slot] || [];
        if (!offer.includes(index)) {
            return;
        }
        ph.picks[slot] = index;
        const sp = this.ships.find((s) => s.slot === slot);
        if (sp) {
            this._grantPerk(sp, index);
        }
        this.sPup();
        this._ev({ k: "pup", x: sp ? sp.x : this.W / 2, y: sp ? sp.y : this.H / 2 });
    }

    /** Countdown + resume once everybody has chosen (or the timer runs out). */
    _updatePerkPhase(ts) {
        const ph = this.perkPhase;
        if (!ph) {
            return;
        }
        ph.t -= ts;
        const pending = this.ships.filter((sp) => ph.picks[sp.slot] == null);
        if (ph.t <= 0) {
            // Nobody is left without an upgrade: take the first option.
            for (const sp of pending) {
                const offer = ph.offers[sp.slot] || [];
                if (offer.length) {
                    this.pickPerk(sp.slot, offer[0]);
                }
            }
        } else if (pending.length) {
            return;
        }
        this.perkPhase = null;
        this.state = "playing";
        this.waveDelay = 40;
        for (const sp of this.ships) {
            sp.inv = Math.max(sp.inv, 60);
        }
    }

    _initShips() {
        this.ships = [];
        // Use the real slots (they may not be contiguous) so each player keeps
        // their ship/colour/name even if somebody else left the lobby.
        const slots = this.slots || Array.from({ length: this.players }, (_v, i) => i);
        const p = slots.length;
        slots.forEach((slot, idx) => {
            const sp = this.mkShip(slot);
            sp.x = sp.tx = (this.W * (idx + 1)) / (p + 1);
            sp.y = sp.ty = this.H - 70;
            this.ships.push(sp);
        });
    }

    _livingShips() {
        return this.ships.filter((s) => !s.down);
    }

    _nearestShip(x, y) {
        let best = null;
        let bd = Infinity;
        for (const s of this.ships) {
            if (s.down) {
                continue;
            }
            const dx = s.x - x;
            const dy = s.y - y;
            const d = dx * dx + dy * dy;
            if (d < bd) {
                bd = d;
                best = s;
            }
        }
        return best;
    }

    _aimShip() {
        const alive = this._livingShips();
        if (!alive.length) {
            return null;
        }
        return alive[Math.floor(Math.random() * alive.length)];
    }

    /**
     * What the enemies aim at: a Decoy Beacon steals every lock-on while it
     * lasts. Decoys travel in the snapshot, so the guest resolves the same
     * target and draws the sniper sight in the same place.
     */
    _target(x, y) {
        if (this.decoys.length) {
            let best = null;
            let bd = Infinity;
            for (const d of this.decoys) {
                const dd = (d.x - x) ** 2 + (d.y - y) ** 2;
                if (dd < bd) {
                    bd = dd;
                    best = d;
                }
            }
            return best;
        }
        return this._nearestShip(x, y);
    }

    /* ------------------------------------------------------------------ */
    /* Entities                                                            */
    /* ------------------------------------------------------------------ */

    _enemyR(type) {
        const r = { boss: 44, colossus: 140, tank: 20, speedy: 10, sniper: 16, kami: 12 };
        return r[type] != null ? r[type] : 14;
    }

    _enemyColor(type) {
        const c = {
            boss: "#ff4d4d", tank: "#9b5de5", speedy: "#ffd166",
            sniper: "#4de3c1", kami: "#ff8f3d",
        };
        return c[type] || "#ff5d8f";
    }

    /** Both boss families share the "big kill" treatment. */
    _isBoss(e) {
        return e.type === "boss" || e.type === "colossus";
    }

    /**
     * Hit test against an enemy. A colossus uses a box (its hull is a wide
     * slab); everything else keeps the circle.
     */
    _enemyHit(e, x, y, pad) {
        if (e.type === "colossus") {
            return Math.abs(x - e.x) < e.hw + pad && Math.abs(y - e.y) < e.hh + pad;
        }
        const rr = e.r + pad;
        return (x - e.x) ** 2 + (y - e.y) ** 2 < rr * rr;
    }

    /** Chassis variant (0/1) based on the sprites available for the type. */
    _enemyVariant(type) {
        const names = ENEMY_SPRITES[type];
        return names && names.length > 1 ? Math.floor(Math.random() * names.length) : 0;
    }

    mkEnemy(type, x, y) {
        const base = {
            type, x, y,
            r: this._enemyR(type),
            c: this._enemyColor(type),
            v: this._enemyVariant(type),
            flash: 0,
            // `id` keeps a piercing bullet from hitting the same hull twice;
            // `stun` is the EMP lock.
            id: ++this._eid,
            stun: 0,
        };
        if (type === "drone") {
            return Object.assign(base, { hp: 1, mhp: 1, t: Math.random() * 6.28, val: 100 });
        }
        if (type === "speedy") {
            return Object.assign(base, { hp: 1, mhp: 1, t: 0, val: 150 });
        }
        if (type === "tank") {
            return Object.assign(base, { hp: 4, mhp: 4, t: Math.random() * 200, val: 300 });
        }
        if (type === "sniper") {
            // Stops mid-screen and punishes with telegraphed, accurate shots.
            return Object.assign(base, {
                hp: 3, mhp: 3, t: 0, val: 400,
                stopY: 90 + Math.random() * 110, aim: 0,
            });
        }
        if (type === "kami") {
            // Locks onto a ship and accelerates; dies on contact (generic collision).
            return Object.assign(base, { hp: 2, mhp: 2, t: 0, val: 350, vx: 0, vy: 1.2, rot: 0 });
        }
        // Regular boss: `k` picks which one of the family it is.
        const k = Math.max(0, base.k != null ? base.k : bossForWave(this.wave));
        const d = BOSSES[k] || BOSSES[0];
        const hp = Math.round((35 + this.wave * 9 + (this.players - 1) * 25) * d.hp);
        return Object.assign(base, {
            type: "boss", k, hp, mhp: hp, t: 0,
            r: d.r, c: d.tint, v: k,
            val: Math.round(5000 * d.val), dropAt: 0.75,
            phase: 0, armor: 0, gap: 140, vx: 0, vy: 0,
        });
    }

    /**
     * A colossal boss: several hundred logical px wide, so it does not fit the
     * arena. While it lives the camera pulls back to `zoom` (see _updateCamera)
     * and the ships look tiny next to it.
     */
    mkColossus(k) {
        const d = COLOSSI[k];
        const size = spriteSize(d.sprite);
        const h = (d.w * size.h) / size.w;
        // The wave term carries most of the hull, so meeting the same colossus
        // again later (they cycle every 50 waves) is a real step up.
        const base = d.hp + this.wave * 28;
        const hp = Math.round(base * (1 + (this.players - 1) * 0.5));
        return {
            type: "colossus", k, id: ++this._eid,
            x: this.W / 2, y: -h * 0.55, ty: d.y,
            w: d.w, h,
            // Hitbox slightly inside the art, so the silhouette stays fair.
            hw: d.w * 0.42, hh: h * 0.32,
            r: Math.min(d.w, h) * 0.28, // circle used by splashes and trails
            c: d.tint, field: d.field || 1, v: 0, flash: 0, stun: 0,
            hp, mhp: hp, t: 0, val: d.val, dropAt: 0.75,
            vx: d.speed, rot: 0, gap: 120,
            a1: 60, a2: 180, a3: 300,
        };
    }

    spawnWave() {
        this.wave++;
        this.sWave();
        this._ev({ k: "wave" });
        this._syncBackground();
        // Last Stand recharges once per wave.
        for (const sp of this.ships) {
            sp.standT = 0;
        }
        const p = this.players;
        const ck = colossusForWave(this.wave);
        if (ck >= 0) {
            const d = COLOSSI[ck];
            this.enemies.push(this.mkColossus(ck));
            this.bossAlive = true;
            this.pop(this.W / 2, this.H / 2 - 60, d.name, d.tint, 40, 130);
            this.pop(this.W / 2, this.H / 2 - 18, '"' + d.title + '"', "#eaf6ff", 20, 130);
            this.shake = 22;
            this.sBigBoom();
            return;
        }
        const bk = bossForWave(this.wave);
        if (bk >= 0) {
            const d = BOSSES[bk];
            const boss = this.mkEnemy("boss", this.W / 2, -90);
            this.enemies.push(boss);
            this.bossAlive = true;
            this.pop(this.W / 2, this.H / 2 - 60, "BOSS", "#ff6b6b", 34, 100);
            this.pop(this.W / 2, this.H / 2 - 24, d.name, d.tint, 22, 100);
            return;
        }
        this.pop(this.W / 2, this.H / 2 - 50, "Wave " + this.wave, "#8be9ff", 30, 80);
        const n = 5 + this.wave * 2 + p * 2;
        // The whole wave is queued and released by `_updateSpawns`, which keeps
        // a minimum number of hulls on screen. Parking them all above the top
        // (the old way) made big waves crawl: the tail took ~12 s just to fly
        // in, and the wave could not end until it did.
        for (let i = 0; i < n; i++) {
            const r = Math.random();
            let type = "drone";
            if (this.wave > 1 && r < 0.3) {
                type = "speedy";
            }
            if (this.wave > 2 && r > 0.8) {
                type = "tank";
            }
            if (this.wave > 3 && r >= 0.3 && r < 0.4) {
                type = "sniper";
            }
            if (this.wave > 4 && r >= 0.66 && r < 0.76) {
                type = "kami";
            }
            this.pending.push(type);
        }
        this.spawnT = 0;
        this.waveAge = 0;
        // Open with a handful already on screen so no wave starts empty.
        for (let i = 0; i < Math.min(this.pending.length, 3 + p); i++) {
            this._releaseEnemy(-30 - i * 26);
        }
        // A couple of asteroids at the start of a wave, more from wave 3 on.
        const rocks = 1 + Math.floor(this.wave / 3);
        for (let i = 0; i < rocks; i++) {
            this.spawnRock();
        }
    }

    /** Pop one queued enemy onto the field. */
    _releaseEnemy(y) {
        const type = this.pending.shift();
        if (!type) {
            return;
        }
        this.enemies.push(
            this.mkEnemy(type, 40 + Math.random() * (this.W - 80), y != null ? y : -30 - Math.random() * 20)
        );
    }

    /**
     * Wave pacing. Two rules keep a round from going quiet:
     *  - release on a timer, but bring the next one forward whenever the field
     *    drops below `minAlive`, so the pressure never dies down;
     *  - once the queue is empty, chase down the last stragglers (`rush`) so a
     *    wave is not decided by one tank drifting across the screen.
     */
    _updateSpawns(ts) {
        this.waveAge += ts;
        const alive = this.enemies.filter((e) => !this._isBoss(e)).length;
        if (this.pending.length) {
            // Later waves keep more hulls on screen at once: that is what makes
            // a round feel frantic instead of a queue of single targets.
            const minAlive = Math.min(11, 3 + this.players + Math.floor(this.wave / 5));
            this.spawnT -= ts;
            if (this.spawnT <= 0 || alive < minAlive) {
                this._releaseEnemy();
                // Faster drip on later waves, and faster still if the field is
                // emptying out.
                this.spawnT = Math.max(10, 34 - this.wave) * (alive < minAlive ? 0.45 : 1);
            }
            return;
        }
        if (alive && alive <= 2 && this.waveAge > 600) {
            for (const e of this.enemies) {
                if (!this._isBoss(e)) {
                    e.rush = 1;
                }
            }
            return;
        }
        // Boss waves used to be one hull alone on an empty screen for half a
        // minute. A thin escort stream keeps things moving (and keeps capsules
        // and score flowing) without competing with the boss pattern.
        const boss = this.enemies.find((e) => this._isBoss(e));
        if (boss && alive < 3 + this.players) {
            this.escortT -= ts;
            if (this.escortT <= 0) {
                this.escortT = boss.type === "colossus" ? 240 : 180;
                const type = Math.random() < 0.55 ? "drone" : "speedy";
                this.enemies.push(
                    this.mkEnemy(type, this.fx0 + 40 + Math.random() * (this.fx1 - this.fx0 - 80), -30)
                );
            }
        }
    }

    spawnRock(x, y, r) {
        const rad = r || 16 + Math.random() * 24;
        this.rocks.push({
            x: x != null ? x : 30 + Math.random() * (this.W - 60),
            y: y != null ? y : -40,
            vx: (Math.random() - 0.5) * 1.6,
            vy: 0.7 + Math.random() * 1.3,
            r: rad,
            rot: Math.random() * 6.2832,
            vr: (Math.random() - 0.5) * 0.06,
            hp: Math.max(1, Math.round(rad / 9)),
            v: Math.floor(Math.random() * ROCK_SPRITES.length),
        });
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {boolean} [supply] boss drop: weighted towards firepower and
     *        shields, which is what you actually need in a long fight
     */
    dropPup(x, y, supply) {
        const table = PUP_TABLE[supply ? "supply" : "normal"];
        let total = 0;
        for (const w of Object.values(table)) {
            total += w;
        }
        let r = Math.random() * total;
        let t = "T";
        for (const [key, w] of Object.entries(table)) {
            r -= w;
            if (r <= 0) {
                t = key;
                break;
            }
        }
        this.pups.push({ x, y, t, vy: 1.1, r: 13, ph: 0 });
    }

    /** Is a boss (regular or colossal) on the field right now? */
    _bossPresent() {
        return this.enemies.some((e) => this._isBoss(e));
    }

    /**
     * Boss fights kill the capsule flow: no small fry means no drops, so you
     * end up facing the hull with the plain shot. A supply capsule falls on a
     * timer while a boss is up (and every 25% of its health, see _updateEnemies).
     */
    _updateSupply(ts) {
        if (!this._bossPresent()) {
            // Slight head start so the first one lands early in the fight.
            this.supplyT = 150;
            return;
        }
        this.supplyT -= ts;
        if (this.supplyT > 0) {
            return;
        }
        this.supplyT = Math.round(430 / (1 + (this.players - 1) * 0.5));
        const x = this.fx0 + 60 + Math.random() * (this.fx1 - this.fx0 - 120);
        this.dropPup(x, this.fy0 + 30, true);
        this.pop(x, this.fy0 + 54, "Supply drop", "#7bffb0", 13);
        this.sTick();
    }

    /**
     * @param {Object} e - enemy
     * @param {Object} [killer] - ship that gets the credit (score/luck perks)
     */
    killEnemy(e, killer) {
        // The index is resolved here: splashes and chains can shuffle the array
        // while another loop is iterating it.
        const i = this.enemies.indexOf(e);
        if (i < 0) {
            return;
        }
        this.enemies.splice(i, 1);
        const big = this._isBoss(e);
        const colossal = e.type === "colossus";
        if (colossal) {
            // Its beams die with it, and the wreck blows up across the arena.
            this.beams = this.beams.filter((b) => b.src !== e.id);
            for (let k = 0; k < 22; k++) {
                this.burst(
                    e.x + (Math.random() - 0.5) * e.w,
                    e.y + (Math.random() - 0.5) * e.h,
                    e.c, 14, 7
                );
            }
            this.flashT = 14;
        }
        this.burst(e.x, e.y, e.c, big ? 90 : 24, big ? 8 : 4.5);
        this.burst(e.x, e.y, "#ffffff", big ? 30 : 8, 3);
        this._ev({ k: "boom", x: e.x, y: e.y, c: e.c, b: big ? 1 : 0 });
        if (killer && killer.dash > 0 && killer.flags.dash_refund) {
            // Kinetic Recharge: kills during the dash give the charge back.
            killer.dashCharges = Math.min(killer.dashMax, killer.dashCharges + 1);
        }
        const pts = Math.round(e.val * this.combo * (1 + (killer ? killer.mods.scoreMul : 0)));
        this.score += pts;
        this.pop(e.x, e.y, "+" + pts.toLocaleString(), "#fff", big ? 24 : 13);
        this.combo = Math.min(this.combo + 1, COMBO_MAX);
        this.comboT = 170;
        this.shake = Math.min(this.shake + (big ? 22 : 5), 24);
        if (big) {
            this.sBigBoom();
            this.bossAlive = false;
            if (this.players === 1) {
                this.slowMo = colossal ? 70 : 40;
            }
            this.shake = 26;
            const drops = colossal ? 6 : 3;
            for (let k = 0; k < drops; k++) {
                this.dropPup(
                    Math.max(30, Math.min(this.W - 30, e.x + (k - (drops - 1) / 2) * 46)),
                    Math.max(60, e.y)
                );
            }
            for (const sp of this._livingShips()) {
                sp.lives = Math.min(this._maxLives(sp), sp.lives + 1);
            }
            this.pop(e.x, e.y - 40, "Extra life for everyone!", "#7bffb0", 16);
        } else {
            this.sBoom();
            // Lucky Charm raises the drop rate of whoever landed the kill.
            if (Math.random() < 0.22 + (killer ? killer.mods.luck : 0)) {
                this.dropPup(e.x, e.y);
            }
        }
    }

    bomb(killer) {
        this.flashT = 12;
        this.sBigBoom();
        this._ev({ k: "bomb" });
        this.shake = 20;
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            const e = this.enemies[i];
            if (this._isBoss(e)) {
                this.burst(e.x, e.y, "#ffb347", 30, 6);
                this._damageEnemy(e, 14, killer);
            } else {
                this.killEnemy(e, killer);
            }
        }
        this.rocks = [];
        this.ebullets = [];
    }

    hurtShip(sp) {
        // Dashing is intangible: that is what makes the Space bar a real dodge.
        if (sp.down || sp.inv > 0 || sp.dash > 0) {
            return;
        }
        sp.hurtT = 240; // Adrenaline window (also feeds the HUD)
        sp.regenT = 0;
        const invMul = 1 + sp.mods.inv;
        if (sp.shield > 0) {
            sp.shield = 0;
            this.burst(sp.x, sp.y, "#7bffb0", 26, 5);
            this.noise(0.25, 0.2, 2000);
            sp.inv = 50 * invMul;
            this.pop(sp.x, sp.y - 30, "Shield down!", "#7bffb0", 14);
            return;
        }
        // Last Stand: cancels one lethal hit per wave.
        if (sp.lives <= 1 && sp.flags.last_stand && !sp.standT) {
            sp.standT = 1;
            sp.inv = 160 * invMul;
            this.burst(sp.x, sp.y, "#ff8fb3", 40, 6);
            this.pop(sp.x, sp.y - 32, "LAST STAND!", "#ff8fb3", 17);
            this.sPup();
            return;
        }
        sp.lives--;
        this.sHit();
        this._ev({ k: "hit", x: sp.x, y: sp.y, c: sp.color });
        this.shake = 18;
        if (this.players === 1) {
            this.slowMo = 28;
        }
        this.burst(sp.x, sp.y, sp.color, 46, 7);
        this.burst(sp.x, sp.y, "#ff8f5d", 26, 5);
        if (!sp.flags.combo_keep) {
            this.combo = 1;
        }
        if (sp.lives <= 0 && sp.flags.phoenix && !sp.phoenixUsed) {
            // Phoenix Core: one resurrection per run, with a shield on top.
            sp.phoenixUsed = true;
            sp.lives = 1;
            sp.shield = 1;
            sp.inv = 190 * invMul;
            this.burst(sp.x, sp.y, "#ffb347", 60, 7);
            this.pop(sp.x, sp.y - 32, "PHOENIX CORE!", "#ffb347", 18);
            this.sPup();
            return;
        }
        if (sp.lives <= 0) {
            sp.down = true;
            sp.reviveProgress = 0;
            sp.shield = 0;
            sp.weapon = "single";
            this.burst(sp.x, sp.y, sp.color, 44, 7);
            this.pop(sp.x, sp.y - 30, sp.name + " down", "#ff8f8f", 15);
            if (this._livingShips().length === 0) {
                this.state = "over";
                this.best = Math.max(this.best, this.score);
                if (this.cb.onGameOver) {
                    this.cb.onGameOver({
                        score: this.score,
                        wave: this.wave,
                        best: this.best,
                        seconds: this.playSeconds(),
                    });
                }
            }
        } else {
            sp.inv = 110 * (1 + sp.mods.inv);
        }
    }

    reset() {
        this.score = 0;
        this.playMs = 0;
        this._clock = 0;
        this.wave = 0;
        this.combo = 1;
        this.comboT = 0;
        this.bullets = [];
        this.ebullets = [];
        this.enemies = [];
        this.rocks = [];
        this.parts = [];
        this.pops = [];
        this.pups = [];
        this.trails = [];
        this.turrets = [];
        this.holes = [];
        this.decoys = [];
        this.zaps = [];
        this.beams = [];
        this.freezeT = 0;
        this.warpT = 0;
        this.shake = 0;
        this.slowMo = 0;
        this.flashT = 0;
        this.rockT = 180;
        this.bossAlive = false;
        this._events = [];
        // Perks are per run: a new game starts from a bare hull again.
        this.perkPhase = null;
        this.nextPerkWave = PERK_WAVES;
        this.field = 1;
        this.fieldTo = 1;
        this.supplyT = 0;
        this.pending = [];
        this.spawnT = 0;
        this.waveAge = 0;
        this.escortT = 0;
        this._applyField();
        this._syncBackground();
        this._initShips();
        for (const sp of this.ships) {
            sp.inv = 90;
        }
        this.waveDelay = 24;
    }

    /* ------------------------------------------------------------------ */
    /* Update (host / solo)                                                */
    /* ------------------------------------------------------------------ */

    update(ts) {
        const W = this.W;
        const H = this.H;

        this._updateStars(ts);

        // Perk phase: the field is frozen, only the choice UI is alive.
        if (this.state === "perk") {
            this._updatePerkPhase(ts);
            this._updateFx(ts);
            return;
        }
        if (this.state !== "playing") {
            this._updateFx(ts);
            return;
        }
        if (this.freezeT > 0) {
            this.freezeT -= ts;
        }
        if (this.warpT > 0) {
            this.warpT -= ts;
        }

        // Hotseat control: the slot 1 ship moves with WASD.
        if (this.hotseat && this.ships[1] && !this.ships[1].down) {
            const sp = this.ships[1];
            const spd = 7;
            if (this.keys.w) { sp.ty -= spd; }
            if (this.keys.s) { sp.ty += spd; }
            if (this.keys.a) { sp.tx -= spd; }
            if (this.keys.d) { sp.tx += spd; }
            sp.tx = Math.max(this.fx0 + 20, Math.min(this.fx1 - 20, sp.tx));
            sp.ty = Math.max(this.fy0 + 70, Math.min(this.fy1 - 24, sp.ty));
        }

        // Living ships: movement, dash, trail, fire, perk timers.
        for (const sp of this.ships) {
            if (sp.down) {
                continue;
            }
            this._updateShipTimers(sp, ts);
            this._moveShip(sp, ts);
            this._shipFire(sp, ts);
            if (sp.weaponT > 0) {
                sp.weaponT -= ts;
                if (sp.weaponT <= 0) {
                    sp.weapon = "single";
                    this.pop(sp.x, sp.y - 30, "Normal shot", "#8be9ff", 12);
                }
            }
        }

        this._updateRevive(ts);

        if (this.comboT > 0) {
            this.comboT -= ts;
            if (this.comboT <= 0) {
                this.combo = 1;
            }
        }

        // Own bullets (Homing Chips steer, Ricochet Rounds bounce).
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const b = this.bullets[i];
            if (b.cd > 0) {
                b.cd -= ts;
            }
            if (b.ho) {
                this._steerBullet(b, ts);
            }
            b.x += b.vx * ts;
            b.y += b.vy * ts;
            if (b.ri) {
                if (b.x < this.fx0 + 4) {
                    b.x = this.fx0 + 4;
                    b.vx = Math.abs(b.vx);
                } else if (b.x > this.fx1 - 4) {
                    b.x = this.fx1 - 4;
                    b.vx = -Math.abs(b.vx);
                }
                // The ceiling only bounces once, otherwise they never die.
                if (b.y < this.fy0 + 4 && !b.bt) {
                    b.y = this.fy0 + 4;
                    b.vy = Math.abs(b.vy);
                    b.bt = 1;
                }
            }
            if (b.y < this.fy0 - 20 || b.y > this.fy1 + 20 || b.x < this.fx0 - 20 || b.x > this.fx1 + 20) {
                this.bullets.splice(i, 1);
            }
        }
        // Enemy bullets: Stasis Field pins them, Time Warp slows them down.
        const ets = this.warpT > 0 ? ts * 0.4 : ts;
        for (let i = this.ebullets.length - 1; i >= 0; i--) {
            const b = this.ebullets[i];
            if (this.freezeT <= 0) {
                b.x += b.vx * ets;
                b.y += b.vy * ets;
            }
            if (b.y > this.fy1 + 20 || b.y < this.fy0 - 20 || b.x < this.fx0 - 20 || b.x > this.fx1 + 20) {
                this.ebullets.splice(i, 1);
                continue;
            }
            // Deflector Dash: what you cross mid-dash is turned around.
            let done = false;
            for (const sp of this.ships) {
                if (sp.down || sp.dash <= 0 || !sp.flags.dash_reflect) {
                    continue;
                }
                const dx = b.x - sp.x;
                const dy = b.y - sp.y;
                if (dx * dx + dy * dy < 46 * 46) {
                    this.bullets.push(this._mkBullet(sp, b.x, b.y, b.vx * -1.6, -Math.abs(b.vy || 3) * 1.6, this._bulletDmg(sp)));
                    this.burst(b.x, b.y, "#c9a4ff", 6, 2.5);
                    done = true;
                    break;
                }
            }
            if (!done) {
                for (const sp of this.ships) {
                    if (sp.down || sp.inv > 0 || sp.dash > 0) {
                        continue;
                    }
                    const dx = b.x - sp.x;
                    const dy = b.y - sp.y;
                    const rr = 16.5 * (1 + sp.mods.hitbox);
                    if (dx * dx + dy * dy < rr * rr) {
                        done = true;
                        this.hurtShip(sp);
                        break;
                    }
                }
            }
            if (done) {
                this.ebullets.splice(i, 1);
            }
        }

        this._updateEnemies(ts);
        this._updateRocks(ts);
        this._updatePups(ts);
        this._updateSpawns(ts);
        this._updateSupply(ts);
        this._updateBeams(ts);
        this._updateTrails(ts);
        this._updateTurrets(ts);
        this._updateHoles(ts);
        this._updateDecoys(ts);
        this._updateFx(ts);

        if (this.enemies.length === 0 && this.pending.length === 0) {
            this.waveDelay -= ts;
            if (this.waveDelay <= 0) {
                if (this.wave >= this.nextPerkWave) {
                    // Every PERK_WAVES cleared waves, everyone upgrades.
                    this.nextPerkWave += PERK_WAVES;
                    this._openPerkPhase();
                } else {
                    this.spawnWave();
                    this.waveDelay = 26;
                }
            }
        }
        this.rockT -= ts;
        if (this.rockT <= 0) {
            this.rockT = Math.max(80, 220 - this.wave * 12);
            this.spawnRock();
        }
        if (this.shake > 0) {
            this.shake *= 0.88;
        }
        if (this.flashT > 0) {
            this.flashT -= ts;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Ships: timers, movement, dash and fire                              */
    /* ------------------------------------------------------------------ */

    _shipBySlot(slot) {
        return this.ships.find((s) => s.slot === slot) || null;
    }

    _nearestEnemy(x, y) {
        let best = null;
        let bd = Infinity;
        for (const e of this.enemies) {
            const d = (e.x - x) ** 2 + (e.y - y) ** 2;
            if (d < bd) {
                bd = d;
                best = e;
            }
        }
        return best;
    }

    _anyAllyDown() {
        return this.ships.some((s) => s.down);
    }

    /** Dash cooldown of a ship (Phase Dash shortens it). */
    _dashCd(sp) {
        return Math.max(25, DASH_CD * (1 + sp.mods.dashCd));
    }

    /** Orbit position of the Drone Wing companion. */
    _dronePos(sp) {
        return { x: sp.x + Math.cos(sp.droneA) * 34, y: sp.y + Math.sin(sp.droneA) * 24 };
    }

    /** Homing Chips: bend the trajectory without changing the speed. */
    _steerBullet(b, ts) {
        const e = this._nearestEnemy(b.x, b.y);
        if (!e) {
            return;
        }
        const s = Math.hypot(b.vx, b.vy) || 1;
        const dx = e.x - b.x;
        const dy = e.y - b.y;
        const d = Math.hypot(dx, dy) || 1;
        b.vx += (dx / d) * 0.6 * ts;
        b.vy += (dy / d) * 0.6 * ts;
        const ns = Math.hypot(b.vx, b.vy) || 1;
        b.vx = (b.vx / ns) * s;
        b.vy = (b.vy / ns) * s;
    }

    _updateShipTimers(sp, ts) {
        if (sp.inv > 0) {
            sp.inv -= ts;
        }
        for (const k of BUFF_KEYS) {
            if (sp.buffs[k] > 0) {
                sp.buffs[k] -= ts;
                if (sp.buffs[k] <= 0) {
                    sp.buffs[k] = 0;
                    this.pop(sp.x, sp.y - 30, k === "D" ? "Wingman left" : "Boost over", "#8d93b8", 12);
                }
            }
        }
        if (sp.hurtT > 0) {
            sp.hurtT -= ts;
        }
        if (sp.odT > 0) {
            sp.odT -= ts;
        }
        if (sp.dash > 0) {
            sp.dash -= ts;
        }
        if (sp.dashCharges < sp.dashMax) {
            sp.dashCd -= ts;
            if (sp.dashCd <= 0) {
                sp.dashCharges++;
                sp.dashCd = sp.dashCharges < sp.dashMax ? this._dashCd(sp) : 0;
            }
        }
        for (const a of sp.actives) {
            if (a.cd > 0) {
                a.cd -= ts;
            }
        }
        // Nano Weave: rebuilds the shield 12 s after losing it.
        if (sp.flags.shield_regen && sp.shield <= 0) {
            sp.regenT += ts;
            if (sp.regenT >= 720) {
                sp.regenT = 0;
                sp.shield = 1;
                this.burst(sp.x, sp.y, "#7bffb0", 16, 3);
                this.pop(sp.x, sp.y - 30, "Shield rebuilt", "#7bffb0", 13);
            }
        }
        // Drone Wing (perk) or Wingman (capsule): orbits and fires on its own.
        if (sp.flags.drone || sp.buffs.D > 0) {
            sp.droneA += 0.045 * ts;
            sp.droneT -= ts;
            if (sp.droneT <= 0) {
                sp.droneT = 26;
                const p = this._dronePos(sp);
                this.bullets.push(this._mkBullet(sp, p.x, p.y - 6, 0, -10, this._bulletDmg(sp) * 0.8));
            }
        }
    }

    _moveShip(sp, ts) {
        if (sp.dash > 0) {
            sp.x += sp.dashVx * DASH_SPEED * ts;
            sp.y += sp.dashVy * DASH_SPEED * ts;
            if (sp.flags.dash_trail && this.frame % 2 === 0) {
                this.trails.push({ x: sp.x, y: sp.y, life: 42, ml: 42, sl: sp.slot });
            }
            this.parts.push({
                x: sp.x, y: sp.y,
                vx: (Math.random() - 0.5) * 2,
                vy: (Math.random() - 0.5) * 2,
                r: Math.random() * 3 + 1.5,
                c: "#c9a4ff", life: 18, ml: 18,
            });
        } else {
            let k = 0.2 * (1 + sp.mods.moveSpeed);
            if (sp.flags.adrenaline && sp.hurtT > 0) {
                k *= 1.4;
            }
            sp.x += (sp.tx - sp.x) * Math.min(0.55, k) * ts;
            sp.y += (sp.ty - sp.y) * Math.min(0.55, k) * ts;
        }
        // The field grows during a colossus fight: this is the only clamp.
        sp.x = Math.max(this.fx0 + 20, Math.min(this.fx1 - 20, sp.x));
        sp.y = Math.max(this.fy0 + 70, Math.min(this.fy1 - 24, sp.y));
        if (this.frame % 2 === 0) {
            this.parts.push({
                x: sp.x + (Math.random() - 0.5) * 6,
                y: sp.y + 16,
                vx: (Math.random() - 0.5) * 0.6,
                vy: 2.2,
                r: Math.random() * 2 + 1,
                c: "#3fa9ff",
                life: 16,
                ml: 16,
            });
        }
        // Feed the animation the motion this frame produced. It happens here,
        // in the simulation, so a paused game freezes the pose too.
        sp.flight.observe(sp.x, sp.y, ts * FRAME_SECONDS);
    }

    /** Space: burst towards the cursor, intangible while it lasts. */
    dashShip(slot) {
        const sp = this._shipBySlot(slot);
        if (!sp || sp.down || sp.dash > 0 || sp.dashCharges <= 0 || this.state !== "playing") {
            return;
        }
        let dx = sp.tx - sp.x;
        let dy = sp.ty - sp.y;
        const d = Math.hypot(dx, dy);
        if (d < 6) {
            // Standing still: the dash goes forward, like a boost.
            dx = 0;
            dy = -1;
        } else {
            dx /= d;
            dy /= d;
        }
        sp.dashVx = dx;
        sp.dashVy = dy;
        sp.dash = DASH_FRAMES;
        sp.dashCharges--;
        // A dash is exactly the brusque move the barrel roll is for, but it is
        // too short for the speed trigger to catch it on its own.
        sp.flight.kickRoll(dx || sp.flight.bank);
        if (sp.dashCd <= 0) {
            sp.dashCd = this._dashCd(sp);
        }
        this.burst(sp.x, sp.y, "#c9a4ff", 18, 4);
        if (sp.slot === this.localSlot) {
            this.tone(380, 0.12, "square", 0.05, 940);
        }
    }

    _shipFire(sp, ts) {
        sp.fireT -= ts;
        if (sp.fireT > 0) {
            return;
        }
        sp.fireT = this._fireDelay(sp);
        this._shoot(sp);
    }

    /**
     * One volley: the centre bullet plus one pair per `side` level (the triple
     * shot capsule counts as one pair) and, with Broadside, a flank salvo.
     */
    _shoot(sp) {
        if (sp.slot === this.localSlot) {
            this.sShoot();
        }
        this.burst(sp.x, sp.y - 20, "#aef1ff", 3, 1.5);
        const spd = 11 * (1 + sp.mods.bulletSpeed);
        const dmg = this._bulletDmg(sp);
        this.bullets.push(this._mkBullet(sp, sp.x, sp.y - 16, 0, -spd, dmg));
        const pairs = (sp.weapon === "triple" ? 1 : 0) + Math.max(0, sp.mods.side);
        for (let k = 1; k <= pairs; k++) {
            const a = 0.15 * k;
            this.bullets.push(
                this._mkBullet(sp, sp.x - 7 * k, sp.y - 10, -Math.sin(a) * spd, -Math.cos(a) * spd, dmg),
                this._mkBullet(sp, sp.x + 7 * k, sp.y - 10, Math.sin(a) * spd, -Math.cos(a) * spd, dmg)
            );
        }
        if (sp.flags.broadside && sp.volley++ % 2 === 0) {
            this.bullets.push(
                this._mkBullet(sp, sp.x - 14, sp.y, -spd * 0.85, 0, dmg),
                this._mkBullet(sp, sp.x + 14, sp.y, spd * 0.85, 0, dmg),
                this._mkBullet(sp, sp.x, sp.y + 16, 0, spd * 0.85, dmg)
            );
        }
    }

    /**
     * Frames between volleys. Conditional perks are resolved here, so their
     * bonus turns on and off with the situation instead of being baked in.
     */
    _fireDelay(sp) {
        const base = sp.weapon === "triple" ? 8 : 9;
        let m = 1 + sp.mods.fireRate;
        if (sp.odT > 0) {
            m -= 0.66;
        }
        if (sp.buffs.R > 0) {
            m -= 0.4;
        }
        if (sp.flags.berserker && sp.lives <= 1) {
            m -= 0.5;
        }
        if (sp.flags.adrenaline && sp.hurtT > 0) {
            m -= 0.4;
        }
        if (sp.flags.combo_surge && this.combo >= 10) {
            m -= 0.25;
        }
        if (sp.flags.guardian_link && this._anyAllyDown()) {
            m -= 0.35;
        }
        return Math.max(2, base * Math.max(0.18, m));
    }

    /** Damage of a bullet at the moment it leaves the cannon. */
    _bulletDmg(sp) {
        let d = 1 + sp.mods.dmg + (sp.buffs.V > 0 ? 1 : 0);
        if (sp.flags.berserker && sp.lives <= 1) {
            d += 1;
        }
        if (sp.flags.desperation && sp.shield <= 0) {
            d += 0.75;
        }
        if (sp.flags.combo_surge && this.combo >= 20) {
            d += 1;
        }
        if (sp.flags.guardian_link && this._anyAllyDown()) {
            d += 1;
        }
        return Math.max(0.34, d);
    }

    _mkBullet(sp, x, y, vx, vy, dmg) {
        const crit = sp.mods.crit > 0 && Math.random() < sp.mods.crit;
        return {
            x, y, vx, vy,
            d: dmg * (crit ? 2 + sp.mods.critMul : 1),
            sl: sp.slot,
            cr: crit ? 1 : 0,
            pi: sp.mods.pierce + (sp.buffs.P > 0 ? 2 : 0),
            ho: sp.flags.homing || sp.buffs.H > 0 ? 1 : 0,
            ri: sp.flags.ricochet ? 1 : 0,
            ex: sp.flags.explosive ? 1 : 0,
            ch: sp.flags.chain ? 1 : 0,
            cd: 0,   // frames without collisions (after piercing a hull)
            hid: 0,  // last enemy id hit, so a pierce does not double dip
        };
    }

    /** Damage actually applied, with the conditionals that depend on the target. */
    _impactDmg(b, e, sp) {
        let d = b.d;
        if (!sp) {
            return d;
        }
        if (sp.flags.boss_hunter && this._isBoss(e)) {
            d *= 2;
        }
        if (sp.flags.swarm_cleaver && (e.type === "drone" || e.type === "speedy")) {
            d += 1.5;
        }
        if (sp.flags.long_shot && e.y < this.H * 0.32) {
            d += 1.5;
        }
        if (sp.flags.point_blank && (e.x - sp.x) ** 2 + (e.y - sp.y) ** 2 < 90 * 90) {
            d += 2;
        }
        return d;
    }

    /**
     * Apply damage to an enemy through a single door: WARDEN raises armour and
     * every source (bullets, splash, chains, trails, singularities, bombs) has
     * to respect it.
     *
     * @returns {boolean} true if the enemy died
     */
    _damageEnemy(e, dmg, killer) {
        e.hp -= e.armor ? dmg * 0.35 : dmg;
        if (e.hp <= 0) {
            this.killEnemy(e, killer);
            return true;
        }
        return false;
    }

    /** Explosive Tips / Orbital Strike splash. */
    _splash(x, y, r, dmg, sp, skip) {
        this.burst(x, y, "#ffb347", 12, 3.5);
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            const e = this.enemies[i];
            if (e === skip || (e.x - x) ** 2 + (e.y - y) ** 2 > r * r) {
                continue;
            }
            e.flash = 5;
            this._damageEnemy(e, dmg, sp);
        }
    }

    /** Arc Capacitor: bolt from the hull just hit to the next one. */
    _chain(from, dmg, sp) {
        let best = null;
        let bd = 150 * 150;
        for (const e of this.enemies) {
            if (e === from) {
                continue;
            }
            const d = (e.x - from.x) ** 2 + (e.y - from.y) ** 2;
            if (d < bd) {
                bd = d;
                best = e;
            }
        }
        if (!best) {
            return;
        }
        best.flash = 5;
        this.zaps.push({ x1: from.x, y1: from.y, x2: best.x, y2: best.y, life: 8 });
        this._ev({ k: "zap", x: from.x, y: from.y, x2: best.x, y2: best.y });
        this._damageEnemy(best, dmg, sp);
    }

    /* ------------------------------------------------------------------ */
    /* Active perks (keys 1..4)                                            */
    /* ------------------------------------------------------------------ */

    /** Trigger the n-th active of a slot, if it is off cooldown. */
    useActive(slot, index) {
        const sp = this._shipBySlot(slot);
        if (!sp || sp.down || this.state !== "playing") {
            return;
        }
        const act = sp.actives[index];
        if (!act || act.cd > 0) {
            return;
        }
        act.cd = act.cdMax;
        this._fireActive(sp, act.id);
    }

    _fireActive(sp, id) {
        const dmg = this._bulletDmg(sp);
        if (id === "nova_burst") {
            for (let k = 0; k < 24; k++) {
                const a = (k / 24) * 6.2832;
                this.bullets.push(this._mkBullet(sp, sp.x, sp.y, Math.cos(a) * 8, Math.sin(a) * 8, dmg));
            }
            this.burst(sp.x, sp.y, "#ffb347", 30, 5);
            this.sBoom();
        } else if (id === "stasis_field") {
            this.freezeT = 180;
            this.flashT = 8;
            this.pop(sp.x, sp.y - 34, "STASIS", "#5ee1ff", 17);
            this.tone(180, 0.4, "sine", 0.12, 60);
        } else if (id === "emp_pulse") {
            for (let i = this.ebullets.length - 1; i >= 0; i--) {
                const b = this.ebullets[i];
                if ((b.x - sp.x) ** 2 + (b.y - sp.y) ** 2 < 240 * 240) {
                    this.ebullets.splice(i, 1);
                }
            }
            for (const e of this.enemies) {
                // A colossus is too big to stun: the EMP only chips at it.
                if ((e.x - sp.x) ** 2 + (e.y - sp.y) ** 2 < 240 * 240) {
                    if (e.type === "colossus") {
                        e.flash = 6;
                        this._damageEnemy(e, 6, sp);
                    } else {
                        e.stun = 150;
                    }
                }
            }
            this.burst(sp.x, sp.y, "#5ee1ff", 40, 7);
            this.shake = Math.min(this.shake + 12, 24);
            this.noise(0.4, 0.25, 3000);
        } else if (id === "overdrive") {
            sp.odT = 300;
            this.pop(sp.x, sp.y - 34, "OVERDRIVE", "#ffb347", 17);
            this.sPup();
        } else if (id === "bulwark") {
            sp.shield = 1;
            sp.inv = Math.max(sp.inv, 240);
            this.burst(sp.x, sp.y, "#7bffb0", 30, 5);
            this.pop(sp.x, sp.y - 34, "BULWARK", "#7bffb0", 17);
        } else if (id === "orbital_strike") {
            for (let k = 0; k < 6; k++) {
                const b = this._mkBullet(sp, 60 + Math.random() * (this.W - 120), -20 - k * 30, 0, 7, dmg + 2);
                b.ho = 1;
                b.ex = 1;
                this.bullets.push(b);
            }
            this.pop(sp.x, sp.y - 34, "ORBITAL STRIKE", "#ffb347", 16);
            this.sBigBoom();
        } else if (id === "black_hole") {
            this.holes.push({
                x: Math.max(90, Math.min(this.W - 90, sp.x)),
                y: Math.max(110, sp.y - 140),
                life: 240, ml: 240, r: 150, sl: sp.slot,
            });
            this.tone(90, 0.6, "sawtooth", 0.16, 30);
        } else if (id === "time_warp") {
            this.warpT = 240;
            this.pop(sp.x, sp.y - 34, "TIME WARP", "#c9a4ff", 17);
            this.tone(600, 0.5, "sine", 0.1, 120);
        } else if (id === "turret_drop") {
            this.turrets.push({ x: sp.x, y: sp.y, life: 600, t: 0, sl: sp.slot });
            this.burst(sp.x, sp.y, "#ffd166", 16, 3);
            this.sTick();
        } else if (id === "decoy_beacon") {
            this.decoys.push({ x: sp.x, y: sp.y, life: 360, ml: 360, sl: sp.slot });
            this.burst(sp.x, sp.y, "#8be9ff", 18, 3);
            this.pop(sp.x, sp.y - 34, "DECOY", "#8be9ff", 15);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Entities created by perks                                           */
    /* ------------------------------------------------------------------ */

    /** Plasma Wake: the dash trail burns whatever flies over it. */
    _updateTrails(ts) {
        for (let i = this.trails.length - 1; i >= 0; i--) {
            const tr = this.trails[i];
            tr.life -= ts;
            if (tr.life <= 0) {
                this.trails.splice(i, 1);
                continue;
            }
            const sp = this._shipBySlot(tr.sl);
            for (let k = this.enemies.length - 1; k >= 0; k--) {
                const e = this.enemies[k];
                if ((e.x - tr.x) ** 2 + (e.y - tr.y) ** 2 < (e.r + 16) ** 2) {
                    e.flash = 3;
                    this._damageEnemy(e, 0.14 * ts, sp);
                }
            }
        }
    }

    _updateTurrets(ts) {
        for (let i = this.turrets.length - 1; i >= 0; i--) {
            const tu = this.turrets[i];
            tu.life -= ts;
            if (tu.life <= 0) {
                this.burst(tu.x, tu.y, "#ffd166", 14, 3);
                this.turrets.splice(i, 1);
                continue;
            }
            tu.t -= ts;
            if (tu.t <= 0) {
                tu.t = 16;
                const sp = this._shipBySlot(tu.sl);
                if (sp) {
                    const e = this._nearestEnemy(tu.x, tu.y);
                    let vx = 0;
                    let vy = -10;
                    if (e) {
                        const dx = e.x - tu.x;
                        const dy = e.y - tu.y;
                        const d = Math.hypot(dx, dy) || 1;
                        vx = (dx / d) * 10;
                        vy = (dy / d) * 10;
                    }
                    this.bullets.push(this._mkBullet(sp, tu.x, tu.y - 10, vx, vy, this._bulletDmg(sp) * 0.7));
                }
            }
        }
    }

    /** Black Hole: drags in enemies, rocks and capsules while it grinds. */
    _updateHoles(ts) {
        for (let i = this.holes.length - 1; i >= 0; i--) {
            const h = this.holes[i];
            h.life -= ts;
            if (h.life <= 0) {
                this.burst(h.x, h.y, "#c9a4ff", 40, 6);
                this.holes.splice(i, 1);
                continue;
            }
            const sp = this._shipBySlot(h.sl);
            const pull = (obj, k) => {
                const dx = h.x - obj.x;
                const dy = h.y - obj.y;
                const d = Math.hypot(dx, dy) || 1;
                if (d > h.r) {
                    return d;
                }
                obj.x += (dx / d) * k * ts;
                obj.y += (dy / d) * k * ts;
                return d;
            };
            for (let k = this.enemies.length - 1; k >= 0; k--) {
                const e = this.enemies[k];
                if (this._isBoss(e)) {
                    continue; // a dreadnought does not get dragged around
                }
                const d = pull(e, 1.8);
                if (d <= h.r) {
                    this._damageEnemy(e, 0.08 * ts, sp);
                }
            }
            for (const rk of this.rocks) {
                pull(rk, 1.4);
            }
            for (const p of this.pups) {
                pull(p, 1.2);
            }
        }
    }

    _updateDecoys(ts) {
        for (let i = this.decoys.length - 1; i >= 0; i--) {
            const d = this.decoys[i];
            d.life -= ts;
            if (d.life <= 0) {
                this.burst(d.x, d.y, "#8be9ff", 14, 3);
                this.decoys.splice(i, 1);
            }
        }
    }

    _updateStars(ts) {
        // The scenery ticks with the star field: both are pure decoration and
        // both run on the host and on the guest.
        if (this.bg) {
            this.bg.update(ts);
        }
        const mx = this.W * 0.55;
        const my = this.H * 0.55;
        for (const s of this.stars) {
            s.y += s.z * (1.2 + this.wave * 0.06) * ts;
            if (s.y > this.H + my) {
                s.y = -my;
                s.x = -mx + Math.random() * (this.W + mx * 2);
            }
        }
    }

    _updateRevive(ts) {
        for (const dn of this.ships) {
            if (!dn.down) {
                continue;
            }
            // Rate 1 by default, x3 if the reviver carries Field Medic.
            let rate = 0;
            for (const sp of this.ships) {
                if (sp.down || sp === dn) {
                    continue;
                }
                const dx = sp.x - dn.x;
                const dy = sp.y - dn.y;
                if (dx * dx + dy * dy < 42 * 42) {
                    rate = Math.max(rate, sp.flags.medic ? 3 : 1);
                }
            }
            if (rate) {
                dn.reviveProgress += ts * rate;
                if (this.frame % 18 === 0) {
                    this.sTick();
                }
                if (dn.reviveProgress >= REVIVE_FRAMES) {
                    dn.down = false;
                    dn.lives = 1;
                    dn.inv = 120;
                    dn.reviveProgress = 0;
                    this.burst(dn.x, dn.y, "#7bffb0", 40, 6);
                    this.pop(dn.x, dn.y - 30, dn.name + " revived!", "#7bffb0", 16);
                    this.sPup();
                    this._ev({ k: "pup", x: dn.x, y: dn.y });
                }
            } else if (dn.reviveProgress > 0) {
                dn.reviveProgress = Math.max(0, dn.reviveProgress - ts * 0.5);
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Colossal bosses                                                     */
    /* ------------------------------------------------------------------ */

    /** Enemy bullet fired by a boss (slightly faster than the small fry). */
    _eb(x, y, vx, vy) {
        this.ebullets.push({ x, y, vx, vy });
    }

    /** Aimed shot from an arbitrary point of the hull. */
    _ebAimed(x, y, speed, spread) {
        const tgt = this.decoys.length ? this._target(x, y) : this._aimShip();
        if (!tgt) {
            return;
        }
        const dx = tgt.x - x;
        const dy = tgt.y - y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const a = Math.atan2(dy, dx) + (spread || 0);
        this._eb(x, y, Math.cos(a) * speed, Math.sin(a) * speed);
    }

    /**
     * Beams: telegraphed first (`warn` frames of a thin sight line), then live.
     * `src` anchors them to a hull so they follow it, `spin` sweeps them.
     */
    mkBeam(o) {
        return Object.assign(
            { x: 0, y: 0, ox: 0, oy: 0, a: Math.PI / 2, len: 1200, w: 26, warn: 60, life: 120, spin: 0, src: 0, c: "#ff4d4d" },
            o
        );
    }

    _updateBeams(ts) {
        for (let i = this.beams.length - 1; i >= 0; i--) {
            const b = this.beams[i];
            if (b.src) {
                const owner = this.enemies.find((e) => e.id === b.src);
                if (!owner) {
                    this.beams.splice(i, 1);
                    continue;
                }
                b.x = owner.x + b.ox;
                b.y = owner.y + b.oy;
            }
            b.a += b.spin * ts;
            if (b.warn > 0) {
                b.warn -= ts;
                if (b.warn <= 0) {
                    this.noise(0.3, 0.16, 1800);
                }
                continue;
            }
            b.life -= ts;
            if (b.life <= 0) {
                this.beams.splice(i, 1);
                continue;
            }
            // Damage: distance from the ship to the beam segment.
            const ex = b.x + Math.cos(b.a) * b.len;
            const ey = b.y + Math.sin(b.a) * b.len;
            for (const sp of this.ships) {
                if (sp.down || sp.inv > 0 || sp.dash > 0) {
                    continue;
                }
                if (this._distToSeg(sp.x, sp.y, b.x, b.y, ex, ey) < b.w * 0.5 + 8 * (1 + sp.mods.hitbox)) {
                    this.hurtShip(sp);
                }
            }
            if (this.frame % 3 === 0) {
                const t = Math.random();
                this.burst(b.x + Math.cos(b.a) * b.len * t, b.y + Math.sin(b.a) * b.len * t, b.c, 2, 2);
            }
        }
    }

    _distToSeg(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const l2 = dx * dx + dy * dy;
        let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
    }

    /** AI of the five colossi (keyed by `e.k`, same order as COLOSSI). */
    _updateColossus(e, mv) {
        const W = this.W;
        // Entrance: it slides in from above without shooting.
        if (e.y < e.ty) {
            e.y += 1.3 * mv;
            return;
        }
        e.x += e.vx * mv * 0.55;
        if (e.x > W / 2 + 105) {
            e.vx = -Math.abs(e.vx);
        } else if (e.x < W / 2 - 105) {
            e.vx = Math.abs(e.vx);
        }
        const rage = e.hp < e.mhp * 0.45;
        e.a1 -= mv;
        e.a2 -= mv;
        e.a3 -= mv;
        const bottom = e.y + e.hh;
        if (e.k === 0) {
            // AEGIS-01: curtain of fire with one gap + twin siege salvos.
            if (e.a1 <= 0) {
                e.a1 = rage ? 62 : 95;
                e.gap = this.fx0 + 60 + ((e.gap + 137) % (this.fx1 - this.fx0 - 120));
                for (let x = this.fx0 + 10; x < this.fx1; x += 34) {
                    if (Math.abs(x - e.gap) < 62) {
                        continue;
                    }
                    this._eb(x, bottom, 0, 2.4);
                }
                this.sTick();
            }
            if (e.a2 <= 0) {
                e.a2 = 190;
                for (const off of [-e.w * 0.22, e.w * 0.22]) {
                    for (let s = -1; s <= 1; s++) {
                        this._ebAimed(e.x + off, bottom, 5, s * 0.12);
                    }
                }
                this.sTick();
            }
        } else if (e.k === 1) {
            // HYDRA-07: crown spiral + aimed fans from the side heads.
            if (e.a1 <= 0) {
                e.a1 = rage ? 5 : 9;
                const arms = rage ? 3 : 2;
                for (let k = 0; k < arms; k++) {
                    const a = e.t * 0.11 + (k / arms) * 6.2832;
                    this._eb(e.x, e.y - e.h * 0.1, Math.cos(a) * 2.7, Math.sin(a) * 2.7);
                }
            }
            if (e.a2 <= 0) {
                e.a2 = rage ? 110 : 165;
                for (const off of [-e.w * 0.38, e.w * 0.38]) {
                    for (let s = -2; s <= 2; s++) {
                        this._ebAimed(e.x + off, e.y + e.h * 0.28, 3.6, s * 0.16);
                    }
                }
                this.sTick();
            }
        } else if (e.k === 2) {
            // VULCAN: asteroid barrage, molten rings and two forge beams.
            if (e.a1 <= 0) {
                e.a1 = rage ? 46 : 74;
                this.spawnRock(
                    this.fx0 + 60 + Math.random() * (this.fx1 - this.fx0 - 120),
                    e.y + e.hh, 18 + Math.random() * 16
                );
            }
            if (e.a2 <= 0) {
                e.a2 = 230;
                for (let k = 0; k < 18; k++) {
                    const a = (k / 18) * 6.2832 + e.t * 0.01;
                    this._eb(e.x, e.y, Math.cos(a) * 2.5, Math.sin(a) * 2.5);
                }
                this.sBoom();
            }
            if (e.a3 <= 0) {
                e.a3 = rage ? 250 : 330;
                // Two forge beams, alternating pattern so the fight keeps
                // asking a different question:
                //  - scissors: they start crossed and sweep through each other;
                //  - sweep: both rake the arena the same way, like a wiper.
                e.pat = (e.pat || 0) ^ 1;
                const spin = (rage ? 0.0075 : 0.0055);
                for (const side of [-1, 1]) {
                    this.beams.push(this.mkBeam({
                        src: e.id,
                        ox: side * e.w * 0.4,
                        oy: e.h * 0.25,
                        // Scissors: each claw aims across to the far side.
                        a: e.pat
                            ? Math.PI / 2 + side * 0.95
                            : Math.PI / 2 - 0.85,
                        warn: 60,
                        life: 210,
                        w: 30,
                        spin: e.pat ? -side * spin : spin,
                        c: "#ffb347",
                    }));
                }
            }
        } else if (e.k === 3) {
            // NYX: four beams turning like clock hands + interceptors.
            if (!this.beams.some((b) => b.src === e.id)) {
                for (let k = 0; k < 4; k++) {
                    this.beams.push(this.mkBeam({
                        src: e.id, a: (k / 4) * 6.2832, warn: 90,
                        life: 100000, w: 22, spin: 0.0075, c: "#4de3c1", len: 1400,
                    }));
                }
            }
            if (e.a2 <= 0) {
                e.a2 = rage ? 170 : 260;
                for (const off of [-e.w * 0.42, e.w * 0.42]) {
                    const spawn = this.mkEnemy(Math.random() < 0.5 ? "speedy" : "drone", e.x + off, e.y + e.hh);
                    this.enemies.push(spawn);
                }
                this.sTick();
            }
        } else {
            // OMEGA: sweeping eye beam, kamikaze seeding, ring bursts and it
            // closes in once it is hurt.
            if (e.a1 <= 0) {
                e.a1 = 340;
                const dir = Math.random() < 0.5 ? 1 : -1;
                this.beams.push(this.mkBeam({
                    src: e.id, oy: e.h * 0.05,
                    a: Math.PI / 2 - 0.55 * dir, warn: 75, life: 190,
                    w: 44, spin: 0.0058 * dir, c: "#ff2fd0", len: 1500,
                }));
            }
            if (e.a2 <= 0) {
                e.a2 = rage ? 150 : 215;
                for (const off of [-e.w * 0.4, e.w * 0.4]) {
                    this.enemies.push(this.mkEnemy("kami", e.x + off, e.y + e.hh * 0.8));
                }
            }
            if (e.a3 <= 0) {
                e.a3 = rage ? 90 : 130;
                for (let k = 0; k < 12; k++) {
                    const a = (k / 12) * 6.2832 + e.t * 0.02;
                    this._eb(e.x, e.y, Math.cos(a) * 3, Math.sin(a) * 3);
                }
            }
            if (rage && e.ty < 235) {
                e.ty += 0.05 * mv;
                e.y += 0.05 * mv;
            }
        }
    }

    /**
     * AI of the regular boss family (keyed by `e.k`, same order as BOSSES).
     * They all fit the arena and leave the camera alone; what changes is how
     * they ask you to move.
     */
    _updateBoss(e, mv) {
        const W = this.W;
        if (e.k === 2) {
            this._bossLancer(e, mv);
            return;
        }
        if (e.k === 4) {
            this._bossPrism(e, mv);
            return;
        }
        // Dreadnought, warden and hive share the "slide in and patrol" base.
        if (e.y < 95) {
            e.y += 1.4 * mv;
            return;
        }
        if (mv <= 0) {
            return;
        }
        if (e.k === 1) {
            this._bossWarden(e, mv);
            return;
        }
        if (e.k === 3) {
            this._bossHive(e, mv);
            return;
        }
        // DREADNOUGHT: wide sweep, radial bursts and aimed triples.
        e.x = W / 2 + Math.sin(e.t * 0.016) * (W * 0.32);
        if (Math.floor(e.t) % 85 === 0) {
            for (let k = 0; k < 9; k++) {
                const a = (k / 9) * 6.2832 + e.t * 0.01;
                this._eb(e.x, e.y, Math.cos(a) * 2.3, Math.sin(a) * 2.3);
            }
            this.sTick();
        }
        if (Math.floor(e.t) % 55 === 27) {
            for (let k = -1; k <= 1; k++) {
                this._ebAimed(e.x, e.y, 3, k * 0.22);
            }
            this.sTick();
        }
    }

    /**
     * WARDEN: alternates an armoured phase (curtain of fire with one gap, hits
     * barely scratch it) with an exposed one (aimed fans). The whole fight is
     * about spending the window when the armour drops.
     */
    _bossWarden(e, mv) {
        e.x += Math.sin(e.t * 0.011) * 1.5 * mv;
        e.x = Math.max(this.fx0 + 80, Math.min(this.fx1 - 80, e.x));
        e.phase -= mv;
        if (e.phase <= 0) {
            e.armor = e.armor ? 0 : 1;
            e.phase = e.armor ? 330 : 260;
            this.burst(e.x, e.y, e.armor ? "#4de3c1" : "#ffd166", 20, 4);
            this.pop(e.x, e.y - e.r - 16, e.armor ? "ARMOUR UP" : "ARMOUR DOWN",
                e.armor ? "#4de3c1" : "#ffd166", 13);
        }
        if (e.armor) {
            if (Math.floor(e.t) % 105 === 0) {
                e.gap = this.fx0 + 60 + ((e.gap + 151) % (this.fx1 - this.fx0 - 120));
                for (let x = this.fx0 + 12; x < this.fx1; x += 40) {
                    if (Math.abs(x - e.gap) < 66) {
                        continue;
                    }
                    this._eb(x, e.y + e.r * 0.6, 0, 2.2);
                }
                this.sTick();
            }
        } else if (Math.floor(e.t) % 42 === 0) {
            for (let k = -2; k <= 2; k++) {
                this._ebAimed(e.x, e.y, 3.4, k * 0.17);
            }
            this.sTick();
        }
    }

    /**
     * LANCER: hovers, charges a lance beam straight down, then dives through
     * the arena and climbs back. Light hull, so it punishes standing still.
     */
    _bossLancer(e, mv) {
        if (e.y < 110 && e.phase === 0) {
            e.y += 2 * mv;
            return;
        }
        if (mv <= 0) {
            return;
        }
        e.phase = e.phase || 1;
        if (e.phase === 1) {
            // Hover over a target and charge the lance.
            const tgt = this._target(e.x, e.y);
            if (tgt) {
                e.x += Math.max(-2.2, Math.min(2.2, (tgt.x - e.x) * 0.02)) * mv;
            }
            e.a1 = (e.a1 || 0) - mv;
            if (e.a1 <= 0) {
                e.a1 = 250;
                this.beams.push(this.mkBeam({
                    src: e.id, oy: e.r * 0.7, a: Math.PI / 2,
                    warn: 55, life: 90, w: 34, spin: 0, c: "#ffd166", len: 900,
                }));
                e.phase = 2;
                e.a2 = 150;
            }
            if (Math.floor(e.t) % 30 === 0) {
                this._ebAimed(e.x, e.y, 3.6);
            }
        } else if (e.phase === 2) {
            // The dive starts once the beam is spent.
            e.a2 -= mv;
            if (e.a2 <= 0) {
                e.phase = 3;
                const tgt = this._target(e.x, e.y);
                e.vx = tgt ? Math.max(-3, Math.min(3, (tgt.x - e.x) * 0.03)) : 0;
                e.vy = 7;
            }
        } else {
            e.x += e.vx * mv;
            e.y += e.vy * mv;
            if (this.frame % 3 === 0) {
                this.burst(e.x, e.y, e.c, 3, 2);
            }
            if (e.y > this.fy1 - 40) {
                e.vy = -6.5;   // climb back out
            }
            if (e.y < 110 && e.vy < 0) {
                e.y = 110;
                e.vy = 0;
                e.phase = 1;
                e.a1 = 120;
            }
        }
    }

    /** HIVE: barely shoots, keeps pouring interceptors out of its bays. */
    _bossHive(e, mv) {
        e.x += Math.sin(e.t * 0.008) * 1.1 * mv;
        e.x = Math.max(this.fx0 + 70, Math.min(this.fx1 - 70, e.x));
        e.a1 = (e.a1 || 0) - mv;
        if (e.a1 <= 0) {
            e.a1 = Math.max(62, 140 - this.wave * 2);
            const brood = this.wave > 8 ? ["drone", "speedy", "kami"] : ["drone", "speedy"];
            // Three bays past the midgame: the flood is the whole point.
            const bays = this.wave > 12 ? [-e.r * 0.6, 0, e.r * 0.6] : [-e.r * 0.55, e.r * 0.55];
            for (const off of bays) {
                const type = brood[Math.floor(Math.random() * brood.length)];
                this.enemies.push(this.mkEnemy(type, e.x + off, e.y + e.r * 0.5));
            }
            this.burst(e.x, e.y + e.r * 0.5, e.c, 10, 3);
            this.sTick();
        }
        if (Math.floor(e.t) % 130 === 0) {
            for (let k = 0; k < 7; k++) {
                const a = (k / 7) * 6.2832 + e.t * 0.02;
                this._eb(e.x, e.y, Math.cos(a) * 1.9, Math.sin(a) * 1.9);
            }
        }
    }

    /** PRISM: blinks around the arena, spinning a three-armed spiral. */
    _bossPrism(e, mv) {
        if (e.y < 120 && !e.phase) {
            e.y += 2 * mv;
            return;
        }
        if (mv <= 0) {
            return;
        }
        e.phase = 1;
        e.a1 = (e.a1 || 0) - mv;
        if (e.a1 <= 0) {
            e.a1 = 150;
            // Shockwave where it was, then reappear somewhere else.
            for (let k = 0; k < 14; k++) {
                const a = (k / 14) * 6.2832;
                this._eb(e.x, e.y, Math.cos(a) * 2.6, Math.sin(a) * 2.6);
            }
            this.burst(e.x, e.y, e.c, 26, 5);
            this._ev({ k: "boom", x: e.x, y: e.y, c: e.c, b: 0 });
            e.x = this.fx0 + 90 + Math.random() * (this.fx1 - this.fx0 - 180);
            e.y = 110 + Math.random() * 90;
            this.burst(e.x, e.y, "#ffffff", 20, 4);
            this.sPup();
        }
        if (Math.floor(e.t) % 7 === 0) {
            for (let k = 0; k < 3; k++) {
                const a = e.t * 0.09 + (k / 3) * 6.2832;
                this._eb(e.x, e.y, Math.cos(a) * 2.9, Math.sin(a) * 2.9);
            }
        }
    }

    _updateEnemies(ts) {
        const W = this.W;
        const H = this.H;
        // Iterate over a copy: a splash or a chain can remove other enemies
        // while this loop runs, so membership is re-checked instead of relying
        // on the index.
        for (const e of this.enemies.slice()) {
            if (!this.enemies.includes(e)) {
                continue;
            }
            // EMP Pulse freezes the hull completely; Time Warp only slows it.
            if (e.stun > 0) {
                e.stun -= ts;
            }
            let mv = e.stun > 0 ? 0 : (this.warpT > 0 ? ts * 0.4 : ts);
            if (e.rush) {
                mv *= 1.9;
            }
            e.t += mv;
            if (e.type === "colossus") {
                this._updateColossus(e, mv);
            } else if (e.type === "drone") {
                e.y += (1.2 + this.wave * 0.05) * mv;
                e.x += Math.sin(e.t * 0.05) * 1.1 * mv;
            } else if (e.type === "speedy") {
                e.y += (3 + this.wave * 0.08) * mv;
                const tgt = this._target(e.x, e.y);
                if (tgt) {
                    e.x += (tgt.x - e.x) * 0.006 * mv;
                }
            } else if (e.type === "tank") {
                e.y += 0.65 * mv;
                if (e.y > 0 && mv > 0 && Math.floor(e.t) % 150 === 0) {
                    const tgt = this.decoys.length ? this._target(e.x, e.y) : this._aimShip();
                    if (tgt) {
                        const dx = tgt.x - e.x;
                        const dy = tgt.y - e.y;
                        const d = Math.sqrt(dx * dx + dy * dy) || 1;
                        this.ebullets.push({ x: e.x, y: e.y, vx: (dx / d) * 2.6, vy: (dy / d) * 2.6 });
                        this.sTick();
                    }
                }
            } else if (e.type === "sniper") {
                // Descends to its firing height and then holds, aiming.
                if (e.y < e.stopY) {
                    e.y += 1.1 * mv;
                } else {
                    e.x += Math.sin(e.t * 0.02) * 0.5 * mv;
                    e.aim += mv;
                    if (e.aim >= 70) {
                        e.aim = 0;
                        // Shoots what it telegraphed (nearest ship or decoy).
                        const tgt = this._target(e.x, e.y);
                        if (tgt) {
                            const dx = tgt.x - e.x;
                            const dy = tgt.y - e.y;
                            const d = Math.sqrt(dx * dx + dy * dy) || 1;
                            this.ebullets.push({ x: e.x, y: e.y, vx: (dx / d) * 5.2, vy: (dy / d) * 5.2 });
                            this.sTick();
                        }
                    }
                }
            } else if (e.type === "kami") {
                // Chases its target, accelerating; the core goes wild.
                const tgt = this._target(e.x, e.y);
                if (tgt) {
                    const dx = tgt.x - e.x;
                    const dy = tgt.y - e.y;
                    const d = Math.sqrt(dx * dx + dy * dy) || 1;
                    e.vx += (dx / d) * 0.09 * mv;
                    e.vy += (dy / d) * 0.09 * mv;
                }
                const sp = Math.sqrt(e.vx * e.vx + e.vy * e.vy) || 1;
                const max = 3.4 + this.wave * 0.06;
                if (sp > max) {
                    e.vx = (e.vx / sp) * max;
                    e.vy = (e.vy / sp) * max;
                }
                e.x += e.vx * mv;
                e.y += e.vy * mv;
                // The sprite looks downwards: rotate relative to +Y.
                e.rot = Math.atan2(e.vy, e.vx) - Math.PI / 2;
            } else {
                this._updateBoss(e, mv);
            }
            // Every quarter of health a boss loses, it sheds a capsule.
            if (this._isBoss(e) && e.dropAt > 0 && e.hp <= e.mhp * e.dropAt) {
                e.dropAt -= 0.25;
                const dy = e.type === "colossus" ? e.hh : e.r;
                this.dropPup(
                    Math.max(this.fx0 + 30, Math.min(this.fx1 - 30, e.x + (Math.random() - 0.5) * 160)),
                    e.y + dy, true
                );
                this.sPup();
            }
            if (e.y > this.fy1 + 50) {
                const idx = this.enemies.indexOf(e);
                if (idx >= 0) {
                    this.enemies.splice(idx, 1);
                }
                continue;
            }
            // Collision with ships.
            let killedByShip = false;
            for (const sp of this.ships) {
                if (sp.down) {
                    continue;
                }
                if (this._enemyHit(e, sp.x, sp.y, 13 * (1 + sp.mods.hitbox))) {
                    const ram = sp.dash > 0 && sp.flags.dash_ram;
                    if (!ram) {
                        this.hurtShip(sp);
                    }
                    if (!this._isBoss(e)) {
                        this.killEnemy(e, sp);
                        killedByShip = true;
                    } else if (ram) {
                        // Ram Prow also bites into a boss, without killing it.
                        e.flash = 6;
                        this.burst(sp.x, sp.y, "#c9a4ff", 20, 5);
                        killedByShip = this._damageEnemy(e, 3, sp);
                    }
                    break;
                }
            }
            if (killedByShip) {
                continue;
            }
            // Own bullets.
            for (let j = this.bullets.length - 1; j >= 0; j--) {
                const b = this.bullets[j];
                if (b.cd > 0 || b.hid === e.id) {
                    continue;
                }
                if (!this._enemyHit(e, b.x, b.y, 4)) {
                    continue;
                }
                const owner = this._shipBySlot(b.sl);
                const dmg = this._impactDmg(b, e, owner);
                const dead = this._damageEnemy(e, dmg, owner);
                this.burst(b.x, b.y, b.cr ? "#ffd166" : "#fff", b.cr ? 10 : 4, b.cr ? 3.5 : 2);
                if (b.cr) {
                    this.pop(b.x, b.y - 8, "CRIT", "#ffd166", 11, 30);
                }
                if (b.ex) {
                    this._splash(b.x, b.y, 62, dmg * 0.6, owner, e);
                }
                if (b.ch) {
                    this._chain(e, dmg * 0.5, owner);
                }
                // Piercing Rounds: the bullet survives, but not against the
                // same hull (`hid`) and not on the very next frames (`cd`).
                if (b.pi > 0) {
                    b.pi--;
                    b.hid = e.id;
                    b.cd = 3;
                } else {
                    this.bullets.splice(j, 1);
                }
                if (dead) {
                    break;
                }
                e.flash = 6;
                this.noise(0.05, 0.06, 3000);
            }
        }
    }

    _updateRocks(ts) {
        const W = this.W;
        const H = this.H;
        for (let i = this.rocks.length - 1; i >= 0; i--) {
            const rk = this.rocks[i];
            rk.x += rk.vx * ts;
            rk.y += rk.vy * ts;
            rk.rot += rk.vr * ts;
            if (rk.x < this.fx0 + rk.r) { rk.vx = Math.abs(rk.vx); }
            if (rk.x > this.fx1 - rk.r) { rk.vx = -Math.abs(rk.vx); }
            if (rk.y > this.fy1 + rk.r + 20) {
                this.rocks.splice(i, 1);
                continue;
            }
            // Collision with ships.
            let broke = false;
            for (const sp of this.ships) {
                if (sp.down) {
                    continue;
                }
                const dx = rk.x - sp.x;
                const dy = rk.y - sp.y;
                const rr = rk.r + 12 * (1 + sp.mods.hitbox);
                if (dx * dx + dy * dy < rr * rr) {
                    // Asteroid Eater (and any dash) shatters the rock for free.
                    if (!sp.flags.rock_eater) {
                        this.hurtShip(sp);
                    }
                    this._breakRock(rk, i, sp);
                    broke = true;
                    break;
                }
            }
            if (broke) {
                continue;
            }
            // Own bullets.
            for (let j = this.bullets.length - 1; j >= 0; j--) {
                const b = this.bullets[j];
                if (b.cd > 0) {
                    continue;
                }
                const bx = b.x - rk.x;
                const by = b.y - rk.y;
                if (bx * bx + by * by < (rk.r + 3) * (rk.r + 3)) {
                    rk.hp -= b.d;
                    this.burst(b.x, b.y, "#c9c9d6", 4, 2);
                    if (b.pi > 0) {
                        b.pi--;
                        b.cd = 3;
                    } else {
                        this.bullets.splice(j, 1);
                    }
                    if (rk.hp <= 0) {
                        this._breakRock(rk, i, this._shipBySlot(b.sl));
                        break;
                    }
                }
            }
        }
    }

    _breakRock(rk, i, killer) {
        this.rocks.splice(i, 1);
        this.burst(rk.x, rk.y, "#b9bcd0", 20, 4.5);
        this._ev({ k: "boom", x: rk.x, y: rk.y, c: "#b9bcd0", b: 0 });
        this.sBoom();
        this.shake = Math.min(this.shake + 4, 24);
        const pts = Math.round(50 * this.combo * (1 + (killer ? killer.mods.scoreMul : 0)));
        this.score += pts;
        this.pop(rk.x, rk.y, "+" + pts.toLocaleString(), "#c9c9d6", 12);
        if (rk.r > 24) {
            for (let k = 0; k < 2; k++) {
                this.spawnRock(rk.x + (k ? 12 : -12), rk.y, rk.r * 0.55);
            }
        }
    }

    _updatePups(ts) {
        const H = this.H;
        for (let i = this.pups.length - 1; i >= 0; i--) {
            const p = this.pups[i];
            p.y += p.vy * ts;
            p.ph += 0.1 * ts;
            // Tractor Beam: the capsule flies to the nearest ship carrying it.
            for (const sp of this.ships) {
                if (sp.down || sp.mods.magnet <= 0) {
                    continue;
                }
                const dx = sp.x - p.x;
                const dy = sp.y - p.y;
                const d = Math.hypot(dx, dy) || 1;
                if (d < sp.mods.magnet) {
                    p.x += (dx / d) * 4.5 * ts;
                    p.y += (dy / d) * 4.5 * ts;
                }
            }
            if (p.y > this.fy1 + 20) {
                this.pups.splice(i, 1);
                continue;
            }
            let picker = null;
            for (const sp of this.ships) {
                if (sp.down) {
                    continue;
                }
                const dx = p.x - sp.x;
                const dy = p.y - sp.y;
                if (dx * dx + dy * dy < 650) {
                    picker = sp;
                    break;
                }
            }
            if (picker) {
                this.pups.splice(i, 1);
                this.sPup();
                this.burst(p.x, p.y, PUP_COLORS[p.t] || "#7bffb0", 14, 3);
                this._ev({ k: "pup", x: p.x, y: p.y });
                this._applyPup(picker, p.t);
            }
        }
    }

    /**
     * Effect of a capsule on the ship that grabbed it. Timed ones just set a
     * counter in `ship.buffs` (read next to the perk mods); the rest resolve
     * on the spot.
     */
    _applyPup(sp, t) {
        const say = (txt, size) => this.pop(sp.x, sp.y - 30, txt, PUP_COLORS[t] || "#eaf6ff", size || 15);
        if (PUP_BUFFS[t]) {
            // Timed: picking the same one again refreshes it, never stacks.
            sp.buffs[t] = Math.max(sp.buffs[t], PUP_BUFFS[t]);
        }
        if (t === "T") {
            sp.weapon = "triple";
            sp.weaponT = 650;
            say("Triple shot!");
        } else if (t === "S") {
            sp.shield = 1;
            say("Shield!");
        } else if (t === "B") {
            this.bomb(sp);
            say("BOMB!", 18);
        } else if (t === "L") {
            sp.lives = Math.min(this._maxLives(sp), sp.lives + 1);
            say("Extra life!");
        } else if (t === "R") {
            say("Rapid fire!");
        } else if (t === "V") {
            say("Overcharge!");
        } else if (t === "P") {
            say("Piercing rounds!");
        } else if (t === "H") {
            say("Homing rounds!");
        } else if (t === "D") {
            say("Wingman!");
        } else if (t === "G") {
            sp.inv = Math.max(sp.inv, PUP_BUFFS.G);
            this.burst(sp.x, sp.y, PUP_COLORS.G, 22, 4);
            say("Phase shift!");
        } else if (t === "F") {
            this.freezeT = 180;
            this.flashT = 6;
            say("Freeze!", 17);
        } else if (t === "X") {
            // Overload: locks the small fry, chips at anything too big to stun.
            for (const e of this.enemies) {
                if (this._isBoss(e)) {
                    e.flash = 6;
                    this._damageEnemy(e, 8, sp);
                } else {
                    e.stun = 150;
                }
            }
            this.burst(sp.x, sp.y, PUP_COLORS.X, 34, 6);
            this.shake = Math.min(this.shake + 10, 24);
            say("Overload!", 17);
        } else if (t === "C") {
            this.combo = Math.min(this.combo + 6, COMBO_MAX);
            this.comboT = 200;
            say("Combo x" + this.combo + "!");
        } else if (t === "Y") {
            const pts = Math.round(150 * Math.max(1, this.wave) * this.combo * (1 + sp.mods.scoreMul));
            this.score += pts;
            this.pop(sp.x, sp.y - 30, "+" + pts.toLocaleString(), PUP_COLORS.Y, 17);
        }
    }

    _updateFx(ts) {
        for (let i = this.parts.length - 1; i >= 0; i--) {
            const p = this.parts[i];
            p.x += p.vx * ts;
            p.y += p.vy * ts;
            p.vx *= 0.98;
            p.vy *= 0.98;
            p.life -= ts;
            if (p.life <= 0) {
                this.parts.splice(i, 1);
            }
        }
        for (let i = this.pops.length - 1; i >= 0; i--) {
            const p = this.pops[i];
            p.y += p.vy * ts;
            p.life -= ts;
            if (p.life <= 0) {
                this.pops.splice(i, 1);
            }
        }
        for (let i = this.zaps.length - 1; i >= 0; i--) {
            this.zaps[i].life -= ts;
            if (this.zaps[i].life <= 0) {
                this.zaps.splice(i, 1);
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Update (guest): interpolation, no simulation                        */
    /* ------------------------------------------------------------------ */

    _guestUpdate(ts) {
        this._updateStars(ts);
        for (const sp of this.ships) {
            sp.x += (sp.tx - sp.x) * 0.3 * ts;
            sp.y += (sp.ty - sp.y) * 0.3 * ts;
            if (sp.inv > 0) {
                sp.inv -= ts;
            }
            if (!sp.down && this.state === "playing" && this.frame % 2 === 0) {
                this.parts.push({
                    x: sp.x + (Math.random() - 0.5) * 6,
                    y: sp.y + 16,
                    vx: (Math.random() - 0.5) * 0.6,
                    vy: 2.2,
                    r: Math.random() * 2 + 1,
                    c: "#3fa9ff",
                    life: 16,
                    ml: 16,
                });
            }
            // Same animation as the host, driven by the interpolated position:
            // nothing about the pose has to travel over the bus.
            sp.flight.observe(sp.x, sp.y, ts * FRAME_SECONDS);
        }
        this._updateFx(ts);
        if (this.shake > 0) {
            this.shake *= 0.88;
        }
        if (this.flashT > 0) {
            this.flashT -= ts;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Network: remote input and snapshot                                  */
    /* ------------------------------------------------------------------ */

    /** Host: apply a guest pointer. */
    setRemoteInput(slot, tx, ty) {
        const sp = this.ships.find((s) => s.slot === slot);
        if (sp && !sp.down) {
            sp.tx = tx;
            sp.ty = ty;
        }
    }

    /**
     * Host: apply a remote action (dash, active perk or perk choice).
     * They travel through the same `/neon/input` route as the pointer.
     */
    setRemoteAction(slot, action) {
        if (this.role === "guest" || !action) {
            return;
        }
        if (action === "pause") {
            this._setPaused(!this.paused);
        } else if (action === "dash") {
            this.dashShip(slot);
        } else if (action.startsWith("act")) {
            this.useActive(slot, parseInt(action.slice(3), 10) || 0);
        } else if (action.startsWith("perk")) {
            this.pickPerk(slot, parseInt(action.slice(4), 10));
        }
    }

    /** Host: compact state to broadcast over the bus. */
    snapshot() {
        const snap = {
            st: this.state,
            sc: this.score,
            wv: this.wave,
            // The arena is sized to the host's window: it is the world every
            // client simulates and renders, whatever their own screen is.
            aw: this.W,
            ah: this.H,
            cb: this.combo,
            ct: this.comboT,
            sk: Math.round(this.shake),
            fl: Math.round(this.flashT),
            pz: this.paused ? 1 : 0,
            fz: this.freezeT > 0 ? 1 : 0,
            wp2: this.warpT > 0 ? 1 : 0,
            ships: this.ships.map((s) => ({
                s: s.slot, n: s.name, c: s.color, hl: s.hull,
                x: Math.round(s.x), y: Math.round(s.y),
                iv: s.inv > 0 ? 1 : 0, sd: s.shield,
                dn: s.down ? 1 : 0, rp: Math.round(s.reviveProgress),
                wp: s.weapon === "triple" ? 1 : 0, lv: s.lives,
                // Perks (indexes), dash and active cooldowns for the HUD.
                pk: s.perks.map((id) => PERK_INDEX[id]),
                ds: s.dashCharges, dm: s.dashMax, dt: s.dash > 0 ? 1 : 0,
                ac: s.actives.map((a) => [Math.round(Math.max(0, a.cd)), a.cdMax]),
                bf: BUFF_KEYS.reduce((m, k, i) => m | (s.buffs[k] > 0 ? 1 << i : 0), 0),
                da: s.flags.drone ? Math.round(s.droneA * 100) / 100 : undefined,
            })),
            en: this.enemies.map((e) => ({
                t: e.type, x: Math.round(e.x), y: Math.round(e.y),
                h: e.hp, mh: e.mhp, f: e.flash > 0 ? 1 : 0, tt: Math.round(e.t),
                // `v` = chassis variant; `rt`/`am` only for kamikaze/sniper.
                v: e.v || 0,
                rt: e.rot != null ? Math.round(e.rot * 100) / 100 : undefined,
                am: e.aim != null ? Math.round(e.aim) : undefined,
                sn: e.stun > 0 ? 1 : 0,
                // Boss/colossus index: the guest rebuilds the rest from the
                // catalogues. `ar` is the WARDEN armour.
                ck: e.k,
                ar: e.armor ? 1 : 0,
            })),
            // 3rd slot = style bits: 1 critical, 2 explosive.
            bu: this.bullets.map((b) => [Math.round(b.x), Math.round(b.y), (b.cr ? 1 : 0) | (b.ex ? 2 : 0)]),
            eb: this.ebullets.map((b) => [Math.round(b.x), Math.round(b.y)]),
            pu: this.pups.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), t: p.t, ph: p.ph })),
            rk: this.rocks.map((r) => ({
                x: Math.round(r.x), y: Math.round(r.y), r: Math.round(r.r),
                a: Math.round(r.rot * 100) / 100, v: r.v || 0,
            })),
            // Entities created by perks.
            tr: this.trails.map((t) => [Math.round(t.x), Math.round(t.y), Math.round(t.life)]),
            tu: this.turrets.map((t) => [Math.round(t.x), Math.round(t.y), t.sl]),
            bh: this.holes.map((h) => [Math.round(h.x), Math.round(h.y), Math.round(h.r), Math.round(h.life)]),
            dc: this.decoys.map((d) => [Math.round(d.x), Math.round(d.y), d.sl]),
            bm: this.beams.map((b) => [
                Math.round(b.x), Math.round(b.y), Math.round(b.a * 1000) / 1000,
                Math.round(b.len), Math.round(b.w), Math.round(Math.max(0, b.warn)), b.c,
            ]),
            // Perk phase (offers per slot, picks already made, countdown).
            pf: this.perkPhase
                ? { o: this.perkPhase.offers, p: this.perkPhase.picks, t: Math.round(this.perkPhase.t) }
                : null,
            ev: this._events,
        };
        this._events = [];
        return snap;
    }

    /** Guest: apply a received snapshot. */
    applySnapshot(snap) {
        // Adopt the host's arena before anything else: every coordinate below
        // is expressed in it. It only ever changes when the host resizes.
        if (snap.aw && (snap.aw !== this.W || snap.ah !== this.H)) {
            this.W = snap.aw;
            this.H = snap.ah;
            this._onArenaResized();
            this.scale = Math.min((this.cssW || this.W) / this.W, (this.cssH || this.H) / this.H);
            this._applyCamera();
        }
        this.state = snap.st;
        this.score = snap.sc;
        this.wave = snap.wv;
        // Derived from the wave, so the guest paints the same sky as the host
        // without a single byte of it travelling.
        this._syncBackground();
        this.combo = snap.cb;
        this.comboT = snap.ct;
        this.shake = snap.sk;
        this.flashT = snap.fl;
        this._setPaused(!!snap.pz);
        this.freezeT = snap.fz ? 60 : 0;
        this.warpT = snap.wp2 ? 60 : 0;
        this.perkPhase = snap.pf
            ? { offers: snap.pf.o || {}, picks: snap.pf.p || {}, t: snap.pf.t || 0 }
            : null;
        // Ships per slot (position interpolation).
        const slots = [];
        for (const s of snap.ships) {
            slots.push(s.s);
            let sp = this.ships.find((k) => k.slot === s.s);
            if (!sp) {
                sp = this.mkShip(s.s);
                sp.x = s.x;
                sp.y = s.y;
                this.ships.push(sp);
            }
            sp.name = s.n;
            sp.color = s.c;
            // The hull is the host's: a guest cannot know what everyone picked.
            sp.hull = s.hl != null ? Math.max(0, Math.min(SHIPS.length - 1, s.hl)) : sp.hull;
            sp.tx = s.x;
            sp.ty = s.y;
            sp.inv = s.iv ? 8 : 0;
            sp.shield = s.sd;
            sp.down = !!s.dn;
            sp.reviveProgress = s.rp;
            sp.weapon = s.wp ? "triple" : "single";
            sp.lives = s.lv;
            // Perks: rebuild the derived state only when the list changes, and
            // then overwrite the cooldowns with the host's authoritative ones.
            const ids = (s.pk || []).map((i) => (PERKS[i] ? PERKS[i].id : null)).filter(Boolean);
            if (ids.join(",") !== sp.perks.join(",")) {
                sp.perks = ids;
                this._recalcPerks(sp);
            }
            (s.ac || []).forEach((a, i) => {
                if (sp.actives[i]) {
                    sp.actives[i].cd = a[0];
                    sp.actives[i].cdMax = a[1];
                }
            });
            BUFF_KEYS.forEach((k, i) => {
                sp.buffs[k] = (s.bf || 0) & (1 << i) ? 1 : 0;
            });
            sp.dashCharges = s.ds != null ? s.ds : sp.dashCharges;
            sp.dashMax = s.dm != null ? s.dm : sp.dashMax;
            sp.dash = s.dt ? 1 : 0;
            if (s.da != null) {
                sp.droneA = s.da;
            }
        }
        this.ships = this.ships.filter((sp) => slots.includes(sp.slot));
        // Entities taken as-is (no interpolation in this version).
        this.enemies = snap.en.map((e) => {
            const en = {
                type: e.t, x: e.x, y: e.y, r: this._enemyR(e.t),
                hp: e.h, mhp: e.mh, c: this._enemyColor(e.t),
                flash: e.f ? 4 : 0, t: e.tt, v: e.v || 0, rot: e.rt, aim: e.am,
                stun: e.sn ? 1 : 0, armor: e.ar ? 1 : 0,
            };
            if (e.t === "boss") {
                // Radius, colour and hull come from the shared catalogue.
                const d = BOSSES[e.ck || 0] || BOSSES[0];
                Object.assign(en, { k: e.ck || 0, r: d.r, c: d.tint, v: e.ck || 0 });
            }
            if (e.t === "colossus") {
                // Size, colour and zoom come from the shared catalogue, so only
                // the index travels.
                const d = COLOSSI[e.ck || 0];
                const size = spriteSize(d.sprite);
                const h = (d.w * size.h) / size.w;
                Object.assign(en, {
                    k: e.ck || 0, w: d.w, h,
                    hw: d.w * 0.42, hh: h * 0.32,
                    r: Math.min(d.w, h) * 0.28,
                    c: d.tint, field: d.field || 1,
                });
            }
            return en;
        });
        this.bullets = snap.bu.map((b) => ({ x: b[0], y: b[1], vx: 0, vy: 0, cr: (b[2] || 0) & 1, ex: (b[2] || 0) & 2 }));
        this.ebullets = snap.eb.map((b) => ({ x: b[0], y: b[1], vx: 0, vy: 0 }));
        this.pups = snap.pu.map((p) => ({ x: p.x, y: p.y, t: p.t, ph: p.ph, r: 13 }));
        this.rocks = snap.rk.map((r) => ({ x: r.x, y: r.y, r: r.r, rot: r.a, v: r.v || 0 }));
        this.trails = (snap.tr || []).map((t) => ({ x: t[0], y: t[1], life: t[2], ml: 42 }));
        this.turrets = (snap.tu || []).map((t) => ({ x: t[0], y: t[1], sl: t[2], life: 1, t: 0 }));
        this.holes = (snap.bh || []).map((h) => ({ x: h[0], y: h[1], r: h[2], life: h[3], ml: 240 }));
        this.decoys = (snap.dc || []).map((d) => ({ x: d[0], y: d[1], sl: d[2], life: 1, ml: 360 }));
        this.beams = (snap.bm || []).map((b) => ({
            x: b[0], y: b[1], a: b[2], len: b[3], w: b[4], warn: b[5], c: b[6], life: 1, spin: 0, src: 0,
        }));
        for (const ev of snap.ev || []) {
            this._playEvent(ev);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Render                                                              */
    /* ------------------------------------------------------------------ */

    /** Colossus beams: thin sight line while charging, wall of light after. */
    _drawBeams() {
        const g = this.g;
        for (const b of this.beams) {
            const ex = b.x + Math.cos(b.a) * b.len;
            const ey = b.y + Math.sin(b.a) * b.len;
            g.save();
            g.globalCompositeOperation = "lighter";
            if (b.warn > 0) {
                g.strokeStyle = b.c;
                g.globalAlpha = 0.25 + Math.abs(Math.sin(this.frame * 0.25)) * 0.4;
                g.lineWidth = 2;
                g.setLineDash([12, 10]);
            } else {
                g.strokeStyle = b.c;
                g.globalAlpha = 0.22;
                g.lineWidth = b.w * (1 + Math.sin(this.frame * 0.5) * 0.06);
            }
            g.beginPath();
            g.moveTo(b.x, b.y);
            g.lineTo(ex, ey);
            g.stroke();
            if (b.warn <= 0) {
                g.setLineDash([]);
                g.globalAlpha = 0.95;
                g.strokeStyle = "#ffffff";
                g.lineWidth = b.w * 0.28;
                g.beginPath();
                g.moveTo(b.x, b.y);
                g.lineTo(ex, ey);
                g.stroke();
            }
            g.restore();
        }
    }

    /** Turrets and decoys: drawn over the field, under the ships. */
    _drawPerkEntities() {
        const g = this.g;
        for (const tu of this.turrets) {
            const sp = this._shipBySlot(tu.sl);
            const col = sp ? sp.color : "#ffd166";
            g.save();
            g.translate(tu.x, tu.y);
            g.globalCompositeOperation = "lighter";
            g.fillStyle = this.glow(col, 0.14);
            g.beginPath();
            g.arc(0, 0, 20, 0, 6.2832);
            g.fill();
            g.globalCompositeOperation = "source-over";
            g.strokeStyle = col;
            g.lineWidth = 2;
            g.beginPath();
            g.moveTo(-10, 8);
            g.lineTo(10, 8);
            g.lineTo(6, -4);
            g.lineTo(-6, -4);
            g.closePath();
            g.stroke();
            g.fillStyle = col;
            g.fillRect(-2, -14, 4, 10);
            g.restore();
        }
        for (const d of this.decoys) {
            const sp = this._shipBySlot(d.sl);
            g.save();
            g.globalAlpha = 0.35 + Math.sin(this.frame * 0.2) * 0.15;
            drawSprite(g, SHIPS[sp ? sp.hull : 0].sprite, d.x, d.y, {
                tint: "#8be9ff",
                px: SHIP_PX,
            });
            g.restore();
        }
    }

    drawShip(sp) {
        const g = this.g;
        // Drone Wing: the companion is drawn even while the hull blinks.
        if (sp.flags && (sp.flags.drone || (sp.buffs && sp.buffs.D > 0))) {
            const p = this._dronePos(sp);
            drawSprite(g, "drone0", p.x, p.y, { tint: sp.color, px: pxFor("drone0", 18) });
        }
        if (sp.inv > 0 && (this.frame >> 2) % 2 === 0) {
            return;
        }
        g.save();
        g.translate(sp.x, sp.y);
        if (sp.dash > 0) {
            // Dash: violet halo that reads as "you cannot be touched now".
            g.globalCompositeOperation = "lighter";
            g.fillStyle = "rgba(201,164,255,0.35)";
            g.beginPath();
            g.arc(0, 0, 30, 0, 6.2832);
            g.fill();
            g.globalCompositeOperation = "source-over";
        }
        g.globalCompositeOperation = "lighter";
        g.fillStyle = this.glow(sp.color, 0.12);
        g.beginPath();
        g.arc(0, 0, 26, 0, 6.2832);
        g.fill();
        g.globalCompositeOperation = "source-over";
        // Banked hull, engine flame and retro-thrusters. Each slot has its own
        // hull and the frames are tinted with sp.color, same as the flat
        // sprite was; the pose comes from the motion `_moveShip` produced.
        sp.flight.draw(g, {
            sprite: SHIPS[sp.hull].sprite,
            tint: sp.color,
            px: SHIP_PX,
        });
        if (sp.shield > 0) {
            g.strokeStyle = "rgba(123,255,176," + (0.5 + Math.sin(this.frame * 0.15) * 0.3) + ")";
            g.lineWidth = 2;
            g.beginPath();
            g.arc(0, 0, 24, 0, 6.2832);
            g.stroke();
        }
        g.restore();
    }

    drawWreck(sp) {
        const g = this.g;
        g.save();
        g.translate(sp.x, sp.y);
        g.globalAlpha = 0.45 + Math.sin(this.frame * 0.1) * 0.1;
        g.strokeStyle = "rgba(190,190,210,0.7)";
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(0, -14);
        g.lineTo(11, 12);
        g.lineTo(-3, 5);
        g.lineTo(-12, 12);
        g.closePath();
        g.stroke();
        g.globalAlpha = 1;
        if (sp.reviveProgress > 0) {
            g.strokeStyle = sp.color;
            g.lineWidth = 3;
            g.beginPath();
            g.arc(0, 0, 22, -Math.PI / 2, -Math.PI / 2 + (sp.reviveProgress / REVIVE_FRAMES) * 6.2832);
            g.stroke();
        }
        g.fillStyle = "rgba(255,150,150,0.85)";
        g.font = "500 11px system-ui,sans-serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(sp.name + " down", 0, 30);
        g.restore();
    }

    /** Enemy sprite name based on type and chassis variant. */
    _enemySprite(e) {
        const names = ENEMY_SPRITES[e.type] || ENEMY_SPRITES.drone;
        return names[(e.v || 0) % names.length];
    }

    drawEnemy(e) {
        const g = this.g;
        const name = this._enemySprite(e);
        const flash = e.flash > 0;
        if (e.flash > 0) {
            e.flash--;
        }
        // Neon halo behind the sprite.
        g.save();
        g.globalCompositeOperation = "lighter";
        g.fillStyle = this.glow(e.c, 0.14);
        g.beginPath();
        g.arc(e.x, e.y, e.r + 10, 0, 6.2832);
        g.fill();
        g.restore();
        // Sniper sight line while it charges. The target is recomputed here (it
        // does not travel in the snapshot): ships are already synchronised, so
        // host and guest draw the same sight.
        if (e.type === "sniper" && e.aim > 40) {
            const tgt = this._target(e.x, e.y);
            if (tgt) {
                g.save();
                g.globalCompositeOperation = "lighter";
                g.strokeStyle = "rgba(77,227,193," + (0.15 + ((e.aim - 40) / 30) * 0.35) + ")";
                g.lineWidth = 1;
                g.beginPath();
                g.moveTo(e.x, e.y);
                g.lineTo(tgt.x, tgt.y);
                g.stroke();
                g.restore();
            }
        }
        if (e.type === "colossus") {
            // Colossal hull: drawn at its full logical width, chunky pixels and
            // a heavy halo. Its health goes to the top bar, not a floating one.
            const d = COLOSSI[e.k] || COLOSSI[0];
            const p = 1 + Math.sin(e.t * 0.05) * 0.012;
            g.save();
            g.globalCompositeOperation = "lighter";
            g.fillStyle = this.glow(e.c, 0.1);
            g.beginPath();
            g.ellipse(e.x, e.y, e.w * 0.55, e.h * 0.6, 0, 0, 6.2832);
            g.fill();
            g.restore();
            g.save();
            g.translate(e.x, e.y);
            g.scale(p, p);
            // NEVER the white flash silhouette here: a colossus is under fire
            // every frame, so it would sit permanently washed out (and it would
            // double the sprite cache for a canvas this big). The hit feedback
            // is the white burst at the point of impact plus the top bar.
            drawSprite(g, d.sprite, 0, 0, { tint: e.c, px: pxFor(d.sprite, e.w) });
            g.restore();
            return;
        }
        if (e.type === "boss") {
            // The dreadnought breathes: gentle pulse around its centre.
            const p = 1 + Math.sin(e.t * 0.08) * 0.04;
            g.save();
            g.translate(e.x, e.y);
            g.scale(p, p);
            drawSprite(g, name, 0, 0, { tint: e.c, px: pxFor(name, e.r * 2), flash });
            g.restore();
        } else {
            drawSprite(g, name, e.x, e.y, {
                tint: e.c,
                px: pxFor(name, e.r * 2),
                flash,
                rot: e.type === "kami" ? e.rot || 0 : 0,
            });
        }
        if (e.armor) {
            // WARDEN with the shield up: hits barely scratch it.
            g.save();
            g.globalCompositeOperation = "lighter";
            g.strokeStyle = "rgba(77,227,193," + (0.45 + Math.sin(this.frame * 0.12) * 0.25) + ")";
            g.lineWidth = 3;
            g.beginPath();
            g.arc(e.x, e.y, e.r + 9, 0, 6.2832);
            g.stroke();
            g.restore();
        }
        if (e.stun > 0) {
            // EMP: crackling ring around a stunned hull.
            g.strokeStyle = "rgba(94,225,255," + (0.4 + Math.sin(this.frame * 0.4) * 0.25) + ")";
            g.lineWidth = 1.5;
            g.beginPath();
            g.arc(e.x, e.y, e.r + 6, 0, 6.2832);
            g.stroke();
        }
        if (e.mhp > 1) {
            const w2 = e.r * 2;
            g.fillStyle = "rgba(255,255,255,0.18)";
            g.fillRect(e.x - w2 / 2, e.y - e.r - 12, w2, 4);
            g.fillStyle = e.type === "boss" ? "#ff6b6b" : "#c9a4ff";
            g.fillRect(e.x - w2 / 2, e.y - e.r - 12, w2 * Math.max(0, e.hp / e.mhp), 4);
        }
    }

    drawRock(rk) {
        const name = ROCK_SPRITES[(rk.v || 0) % ROCK_SPRITES.length];
        drawSprite(this.g, name, rk.x, rk.y, {
            tint: "#8a8faf",
            px: pxFor(name, rk.r * 2.2),
            rot: rk.rot,
        });
    }

    render() {
        const g = this.g;
        const W = this.W;
        const H = this.H;
        const dpr = this.dpr;

        // Clear the whole physical canvas (letterbox bars in black).
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.fillStyle = "#05060e";
        g.fillRect(0, 0, this.cv.width, this.cv.height);

        // Logical world transform (scale * zoom + centring).
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.translate(this.ox, this.oy);
        g.scale(this.scale * this.zoom, this.scale * this.zoom);

        // Visible rectangle: the arena plus whatever the camera shows around it.
        const mx = this.viewMX;
        const my = this.viewMY;
        g.save();
        g.beginPath();
        g.rect(-mx, -my, W + mx * 2, H + my * 2);
        g.clip();
        g.fillStyle = "#05060e";
        g.fillRect(-mx, -my, W + mx * 2, H + my * 2);
        if (this.shake > 0.5) {
            g.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
        }
        // Scenery first, star field on top of it: the stars are the near layer.
        if (this.bg) {
            this.bg.draw(g);
        }
        for (const s of this.stars) {
            g.fillStyle = "rgba(200,220,255," + (0.25 + s.z * 0.25) + ")";
            g.fillRect(s.x, s.y, s.s, s.s + s.z * 2);
        }
        // Where the playable field ends: the wall the ships stop against. It is
        // drawn on every frame, not only when zoomed out, because otherwise you
        // have to bump into it to learn how far you can fly. While a colossus
        // is alive the field is wider and the camera pulls back, so the outside
        // (colossus and open space) is dimmed as well and the edge is brighter.
        {
            const zoomed = this.zoom < 0.985;
            const a = zoomed ? Math.min(1, (1 - this.zoom) * 4) : 0;
            const fx = this.fx0;
            const fy = this.fy0;
            const fw = this.fx1 - this.fx0;
            const fh = this.fy1 - this.fy0;
            g.save();
            if (zoomed) {
                g.fillStyle = "rgba(4,5,12,0.45)";
                g.fillRect(-mx, -my, W + mx * 2, my + fy);
                g.fillRect(-mx, this.fy1, W + mx * 2, my + (H - this.fy1));
                g.fillRect(-mx, fy, mx + fx, fh);
                g.fillRect(this.fx1, fy, mx + (W - this.fx1), fh);
            }
            g.strokeStyle = "rgba(113,75,103," + (0.35 + a * 0.4) + ")";
            g.lineWidth = 2 / this.zoom;
            g.strokeRect(fx, fy, fw, fh);
            // Corner brackets in cyan: the frame alone reads as decoration at
            // full zoom, the brackets read as a limit.
            const c = Math.min(fw, fh) * 0.07;
            g.strokeStyle = "rgba(94,225,255," + (0.3 + a * 0.35) + ")";
            g.beginPath();
            for (const [cx, sx] of [[fx, 1], [fx + fw, -1]]) {
                for (const [cy, sy] of [[fy, 1], [fy + fh, -1]]) {
                    g.moveTo(cx + sx * c, cy);
                    g.lineTo(cx, cy);
                    g.lineTo(cx, cy + sy * c);
                }
            }
            g.stroke();
            g.restore();
        }
        g.globalCompositeOperation = "lighter";
        for (const p of this.parts) {
            g.globalAlpha = Math.max(0, p.life / p.ml);
            g.fillStyle = p.c;
            g.beginPath();
            g.arc(p.x, p.y, p.r, 0, 6.2832);
            g.fill();
        }
        g.globalAlpha = 1;
        // Plasma Wake and the Black Hole live under the bullets.
        for (const tr of this.trails) {
            g.globalAlpha = Math.max(0, tr.life / (tr.ml || 42)) * 0.6;
            g.fillStyle = "#c9a4ff";
            g.beginPath();
            g.arc(tr.x, tr.y, 15, 0, 6.2832);
            g.fill();
        }
        g.globalAlpha = 1;
        for (const h of this.holes) {
            const p = 1 + Math.sin(this.frame * 0.2) * 0.06;
            g.fillStyle = "rgba(201,164,255,0.10)";
            g.beginPath();
            g.arc(h.x, h.y, h.r * p, 0, 6.2832);
            g.fill();
            g.fillStyle = "rgba(140,90,255,0.35)";
            g.beginPath();
            g.arc(h.x, h.y, 26 * p, 0, 6.2832);
            g.fill();
        }
        for (const z of this.zaps) {
            g.globalAlpha = Math.max(0, z.life / 8);
            g.strokeStyle = "#8be9ff";
            g.lineWidth = 2;
            g.beginPath();
            g.moveTo(z.x1, z.y1);
            // A single kink is enough to read as an electric arc.
            g.lineTo((z.x1 + z.x2) / 2 + (Math.random() - 0.5) * 18, (z.y1 + z.y2) / 2 + (Math.random() - 0.5) * 18);
            g.lineTo(z.x2, z.y2);
            g.stroke();
        }
        g.globalAlpha = 1;
        for (const b of this.bullets) {
            if (b.cr) {
                g.fillStyle = "rgba(255,209,102,0.3)";
                g.fillRect(b.x - 4, b.y - 3, 8, 20);
                g.fillStyle = "#fff0c2";
                g.fillRect(b.x - 2, b.y, 4, 15);
            } else if (b.ex) {
                g.fillStyle = "rgba(255,179,71,0.3)";
                g.fillRect(b.x - 4, b.y - 2, 8, 17);
                g.fillStyle = "#ffe0b0";
                g.fillRect(b.x - 2, b.y, 4, 13);
            } else {
                g.fillStyle = "rgba(94,225,255,0.25)";
                g.fillRect(b.x - 3, b.y - 2, 6, 16);
                g.fillStyle = "#d8f8ff";
                g.fillRect(b.x - 1.5, b.y, 3, 12);
            }
        }
        for (const b of this.ebullets) {
            const frozen = this.freezeT > 0;
            g.fillStyle = frozen ? "rgba(94,225,255,0.3)" : "rgba(255,110,110,0.3)";
            g.beginPath();
            g.arc(b.x, b.y, 7, 0, 6.2832);
            g.fill();
            g.fillStyle = frozen ? "#d8f8ff" : "#ffdada";
            g.beginPath();
            g.arc(b.x, b.y, 3.5, 0, 6.2832);
            g.fill();
        }
        this._drawBeams();
        g.globalCompositeOperation = "source-over";
        this._drawPerkEntities();
        for (const rk of this.rocks) {
            this.drawRock(rk);
        }
        for (const p of this.pups) {
            const col = PUP_COLORS[p.t] || PUP_COLORS.L;
            const bob = Math.sin(p.ph) * 2;
            g.save();
            g.globalCompositeOperation = "lighter";
            g.fillStyle = this.glow(col, 0.16);
            g.beginPath();
            g.arc(p.x, p.y + bob, p.r + 6, 0, 6.2832);
            g.fill();
            g.restore();
            // The capsule carries the glyph drawn in the pixel grid itself.
            drawSprite(g, "pup" + p.t, p.x, p.y + bob, { tint: col, px: PUP_PX });
        }
        for (const e of this.enemies) {
            this.drawEnemy(e);
        }
        if (this.state !== "start") {
            for (const sp of this.ships) {
                if (sp.down) {
                    this.drawWreck(sp);
                } else {
                    this.drawShip(sp);
                }
            }
        }
        for (const p of this.pops) {
            g.globalAlpha = Math.max(0, p.life / p.ml);
            g.fillStyle = p.color;
            g.font = "500 " + p.size + "px system-ui,sans-serif";
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText(p.txt, p.x, p.y);
        }
        g.globalAlpha = 1;
        if (this.flashT > 0) {
            g.fillStyle = "rgba(255,255,255," + ((this.flashT / 12) * 0.55) + ")";
            g.fillRect(-mx - 30, -my - 30, W + mx * 2 + 60, H + my * 2 + 60);
        }
        g.restore();

        // HUD in its own transform: it must not shrink with the camera.
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.translate(this.hudOx, this.hudOy);
        g.scale(this.scale, this.scale);
        this._renderHud();
        if (this.state === "perk") {
            this._renderPerkChoice();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Perk UI (canvas: works the same on host and guest)                  */
    /* ------------------------------------------------------------------ */

    /** Geometry of the 3 cards offered to the local slot. */
    _perkCards() {
        const ph = this.perkPhase;
        if (!ph) {
            return [];
        }
        const offers = ph.offers[this.localSlot] || [];
        const w = 188;
        const h = 250;
        const gap = 16;
        const total = offers.length * w + Math.max(0, offers.length - 1) * gap;
        const x0 = (this.W - total) / 2;
        const y = this.H / 2 - h / 2 + 26;
        return offers.map((idx, i) => ({ idx, i, x: x0 + i * (w + gap), y, w, h }));
    }

    _wrapText(text, maxW) {
        const g = this.g;
        const words = String(text).split(" ");
        const lines = [];
        let line = "";
        for (const word of words) {
            const next = line ? line + " " + word : word;
            if (g.measureText(next).width > maxW && line) {
                lines.push(line);
                line = word;
            } else {
                line = next;
            }
        }
        if (line) {
            lines.push(line);
        }
        return lines;
    }

    _renderPerkChoice() {
        const g = this.g;
        const W = this.W;
        const H = this.H;
        const ph = this.perkPhase;
        const picked = ph.picks[this.localSlot];
        // Drawn in HUD space: overshoot to cover the letterbox and, if the
        // camera is still pulled back, the margin around the arena.
        g.fillStyle = "rgba(4,5,12,0.86)";
        g.fillRect(-W, -H, W * 3, H * 3);
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillStyle = "#eaf6ff";
        g.font = "500 26px system-ui,sans-serif";
        g.fillText("CHOOSE AN UPGRADE", W / 2, 74);
        g.fillStyle = "rgba(180,210,255,0.75)";
        g.font = "400 14px system-ui,sans-serif";
        g.fillText(
            "Wave " + this.wave + " cleared · you keep it for the rest of the run",
            W / 2,
            100
        );

        for (const card of this._perkCards()) {
            const perk = PERKS[card.idx];
            if (!perk) {
                continue;
            }
            const chosen = picked === card.idx;
            const hover =
                picked == null &&
                this._hover &&
                this._hover.x >= card.x && this._hover.x <= card.x + card.w &&
                this._hover.y >= card.y && this._hover.y <= card.y + card.h;
            g.fillStyle = chosen ? this.glow(perk.tint, 0.22) : hover ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.04)";
            g.fillRect(card.x, card.y, card.w, card.h);
            g.strokeStyle = chosen || hover ? perk.tint : this.glow(perk.tint, 0.45);
            g.lineWidth = chosen || hover ? 2.5 : 1.2;
            g.strokeRect(card.x, card.y, card.w, card.h);
            const cx = card.x + card.w / 2;
            // Key hint.
            g.fillStyle = this.glow(perk.tint, 0.75);
            g.font = "500 12px system-ui,sans-serif";
            g.fillText("[" + (card.i + 1) + "]", cx, card.y + 22);
            // Kind + name.
            g.fillStyle = perk.tint;
            g.font = "500 11px system-ui,sans-serif";
            g.fillText(perk.kind.toUpperCase() + " · " + perk.tag.toUpperCase(), cx, card.y + 46);
            g.fillStyle = "#eaf6ff";
            g.font = "500 18px system-ui,sans-serif";
            for (const [k, line] of this._wrapText(perk.name, card.w - 24).entries()) {
                g.fillText(line, cx, card.y + 76 + k * 22);
            }
            // Description.
            g.fillStyle = "rgba(200,220,255,0.85)";
            g.font = "400 13px system-ui,sans-serif";
            const lines = this._wrapText(perk.desc, card.w - 28);
            lines.forEach((line, k) => {
                g.fillText(line, cx, card.y + 132 + k * 18);
            });
            if (perk.kind === "active") {
                g.fillStyle = "rgba(255,179,71,0.9)";
                g.font = "400 12px system-ui,sans-serif";
                g.fillText("cooldown " + Math.round((perk.cd || 600) / 60) + " s", cx, card.y + card.h - 22);
            }
            if (chosen) {
                g.fillStyle = perk.tint;
                g.font = "500 13px system-ui,sans-serif";
                g.fillText("SELECTED", cx, card.y + card.h - 22);
            }
        }

        g.textAlign = "center";
        if (picked != null) {
            const pending = this.ships.filter((sp) => ph.picks[sp.slot] == null).length;
            g.fillStyle = "rgba(180,210,255,0.8)";
            g.font = "400 15px system-ui,sans-serif";
            g.fillText(
                pending ? "Waiting for " + pending + " player(s)… " + Math.ceil(ph.t / 60) + " s" : "Get ready…",
                W / 2,
                H - 42
            );
        } else {
            const pul = 0.7 + Math.sin(this.frame * 0.08) * 0.3;
            g.fillStyle = "rgba(255,255,255," + pul + ")";
            g.font = "500 15px system-ui,sans-serif";
            g.fillText("Click a card or press 1, 2 or 3 · " + Math.ceil(ph.t / 60) + " s", W / 2, H - 42);
        }
    }

    /** Wide health bar for the colossus on duty (it has no floating bar). */
    _renderColossusBar() {
        const boss = this.enemies.find((e) => e.type === "colossus");
        if (!boss) {
            return;
        }
        const d = COLOSSI[boss.k] || COLOSSI[0];
        const g = this.g;
        const w = this.W - 120;
        const x = 60;
        const y = 52;
        g.textAlign = "center";
        g.fillStyle = d.tint;
        g.font = "500 13px system-ui,sans-serif";
        g.fillText(d.name + " · " + d.title.toUpperCase(), this.W / 2, y - 12);
        g.fillStyle = "rgba(255,255,255,0.14)";
        g.fillRect(x, y, w, 9);
        const pct = Math.max(0, boss.hp / boss.mhp);
        g.fillStyle = pct < 0.45 ? "#ff6b6b" : d.tint;
        g.fillRect(x, y, w * pct, 9);
        g.strokeStyle = "rgba(255,255,255,0.25)";
        g.lineWidth = 1;
        g.strokeRect(x, y, w, 9);
    }

    /** Bottom-left block: dash charges, actives and perks owned. */
    _renderPerkHud() {
        const g = this.g;
        const sp = this._shipBySlot(this.localSlot);
        if (!sp || sp.down) {
            return;
        }
        const y = this.H - 26;
        g.textAlign = "left";
        g.textBaseline = "middle";
        g.fillStyle = "rgba(180,210,255,0.65)";
        g.font = "500 11px system-ui,sans-serif";
        g.fillText("SPACE", 14, y);
        let x = 56;
        for (let i = 0; i < sp.dashMax; i++) {
            const ready = i < sp.dashCharges;
            g.fillStyle = ready ? "#c9a4ff" : "rgba(201,164,255,0.22)";
            g.fillRect(x, y - 5, 14, 10);
            x += 18;
        }
        x += 10;
        sp.actives.forEach((a, i) => {
            const perk = PERKS[PERK_INDEX[a.id]];
            const ready = a.cd <= 0;
            const w = 78;
            g.fillStyle = "rgba(255,255,255,0.07)";
            g.fillRect(x, y - 11, w, 22);
            if (!ready) {
                g.fillStyle = "rgba(255,179,71,0.20)";
                g.fillRect(x, y - 11, w * (1 - a.cd / a.cdMax), 22);
            }
            g.strokeStyle = ready ? (perk ? perk.tint : "#ffb347") : "rgba(255,255,255,0.16)";
            g.lineWidth = 1;
            g.strokeRect(x, y - 11, w, 22);
            g.fillStyle = ready ? "#eaf6ff" : "rgba(200,220,255,0.55)";
            g.font = "500 10px system-ui,sans-serif";
            g.fillText(
                "[" + (i + 1) + "] " + (perk ? perk.name : a.id).slice(0, 11),
                x + 5,
                y
            );
            x += w + 8;
        });
        // Perks owned: one dot per perk, in its family colour.
        if (sp.perks.length) {
            let px = 14;
            const py = y - 24;
            for (const id of sp.perks.slice(0, 16)) {
                const perk = PERKS[PERK_INDEX[id]];
                g.fillStyle = perk ? perk.tint : "#eaf6ff";
                g.beginPath();
                g.arc(px, py, 3.5, 0, 6.2832);
                g.fill();
                px += 11;
            }
        }
    }

    _renderHud() {
        const g = this.g;
        const W = this.W;
        const H = this.H;
        g.textBaseline = "middle";
        if (this.state === "playing" || this.state === "over" || this.state === "perk") {
            g.textAlign = "left";
            g.fillStyle = "#eaf6ff";
            g.font = "500 16px system-ui,sans-serif";
            g.fillText(this.score.toLocaleString(), 14, 22);
            if (this.combo > 1) {
                g.fillStyle = "#ffd166";
                g.font = "500 13px system-ui,sans-serif";
                g.fillText("combo x" + this.combo, 14, 42);
                g.fillStyle = "rgba(255,209,102,0.3)";
                g.fillRect(14, 52, 60, 3);
                g.fillStyle = "#ffd166";
                g.fillRect(14, 52, 60 * (this.comboT / 170), 3);
            }
            g.textAlign = "center";
            g.fillStyle = "rgba(180,210,255,0.7)";
            g.font = "500 13px system-ui,sans-serif";
            g.fillText(
                "Wave " + this.wave + "  ·  " + NeonStrikeEngine.formatTime(this.playSeconds()),
                W / 2, 22
            );
            // Per-player panel (top right).
            let py = 16;
            g.textAlign = "right";
            for (const sp of this.ships) {
                g.font = "500 12px system-ui,sans-serif";
                if (sp.down) {
                    g.fillStyle = "rgba(255,130,130,0.85)";
                    const pct = Math.floor((sp.reviveProgress / REVIVE_FRAMES) * 100);
                    g.fillText(sp.name + " · down " + pct + "%", W - 14, py);
                } else {
                    g.fillStyle = sp.color;
                    let hearts = "";
                    for (let k = 0; k < sp.lives; k++) {
                        hearts += "▲";
                    }
                    let extra = hearts;
                    if (sp.weapon === "triple") {
                        extra += "  ✦";
                    }
                    if (sp.shield > 0) {
                        extra += "  ◯";
                    }
                    // Timed capsules, by their letter.
                    const buffs = BUFF_KEYS.filter((k) => sp.buffs[k] > 0);
                    if (buffs.length) {
                        extra += "  " + buffs.join("");
                    }
                    g.fillText(sp.name + "  " + extra, W - 14, py);
                }
                py += 18;
            }
            this._renderPerkHud();
            this._renderColossusBar();
        }
        if (this.paused) {
            g.fillStyle = "rgba(4,5,12,0.7)";
            g.fillRect(-W, -H, W * 3, H * 3);
            g.textAlign = "center";
            g.fillStyle = "#eaf6ff";
            g.font = "500 34px system-ui,sans-serif";
            g.fillText("PAUSED", W / 2, H / 2 - 10);
            g.fillStyle = "rgba(180,210,255," + (0.5 + Math.sin(this.frame * 0.07) * 0.3) + ")";
            g.font = "400 15px system-ui,sans-serif";
            g.fillText("Esc to resume", W / 2, H / 2 + 26);
        }
        if (this.state === "start") {
            g.textAlign = "center";
            const pul = 0.7 + Math.sin(this.frame * 0.06) * 0.3;
            g.fillStyle = "rgba(94,225,255," + pul * 0.25 + ")";
            g.font = "500 46px system-ui,sans-serif";
            g.fillText("NEON STRIKE", W / 2, H / 2 - 62);
            g.fillStyle = "#eaf6ff";
            g.font = "500 44px system-ui,sans-serif";
            g.fillText("NEON STRIKE", W / 2, H / 2 - 64);
            g.fillStyle = "rgba(180,210,255,0.8)";
            g.font = "400 15px system-ui,sans-serif";
            g.fillText("Drag to move · auto fire · SPACE to dash", W / 2, H / 2 - 16);
            g.fillText("Every 5 waves you keep 1 of 3 permanent upgrades", W / 2, H / 2 + 8);
            if (this.role !== "guest") {
                g.fillStyle = "rgba(255,255,255," + pul + ")";
                g.font = "500 18px system-ui,sans-serif";
                g.fillText("Tap to play", W / 2, H / 2 + 58);
            } else {
                g.fillStyle = "rgba(180,210,255,0.7)";
                g.font = "400 15px system-ui,sans-serif";
                g.fillText("Waiting for the host…", W / 2, H / 2 + 58);
            }
            g.fillStyle = "#b78bad";
            g.font = "500 12px system-ui,sans-serif";
            g.fillText("Odoo 19 · neon_strike module", W / 2, H / 2 + 88);
        }
        if (this.state === "over") {
            g.fillStyle = "rgba(4,5,12,0.72)";
            g.fillRect(-W, -H, W * 3, H * 3);
            g.textAlign = "center";
            g.fillStyle = "#ff8f8f";
            g.font = "500 38px system-ui,sans-serif";
            g.fillText("Game over", W / 2, H / 2 - 58);
            g.fillStyle = "#eaf6ff";
            g.font = "500 22px system-ui,sans-serif";
            g.fillText("Score: " + this.score.toLocaleString(), W / 2, H / 2 - 12);
            g.fillStyle = "rgba(180,210,255,0.85)";
            g.font = "400 15px system-ui,sans-serif";
            g.fillText(
                "Best: " + this.best.toLocaleString() + " · Wave " + this.wave +
                " · " + NeonStrikeEngine.formatTime(this.playSeconds()),
                W / 2, H / 2 + 16
            );
            const pul = 0.7 + Math.sin(this.frame * 0.08) * 0.3;
            if (this.role !== "guest") {
                g.fillStyle = "rgba(255,255,255," + pul + ")";
                g.font = "500 17px system-ui,sans-serif";
                g.fillText("Tap to retry", W / 2, H / 2 + 62);
            } else {
                g.fillStyle = "rgba(180,210,255,0.7)";
                g.font = "400 15px system-ui,sans-serif";
                g.fillText("Waiting for the host…", W / 2, H / 2 + 62);
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Input                                                               */
    /* ------------------------------------------------------------------ */

    _ptr(e) {
        const r = this.cv.getBoundingClientRect();
        // Same transform as the render (scale * zoom), so the cursor keeps
        // matching the ship while the camera pulls back for a colossus.
        const eff = this.scale * this.zoom;
        return {
            x: (e.clientX - r.left - this.ox) / eff,
            y: (e.clientY - r.top - this.oy) / eff,
            touch: e.pointerType === "touch",
        };
    }

    _applyLocalInput(x, y) {
        const sp = this.ships.find((s) => s.slot === this.localSlot);
        if (sp) {
            sp.tx = x;
            sp.ty = y;
        }
        if (this.role === "guest" && this.cb.onLocalInput) {
            this.cb.onLocalInput(x, y);
        }
    }

    _pointerDown(e) {
        this.audio();
        const p = this._ptr(e);
        this._hover = { x: p.x, y: p.y };
        if (this.state === "perk") {
            // Clicking a card is the only thing a tap does while choosing.
            for (const card of this._perkCards()) {
                if (p.x >= card.x && p.x <= card.x + card.w && p.y >= card.y && p.y <= card.y + card.h) {
                    this._choosePerk(card.idx);
                    break;
                }
            }
            return;
        }
        // Only host/solo can start or retry by tapping; the guest cannot.
        if (this.role !== "guest" && this.state !== "playing") {
            this.beginPlay();
        }
        this._applyLocalInput(p.x, p.touch ? p.y - 60 : p.y);
    }

    _pointerMove(e) {
        const p = this._ptr(e);
        this._hover = { x: p.x, y: p.y };
        if (this.state === "perk") {
            return;
        }
        this._applyLocalInput(p.x, p.touch ? p.y - 60 : p.y);
    }

    /**
     * Keyboard: Space dashes, 1..4 fire the actives and, while choosing,
     * 1..3 pick a card. WASD only moves the second ship in hotseat.
     */
    _keyDown(e) {
        // The listener is on `window`, so it also sees keys typed in the UI
        // around the canvas (nickname, feedback...). Space would dash instead
        // of typing a space, and preventDefault would swallow it.
        const el = e.target;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
            return;
        }
        const k = (e.key || "").toLowerCase();
        this.keys[k] = true;
        const digit = parseInt(k, 10);
        if (k === "escape") {
            this.togglePause();
            e.preventDefault();
            return;
        }
        if (this.paused) {
            return;
        }
        if (this.state === "perk") {
            const cards = this._perkCards();
            if (digit >= 1 && digit <= cards.length) {
                this._choosePerk(cards[digit - 1].idx);
                e.preventDefault();
            }
            return;
        }
        if (k === " " || k === "spacebar") {
            this.audio();
            this._localAction("dash");
            e.preventDefault();
            return;
        }
        if (digit >= 1 && digit <= MAX_ACTIVES) {
            this.audio();
            this._localAction("act" + (digit - 1));
        }
    }

    /** Route an action: the guest sends it to the host, everyone else applies it. */
    _localAction(action) {
        if (this.role === "guest") {
            if (this.cb.onAction) {
                this.cb.onAction(action);
            }
            return;
        }
        this.setRemoteAction(this.localSlot, action);
    }

    _choosePerk(index) {
        const ph = this.perkPhase;
        if (!ph || ph.picks[this.localSlot] != null) {
            return;
        }
        if (this.role === "guest") {
            // Optimistic: the host confirms it in the next snapshot.
            if (this.cb.onAction) {
                this.cb.onAction("perk" + index);
            }
            return;
        }
        this.pickPerk(this.localSlot, index);
    }
}
