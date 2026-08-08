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
import { drawSprite, pxFor } from "./sprites";

const SHIP_COLORS = ["#5ee1ff", "#ff8fb3", "#7bffb0", "#ffd166"];
const REVIVE_FRAMES = 120;
const COMBO_MAX = 25;

// Sprite per enemy type. Types with two entries alternate chassis based on
// `e.v` (variant fixed when the enemy is created and carried in the snapshot).
const ENEMY_SPRITES = {
    drone: ["drone0", "drone1"],
    speedy: ["speedy0", "speedy1"],
    tank: ["tank0", "tank1"],
    sniper: ["sniper0"],
    kami: ["kami0"],
    boss: ["boss0"],
};
const ROCK_SPRITES = ["rock0", "rock1"];
// Colour per power-up type (T triple, S shield, B bomb, L extra life). The
// `pup<T>` sprite is tinted with it, so the two always go together.
const PUP_COLORS = { T: "#5ee1ff", S: "#7bffb0", B: "#ffb347", L: "#ff8fb3" };
// Ship pixel size: a 16 px grid -> ~32 logical px wide.
const SHIP_PX = pxFor("ship0", 30);
const PUP_PX = pxFor("pupT", 30);

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
        this.hotseat = !!callbacks.hotseat;

        this.state = "start";
        this.muted = false;
        this.AC = null;

        // Fixed logical space (independent of the window size).
        this.W = 680;
        this.H = 540;
        this.dpr = 1;
        this.scale = 1;
        this.ox = 0;
        this.oy = 0;

        this.frame = 0;
        this.slowMo = 0;

        this.ships = [];
        this.bullets = [];
        this.ebullets = [];
        this.enemies = [];
        this.rocks = [];
        this.parts = [];
        this.pops = [];
        this.pups = [];
        this.stars = [];
        this._events = [];

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
        this._kd = (e) => { this.keys[(e.key || "").toLowerCase()] = true; };
        this._ku = (e) => { this.keys[(e.key || "").toLowerCase()] = false; };
        this.cv.addEventListener("pointerdown", this._pd);
        this.cv.addEventListener("pointermove", this._pm);
        if (this.hotseat) {
            window.addEventListener("keydown", this._kd);
            window.addEventListener("keyup", this._ku);
        }
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
        if (this.hotseat) {
            window.removeEventListener("keydown", this._kd);
            window.removeEventListener("keyup", this._ku);
        }
        if (this.AC) {
            try {
                this.AC.close();
            } catch (e) {
                /* AudioContext already closed */
            }
        }
    }

    setMuted(muted) {
        this.muted = muted;
        if (!muted) {
            this.audio();
        }
    }

    restartToMenu() {
        this.reset();
        this.state = "start";
    }

    /** Start a game (host/solo). Guests get the state through snapshots. */
    beginPlay() {
        this.reset();
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
        this.scale = Math.min(cw / this.W, ch / this.H);
        this.ox = (cw - this.W * this.scale) / 2;
        this.oy = (ch - this.H * this.scale) / 2;
    }

    _loopFn() {
        this.frame++;
        const ts = this.slowMo > 0 ? 0.35 : 1;
        if (this.slowMo > 0) {
            this.slowMo--;
        }
        if (this.role === "guest") {
            this._guestUpdate(ts);
        } else {
            this.update(ts);
        }
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
        for (let i = 0; i < 110; i++) {
            this.stars.push({
                x: Math.random() * this.W,
                y: Math.random() * this.H,
                z: Math.random() * 2 + 0.5,
                s: Math.random() * 1.4 + 0.4,
            });
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
        }
    }

    /* ------------------------------------------------------------------ */
    /* Naves                                                               */
    /* ------------------------------------------------------------------ */

    mkShip(slot) {
        return {
            slot,
            name: (this.names && this.names[slot]) || "J" + (slot + 1),
            color: SHIP_COLORS[slot % SHIP_COLORS.length],
            x: 0, y: 0, tx: 0, ty: 0,
            inv: 0, shield: 0,
            weapon: "single", weaponT: 0, fireT: 0,
            lives: 3, down: false, reviveProgress: 0,
        };
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

    /* ------------------------------------------------------------------ */
    /* Entidades                                                           */
    /* ------------------------------------------------------------------ */

    _enemyR(type) {
        const r = { boss: 44, tank: 20, speedy: 10, sniper: 16, kami: 12 };
        return r[type] != null ? r[type] : 14;
    }

    _enemyColor(type) {
        const c = {
            boss: "#ff4d4d", tank: "#9b5de5", speedy: "#ffd166",
            sniper: "#4de3c1", kami: "#ff8f3d",
        };
        return c[type] || "#ff5d8f";
    }

    /** Chassis variant (0/1) based on the sprites available for the type. */
    _enemyVariant(type) {
        const names = ENEMY_SPRITES[type];
        return names && names.length > 1 ? Math.floor(Math.random() * names.length) : 0;
    }

    mkEnemy(type, x, y) {
        const base = { type, x, y, r: this._enemyR(type), c: this._enemyColor(type), v: this._enemyVariant(type), flash: 0 };
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
        const hp = 35 + this.wave * 9 + (this.players - 1) * 25;
        return Object.assign(base, { type: "boss", hp, mhp: hp, t: 0, val: 5000 });
    }

    spawnWave() {
        this.wave++;
        this.sWave();
        this._ev({ k: "wave" });
        const p = this.players;
        if (this.wave % 4 === 0) {
            this.enemies.push(this.mkEnemy("boss", this.W / 2, -90));
            this.bossAlive = true;
            this.pop(this.W / 2, this.H / 2 - 50, "BOSS!", "#ff6b6b", 36, 90);
            return;
        }
        this.pop(this.W / 2, this.H / 2 - 50, "Oleada " + this.wave, "#8be9ff", 30, 80);
        const n = 5 + this.wave * 2 + p * 2;
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
            this.enemies.push(
                this.mkEnemy(type, 40 + Math.random() * (this.W - 80), -30 - i * 48 - Math.random() * 40)
            );
        }
        // A couple of asteroids at the start of a wave, more from wave 3 on.
        const rocks = 1 + Math.floor(this.wave / 3);
        for (let i = 0; i < rocks; i++) {
            this.spawnRock();
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

    dropPup(x, y) {
        const r = Math.random();
        let t = "T";
        if (r > 0.35) { t = "S"; }
        if (r > 0.62) { t = "B"; }
        if (r > 0.85) { t = "L"; }
        this.pups.push({ x, y, t, vy: 1.1, r: 13, ph: 0 });
    }

    killEnemy(e, i) {
        this.enemies.splice(i, 1);
        const big = e.type === "boss";
        this.burst(e.x, e.y, e.c, big ? 90 : 24, big ? 8 : 4.5);
        this.burst(e.x, e.y, "#ffffff", big ? 30 : 8, 3);
        this._ev({ k: "boom", x: e.x, y: e.y, c: e.c, b: big ? 1 : 0 });
        const pts = e.val * this.combo;
        this.score += pts;
        this.pop(e.x, e.y, "+" + pts.toLocaleString(), "#fff", big ? 24 : 13);
        this.combo = Math.min(this.combo + 1, COMBO_MAX);
        this.comboT = 170;
        this.shake = Math.min(this.shake + (big ? 22 : 5), 24);
        if (big) {
            this.sBigBoom();
            this.bossAlive = false;
            if (this.players === 1) {
                this.slowMo = 40;
            }
            this.dropPup(e.x - 40, e.y);
            this.dropPup(e.x, e.y);
            this.dropPup(e.x + 40, e.y);
            for (const sp of this._livingShips()) {
                sp.lives = Math.min(5, sp.lives + 1);
            }
            this.pop(e.x, e.y - 40, "Extra life for everyone!", "#7bffb0", 16);
        } else {
            this.sBoom();
            if (Math.random() < 0.22) {
                this.dropPup(e.x, e.y);
            }
        }
    }

    bomb() {
        this.flashT = 12;
        this.sBigBoom();
        this._ev({ k: "bomb" });
        this.shake = 20;
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            const e = this.enemies[i];
            if (e.type === "boss") {
                e.hp -= 14;
                this.burst(e.x, e.y, "#ffb347", 30, 6);
                if (e.hp <= 0) {
                    this.killEnemy(e, i);
                }
            } else {
                this.killEnemy(e, i);
            }
        }
        this.rocks = [];
        this.ebullets = [];
    }

    hurtShip(sp) {
        if (sp.down || sp.inv > 0) {
            return;
        }
        if (sp.shield > 0) {
            sp.shield = 0;
            this.burst(sp.x, sp.y, "#7bffb0", 26, 5);
            this.noise(0.25, 0.2, 2000);
            sp.inv = 50;
            this.pop(sp.x, sp.y - 30, "Shield down!", "#7bffb0", 14);
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
        this.combo = 1;
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
                    this.cb.onGameOver({ score: this.score, wave: this.wave, best: this.best });
                }
            }
        } else {
            sp.inv = 110;
        }
    }

    reset() {
        this.score = 0;
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
        this.shake = 0;
        this.slowMo = 0;
        this.flashT = 0;
        this.rockT = 180;
        this.bossAlive = false;
        this._events = [];
        this._initShips();
        for (const sp of this.ships) {
            sp.inv = 90;
        }
        this.waveDelay = 30;
    }

    /* ------------------------------------------------------------------ */
    /* Update (host / solo)                                                */
    /* ------------------------------------------------------------------ */

    update(ts) {
        const W = this.W;
        const H = this.H;

        this._updateStars(ts);

        if (this.state !== "playing") {
            this._updateFx(ts);
            return;
        }

        // Hotseat control: the slot 1 ship moves with WASD.
        if (this.hotseat && this.ships[1] && !this.ships[1].down) {
            const sp = this.ships[1];
            const spd = 7;
            if (this.keys.w) { sp.ty -= spd; }
            if (this.keys.s) { sp.ty += spd; }
            if (this.keys.a) { sp.tx -= spd; }
            if (this.keys.d) { sp.tx += spd; }
            sp.tx = Math.max(20, Math.min(W - 20, sp.tx));
            sp.ty = Math.max(70, Math.min(H - 24, sp.ty));
        }

        // Living ships: movement, trail, fire, timers.
        for (const sp of this.ships) {
            if (sp.down) {
                continue;
            }
            sp.x += (sp.tx - sp.x) * 0.2 * ts;
            sp.y += (sp.ty - sp.y) * 0.2 * ts;
            sp.x = Math.max(20, Math.min(W - 20, sp.x));
            sp.y = Math.max(70, Math.min(H - 24, sp.y));
            if (sp.inv > 0) {
                sp.inv -= ts;
            }
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
            sp.fireT -= ts;
            if (sp.fireT <= 0) {
                sp.fireT = sp.weapon === "triple" ? 8 : 9;
                if (sp.slot === this.localSlot) {
                    this.sShoot();
                }
                this.burst(sp.x, sp.y - 20, "#aef1ff", 3, 1.5);
                if (sp.weapon === "triple") {
                    this.bullets.push(
                        { x: sp.x, y: sp.y - 16, vx: 0, vy: -11 },
                        { x: sp.x - 8, y: sp.y - 10, vx: -1.8, vy: -10.5 },
                        { x: sp.x + 8, y: sp.y - 10, vx: 1.8, vy: -10.5 }
                    );
                } else {
                    this.bullets.push({ x: sp.x, y: sp.y - 16, vx: 0, vy: -11 });
                }
            }
            if (sp.weaponT > 0) {
                sp.weaponT -= ts;
                if (sp.weaponT <= 0) {
                    sp.weapon = "single";
                    this.pop(sp.x, sp.y - 30, "Disparo normal", "#8be9ff", 12);
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

        // Balas propias.
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const b = this.bullets[i];
            b.x += b.vx * ts;
            b.y += b.vy * ts;
            if (b.y < -20 || b.x < -20 || b.x > W + 20) {
                this.bullets.splice(i, 1);
            }
        }
        // Balas enemigas.
        for (let i = this.ebullets.length - 1; i >= 0; i--) {
            const b = this.ebullets[i];
            b.x += b.vx * ts;
            b.y += b.vy * ts;
            if (b.y > H + 20 || b.y < -20 || b.x < -20 || b.x > W + 20) {
                this.ebullets.splice(i, 1);
                continue;
            }
            let hit = false;
            for (const sp of this.ships) {
                if (sp.down || sp.inv > 0) {
                    continue;
                }
                const dx = b.x - sp.x;
                const dy = b.y - sp.y;
                if (dx * dx + dy * dy < 270) {
                    hit = true;
                    this.hurtShip(sp);
                    break;
                }
            }
            if (hit) {
                this.ebullets.splice(i, 1);
            }
        }

        this._updateEnemies(ts);
        this._updateRocks(ts);
        this._updatePups(ts);
        this._updateFx(ts);

        if (this.enemies.length === 0) {
            this.waveDelay -= ts;
            if (this.waveDelay <= 0) {
                this.spawnWave();
                this.waveDelay = 45;
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

    _updateStars(ts) {
        for (const s of this.stars) {
            s.y += s.z * (1.2 + this.wave * 0.06) * ts;
            if (s.y > this.H) {
                s.y = -4;
                s.x = Math.random() * this.W;
            }
        }
    }

    _updateRevive(ts) {
        for (const dn of this.ships) {
            if (!dn.down) {
                continue;
            }
            let reviver = false;
            for (const sp of this.ships) {
                if (sp.down || sp === dn) {
                    continue;
                }
                const dx = sp.x - dn.x;
                const dy = sp.y - dn.y;
                if (dx * dx + dy * dy < 42 * 42) {
                    reviver = true;
                    break;
                }
            }
            if (reviver) {
                dn.reviveProgress += ts;
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

    _updateEnemies(ts) {
        const W = this.W;
        const H = this.H;
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            const e = this.enemies[i];
            e.t += ts;
            if (e.type === "drone") {
                e.y += (1.2 + this.wave * 0.05) * ts;
                e.x += Math.sin(e.t * 0.05) * 1.1 * ts;
            } else if (e.type === "speedy") {
                e.y += (3 + this.wave * 0.08) * ts;
                const tgt = this._nearestShip(e.x, e.y);
                if (tgt) {
                    e.x += (tgt.x - e.x) * 0.006 * ts;
                }
            } else if (e.type === "tank") {
                e.y += 0.65 * ts;
                if (e.y > 0 && Math.floor(e.t) % 150 === 0) {
                    const tgt = this._aimShip();
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
                    e.y += 1.1 * ts;
                } else {
                    e.x += Math.sin(e.t * 0.02) * 0.5 * ts;
                    e.aim += ts;
                    if (e.aim >= 70) {
                        e.aim = 0;
                        // Shoots the ship it telegraphed (the nearest one), not a random one.
                        const tgt = this._nearestShip(e.x, e.y);
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
                // Chases the nearest ship, accelerating; the core goes wild.
                const tgt = this._nearestShip(e.x, e.y);
                if (tgt) {
                    const dx = tgt.x - e.x;
                    const dy = tgt.y - e.y;
                    const d = Math.sqrt(dx * dx + dy * dy) || 1;
                    e.vx += (dx / d) * 0.09 * ts;
                    e.vy += (dy / d) * 0.09 * ts;
                }
                const sp = Math.sqrt(e.vx * e.vx + e.vy * e.vy) || 1;
                const max = 3.4 + this.wave * 0.06;
                if (sp > max) {
                    e.vx = (e.vx / sp) * max;
                    e.vy = (e.vy / sp) * max;
                }
                e.x += e.vx * ts;
                e.y += e.vy * ts;
                // El sprite mira hacia abajo: rota respecto a +Y.
                e.rot = Math.atan2(e.vy, e.vx) - Math.PI / 2;
            } else {
                if (e.y < 95) {
                    e.y += 1.4 * ts;
                } else {
                    e.x = W / 2 + Math.sin(e.t * 0.016) * (W * 0.32);
                }
                if (e.y >= 90) {
                    if (Math.floor(e.t) % 85 === 0) {
                        for (let k = 0; k < 9; k++) {
                            const a = (k / 9) * 6.2832 + e.t * 0.01;
                            this.ebullets.push({ x: e.x, y: e.y, vx: Math.cos(a) * 2.3, vy: Math.sin(a) * 2.3 });
                        }
                        this.sTick();
                    }
                    if (Math.floor(e.t) % 55 === 27) {
                        const tgt = this._aimShip();
                        if (tgt) {
                            const dx = tgt.x - e.x;
                            const dy = tgt.y - e.y;
                            const d = Math.sqrt(dx * dx + dy * dy) || 1;
                            for (let k = -1; k <= 1; k++) {
                                this.ebullets.push({ x: e.x, y: e.y, vx: (dx / d) * 3 + k * 0.7, vy: (dy / d) * 3 });
                            }
                            this.sTick();
                        }
                    }
                }
            }
            if (e.y > H + 50) {
                this.enemies.splice(i, 1);
                continue;
            }
            // Collision with ships.
            let killedByShip = false;
            for (const sp of this.ships) {
                if (sp.down) {
                    continue;
                }
                const dx = e.x - sp.x;
                const dy = e.y - sp.y;
                const rr = e.r + 13;
                if (dx * dx + dy * dy < rr * rr) {
                    this.hurtShip(sp);
                    if (e.type !== "boss") {
                        this.killEnemy(e, i);
                        killedByShip = true;
                    }
                    break;
                }
            }
            if (killedByShip) {
                continue;
            }
            // Balas propias.
            for (let j = this.bullets.length - 1; j >= 0; j--) {
                const b = this.bullets[j];
                const bx = b.x - e.x;
                const by = b.y - e.y;
                if (bx * bx + by * by < (e.r + 4) * (e.r + 4)) {
                    this.bullets.splice(j, 1);
                    e.hp--;
                    this.burst(b.x, b.y, "#fff", 4, 2);
                    if (e.hp <= 0) {
                        this.killEnemy(e, i);
                        break;
                    } else {
                        e.flash = 6;
                        this.noise(0.05, 0.06, 3000);
                    }
                }
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
            if (rk.x < rk.r) { rk.vx = Math.abs(rk.vx); }
            if (rk.x > W - rk.r) { rk.vx = -Math.abs(rk.vx); }
            if (rk.y > H + rk.r + 20) {
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
                const rr = rk.r + 12;
                if (dx * dx + dy * dy < rr * rr) {
                    this.hurtShip(sp);
                    this._breakRock(rk, i);
                    broke = true;
                    break;
                }
            }
            if (broke) {
                continue;
            }
            // Balas propias.
            for (let j = this.bullets.length - 1; j >= 0; j--) {
                const b = this.bullets[j];
                const bx = b.x - rk.x;
                const by = b.y - rk.y;
                if (bx * bx + by * by < (rk.r + 3) * (rk.r + 3)) {
                    this.bullets.splice(j, 1);
                    rk.hp--;
                    this.burst(b.x, b.y, "#c9c9d6", 4, 2);
                    if (rk.hp <= 0) {
                        this._breakRock(rk, i);
                        break;
                    }
                }
            }
        }
    }

    _breakRock(rk, i) {
        this.rocks.splice(i, 1);
        this.burst(rk.x, rk.y, "#b9bcd0", 20, 4.5);
        this._ev({ k: "boom", x: rk.x, y: rk.y, c: "#b9bcd0", b: 0 });
        this.sBoom();
        this.shake = Math.min(this.shake + 4, 24);
        this.score += 50 * this.combo;
        this.pop(rk.x, rk.y, "+" + (50 * this.combo).toLocaleString(), "#c9c9d6", 12);
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
            if (p.y > H + 20) {
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
                this.burst(p.x, p.y, "#7bffb0", 14, 3);
                this._ev({ k: "pup", x: p.x, y: p.y });
                if (p.t === "T") {
                    picker.weapon = "triple";
                    picker.weaponT = 650;
                    this.pop(picker.x, picker.y - 30, "Triple shot!", "#5ee1ff", 15);
                } else if (p.t === "S") {
                    picker.shield = 1;
                    this.pop(picker.x, picker.y - 30, "Shield!", "#7bffb0", 15);
                } else if (p.t === "B") {
                    this.bomb();
                    this.pop(picker.x, picker.y - 30, "BOMB!", "#ffb347", 18);
                } else {
                    picker.lives = Math.min(5, picker.lives + 1);
                    this.pop(picker.x, picker.y - 30, "Extra life!", "#ff8fb3", 15);
                }
            }
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
    /* Red: entrada remota y snapshot                                      */
    /* ------------------------------------------------------------------ */

    /** Host: apply a guest pointer. */
    setRemoteInput(slot, tx, ty) {
        const sp = this.ships.find((s) => s.slot === slot);
        if (sp && !sp.down) {
            sp.tx = tx;
            sp.ty = ty;
        }
    }

    /** Host: compact state to broadcast over the bus. */
    snapshot() {
        const snap = {
            st: this.state,
            sc: this.score,
            wv: this.wave,
            cb: this.combo,
            ct: this.comboT,
            sk: Math.round(this.shake),
            fl: Math.round(this.flashT),
            ships: this.ships.map((s) => ({
                s: s.slot, n: s.name, c: s.color,
                x: Math.round(s.x), y: Math.round(s.y),
                iv: s.inv > 0 ? 1 : 0, sd: s.shield,
                dn: s.down ? 1 : 0, rp: Math.round(s.reviveProgress),
                wp: s.weapon === "triple" ? 1 : 0, lv: s.lives,
            })),
            en: this.enemies.map((e) => ({
                t: e.type, x: Math.round(e.x), y: Math.round(e.y),
                h: e.hp, mh: e.mhp, f: e.flash > 0 ? 1 : 0, tt: Math.round(e.t),
                // `v` = chassis variant; `rt`/`am` only for kamikaze/sniper.
                v: e.v || 0,
                rt: e.rot != null ? Math.round(e.rot * 100) / 100 : undefined,
                am: e.aim != null ? Math.round(e.aim) : undefined,
            })),
            bu: this.bullets.map((b) => [Math.round(b.x), Math.round(b.y)]),
            eb: this.ebullets.map((b) => [Math.round(b.x), Math.round(b.y)]),
            pu: this.pups.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), t: p.t, ph: p.ph })),
            rk: this.rocks.map((r) => ({
                x: Math.round(r.x), y: Math.round(r.y), r: Math.round(r.r),
                a: Math.round(r.rot * 100) / 100, v: r.v || 0,
            })),
            ev: this._events,
        };
        this._events = [];
        return snap;
    }

    /** Guest: apply a received snapshot. */
    applySnapshot(snap) {
        this.state = snap.st;
        this.score = snap.sc;
        this.wave = snap.wv;
        this.combo = snap.cb;
        this.comboT = snap.ct;
        this.shake = snap.sk;
        this.flashT = snap.fl;
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
            sp.tx = s.x;
            sp.ty = s.y;
            sp.inv = s.iv ? 8 : 0;
            sp.shield = s.sd;
            sp.down = !!s.dn;
            sp.reviveProgress = s.rp;
            sp.weapon = s.wp ? "triple" : "single";
            sp.lives = s.lv;
        }
        this.ships = this.ships.filter((sp) => slots.includes(sp.slot));
        // Entities taken as-is (no interpolation in this version).
        this.enemies = snap.en.map((e) => ({
            type: e.t, x: e.x, y: e.y, r: this._enemyR(e.t),
            hp: e.h, mhp: e.mh, c: this._enemyColor(e.t),
            flash: e.f ? 4 : 0, t: e.tt, v: e.v || 0, rot: e.rt, aim: e.am,
        }));
        this.bullets = snap.bu.map((b) => ({ x: b[0], y: b[1], vx: 0, vy: 0 }));
        this.ebullets = snap.eb.map((b) => ({ x: b[0], y: b[1], vx: 0, vy: 0 }));
        this.pups = snap.pu.map((p) => ({ x: p.x, y: p.y, t: p.t, ph: p.ph, r: 13 }));
        this.rocks = snap.rk.map((r) => ({ x: r.x, y: r.y, r: r.r, rot: r.a, v: r.v || 0 }));
        for (const ev of snap.ev || []) {
            this._playEvent(ev);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Render                                                              */
    /* ------------------------------------------------------------------ */

    drawShip(sp) {
        const g = this.g;
        if (sp.inv > 0 && (this.frame >> 2) % 2 === 0) {
            return;
        }
        g.save();
        g.translate(sp.x, sp.y);
        const tilt = Math.max(-0.35, Math.min(0.35, (sp.tx - sp.x) * 0.02));
        g.rotate(tilt);
        g.globalCompositeOperation = "lighter";
        g.fillStyle = this.glow(sp.color, 0.12);
        g.beginPath();
        g.arc(0, 0, 26, 0, 6.2832);
        g.fill();
        const fl = 10 + Math.random() * 8;
        g.fillStyle = "rgba(255,170,70,0.85)";
        g.beginPath();
        g.moveTo(-5, 14);
        g.lineTo(0, 14 + fl);
        g.lineTo(5, 14);
        g.closePath();
        g.fill();
        g.globalCompositeOperation = "source-over";
        // Each slot has its own hull; the sprite is tinted with sp.color.
        drawSprite(g, "ship" + (sp.slot % 4), 0, 0, { tint: sp.color, px: SHIP_PX });
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
            const tgt = this._nearestShip(e.x, e.y);
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

        // Logical world transform (scale + centring).
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.translate(this.ox, this.oy);
        g.scale(this.scale, this.scale);

        g.save();
        g.beginPath();
        g.rect(0, 0, W, H);
        g.clip();
        g.fillStyle = "#05060e";
        g.fillRect(0, 0, W, H);
        if (this.shake > 0.5) {
            g.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
        }
        for (const s of this.stars) {
            g.fillStyle = "rgba(200,220,255," + (0.25 + s.z * 0.25) + ")";
            g.fillRect(s.x, s.y, s.s, s.s + s.z * 2);
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
        for (const b of this.bullets) {
            g.fillStyle = "rgba(94,225,255,0.25)";
            g.fillRect(b.x - 3, b.y - 2, 6, 16);
            g.fillStyle = "#d8f8ff";
            g.fillRect(b.x - 1.5, b.y, 3, 12);
        }
        for (const b of this.ebullets) {
            g.fillStyle = "rgba(255,110,110,0.3)";
            g.beginPath();
            g.arc(b.x, b.y, 7, 0, 6.2832);
            g.fill();
            g.fillStyle = "#ffdada";
            g.beginPath();
            g.arc(b.x, b.y, 3.5, 0, 6.2832);
            g.fill();
        }
        g.globalCompositeOperation = "source-over";
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
            g.fillRect(-30, -30, W + 60, H + 60);
        }
        g.restore();

        this._renderHud();
    }

    _renderHud() {
        const g = this.g;
        const W = this.W;
        const H = this.H;
        g.textBaseline = "middle";
        if (this.state === "playing" || this.state === "over") {
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
            g.fillText("Oleada " + this.wave, W / 2, 22);
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
                    g.fillText(sp.name + "  " + extra, W - 14, py);
                }
                py += 18;
            }
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
            g.fillText("Drag to move · auto fire", W / 2, H / 2 - 16);
            g.fillText("Survive the waves and take down the bosses", W / 2, H / 2 + 8);
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
            g.fillRect(0, 0, W, H);
            g.textAlign = "center";
            g.fillStyle = "#ff8f8f";
            g.font = "500 38px system-ui,sans-serif";
            g.fillText("Game over", W / 2, H / 2 - 58);
            g.fillStyle = "#eaf6ff";
            g.font = "500 22px system-ui,sans-serif";
            g.fillText("Puntos: " + this.score.toLocaleString(), W / 2, H / 2 - 12);
            g.fillStyle = "rgba(180,210,255,0.85)";
            g.font = "400 15px system-ui,sans-serif";
            g.fillText("Best: " + this.best.toLocaleString() + " · Wave " + this.wave, W / 2, H / 2 + 16);
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
        return {
            x: (e.clientX - r.left - this.ox) / this.scale,
            y: (e.clientY - r.top - this.oy) / this.scale,
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
        // Only host/solo can start or retry by tapping; the guest cannot.
        if (this.role !== "guest" && this.state !== "playing") {
            this.beginPlay();
        }
        this._applyLocalInput(p.x, p.touch ? p.y - 60 : p.y);
    }

    _pointerMove(e) {
        const p = this._ptr(e);
        this._applyLocalInput(p.x, p.touch ? p.y - 60 : p.y);
    }
}
