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
import { drawSprite, pxFor, rgba, spriteSize } from "./sprites";
import { MAX_ACTIVES, PERKS, PERK_INDEX, rollOffers } from "./perks";
import { PerkScreen } from "./perk_screen";
import { BOSSES, bossForWave } from "./bosses";
import { COLOSSI, colossusForWave } from "./colossi";
import { SHIPS, SHIP_COLORS } from "./ships";
import { ShipFlight } from "./ship_flight";
import { BossAnimator } from "./boss_animator";
import { COLOSSUS_ANIM_KINDS, ColossusAnimator, hullParts } from "./colossus_animator";
import { DRONE_ANIM, drawDrone, drawDroneWreck, droneTier } from "./drone_animator";
import {
    FRY_ANIM, drawFry, drawFryWreck, fryDeathFrames, fryKit, fryStep, fryTier,
} from "./fry_animator";
import { AegisMotion } from "./aegis_motion";
import { VulcanMotion } from "./vulcan_motion";
import { Backdrop, backgroundForWave, bgFlow } from "./backgrounds";
import {
    HudFx, drawActives, drawBuffs, drawCombo, drawCrewTag, drawEscPip, drawMeta, drawVitals,
} from "./hud";
const REVIVE_FRAMES = 120;
const COMBO_MAX = 25;
// The hitbox is deliberately far smaller than the hull: the sprite is ~32
// logical px wide, this is the circle that actually kills you. It is drawn as
// a dot in `drawShip`, because a hitbox nobody can see is a hitbox nobody can
// use. Every other collision radius against a ship is derived from it, so
// there is exactly one shape to learn.
const SHIP_HIT_R = 6.5;
// Grazing: passing this close to an enemy bullet without being hit. Every
// GRAZE_PER_COMBO grazes are worth one combo step, which is what pays for
// flying into the pattern instead of camping the bottom of the arena.
const GRAZE_R = 26;
const GRAZE_PER_COMBO = 10;
// Focus (Shift): precision movement. The hitbox does not change size, it just
// becomes obvious and the ship stops overshooting the cursor.
const FOCUS_FACTOR = 0.38;
// Frames of warning before a boss pattern goes off (see `_tel`).
const TELEGRAPH_FRAMES = 45;
// Health fraction where a boss switches to its second phase.
const BOSS_RAGE_AT = 0.5;
const COLOSSUS_RAGE_AT = 0.45;
// HYDRA-07. Its two attacks ask opposite things -- the spiral is a static
// pattern you thread a route through, the fan is aimed and punishes standing
// still -- and the fight is the tension between them. Under the rage threshold
// they take turns with a breath in between, so each one gets read on its own;
// over it they run at once, a spiral floor with fans landing on top of it.
//
// The crown turns whether or not it is emitting, and **flips direction at the
// start of every charge**: that is what the wind-up telegraphs. The ring of
// light `colossus_animator.js` runs around the crown reads `sa` and the same
// arm count, so retuning the spiral cannot leave the light pointing where the
// bullets are not.
const HYDRA_SPIRAL = {
    rate: 0.11,         // rad/frame the crown turns
    arms: 2, ragedArms: 3,
    every: 9,           // frames between pairs of bullets while emitting
    ragedEvery: 5,
    deadStep: 2,        // ...faster by this much per side head destroyed
    warn: 45,           // SPIRAL_CHARGE, and it shows which way the spiral goes
    burst: 190,         // how long one turn at the crown lasts
};
const HYDRA_FAN = {
    every: 165, ragedEvery: 110,
    warn: 45,
    // The two heads fire this far apart, never together: the whole point of
    // two aimed cones is being able to read which one is coming first.
    stagger: 24,
};
// The breath between two attacks in the first phase. Without it the fight is
// the second phase from the start, and the alternation is what the first one is.
const HYDRA_REST = 55;
// The side heads are destructible, and that is the trade the boss is built on:
// killing one costs you nothing but the time to fly out to the flank and shoot
// it, and it takes that head's fan out of the fight -- but the crown's spiral
// tightens by `deadStep` for each one that is gone. Kill both and HYDRA stops
// aiming at you entirely and becomes a wall of spiral.
const HYDRA_HEAD = {
    hp: 0.12,           // of the hull's own maximum, each
    val: 0.06,          // of the colossus's score, each
    dead: 900,          // 15 s hanging inert...
    regrow: 40,         // ...and the rebuild, eyes last
};
// VULCAN. Its three attacks were three independent timers; the design sheet
// made them one **heat cycle**, and that is what this is:
//
//   REST -> BEAM_WARN -> BEAM (heat climbs) -> OVERHEAT -> VENT (heat dumps,
//   the core is open) -> ROCK_WARN -> ROCKS (heat drifts down) -> REST
//
// Heat is the clock, and the player owns a lever on it: the two shoulder fans.
// A hit on one adds `VULCAN_FAN.heat`, which brings the overheat forward, and
// the overheat **kills the beams on the spot** -- so shooting the fans is both
// how you cut a beam phase short and how you buy the next window at the core.
// Everything the fight is about is in that one loop, which is why the phases
// live in an array instead of three `a1/a2/a3` countdowns.
//
// It reads at a glance off the hull because the art has a three-layer slot
// (dark frame, neon ring, white middle) with exactly the ramp headroom to be a
// gauge -- see `slotOf` in `colossus_animator.js`.
const V_REST = 0;
const V_BEAM_WARN = 1;
const V_BEAM = 2;
const V_OVERHEAT = 3;
const V_VENT = 4;
const V_ROCK_WARN = 5;
const V_ROCKS = 6;
const VULCAN = {
    // Frames each phase lasts. BEAM is a ceiling, not a duration: heat normally
    // ends it first, and that is the point of the lever.
    len: [46, 60, 300, 40, 130, 35, 26],
    raged: [30, 46, 300, 28, 104, 26, 26],
    // Heat per 60 fps frame, by phase. The beam rate is what sets the cycle:
    // 1/210 is 3.5 s of forge from cold to overheat.
    // -1/128 against a 130 frame vent: a full window empties the gauge exactly
    // as it closes, and a window shortened by a jammed fan leaves heat behind,
    // so a broken exhaust means the forge never quite cools. That is the cost
    // of the overshoot, and it costs nothing to express.
    heat: [-1 / 900, 1 / 900, 1 / 210, 1 / 600, -1 / 128, -1 / 260, -1 / 260],
    ragedHeat: 1.3,     // multiplier on a *rising* rate only
    // The volley: how many rocks, and therefore how many pips the telegraph
    // lights. "Number of lit dots = number of projectiles" is a promise, so the
    // count is decided when the charge opens and travels as `vn`.
    volley: [3, 6], ragedVolley: [5, 8],
    rock: { speed: 1.5, spread: 0.42, jitter: 0.07, r: [15, 31] },
    // Molten rings, one burst per live fan per wave, thrown down and outwards.
    // The pocket they leave is the middle -- which is exactly where the core
    // window is, so the attack and the reward are the same piece of geometry.
    ring: { n: 13, speed: 2.3, arc: 4.2, waves: 2, gap: 52, spin: 0.24,
            // The backfire: with every fan jammed the heat has nowhere to go,
            // so it comes out of the slot instead -- a full circle from the
            // middle of the hull, which is exactly where the core window has
            // been inviting the player to stand. Without it, jamming both fans
            // is the *safe* play (no rings at all during a window), and the
            // overshoot penalty rewards the overshoot. Fewer bullets than two
            // working shoulders throw, out of the worst possible place.
            backN: 16, backSpeed: 2.1 },
    // The two forge beams. `warn` matches BEAM_WARN so the sight line and the
    // phase are the same beat, and the origin comes from `parts.arms` (the
    // hand at the end of each side arm) instead of a fraction nothing draws.
    beam: { w: 30, spin: 0.0055, ragedSpin: 0.0075, life: 1200 },
    // The vent window: hits inside the core box count double while the slot is
    // open. `COLOSSI[2].hp` carries a modest lift for it rather than a full
    // one -- a player who never uses the window should not be paying for it.
    vent: { coreMul: 2 },
};
// The fans are the lever, and jamming one is the overshoot penalty: it stops
// taking heat (so you lose the lever), and the machine loses that much of its
// exhaust, so the vent window itself gets shorter. All you win is one ring
// fewer. Chip them; do not break them.
const VULCAN_FAN = {
    hp: 0.055,          // of the hull's own maximum, each
    // The exchange rate: damage spent on a fan buys heat in proportion, so
    // taking one down to half its points buys half of `heatFull`. Per *damage*
    // and not per hit, which is the only version that is not either useless or
    // broken -- a flat amount per hit is worth nothing to a single shot and
    // instant overheat to a rapid-fire build, and the lever has to read the
    // same whatever the player is flying.
    heatFull: 0.9,
    // ...and it repairs, or the lever is spent after seven hits and the fight
    // goes back to its own clock for the rest of the run. 8 s from nothing to
    // whole, which sustained fire outpaces easily -- so chipping is a lever you
    // keep, and jamming is still what happens if you commit to it.
    repair: 1 / 480,    // of its maximum per frame
    jam: 720,           // 12 s seized
    ventShare: 0.3,     // of the vent window one jammed fan takes away
};
// Hulls a practice wave queues when the target is a regular enemy. Small on
// purpose: the point is to watch one of them, not to survive a swarm.
const PRACTICE_ENEMIES = 6;
// Bombs are a stock you spend (X), not a capsule that goes off on pickup.
const BOMB_START = 2;
const BOMB_MAX = 3;
// Frames the whole simulation freezes on an impact. Small, but it is the
// difference between a bullet deleting an enemy and a bullet hitting one.
const HITSTOP_CHAFF = 1;
const HITSTOP_HEAVY = 3;
const HITSTOP_BOSS = 8;
const HITSTOP_COLOSSUS = 12;
const HITSTOP_HURT = 6;
// Frames a bomb's shockwave ring takes to cross the field. Cosmetic: the
// clear itself is still instant, the ring is what makes it read as a blast
// sweeping outward instead of the bullets simply ceasing to exist.
const SHOCK_FRAMES = 26;

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
// The small ships that share `fry_animator.js`, in the order their corpse
// cue encodes them. Appending is safe; reordering is not.
const FRY_KINDS = ["speedy", "tank", "sniper", "kami"];
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
// Capsule flow off small fry. It is rolled per kill, but what the player feels
// is capsules a minute, and the two come apart badly across a run: a wave is
// 9-12 hulls in 6-8 seconds at wave 1 and 32-44 in 14-17 by wave 16, so a flat
// chance more than doubles the flow with it. Measured over three runs to wave
// 28: 6-12 capsules a minute and 0.6-1.0 standing on the field over the first
// three waves, against 24-40 a minute and 2.3-3.9 standing from wave 16 on --
// enough that the timed buffs (10 seconds each) never lapse and a late run
// stops being about the build. `dropFalloff` holds the flow near its wave-1
// rate for the rest of the run; `DROP_FIELD_CAP` is the ceiling on what may be
// standing uncollected before a roll is skipped, which is what takes the spikes
// off. Both apply to fry only: a supply drop and a boss bundle are the answer
// to a boss fight having no fry in it, and are left alone.
const DROP_CHANCE = 0.22;
const DROP_FALLOFF_WAVE = 18;
const DROP_FALLOFF_MIN = 0.42;
const DROP_FIELD_CAP = 4;
// What a modifier is measured from, for the running totals the upgrade screen
// shows. They live here rather than in `perk_screen.js` because every one of
// them is a number this file applies: change `_fireDelay`'s base, `SHIP_HIT_R`
// or `DASH_CD` and the card has to move with it.
const MOD_BASES = {
    fireRate: 9, dmg: 1, bulletSpeed: 1, side: 0, pierce: 0,
    crit: 0, critMul: 2, moveSpeed: 1, hitbox: SHIP_HIT_R, lives: 3,
    maxLives: 5, inv: 1, magnet: 0, luck: DROP_CHANCE, scoreMul: 1,
    dashCd: DASH_CD, dashCharges: 1,
};
// Timed capsules: frames the buff lasts on the ship that grabbed it.
const PUP_BUFFS = { R: 600, V: 600, P: 540, H: 600, D: 900, G: 240 };
// Order of `ship.buffs` in the snapshot bitmask (never reorder, append only).
const BUFF_KEYS = ["R", "V", "P", "H", "D", "G"];
// Enemy bullet vocabulary. The colour and the size say what the shot does, so
// the arena stays readable when three patterns overlap. `k` is the index into
// this table, it is rolled where the bullet is fired and it travels in the
// snapshot: this is wire format, append only.
//   0 spread  - radial or spiral burst, it was not aimed at you: read the gaps
//   1 aimed   - fired at where you were: keep moving sideways
//   2 lance   - fast and precise, it is already where it is going
//   3 curtain - slow heavy wall: find the gap, you cannot outrun it
const EB_KINDS = [
    { c: "#ff5d8f", h: "#ffe0ea", r: 6, cr: 3 },
    { c: "#ffb347", h: "#fff0d2", r: 6.5, cr: 3.4 },
    { c: "#4de3c1", h: "#e0fff8", r: 5, cr: 2.6 },
    { c: "#c9a4ff", h: "#f0e6ff", r: 8.5, cr: 4.4 },
];
const EB_SPREAD = 0;
const EB_AIMED = 1;
const EB_LANCE = 2;
const EB_CURTAIN = 3;
// The forge-beam profile, from the VULCAN design sheet. Its beams are three
// concentric layers rather than the two the engine drew: the hull's own colour
// as an outer sheath, a hotter inner one, and a core that is white and one or
// two pixels wide from frame to frame. `hull` means "use the beam's own colour",
// so the sheath stays the boss-tint code the rest of the game reads beams by.
// The width waves *along* the beam (which is why it is drawn in segments) and
// the whole thing flickers per frame -- between them, that is the difference
// between molten metal and a laser pointer.
const BEAM_FORGE = {
    // Each layer is drawn as one filled ribbon whose two edges follow the wave,
    // rather than as a run of strokes of different widths. Both give the same
    // picture; the ribbon gives it with 4 rasterised fills per beam instead of
    // 104 strokes (measured: 212 rasterising calls a frame against 8), and its
    // edges come out continuous instead of stepped every 46 px.
    steps: 20,
    waveLen: 3.4,       // wavelengths over the beam's length
    waveRate: 0.011,    // ...travelling down it, per frame
    waveAmp: 0.16,
    flickMin: 0.62,
    layers: [
        { c: "hull", a: 0.20, w: 1.0, flick: 1 },
        { c: "hull", a: 0.42, w: 0.52, flick: 1 },
        { c: "#fff0d2", a: 0.55, w: 0.26, flick: 1 },
        { c: "#ffffff", a: 0.95, w: 0.11, core: 1 },
    ],
    // Where the beam lands. `at` is a fraction of its length: the beams are
    // 1200 px long and sweep past the bottom of the field, so the bloom sits
    // where it crosses rather than at its far end, which is off screen.
    bloom: { at: 0.42, rx: 0.85, ry: 0.5, a: 0.3 },
};
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
        // Practice run: one target from the glossary, over and over, instead of
        // the normal wave table. `{type, v}` for a regular enemy chassis,
        // `{boss: k}`, `{colossus: k}` or `{rock: v}`. Solo only, and the score
        // is not submitted (see `onGameOver` in the OWL component).
        this.practice = callbacks.practice || null;

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
        // Frames the simulation stays frozen after an impact. Unlike slow
        // motion this stops everything dead, which is what gives a kill its
        // weight; it is local (never in the snapshot) and never runs on a
        // guest, whose whole job is to keep interpolating.
        this.hitstop = 0;
        // Lives lost this run and whether the current wave has been cleared
        // untouched. Both feed the risk economy: a clean wave pays a bonus,
        // and repeated deaths thin out the next waves a little.
        this.deaths = 0;
        this.waveClean = true;
        // True only while `bomb()` is clearing the field, so those kills can
        // be paid at a discount: a bomb is a way out, not a scoring move.
        this.bombing = false;
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
        // Boss animation state, keyed by boss index. It cannot live on the enemy
        // object: a guest rebuilds `this.enemies` from every snapshot, which
        // would reset the pose ~15 times a second.
        this._bossAnims = new Map();
        // Same thing for the colossi, keyed by colossus index. Only the ones
        // with a section in `COLOSSUS_ANIM_KINDS` get an animator; the rest are
        // drawn plain.
        this._colossusAnims = new Map();
        // Entities created by perks (dash trails, turrets, singularities, decoys).
        this.trails = [];
        this.turrets = [];
        this.holes = [];
        this.decoys = [];
        // Arc Capacitor bolts: cosmetic, they live one blink (also on guests).
        this.zaps = [];
        // Bomb shockwaves: cosmetic rings sweeping out from the detonation.
        this.shocks = [];
        // Dead drones coming apart (see `drone_animator.js`). Cosmetic and
        // capped: a bomb can sweep thirty hulls on one frame.
        this.wrecks = [];
        // Colossus beams (telegraphed, then lethal).
        this.beams = [];
        // Global timers driven by actives: frozen bullets and slowed enemies.
        this.freezeT = 0;
        this.warpT = 0;
        // Perk phase: {offers: {slot: [idx]}, picks: {slot: idx}, t}. Null while
        // playing. The state machine goes playing -> perk -> playing.
        this.perkPhase = null;
        this.nextPerkWave = PERK_WAVES;
        // The upgrade screen. Render-only, like `ShipFlight` and `HudFx`: it
        // holds the animation of the cards and nothing the simulation reads.
        this.perkUI = new PerkScreen();
        this.perkTimedOut = false;
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
        this._ku = (e) => this._keyUp(e);
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
        if (this.paused) {
            // Frozen: no simulation, no interpolation. Only the overlay moves.
            this.render();
            this._raf = requestAnimationFrame(this._loop);
            return;
        }
        // Hitstop: a handful of frames where nothing moves at all. It comes
        // before the slow-motion clock on purpose (it is a hit landing, not a
        // dramatic pause) and it is skipped on a guest, which does not
        // simulate and would only stutter its interpolation.
        if (this.hitstop > 0 && this.role !== "guest") {
            this.hitstop--;
            this.render();
            this._raf = requestAnimationFrame(this._loop);
            return;
        }
        const ts = this.slowMo > 0 ? 0.35 : 1;
        if (this.slowMo > 0) {
            this.slowMo--;
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
            if (ev.dr) {
                this._droneWreck(ev.x, ev.y, ev.dr);
            }
            if (ev.fr) {
                this._fryWreck(ev.x, ev.y, ev.fr);
            }
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
            if (ev.x != null) {
                this.shocks.push({ x: ev.x, y: ev.y, t: 0 });
            }
        } else if (ev.k === "rage") {
            // Boss phase change. The threshold is derivable from `h`/`mh`, but
            // the beat itself is mirrored so it lands on the same frame here.
            this.burst(ev.x, ev.y, ev.c || "#ff6b6b", 40, 6);
            this.flashT = Math.max(this.flashT, 7);
            this.sBigBoom();
        } else if (ev.k === "zap") {
            this.zaps.push({ x1: ev.x, y1: ev.y, x2: ev.x2, y2: ev.y2, life: 8 });
        } else if (ev.k === "bfx") {
            // Boss cosmetic cue. Created on demand, because the event can arrive
            // in the same snapshot that first introduces the boss.
            let anim = this._bossAnims.get(ev.bk);
            if (!anim) {
                anim = new BossAnimator(ev.bk, (BOSSES[ev.bk] || BOSSES[0]).tint);
                this._bossAnims.set(ev.bk, anim);
            }
            anim.emit(ev.n, ev);
        } else if (ev.k === "cfx" && ev.ck < COLOSSUS_ANIM_KINDS.length) {
            // Same, for a colossus. The guard matches `_colossusCue`: an index
            // with no section would get an animator posed as AEGIS and, since
            // `_updateColossusAnims` skips it, frozen there.
            let anim = this._colossusAnims.get(ev.ck);
            if (!anim) {
                anim = new ColossusAnimator(ev.ck, (COLOSSI[ev.ck] || COLOSSI[0]).tint);
                this._colossusAnims.set(ev.ck, anim);
            }
            anim.emit(ev.n);
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
            // HUD transitions, on the same terms: it watches lives, bombs and
            // dash charges and lights an envelope wherever one moved, so a
            // guest gets them off the snapshot for free.
            hudFx: new HudFx(),
            inv: 0, invMax: 1, shield: 0,
            weapon: "single", weaponT: 0, fireT: 0,
            lives: 3, down: false, reviveProgress: 0,
            // Bombs (X): the emergency exit. You start with a couple and the
            // B capsule refills the stock instead of detonating on pickup.
            bombs: BOMB_START,
            // Focus (Shift): halves the movement and shows the hitbox.
            focus: false,
            // Grazes banked towards the next combo step (see `_grazeTick`).
            graze: 0, grazeT: 0,
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
            // What `dashCd` started at. The HUD fills the recharging pip with
            // the ratio of the two, and a bare countdown cannot be divided.
            dashCdMax: DASH_CD,
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

    /**
     * The collision radius of a ship. Everything that can hurt it (bullets,
     * hulls, rocks, beams) measures against this one number, so what the dot
     * in `drawShip` promises is what every threat in the game respects.
     */
    _hitR(sp) {
        return Math.max(2, SHIP_HIT_R * (1 + sp.mods.hitbox));
    }

    /**
     * Start an invulnerability window. `invMax` is kept so the render can show
     * how much of it is left instead of blinking at a fixed rate right up to
     * the frame it ends.
     */
    _setInv(sp, frames) {
        if (frames <= sp.inv) {
            return;
        }
        sp.inv = frames;
        sp.invMax = frames;
    }

    /**
     * A bullet passed close enough to count. Grazes bank towards a combo step,
     * which is the whole reason to fly into a pattern: the combo multiplies
     * every point in the game, and camping the bottom of the arena earns none.
     */
    _grazeTick(sp, x, y) {
        sp.graze++;
        sp.grazeT = 30;
        if (this.frame % 2 === 0) {
            this.parts.push({
                x, y,
                vx: (Math.random() - 0.5) * 1.5,
                vy: (Math.random() - 0.5) * 1.5,
                r: Math.random() * 1.4 + 0.6,
                c: "#eaf6ff", life: 14, ml: 14,
            });
        }
        if (sp.graze % GRAZE_PER_COMBO === 0 && this.combo < COMBO_MAX) {
            this.combo++;
            this.comboT = Math.max(this.comboT, 170);
            this.pop(sp.x, sp.y - 38, "GRAZE x" + this.combo, "#eaf6ff", 13, 40);
            // The pitch climbs with the ladder, so a run of grazes is audibly
            // going somewhere instead of hitting the same key each time.
            this.tone(1100 + this.combo * 30, 0.04, "square", 0.03);
        }
    }

    _maxBombs() {
        return BOMB_MAX;
    }

    /** X: spend one bomb. It clears the field and buys a moment of safety. */
    useBomb(slot) {
        const sp = this._shipBySlot(slot);
        if (!sp || sp.down || sp.bombs <= 0 || this.state !== "playing") {
            return;
        }
        sp.bombs--;
        this._setInv(sp, 90);
        this.pop(sp.x, sp.y - 34, "BOMB", "#ffb347", 18);
        this.bomb(sp);
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
        this.perkTimedOut = false;
        this.perkUI.sync(offers[this.localSlot] || []);
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
        // The screen animates from the same step the phase counts down on, so
        // pause freezes it and slow motion slows it.
        this.perkUI.sync(ph.offers[this.localSlot] || []);
        this.perkUI.update(ts, this._perkModel());
        if (ph.t <= 0) {
            // Nobody is left without an upgrade: take the first option. The
            // card has been saying it would for the whole twenty seconds.
            for (const sp of pending) {
                const offer = ph.offers[sp.slot] || [];
                if (offer.length) {
                    if (sp.slot === this.localSlot) {
                        this.perkTimedOut = true;
                    }
                    this.pickPerk(sp.slot, offer[0]);
                }
            }
        } else if (pending.length) {
            return;
        }
        this.perkUI.close();
        this.perkPhase = null;
        this.state = "playing";
        this.waveDelay = 40;
        for (const sp of this.ships) {
            this._setInv(sp, 60);
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
            if (Math.abs(x - e.x) < e.hw + pad && Math.abs(y - e.y) < e.hh + pad) {
                return true;
            }
            // HYDRA's side heads hang below and outside the chest's box: half
            // of each one used to be unshootable, which is no way to run a
            // destructible part.
            return this._headAt(e, x, y, pad) >= 0;
        }
        const rr = e.r + pad;
        return (x - e.x) ** 2 + (y - e.y) ** 2 < rr * rr;
    }

    /**
     * Which live side head a point falls on, or -1. The boxes come from
     * `hullParts` (the same cells `colossus_animator.js` lights up), so what
     * you can shoot and what flashes when you hit it are one thing.
     *
     * A destroyed head is not a target: the stump is not something you can
     * keep chipping at, and letting bullets stop there would quietly protect
     * the chest behind it.
     */
    _headAt(e, x, y, pad) {
        if (!e.heads || !e.parts) {
            return -1;
        }
        for (let i = 0; i < e.heads.length; i++) {
            if (e.heads[i].hp <= 0) {
                continue;
            }
            const b = e.parts.heads[i];
            if (Math.abs(x - (e.x + b.x * e.w)) < b.hw * e.w + pad
                    && Math.abs(y - (e.y + b.y * e.h)) < b.hh * e.h + pad) {
                return i;
            }
        }
        return -1;
    }

    /**
     * A side head taking a hit. Head damage does **not** come off the hull:
     * killing one has to be a choice you make by flying out to the flank and
     * spending fire on it, not something that happens to you while you shoot
     * the chest -- otherwise the trade it buys is not a trade.
     */
    _damageHead(e, i, dmg, killer) {
        const h = e.heads[i];
        if (h.hp <= 0) {
            return;
        }
        h.hp -= dmg;
        const b = e.parts.heads[i];
        const hx = e.x + b.mx * e.w;
        const hy = e.y + b.my * e.h;
        if (h.hp > 0) {
            return;
        }
        // Destroyed: it hangs inert for 15 s, its fan is out of the fight, and
        // the crown speeds up to pay for it (see `_hydraDirector`).
        h.hp = 0;
        h.t = HYDRA_HEAD.dead + HYDRA_HEAD.regrow;
        this.burst(hx, hy, e.c, 46, 6);
        this.burst(hx, hy, "#ffffff", 16, 3.5);
        this.shake = Math.min(this.shake + 10, 24);
        this.hitstop = Math.max(this.hitstop, HITSTOP_BOSS);
        this.sBoom();
        // Paid like a kill, but it does not build the combo: the combo is the
        // rate you are clearing hulls at, and a head is a part of one.
        const pts = Math.round(
            e.val * HYDRA_HEAD.val * this.combo * (1 + (killer ? killer.mods.scoreMul : 0))
        );
        this.score += pts;
        this.pop(hx, hy - 26, "HEAD DOWN  +" + pts.toLocaleString(), "#ff2fd0", 17, 80);
        this._ev({ k: "boom", x: hx, y: hy, c: e.c, b: 1 });
    }

    /** `hp`/`mhp` pair, so the wave scaling is written once per enemy type. */
    _hp(n) {
        const hp = Math.max(1, Math.round(n));
        return { hp, mhp: hp };
    }

    /** Chassis variant (0/1) based on the sprites available for the type. */
    _enemyVariant(type) {
        const names = ENEMY_SPRITES[type];
        return names && names.length > 1 ? Math.floor(Math.random() * names.length) : 0;
    }

    mkEnemy(type, x, y, k) {
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
        // Small fry used to keep the same hull for the whole run: only their
        // speed grew, so past wave ~25 a wave was longer but never harder,
        // while the player kept stacking damage perks every 5 waves. The step
        // is per type, so the roles stay apart (a drone still dies fast).
        const w = this.wave;
        if (type === "drone") {
            return Object.assign(base, this._hp(1 + Math.floor(w / 9)), { t: Math.random() * 6.28, val: 100 });
        }
        if (type === "speedy") {
            // Seeded like a drone's and a tank's: `t` is the only phase the fry
            // kit has, so a squadron spawned on one frame would otherwise burn
            // in lockstep. It costs nothing -- `t` already travels.
            return Object.assign(base, this._hp(1 + Math.floor(w / 10)), { t: Math.random() * 300, val: 150 });
        }
        if (type === "tank") {
            // `fire` is the recoil: the frames left of the kick and the muzzle
            // flash. The animator cannot derive it (the hull is quiet again
            // before the bullet is anywhere), so the engine hands it over.
            return Object.assign(base, this._hp(4 + Math.floor(w / 5)), {
                t: Math.random() * 200, val: 300, fire: 0,
            });
        }
        if (type === "sniper") {
            // Stops mid-screen and punishes with telegraphed, accurate shots.
            // `t` seeded for the same reason as the speedy's, and here it is
            // the one that matters: a sniper's drift and its station-keeping
            // thrusters are both pure functions of it, so two of them side by
            // side used to puff on the same frame and cut together.
            return Object.assign(base, this._hp(3 + Math.floor(w / 7)), {
                t: Math.random() * 300, val: 400,
                stopY: 90 + Math.random() * 110, aim: 0, fire: 0,
            });
        }
        if (type === "kami") {
            // Locks onto a ship and accelerates; dies on contact (generic collision).
            return Object.assign(base, this._hp(2 + Math.floor(w / 8)), { t: 0, val: 350, vx: 0, vy: 1.2, rot: 0 });
        }
        // Regular boss: `k` picks which one of the family it is. It is only
        // passed in by a practice run; a normal wave reads it off the rotation.
        const bk = Math.max(0, k != null ? k : bossForWave(this.wave));
        const d = BOSSES[bk] || BOSSES[0];
        const hp = Math.round((35 + this.wave * 9 + (this.players - 1) * 25) * d.hp);
        return Object.assign(base, {
            type: "boss", k: bk, hp, mhp: hp, t: 0,
            r: d.r, c: d.tint, v: bk,
            val: Math.round(5000 * d.val), dropAt: 0.75,
            // `gap` is the hole in the next curtain. It is decided one curtain
            // ahead so the telegraph can show where it will be: a wall of
            // bullets you only read once it is on top of you is not a pattern.
            phase: 0, armor: 0, gap: this.W / 2, vx: 0, vy: 0,
            // Seeded, not left at zero: an undefined timer fires on its first
            // frame, so every boss used to open with an untelegraphed pattern
            // the instant it finished sliding in.
            a1: 70,
            // Telegraph (0..1) and which warning to draw, rebuilt every frame.
            tel: 0, telK: "",
            // Second phase, on a health threshold: `hold` is the beat where it
            // stops firing so the change is something you can see happen.
            raged: 0, hold: 0,
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
        const e = {
            type: "colossus", k, id: ++this._eid,
            x: this.W / 2, y: -h * 0.55, ty: d.y,
            w: d.w, h,
            // Hitbox slightly inside the art, so the silhouette stays fair.
            hw: d.w * 0.42, hh: h * 0.32,
            r: Math.min(d.w, h) * 0.28, // circle used by splashes and trails
            c: d.tint, field: d.field || 1, v: 0, flash: 0, stun: 0,
            hp, mhp: hp, t: 0, val: d.val, dropAt: 0.75,
            vx: d.speed, rot: 0, gap: this.W / 2,
            a1: 60, a2: 180, a3: 300,
            tel: 0, telK: "", raged: 0, hold: 0,
        };
        // HYDRA-07 is three creatures on one chest, and the two side ones are
        // targets of their own (see HYDRA_HEAD). `parts` comes out of the art
        // in `colossus_animator.js`, so the boxes you can shoot are the cells
        // that light up. `ph`/`pt` are the director; `sa` the crown's angle.
        if (k === 1) {
            const headHp = Math.max(1, Math.round(hp * HYDRA_HEAD.hp));
            Object.assign(e, {
                parts: hullParts(d.sprite),
                heads: [
                    { hp: headHp, mhp: headHp, t: 0 },
                    { hp: headHp, mhp: headHp, t: 0 },
                ],
                ph: 0, pt: HYDRA_REST, sa: 0, spin: 1, spiral: 0, fq: [0, 1],
            });
        }
        // VULCAN runs the heat cycle, and its two shoulder fans are the lever
        // on it (see VULCAN_FAN). `parts` comes out of the art the same way
        // HYDRA's does, so the fan you can hit is the housing that lights up,
        // the core box the vent window doubles damage in is the white middle,
        // and the beams leave from the ends of the bottom lip.
        if (k === 2) {
            const parts = hullParts(d.sprite);
            const fanHp = Math.max(1, Math.round(hp * VULCAN_FAN.hp));
            Object.assign(e, {
                parts,
                fans: (parts && parts.fans ? parts.fans : []).map(() => ({
                    hp: fanHp, mhp: fanHp, t: 0,
                })),
                ph: V_REST, pt: VULCAN.len[V_REST], ptMax: VULCAN.len[V_REST],
                heat: 0, vn: 0, vw: 0,
            });
        }
        return e;
    }

    spawnWave() {
        // Pay the wave that just ended before opening the next one. Clearing a
        // wave without being touched is the only thing in the game that asks
        // you to play well rather than merely long, so it is what the bonus
        // rewards -- and losing it is most of what a death now costs.
        if (this.wave >= 1 && this.waveClean) {
            const bonus = Math.round(500 * this.wave * (1 + this.combo * 0.06));
            this.score += bonus;
            this.pop(this.W / 2, this.H / 2 + 30, "NO DAMAGE  +" + bonus.toLocaleString(), "#7bffb0", 20, 100);
            this.sPup();
        }
        this.wave++;
        this.waveClean = true;
        this.sWave();
        this._ev({ k: "wave" });
        this._syncBackground();
        // Last Stand recharges once per wave.
        for (const sp of this.ships) {
            sp.standT = 0;
        }
        const p = this.players;
        if (this.practice) {
            this._spawnPracticeWave();
            return;
        }
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
        // Mercy: a run that keeps dying gets slightly shorter waves, down to
        // three quarters. It is not a difficulty setting, it is a floor under
        // the spiral where you die, lose the combo, and die again to the same
        // wave you were already struggling with.
        const relief = Math.max(0.75, 1 - this.deaths * 0.04);
        const n = Math.round((5 + this.wave * 2 + p * 2) * relief);
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

    /**
     * A wave of nothing but the target picked in the glossary. Reached from the
     * backend *Practice* menu, so a single hull can be watched without playing
     * ten waves to get to it -- which is most of what it costs to look at a
     * colossus twice.
     *
     * The wave counter still runs, and that is the point: the same target comes
     * back a little tougher every time instead of being frozen at wave 1. What
     * does not run is the rest of the run -- no perk phase, no boss escort, no
     * mixed spawns (see `_updateSpawns` and the perk check in `update`).
     */
    _spawnPracticeWave() {
        const pr = this.practice;
        if (pr.colossus != null) {
            const d = COLOSSI[pr.colossus] || COLOSSI[0];
            this.enemies.push(this.mkColossus(pr.colossus));
            this.bossAlive = true;
            this.pop(this.W / 2, this.H / 2 - 60, d.name, d.tint, 40, 130);
            this.pop(this.W / 2, this.H / 2 - 18, '"' + d.title + '"', "#eaf6ff", 20, 130);
            this.shake = 22;
            this.sBigBoom();
            return;
        }
        if (pr.boss != null) {
            const d = BOSSES[pr.boss] || BOSSES[0];
            this.enemies.push(this.mkEnemy("boss", this.W / 2, -90, pr.boss));
            this.bossAlive = true;
            this.pop(this.W / 2, this.H / 2 - 60, "BOSS", "#ff6b6b", 34, 100);
            this.pop(this.W / 2, this.H / 2 - 24, d.name, d.tint, 22, 100);
            return;
        }
        this.pop(this.W / 2, this.H / 2 - 50, "Wave " + this.wave, "#8be9ff", 30, 80);
        if (pr.rock != null) {
            // Asteroids are not enemies, so the wave would end the frame it
            // starts: `update` holds it open while any of them is still up.
            for (let i = 0; i < 4; i++) {
                this.spawnRock(undefined, undefined, undefined, pr.rock);
            }
            return;
        }
        for (let i = 0; i < PRACTICE_ENEMIES; i++) {
            this.pending.push(pr.type);
        }
        this.spawnT = 0;
        this.waveAge = 0;
        for (let i = 0; i < Math.min(this.pending.length, 3); i++) {
            this._releaseEnemy(-30 - i * 26);
        }
    }

    /** Pop one queued enemy onto the field. */
    _releaseEnemy(y) {
        const type = this.pending.shift();
        if (!type) {
            return;
        }
        const e = this.mkEnemy(type, 40 + Math.random() * (this.W - 80),
            y != null ? y : -30 - Math.random() * 20);
        // A practice run asked for one chassis, not for the random one.
        if (this.practice && this.practice.v != null && this.practice.type === type) {
            e.v = this.practice.v;
        }
        this.enemies.push(e);
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
            // The old ceiling (11 hulls, one every 10 frames) was reached around
            // wave 24 and never moved again, so from there on a wave only got
            // longer. It now keeps climbing; the room to breathe was moved
            // where it belongs, between waves (see `waveDelay`).
            const minAlive = Math.min(14, 3 + this.players + Math.floor(this.wave / 5));
            this.spawnT -= ts;
            if (this.spawnT <= 0 || alive < minAlive) {
                this._releaseEnemy();
                // Faster drip on later waves, and faster still if the field is
                // emptying out.
                this.spawnT = Math.max(7, 34 - this.wave) * (alive < minAlive ? 0.45 : 1);
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
        if (boss && alive < 3 + this.players && !this.practice) {
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

    /** @returns {Object} the rock, so a caller that aims one can set its drift. */
    spawnRock(x, y, r, v) {
        const rad = r || 16 + Math.random() * 24;
        const rk = {
            x: x != null ? x : 30 + Math.random() * (this.W - 60),
            y: y != null ? y : -40,
            vx: (Math.random() - 0.5) * 1.6,
            vy: 0.7 + Math.random() * 1.3,
            r: rad,
            rot: Math.random() * 6.2832,
            vr: (Math.random() - 0.5) * 0.06,
            hp: Math.max(1, Math.round(rad / 9)),
            v: v != null ? v : Math.floor(Math.random() * ROCK_SPRITES.length),
        };
        this.rocks.push(rk);
        return rk;
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

    /**
     * How much of the wave-1 capsule chance a fry kill is worth now: 1 at the
     * start of a run, easing down to `DROP_FALLOFF_MIN` by wave
     * `DROP_FALLOFF_WAVE` and flat after that. The kill rate roughly doubles
     * over the same span, so the product -- capsules a minute -- is what stays
     * put, and that is the thing the player actually reads.
     *
     * @returns {number} 0..1
     */
    _dropFalloff() {
        const k = Math.min(1, Math.max(0, ((this.wave || 1) - 1) / (DROP_FALLOFF_WAVE - 1)));
        return 1 - (1 - DROP_FALLOFF_MIN) * k;
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
        const boom = { k: "boom", x: e.x, y: e.y, c: e.c, b: big ? 1 : 0 };
        if (e.type === "drone") {
            // The hull comes apart instead of simply ceasing to exist. It
            // rides on the kill cue every enemy already sends rather than an
            // event of its own -- three small numbers, and drones die in
            // dozens. The husk wears whatever hull was left, which is the
            // bottom tier for anything ground down; the five frames of white
            // silhouette the wreck opens with cover the step on an overkill.
            boom.dr = [e.v || 0, droneTier(Math.max(1, Math.ceil(e.hp))), Math.round(e.t)];
            this._droneWreck(e.x, e.y, boom.dr);
        } else if (fryKit(e.type)) {
            // Same idea for the small ships, on the same kill cue: the chassis,
            // the wear it died wearing and the pose it died in. Everything else
            // the break-up is drawn from is a pure function of those and the
            // corpse's own age, so a guest that only ever receives the cue
            // draws the same wreck as the host.
            boom.fr = [
                FRY_KINDS.indexOf(e.type), e.v || 0,
                fryTier(Math.max(1, Math.ceil(e.hp)), e.mhp),
                this._fryStep(e),
            ];
            this._fryWreck(e.x, e.y, boom.fr);
        }
        this._ev(boom);
        if (killer && killer.dash > 0 && killer.flags.dash_refund) {
            // Kinetic Recharge: kills during the dash give the charge back.
            killer.dashCharges = Math.min(killer.dashMax, killer.dashCharges + 1);
        }
        // Hitstop: the frames where the impact reads as an impact instead of
        // the hull simply ceasing to exist. A bomb sweeping thirty hulls must
        // not stop the game thirty times, so it is skipped while bombing.
        if (!this.bombing) {
            const stop = colossal ? HITSTOP_COLOSSUS
                : big ? HITSTOP_BOSS
                    : e.mhp >= 3 ? HITSTOP_HEAVY : HITSTOP_CHAFF;
            this.hitstop = Math.max(this.hitstop, stop);
        }
        // Point blank pays. Killing something from across the arena is free;
        // killing it in your face is the risk the score is supposed to price,
        // and until now the combo only measured how fast you were clearing.
        let risk = 1;
        if (killer && !this.bombing) {
            const d = Math.hypot(e.x - killer.x, e.y - killer.y);
            risk = 1 + Math.max(0, 1 - d / 180) * 0.5;
        }
        // A bomb is a way out, not a scoring move: half points, and it does
        // not build the combo it would otherwise hand you for free.
        const pts = Math.round(
            e.val * this.combo * risk * (this.bombing ? 0.5 : 1)
            * (1 + (killer ? killer.mods.scoreMul : 0))
        );
        this.score += pts;
        this.pop(e.x, e.y, "+" + pts.toLocaleString(), risk > 1.15 ? "#ffd166" : "#fff", big ? 24 : 13);
        if (!this.bombing) {
            this.combo = Math.min(this.combo + 1, COMBO_MAX);
            this.comboT = 170;
        }
        this.shake = Math.min(this.shake + (big ? 22 : 5), 24);
        if (big) {
            this.sBigBoom();
            this.bossAlive = false;
            if (this.players === 1) {
                this.slowMo = colossal ? 70 : 40;
            }
            this.shake = 26;
            // Everything the wreck had in the air dies with it. Without this,
            // the slow motion that celebrates the kill was also the slowest,
            // least fair way to lose a life in the game.
            this.ebullets = [];
            this.beams = this.beams.filter((b) => b.src !== e.id);
            // The wave after a boss waits. The spawn logic is built so pressure
            // never drops inside a wave, which leaves the gaps between them as
            // the only place a run can breathe -- and a peak with no valley
            // after it stops reading as a peak at all.
            this.waveDelay = Math.max(this.waveDelay, 110);
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
            // Lucky Charm raises the drop rate of whoever landed the kill. It
            // multiplies rather than adds on top of the falloff, so the perk is
            // worth the same fraction of the flow at wave 30 as at wave 3.
            const chance = (DROP_CHANCE + (killer ? killer.mods.luck : 0)) * this._dropFalloff();
            if (this.pups.length < DROP_FIELD_CAP && Math.random() < chance) {
                this.dropPup(e.x, e.y);
            }
        }
    }

    bomb(killer) {
        this.flashT = 12;
        this.sBigBoom();
        this.shocks.push({ x: killer.x, y: killer.y, t: 0 });
        this._ev({ k: "bomb", x: Math.round(killer.x), y: Math.round(killer.y) });
        this.shake = 20;
        this.hitstop = Math.max(this.hitstop, 6);
        // `bombing` is read by `killEnemy`: everything caught in the blast is
        // paid at half price and builds no combo. Set it around the loop, not
        // inside it, because splashes and chains land in the same sweep.
        this.bombing = true;
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            const e = this.enemies[i];
            if (this._isBoss(e)) {
                this.burst(e.x, e.y, "#ffb347", 30, 6);
                this._damageEnemy(e, 14, killer);
            } else {
                this.killEnemy(e, killer);
            }
        }
        this.bombing = false;
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
        // Being touched at all forfeits the wave bonus and the grazes banked
        // towards the next combo step: they are paid for staying untouched.
        this.waveClean = false;
        sp.graze = 0;
        const invMul = 1 + sp.mods.inv;
        if (sp.shield > 0) {
            sp.shield = 0;
            this.burst(sp.x, sp.y, "#7bffb0", 26, 5);
            this.noise(0.25, 0.2, 2000);
            this._setInv(sp, 50 * invMul);
            this.hitstop = Math.max(this.hitstop, HITSTOP_CHAFF);
            this.pop(sp.x, sp.y - 30, "Shield down!", "#7bffb0", 14);
            return;
        }
        // Last Stand: cancels one lethal hit per wave.
        if (sp.lives <= 1 && sp.flags.last_stand && !sp.standT) {
            sp.standT = 1;
            this._setInv(sp, 160 * invMul);
            this.burst(sp.x, sp.y, "#ff8fb3", 40, 6);
            this.pop(sp.x, sp.y - 32, "LAST STAND!", "#ff8fb3", 17);
            this.sPup();
            return;
        }
        sp.lives--;
        this.deaths++;
        this.sHit();
        this._ev({ k: "hit", x: sp.x, y: sp.y, c: sp.color });
        this.shake = 18;
        this.hitstop = Math.max(this.hitstop, HITSTOP_HURT);
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
            this._setInv(sp, 190 * invMul);
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
                        deaths: this.deaths,
                    });
                }
            }
        } else {
            this._setInv(sp, 110 * invMul);
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
        this.shocks = [];
        this.wrecks = [];
        this.beams = [];
        this._bossAnims.clear();
        this._colossusAnims.clear();
        this.freezeT = 0;
        this.warpT = 0;
        this.shake = 0;
        this.slowMo = 0;
        this.hitstop = 0;
        this.bombing = false;
        this.deaths = 0;
        this.waveClean = true;
        this.flashT = 0;
        this.rockT = 180;
        this.bossAlive = false;
        this._events = [];
        // Perks are per run: a new game starts from a bare hull again.
        this.perkPhase = null;
        this.nextPerkWave = PERK_WAVES;
        this.perkUI.close();
        this.perkTimedOut = false;
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
            this._setInv(sp, 90);
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

        // Focus (Shift) is a held key, so the local slot reads it straight off
        // the keyboard every frame. A guest cannot: its input channel only
        // carries one-shot actions, so it sends the press and the release as
        // two edges (`focus1`/`focus0`) and the host holds the state for it.
        const local = this._shipBySlot(this.localSlot);
        if (local && this.role !== "guest") {
            local.focus = !!this.keys.shift && !local.down;
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
                // Losing the multiplier to the clock was the one loss in the
                // game with no cue at all: an x18 quietly became an x1 while
                // you watched the bullets. Small combos go without comment.
                if (this.combo >= 5) {
                    const me = this._shipBySlot(this.localSlot);
                    this.pop(me ? me.x : this.W / 2, (me ? me.y : this.H / 2) - 38,
                        "COMBO LOST", "#9aa6c4", 14, 55);
                    this.tone(520, 0.18, "square", 0.05, 160);
                }
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
                    // Intangible ships neither take the hit nor bank the graze:
                    // dashing through a curtain is already free, and paying it
                    // twice would make the safest move the best-scoring one.
                    if (sp.down || sp.inv > 0 || sp.dash > 0) {
                        continue;
                    }
                    const dx = b.x - sp.x;
                    const dy = b.y - sp.y;
                    const d2 = dx * dx + dy * dy;
                    const rr = this._hitR(sp);
                    if (d2 < rr * rr) {
                        done = true;
                        this.hurtShip(sp);
                        break;
                    }
                    // It went past, close. Counted once per bullet and per
                    // ship, which is what the `gz` bitmask on the bullet is.
                    const gr = rr + GRAZE_R;
                    const bit = 1 << (sp.slot & 7);
                    if (d2 < gr * gr && !((b.gz || 0) & bit)) {
                        b.gz = (b.gz || 0) | bit;
                        this._grazeTick(sp, b.x, b.y);
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
        // After the beams: the LANCER charge glow reads their `warn` frames.
        this._updateBossAnims(ts);
        this._updateColossusAnims(ts);
        this._updateTrails(ts);
        this._updateTurrets(ts);
        this._updateHoles(ts);
        this._updateDecoys(ts);
        this._updateFx(ts);

        // Practising asteroids is the one case where nothing on the field is
        // an enemy, so the wave has to stay open until they are cleared.
        const holdRocks = this.practice && this.practice.rock != null && this.rocks.length;
        if (this.enemies.length === 0 && this.pending.length === 0 && !holdRocks) {
            this.waveDelay -= ts;
            if (this.waveDelay <= 0) {
                if (this.wave >= this.nextPerkWave && !this.practice) {
                    // Every PERK_WAVES cleared waves, everyone upgrades.
                    this.nextPerkWave += PERK_WAVES;
                    this._openPerkPhase();
                } else {
                    this.spawnWave();
                    // Two thirds of a second of empty sky. It used to be 26
                    // frames, which is under half of that and reads as one
                    // continuous wave: the peaks need a floor to stand on.
                    this.waveDelay = 48;
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

    /** Start the dash cooldown, remembering how long it is: the HUD divides. */
    _armDashCd(sp) {
        sp.dashCdMax = this._dashCd(sp);
        sp.dashCd = sp.dashCdMax;
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
        if (sp.grazeT > 0) {
            sp.grazeT -= ts;
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
                if (sp.dashCharges < sp.dashMax) {
                    this._armDashCd(sp);
                } else {
                    sp.dashCd = 0;
                }
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
            k = Math.min(0.55, k);
            // Focus: the cursor still says where to go, the hull just stops
            // lunging at it. The clamp is applied first so a fast build gets
            // the same ratio of precision as a slow one.
            if (sp.focus) {
                k *= FOCUS_FACTOR;
            }
            sp.x += (sp.tx - sp.x) * k * ts;
            sp.y += (sp.ty - sp.y) * k * ts;
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
        sp.hudFx.observe(sp, ts);
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
            this._armDashCd(sp);
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
    _damageEnemy(e, dmg, killer, hx, hy) {
        // A hit with a position on it may have landed on a destructible part
        // rather than the hull. Everything with a real point of impact passes
        // one; area effects (a bomb, the EMP, a black hole) do not, and go to
        // the hull, which is the honest answer for something that engulfs the
        // whole silhouette.
        if (e.heads && hx != null) {
            const i = this._headAt(e, hx, hy, 4);
            if (i >= 0) {
                this._damageHead(e, i, dmg, killer);
                return false;
            }
        }
        if (e.fans && hx != null) {
            // VULCAN's shoulder fans sit inside the chest's box, so this is a
            // routing question and not a second hitbox: a hit that lands on one
            // feeds the heat cycle instead of the hull (see `_damageFan`).
            const i = this._fanAt(e, hx, hy, 4);
            if (i >= 0) {
                this._damageFan(e, i, dmg);
                return false;
            }
            // The vent window: while the slot is open, the white middle of it
            // counts double. This is the only damage multiplier in the game and
            // it is deliberately a *place* rather than a state -- the invitation
            // is worth nothing if it does not ask you to fly somewhere.
            if (this._ventOpen(e) && this._coreHit(e, hx, hy)) {
                dmg *= VULCAN.vent.coreMul;
            }
        }
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
            this._damageEnemy(e, dmg, sp, x, y);
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
            this._setInv(sp, 240);
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
        // The star field is the near layer of whatever place this is, so it
        // takes the place's own flow: on a descent world the backdrop rises and
        // a star field still falling past it is a contradiction you can see.
        // Every place but GAS GIANT DESCENT is +1, and reads exactly as before.
        const flow = this.bg ? bgFlow(this.bg.def) : 1;
        for (const s of this.stars) {
            s.y += flow * s.z * (1.2 + this.wave * 0.06) * ts;
            if (s.y > this.H + my) {
                s.y = -my;
                s.x = -mx + Math.random() * (this.W + mx * 2);
            } else if (s.y < -my) {
                s.y = this.H + my;
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
                    dn.bombs = Math.max(dn.bombs, 1);
                    this._setInv(dn, 120);
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

    /**
     * Enemy bullet. `k` is the entry in EB_KINDS: it decides the colour and
     * the size, so what the shot is doing is legible from across the arena
     * instead of every pattern in the game being the same red dot.
     */
    _eb(x, y, vx, vy, k) {
        this.ebullets.push({ x, y, vx, vy, k: k || EB_SPREAD, gz: 0 });
    }

    /** Aimed shot from an arbitrary point of the hull. */
    _ebAimed(x, y, speed, spread, k) {
        const tgt = this.decoys.length ? this._target(x, y) : this._aimShip();
        if (!tgt) {
            return;
        }
        const dx = tgt.x - x;
        const dy = tgt.y - y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const a = Math.atan2(dy, dx) + (spread || 0);
        this._eb(x, y, Math.cos(a) * speed, Math.sin(a) * speed, k != null ? k : EB_AIMED);
    }

    /**
     * Pattern timer on an enemy. Returns true on the single frame the pattern
     * fires, and `first` seeds the countdown (the old offsets).
     *
     * It replaces `Math.floor(e.t) % n === 0`, which fired two or three frames
     * in a row whenever `e.t` advanced by less than 1 per frame -- exactly what
     * slow motion (0.35) and Time Warp (0.4) do. The burst therefore tripled
     * right after a hit, when the player could least afford it.
     */
    _every(e, key, period, mv, first) {
        if (e[key] == null) {
            e[key] = first != null ? first : period;
        }
        e[key] -= mv;
        if (e[key] <= 0) {
            e[key] = period;
            return true;
        }
        return false;
    }

    /**
     * Turn the frames left on a pattern timer into a telegraph: `tel` (0..1)
     * and `telK` (which warning to draw) on the enemy. The strongest warning
     * wins, so a boss running three timers still shows one clear cue.
     *
     * Every branch calls this with the timer it is about to spend, before
     * `_every` consumes it, which is what makes the ramp reach 1 on the frame
     * the pattern actually goes off.
     */
    _tel(e, left, kind) {
        if (left == null || left <= 0 || left > TELEGRAPH_FRAMES) {
            return;
        }
        const v = 1 - left / TELEGRAPH_FRAMES;
        if (v > (e.tel || 0)) {
            e.tel = v;
            e.telK = kind;
        }
    }

    /**
     * Second phase of a boss, on a health threshold instead of a stopwatch.
     * The transition is a beat of its own: the hull holds fire, the screen
     * flashes and the cadence comes back faster. Without the pause the change
     * is invisible in the middle of a firefight, which is why the colossi had
     * been switching at 45% for five patterns with nothing but a bar turning
     * red to say so.
     *
     * @returns {boolean} whether the second phase is running
     */
    _bossRage(e, mv, at) {
        if (!e.raged && e.mhp && e.hp <= e.mhp * (at || BOSS_RAGE_AT)) {
            e.raged = 1;
            e.hold = 50;
            this.flashT = Math.max(this.flashT, 7);
            this.shake = Math.min(this.shake + 14, 24);
            this.burst(e.x, e.y, e.c, 40, 6);
            this.pop(e.x, e.y - (e.hh || e.r) - 22, "ENRAGED", "#ff6b6b", 20, 90);
            this.sBigBoom();
            // One event, not a `bfx` cue: `BossAnimator.emit` has no pose for a
            // phase change, and the bus is already the thing that makes co-op
            // feel bad -- there is no point spending bytes nobody reads.
            this._ev({ k: "rage", x: Math.round(e.x), y: Math.round(e.y), c: e.c });
        }
        if (e.hold > 0) {
            e.hold -= mv;
        }
        return !!e.raged;
    }

    /** The angle `_ebAimed` fires at, reused by the muzzle flash cosmetics. */
    _aimAngle(x, y) {
        const tgt = this.decoys.length ? this._target(x, y) : this._aimShip();
        return tgt ? Math.atan2(tgt.y - y, tgt.x - x) : Math.PI / 2;
    }

    /**
     * Beams: telegraphed first (`warn` frames of a thin sight line), then live.
     * `src` anchors them to a hull so they follow it, `spin` sweeps them.
     */
    mkBeam(o) {
        return Object.assign(
            { x: 0, y: 0, ox: 0, oy: 0, a: Math.PI / 2, len: 1200, w: 26, warn: 60, life: 120, spin: 0, src: 0, hot: 0, c: "#ff4d4d" },
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
                if (this._distToSeg(sp.x, sp.y, b.x, b.y, ex, ey) < b.w * 0.5 + this._hitR(sp)) {
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
        // Last frame's telegraph. `tel` is cleared below before the new one is
        // computed and `telK` is only ever raised, never cleared, so this is the
        // only place both are still true together.
        const telK = e.tel > 0 ? e.telK : "";
        if (e.k === 0) {
            // AEGIS-01 flies its own motion profile (see `aegis_motion.js`):
            // weighted reversals, a capped pull toward the ships, a brace on the
            // curtain telegraph and one shove during the enrage beat. It is
            // created here, after the entrance, so it starts from where the
            // entrance left the hull.
            if (!e.mo) {
                e.mo = new AegisMotion(e.x, e.y);
            }
            const p = e.mo.step(mv * FRAME_SECONDS, {
                x: e.x, y: e.y,
                fx0: this.fx0, fx1: this.fx1,
                hp01: e.mhp ? e.hp / e.mhp : 1,
                raged: !!e.raged,
                holding: e.hold > 0,
                telK,
                // Downed ships are left out: the slab presses whoever is still
                // flying, not the wreck of someone waiting for a revive.
                ships: this.ships.filter((sp) => !sp.down),
            });
            e.x = p.x;
            e.y = p.y;
        } else if (e.k === 2) {
            // VULCAN walks its lane (see `vulcan_motion.js`): acceleration
            // limited travel with a settle, and feet that plant for the phases
            // the sheet plants them for. Created here, after the entrance, so
            // it starts from where the entrance left the hull.
            if (!e.mo) {
                e.mo = new VulcanMotion(e.x, e.y);
            }
            const p = e.mo.step(mv * FRAME_SECONDS, {
                x: e.x,
                fx0: this.fx0, fx1: this.fx1,
                hp01: e.mhp ? e.hp / e.mhp : 1,
                raged: !!e.raged,
                planted: e.ph === V_OVERHEAT || e.ph === V_VENT || e.ph === V_ROCK_WARN,
            });
            e.x = p.x;
            e.y = p.y;
        } else {
            e.x += e.vx * mv * 0.55;
            if (e.x > W / 2 + 105) {
                e.vx = -Math.abs(e.vx);
            } else if (e.x < W / 2 - 105) {
                e.vx = Math.abs(e.vx);
            }
        }
        const wasRaged = e.raged;
        const rage = this._bossRage(e, mv, COLOSSUS_RAGE_AT);
        if (!wasRaged && e.raged) {
            this._colossusCue(e, "rage");
        }
        e.tel = 0;
        if (e.hold > 0) {
            // The phase change is its own beat: the hull keeps drifting, the
            // guns stop, and the timers below are not spent.
            return;
        }
        e.a1 -= mv;
        e.a2 -= mv;
        e.a3 -= mv;
        const bottom = e.y + e.hh;
        if (e.k === 0) {
            // AEGIS-01: curtain of fire with one gap + twin siege salvos.
            this._tel(e, e.a1, "curtain");
            this._tel(e, e.a2, "aimed");
            if (e.a1 <= 0) {
                e.a1 = rage ? 62 : 95;
                for (let x = this.fx0 + 10; x < this.fx1; x += 34) {
                    if (Math.abs(x - e.gap) < 62) {
                        continue;
                    }
                    this._eb(x, bottom, 0, 2.4, EB_CURTAIN);
                }
                this.sTick();
                this._colossusCue(e, "curtain");
                // The next gap is decided here, one curtain ahead, so the
                // telegraph can point at it. A wall of bullets you can only
                // read once it is on top of you is not a pattern, it is a die
                // roll: where the hole is *is* the whole attack.
                e.gap = this.fx0 + 60 + ((e.gap + 137) % (this.fx1 - this.fx0 - 120));
            }
            if (e.a2 <= 0) {
                e.a2 = 190;
                // 0.163 of the hull is where the two siege nozzles of
                // `colossus0` actually are (15 cells either side of the centre
                // line). `colossus_animator.js` finds them in the art and
                // flashes them, so the light is on the barrel the bullets leave
                // from instead of 49 px inboard of it.
                for (const off of [-e.w * 0.163, e.w * 0.163]) {
                    for (let s = -1; s <= 1; s++) {
                        this._ebAimed(e.x + off, bottom, 5, s * 0.12);
                    }
                }
                this.sTick();
                this._colossusCue(e, "salvo");
            }
        } else if (e.k === 1) {
            this._hydra(e, mv, rage);
        } else if (e.k === 2) {
            this._vulcan(e, mv, rage);
        } else if (e.k === 3) {
            // NYX: four beams turning like clock hands + interceptors.
            this._tel(e, e.a2, "spawn");
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
            this._tel(e, e.a2, "spawn");
            this._tel(e, e.a3, "ring");
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
                    this._eb(e.x, e.y, Math.cos(a) * 3, Math.sin(a) * 3, EB_SPREAD);
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
    /**
     * Tick the boss animations.
     *
     * Render-only, so it runs the same on host, solo and guest: everything it
     * reads either travels in the snapshot (position, hp, armour, beams) or is
     * derived from observed motion. It lives in the simulation rather than the
     * draw, so a paused game freezes the pose along with everything else.
     */
    _updateBossAnims(ts) {
        if (!this._bossAnims.size && !this.enemies.some((e) => e.type === "boss")) {
            return;
        }
        const dt = ts * FRAME_SECONDS;
        const alive = new Set();
        for (const e of this.enemies) {
            if (e.type !== "boss") {
                continue;
            }
            const k = e.k || 0;
            alive.add(k);
            let anim = this._bossAnims.get(k);
            if (!anim) {
                anim = new BossAnimator(k, e.c);
                this._bossAnims.set(k, anim);
            }
            // LANCER: the telegraph is the engine's own beam. A guest loses the
            // `src` id in the snapshot but still gets the beam's origin and warn
            // frames, so proximity is what both sides can agree on.
            let charging = false;
            if (k === 2) {
                for (const b of this.beams) {
                    if (b.warn > 0 && Math.abs(b.x - e.x) < e.r * 2
                            && Math.abs(b.y - e.y) < e.r * 3) {
                        charging = true;
                        break;
                    }
                }
            }
            anim.observe(dt, {
                x: e.x,
                y: e.y,
                hp01: e.mhp ? e.hp / e.mhp : 1,
                armor: !!e.armor,
                charging,
            });
        }
        // Forget a boss that is gone, so the next one of the same kind starts
        // clean instead of inheriting a half-finished blink.
        for (const k of Array.from(this._bossAnims.keys())) {
            if (!alive.has(k)) {
                this._bossAnims.delete(k);
            }
        }
    }

    /**
     * HYDRA-07. Three creatures on one chest, and the fight is the argument
     * between the two things they do:
     *
     *  - the **crown** spits a spiral: a static pattern that fills the arena
     *    and asks you to plan a route through it;
     *  - the **side heads** spray aimed fans: they punish standing still and
     *    ask for a reflex.
     *
     * Under the rage threshold the two take turns with a breath between them,
     * so each one can be read on its own. Over it they run at the same time --
     * a spiral floor with fans landing on top -- which is the whole second
     * phase and needs no new pattern to be one.
     *
     * The crown turns whether or not it is emitting, and flips direction at the
     * start of each wind-up: that is what SPIRAL_CHARGE actually telegraphs,
     * and the ring of light around the crown is how you read it.
     */
    _hydra(e, mv, rage) {
        const S = HYDRA_SPIRAL;
        const F = HYDRA_FAN;
        this._hydraHeads(e, mv);
        // The crown never stops turning, so the direction is always readable.
        e.sa = (e.sa + S.rate * e.spin * mv) % 6.2832;
        const dead = e.heads.reduce((n, h) => n + (h.hp <= 0 ? 1 : 0), 0);
        if (rage) {
            // Second phase: the director is gone, both attacks run at once.
            e.spiral = 1;
            this._tel(e, e.a2, "aimed");
            if (e.a2 <= 0) {
                e.a2 = F.ragedEvery;
                this._hydraFan(e);
            }
        } else {
            this._hydraDirector(e, mv);
        }
        if (e.spiral && e.a1 <= 0) {
            // The trade: every head that is gone tightens the spiral.
            e.a1 = Math.max(3, (rage ? S.ragedEvery : S.every) - dead * S.deadStep);
            const arms = rage ? S.ragedArms : S.arms;
            const p = e.parts.crown;
            for (let k = 0; k < arms; k++) {
                const a = e.sa + (k / arms) * 6.2832;
                this._eb(
                    e.x + p.x * e.w, e.y + p.y * e.h,
                    Math.cos(a) * 2.7, Math.sin(a) * 2.7, EB_SPREAD
                );
            }
        }
    }

    /**
     * The first phase, one attack at a time. `ph` is the beat and `pt` counts
     * it down; neither travels, because a guest reads the telegraph (which
     * does) and the bullets, never the clock behind them.
     */
    _hydraDirector(e, mv) {
        const S = HYDRA_SPIRAL;
        const F = HYDRA_FAN;
        e.pt -= mv;
        switch (e.ph) {
            case 1:
                // SPIRAL_CHARGE. The crown already turned the new way when this
                // beat opened, so the warning says *which way* and not merely
                // "something is coming".
                this._tel(e, e.pt, "spiral");
                if (e.pt <= 0) {
                    e.ph = 2;
                    e.pt = S.burst;
                    e.spiral = 1;
                }
                break;
            case 2:
                if (e.pt <= 0) {
                    e.ph = 3;
                    e.pt = HYDRA_REST;
                    e.spiral = 0;
                }
                break;
            case 4:
                this._tel(e, e.pt, "aimed");
                if (e.pt <= 0) {
                    e.ph = 5;
                    e.pt = F.stagger;
                    this._hydraFan(e, e.fq[0]);
                }
                break;
            case 5:
                // The second head, a beat later, so the two cones can be read
                // one at a time instead of arriving as one wall.
                if (e.pt <= 0) {
                    e.ph = 0;
                    e.pt = HYDRA_REST;
                    if (e.fq.length > 1) {
                        this._hydraFan(e, e.fq[1]);
                    }
                }
                break;
            default:
                // Resting: 0 is the breath before the crown, 3 the one before
                // the heads. With both heads down there is no fan left to take
                // a turn, so the crown simply keeps the arena to itself.
                if (e.pt > 0) {
                    break;
                }
                e.fq = [];
                for (let i = 0; i < e.heads.length; i++) {
                    if (e.heads[i].hp > 0) {
                        e.fq.push(i);
                    }
                }
                if (e.ph === 3 && e.fq.length) {
                    e.ph = 4;
                    e.pt = F.warn;
                } else {
                    // Into the crown, and the direction it will turn is decided
                    // here so the wind-up has something to say.
                    e.ph = 1;
                    e.pt = S.warn;
                    e.spin = -e.spin;
                }
        }
    }

    /**
     * One fan, or both. Each leaves from the glass in its own head (`parts`,
     * read out of the art) and cues that mouth, so the flash is on the barrel
     * the bullets came from. A destroyed head has no fan -- that is what
     * killing it bought.
     */
    _hydraFan(e, only) {
        let fired = false;
        for (let i = 0; i < e.heads.length; i++) {
            if (e.heads[i].hp <= 0 || (only != null && only !== i)) {
                continue;
            }
            const b = e.parts.heads[i];
            for (let s = -2; s <= 2; s++) {
                this._ebAimed(e.x + b.mx * e.w, e.y + b.my * e.h, 3.6, s * 0.16);
            }
            fired = true;
            // The mouth flash has to be a cue: a fan lasts one frame, and the
            // snapshot a guest would have to spot it in arrives up to four
            // frames later, by which time its bullets are 14 px out.
            this._colossusCue(e, i === 0 ? "fanL" : "fanR");
        }
        if (fired) {
            this.sTick();
        }
    }

    /** Destroyed side heads counting down to their rebuild. */
    _hydraHeads(e, mv) {
        for (const h of e.heads) {
            if (h.hp > 0) {
                continue;
            }
            h.t -= mv;
            if (h.t <= 0) {
                h.hp = h.mhp;
                h.t = 0;
            }
        }
    }

    /**
     * VULCAN's heat cycle: one director instead of three timers.
     *
     * `heat` is the clock and `ph`/`pt` the phase it is spending, and the whole
     * fight is the loop in the VULCAN block above. Two things make it a fight
     * rather than a sequence:
     *
     *   - a hit on a shoulder fan adds heat, so the player decides *when* the
     *     overheat comes -- and the overheat cuts the beams off mid-sweep, so
     *     the lever is defensive as well as an invitation;
     *   - the vent that follows opens the core (double damage inside it) while
     *     the rings leave from the shoulders, which means the safe pocket and
     *     the reward are the same piece of the arena.
     *
     * `heat` and `ph` travel (`ht`, `vp`): the whole visual language of the hull
     * is read off them, and neither can be derived from a position. `pt` does
     * not -- a guest reads the telegraph, which does.
     */
    _vulcan(e, mv, rage) {
        this._vulcanFans(e, mv);
        const len = rage ? VULCAN.raged : VULCAN.len;
        // Heat first, so a fan hit landing this frame can still end the beam.
        let d = VULCAN.heat[e.ph];
        if (d > 0 && rage) {
            d *= VULCAN.ragedHeat;
        }
        e.heat = Math.max(0, Math.min(1, e.heat + d * mv));
        e.pt -= mv;
        switch (e.ph) {
            case V_BEAM_WARN:
                // The beams telegraph themselves: `mkBeam`'s `warn` draws the
                // sight line the sheet calls innegociable, and it is the same
                // 60 frames as this phase, so the two cannot drift apart.
                if (e.pt <= 0) {
                    this._vulcanPhase(e, V_BEAM, len);
                }
                break;
            case V_BEAM:
                // Heat ends it, not the clock. `len` is only a ceiling, for the
                // case where every fan is jammed and nothing is feeding it.
                if (e.heat >= 1 || e.pt <= 0) {
                    this._vulcanPhase(e, V_OVERHEAT, len);
                }
                break;
            case V_OVERHEAT:
                // The 40 frames of "something is about to burst" *are* the
                // warning for the rings, and the existing ring telegraph -- a
                // circle closing onto the hull -- is already the right picture
                // for two vents about to blow outwards.
                this._tel(e, e.pt, "ring");
                if (e.pt <= 0) {
                    this._vulcanPhase(e, V_VENT, len);
                }
                break;
            case V_VENT:
                // Two waves of rings a beat apart, for the same reason HYDRA's
                // two fans are staggered: one wall of bullets cannot be read.
                if (e.vw < VULCAN.ring.waves
                        && e.pt <= e.ptMax - e.vw * VULCAN.ring.gap) {
                    this._vulcanRing(e, e.vw);
                    e.vw++;
                }
                if (e.pt <= 0) {
                    this._vulcanPhase(e, V_ROCK_WARN, len);
                }
                break;
            case V_ROCK_WARN:
                // The one telegraph that carries a *number*: how many pips are
                // lit is how many rocks are coming (see `_drawTelegraph`).
                this._tel(e, e.pt, "volley");
                if (e.pt <= 0) {
                    this._vulcanPhase(e, V_ROCKS, len);
                }
                break;
            case V_ROCKS:
                if (e.pt <= 0) {
                    this._vulcanPhase(e, V_REST, len);
                }
                break;
            default:
                if (e.pt <= 0) {
                    this._vulcanPhase(e, V_BEAM_WARN, len);
                }
        }
    }

    /**
     * Enter a phase, and do the one-shot it opens with. Every transition goes
     * through here so the phase, its clock and the thing it fires cannot end up
     * describing different beats.
     */
    _vulcanPhase(e, ph, len) {
        e.ph = ph;
        e.pt = len[ph];
        e.ptMax = e.pt;
        if (ph === V_BEAM_WARN) {
            this._vulcanBeams(e, !!e.raged, len[V_BEAM_WARN], len[V_BEAM]);
        } else if (ph === V_OVERHEAT) {
            // The forge fails: the beams cut out where they are. This is what
            // the fans buy, and it is why hitting them is worth the trip.
            for (let i = this.beams.length - 1; i >= 0; i--) {
                if (this.beams[i].src === e.id) {
                    this.beams.splice(i, 1);
                }
            }
            this.noise(0.4, 0.5, 900);
        } else if (ph === V_VENT) {
            // Fewer working fans, less exhaust, shorter window -- the whole
            // cost of having broken one.
            const jammed = e.fans.reduce((n, f) => n + (f.hp <= 0 ? 1 : 0), 0);
            const total = Math.max(1, e.fans.length);
            e.pt = Math.round(e.pt * (1 - VULCAN_FAN.ventShare * (jammed / total)));
            e.ptMax = e.pt;
            e.vw = 0;
            this.sBoom();
        } else if (ph === V_ROCK_WARN) {
            const span = e.raged ? VULCAN.ragedVolley : VULCAN.volley;
            e.vn = span[0] + Math.floor(Math.random() * (span[1] - span[0] + 1));
        } else if (ph === V_ROCKS) {
            this._vulcanVolley(e);
        }
    }

    /**
     * The two forge beams, from the hand at the end of each side arm.
     *
     * `parts.arms` is read out of the art, so the light `colossus_animator.js`
     * puts on each hand is on the muzzle the beam actually leaves from -- the
     * same correction the AEGIS salvo got, and at +/-0.482 of the width the arms
     * put it where the silhouette really ends, further out than the constant
     * that was there before. The two patterns stay: scissors
     * start crossed and sweep through each other, sweep rakes the arena one way
     * like a wiper, and alternating them is what keeps the fight asking a
     * different question every cycle.
     */
    _vulcanBeams(e, rage, warn, life) {
        e.pat = (e.pat || 0) ^ 1;
        const spin = rage ? VULCAN.beam.ragedSpin : VULCAN.beam.spin;
        const arms = e.parts && e.parts.arms;
        for (const side of [-1, 1]) {
            const f = arms && arms[side < 0 ? 0 : 1];
            this.beams.push(this.mkBeam({
                src: e.id,
                ox: f ? f.x * e.w : side * e.w * 0.4,
                oy: f ? f.y * e.h : e.h * 0.25,
                a: e.pat ? Math.PI / 2 + side * 0.95 : Math.PI / 2 - 0.85,
                warn,
                // Forge beam: `_drawBeams` gives it the layered profile from the
                // design sheet instead of the plain two-stroke one.
                hot: 1,
                // Outlived by the phase on purpose: the overheat is what ends a
                // sweep, and `life` is only there so a beam cannot survive its
                // owner's cycle if anything ever cuts the phase short.
                life: life + VULCAN.beam.life,
                w: VULCAN.beam.w,
                spin: e.pat ? -side * spin : spin,
                c: "#ffb347",
            }));
        }
    }

    /**
     * One wave of molten rings: a burst out of every live fan, thrown down and
     * outwards. A jammed fan has no ring -- that is the one thing breaking it
     * wins you.
     */
    _vulcanRing(e, wave) {
        const R = VULCAN.ring;
        let fired = false;
        for (let i = 0; i < e.fans.length; i++) {
            if (e.fans[i].hp <= 0) {
                continue;
            }
            const b = e.parts.fans[i];
            const x = e.x + b.x * e.w;
            const y = e.y + b.y * e.h;
            for (let n = 0; n < R.n; n++) {
                const a = Math.PI / 2 + (n / (R.n - 1) - 0.5) * R.arc + wave * R.spin;
                this._eb(x, y, Math.cos(a) * R.speed, Math.sin(a) * R.speed, EB_SPREAD);
            }
            fired = true;
        }
        // Both shoulders together, and the two *waves* a beat apart instead:
        // unlike HYDRA's two aimed cones these are one symmetric pattern whose
        // whole content is the pocket they leave in the middle, and staggering
        // them would blur the very shape the player is reading.
        if (fired) {
            this.shake = Math.min(this.shake + 6, 24);
            this._colossusCue(e, "vent");
            return;
        }
        const core = e.parts && e.parts.core;
        const x = e.x + (core ? core.x * e.w : 0);
        const y = e.y + (core ? core.y * e.h : 0);
        for (let n = 0; n < R.backN; n++) {
            const a = (n / R.backN) * 6.2832 + wave * R.spin;
            this._eb(x, y, Math.cos(a) * R.backSpeed, Math.sin(a) * R.backSpeed, EB_SPREAD);
        }
        this.shake = Math.min(this.shake + 8, 24);
        this._colossusCue(e, "backfire");
    }

    /**
     * The volley: `vn` rocks out of the open slot, fanned out. They are the
     * engine's own asteroids, so they keep bouncing off the field walls and
     * sitting in the arena afterwards -- the sheet's "ocupan territorio y
     * persisten como escombro" for free.
     */
    _vulcanVolley(e) {
        const R = VULCAN.rock;
        const core = e.parts && e.parts.core;
        const x = e.x + (core ? core.x * e.w : 0);
        const y = e.y + (core ? core.y * e.h : 0);
        const n = Math.max(1, e.vn);
        for (let i = 0; i < n; i++) {
            // Down and outwards, never lobbed: the engine's asteroids carry no
            // gravity (`_updateRocks` moves them at a constant velocity and only
            // culls them below the field), so anything thrown upwards would
            // climb out of the arena and stay in the list for the whole run.
            // Fanned like this the outer rocks rake sideways and bounce off the
            // field walls, which is the "ocupan territorio" the sheet wants.
            const a = Math.PI / 2 + (i - (n - 1) / 2) * R.spread
                + (Math.random() - 0.5) * R.jitter;
            const sp = R.speed * (0.85 + Math.random() * 0.3);
            const rk = this.spawnRock(x, y, R.r[0] + Math.random() * (R.r[1] - R.r[0]));
            // Thrown, not dropped: `spawnRock` rolls a drift, this aims it.
            rk.vx = Math.cos(a) * sp * 1.9;
            rk.vy = Math.sin(a) * sp;
        }
        this.shake = Math.min(this.shake + 9, 24);
        this.sBoom();
        this._colossusCue(e, "spit");
    }

    /**
     * The shoulder fans between hits: a jammed one counting down to clearing
     * itself, a working one slowly repairing.
     *
     * The repair is what makes the fans a lever the player keeps rather than a
     * budget of seven hits: without it, a fight past the first minute has no
     * way left to hurry the cycle at all.
     */
    _vulcanFans(e, mv) {
        for (const f of e.fans) {
            if (f.hp <= 0) {
                f.t -= mv;
                if (f.t <= 0) {
                    f.hp = f.mhp;
                    f.t = 0;
                }
                continue;
            }
            if (f.hp < f.mhp) {
                f.hp = Math.min(f.mhp, f.hp + f.mhp * VULCAN_FAN.repair * mv);
            }
        }
    }

    /**
     * Which live shoulder fan a point falls on, or -1. Unlike HYDRA's heads the
     * fans sit *inside* the chest's own box, so this is only ever a routing
     * question in `_damageEnemy` -- `_enemyHit` already covers them.
     */
    _fanAt(e, x, y, pad) {
        if (!e.fans || !e.parts || !e.parts.fans) {
            return -1;
        }
        for (let i = 0; i < e.fans.length; i++) {
            if (e.fans[i].hp <= 0) {
                continue;
            }
            const b = e.parts.fans[i];
            if (Math.abs(x - (e.x + b.x * e.w)) < b.hw * e.w + pad
                    && Math.abs(y - (e.y + b.y * e.h)) < b.hh * e.h + pad) {
                return i;
            }
        }
        return -1;
    }

    /**
     * A shoulder fan taking a hit: the lever, and its overshoot penalty.
     *
     * Fan damage does not come off the hull, for the same reason head damage
     * does not: what it buys has to be something you chose to fly out and spend
     * fire on. What it buys is heat -- and heat is time off the beam phase and
     * the next window at the core. Breaking one is the mistake: it stops taking
     * heat at all and it shortens the very window you were buying, so it pays
     * no score and says so.
     */
    _damageFan(e, i, dmg) {
        const f = e.fans[i];
        if (f.hp <= 0) {
            return;
        }
        f.hp -= dmg;
        const b = e.parts.fans[i];
        const fx = e.x + b.x * e.w;
        const fy = e.y + b.y * e.h;
        // Whatever landed on the fan buys its share of the gauge, including the
        // part of the last hit that overshot: the trade has to be the same
        // whether you finish a fan or stop one point short of it.
        e.heat = Math.min(1, (e.heat || 0)
            + (Math.min(dmg, f.hp + dmg) / f.mhp) * VULCAN_FAN.heatFull);
        if (f.hp > 0) {
            this.burst(fx, fy, "#ffffff", 8, 3);
            return;
        }
        f.hp = 0;
        f.t = VULCAN_FAN.jam;
        this.burst(fx, fy, e.c, 34, 5);
        this.burst(fx, fy, "#6b7099", 14, 3.5);
        this.shake = Math.min(this.shake + 8, 24);
        this.sBoom();
        this.pop(fx, fy - 26, "VENT JAMMED", "#6b7099", 16, 80);
        this._ev({ k: "boom", x: fx, y: fy, c: e.c, b: 1 });
    }

    /** Is VULCAN's slot open, i.e. is the double-damage window up? */
    _ventOpen(e) {
        return e.k === 2 && e.ph === V_VENT && !e.hold;
    }

    /**
     * Did a hit land in the white middle of VULCAN's slot? Same box the animator
     * grows white while it vents, out of the same `hullParts` answer, so what is
     * worth double is exactly what the hull shows is open.
     */
    _coreHit(e, x, y) {
        const b = e.parts && e.parts.core;
        if (!b) {
            return false;
        }
        return Math.abs(x - (e.x + b.x * e.w)) < b.hw * e.w
            && Math.abs(y - (e.y + b.y * e.h)) < b.hh * e.h;
    }

    /**
     * Same as `_updateBossAnims` for the colossi. Only the indexes with a
     * section in `COLOSSUS_ANIM_KINDS` get one, so adding the animation of the
     * next colossus is one entry there plus its tuning block.
     */
    _updateColossusAnims(ts) {
        if (!this._colossusAnims.size && !this.enemies.some((e) => e.type === "colossus")) {
            return;
        }
        const dt = ts * FRAME_SECONDS;
        const alive = new Set();
        for (const e of this.enemies) {
            const k = e.k || 0;
            if (e.type !== "colossus" || k >= COLOSSUS_ANIM_KINDS.length) {
                continue;
            }
            alive.add(k);
            let anim = this._colossusAnims.get(k);
            if (!anim) {
                anim = new ColossusAnimator(k, e.c);
                this._colossusAnims.set(k, anim);
            }
            const hp01 = e.mhp ? e.hp / e.mhp : 1;
            // The second phase, derived rather than read: `e.raged` never
            // travels, but `hp`/`mhp` do, so both roles cross the threshold on
            // the same frame off the same numbers the AI uses.
            const raged = hp01 <= COLOSSUS_RAGE_AT;
            anim.observe(dt, {
                x: e.x,
                y: e.y,
                hp01,
                // HYDRA-07 only. The crown's own angle and whether it is
                // emitting, so the ring of light sits on the sector the bullets
                // are leaving from and goes dark when they stop; and the state
                // of the two side heads, from which the animator gets the local
                // hit flash, the dead head and the rebuild without a cue for
                // any of them. All of it travels (`sa`, `sp`, `hd`).
                spinA: e.sa || 0,
                spiral: !!e.spiral,
                arms: raged ? HYDRA_SPIRAL.ragedArms : HYDRA_SPIRAL.arms,
                heads: e.heads,
                headRegrow: HYDRA_HEAD.regrow,
                // VULCAN only. The heat and the phase are the whole language of
                // the hull -- the slot is a gauge, the chimneys smoke harder,
                // the feet plant -- and the fans give the animator the hit
                // flash, the seized fan and the clearing off one number each,
                // exactly as HYDRA's heads do. All of it travels (`ht`, `vp`,
                // `vn`, `vf`).
                heat: e.heat,
                phase: e.heat != null ? e.ph : null,
                volley: e.vn || 0,
                fans: e.fans,
                fanJam: VULCAN_FAN.jam,
                raged,
                tel: e.tel || 0,
                // `telK` outlives the telegraph that set it (see _updateColossus).
                telK: e.tel > 0 ? e.telK : "",
                gapX: e.gap,
                // Centre of mass of whoever is still flying, so the hull can
                // tip towards them. Same ships `_updateColossus` presses, and a
                // guest has them from the snapshot: no new bytes on the bus.
                aimX: this._liveCentroidX(),
            });
        }
        for (const k of Array.from(this._colossusAnims.keys())) {
            if (!alive.has(k)) {
                this._colossusAnims.delete(k);
            }
        }
    }

    /**
     * X of the centre of mass of the ships still flying, or null when they are
     * all down. Downed ships are left out for the same reason the colossus
     * motion leaves them out: the slab presses whoever can still dodge.
     */
    _liveCentroidX() {
        let sum = 0;
        let n = 0;
        for (const sp of this.ships) {
            if (!sp.down) {
                sum += sp.x;
                n++;
            }
        }
        return n ? sum / n : null;
    }

    /** Cosmetic cue for a colossus, mirrored to the guests over `ev`. */
    _colossusCue(e, name) {
        const k = e.k || 0;
        if (k >= COLOSSUS_ANIM_KINDS.length) {
            return;
        }
        const anim = this._colossusAnims.get(k);
        if (anim) {
            anim.emit(name);
        }
        this._ev({ k: "cfx", ck: k, n: name });
    }

    /** Cosmetic cue for a boss, mirrored to the guests over the `ev` channel. */
    _bossCue(e, name, data) {
        const anim = this._bossAnims.get(e.k || 0);
        if (anim) {
            anim.emit(name, data);
        }
        this._ev(Object.assign({ k: "bfx", bk: e.k || 0, n: name }, data || {}));
    }

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
        e.tel = 0;
        const rage = this._bossRage(e, mv);
        if (e.hold > 0) {
            return;
        }
        const arms = rage ? 12 : 9;
        this._tel(e, e.a1, "ring");
        this._tel(e, e.a2, "aimed");
        if (this._every(e, "a1", rage ? 62 : 85, mv)) {
            for (let k = 0; k < arms; k++) {
                const a = (k / arms) * 6.2832 + e.t * 0.01;
                this._eb(e.x, e.y, Math.cos(a) * 2.3, Math.sin(a) * 2.3, EB_SPREAD);
            }
            this.sTick();
            this._bossCue(e, "burst");
        }
        if (this._every(e, "a2", rage ? 40 : 55, mv, 27)) {
            for (let k = -1; k <= 1; k++) {
                this._ebAimed(e.x, e.y, 3, k * 0.22);
            }
            this.sTick();
            this._bossCue(e, "salvo", { a: Math.round(this._aimAngle(e.x, e.y) * 100) / 100 });
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
        e.tel = 0;
        // Second phase: the armour spends less time up and more time down, and
        // both patterns speed up. The fight is about the hurt window, so that
        // is the dial the phase change turns.
        const rage = this._bossRage(e, mv);
        e.phase -= mv;
        if (e.phase <= 0) {
            e.armor = e.armor ? 0 : 1;
            e.phase = e.armor ? (rage ? 240 : 330) : (rage ? 300 : 260);
            this.burst(e.x, e.y, e.armor ? "#4de3c1" : "#ffd166", 20, 4);
            this.pop(e.x, e.y - e.r - 16, e.armor ? "ARMOUR UP" : "ARMOUR DOWN",
                e.armor ? "#4de3c1" : "#ffd166", 13);
        }
        if (e.hold > 0) {
            return;
        }
        if (e.armor) {
            this._tel(e, e.a1, "curtain");
            if (this._every(e, "a1", rage ? 82 : 105, mv)) {
                for (let x = this.fx0 + 12; x < this.fx1; x += 40) {
                    if (Math.abs(x - e.gap) < 66) {
                        continue;
                    }
                    this._eb(x, e.y + e.r * 0.6, 0, 2.2, EB_CURTAIN);
                }
                this.sTick();
                // Next gap decided now, so the telegraph can point at it.
                e.gap = this.fx0 + 60 + ((e.gap + 151) % (this.fx1 - this.fx0 - 120));
            }
        } else {
            this._tel(e, e.a2, "aimed");
            if (this._every(e, "a2", rage ? 32 : 42, mv)) {
                for (let k = -2; k <= 2; k++) {
                    this._ebAimed(e.x, e.y, 3.4, k * 0.17);
                }
                this.sTick();
                this._bossCue(e, "salvo", { a: Math.round(this._aimAngle(e.x, e.y) * 100) / 100 });
            }
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
        e.tel = 0;
        // Second phase: it charges sooner and dives harder. The lance keeps its
        // full 55 frames of warning -- a phase change is allowed to make an
        // attack worse, never to make it less readable.
        const rage = this._bossRage(e, mv);
        // The beat holds the hovering half of the cycle only: a hull stopped
        // dead halfway through a dive reads as the game having crashed.
        if (e.hold > 0 && e.phase !== 3) {
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
                e.a1 = rage ? 190 : 250;
                this.beams.push(this.mkBeam({
                    src: e.id, oy: e.r * 0.7, a: Math.PI / 2,
                    warn: 55, life: 90, w: 34, spin: 0, c: "#ffd166", len: 900,
                }));
                e.phase = 2;
                e.a2 = 150;
            }
            this._tel(e, e.a4, "aimed");
            if (this._every(e, "a4", rage ? 22 : 30, mv)) {
                this._ebAimed(e.x, e.y, 3.6);
            }
        } else if (e.phase === 2) {
            // The dive starts once the beam is spent.
            e.a2 -= mv;
            if (e.a2 <= 0) {
                e.phase = 3;
                const tgt = this._target(e.x, e.y);
                e.vx = tgt ? Math.max(-3, Math.min(3, (tgt.x - e.x) * 0.03)) : 0;
                e.vy = rage ? 8.5 : 7;
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
        e.tel = 0;
        const rage = this._bossRage(e, mv);
        if (e.hold > 0) {
            return;
        }
        this._tel(e, e.a1, "spawn");
        this._tel(e, e.a2, "ring");
        e.a1 = (e.a1 || 0) - mv;
        if (e.a1 <= 0) {
            e.a1 = Math.max(62, 140 - this.wave * 2) * (rage ? 0.72 : 1);
            const brood = this.wave > 8 ? ["drone", "speedy", "kami"] : ["drone", "speedy"];
            // Three bays past the midgame: the flood is the whole point.
            const bays = this.wave > 12 ? [-e.r * 0.6, 0, e.r * 0.6] : [-e.r * 0.55, e.r * 0.55];
            for (const off of bays) {
                const type = brood[Math.floor(Math.random() * brood.length)];
                this.enemies.push(this.mkEnemy(type, e.x + off, e.y + e.r * 0.5));
                // The door that opened, as a fraction of the half-width.
                this._bossCue(e, "launch", { c: Math.round((off / e.r) * 100) / 100 });
            }
            this.burst(e.x, e.y + e.r * 0.5, e.c, 10, 3);
            this.sTick();
        }
        if (this._every(e, "a2", rage ? 95 : 130, mv)) {
            for (let k = 0; k < 7; k++) {
                const a = (k / 7) * 6.2832 + e.t * 0.02;
                this._eb(e.x, e.y, Math.cos(a) * 1.9, Math.sin(a) * 1.9, EB_SPREAD);
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
        e.tel = 0;
        const rage = this._bossRage(e, mv);
        if (e.hold > 0) {
            return;
        }
        e.phase = 1;
        // The blink leaves a shockwave behind, so the ring is worth warning
        // about: it goes off where the hull still is, not where it lands.
        this._tel(e, e.a1, "ring");
        e.a1 = (e.a1 || 0) - mv;
        if (e.a1 <= 0) {
            e.a1 = rage ? 110 : 150;
            // Shockwave where it was, then reappear somewhere else.
            for (let k = 0; k < 14; k++) {
                const a = (k / 14) * 6.2832;
                this._eb(e.x, e.y, Math.cos(a) * 2.6, Math.sin(a) * 2.6, EB_SPREAD);
            }
            this.burst(e.x, e.y, e.c, 26, 5);
            this._ev({ k: "boom", x: e.x, y: e.y, c: e.c, b: 0 });
            // Shockwave ring stays behind at the departure point. The collapse
            // itself needs no cue: the animator sees the teleport.
            this._bossCue(e, "blink", { x: Math.round(e.x), y: Math.round(e.y) });
            e.x = this.fx0 + 90 + Math.random() * (this.fx1 - this.fx0 - 180);
            e.y = 110 + Math.random() * 90;
            this.burst(e.x, e.y, "#ffffff", 20, 4);
            this.sPup();
        }
        if (this._every(e, "a2", rage ? 5 : 7, mv)) {
            for (let k = 0; k < 3; k++) {
                const a = e.t * 0.09 + (k / 3) * 6.2832;
                this._eb(e.x, e.y, Math.cos(a) * 2.9, Math.sin(a) * 2.9, EB_SPREAD);
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
                // The zigzag lives in `DRONE_ANIM.drift`, not here: the animator
                // reads the lean, the eyes and the turn telegraph off this exact
                // sine (see `dronePose`), and a second copy of the rate would
                // point the lean the wrong way the first time it is retuned.
                e.x += Math.sin(e.t * DRONE_ANIM.drift.rate) * DRONE_ANIM.drift.ampPx * mv;
            } else if (e.type === "speedy") {
                // Both numbers live in `FRY_ANIM.speedy`: the animator points
                // the hull along the velocity they produce (see `fryPose`), and
                // a second copy would aim the lean the wrong way the first time
                // either is retuned.
                const S = FRY_ANIM.speedy;
                e.y += (S.fall[0] + this.wave * S.fall[1]) * mv;
                const tgt = this._target(e.x, e.y);
                if (tgt) {
                    e.x += (tgt.x - e.x) * S.steer * mv;
                }
            } else if (e.type === "tank") {
                e.y += 0.65 * mv;
                e.tel = 0;
                if (e.fire > 0) {
                    e.fire -= mv;
                }
                if (e.y > 0 && mv > 0) {
                    // The tank was the only aimed shot in the game with no
                    // warning at all: it just went off every 150 frames.
                    this._tel(e, e.a1, "aimed");
                    if (this._every(e, "a1", 150, mv)) {
                        const tgt = this.decoys.length ? this._target(e.x, e.y) : this._aimShip();
                        if (tgt) {
                            const dx = tgt.x - e.x;
                            const dy = tgt.y - e.y;
                            const d = Math.sqrt(dx * dx + dy * dy) || 1;
                            this._eb(e.x, e.y, (dx / d) * 2.6, (dy / d) * 2.6, EB_AIMED);
                            e.fire = FRY_ANIM.tank.recoil;
                            this.sTick();
                        }
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
                            this._eb(e.x, e.y, (dx / d) * 5.2, (dy / d) * 5.2, EB_LANCE);
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
                    e.vx += (dx / d) * FRY_ANIM.kami.accel * mv;
                    e.vy += (dy / d) * FRY_ANIM.kami.accel * mv;
                }
                const sp = Math.sqrt(e.vx * e.vx + e.vy * e.vy) || 1;
                // Same numbers the plume and the core throb read: the animator
                // rebuilds the speed from the clock, because a guest is handed
                // `t` and never a velocity.
                const max = FRY_ANIM.kami.cap[0] + this.wave * FRY_ANIM.kami.cap[1];
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
                if (this._enemyHit(e, sp.x, sp.y, this._hitR(sp))) {
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
                        killedByShip = this._damageEnemy(e, 3, sp, sp.x, sp.y);
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
                const dead = this._damageEnemy(e, dmg, owner, b.x, b.y);
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
                const rr = rk.r + this._hitR(sp);
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
            // The capsule refills the stock, it does not detonate: a bomb that
            // goes off the instant you touch it is a bomb you never chose to
            // use, and the whole point of the resource is choosing the moment.
            sp.bombs = Math.min(this._maxBombs(), sp.bombs + 1);
            say("Bomb +1  ·  X", 16);
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
            this._setInv(sp, PUP_BUFFS.G);
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
            // Was +6. Grazing now feeds the combo too, and a capsule handing
            // out a quarter of the whole ladder for free undercuts it.
            this.combo = Math.min(this.combo + 3, COMBO_MAX);
            this.comboT = 200;
            say("Combo x" + this.combo + "!");
        } else if (t === "Y") {
            // The combo used to multiply this outright: at wave 30 with x25 a
            // single capsule paid more than a boss, so the best scoring move in
            // the game was walking into a capsule. It now scales with the
            // combo instead of being multiplied by it.
            const pts = Math.round(
                120 * Math.max(1, this.wave) * (1 + this.combo * 0.15) * (1 + sp.mods.scoreMul)
            );
            this.score += pts;
            this.pop(sp.x, sp.y - 30, "+" + pts.toLocaleString(), PUP_COLORS.Y, 17);
        }
    }

    /**
     * A drone coming apart, from the three numbers its kill cue carries:
     * chassis, hull tier and the clock it died on. Everything else the wreck is
     * drawn from -- the lean it was in, the drift it keeps, how far the halves
     * have travelled -- is a pure function of those and its own age, so a guest
     * that only ever receives the cue draws the same wreck as the host.
     *
     * @param {number} x
     * @param {number} y
     * @param {Array} dr `[variant, tier, clock]`
     */
    _droneWreck(x, y, dr) {
        if (this.wrecks.length >= DRONE_ANIM.maxWrecks) {
            this.wrecks.shift();
        }
        const name = ENEMY_SPRITES.drone[(dr[0] || 0) % ENEMY_SPRITES.drone.length];
        this.wrecks.push({
            name, x, y, t: 0,
            tint: this._enemyColor("drone"),
            px: pxFor(name, this._enemyR("drone") * 2),
            tier: dr[1] || 1,
            t0: dr[2] || 0,
            life: DRONE_ANIM.death.frames,
        });
    }

    /** The yaw step a fry hull is posed in, for the corpse to open in it. */
    _fryStep(e) {
        const tgt = this._target(e.x, e.y);
        return fryStep({
            name: this._enemySprite(e), kit: fryKit(e.type),
            t: e.t, wave: this.wave, dx: tgt ? tgt.x - e.x : 0,
            tel: e.tel, aim: e.aim, rot: e.rot,
        });
    }

    /**
     * A small ship coming apart, from the four numbers its kill cue carries:
     * which of them it was, its chassis, the wear it died wearing and the pose
     * it died in. Everything else -- the flame-out, how far the halves have
     * travelled, the debris -- is a pure function of those and the corpse's own
     * age, so a guest that only ever receives the cue draws the same wreck.
     *
     * The cap drops the *oldest* corpse rather than refusing the newest: a
     * death that goes missing because a bomb swept the field a second ago is
     * the one death the player was actually looking at.
     *
     * @param {number} x
     * @param {number} y
     * @param {Array} fr `[kind, variant, tier, pose]`
     */
    _fryWreck(x, y, fr) {
        const type = FRY_KINDS[fr[0]];
        if (!type) {
            return;
        }
        if (this.wrecks.length >= DRONE_ANIM.maxWrecks) {
            this.wrecks.shift();
        }
        const names = ENEMY_SPRITES[type];
        const name = names[(fr[1] || 0) % names.length];
        this.wrecks.push({
            name, kit: type, x, y, t: 0,
            tint: this._enemyColor(type),
            px: pxFor(name, this._enemyR(type) * 2),
            tier: fr[2] || 0,
            step: fr[3] || 0,
            life: fryDeathFrames(type),
        });
    }

    _updateFx(ts) {
        for (let i = this.wrecks.length - 1; i >= 0; i--) {
            const w = this.wrecks[i];
            w.t += ts;
            if (w.t >= w.life) {
                this.wrecks.splice(i, 1);
            }
        }
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
        for (let i = this.shocks.length - 1; i >= 0; i--) {
            this.shocks[i].t += ts;
            if (this.shocks[i].t >= SHOCK_FRAMES) {
                this.shocks.splice(i, 1);
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
            sp.hudFx.observe(sp, ts);
        }
        // Bosses are not simulated here, but their animation is derived from the
        // snapshot positions, so it ticks on a guest exactly as on the host.
        this._updateBossAnims(ts);
        this._updateColossusAnims(ts);
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
        } else if (action === "bomb") {
            this.useBomb(slot);
        } else if (action === "focus1" || action === "focus0") {
            // Focus is the one held input in the game, and this channel only
            // carries one-shot actions: a guest sends the press and the release
            // as two edges. If a release is ever lost the player is stuck in
            // focus until the next tap, which is why it is the only input the
            // engine also mirrors in the snapshot (`fc`).
            const sp = this._shipBySlot(slot);
            if (sp) {
                sp.focus = action === "focus1";
            }
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
                // `iv` used to be a bare 0/1, which is why a guest could only
                // blink at a fixed rate: it now carries the frames left (and
                // the window they came from) so the blink can speed up as the
                // window closes. An old reader still sees a truthy number.
                iv: Math.round(Math.max(0, s.inv)), im: Math.round(s.invMax || 1),
                sd: s.shield,
                dn: s.down ? 1 : 0, rp: Math.round(s.reviveProgress),
                wp: s.weapon === "triple" ? 1 : 0, lv: s.lives,
                bo: s.bombs, fc: s.focus ? 1 : 0,
                // Grazes banked towards the next combo step, for the HUD meter.
                gz: s.graze % GRAZE_PER_COMBO,
                // Perks (indexes), dash and active cooldowns for the HUD.
                pk: s.perks.map((id) => PERK_INDEX[id]),
                ds: s.dashCharges, dm: s.dashMax, dt: s.dash > 0 ? 1 : 0,
                // How full the recharging dash pip is, 0-100. The fill and not
                // the clock, because the length of the cooldown comes off perks
                // the HUD would otherwise have to be told about as well.
                dp: s.dashCharges < s.dashMax && s.dashCdMax > 0
                    ? Math.round((1 - Math.max(0, s.dashCd) / s.dashCdMax) * 100)
                    : undefined,
                ac: s.actives.map((a) => [Math.round(Math.max(0, a.cd)), a.cdMax]),
                bf: BUFF_KEYS.reduce((m, k, i) => m | (s.buffs[k] > 0 ? 1 << i : 0), 0),
                // Frames left on each capsule, so a guest can draw the column
                // draining and the last two seconds flickering -- `bf` only
                // ever said present or absent, which is the readout the HUD
                // study was written to replace. Sent only while one is running.
                bt: BUFF_KEYS.some((k) => s.buffs[k] > 0)
                    ? BUFF_KEYS.map((k) => Math.round(s.buffs[k]))
                    : undefined,
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
                // The recoil: the frames left of a tank's kick. It cannot be
                // derived -- the pattern timer it comes off does not travel and
                // the hull is quiet again before the bullet is anywhere -- and
                // it is only ever on the wire for the three frames it lasts.
                fi: e.fire > 0 ? Math.ceil(e.fire) : undefined,
                // Boss/colossus index: the guest rebuilds the rest from the
                // catalogues. `ar` is the WARDEN armour.
                ck: e.k,
                ar: e.armor ? 1 : 0,
                // Telegraph: intensity, which warning, and where the hole in
                // the next curtain is. It has to travel -- a guest does not
                // simulate, and deriving it from the AI's own arithmetic would
                // drift apart the first time anyone retunes a boss.
                tl: e.tel ? Math.round(e.tel * 100) : undefined,
                tk: e.tel ? e.telK : undefined,
                gp: e.gap != null ? Math.round(e.gap) : undefined,
                // HYDRA-07's three extra pieces of state. `hd` is one number
                // per side head: its hull points while it lives, and minus the
                // frames left of its death-and-rebuild once it does not, which
                // is everything a guest needs to draw all of 7/8/9 without a
                // second field. `sp` is the crown emitting, `sa` its angle --
                // both are what the ring of light is drawn from, and neither
                // can be derived from a position.
                hd: e.heads ? e.heads.map((h) => Math.round(h.hp > 0 ? h.hp : -h.t)) : undefined,
                sp: e.spiral ? 1 : undefined,
                sa: e.sa != null ? Math.round(e.sa * 100) / 100 : undefined,
                // VULCAN's heat cycle. `ht` is the heat (0..100) and `vp` the
                // phase: the entire visual language of the hull is read off
                // those two and neither can be derived from a position -- the
                // slot is a gauge, the fans light while they vent, the feet
                // plant. `vn` is how many rocks the volley telegraph promises,
                // which has to be the number that is actually coming. `vf` is
                // one number per shoulder fan on exactly HYDRA's `hd` pattern:
                // its points while it works, minus the frames left of the jam
                // once it does not, so the hit flash, the seized fan and the
                // clearing all come for free. `pt` deliberately does not
                // travel: a guest reads the telegraph, not the clock.
                ht: e.heat != null ? Math.round(e.heat * 100) : undefined,
                vp: e.heat != null ? e.ph : undefined,
                vn: e.vn || undefined,
                vf: e.fans ? e.fans.map((f) => Math.round(f.hp > 0 ? f.hp : -f.t)) : undefined,
            })),
            // 3rd slot = style bits: 1 critical, 2 explosive.
            bu: this.bullets.map((b) => [Math.round(b.x), Math.round(b.y), (b.cr ? 1 : 0) | (b.ex ? 2 : 0)]),
            // 3rd slot = EB_KINDS index (colour and size). Appended at the end
            // of the tuple, so a reader that does not know about it reads
            // `undefined` and falls back to kind 0 instead of breaking.
            eb: this.ebullets.map((b) => [Math.round(b.x), Math.round(b.y), b.k || 0]),
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
            // 8th slot = the forge profile flag. Appended at the end, so a
            // reader that does not know about it sees `undefined` and draws the
            // plain beam instead of breaking.
            bm: this.beams.map((b) => [
                Math.round(b.x), Math.round(b.y), Math.round(b.a * 1000) / 1000,
                Math.round(b.len), Math.round(b.w), Math.round(Math.max(0, b.warn)), b.c,
                b.hot ? 1 : 0,
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
            sp.inv = s.iv || 0;
            sp.invMax = s.im || Math.max(1, s.iv || 1);
            sp.shield = s.sd;
            sp.down = !!s.dn;
            sp.reviveProgress = s.rp;
            sp.weapon = s.wp ? "triple" : "single";
            sp.lives = s.lv;
            sp.bombs = s.bo != null ? s.bo : sp.bombs;
            sp.focus = !!s.fc;
            sp.graze = s.gz || 0;
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
                sp.buffs[k] = s.bt ? s.bt[i] || 0 : ((s.bf || 0) & (1 << i) ? 1 : 0);
            });
            sp.dashCharges = s.ds != null ? s.ds : sp.dashCharges;
            sp.dashMax = s.dm != null ? s.dm : sp.dashMax;
            sp.dash = s.dt ? 1 : 0;
            // The host sent the fill; rebuild a cooldown that reads the same,
            // so one code path draws the pip on both roles.
            sp.dashCdMax = 100;
            sp.dashCd = s.dp != null ? 100 - s.dp : 0;
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
                stun: e.sn ? 1 : 0, armor: e.ar ? 1 : 0, fire: e.fi || 0,
                tel: (e.tl || 0) / 100, telK: e.tk || "", gap: e.gp,
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
                if (e.hd) {
                    // HYDRA's side heads, unpacked from the one number each of
                    // them travels as. `mhp` is not sent: it is a fixed share
                    // of the hull's, and `mh` is already here.
                    const mhp = Math.max(1, Math.round((e.mh || 1) * HYDRA_HEAD.hp));
                    Object.assign(en, {
                        parts: hullParts(d.sprite),
                        heads: e.hd.map((v) => ({ hp: v > 0 ? v : 0, mhp, t: v > 0 ? 0 : -v })),
                        spiral: e.sp ? 1 : 0,
                        sa: e.sa || 0,
                    });
                }
                if (e.ht != null) {
                    // VULCAN, same unpacking for the fans as HYDRA's heads.
                    const mhp = Math.max(1, Math.round((e.mh || 1) * VULCAN_FAN.hp));
                    Object.assign(en, {
                        parts: hullParts(d.sprite),
                        heat: e.ht / 100,
                        ph: e.vp || 0,
                        vn: e.vn || 0,
                        fans: (e.vf || []).map((v) => ({
                            hp: v > 0 ? v : 0, mhp, t: v > 0 ? 0 : -v,
                        })),
                    });
                }
            }
            return en;
        });
        this.bullets = snap.bu.map((b) => ({ x: b[0], y: b[1], vx: 0, vy: 0, cr: (b[2] || 0) & 1, ex: (b[2] || 0) & 2 }));
        this.ebullets = snap.eb.map((b) => ({ x: b[0], y: b[1], vx: 0, vy: 0, k: b[2] || 0 }));
        this.pups = snap.pu.map((p) => ({ x: p.x, y: p.y, t: p.t, ph: p.ph, r: 13 }));
        this.rocks = snap.rk.map((r) => ({ x: r.x, y: r.y, r: r.r, rot: r.a, v: r.v || 0 }));
        this.trails = (snap.tr || []).map((t) => ({ x: t[0], y: t[1], life: t[2], ml: 42 }));
        this.turrets = (snap.tu || []).map((t) => ({ x: t[0], y: t[1], sl: t[2], life: 1, t: 0 }));
        this.holes = (snap.bh || []).map((h) => ({ x: h[0], y: h[1], r: h[2], life: h[3], ml: 240 }));
        this.decoys = (snap.dc || []).map((d) => ({ x: d[0], y: d[1], sl: d[2], life: 1, ml: 360 }));
        this.beams = (snap.bm || []).map((b) => ({
            x: b[0], y: b[1], a: b[2], len: b[3], w: b[4], warn: b[5], c: b[6],
            hot: b[7] || 0, life: 1, spin: 0, src: 0,
        }));
        for (const ev of snap.ev || []) {
            this._playEvent(ev);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Render                                                              */
    /* ------------------------------------------------------------------ */

    /**
     * Colossus beams: thin sight line while charging, wall of light after.
     *
     * A beam marked `hot` gets the profile from the VULCAN design sheet instead
     * of the plain two-stroke one -- three concentric layers with a jittering
     * white core, a width that waves along its length, a per-frame flicker and
     * a bloom where it lands. It is a flag rather than a restyle of every beam
     * because NYX and OMEGA were not part of this pass and their beams are
     * tuned as they are; and it is only cosmetic, so it needs nothing from the
     * simulation beyond the beam the engine already owns and already damages
     * with. `hot` travels in `bm`, so a guest draws the same beam.
     */
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
                g.beginPath();
                g.moveTo(b.x, b.y);
                g.lineTo(ex, ey);
                g.stroke();
                g.restore();
                continue;
            }
            if (b.hot) {
                this._drawForgeBeam(b, ex, ey);
                g.restore();
                continue;
            }
            g.strokeStyle = b.c;
            g.globalAlpha = 0.22;
            g.lineWidth = b.w * (1 + Math.sin(this.frame * 0.5) * 0.06);
            g.beginPath();
            g.moveTo(b.x, b.y);
            g.lineTo(ex, ey);
            g.stroke();
            g.setLineDash([]);
            g.globalAlpha = 0.95;
            g.strokeStyle = "#ffffff";
            g.lineWidth = b.w * 0.28;
            g.beginPath();
            g.moveTo(b.x, b.y);
            g.lineTo(ex, ey);
            g.stroke();
            g.restore();
        }
    }

    /**
     * One forge beam, as the sheet draws it: an outer sheath in the hull's own
     * colour, an inner one pushed towards white, and a core that is white and
     * jitters a pixel or two along its length. The width **waves along the
     * beam** rather than pulsing as a whole, and that wave is most of what makes
     * it read as molten metal instead of as a laser pointer.
     *
     * A canvas line cannot change width along itself, so each layer is a filled
     * ribbon: down one edge and back up the other, with the half-width sampled
     * from the wave at every step. That is also what makes it affordable, which
     * the first version of this was not -- see `BEAM_FORGE.steps`.
     */
    _drawForgeBeam(b, ex, ey) {
        const g = this.g;
        const T = BEAM_FORGE;
        const flick = T.flickMin
            + (1 - T.flickMin) * Math.abs(Math.sin(this.frame * 0.9 + b.a * 7));
        const n = T.steps;
        const dx = (ex - b.x) / n;
        const dy = (ey - b.y) / n;
        // Across the beam, for the ribbon's two edges.
        const px = -Math.sin(b.a);
        const py = Math.cos(b.a);
        g.setLineDash([]);
        for (const layer of T.layers) {
            g.fillStyle = layer.c === "hull" ? b.c : layer.c;
            g.globalAlpha = layer.a * (layer.flick ? flick : 1);
            g.beginPath();
            for (let i = 0; i <= n; i++) {
                const m = this._forgeHalf(b, layer, i, n);
                const cx = b.x + dx * i;
                const cy = b.y + dy * i;
                if (i === 0) {
                    g.moveTo(cx + px * m, cy + py * m);
                } else {
                    g.lineTo(cx + px * m, cy + py * m);
                }
            }
            for (let i = n; i >= 0; i--) {
                const m = this._forgeHalf(b, layer, i, n);
                g.lineTo(b.x + dx * i - px * m, b.y + dy * i - py * m);
            }
            g.closePath();
            g.fill();
        }
        // The bloom where it lands, which is the sheet's other half of the beam:
        // without it the light simply stops in the middle of the arena.
        const t = BEAM_FORGE.bloom;
        const bx = b.x + (ex - b.x) * t.at;
        const by = b.y + (ey - b.y) * t.at;
        g.globalAlpha = t.a * flick;
        g.fillStyle = b.c;
        g.beginPath();
        g.ellipse(bx, by, b.w * t.rx, b.w * t.ry, b.a, 0, 6.2832);
        g.fill();
        g.globalAlpha = Math.min(1, t.a * 1.6 * flick);
        g.fillStyle = "#ffffff";
        g.beginPath();
        g.ellipse(bx, by, b.w * t.rx * 0.4, b.w * t.ry * 0.4, b.a, 0, 6.2832);
        g.fill();
        g.globalAlpha = 1;
    }

    /** Half-width of one forge-beam layer at step `i`, off the travelling wave. */
    _forgeHalf(b, layer, i, n) {
        const T = BEAM_FORGE;
        const wave = Math.sin(((i / n) * T.waveLen + this.frame * T.waveRate) * 6.2832);
        const w = b.w * layer.w * (1 + wave * T.waveAmp) * 0.5;
        if (!layer.core) {
            return w;
        }
        // The core jitters a pixel or two along its length, exactly as the
        // sheet's does: it is what keeps the beam alive on a frame where nothing
        // else about it moved.
        return Math.max(0.9, w + (((this.frame + i * 13) * 7919) % 10 < 3 ? 0.9 : 0));
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
            g.fillStyle = rgba(col, 0.14);
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
        // Invulnerable: the blink used to be a flat 4 frames on, 4 off, exactly
        // the same on the first frame of the window and on the last, so the
        // moment you became solid again was invisible -- and being hit one
        // frame after an invulnerability you thought was still running is the
        // death that reads as the game cheating. It now doubles in rhythm for
        // the last ~25 frames, and the dot below is drawn either way.
        let hidden = false;
        if (sp.inv > 0) {
            const period = sp.inv > 25 ? 8 : 4;
            hidden = this.frame % period < period / 2;
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
        if (!hidden) {
            g.globalCompositeOperation = "lighter";
            g.fillStyle = rgba(sp.color, 0.12);
            g.beginPath();
            g.arc(0, 0, 26, 0, 6.2832);
            g.fill();
            g.globalCompositeOperation = "source-over";
            // Banked hull, engine flame and retro-thrusters. Each slot has its
            // own hull and the frames are tinted with sp.color, same as the
            // flat sprite was; the pose comes from the motion `_moveShip` made.
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
        }
        this._drawHitbox(sp);
        g.restore();
    }

    /**
     * The dot that is actually you. The hull is ~32 logical px wide and the
     * circle that kills you is 6.5: without drawing it, every near miss is
     * unreadable and every hit feels arbitrary. It stays at full opacity while
     * the hull blinks, and focusing draws the exact circle so a gap can be
     * measured by eye instead of guessed.
     *
     * Called inside the ship transform, so it draws around the origin.
     */
    _drawHitbox(sp) {
        const g = this.g;
        const r = this._hitR(sp);
        g.globalAlpha = 1;
        g.globalCompositeOperation = "lighter";
        g.fillStyle = "rgba(255,255,255," + (sp.focus ? 0.34 : 0.16) + ")";
        g.beginPath();
        g.arc(0, 0, r * (sp.focus ? 2.6 : 2), 0, 6.2832);
        g.fill();
        g.globalCompositeOperation = "source-over";
        g.fillStyle = sp.focus ? "#ffffff" : "rgba(255,255,255,0.92)";
        g.beginPath();
        g.arc(0, 0, r * 0.62, 0, 6.2832);
        g.fill();
        if (sp.focus) {
            g.strokeStyle = "rgba(255,255,255," + (0.6 + Math.sin(this.frame * 0.18) * 0.25) + ")";
            g.lineWidth = 1.2;
            g.beginPath();
            g.arc(0, 0, r, 0, 6.2832);
            g.stroke();
        }
        if (sp.inv > 0 && sp.invMax > 1) {
            // How much of the window is left, as an arc that drains. The blink
            // says "invulnerable"; this says "for this much longer".
            g.strokeStyle = "rgba(94,225,255,0.7)";
            g.lineWidth = 2;
            g.beginPath();
            g.arc(0, 0, 20, -Math.PI / 2, -Math.PI / 2 + Math.min(1, sp.inv / sp.invMax) * 6.2832);
            g.stroke();
        }
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

    /**
     * The shape of what is about to happen, drawn in the fraction of a second
     * before it does. Beams and the sniper were the only two attacks in the
     * game that announced themselves; every boss pattern simply went off, and
     * a dense pattern with no warning reads as unfair rather than hard.
     *
     * `tel`/`telK` are written by the AI (see `_tel`) and travel in the
     * snapshot, so a guest draws the same warning on the same frame.
     */
    _drawTelegraph(e) {
        const t = e.tel || 0;
        if (t <= 0.02 || !e.telK) {
            return;
        }
        const g = this.g;
        const a = 0.22 + t * 0.55;
        const dash = Math.max(3, 14 * (1 - t));
        const rad = e.type === "colossus" ? Math.max(e.hw, e.hh) : e.r;
        g.save();
        g.globalCompositeOperation = "lighter";
        g.strokeStyle = e.c;
        g.globalAlpha = a;
        g.lineWidth = 1.5 + t * 1.5;
        g.setLineDash([dash, dash]);
        if (e.telK === "ring") {
            // A ring closing onto the hull: the burst goes off when it lands.
            g.beginPath();
            g.arc(e.x, e.y, rad + 10 + (1 - t) * 120, 0, 6.2832);
            g.stroke();
        } else if (e.telK === "aimed") {
            const tgt = this._target(e.x, e.y);
            if (tgt) {
                const ang = Math.atan2(tgt.y - e.y, tgt.x - e.x);
                const len = 260 + t * 140;
                g.beginPath();
                g.moveTo(e.x, e.y);
                g.lineTo(e.x + Math.cos(ang) * len, e.y + Math.sin(ang) * len);
                g.stroke();
            }
        } else if (e.telK === "curtain") {
            // The wall, and above all the hole in it. Where the gap is *is* the
            // attack, so it is marked brighter than the wall itself. The mark
            // is deliberately narrower than the real hole (52 against the 62-66
            // the pattern skips): what it points at is always safe.
            const y = e.y + rad * 0.6;
            g.beginPath();
            g.moveTo(this.fx0, y);
            g.lineTo(this.fx1, y);
            g.stroke();
            if (e.gap != null) {
                g.setLineDash([]);
                g.globalAlpha = Math.min(1, a + 0.25);
                g.strokeStyle = "#7bffb0";
                g.lineWidth = 3;
                g.beginPath();
                g.moveTo(e.gap - 52, y);
                g.lineTo(e.gap + 52, y);
                g.moveTo(e.gap - 52, y - 9);
                g.lineTo(e.gap - 52, y + 9);
                g.moveTo(e.gap + 52, y - 9);
                g.lineTo(e.gap + 52, y + 9);
                g.stroke();
            }
        } else if (e.telK === "volley") {
            // The one telegraph that carries a number: one pip per rock in the
            // volley that is coming, filling left to right as the slot charges.
            // The sheet is explicit that the count has to be readable, and `vn`
            // travels for exactly that reason.
            g.setLineDash([]);
            const n = e.vn || 0;
            const y = e.y + rad * 0.5;
            const step = 22;
            const lit = Math.min(n, Math.floor(t * n) + 1);
            for (let i = 0; i < n; i++) {
                const x = e.x + (i - (n - 1) / 2) * step;
                const on = i < lit;
                g.globalAlpha = on ? Math.min(1, a + 0.3) : a * 0.5;
                g.fillStyle = on ? "#fff0d2" : e.c;
                g.beginPath();
                g.arc(x, y, on ? 5 : 3.5, 0, 6.2832);
                g.fill();
            }
            g.globalAlpha = a;
        } else if (e.telK === "spawn") {
            // Bays about to open: chevrons pointing the way the brood comes out.
            g.setLineDash([]);
            const y = e.y + rad * 0.5;
            for (const off of [-rad * 0.6, 0, rad * 0.6]) {
                g.beginPath();
                g.moveTo(e.x + off - 9, y);
                g.lineTo(e.x + off, y + 9 + t * 6);
                g.lineTo(e.x + off + 9, y);
                g.stroke();
            }
        }
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
        g.fillStyle = rgba(e.c, 0.14);
        g.beginPath();
        g.arc(e.x, e.y, e.r + 10, 0, 6.2832);
        g.fill();
        g.restore();
        // Sniper sight line while it charges. The target is recomputed here (it
        // does not travel in the snapshot): ships are already synchronised, so
        // host and guest draw the same sight.
        //
        // It used to appear at `aim > 40`, i.e. 30 frames of a 1 px line at
        // alpha 0.15: technically a telegraph, in practice invisible over a
        // lit backdrop. It now starts at 25 (45 frames, the same warning every
        // other pattern gets) and is drawn like something that matters.
        if (e.type === "sniper" && e.aim > 25) {
            const tgt = this._target(e.x, e.y);
            if (tgt) {
                const p = Math.min(1, (e.aim - 25) / 45);
                g.save();
                g.globalCompositeOperation = "lighter";
                g.strokeStyle = "rgba(77,227,193," + (0.25 + p * 0.55) + ")";
                g.lineWidth = 1 + p * 1.5;
                g.setLineDash([Math.max(3, 12 * (1 - p)), 8]);
                g.beginPath();
                g.moveTo(e.x, e.y);
                g.lineTo(tgt.x, tgt.y);
                g.stroke();
                g.restore();
            }
        }
        this._drawTelegraph(e);
        if (e.type === "colossus") {
            // Colossal hull: drawn at its full logical width, chunky pixels and
            // a heavy halo. Its health goes to the top bar, not a floating one.
            const d = COLOSSI[e.k] || COLOSSI[0];
            const px = pxFor(d.sprite, e.w);
            g.save();
            g.globalCompositeOperation = "lighter";
            g.fillStyle = rgba(e.c, 0.1);
            g.beginPath();
            g.ellipse(e.x, e.y, e.w * 0.55, e.h * 0.6, 0, 0, 6.2832);
            g.fill();
            g.restore();
            // NEVER the white flash silhouette here: a colossus is under fire
            // every frame, so it would sit permanently washed out (and it would
            // double the sprite cache for a canvas this big). The hit feedback
            // is the white burst at the point of impact plus the top bar.
            const anim = this._colossusAnims.get(e.k || 0);
            if (anim) {
                // Per-colossus animation: lean, breathing, the gap shutter, the
                // bottom-edge sweep, plumes and the failing hull (see
                // `colossus_animator.js`). The pose was computed in the
                // simulation, so this only reads it.
                anim.draw(g, { sprite: d.sprite, px, x: e.x, y: e.y });
            } else {
                const p = 1 + Math.sin(e.t * 0.05) * 0.012;
                g.save();
                g.translate(e.x, e.y);
                g.scale(p, p);
                drawSprite(g, d.sprite, 0, 0, { tint: e.c, px });
                g.restore();
            }
            return;
        }
        if (e.type === "boss") {
            // Per-boss animation: lean, breathing, plates, curtain, blink and
            // the rest (see `boss_animator.js`). The pose was computed in the
            // simulation, so this only reads it.
            const anim = this._bossAnims.get(e.k || 0);
            if (anim) {
                anim.draw(g, { sprite: name, px: pxFor(name, e.r * 2), x: e.x, y: e.y, flash });
            } else {
                drawSprite(g, name, e.x, e.y, { tint: e.c, px: pxFor(name, e.r * 2), flash });
            }
        } else if (e.type === "drone") {
            // The drone kit: the lean, the eyes, the hull tier and the turn
            // telegraph, all sampled from `e.t` and `e.hp` (see
            // `drone_animator.js`). Still one `drawImage` per hull, which is the
            // point of it -- there can be thirty of these on screen.
            drawDrone(g, {
                name, tint: e.c, px: pxFor(name, e.r * 2),
                x: e.x, y: e.y, t: e.t, hp: e.hp, flash,
            });
        } else if (fryKit(e.type)) {
            // The fry kit: a rigid hull turning as a body, and a burn that says
            // what its engine is doing -- the speedy's stutter, the tank's
            // heavy beat and the quiet it goes into to steady a shot, the
            // sniper's alternating station-keeping puffs and the cut that
            // telegraphs the shot, the kamikaze's throttle (see
            // `fry_animator.js`). Everything is sampled from `e.t`, `e.hp` and
            // the fields that already travel.
            const tgt = this._target(e.x, e.y);
            drawFry(g, {
                name, kit: fryKit(e.type), tint: e.c, px: pxFor(name, e.r * 2),
                x: e.x, y: e.y, t: e.t, hp: e.hp, mhp: e.mhp, wave: this.wave, flash,
                dx: tgt ? tgt.x - e.x : 0, dy: tgt ? tgt.y - e.y : 1,
                tel: e.tel, aim: e.aim, rot: e.rot, fire: e.fire,
            });
        } else {
            drawSprite(g, name, e.x, e.y, {
                tint: e.c,
                px: pxFor(name, e.r * 2),
                flash,
            });
        }
        if (e.armor && e.type !== "boss") {
            // Hits barely scratch it. A boss gets the animator's sliding plates
            // and gapped curtain instead of this ring: both at once reads as two
            // concentric circles and hides which one is the way in.
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
            if (e.type === "boss") {
                // Tick where the second phase starts, same idea as the colossus
                // bar: the threshold is something to aim at, not a surprise.
                g.fillStyle = "rgba(255,255,255,0.6)";
                g.fillRect(e.x - w2 / 2 + w2 * BOSS_RAGE_AT - 1, e.y - e.r - 14, 2, 8);
            }
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
            // A veil between the scenery and everything that can kill you. Nine
            // of the 27 places paint in the same warm reds as the enemy bullets
            // and scatter 1-3 px motes the exact size of a bullet core, all in
            // `lighter`: on the lava world or under a supernova a shot and the
            // background were literally the same pixels. The places ported to
            // Direction A carry their own number instead, down to none at all
            // for DEEP SPACE -- the place decides, not the catalogue.
            g.fillStyle = this.bg.scrim;
            g.fillRect(-mx, -my, W + mx * 2, H + my * 2);
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
        for (const s of this.shocks) {
            const k = Math.min(1, s.t / SHOCK_FRAMES);
            const e2 = 1 - Math.pow(1 - k, 3);
            const r = 30 + e2 * Math.hypot(this.W, this.H) * 0.72;
            g.save();
            g.globalCompositeOperation = "lighter";
            g.globalAlpha = (1 - k) * 0.8;
            g.strokeStyle = "#ffffff";
            g.lineWidth = 6 * (1 - k) + 1.5;
            g.beginPath();
            g.arc(s.x, s.y, r, 0, 6.2832);
            g.stroke();
            g.strokeStyle = "#ffb347";
            g.lineWidth = 12 * (1 - k) + 2;
            g.globalAlpha = (1 - k) * 0.35;
            g.beginPath();
            g.arc(s.x, s.y, r * 0.9, 0, 6.2832);
            g.stroke();
            g.restore();
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
        // Enemy bullets used to be one shape in one colour, so a curtain shot
        // drifting at 2.2 px/frame and a sniper round at 5.2 looked identical
        // and asked for opposite answers. The colour and the size now come from
        // EB_KINDS: what a bullet is doing is legible from across the arena.
        for (const b of this.ebullets) {
            const kd = EB_KINDS[b.k || 0] || EB_KINDS[0];
            const frozen = this.freezeT > 0;
            g.fillStyle = frozen ? "rgba(94,225,255,0.3)" : rgba(kd.c, 0.34);
            g.beginPath();
            g.arc(b.x, b.y, kd.r, 0, 6.2832);
            g.fill();
            g.fillStyle = frozen ? "#d8f8ff" : kd.h;
            g.beginPath();
            g.arc(b.x, b.y, kd.cr, 0, 6.2832);
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
            g.fillStyle = rgba(col, 0.16);
            g.beginPath();
            g.arc(p.x, p.y + bob, p.r + 6, 0, 6.2832);
            g.fill();
            g.restore();
            // The capsule carries the glyph drawn in the pixel grid itself.
            drawSprite(g, "pup" + p.t, p.x, p.y + bob, { tint: col, px: PUP_PX });
        }
        // Under the living hulls: a wreck is scenery, and a drone flying over
        // one must not be hidden by it.
        for (const w of this.wrecks) {
            if (w.kit) {
                drawFryWreck(g, w);
            } else {
                drawDroneWreck(g, w);
            }
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

    /**
     * Everything the upgrade screen draws from, in one object. It is built the
     * same way on host and guest: the phase packet plus the local ship's own
     * perks and summed modifiers, so nothing here needs simulating.
     *
     * @returns {Object|null}
     */
    _perkModel() {
        const ph = this.perkPhase;
        if (!ph) {
            return null;
        }
        const sp = this.ships.find((s) => s.slot === this.localSlot);
        const offers = ph.offers[this.localSlot] || [];
        const picked = ph.picks[this.localSlot];
        return {
            W: this.W,
            H: this.H,
            wave: this.wave,
            t: ph.t,
            tMax: PERK_TIMEOUT,
            offers,
            picked: picked == null ? null : picked,
            hover: this._perkHover(offers),
            timedOut: this.perkTimedOut,
            owned: sp ? sp.perks.map((id) => PERKS[PERK_INDEX[id]]).filter(Boolean) : [],
            ownedIds: sp ? sp.perks : [],
            sums: sp ? sp.mods : BASE_MODS,
            bases: MOD_BASES,
            actives: sp ? sp.actives.length : 0,
            chips: this.ships.map((s) => ({
                label: "P" + (s.slot + 1),
                picked: ph.picks[s.slot] != null,
                me: s.slot === this.localSlot,
            })),
            pending: this.ships.filter((s) => ph.picks[s.slot] == null).length,
        };
    }

    /** Which card the pointer is over, or -1. Cheap: it re-runs the layout. */
    _perkHover(offers) {
        if (!this._hover || !offers.length || this.perkPhase.picks[this.localSlot] != null) {
            return -1;
        }
        for (const c of this._perkCards()) {
            if (
                this._hover.x >= c.x && this._hover.x <= c.x + c.w &&
                this._hover.y >= c.y && this._hover.y <= c.y + c.h
            ) {
                return c.i;
            }
        }
        return -1;
    }

    /**
     * Geometry of the cards offered to the local slot. The layout is measured
     * from the text at the live card width, and this is the same array the
     * screen paints from -- a card can never be clickable somewhere it is not
     * drawn, which is the defect the study was written against.
     */
    _perkCards() {
        const ph = this.perkPhase;
        if (!ph) {
            return [];
        }
        const offers = ph.offers[this.localSlot] || [];
        if (!offers.length) {
            return [];
        }
        // `_perkHover` is not called here: it would recurse through layout.
        return this.perkUI.layout(this.g, { W: this.W, H: this.H, offers }).cards;
    }

    _renderPerkChoice() {
        const m = this._perkModel();
        if (!m) {
            return;
        }
        this.perkUI.draw(this.g, m);
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
        g.fillStyle = pct < COLOSSUS_RAGE_AT ? "#ff6b6b" : d.tint;
        g.fillRect(x, y, w * pct, 9);
        g.strokeStyle = "rgba(255,255,255,0.25)";
        g.lineWidth = 1;
        g.strokeRect(x, y, w, 9);
        // Where the second phase starts. A threshold you can see coming is a
        // thing you can prepare for; the bar quietly turning red was not.
        g.fillStyle = "rgba(255,255,255,0.55)";
        g.fillRect(x + w * COLOSSUS_RAGE_AT - 1, y - 3, 2, 15);
    }

    /**
     * The bottom edge and the two bottom corners: the local player's vitals
     * band, a crew tag for everyone else, the actives and the capsules. Named
     * for the block it used to be -- it is the whole below-the-fold HUD now.
     *
     * The perks owned came out of here. Sixteen dots nobody reads mid-pattern
     * were the largest single thing the HUD put over the field, and the two
     * moments a player actually thinks about their perks -- the Esc overlay and
     * the wave-clear pick -- both already list them.
     */
    _renderPerkHud() {
        const g = this.g;
        const W = this.W;
        const H = this.H;
        const me = this._shipBySlot(this.localSlot);
        if (me) {
            drawVitals(g, me, W, H, this.frame, this._maxBombs(), me.reviveProgress / REVIVE_FRAMES);
            const top = drawActives(g, me, W, H, (a) => {
                const perk = PERKS[PERK_INDEX[a.id]];
                return perk ? perk.tint : null;
            });
            drawBuffs(g, me, W, this.frame, BUFF_KEYS, PUP_BUFFS, top);
        }
        // Everyone else, stacking up the bottom-left corner. Three at most:
        // past that a tag is worth less than the field it covers.
        let n = 0;
        for (const sp of this.ships) {
            if (sp.slot === this.localSlot || n >= 3) {
                continue;
            }
            drawCrewTag(g, sp, 12, H - 12 - 16 - n * 20, sp.reviveProgress / REVIVE_FRAMES);
            n++;
        }
    }

    _renderHud() {
        const g = this.g;
        const W = this.W;
        const H = this.H;
        g.textBaseline = "middle";
        if (this.state === "playing" || this.state === "over" || this.state === "perk") {
            // Everything above the fold, in priority order outward from the
            // ship: the combo on the top edge, then the corners. The old block
            // of player names, hearts and buff letters in the top right is
            // gone -- a name is only worth drawing when it belongs to someone
            // else, and that is what the crew tags are for.
            drawEscPip(g);
            drawCombo(g, this.combo, this.comboT, 170, W, this.frame);
            const me = this._shipBySlot(this.localSlot);
            let meta = "W" + this.wave + "  " + NeonStrikeEngine.formatTime(this.playSeconds());
            if (me) {
                // Graze as progress towards the next combo step rather than a
                // running total: the total is not a thing anyone acts on, and
                // this is the number that changes how you fly into a pattern.
                meta += "  G" + (me.graze % GRAZE_PER_COMBO) + "/" + GRAZE_PER_COMBO;
            }
            drawMeta(g, this.score, (this.practice ? "PRACTICE  " : "") + meta, W);
            this._renderPerkHud();
            this._renderColossusBar();
        }
        // Nothing is drawn for `paused`: the Esc overlay owns that moment now,
        // and it owns it in the DOM, where the text it wants to show wraps.
        // The engine still freezes -- `_loopFn` returns before anything ticks.
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
            g.fillText("Drag to move · auto fire · SPACE dash · X bomb", W / 2, H / 2 - 16);
            g.fillText("Hold SHIFT to focus: slow, precise, and it shows your hitbox", W / 2, H / 2 + 8);
            g.fillText("Every 5 waves you keep 1 of 3 permanent upgrades", W / 2, H / 2 + 32);
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
        if (k === "x" || k === "b") {
            this.audio();
            this._localAction("bomb");
            e.preventDefault();
            return;
        }
        if (k === "shift") {
            // Held, unlike everything else here. On host/solo `update()` reads
            // the key directly every frame; a guest has no channel for a held
            // input, so it sends the press and the release as two edges.
            // `e.repeat` matters: auto-repeat would otherwise flood the bus.
            if (this.role === "guest" && !e.repeat) {
                this._localAction("focus1");
            }
            return;
        }
        if (digit >= 1 && digit <= MAX_ACTIVES) {
            this.audio();
            this._localAction("act" + (digit - 1));
        }
    }

    _keyUp(e) {
        const k = (e.key || "").toLowerCase();
        this.keys[k] = false;
        if (k === "shift" && this.role === "guest") {
            this._localAction("focus0");
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
