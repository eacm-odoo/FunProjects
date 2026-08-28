/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - flight and combat animation for the colossal bosses.
 *
 * Ported from the design studies for AEGIS-01 (the Study, then the Animation
 * Sheet that reworked it), for HYDRA-07 and for VULCAN (each its own Animation
 * Sheet), which arrived already respecting the render-only contract. Same shape
 * as `boss_animator.js`, one size up. Three of the five colossi are covered;
 * the other two fall through to the plain hull draw until they get a section of
 * their own (`COLOSSUS_ANIM_KINDS` is what decides).
 *
 * The sheet's one big idea is the **brightness ramp**: an effect never mixes a
 * colour, it promotes the pixel it lands on along the sprite bank's own palette
 * (see RAMP below). A slab 850 px wide covered in additive light stops reading
 * as pixel art after the second overlay; promotion cannot put a tone on screen
 * that the hull does not already have. Only the two effects that are glows
 * *around* the hull rather than on it (the enrage charge and its ring) are
 * still additive.
 *
 * Five deliberate departures from the studies:
 *
 *   1. **The hull stays the module's.** They shipped their own procedural grid
 *      (92x28, then 42x13) and painted it cell by cell. `colossus0` already
 *      exists in `sprites.js` with the ten-index palette where 4/5/6 are the
 *      tint, and it is what the glossary shows. So the hull is the cached
 *      raster, and only the cells an effect actually changes are painted on top
 *      of it -- and only when the promotion lands on a different rung, so the
 *      whole animation costs ~160 `fillRect`s in an average frame.
 *   2. **No lance.** The study gave AEGIS an eye that fires a 1100 px column of
 *      light at a ship. The engine has no such attack, and drawing a beam with
 *      no hitbox shows light where the damage is not -- the same reason
 *      `boss_animator.js` refused the LANCER beam. Note what this rule does
 *      *not* say, because the VULCAN pass first read it too widely: a beam the
 *      engine already owns, telegraphs and damages with may absolutely be given
 *      the sheet's own look. There is no light without damage there -- it is the
 *      same beam, better drawn (see `_drawForgeBeam` in `game_engine.js`).
 *   3. **No hit flash.** A colossus is under fire every frame, so that leaves
 *      it permanently washed out; the hit feedback stays the white burst at the
 *      point of impact plus the top bar.
 *   4. **The enrage beat is an envelope, not an observed flag.** `e.hold` does
 *      not travel in the snapshot, so `charge` runs off the `rage` cue for the
 *      50 frames `_bossRage` holds fire. Same beat on host and guest, no new
 *      bytes on the bus.
 *   5. **No state machine, and no DEATH.** The sheet drives itself through
 *      ENTRY/IDLE/LEAN/PLANT/CURTAIN/SALVO/STAGGER/DEATH and spawns its own
 *      bullets from it. Here the engine owns all of that: every one of those
 *      beats is *observed* (the plant from `tel`, the salvo from the cue, the
 *      stagger from `hp01`) so the animation cannot disagree with the fight.
 *      DEATH is dropped outright: it would need the corpse to outlive
 *      `killEnemy`, which is gameplay, not animation.
 *
 * HYDRA-07 arrived as a second sheet, and it did not describe the boss the
 * engine had: destructible side heads, attacks that take turns before the rage
 * and run together after it, a wind-up on the spiral and staggered fans were
 * all in the sheet and none of them in `_updateColossus`. That went the other
 * way round from AEGIS -- **the engine moved to meet the sheet** (see `_hydra`
 * and HYDRA_HEAD there), and what is left here is the animation of a boss that
 * now really does all of it. Only one thing was refused outright:
 *
 *   6. **Nothing moves that a cached raster cannot move.** The sheet redraws
 *      its monster every frame, so its heads swing on bezier arms and their
 *      snouts rotate to aim. Here a head says where it is looking by *where
 *      the light sits inside it* -- the promoted disc slides towards the ships,
 *      exactly as AEGIS's core slides with the lean -- the destroyed one goes
 *      dark and sparks at the stump instead of hanging from it, and the recoil
 *      is the whole hull, as it is for the siege salvo.
 *
 * The sheet's actual idea survived whole: three parts on beats of their own, so
 * the hull never pulses as one lamp; a crown whose ring of light turns with the
 * spiral it is firing and, during the wind-up, runs a single arc *the way the
 * coming spiral will turn*; and two heads that light, open and flash a beat
 * apart, because the stagger is the thing that makes two aimed cones readable.
 *
 * VULCAN arrived as the third sheet, and it went the HYDRA way again: it
 * described a **heat cycle** the engine did not have (see the VULCAN block in
 * `game_engine.js`), so the engine moved to meet it. What is animation here is
 * the one thing the sheet is emphatic about -- that the player must be able to
 * read the heat by looking at the boss and not at a HUD -- and the hull turns
 * out to have exactly the art for it. `colossus2` paints its slot as three
 * concentric layers, and on this ramp each one can say something the others
 * cannot: the dark frame has six rungs of headroom and is the gauge, the neon
 * ring has two and carries the top of it by making the white middle visibly
 * *grow*, and the white middle has none at all and so takes no part -- it is
 * already at the top of the ramp. Trying to use it as the cold end of the gauge
 * is what the trough test in this port caught: it repainted 106 cells on every
 * idle frame and left VULCAN never once looking like its own sprite.
 *
 * Two more things fell out of the art the way the nozzles and the heads did:
 * the **six chimneys** are the narrow stacks that rise above the top edge (the
 * exact mirror of the nozzle rule, which reads the columns that hang below the
 * bottom one), and the **two fans** are the accent blobs the slot is not made
 * of -- every other hull in the bank paints its accent as single cells or
 * one-row bars, so "blob away from the core" is the whole test. The fans are
 * the fight's lever, so `hullParts` hands the engine their *housing* rather
 * than the blade, and the animator lights exactly that radius: what you can
 * shoot and what lights up stay one answer. The **arms** are the two connected
 * masses of metal on the flanks -- VULCAN breaks into exactly two, AEGIS into
 * four and NYX into six, which is what makes the count the test -- and the
 * **hand** at the end of each is its outer-bottom corner. The beams leave from
 * there: the same correction the AEGIS salvo got, and the art had a better
 * answer than any fraction of the width at +/-0.482, right where the silhouette
 * ends. Getting the two hands *symmetric* needed one more line than expected,
 * because the sprite is mirrored but a flood fill's visit order is not.
 *
 * Three departures of its own:
 *
 *   7. **No four legs.** The sheet walks on four, swinging each one on its own
 *      timer. The hull has two feet and is one cached raster, so the walk is
 *      the *hull* -- a bob and a settle quantised to whole cells, plus the foot
 *      that just landed lighting up and throwing dust. The gait runs off
 *      distance travelled rather than a clock, which is what makes it slow into
 *      every reversal and stop dead while the feet are planted for free.
 *   8. **No DEATH, again**, so the chimneys bursting one by one has no home;
 *      the same idea is re-homed onto the one failure the engine does own, and
 *      the stacks stop smoking one at a time as the hull is chewed down. The
 *      smoke itself is the sheet's: **particles**, emitted from `observe` off
 *      this animator's own LCG, that rise, keep rising as they slow, drift and
 *      fade. A fixed-height plume was tried first and reads as a bar chart of
 *      the heat rather than as exhaust -- and, at 35 cells at rest against the
 *      puffs' 8, it was the more expensive of the two as well.
 *   9. **No fan hitbox of the sheet's making.** Its fans are a debug toggle
 *      with no rule behind them. Here they have hull points, they buy heat in
 *      proportion to the damage spent on them, and breaking one seizes it --
 *      which is gameplay, and lives in `game_engine.js` where it belongs.
 *
 * Everything else is **render only**: the engine (or, on a guest, the host
 * snapshot) owns position, hull points, every bullet and the telegraph. This
 * reads state that already travels -- x, y, hp01, tel, telK, `gap` (the hole in
 * the *next* curtain), the crown's angle and whether it is emitting (`sa`,
 * `sp`), the side heads (`hd`), VULCAN's heat, phase, volley count and fans
 * (`ht`, `vp`, `vn`, `vf`) and where the live ships are -- and derives the rest
 * from observed motion. Three of HYDRA's states cost no cue at all, and so do
 * three of VULCAN's: a part's hull points travel, so a drop is a hit, zero is a
 * destroyed head or a seized fan, and the countdown under it is the rebuild.
 *
 * State cannot live on the enemy object: a guest rebuilds `this.enemies` from
 * scratch on every snapshot, so the engine keeps these animators in a map keyed
 * by colossus index and feeds them (see `_updateColossusAnims`).
 */

import { palette, sprite, spriteGrid } from "./sprites";

/**
 * The brightness ramp, dark to bright, in sprite bank palette indices:
 * dark hull, dark accent, mid hull, dark tint, metal, TINT, light tint, glass,
 * hot white. The neon accent (8) shares the tint's rung, so the strip along the
 * shoulder flares with the plating instead of against it.
 *
 * Effects do not add a rung, they pull a cell a fraction of the way to the top
 * (or, negative, back down towards the dark hull). Rung counting would make an
 * effect land differently on every cell it crosses -- lighting the bottom edge
 * of AEGIS by "+2" barely moves its dark plating while blowing out the glass
 * two rows above it.
 */
const RAMP_CHARS = ["1", "9", "2", "5", "3", "4", "6", "7", "0"];
const RUNG = { 1: 0, 9: 1, 2: 2, 5: 3, 3: 4, 4: 5, 8: 5, 6: 6, 7: 7, 0: 8 };
const TOP = RAMP_CHARS.length - 1;

/** Hull cells the damage burns out: mid hull and metal, never the tint. */
const DEAD_CHARS = "23";
/** Hull cells that make up the core window: glass and hot white. */
const CORE_CHARS = "70";
/** The neon accent: the one index the sprite bank paints magenta on any hull. */
const ACCENT_CHAR = "8";
/** Dark accent: the index the frame of VULCAN's slot (and its feet) is drawn in. */
const DARK_ACCENT_CHAR = "9";
/** Metal: the index VULCAN's chimneys and its two side arms are drawn in. */
const METAL_CHAR = "3";
/**
 * The three rungs that are shades of the hull's own tint (5 dark, 4 flat, 6
 * light). They belong on any hull whether or not the art happens to use them;
 * every other rung is a fixed colour, and one the art never uses has no
 * business appearing under an effect (see `rungs` in `hullGeometry`).
 */
const TINT_RUNGS = [RUNG[5], RUNG[4], RUNG[6]];
/**
 * How far out of a part's own ellipse the ring of light sits: past this it is
 * the plating around the face, under it the face itself. 0.62 on HYDRA's crown
 * takes the horns, the sides and the collar and leaves the two eyes alone.
 */
const RING_INNER = 0.62;
/**
 * How far around its mouth a side head reaches, in multiples of the mouth's own
 * radius. 3 takes HYDRA's skull and wrist and stops at the forearm, which is
 * what the hitbox in `game_engine.js` is cut from -- so what you can shoot and
 * what lights up are the same cells, read from the same art.
 */
const HEAD_SPAN = 3;
/**
 * A chimney is a *narrow* stack rising above the hull's top edge: at most this
 * fraction of the hull's width and at least CHIM_MIN_H cells tall. Both tests
 * are what make the rule specific to a hull that really has stacks -- without
 * them AEGIS's shoulder (28 of 92 columns) and HYDRA's whole crown (52 of 92)
 * come back as one enormous chimney. On VULCAN it finds exactly the six the art
 * is drawn with, in three heights.
 */
const CHIM_MAX_W = 0.12;
const CHIM_MIN_H = 3;
/**
 * A fan is a *blob* of the neon accent away from the core window: this many
 * cells at least, spanning at least FAN_MIN_SPAN in both directions. Every
 * other hull in the bank paints its accent as single cells (AEGIS's shoulder
 * lights, OMEGA's rim) or as one-row bars (HYDRA's chest grilles), so the two
 * tests are the whole difference between "this hull has fans" and "this hull
 * has an accent". VULCAN's are 11 cells in a 5x3 box, one per shoulder.
 */
const FAN_MIN_CELLS = 6;
const FAN_MIN_SPAN = 3;
/**
 * How far out of the accent blade the fan's housing reaches, in cells. The
 * blade alone is 5x3 cells -- 48x29 px on an 800 px hull, a finer target than
 * anything else in the game -- and the fans are the *lever* of the whole fight,
 * so they have to be hittable. 2 cells makes the pod 9x7 (86x67 px, in the same
 * class as HYDRA's side heads), and the animator lights exactly this radius, so
 * what you can shoot and what lights up stay one answer.
 */
const FAN_PAD = 2;
/**
 * An arm is a connected mass of plating hanging off the flank, under the top
 * edge, and a hull only has arms when it breaks into **exactly two** of them,
 * mirrored, each at least this share of the hull's cells. Both halves of the
 * test earn their keep: AEGIS breaks into four such masses (its nozzle
 * clusters) and NYX into six, so the count is what says "arms" rather than
 * "plating"; and at 118 cells each VULCAN's are four times the size of AEGIS's,
 * so the share is an independent guard on the same answer.
 */
const ARM_MIN_SHARE = 0.04;
/** How far around its hand an arm lights when the forge fires, in cells. */
const HAND_R = 2.5;

/**
 * Reference speeds are the ones `aegis_motion.js` actually produces, measured
 * over a full 120 s fight: |v| peaks at 58 px/s (36 calm, 54 raged, more only
 * during the enrage shove) and a tick never moves the hull by a whole pixel.
 * On a guest the same positions arrive rounded to whole px at ~15 Hz, which is
 * why the derived velocity is smoothed hard rather than used raw.
 */
export const COLOSSUS_ANIM = {
    global: {
        velRefPx: 60,       // px/s that maps to |vx01| = 1
        velSmooth: 9,       // 1/s exponential ease on the derived velocity
        boolIn: 11,         // 1/s rise for a boolean eased into 0..1
        boolOut: 5,         // 1/s fall
        teleportPx: 24,     // a bigger step is a teleport: drop the velocity
        maxDt: 0.1,
        maxSparks: 48,      // hard cap on cosmetic particles
    },
    AEGIS: {
        breathe: { amp: 0.012, rate: 0.85, loadTilt: 0.35 },
        // The lean has two terms because the drift alone is not a pose: AEGIS
        // is stationary 95% of the fight (|v| p50 0.5 px/s, p95 13 px/s -- the
        // 54 px/s peak only happens on the enrage shove), so a lean driven by
        // velocity is invisible exactly when the catalogue promises "it leans
        // toward whoever is still flying". `aimGain` is that promise: the hull
        // tips towards the centre of mass of the live ships, which both roles
        // already have. `aimSpanPx` is a flank of the widened field.
        lean: { maxRad: 0.028, velGain: 1, aimGain: 0.7, aimSpanPx: 300, aimSmooth: 2.2, smooth: 6 },
        recoil: { px: 14, fall: 3.2 },
        barrel: { life: 0.22, rows: 3, lift: 1 },
        curtain: { sweepSec: 0.3, rows: 2, tail: 0.28, lift: 0.9 },
        // The shutter that announces the hole in the next curtain. 7 cells is
        // 63 px against the 124 px the pattern actually skips, deliberately
        // narrower for the same reason the telegraph mark is: what it points
        // at is always safe.
        port: { wCells: 7, top: 7, bottom: 19, bloomCells: 2, lift: 0.62, flicker: 0.28 },
        // The brace: the whole hull answering a telegraph, not just the shutter
        // lighting up. `aegis_motion.js` already stops the slab for the 0.75 s
        // of a curtain warning; this is what that stop looks like.
        plant: { squareUp: 0.55, judderCells: 1, judderHz: 6.5, emitDrop: 0.7 },
        // The core window (the glass lens at the centre of the hull). It
        // breathes, it saturates as an attack is charged, it is pushed towards
        // the side the slab leans to, and it goes cold as the hull fails --
        // AEGIS reads at a glance from a single bright shape.
        //
        // These numbers are set against the ramp, not carried over: the lens is
        // glass, one rung under white, so a cell only changes at all above
        // k = 0.5, and the study's 0.18..0.50 breath was a pulse that never
        // once lit a pixel. 0.5..0.9 crosses that line inside the lens and the
        // distance falloff turns the crossing into a ring growing from the
        // middle. `jitter` has to reach past 0 for the same reason: only a
        // negative k can push glass back down to metal.
        core: { base: 0.5, pulse: 0.4, rate: 0.55, sat: 0.5, squeeze: 0.34,
                biasCells: 2.4, flashSec: 0.12, jitter: 1, dim: 1.2 },
        // Plumes hang off the four nozzle clusters the hull actually has (the
        // only columns that reach below its bottom edge), the outer pair phase
        // shifted against the inner one so the slab never pulses as one lamp.
        emitters: { period: 0.77, amp: 0.45, idle: 0.45, outerPhase: 0.5,
                    maxCells: 5, tiltCells: 2, jitter: 0.35, velGain: 1 },
        damage: {
            start: 0.3,     // hp01 under which the hull starts failing
            shakePx: 5, shakeHz: 17,
            deadCells: 30,  // % of the hull's dark cells burnt out at 0 hull
            ventRate: 9, sparkLife: 0.55, sparkSpeed: 26,
        },
        // The arrival. `_updateColossus` slides the hull down at 78 px/s and
        // AEGIS never moves vertically faster than ~20 px/s once it is flying,
        // so the descent is the one thing a velocity threshold can name without
        // a byte on the bus. `landed` latches it: it can only ever happen once.
        entry: { vy: 45, span: 33, burn: 0.9 },
        // 0.83 s: the 50 frames `_bossRage` holds fire on a colossus.
        rage: { holdSec: 0.83, flareSec: 0.9, ringCells: 6 },
        charge: { max: 0.55, bands: 12, falloff: 1.4 },
    },
    HYDRA: {
        breathe: { amp: 0.013, rate: 0.7, loadTilt: 0.4 },
        // HYDRA actually travels -- a flat 38 px/s across a 210 px lane, with
        // the direction flipping at the ends -- so unlike AEGIS the drift is
        // the main term of the lean and the pull towards the ships only tips
        // it. The catalogue promises the *heads* aim, not the hull.
        lean: { maxRad: 0.032, velGain: 1, aimGain: 0.25, aimSpanPx: 320, aimSmooth: 2.6, smooth: 5 },
        recoil: { px: 11, fall: 3.6 },
        // HYDRA telegraphs one thing (the fan), so the brace *is* the wind-up:
        // the hull judders, the crown saturates and both mouths open on it.
        plant: { squareUp: 0.25, judderCells: 1, judderHz: 7.5, emitDrop: 0 },
        // The crown lens, on the same machinery as AEGIS's core window and set
        // against the same ramp: the eyes are glass around a white middle, so
        // nothing repaints at all under k = 0.5, and the idle breath is tuned
        // to cross it only near its peak. At rest the crown is exactly the
        // sprite; it blinks once every 2.7 s. `squeeze` is 0 because HYDRA's
        // lens has no charge to shrink for -- the crown never stops firing.
        core: { base: 0.4, pulse: 0.22, rate: 0.37, sat: 0.35, squeeze: 0,
                falloff: 0.45, biasCells: 1.6, flashSec: 0, jitter: 0.9, dim: 1.1 },
        // The ring of light on the crown's plating, turning with the spiral.
        // `cut` is what keeps it arcs instead of a halo: at 0.6 each of the two
        // arms lights ~68 deg of the ellipse (~48 with the third arm of the
        // enrage), and the square falloff puts the bright end of the arc on the
        // cells the bullets are leaving from.
        // The ring of light on the crown's plating. It only burns while the
        // crown is actually emitting; during the wind-up it runs a single arc
        // around the ring instead, *in the direction the coming spiral turns*,
        // which is the one thing the warning has to say.
        ring: { lift: 0.8, cut: 0.6, rageLift: 0.15,
                warnLift: 0.7, warnCut: 0.72, seqRate: 1.6, idle: 0.12 },
        // The side heads. Different rates half a period apart, which is the one
        // thing from the sheet that had to survive even though neither head can
        // move: three parts that never light together. `openCells` is the mouth
        // opening -- the promoted disc grows past the glass into the plating as
        // the fan winds up -- and `biasCells` is the only aiming a cached
        // raster can do.
        heads: { idle: 0.16, pulse: 0.5, rate: [0.31, 0.35], phase: [0, 0.5],
                 charge: 0.55, rage: 0.12, falloff: 0.35, openCells: 2.2,
                 biasCells: 1.8, aimSpanPx: 260, aimSmooth: 3.2, dim: 1,
                 flashSec: 0.16, flameCells: 4, flameTilt: 2,
                 // Local damage: 4 frames of the hit head alone going white,
                 // while the other two parts carry on. A colossus has no hull
                 // flash on purpose (it is under fire every frame); a part you
                 // have to deliberately fly out and shoot is the one place the
                 // feedback belongs.
                 hurtSec: 0.07,
                 // Destroyed: pulled this far back *down* the ramp, which is
                 // the only direction that reads as "off" on art this dark.
                 dead: 0.62, stumpRate: 13, stumpCells: 3,
                 // The rebuild grows out of the stump with a lit front, and the
                 // eyes are the last thing to come back.
                 growFront: 0.18, growLift: 0.8, eyesAt: 0.7 },
        // The chest grilles: the four bars the sprite already paints in the
        // neon accent. They ripple down the chest once per turn of the spiral,
        // which is the only thing the chest ever says about what the crown is
        // doing, and they drop away while the heads are winding up.
        vents: { idle: 0.08, amp: 0.46, rowPhase: 1.1, rage: 0.3, plantDrop: 0.5 },
        damage: {
            start: 0.3,
            shakePx: 5, shakeHz: 17,
            // Lower than AEGIS's 30: HYDRA's chest is 412 cells of mid hull
            // against AEGIS's 340 of mid hull and metal, so the same percentage
            // puts noticeably more of the silhouette out.
            deadCells: 24,
            ventRate: 9, sparkLife: 0.55, sparkSpeed: 26,
        },
        // Same descent as AEGIS: `_updateColossus` slides every colossus in at
        // 78 px/s, and HYDRA never moves vertically again once it is in its
        // lane, so the threshold names the arrival without a byte on the bus.
        entry: { vy: 45, span: 33 },
        // 0.83 s: the 50 frames `_bossRage` holds fire. HYDRA rears up over
        // that beat instead of AEGIS's shove, and settles as the guns come back.
        rage: { holdSec: 0.83, flareSec: 0.9, ringCells: 6, archPx: 9 },
        charge: { max: 0.5, bands: 12, falloff: 1.2 },
    },
    VULCAN: {
        breathe: { amp: 0.009, rate: 0.5, loadTilt: 0.5 },
        // VULCAN walks its lane at 25 px/s and never presses the ships (see
        // `vulcan_motion.js`), so unlike AEGIS the drift is the *only* term of
        // the lean and `aimGain` is 0 on purpose: the catalogue promises a
        // machine that shoots the arena, not one that tracks you. `velRefPx` is
        // 60, so |vx01| peaks at 0.42 and the shear peaks near 0.013 rad.
        lean: { maxRad: 0.03, velGain: 1, aimGain: 0, aimSpanPx: 300, aimSmooth: 2.2, smooth: 4 },
        recoil: { px: 16, fall: 3 },
        // The walk. It runs off *distance travelled*, not a clock: the cadence
        // then slows into every reversal and stops dead while the feet are
        // planted, with no extra state and nothing on the bus -- and a guest,
        // whose x arrives rounded at ~15 Hz, still accumulates the same total.
        // 22 px per footfall against a 25 px/s cruise is a step every 0.88 s,
        // which is what a hull 800 px wide should feel like.
        gait: { stridePx: 22, bobCells: 1, settleCells: 1.2, settleRate: 3.4,
                dustCells: 3, dustSpread: 2.4, footLift: 0.5, limpRad: 0.018 },
        // The slot, read as the three concentric layers the art paints, because
        // on this ramp they are the only way a hull can show a level at all:
        //
        //   frame  dark accent, rung 1, six rungs of headroom -- the gauge. Its
        //          fourth is the bank's fixed grey-blue, so the drive is capped
        //          under it: 0.34 lights violet at heat 0.22 and warm brown at
        //          0.63 and never puts grey on an orange hull.
        //   ring   neon accent, rung 5: light tint at k = 0.17, white at 0.5.
        //          0.62 puts those at heat 0.27 and 0.81, so the top of the
        //          gauge is the white middle visibly *growing* from 18 cells
        //          wide to 28 -- the only way a window already at the top of
        //          the ramp can read as "more open".
        //   glass  the white middle, rung 8. It cannot brighten at all, so it
        //          takes no part in the gauge: `coldDip` is only ever used for
        //          the arrival and to cut the volley pips out of it. It was
        //          tried as the cold end of the same gauge -- the middle pulled
        //          down to light tint at rest -- and that is the trough mistake
        //          the AEGIS port is a monument to: it repainted 106 cells on
        //          every idle frame and left VULCAN never once looking like its
        //          own sprite. The art is the baseline; heat only ever adds.
        slot: { frame: 0.34, ring: 0.62, coldDip: -0.26, falloff: 0.3,
                openRate: 3.2, ventLift: 0.62, enterDim: 0.5 },
        // The two shoulder fans. `idle` has to stay under the metal's first
        // rung (0.125) or the pod sits permanently one rung brighter, which is
        // not a fan turning over but a hull that is wrong; the pulse is what
        // crosses it. `blade` is the bright spot orbiting inside the pod, which
        // is the only way a cached raster can spin anything.
        // `pulse` peaks at 0.21, which is the first thing that matters: the
        // accent blade sits on the tint's rung and only repaints past 0.17, so
        // a smaller pulse left the pods painting 2 cells at idle and the lever
        // of the whole fight was invisible. The trough is still 0.05, under the
        // metal's first step at 0.125, so the pod does fall all the way back to
        // the sprite -- which is what makes it a breath and not a hull that is
        // permanently one rung brighter.
        fans: { idle: 0.05, pulse: 0.16, rate: [0.9, 1.05], phase: [0, 0.5],
                heat: 0.4, vent: 0.5, rage: 0.08, falloff: 0.45, dim: 1,
                blade: 0.5, bladeCold: 0.3, bladeR: 0.5,
                spinIdle: 0.3, spinHeat: 1.5, spinVent: 2.4,
                flashSec: 0.18, flameCells: 3,
                // Local damage: the fans are the lever, so a hit on one has to
                // be visible on that fan alone. Same four frames HYDRA's heads
                // get, and for the same reason.
                hurtSec: 0.07,
                // Jammed: pulled back down the ramp (the only direction that
                // reads as "off"), sparks at the rim, and the clearing grows
                // back the way a rebuilt head does.
                jam: 0.5, stumpRate: 11, stumpCells: 2,
                clearFront: 0.2, clearLift: 0.75 },
        // Smoke off the six stacks. Denser with heat, and the stacks go out one
        // by one as the hull fails -- the sheet blows them up in its DEATH
        // state, which this port has no room for (see the header), so the same
        // idea is re-homed onto the one failure the engine actually owns.
        // Smoke off the six stacks, as **particles** rather than a plume of
        // fixed height. The plume came first and was wrong: a column of cells
        // that grows and shrinks reads as a bar chart of the heat, not as
        // exhaust. The sheet pushes puffs that rise, keep rising (its `g` is
        // negative), drift sideways and fade over ~80 frames, and that is what
        // actually looks like a foundry working. Fed from `observe` off the
        // animator's own LCG, so the draw never consumes simulation noise and
        // host and guest emit the same puffs.
        // Rates and speeds set against the hull, not the sheet's 220 px canvas:
        // at 2.1 cells/s the smoke climbed 5 cells, i.e. 48 px over a boss 324
        // px tall, which is a wisp rather than a foundry. 5.5 cells/s over a
        // ~2.4 s life clears 9-10 cells (~90 px). The whole layer costs 1-2
        // `fillRect`s per puff, which is why it can afford to be this dense --
        // the fixed-height plume it replaced cost 35 at rest and 150 at full
        // overheat on its own.
        smoke: { idle: 3.5, heat: 12, overheat: 6,    // puffs per second, all six
                 rise: 5.5, riseVar: 3, drift: 1.4, slow: 0.5,
                 life: 1.8, lifeVar: 1.2, spread: 1.6,
                 fat: 0.5,           // fraction of puffs drawn 2 cells wide
                 maxPuffs: 70, deadCells: 60 },
        // The hands at the ends of the two arms. `warn` is the sight line the
        // engine draws; this is the hand lighting up under it, and then burning
        // while the beam is live.
        forge: { warn: 0.4, live: 1, rows: 4 },
        // The brace, on VULCAN's own two telegraphs: the sheet vibrates the
        // hull through the overheat ("el casco vibra") and gives the volley
        // charge a recoil, and those are exactly the beats `ring` and `volley`
        // mark. `emitDrop` is unused (VULCAN has no plumes) but the block has
        // to be here, because `pose()` and `draw()` read it for every kind.
        plant: { squareUp: 0.4, judderCells: 1, judderHz: 8.5, emitDrop: 0 },
        // VULCAN draws no core window -- the slot is three layers on its own
        // machinery -- but `pose()` computes `core`/`coreBias` for every kind,
        // and `coreBias` is what slides the gauge towards the side the hull
        // leans to. So: a flat block that produces no light of its own.
        core: { base: 0, pulse: 0, rate: 0.4, sat: 0, squeeze: 0,
                biasCells: 1.6, flashSec: 0.12, jitter: 0, dim: 0 },
        // The overheat: light through the plating. Taken from the *end* of the
        // hull's stable dark-cell order so it cannot fight `_drawDamage`, which
        // burns them out from the front.
        crack: { cells: 14, lift: 0.85, rate: 19 },
        damage: {
            start: 0.3,
            shakePx: 5, shakeHz: 17,
            deadCells: 26,
            ventRate: 9, sparkLife: 0.55, sparkSpeed: 26,
        },
        entry: { vy: 45, span: 33 },
        rage: { holdSec: 0.83, flareSec: 0.9, ringCells: 6 },
        charge: { max: 0.5, bands: 12, falloff: 1.3 },
    },
};

/** Index into COLOSSI -> section above. A colossus with no section is drawn plain. */
export const COLOSSUS_ANIM_KINDS = ["AEGIS", "HYDRA", "VULCAN"];
/**
 * VULCAN's phases, mirroring the V_* constants in `game_engine.js`. The
 * animator only ever compares against these, so the two lists are the whole
 * coupling between the director and its animation.
 */
const V = { REST: 0, BEAM_WARN: 1, BEAM: 2, OVERHEAT: 3, VENT: 4, ROCK_WARN: 5, ROCKS: 6 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const smoothstep = (v) => v * v * (3 - 2 * v);

/** Pull a rung `k` of the way to hot white, or (k < 0) back down to dark hull. */
const lift = (rung, k) => (k >= 0 ? rung + (TOP - rung) * k : rung * (1 + k));

/** Stable 0..1 noise for a cell, so the burnt sections never crawl. */
function cellNoise(c, r) {
    const n = (((c * 73856093) ^ (r * 19349663)) >>> 0) % 100000;
    return n / 100000;
}

const geometry = new Map();

/**
 * Bounding box of a flat [c, r, c, r, ...] cell list, with the radii an effect
 * needs to talk about "the outer third" of it. Null for an empty list.
 */
function cellBox(cells) {
    if (!cells.length) {
        return null;
    }
    let c0 = Infinity;
    let c1 = -Infinity;
    let r0 = Infinity;
    let r1 = -Infinity;
    for (let i = 0; i < cells.length; i += 2) {
        c0 = Math.min(c0, cells[i]);
        c1 = Math.max(c1, cells[i]);
        r0 = Math.min(r0, cells[i + 1]);
        r1 = Math.max(r1, cells[i + 1]);
    }
    return {
        c0, c1, r0, r1,
        cx: (c0 + c1) / 2, cy: (r0 + r1) / 2,
        rx: (c1 - c0) / 2 + 0.5, ry: (r1 - r0) / 2 + 0.5,
    };
}

/**
 * The crown: everything above the shoulder line, provided there is glass up
 * there. Returns the cells, the lens (the glass) with the distance of each of
 * its cells to the middle of it, and the ring -- the plating outside
 * RING_INNER, carrying the *true* angle of each cell (not the ellipse-normalised
 * one), because the lit arc has to point where the spiral arms actually fly.
 */
function crownOf(grid, cols, rows) {
    const mid = cols >> 1;
    let shoulder = 0;
    for (let r = 0; r < rows; r++) {
        if (grid[r][mid] === ".") {
            continue;
        }
        let a = mid;
        while (a > 0 && grid[r][a - 1] !== ".") {
            a--;
        }
        let b = mid;
        while (b < cols - 1 && grid[r][b + 1] !== ".") {
            b++;
        }
        if (b - a + 1 >= cols * 0.4) {
            shoulder = r;
            break;
        }
    }
    const cells = [];
    const core = [];
    for (let r = 0; r < shoulder; r++) {
        for (let c = 0; c < cols; c++) {
            const ch = grid[r][c];
            if (ch === ".") {
                continue;
            }
            cells.push(c, r);
            if (CORE_CHARS.indexOf(ch) >= 0) {
                core.push(c, r);
            }
        }
    }
    const coreBox = cellBox(core);
    if (!coreBox) {
        return null;
    }
    const box = cellBox(cells);
    const ring = [];
    const ringA = [];
    for (let i = 0; i < cells.length; i += 2) {
        const c = cells[i];
        const r = cells[i + 1];
        if (CORE_CHARS.indexOf(grid[r][c]) >= 0) {
            continue;
        }
        const dx = (c - box.cx) / box.rx;
        const dy = (r - box.cy) / box.ry;
        if (Math.sqrt(dx * dx + dy * dy) <= RING_INNER) {
            continue;
        }
        ring.push(c, r);
        ringA.push(Math.atan2(r - box.cy, c - box.cx));
    }
    return { shoulder, cells, box, core, coreBox, ring, ringA };
}

/**
 * The side heads: the outer two of exactly three pieces the silhouette breaks
 * into under its widest row.
 *
 * The piece includes the forearm, which is not the head: `cells` is cut back to
 * what sits within HEAD_SPAN of the mouth, and that cut is the head everywhere
 * -- the cells an effect may light, the box `hullParts` hands the engine to
 * shoot at, and the mass that goes dark when it is destroyed. `stump` is where
 * that cut meets the arm, which is where the sparks come from and where the
 * rebuild grows back from; `sd` is every cell's distance from it, 0..1, so the
 * regrow can spread instead of switching on.
 */
function headsOf(grid, cols, rows) {
    let waist = 0;
    let widest = -1;
    for (let r = 0; r < rows; r++) {
        let n = 0;
        for (let c = 0; c < cols; c++) {
            if (grid[r][c] !== ".") {
                n++;
            }
        }
        if (n > widest) {
            widest = n;
            waist = r;
        }
    }
    let split = -1;
    for (let r = waist; r < rows && split < 0; r++) {
        let runs = 0;
        for (let c = 0; c < cols; c++) {
            if (grid[r][c] !== "." && (c === 0 || grid[r][c - 1] === ".")) {
                runs++;
            }
        }
        if (runs >= 3) {
            split = r;
        }
    }
    if (split < 0) {
        return null;
    }
    const seen = new Uint8Array(cols * rows);
    const parts = [];
    for (let r = split; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (grid[r][c] === "." || seen[r * cols + c]) {
                continue;
            }
            seen[r * cols + c] = 1;
            const stack = [c, r];
            const cells = [];
            while (stack.length) {
                const y = stack.pop();
                const x = stack.pop();
                cells.push(x, y);
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || nx >= cols || ny < split || ny >= rows
                                || grid[ny][nx] === "." || seen[ny * cols + nx]) {
                            continue;
                        }
                        seen[ny * cols + nx] = 1;
                        stack.push(nx, ny);
                    }
                }
            }
            parts.push({ cells, box: cellBox(cells) });
        }
    }
    if (parts.length !== 3) {
        return null;
    }
    parts.sort((a, b) => a.box.c0 - b.box.c0);
    const mid = cols >> 1;
    if (parts[1].box.c0 > mid || parts[1].box.c1 < mid) {
        return null;
    }
    return [parts[0], parts[2]].map((part, side) => {
        const glass = [];
        for (let i = 0; i < part.cells.length; i += 2) {
            if (CORE_CHARS.indexOf(grid[part.cells[i + 1]][part.cells[i]]) >= 0) {
                glass.push(part.cells[i], part.cells[i + 1]);
            }
        }
        const gbox = cellBox(glass) || part.box;
        const r = Math.max(gbox.rx, gbox.ry);
        const reach = r * HEAD_SPAN;
        const cells = [];
        for (let i = 0; i < part.cells.length; i += 2) {
            if (Math.hypot(part.cells[i] - gbox.cx, part.cells[i + 1] - gbox.cy) <= reach) {
                cells.push(part.cells[i], part.cells[i + 1]);
            }
        }
        const box = cellBox(cells);
        // The stump: the top corner of the head on the side the arm comes down
        // from, which is the inner one.
        const stump = { c: side ? box.c0 : box.c1, r: box.r0 };
        const sd = new Float32Array(cells.length / 2);
        let far = 1;
        for (let i = 0; i < cells.length; i += 2) {
            sd[i / 2] = Math.hypot(cells[i] - stump.c, cells[i + 1] - stump.r);
            far = Math.max(far, sd[i / 2]);
        }
        for (let i = 0; i < sd.length; i++) {
            sd[i] /= far;
        }
        return { cells, box, glass, gbox, r, stump, sd };
    });
}

/**
 * The chimneys: narrow stacks of plating rising above the hull's top edge.
 *
 * The exact mirror of the nozzle rule, which reads the columns that hang
 * *below* the bottom edge -- a stack is a run of columns whose highest cell is
 * above the first row wide enough to be the hull proper. CHIM_MAX_W and
 * CHIM_MIN_H are what keep it to a hull that really has stacks (see there).
 *
 * `outer` is set on the pair furthest from the centre line, so smoke can be
 * phase shifted the way AEGIS's plumes are: six stacks breathing as one lamp is
 * what a chimney must never look like.
 */
function chimneysOf(cols, highest, topEdgeRow) {
    const runs = [];
    for (let c = 0; c < cols; c++) {
        if (highest[c] < 0 || highest[c] >= topEdgeRow) {
            continue;
        }
        const last = runs[runs.length - 1];
        if (last && c - last.c1 <= 1) {
            last.c1 = c;
        } else {
            runs.push({ c0: c, c1: c });
        }
    }
    const out = [];
    for (const n of runs) {
        let top = topEdgeRow;
        for (let c = n.c0; c <= n.c1; c++) {
            top = Math.min(top, highest[c]);
        }
        n.top = top;
        n.h = topEdgeRow - top;
        n.x = (n.c0 + n.c1 + 1) / 2;
        if (n.c1 - n.c0 + 1 <= cols * CHIM_MAX_W && n.h >= CHIM_MIN_H) {
            out.push(n);
        }
    }
    if (out.length < 2) {
        return null;
    }
    const byDist = out.map((n, i) => i)
        .sort((a, b) => Math.abs(out[b].x - cols / 2) - Math.abs(out[a].x - cols / 2));
    out.forEach((n) => { n.outer = 0; });
    byDist.slice(0, 2).forEach((i) => { out[i].outer = 1; });
    return out;
}

/**
 * The slot: the core window read as the three concentric layers the art paints
 * it with, because on this ramp they are the only way a hull can show a
 * *level*. Measured on `colossus2`:
 *
 *   - `frame`, the dark accent around it (rung 1), has six rungs of headroom
 *     and is therefore the gauge -- but the fourth of them is the bank's fixed
 *     grey-blue, so whatever drives it has to stay under that (see the VULCAN
 *     block's `slot.frame`);
 *   - `ring`, the neon accent (rung 5), has two: light tint at k = 0.17 and
 *     white at 0.5, which is what makes the white middle visibly *grow*;
 *   - `glass`, the hot white middle (rung 8), is already at the top of the ramp
 *     and cannot brighten at all. Only a negative k moves it, which is exactly
 *     what "the forge is cold" has to look like.
 *
 * `ring` is the accent touching the glass, so the shoulder fans -- the same
 * index, elsewhere on the hull -- are not part of it, and `frame` is the dark
 * accent touching either. That is what keeps the feet, drawn in the same index,
 * out of a thermometer.
 */
function slotOf(grid, cols, rows, core) {
    if (!core.length) {
        return null;
    }
    const isCore = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows
        && CORE_CHARS.indexOf(grid[r][c]) >= 0;
    const inner = new Set();
    for (let i = 0; i < core.length; i += 2) {
        inner.add(core[i] + "," + core[i + 1]);
    }
    const seen = new Uint8Array(cols * rows);
    const ring = [];
    const fans = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (grid[r][c] !== ACCENT_CHAR || seen[r * cols + c]) {
                continue;
            }
            seen[r * cols + c] = 1;
            const stack = [c, r];
            const cells = [];
            let touches = false;
            while (stack.length) {
                const y = stack.pop();
                const x = stack.pop();
                cells.push(x, y);
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (isCore(nx, ny)) {
                            touches = true;
                        }
                        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows
                                || grid[ny][nx] !== ACCENT_CHAR || seen[ny * cols + nx]) {
                            continue;
                        }
                        seen[ny * cols + nx] = 1;
                        stack.push(nx, ny);
                    }
                }
            }
            const box = cellBox(cells);
            if (touches) {
                ring.push(...cells);
                for (let i = 0; i < cells.length; i += 2) {
                    inner.add(cells[i] + "," + cells[i + 1]);
                }
            } else if (cells.length / 2 >= FAN_MIN_CELLS
                    && box.c1 - box.c0 + 1 >= FAN_MIN_SPAN
                    && box.r1 - box.r0 + 1 >= FAN_MIN_SPAN) {
                const pod = {
                    c0: Math.max(0, box.c0 - FAN_PAD), c1: Math.min(cols - 1, box.c1 + FAN_PAD),
                    r0: Math.max(0, box.r0 - FAN_PAD), r1: Math.min(rows - 1, box.r1 + FAN_PAD),
                };
                pod.cx = (pod.c0 + pod.c1) / 2;
                pod.cy = (pod.r0 + pod.r1) / 2;
                pod.rx = (pod.c1 - pod.c0) / 2 + 0.5;
                pod.ry = (pod.r1 - pod.r0) / 2 + 0.5;
                fans.push({
                    cells, box, pod,
                    r: Math.max(box.rx, box.ry),
                    podR: Math.max(pod.rx, pod.ry),
                });
            }
        }
    }
    const frame = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (grid[r][c] !== DARK_ACCENT_CHAR) {
                continue;
            }
            let adj = false;
            for (let dy = -1; dy <= 1 && !adj; dy++) {
                for (let dx = -1; dx <= 1 && !adj; dx++) {
                    if (inner.has((c + dx) + "," + (r + dy))) {
                        adj = true;
                    }
                }
            }
            if (adj) {
                frame.push(c, r);
            }
        }
    }
    fans.sort((a, b) => a.box.c0 - b.box.c0);
    return {
        glass: core, ring, frame,
        gbox: cellBox(core),
        box: cellBox([...core, ...ring, ...frame]),
        fans: fans.length >= 2 ? fans : null,
    };
}

/**
 * The side arms, and the hand at the end of each: the two stubby masses of
 * plating on VULCAN's flanks, which is where the forge beams leave from.
 *
 * `_updateColossus` used to fire them from 0.4 of the hull's width, a third of
 * the way up it and 49 px inboard of anything the art draws. Same answer as
 * AEGIS's siege salvo -- when the art and the muzzle disagree, move the muzzle
 * -- except that here the art has something much better to offer than a
 * fraction: the arms are two connected masses of metal, the outer-bottom corner
 * of each is unmistakably a hand, and at +/-0.470 of the width it is further
 * out than the old constant was.
 *
 * The `hand` is the lowest cell within two columns of the arm's outer edge, and
 * the whole thing is symmetric by construction, so a retouched sprite moves the
 * muzzle and the light on it together.
 */
function armsOf(grid, cols, rows, topEdgeRow) {
    const seen = new Uint8Array(cols * rows);
    const parts = [];
    for (let r = topEdgeRow; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (grid[r][c] !== METAL_CHAR || seen[r * cols + c]) {
                continue;
            }
            seen[r * cols + c] = 1;
            const stack = [c, r];
            const cells = [];
            while (stack.length) {
                const y = stack.pop();
                const x = stack.pop();
                cells.push(x, y);
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || nx >= cols || ny < topEdgeRow || ny >= rows
                                || grid[ny][nx] !== METAL_CHAR || seen[ny * cols + nx]) {
                            continue;
                        }
                        seen[ny * cols + nx] = 1;
                        stack.push(nx, ny);
                    }
                }
            }
            parts.push({ cells, box: cellBox(cells) });
        }
    }
    if (parts.length !== 2) {
        return null;
    }
    parts.sort((a, b) => a.box.c0 - b.box.c0);
    const min = cols * rows * ARM_MIN_SHARE;
    if (parts[0].cells.length / 2 < min || parts[1].cells.length / 2 < min) {
        return null;
    }
    return parts.map((arm, side) => {
        const outer = side ? arm.box.c1 : arm.box.c0;
        // Lowest first, then outermost. The second half of that is not a detail:
        // the sprite is mirrored, so the two arms are the same shape, but a
        // tie-break that depends on the order the flood fill happened to visit
        // cells in picked column 2 on the left against 82 on the right and put
        // one muzzle 10 px further out than the other.
        let r = -1;
        let c = outer;
        for (let i = 0; i < arm.cells.length; i += 2) {
            const cc = arm.cells[i];
            const rr = arm.cells[i + 1];
            if (Math.abs(cc - outer) > 2) {
                continue;
            }
            if (rr > r || (rr === r && Math.abs(cc - outer) < Math.abs(c - outer))) {
                r = rr;
                c = cc;
            }
        }
        return { cells: arm.cells, box: arm.box, hand: { c, r } };
    });
}

/**
 * Everything about a hull grid that never changes, worked out once: the ramp
 * rung of every cell, the lowest occupied row of each column (where a plume
 * hangs), the last row wide enough to count as the bottom edge (where the
 * curtain leaves the hull), the dark cells damage can burn out in a stable
 * order, the core window and the nozzle clusters.
 *
 * Nothing here is written down per colossus: a nozzle is any run of columns
 * that reaches below the bottom edge, and the core is the glass. Both fall out
 * of the art, so the next colossus to get a section does not have to hand-count
 * its own cells -- and neither can drift when a sprite is retouched.
 *
 * The same goes for the parts a hull is *built* out of, which is what HYDRA-07
 * needs and AEGIS does not have:
 *
 *   - the **crown** is whatever sits above the row where the silhouette first
 *     spans 40% of its width -- the shoulder line -- and it only counts as one
 *     if there is glass up there to be a face;
 *   - the **heads** are the outer two of the three pieces the silhouette breaks
 *     into below its widest row, and only when it breaks into exactly three
 *     with the middle one straddling the centre. AEGIS breaks into four nozzle
 *     clusters, so it has no heads and never asks for any;
 *   - the **vents** are the cells the sprite already paints in the neon accent.
 */
function hullGeometry(name) {
    let geo = geometry.get(name);
    if (geo) {
        return geo;
    }
    const grid = spriteGrid(name);
    const rows = grid.length;
    const cols = rows ? grid[0].length : 0;
    const cells = new Int8Array(cols * rows).fill(-1);
    const lowest = new Int16Array(cols).fill(-1);
    const highest = new Int16Array(cols).fill(-1);
    const dead = [];
    const core = [];
    const vents = [];
    const used = new Uint8Array(TOP + 1);
    let edgeRow = rows - 1;
    // The *first* row wide enough to be the hull proper, i.e. where a chimney
    // stops being a chimney. `edgeRow` below is the last one, where a nozzle
    // starts being a nozzle: the same test read from the two ends.
    let topEdgeRow = -1;
    for (let r = 0; r < rows; r++) {
        let filled = 0;
        for (let c = 0; c < cols; c++) {
            const ch = grid[r][c];
            if (ch === ".") {
                continue;
            }
            filled++;
            const rung = RUNG[ch] == null ? 0 : RUNG[ch];
            cells[r * cols + c] = rung;
            used[rung] = 1;
            lowest[c] = r;
            if (highest[c] < 0) {
                highest[c] = r;
            }
            if (DEAD_CHARS.indexOf(ch) >= 0) {
                dead.push([cellNoise(c, r), c, r]);
            }
            if (CORE_CHARS.indexOf(ch) >= 0) {
                core.push(c, r);
            }
            if (ch === ACCENT_CHAR) {
                vents.push(c, r);
            }
        }
        if (cols && filled / cols >= 0.6) {
            edgeRow = r;
            if (topEdgeRow < 0) {
                topEdgeRow = r;
            }
        }
    }
    dead.sort((a, b) => a[0] - b[0]);

    // Core window: the ellipse the glass cells fill, so an effect can talk
    // about "the outer third of the core" without knowing the shape.
    let c0 = cols, c1 = -1, r0 = rows, r1 = -1;
    for (let i = 0; i < core.length; i += 2) {
        c0 = Math.min(c0, core[i]); c1 = Math.max(c1, core[i]);
        r0 = Math.min(r0, core[i + 1]); r1 = Math.max(r1, core[i + 1]);
    }
    const coreBox = core.length
        ? { cx: (c0 + c1) / 2, cy: (r0 + r1) / 2, rx: (c1 - c0) / 2 + 0.5, ry: (r1 - r0) / 2 + 0.5 }
        : null;

    // Nozzles: runs of columns hanging below the bottom edge.
    const nozzles = [];
    for (let c = 0; c < cols; c++) {
        if (lowest[c] <= edgeRow) {
            continue;
        }
        const last = nozzles[nozzles.length - 1];
        if (last && c - last.c1 <= 1) {
            last.c1 = c;
        } else {
            nozzles.push({ c0: c, c1: c });
        }
    }
    for (const n of nozzles) {
        n.x = (n.c0 + n.c1 + 1) / 2;                    // centre in cell units
        n.outer = 0;
    }
    // The siege barrels are the two clusters nearest the centre line, and the
    // pair furthest from it breathes out of phase with them.
    const byDist = nozzles.map((n, i) => i)
        .sort((a, b) => Math.abs(nozzles[a].x - cols / 2) - Math.abs(nozzles[b].x - cols / 2));
    const barrels = byDist.slice(0, 2).sort((a, b) => nozzles[a].x - nozzles[b].x);
    byDist.slice(2).forEach((i) => { nozzles[i].outer = 1; });

    // A promotion may only land on a colour the hull is actually painted with.
    // The three tint shades always belong -- they are this hull's own colour,
    // darker and lighter -- but a fixed palette entry the art never uses does
    // not: promoted through rung 4, a cell of HYDRA's chest would put the
    // sprite bank's grey-blue on a violet hull. Those fold onto the nearest
    // rung the art does use, darker side first, so an effect can only ever
    // brighten a cell into a tone that is already on screen somewhere.
    const rungs = new Int8Array(TOP + 1);
    for (let i = 0; i <= TOP; i++) {
        rungs[i] = i;
        if (used[i] || TINT_RUNGS.indexOf(i) >= 0) {
            continue;
        }
        let best = i;
        let bestD = TOP + 1;
        for (let j = 0; j <= TOP; j++) {
            if (used[j] && Math.abs(j - i) < bestD) {
                bestD = Math.abs(j - i);
                best = j;
            }
        }
        rungs[i] = best;
    }

    const slot = slotOf(grid, cols, rows, core);
    geo = {
        cols, rows, cells, lowest, highest, edgeRow, topEdgeRow, rungs, vents,
        dead: dead.map((d) => [d[1], d[2]]),
        core, coreBox, nozzles, barrels,
        crown: crownOf(grid, cols, rows),
        heads: headsOf(grid, cols, rows),
        ventBox: cellBox(vents),
        // VULCAN's three: the stacks, the slot read as concentric layers and
        // the fans (the accent blobs the slot itself is not made of).
        chimneys: chimneysOf(cols, highest, topEdgeRow < 0 ? 0 : topEdgeRow),
        slot,
        fans: slot ? slot.fans : null,
        arms: cols ? armsOf(grid, cols, rows, topEdgeRow < 0 ? 0 : topEdgeRow) : null,
    };
    geometry.set(name, geo);
    return geo;
}

/**
 * Where a hull's parts are, as fractions of its own width and height measured
 * from its centre -- the form `game_engine.js` wants, since a colossus knows
 * `e.w`/`e.h` and nothing about cells.
 *
 * This is the one thing the animator exports that the *simulation* reads, and
 * it is deliberate: HYDRA's spiral leaves from the lens between the crown's
 * eyes, its fans from the glass in each side head, and its side heads can be
 * shot off; VULCAN's beams leave from the hands at the ends of its two side
 * arms, its volley from the slot and its shoulder fans can be jammed. All of those want
 * the same answer to "where is that part", and a second copy of it in the
 * engine would drift from the art the first time the sprite is retouched. Pure
 * and cached, so host and guest agree.
 *
 * A hull only carries the keys it actually has: HYDRA has `crown`/`heads`,
 * VULCAN has `fans`/`core`/`arms`, AEGIS has none of them and gets null.
 *
 * @param {string} name sprite key
 * @returns {Object|null} `{ crown: {x, y}, heads: [{x, y, hw, hh, mx, my}] }`
 *      and/or `{ fans: [{x, y, hw, hh}], core: {x, y, hw, hh}, arms: [{x, y}] }`,
 *      or null for a hull with no parts at all. `mx`/`my` is a mouth, `x`/`y`
 *      with `hw`/`hh` the box the part fills.
 */
export function hullParts(name) {
    const geo = hullGeometry(name);
    const fx = (c) => c / geo.cols - 0.5;
    const fy = (r) => r / geo.rows - 0.5;
    const boxOf = (b) => ({
        x: fx(b.cx + 0.5), y: fy(b.cy + 0.5),
        hw: (b.c1 - b.c0 + 1) / 2 / geo.cols,
        hh: (b.r1 - b.r0 + 1) / 2 / geo.rows,
    });
    const parts = {};
    if (geo.crown && geo.heads) {
        parts.crown = {
            x: fx(geo.crown.coreBox.cx + 0.5), y: fy(geo.crown.coreBox.cy + 0.5),
        };
        parts.heads = geo.heads.map((head) => Object.assign(boxOf(head.box), {
            mx: fx(head.gbox.cx + 0.5), my: fy(head.gbox.cy + 0.5),
        }));
    }
    if (geo.fans && geo.slot) {
        // The housing, not the blade: see FAN_PAD.
        parts.fans = geo.fans.map((fan) => boxOf(fan.pod));
        // The white middle, not the whole slot: this is the box the vent window
        // doubles the damage inside, so it has to be the part the player can
        // see is open, and the frame around it never lights white.
        parts.core = boxOf(geo.slot.gbox);
        if (geo.arms) {
            // The hand at the end of each arm: where the forge beam leaves from,
            // and the cells `_drawArms` lights when it does.
            parts.arms = geo.arms.map((a) => ({
                x: fx(a.hand.c + 0.5), y: fy(a.hand.r + 0.5),
            }));
        }
    }
    return Object.keys(parts).length ? parts : null;
}

function hexToRgb(h) {
    const n = parseInt(String(h).replace("#", ""), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class ColossusAnimator {
    /**
     * @param {number} k index into COLOSSI (same order as COLOSSUS_ANIM_KINDS)
     * @param {string} tint the colossus colour from the catalogue
     */
    constructor(k, tint) {
        this.k = k;
        this.kind = COLOSSUS_ANIM_KINDS[k] || COLOSSUS_ANIM_KINDS[0];
        this.t = COLOSSUS_ANIM[this.kind];
        this.g0 = COLOSSUS_ANIM.global;
        this.tint = tint || "#ff4d4d";
        // The ramp resolved for this hull's tint, straight out of the sprite
        // bank, so a promoted cell is exactly a colour the raster already uses.
        const pal = palette(this.tint);
        this.ramp = RAMP_CHARS.map((ch) => pal[ch]);
        const [r, g, b] = hexToRgb(this.tint);
        // The additive colour of the two glows: the hull's own tint pushed most
        // of the way to white, so a red slab glows hot and a teal one glows cold.
        this.hot = ((r + (255 - r) * 0.6) | 0) + ","
            + ((g + (255 - g) * 0.75) | 0) + ","
            + ((b + (255 - b) * 0.7) | 0);
        this.time = 0;
        this.x = null;
        this.y = null;
        this.vx = 0;
        this.vy = 0;
        this.vx01 = 0;
        this.aim = 0;
        this.lean = 0;
        this.recoil = 0;
        this.sweep = -1;        // < 0 idle, else 0..1 + tail
        this.plant = 0;         // 0..1 brace on any telegraph
        this.port = 0;          // 0..1 shutter, curtain telegraph only
        this.charge = 0;
        this.hold = 0;          // seconds left of the enrage beat
        this.flare = -1;
        this.dmg = 0;
        this.enter = 0;         // 0..1 while it is still coming down
        this.landed = false;
        this.coreFlash = 0;     // seconds left of the salvo core flash
        this.gapX = null;
        this.barrels = [-1, -1];
        // HYDRA: the crown reads the spiral it is firing straight off the AI
        // (`spin` is the arm angle, `arms` how many there are), the enrage is a
        // level rather than a beat, and each side head keeps its own muzzle
        // timer and its own, slower, look at the ships.
        this.spin = 0;
        this.spinDir = 1;
        this.arms = 2;
        this.emit01 = 0;        // 0..1, the crown actually emitting
        this.crownWarn = 0;     // 0..1, SPIRAL_CHARGE
        this.rage01 = 0;
        this.aimH = 0;
        this.headFlash = [0, 0];
        this.headHurt = [0, 0];
        this.headHp = [null, null];
        this.headState = [
            { k: 0, dead: false, grow: 1, hurt: 0 },
            { k: 0, dead: false, grow: 1, hurt: 0 },
        ];
        // VULCAN: the heat cycle. `heat` and `phase` are read straight off the
        // engine (both travel); everything else here is derived -- the gait
        // from distance travelled, the hood and the forge from the phase, the
        // fans from one number each on HYDRA's pattern.
        this.heat = 0;
        this.phase = null;
        this.volley = 0;
        this.volleyTel = 0;
        this.gait = 0;
        this.foot = 0;
        this.fall = -1;         // seconds since the last footfall, < 0 idle
        this.fallFoot = 0;
        this.settle = 0;
        this.open = 0;          // 0..1 the slot's hood
        this.ventE = 0;         // 0..1 venting
        this.crackE = 0;        // 0..1 overheating
        this.forgeE = 0;        // 0..1 the forge mouths lit
        this.fanSpin = 0;
        this.smoke = [];
        this._puff = 0;
        // Filled in by the first `draw`: the hull grid the smoke leaves from.
        this._geo = null;
        this.fanFlash = [0, 0];
        this.fanHurt = [0, 0];
        this.fanHp = [null, null];
        this.fanState = [
            { jam: false, clear: 1, hurt: 0 },
            { jam: false, clear: 1, hurt: 0 },
        ];
        this.sparks = [];
        this._spawn = 0;
        this._fell = false;
        this._seed = 0.1234;
    }

    /**
     * Advance the cosmetics from state the engine already owns.
     *
     * @param {number} dt seconds
     * @param {Object} s read-only view: x, y, hp01, tel, telK, gapX, aimX, and
     *      for HYDRA spinA (the angle of the spiral arm the AI is firing),
     *      arms (how many of them) and raged
     */
    observe(dt, s) {
        const t = this.t;
        const g = this.g0;
        if (!(dt > 0)) {
            return this;
        }
        if (dt > g.maxDt) {
            dt = g.maxDt;
        }
        this.time += dt;

        // The engine moves a colossus by writing x/y, so there is no velocity to
        // read. On a guest those positions are whole px at ~15 Hz, which makes
        // the raw difference steppy and often exactly 0 for several frames --
        // hence the smoothing rather than the difference itself.
        if (this.x === null) {
            this.x = s.x;
            this.y = s.y;
        }
        const dx = s.x - this.x;
        const dy = s.y - this.y;
        if (Math.abs(dx) > g.teleportPx || Math.abs(dy) > g.teleportPx) {
            this.vx = 0;
            this.vy = 0;
        } else {
            this.vx = ease(this.vx, dx / dt, g.velSmooth, dt);
            this.vy = ease(this.vy, dy / dt, g.velSmooth, dt);
        }
        this.x = s.x;
        this.y = s.y;

        this.vx01 = clamp(this.vx / g.velRefPx, -1, 1);

        // Where the ships are, as a signed fraction of a flank. Eased slowly:
        // a slab this size answering a dodge frame for frame would read as a
        // turret, and the pull `aegis_motion.js` applies is slewed just as hard.
        const aim = s.aimX == null ? 0 : clamp((s.aimX - s.x) / t.lean.aimSpanPx, -1, 1);
        this.aim = ease(this.aim, aim, t.lean.aimSmooth, dt);

        // The arrival: emitters at full burn and a cold core, both fading out as
        // the slab settles into its lane. Once it has fallen and stopped, the
        // latch closes for good -- nothing else it does can look like a descent.
        if (!this.landed) {
            const want = clamp01((this.vy - t.entry.vy) / t.entry.span);
            this.enter = ease(this.enter, want, want > this.enter ? g.boolIn : g.boolOut, dt);
            if (this.enter > 0.5) {
                this._fell = true;
            } else if (this._fell && this.enter < 0.02) {
                this.enter = 0;
                this.landed = true;
            }
        }

        // A telegraph braces the whole hull; only the curtain one opens the
        // shutter, because only the curtain has a hole to point at.
        const tel = smoothstep(clamp01(s.tel || 0));
        // AEGIS braces on its curtain and its salvo, HYDRA on its fan, VULCAN on
        // the overheat and the volley charge. No colossus sets a kind that is
        // not its own, so this list is additive.
        const brace = s.telK === "curtain" || s.telK === "aimed"
            || s.telK === "ring" || s.telK === "volley" ? tel : 0;
        this.plant = ease(this.plant, brace, brace > this.plant ? g.boolIn : g.boolOut, dt);
        const shutter = s.telK === "curtain" ? tel : 0;
        this.port = ease(this.port, shutter, shutter > this.port ? g.boolIn : g.boolOut, dt);
        this.gapX = s.gapX;

        // Planting squares the slab up: it stops leaning where it was going and
        // faces the arena to fire.
        const tip = clamp(this.vx01 * t.lean.velGain + this.aim * t.lean.aimGain, -1, 1);
        const leanTo = -tip * t.lean.maxRad * (1 - this.plant * t.plant.squareUp);
        this.lean = ease(this.lean, leanTo, t.lean.smooth, dt);

        if (this.hold > 0) {
            this.hold -= dt;
        }
        this.charge = ease(this.charge, this.hold > 0 ? 1 : 0,
            this.hold > 0 ? g.boolIn : g.boolOut, dt);
        this.dmg = clamp01((t.damage.start - clamp01(s.hp01 == null ? 1 : s.hp01)) / t.damage.start);

        this.recoil = this.recoil > 0.001 ? ease(this.recoil, 0, t.recoil.fall, dt) : 0;
        if (this.coreFlash > 0) {
            this.coreFlash -= dt;
        }
        if (this.sweep >= 0) {
            this.sweep += dt / t.curtain.sweepSec;
            if (this.sweep > 1 + t.curtain.tail) {
                this.sweep = -1;
            }
        }
        if (this.flare >= 0) {
            this.flare += dt / t.rage.flareSec;
            if (this.flare > 1) {
                this.flare = -1;
            }
        }
        for (let i = 0; i < 2; i++) {
            if (this.barrels[i] >= 0) {
                this.barrels[i] += dt / t.barrel.life;
                if (this.barrels[i] > 1) {
                    this.barrels[i] = -1;
                }
            }
        }
        if (this.kind === "HYDRA") {
            this._observeHydra(dt, s);
        } else if (this.kind === "VULCAN") {
            this._observeVulcan(dt, s, dx);
        }
        this._vent(dt);
        return this;
    }

    /**
     * The three parts of HYDRA-07: what the crown is firing, how hurt it is and
     * where the heads are looking.
     *
     * The enrage is a *level* here, not the beat AEGIS gets: the phase lasts
     * the rest of the fight, and it is read off `hp01` (which travels) against
     * the same threshold the AI uses, so host and guest cross it on the same
     * frame without `raged` ever going on the bus.
     */
    _observeHydra(dt, s) {
        const t = this.t;
        const g = this.g0;
        // Which way the crown is turning, read off its own angle rather than
        // sent: the direction flips at the start of every wind-up and that is
        // what the warning is *for*, so it has to be right on a guest too. Only
        // a real step counts -- between two snapshots the angle repeats, and a
        // frame of no movement is not a change of direction.
        const step = ((s.spinA || 0) - this.spin + Math.PI * 3) % 6.2832 - Math.PI;
        if (Math.abs(step) > 0.002) {
            this.spinDir = step > 0 ? 1 : -1;
        }
        this.spin = s.spinA || 0;
        this.arms = s.arms || 2;
        this.emit01 = ease(this.emit01, s.spiral ? 1 : 0, s.spiral ? g.boolIn : g.boolOut, dt);
        const warn = s.telK === "spiral" ? smoothstep(clamp01(s.tel || 0)) : 0;
        this.crownWarn = ease(this.crownWarn, warn, warn > this.crownWarn ? g.boolIn : g.boolOut, dt);
        this._observeHeads(dt, s);
        // Deliberately the slower of the two boolean rates in both directions:
        // the phase takes ~0.6 s to settle, so it reads as a change of state
        // rather than a second flash on top of the one `rage` already fires.
        this.rage01 = ease(this.rage01, s.raged ? 1 : 0, g.boolOut, dt);
        // The heads answer a dodge more slowly than the hull leans into one: a
        // head that snapped onto the ships would read as a turret, which is the
        // same reason `lean.aimSmooth` is what it is.
        const aim = s.aimX == null ? 0 : clamp((s.aimX - s.x) / t.heads.aimSpanPx, -1, 1);
        this.aimH = ease(this.aimH, aim, t.heads.aimSmooth, dt);
    }

    /**
     * The two side heads, all of it *observed*: their hull points travel, so a
     * drop is a hit, zero is a destroyed head and the countdown under it is the
     * rebuild. Three of the sheet's states for no cue at all -- and the local
     * hit flash in particular could not have been one, because it fires as
     * often as you can put a bullet on a head.
     */
    _observeHeads(dt, s) {
        const t = this.t.heads;
        const regrow = s.headRegrow || 40;
        for (let i = 0; i < 2; i++) {
            if (this.headFlash[i] > 0) {
                this.headFlash[i] -= dt;
            }
            if (this.headHurt[i] > 0) {
                this.headHurt[i] -= dt;
            }
            const h = s.heads && s.heads[i];
            const st = this.headState[i];
            if (!h) {
                st.dead = false;
                st.grow = 1;
                continue;
            }
            const was = this.headHp[i];
            if (was != null && h.hp < was && h.hp > 0) {
                this.headHurt[i] = t.hurtSec;
            }
            this.headHp[i] = h.hp;
            st.dead = h.hp <= 0;
            // `t` counts the whole death down: the rebuild is its last frames.
            st.grow = st.dead ? clamp01(1 - h.t / regrow) : 1;
            if (st.dead) {
                this.headFlash[i] = 0;
            }
            st.hurt = clamp01(this.headHurt[i] / t.hurtSec);
        }
    }

    /**
     * VULCAN: the heat cycle, the walk and the two fans.
     *
     * `heat` and `phase` are the only two things read rather than derived, and
     * they travel for exactly that reason -- the hull's whole visual language
     * is the gauge in the slot and the beat the machine is on, and neither can
     * be worked out from a position. Everything else falls out:
     *
     *   - the **gait** accumulates *distance travelled*, not time, so the
     *     cadence eases into every reversal and stops dead while the feet are
     *     planted, with no extra state and nothing on the bus. It also survives
     *     a guest's ~15 Hz whole-pixel positions, because the total distance
     *     does even when the per-frame difference is 0 for three frames;
     *   - the **hood**, the **forge** and the **cracks** are levels eased off
     *     the phase, so the animation cannot disagree with the fight;
     *   - the **fans** come off one signed number each, exactly as HYDRA's side
     *     heads do: a drop is a hit, zero is a jam, the countdown under it is
     *     the clearing.
     */
    _observeVulcan(dt, s, dx) {
        const t = this.t;
        const g = this.g0;
        const ph = s.phase == null ? V.REST : s.phase;
        this.heat = clamp01(s.heat == null ? 0 : s.heat);
        this.phase = ph;
        this.volley = s.volley || 0;
        // How far into the volley charge we are, which is how many pips are
        // lit. Straight off the telegraph the engine already sends, so the pips
        // on the hull and the pips under it fill on the same frame.
        this.volleyTel = s.telK === "volley" ? clamp01(s.tel || 0) : 0;

        // The walk. Only a teleport is not travel: the entrance is straight
        // down, so it contributes no |dx| and needs no gate of its own -- and
        // gating this on `landed` was a real host/guest split, because a guest
        // derives that from a velocity it only sees at ~15 Hz and so never
        // latched it. Summing |dx| is safe there for the opposite reason: the
        // rounding in the snapshot is on the position, not on the step, so the
        // total distance survives even when three frames in four move by 0.
        if (Math.abs(dx) <= g.teleportPx) {
            const stride = 2 * t.gait.stridePx;
            const before = this.gait;
            this.gait = (this.gait + Math.abs(dx) / stride) % 1;
            if (Math.floor(before * 2) !== Math.floor(this.gait * 2)) {
                this.fall = 0;
                this.fallFoot = Math.floor(this.gait * 2) & 1;
            }
        }
        if (this.fall >= 0) {
            this.fall += dt;
            if (this.fall > 0.5) {
                this.fall = -1;
            }
        }

        // Planted: the sheet is explicit that it does not walk while it vents,
        // and `vulcan_motion.js` really does stop it, so this only has to be
        // what stopping *looks* like -- it sinks onto its feet.
        const planted = ph === V.OVERHEAT || ph === V.VENT || ph === V.ROCK_WARN;
        this.settle = ease(this.settle, planted ? 1 : 0, t.gait.settleRate, dt);

        // The hood over the slot: open to throw a volley and open to vent, shut
        // for everything else. `openRate` rather than the boolean rates because
        // it is a shutter with mass, not a lamp.
        const wantOpen = ph === V.ROCK_WARN || ph === V.ROCKS || ph === V.VENT ? 1 : 0;
        this.open = ease(this.open, wantOpen, t.slot.openRate, dt);
        this.ventE = ease(this.ventE, ph === V.VENT ? 1 : 0,
            ph === V.VENT ? g.boolIn : g.boolOut, dt);
        this.crackE = ease(this.crackE, ph === V.OVERHEAT ? 1 : 0,
            ph === V.OVERHEAT ? g.boolIn : g.boolOut, dt);
        // The mouths light under the sight line and burn while the beam is live.
        const wantForge = ph === V.BEAM ? t.forge.live : ph === V.BEAM_WARN ? t.forge.warn : 0;
        this.forgeE = ease(this.forgeE, wantForge,
            wantForge > this.forgeE ? g.boolIn : g.boolOut, dt);

        // The blades. They turn faster as the forge heats and faster again while
        // it is actually dumping, which is the one thing on the hull that says
        // the exhaust is working.
        const f = t.fans;
        const rev = f.spinIdle + this.heat * f.spinHeat + this.ventE * f.spinVent;
        this.fanSpin = (this.fanSpin + rev * dt) % 1;
        this._smoke(dt);
        this._observeFans(dt, s);
        this.rage01 = ease(this.rage01, s.raged ? 1 : 0, g.boolOut, dt);
    }

    /**
     * The two shoulder fans, all of it observed off `vf`: points while the fan
     * works, minus the frames left of the jam once it does not. Same trick as
     * HYDRA's heads and for the same reason -- a hit on a fan happens as often
     * as the player can put a bullet on one, so it could never be a cue.
     */
    _observeFans(dt, s) {
        const t = this.t.fans;
        const jam = s.fanJam || 720;
        for (let i = 0; i < 2; i++) {
            if (this.fanFlash[i] > 0) {
                this.fanFlash[i] -= dt;
            }
            if (this.fanHurt[i] > 0) {
                this.fanHurt[i] -= dt;
            }
            const f = s.fans && s.fans[i];
            const st = this.fanState[i];
            if (!f) {
                st.jam = false;
                st.clear = 1;
                continue;
            }
            const was = this.fanHp[i];
            if (was != null && f.hp < was && f.hp > 0) {
                this.fanHurt[i] = t.hurtSec;
            }
            this.fanHp[i] = f.hp;
            st.jam = f.hp <= 0;
            st.clear = st.jam ? clamp01(1 - f.t / jam) : 1;
            if (st.jam) {
                this.fanFlash[i] = 0;
            }
            st.hurt = clamp01(this.fanHurt[i] / t.hurtSec);
        }
    }

    /**
     * The chimney smoke, in cell space: puffs that leave a stack, keep rising
     * (they lose upward speed but never fall), drift sideways and fade.
     *
     * Emitted here rather than in the draw for the same reason the damage
     * sparks are: the draw must not consume the simulation's noise, and both
     * roles have to be able to produce the same smoke off the same LCG. The
     * stacks go out one at a time as the hull fails, and the inner and outer
     * pairs are phase shifted -- six stacks puffing in step is a lamp, not a
     * foundry.
     */
    _smoke(dt) {
        const t = this.t.smoke;
        const geo = this._geo;
        if (!geo || !geo.chimneys) {
            return;
        }
        const chim = geo.chimneys;
        const out = Math.round(chim.length * this.dmg * (t.deadCells / 100));
        const live = chim.length - out;
        if (live > 0) {
            const rate = t.idle + t.heat * this.heat + t.overheat * this.crackE;
            this._puff += dt * rate;
            while (this._puff >= 1) {
                this._puff -= 1;
                const n = chim[out + Math.floor(this._rnd() * live)];
                // A stack breathes on its own beat, so the six never puff as one.
                const ph = (n.outer ? 0.5 : 0) + n.x * 0.017;
                if (this._rnd() > 0.45 + 0.55 * (0.5 + 0.5 * Math.sin((this.time / 0.85 + ph) * 6.2832))) {
                    continue;
                }
                this.smoke.push({
                    c: n.x - 0.5 + (this._rnd() - 0.5) * t.spread,
                    r: n.top - 1,
                    vc: (this._rnd() - 0.5) * t.drift,
                    vr: -(t.rise + this._rnd() * t.riseVar),
                    fat: this._rnd() < t.fat,
                    life: t.life + this._rnd() * t.lifeVar,
                    age: 0,
                });
            }
        }
        for (let i = this.smoke.length - 1; i >= 0; i--) {
            const s = this.smoke[i];
            s.age += dt;
            s.c += (s.vc + this.vx * -0.006) * dt;
            s.r += s.vr * dt;
            // It slows as it climbs instead of falling back: this is smoke, and
            // the sheet's own puffs use a negative gravity for the same reason.
            s.vr *= 1 - t.slow * dt;
            if (s.age >= s.life) {
                this.smoke.splice(i, 1);
            }
        }
        if (this.smoke.length > t.maxPuffs) {
            this.smoke.splice(0, this.smoke.length - t.maxPuffs);
        }
    }

    /** Venting sparks, in cell space, while the hull is failing. */
    _vent(dt) {
        const t = this.t;
        if (this.dmg > 0.05) {
            this._spawn += dt * t.damage.ventRate * this.dmg;
            while (this._spawn >= 1) {
                this._spawn -= 1;
                // `c` is the column it vents from, as a fraction of the hull
                // (the grid is not known here); `dc` is its drift, in cells.
                this.sparks.push({
                    c: this._rnd(), dc: 0, r: 6 + this._rnd() * 20,
                    vc: (this._rnd() - 0.5) * 2, vr: 0.4 + this._rnd() * 1.6,
                    life: t.damage.sparkLife * (0.6 + this._rnd() * 0.7), age: 0,
                });
            }
        }
        for (let i = this.sparks.length - 1; i >= 0; i--) {
            const p = this.sparks[i];
            p.age += dt;
            p.dc += p.vc * dt * 2;
            p.r += p.vr * dt * t.damage.sparkSpeed * 0.1;
            if (p.age >= p.life) {
                this.sparks.splice(i, 1);
            }
        }
        if (this.sparks.length > this.g0.maxSparks) {
            this.sparks.splice(0, this.sparks.length - this.g0.maxSparks);
        }
    }

    /**
     * Cosmetic cue from the engine, mirrored to the guests over the bus.
     *
     * Every branch is guarded by the tuning block it needs, because a cue
     * arrives off the wire as a name plus a colossus index: a `cfx` for a hull
     * whose section has no barrels (or no heads) has to be ignored, not read a
     * block that is not there and take the whole guest down with it.
     */
    emit(name) {
        if (name === "salvo" && this.t.barrel) {
            this.recoil = 1;
            this.barrels[0] = 0;
            this.barrels[1] = 0;
            this.coreFlash = this.t.core.flashSec;
        } else if (name === "curtain" && this.t.curtain) {
            this.sweep = 0;
        } else if ((name === "fanL" || name === "fanR") && this.t.heads) {
            // One cue per mouth, because the two heads deliberately fire a
            // beat apart: flashing both would erase the very thing the stagger
            // exists to show. The recoil is still the hull's -- a head cannot
            // move on a cached raster.
            this.recoil = 1;
            this.headFlash[name === "fanL" ? 0 : 1] = this.t.heads.flashSec;
        } else if ((name === "vent" || name === "backfire") && this.t.fans) {
            // One wave of rings leaving. Both shoulders fire together, so both
            // flash together -- and when neither can (every fan jammed) the
            // heat comes out of the slot instead, which is a flash on the core
            // and a recoil on the whole hull.
            this.recoil = name === "backfire" ? 1 : 0.5;
            if (name === "vent") {
                this.fanFlash = [this.t.fans.flashSec, this.t.fans.flashSec];
            } else {
                this.coreFlash = 0.14;
            }
        } else if (name === "spit" && this.t.gait) {
            // The volley: the sheet's one dry, seco beat. The recoil is the
            // whole hull, and the feet take it.
            this.recoil = 1;
            this.coreFlash = 0.1;
        } else if (name === "rage") {
            this.flare = 0;
            this.hold = this.t.rage.holdSec;
        }
        return this;
    }

    pose() {
        const t = this.t;
        const load = 1 + t.breathe.loadTilt * this.dmg;
        // Core: idle breath, saturated by the brace, whited out by the salvo,
        // jittering and going cold as the hull fails, dark while it arrives.
        const beat = 0.5 + 0.5 * Math.sin(this.time * 6.2832 * t.core.rate);
        let core = t.core.base + t.core.pulse * beat + this.plant * t.core.sat;
        if (this.dmg > 0.05) {
            core = core * (1 - 0.5 * this.dmg) - this.dmg * t.core.jitter
                * (0.5 + 0.5 * Math.sin(this.time * 37));
        }
        core -= this.enter * t.core.dim;
        if (this.coreFlash > 0) {
            core = Math.max(core, 1);
        }
        // HYDRA only: the chest grilles and the two side heads. Both are levels
        // the draw turns into promotions; the grilles carry the phase of the
        // spiral so the ripple runs down the chest in step with the crown.
        let vent = null;
        let heads = null;
        if (this.kind === "HYDRA") {
            const v = t.vents;
            const gain = (1 - this.plant * v.plantDrop) * (1 - 0.7 * this.dmg);
            vent = {
                base: (v.idle + this.rage01 * v.rage) * gain,
                amp: v.amp * gain,
                phase: this.spin,
            };
            const hd = t.heads;
            heads = [];
            for (let i = 0; i < 2; i++) {
                const st = this.headState[i];
                const w = this.time * hd.rate[i] + hd.phase[i];
                let k = hd.idle + hd.pulse * (0.5 + 0.5 * Math.sin(w * 6.2832))
                    + this.plant * hd.charge + this.rage01 * hd.rage;
                if (this.headFlash[i] > 0) {
                    k = Math.max(k, 1);
                }
                k = k * (1 - 0.6 * this.dmg) - this.enter * hd.dim;
                // Coming back, the eyes are the last thing to light.
                if (st.dead) {
                    k *= clamp01((st.grow - hd.eyesAt) / (1 - hd.eyesAt));
                }
                heads.push({ k, dead: st.dead, grow: st.grow, hurt: st.hurt });
            }
        }
        // VULCAN only: the three layers of the slot, the fans and the walk.
        let slot = null;
        let fans = null;
        let walk = null;
        if (this.kind === "VULCAN") {
            const sl = t.slot;
            const open = this.open;
            slot = {
                open,
                // The gauge. The frame carries the bottom of it, the ring the
                // top, and the middle is the only one that can move *down*.
                frame: sl.frame * this.heat,
                ring: Math.max(sl.ring * this.heat, this.ventE * sl.ventLift),
                cold: -this.enter * sl.enterDim,
                // The pips: how many rocks are coming, as dark dots left behind
                // in a middle that has dipped for the charge (see `_drawSlot`).
                pips: this.phase === V.ROCK_WARN ? this.volley : 0,
                lit: this.phase === V.ROCK_WARN
                    ? Math.min(this.volley, Math.floor(this.volleyTel * this.volley) + 1)
                    : 0,
                flash: this.coreFlash > 0,
            };
            const fn = t.fans;
            fans = [];
            for (let i = 0; i < 2; i++) {
                const st = this.fanState[i];
                const w = this.time * fn.rate[i] + fn.phase[i];
                let k = fn.idle + fn.pulse * (0.5 + 0.5 * Math.sin(w * 6.2832))
                    + this.heat * fn.heat + this.ventE * fn.vent + this.rage01 * fn.rage;
                if (this.fanFlash[i] > 0) {
                    k = Math.max(k, 1);
                }
                k = k * (1 - 0.5 * this.dmg) - this.enter * fn.dim;
                fans.push({ k, jam: st.jam, clear: st.clear, hurt: st.hurt });
            }
            const gt = t.gait;
            walk = {
                // Quantised to whole cells for the same reason the damage shake
                // is: at this scale anything smaller reads as the sprite
                // vibrating rather than as a hull putting a foot down.
                bob: -Math.abs(Math.sin(this.gait * 6.2832)) * gt.bobCells,
                settle: this.settle * gt.settleCells,
                gait: this.gait,
                fall: this.fall,
                fallFoot: this.fallFoot,
                // The limp: one constant tilt under the rage threshold, on top
                // of the drift lean. The sheet tilts by 0.16 rad, which on a
                // slab 800 px wide would tear every column apart.
                limp: this.rage01 * gt.limpRad,
            };
        }
        return {
            vx: this.vx, vy: this.vy, vx01: this.vx01,
            lean: this.lean,
            slot, fans, walk,
            heat: this.heat, crack: this.crackE, forge: this.forgeE,
            recoilPx: this.recoil * t.recoil.px,
            breathe: 1 + Math.sin(this.time * 6.2832 * t.breathe.rate) * t.breathe.amp * load,
            sweep: this.sweep, plant: this.plant, port: this.port, charge: this.charge,
            flare: this.flare, dmg: this.dmg, enter: this.enter,
            core, coreScale: 1 - t.core.squeeze * this.plant,
            coreBias: -this.lean / t.lean.maxRad * t.core.biasCells,
            vent, heads,
            // The hull rears up over the enrage beat. AEGIS's block has no
            // `archPx`, so for it this stays 0 and the transform is the one it
            // always had.
            archPx: (t.rage.archPx || 0) * this.charge,
        };
    }

    /** Deterministic noise: no `Math.random` anywhere in the simulation path. */
    _rnd() {
        this._seed = (this._seed * 16807) % 2147483647;
        return this._seed / 2147483647;
    }

    /**
     * Draw the hull with the current pose.
     *
     * Everything is laid out in the hull's own space (origin top left, one unit
     * = one logical px) under a transform that carries the recoil, the damage
     * shake, the brace judder, the breathing and the lean, so an effect only has
     * to know which cell it belongs to.
     *
     * Two passes: the promotions repaint cells of the hull opaquely (source
     * over, exactly as the rasterizer painted them), then the two glows that
     * live around the silhouette go on additively.
     *
     * @param {CanvasRenderingContext2D} g
     * @param {Object} o { sprite, px, x, y }
     */
    draw(g, o) {
        const t = this.t;
        const geo = hullGeometry(o.sprite);
        // The smoke is emitted in `observe`, which does not know the sprite --
        // only the engine's draw call does. Caching it here is safe because a
        // colossus never changes hull, and it means the puffs leave the stacks
        // the art actually has rather than a hand-written position.
        this._geo = geo;
        const cv = sprite(o.sprite, this.tint, o.px, false);
        if (!cv || !geo.cols) {
            return;
        }
        const p = this.pose();
        const cell = o.px;
        const w = geo.cols * cell;
        const h = geo.rows * cell;

        // The shake is quantised to whole cells: at this scale anything smaller
        // reads as the sprite vibrating rather than the hull taking damage. The
        // brace judder rides on the same quantisation, one cell at most.
        let sx = 0;
        let sy = 0;
        if (p.dmg > 0.02) {
            const a = t.damage.shakePx * p.dmg;
            sx = Math.round(Math.sin(this.time * t.damage.shakeHz * 6.2832) * a / cell) * cell;
            sy = Math.round(Math.cos(this.time * t.damage.shakeHz * 4.1) * a * 0.6 / cell) * cell;
        }
        if (p.plant > 0.02) {
            // Cubed on purpose: with a telegraph up ~44% of the fight a judder
            // that tracks `plant` linearly is just a permanent shudder. This
            // one only really lands in the last third of the warning.
            const j = t.plant.judderCells * p.plant * p.plant * p.plant;
            sx += Math.round(Math.sin(this.time * t.plant.judderHz * 6.2832) * j) * cell;
            sy += Math.round(Math.cos(this.time * t.plant.judderHz * 9.7) * j * 0.5) * cell;
        }

        // The walk rides on the same quantisation as the shake: the hull dips a
        // whole cell as a foot lands and sinks another as the feet plant, so
        // the weight is in the pixel grid rather than in a sub-pixel wobble.
        let wy = 0;
        let limp = 0;
        if (p.walk) {
            wy = Math.round(p.walk.bob + p.walk.settle) * cell;
            limp = p.walk.limp;
        }

        g.save();
        g.imageSmoothingEnabled = false;
        g.translate(o.x + sx, o.y - p.recoilPx - p.archPx + sy + wy);
        g.scale(p.breathe, p.breathe);
        // Shear the columns instead of rotating the bitmap: a slab this wide
        // pulls apart visibly past ~0.03 rad, and a rotation would soften every
        // pixel edge in the hull.
        g.transform(1, 0, -p.lean - limp, 1, 0, 0);
        g.translate(-w / 2, -h / 2);
        g.drawImage(cv, 0, 0, w, h);

        this._drawDamage(g, geo, cell, p);
        if (this.kind === "VULCAN") {
            this._drawSmoke(g, geo, cell);
            this._drawSlot(g, geo, cell, p);
            this._drawFans(g, geo, cell, p);
            this._drawArms(g, geo, cell, p);
            this._drawCracks(g, geo, cell, p);
            this._drawFeet(g, geo, cell, p);
        } else if (this.kind === "HYDRA") {
            this._drawVents(g, geo, cell, p);
            this._drawCrown(g, geo, cell, p);
            this._drawHeads(g, geo, cell, p);
        } else {
            this._drawCore(g, geo, cell, p);
            this._drawSweep(g, geo, cell, p);
            this._drawPort(g, geo, cell, p, o.x);
            this._drawBarrels(g, geo, cell, p);
            this._drawPlumes(g, geo, cell, p);
        }
        this._drawSparks(g, geo, cell);
        g.globalCompositeOperation = "lighter";
        this._drawCharge(g, cv, geo, cell, h, p);
        this._drawFlare(g, cell, w, h, p);
        g.restore();
    }

    /**
     * Repaint one hull cell `k` of the way up the ramp. Nothing is drawn when
     * the promotion lands on the rung the cell already has, which is most of
     * why this is affordable: measured over a 120 s fight the hull costs one
     * `drawImage` plus ~160 `fillRect`s in an average frame and 425 at the
     * worst, against the 2576 a full cell-by-cell repaint would cost.
     */
    _promote(g, geo, cell, c, r, k) {
        const rung = geo.cells[r * geo.cols + c];
        if (rung < 0) {
            return;
        }
        const to = geo.rungs[clamp(Math.round(lift(rung, k)), 0, TOP)];
        if (to === rung) {
            return;
        }
        g.fillStyle = this.ramp[to];
        g.fillRect(c * cell, r * cell, cell, cell);
    }

    /** Burnt-out sections: the lights go off in the hull's dark cells. */
    _drawDamage(g, geo, cell, p) {
        if (p.dmg <= 0.05) {
            return;
        }
        const n = Math.round(geo.dead.length * p.dmg * (this.t.damage.deadCells / 100));
        g.fillStyle = this.ramp[0];
        for (let i = 0; i < n; i++) {
            const d = geo.dead[i];
            g.fillRect(d[0] * cell, d[1] * cell, cell, cell);
        }
    }

    /**
     * The core window. The glass is promoted from the middle outwards, so a
     * pulse reads as light spreading rather than the whole lens switching; the
     * cells that fall outside `coreScale` are pushed back down to the plating,
     * which is what makes the core visibly shrink as an attack is charged.
     * `coreBias` slides that centre towards the side the hull leans to.
     */
    _drawCore(g, geo, cell, p) {
        const box = geo.coreBox;
        if (!box) {
            return;
        }
        const cx = box.cx + p.coreBias;
        for (let i = 0; i < geo.core.length; i += 2) {
            const c = geo.core[i];
            const r = geo.core[i + 1];
            const dx = (c - cx) / box.rx;
            const dy = (r - box.cy) / box.ry;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d > p.coreScale) {
                // Out of the squeezed lens: back to plating, not to black.
                const rung = geo.cells[r * geo.cols + c];
                if (rung !== RUNG[4]) {
                    g.fillStyle = this.ramp[RUNG[4]];
                    g.fillRect(c * cell, r * cell, cell, cell);
                }
                continue;
            }
            this._promote(g, geo, cell, c, r, p.core * (1 - 0.35 * d));
        }
    }

    /** The bottom edge lights cell by cell as the curtain leaves the hull. */
    _drawSweep(g, geo, cell, p) {
        if (p.sweep < 0) {
            return;
        }
        const t = this.t.curtain;
        const front = p.sweep * geo.cols;
        const tail = geo.cols * t.tail;
        const r0 = Math.max(0, geo.edgeRow - t.rows + 1);
        for (let r = r0; r <= geo.edgeRow; r++) {
            for (let c = 0; c < geo.cols; c++) {
                const d = front - c;
                if (d < 0 || d >= tail) {
                    continue;
                }
                this._promote(g, geo, cell, c, r, t.lift * (1 - d / tail));
            }
        }
    }

    /**
     * The shutter over the hole in the *next* curtain. `gap` is decided one
     * curtain ahead and travels in the snapshot, so the hull can point at the
     * hole on every machine. The gap is often outside the hull, which is wide
     * but not as wide as the field: the port then slides to that edge and stays
     * there, still pointing the right way.
     */
    _drawPort(g, geo, cell, p, cx) {
        if (p.port <= 0.01 || this.gapX == null) {
            return;
        }
        const t = this.t.port;
        const half = t.wCells / 2;
        const local = (this.gapX - cx) / cell + geo.cols / 2;
        const mid = clamp(local, half, geo.cols - 1 - half);
        const c0 = Math.round(mid - half);
        const c1 = Math.round(mid + half);
        const rowMid = (t.top + t.bottom) / 2;
        const span = ((t.bottom - t.top) / 2) * p.port;
        // A shutter that only ramps up is a lamp; the flicker is what says it is
        // a mechanism opening under load.
        const pulse = p.port * (1 - t.flicker + t.flicker * (0.5 + 0.5 * Math.sin(this.time * 33)));
        for (let c = c0; c <= c1; c++) {
            for (let r = t.top; r <= t.bottom; r++) {
                const d = Math.abs(r - rowMid);
                let k = 0;
                if (d <= span) {
                    k = t.lift * (0.35 + 0.65 * pulse);
                } else if (d < span + t.bloomCells) {
                    k = t.lift * 0.3 * pulse;
                }
                if (k <= 0.01) {
                    continue;
                }
                this._promote(g, geo, cell, c, r, k);
            }
        }
    }

    /**
     * Muzzle flash at the two siege barrels: the nozzle clusters nearest the
     * centre line, which is where `_updateColossus` fires the salvo from. The
     * flash is the nozzle itself going white, not a sprite laid over it.
     */
    _drawBarrels(g, geo, cell, p) {
        const t = this.t.barrel;
        for (let i = 0; i < geo.barrels.length && i < 2; i++) {
            const f = this.barrels[i];
            if (f < 0) {
                continue;
            }
            const n = geo.nozzles[geo.barrels[i]];
            const a = 1 - f;
            for (let c = n.c0; c <= n.c1; c++) {
                const base = geo.lowest[c];
                if (base < 0) {
                    continue;
                }
                for (let r = Math.max(0, geo.edgeRow); r <= base; r++) {
                    this._promote(g, geo, cell, c, r, t.lift * a);
                }
                // The flame leaving the mouth, outside the silhouette.
                for (let k = 1; k <= t.rows; k++) {
                    g.globalAlpha = a * (1 - (k - 1) / (t.rows + 1));
                    g.fillStyle = this.ramp[k > 1 ? TOP - 1 : TOP];
                    g.fillRect(c * cell, (base + k) * cell, cell, cell);
                }
            }
        }
        g.globalAlpha = 1;
    }

    /**
     * Level of one emitter, 0..2: a slow breath phase-shifted between the inner
     * and the outer pair, plus the throttle (drift, enrage charge, recoil, the
     * arrival), minus whatever the brace holds back. Over 1 the nozzle is at the
     * top of the ramp, which is what the muzzle flash rides on.
     */
    _emitLevel(i, geo, p) {
        const t = this.t.emitters;
        const n = geo.nozzles[i];
        const ph = (i * 0.29 + (n.outer ? t.outerPhase : 0)) % 1;
        const w = (this.time / t.period + ph) % 1;
        let lvl = t.idle + t.amp * (0.5 + 0.5 * Math.sin(w * 6.2832));
        lvl += Math.abs(p.vx01) * t.velGain + p.charge * 0.6 + this.recoil * 0.8
            + p.enter * this.t.entry.burn;
        // Time-hashed flicker: the draw must not consume the simulation's noise.
        lvl += Math.sin(this.time * 21 + i * 2.4) * 0.5 * t.jitter;
        return clamp(lvl * (1 - p.plant * this.t.plant.emitDrop), 0, 2);
    }

    /** Plumes hanging off the nozzle clusters, tapered and tilted against the drift. */
    _drawPlumes(g, geo, cell, p) {
        const t = this.t.emitters;
        for (let i = 0; i < geo.nozzles.length; i++) {
            const n = geo.nozzles[i];
            const lvl = this._emitLevel(i, geo, p);
            const len = Math.round(lvl * t.maxCells);
            if (len <= 0) {
                continue;
            }
            for (let k = 0; k < len; k++) {
                const a = 1 - k / len;
                // Solid ramp rungs, so the plume stays pixel art: white at the
                // mouth when the nozzle is over-driven, then glass, tint, and a
                // dark accent tail.
                const rung = lvl > 1 && k === 0 ? TOP : a > 0.7 ? TOP - 1 : a > 0.4 ? RUNG[4] : 1;
                const taper = Math.floor(k / 2);
                const tilt = Math.round(-p.vx01 * t.tiltCells * (k / Math.max(1, len - 1)));
                g.globalAlpha = k === len - 1 ? 0.55 : 1;
                g.fillStyle = this.ramp[rung];
                for (let c = n.c0 + taper; c <= n.c1 - taper; c++) {
                    const base = geo.lowest[c];
                    if (base < 0) {
                        continue;
                    }
                    g.fillRect((c + tilt) * cell, (base + 1 + k) * cell, cell, cell);
                }
            }
        }
        g.globalAlpha = 1;
    }

    /**
     * VULCAN's slot: the three-layer gauge (see the VULCAN block's `slot`).
     *
     * The frame carries the bottom of the heat reading, the neon ring the top,
     * and the white middle -- which cannot brighten, being already at the top
     * of the ramp -- carries the *cold* end by being pulled down towards the
     * light tint between cycles. Together they are the one thing on the hull
     * that lets the player read the heat without a HUD, which is what the sheet
     * asks for; separately, none of them could, because no single index in this
     * art has both headroom and a floor.
     *
     * The hood is not a shutter drawn over the slot: `open` widens the falloff
     * so the light reaches further out of the middle, and the volley pips are
     * cut *out* of it -- the middle dips for the charge and the lit pips are the
     * cells left at white. One pip per rock, which is the promise the telegraph
     * under the hull is also keeping.
     */
    _drawSlot(g, geo, cell, p) {
        const slot = geo.slot;
        if (!slot || !p.slot) {
            return;
        }
        const t = this.t.slot;
        const S = p.slot;
        const box = slot.box;
        const cx = box.cx + p.coreBias;
        const reach = 1 + S.open * 0.35;
        const level = (c, r, k) => {
            if (k === 0) {
                return 0;
            }
            const dx = (c - cx) / box.rx;
            const dy = (r - box.cy) / box.ry;
            const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) / reach);
            return k * (1 - t.falloff * d);
        };
        for (let i = 0; i < slot.frame.length; i += 2) {
            this._promote(g, geo, cell, slot.frame[i], slot.frame[i + 1],
                level(slot.frame[i], slot.frame[i + 1], S.frame));
        }
        for (let i = 0; i < slot.ring.length; i += 2) {
            this._promote(g, geo, cell, slot.ring[i], slot.ring[i + 1],
                level(slot.ring[i], slot.ring[i + 1], S.ring));
        }
        // The middle. A flash is the only thing that leaves it alone outright.
        if (S.flash) {
            return;
        }
        const gbox = slot.gbox;
        const span = Math.max(1, gbox.c1 - gbox.c0 + 1);
        for (let i = 0; i < slot.glass.length; i += 2) {
            const c = slot.glass[i];
            const r = slot.glass[i + 1];
            if (S.pips) {
                const pip = Math.floor(((c - gbox.c0) / span) * S.pips);
                if (pip < S.lit) {
                    continue;           // a lit pip: the art's own white
                }
                this._promote(g, geo, cell, c, r, t.coldDip);
                continue;
            }
            this._promote(g, geo, cell, c, r, level(c, r, S.cold));
        }
    }

    /**
     * VULCAN's two shoulder fans: the lever, so they have to be the most
     * legible thing on the hull after the slot.
     *
     * A blade cannot turn on a cached raster, so what turns is the light inside
     * the housing -- a bright cell orbiting the pod, at a rate that rises with
     * the heat and rises again while the exhaust is actually dumping. The pod
     * itself is the same disc-with-falloff HYDRA's heads use, over the cells
     * `hullParts` hands the engine as the hitbox, so what you can shoot is what
     * lights up.
     */
    _drawFans(g, geo, cell, p) {
        const fans = geo.fans;
        if (!fans || !p.fans) {
            return;
        }
        const t = this.t.fans;
        for (let i = 0; i < fans.length && i < 2; i++) {
            const fan = fans[i];
            const f = p.fans[i];
            if (f.jam) {
                this._drawJammedFan(g, geo, cell, fan, i, f);
            }
            // A hit is that fan alone going white for four frames. The hull has
            // no flash of its own on purpose (it is under fire every frame), so
            // this is the one place the feedback belongs -- and it is the one
            // the player is aiming at.
            if (f.hurt > 0.01) {
                for (let n = 0; n < fan.cells.length; n += 2) {
                    this._promote(g, geo, cell, fan.cells[n], fan.cells[n + 1], f.hurt * 0.95);
                }
            }
            if (f.k <= 0.02 || f.jam) {
                continue;
            }
            const pod = fan.pod;
            for (let c = pod.c0; c <= pod.c1; c++) {
                for (let r = pod.r0; r <= pod.r1; r++) {
                    const dx = (c - pod.cx) / pod.rx;
                    const dy = (r - pod.cy) / pod.ry;
                    const d = Math.sqrt(dx * dx + dy * dy);
                    if (d > 1) {
                        continue;
                    }
                    this._promote(g, geo, cell, c, r, f.k * (1 - t.falloff * d));
                }
            }
            // The blade: one cell of light going round inside the housing, and
            // the one thing on the fan that reads *both* halves of the state --
            // it turns faster and burns brighter as the forge heats. Scaled by
            // the heat rather than flat, because flat put a permanently white
            // cell on each shoulder: at rest the sheet's blade is the accent's
            // own colour, so at heat 0 this lands under the 0.17 step and paints
            // nothing at all.
            const a = (this.fanSpin + i * 0.5) * 6.2832;
            const bc = Math.round(pod.cx + Math.cos(a) * pod.rx * t.bladeR);
            const br = Math.round(pod.cy + Math.sin(a) * pod.ry * t.bladeR);
            const hot = Math.max(p.heat, p.crack, this.ventE);
            this._promote(g, geo, cell, bc, br,
                Math.max(f.k, t.blade * (t.bladeCold + (1 - t.bladeCold) * hot)));
            if (this.fanFlash[i] > 0) {
                this._drawFanFlame(g, geo, cell, fan, clamp01(this.fanFlash[i] / t.flashSec));
            }
        }
    }

    /**
     * A jammed fan, and its clearing. Pulled *down* the ramp -- the only
     * direction that reads as "off" on plating this dark -- with sparks at the
     * rim, and the clearing grows back behind a lit front the way a rebuilt
     * HYDRA head does. All three states come off the one number the fan travels
     * as, so none of them costs a cue.
     */
    _drawJammedFan(g, geo, cell, fan, i, f) {
        const t = this.t.fans;
        const box = fan.box;
        const span = Math.max(1, box.r1 - box.r0 + 1);
        for (let n = 0; n < fan.cells.length; n += 2) {
            const d = (fan.cells[n + 1] - box.r0) / span;
            if (d <= f.clear - t.clearFront) {
                continue;               // cleared: the sprite's own colour
            }
            if (d <= f.clear) {
                this._promote(g, geo, cell, fan.cells[n], fan.cells[n + 1], t.clearLift);
                continue;
            }
            this._promote(g, geo, cell, fan.cells[n], fan.cells[n + 1], -t.jam);
        }
        // Time-hashed rather than drawn from the particle system: the draw must
        // not consume the simulation's noise.
        for (let k = 0; k < t.stumpCells; k++) {
            const ph = this.time * t.stumpRate + k * 2.39 + i * 1.7;
            const a = 1 - (ph % 1);
            if (a < 0.2) {
                continue;
            }
            g.globalAlpha = clamp01(a * 0.85);
            g.fillStyle = this.ramp[a > 0.6 ? TOP : RUNG[4]];
            g.fillRect(Math.round(box.cx + Math.sin(ph * 3.1 + k) * 3) * cell,
                Math.round(box.r0 - (1 - a) * 3) * cell, cell, cell);
        }
        g.globalAlpha = 1;
    }

    /** The ring leaving a fan: cells outboard of the housing, going white. */
    _drawFanFlame(g, geo, cell, fan, a) {
        const t = this.t.fans;
        const out = fan.pod.cx < geo.cols / 2 ? -1 : 1;
        for (let k = 1; k <= t.flameCells; k++) {
            const f = 1 - (k - 1) / t.flameCells;
            g.globalAlpha = a * f;
            g.fillStyle = this.ramp[k > 2 ? RUNG[4] : k > 1 ? TOP - 1 : TOP];
            const c = Math.round(fan.pod.cx + out * (fan.pod.rx + k));
            for (let r = Math.round(fan.pod.r0); r <= Math.round(fan.pod.r1); r++) {
                g.fillRect(c * cell, r * cell, cell, cell);
            }
        }
        g.globalAlpha = 1;
    }

    /**
     * The smoke, above the hull's top edge.
     *
     * The stacks it leaves from are read out of the art the same way AEGIS's
     * plumes are read out of the columns hanging below its bottom edge -- these
     * are the ones that rise above the top one -- and they go out one by one as
     * the hull fails, which is where the sheet's DEATH state (the chimneys
     * bursting in sequence) ends up in a port that has no DEATH.
     *
     * Drawn in solid ramp rungs with alpha, so it stays pixel art: grey-blue
     * metal while a puff is fresh, then mid hull, then the dark accent as it
     * goes. Nothing here is promoted -- smoke is outside the silhouette, and
     * promotion is for light landing *on* the hull.
     */
    _drawSmoke(g, geo, cell) {
        for (const s of this.smoke) {
            const a = 1 - s.age / s.life;
            g.globalAlpha = clamp01(a * 0.8);
            g.fillStyle = this.ramp[a > 0.62 ? RUNG[3] : a > 0.3 ? RUNG[2] : RUNG[9]];
            const w = s.fat && a > 0.45 ? 2 : 1;
            g.fillRect(Math.round(s.c) * cell, Math.round(s.r) * cell,
                cell * w, cell * w);
        }
        g.globalAlpha = 1;
    }

    /**
     * The hands at the ends of the two side arms: lit under the sight line,
     * burning while the beam is live.
     *
     * `parts.arms` is where `_vulcanBeams` actually anchors the beams, so this
     * is light on the muzzle the beam leaves from -- and because the hand is a
     * corner of the arm rather than a point on a flat lip, the glow is a disc
     * around it that falls off into the plating, with the flame hanging off the
     * cells below.
     */
    _drawArms(g, geo, cell, p) {
        const arms = geo.arms;
        if (!arms || p.forge <= 0.02) {
            return;
        }
        const t = this.t.forge;
        const flick = p.forge * (0.75 + 0.25 * Math.sin(this.time * 29));
        for (const arm of arms) {
            const h = arm.hand;
            const c0 = Math.max(0, Math.round(h.c - HAND_R));
            const c1 = Math.min(geo.cols - 1, Math.round(h.c + HAND_R));
            const r0 = Math.max(0, Math.round(h.r - HAND_R));
            const r1 = Math.min(geo.rows - 1, Math.round(h.r + HAND_R));
            for (let c = c0; c <= c1; c++) {
                for (let r = r0; r <= r1; r++) {
                    const d = Math.hypot(c - h.c, r - h.r) / HAND_R;
                    if (d > 1) {
                        continue;
                    }
                    this._promote(g, geo, cell, c, r, flick * (1 - 0.55 * d));
                }
            }
            // The flame leaving the hand, outside the silhouette, in solid ramp
            // rungs so it stays pixel art.
            for (let k = 1; k <= t.rows; k++) {
                g.globalAlpha = flick * (1 - (k - 1) / (t.rows + 1));
                g.fillStyle = this.ramp[k > 2 ? RUNG[4] : k > 1 ? TOP - 1 : TOP];
                const w = k > 2 ? 1 : 2;
                for (let c = h.c - (w >> 1); c <= h.c + (w >> 1); c++) {
                    g.fillRect(c * cell, (h.r + k) * cell, cell, cell);
                }
            }
        }
        g.globalAlpha = 1;
    }

    /**
     * The overheat: light coming through the plating. Taken from the *end* of
     * the hull's stable dark-cell order, so it can never fight `_drawDamage`,
     * which burns the same list out from the front.
     */
    _drawCracks(g, geo, cell, p) {
        if (p.crack <= 0.02) {
            return;
        }
        const t = this.t.crack;
        const n = Math.min(geo.dead.length, Math.round(t.cells * p.crack));
        for (let i = 0; i < n; i++) {
            const d = geo.dead[geo.dead.length - 1 - i];
            // Each crack breathes on its own hash, so they do not blink as one.
            const a = 0.55 + 0.45 * Math.sin(this.time * t.rate + i * 1.9);
            this._promote(g, geo, cell, d[0], d[1], t.lift * p.crack * a);
        }
    }

    /**
     * The footfall: the foot that just landed lights up and throws dust under
     * itself. The feet are the two nozzle clusters -- the columns that hang
     * below the bottom edge -- so, as with everything else here, which cells
     * they are comes out of the art.
     */
    _drawFeet(g, geo, cell, p) {
        const feet = geo.nozzles;
        if (!feet || !feet.length || !p.walk || p.walk.fall < 0) {
            return;
        }
        const t = this.t.gait;
        const a = clamp01(1 - p.walk.fall / 0.5);
        const n = feet[p.walk.fallFoot % feet.length];
        for (let c = n.c0; c <= n.c1; c++) {
            const base = geo.lowest[c];
            if (base < 0) {
                continue;
            }
            for (let r = Math.max(0, geo.edgeRow); r <= base; r++) {
                this._promote(g, geo, cell, c, r, t.footLift * a);
            }
        }
        // Dust, time-hashed off the footfall rather than the particle system.
        for (let k = 0; k < t.dustCells; k++) {
            const ph = k * 2.39 + p.walk.fallFoot * 1.7;
            const spread = (Math.sin(ph * 3.7) * t.dustSpread) * (1 - a);
            g.globalAlpha = clamp01(a * 0.7);
            g.fillStyle = this.ramp[a > 0.6 ? RUNG[3] : RUNG[2]];
            const c = Math.round(n.x + spread);
            const base = geo.lowest[clamp(c, 0, geo.cols - 1)];
            g.fillRect(c * cell, ((base < 0 ? geo.rows : base) + 1 + Math.floor((1 - a) * 2)) * cell,
                cell, cell);
        }
        g.globalAlpha = 1;
    }

    /**
     * HYDRA's chest grilles: the four bars the sprite already paints in the
     * neon accent, rippling downwards once per turn of the spiral. They sit on
     * the tint's rung, so they cross into the light tint at k = 0.17 and into
     * glass at 0.5 -- the idle ripple stays under the second line and only the
     * enrage puts them there.
     */
    _drawVents(g, geo, cell, p) {
        const box = geo.ventBox;
        if (!p.vent || !box) {
            return;
        }
        const span = Math.max(1, box.r1 - box.r0);
        for (let i = 0; i < geo.vents.length; i += 2) {
            const r = geo.vents[i + 1];
            const ph = p.vent.phase - ((r - box.r0) / span) * this.t.vents.rowPhase;
            const k = p.vent.base + p.vent.amp * (0.5 + 0.5 * Math.sin(ph));
            if (k <= 0.01) {
                continue;
            }
            this._promote(g, geo, cell, geo.vents[i], r, k);
        }
    }

    /**
     * HYDRA's crown: the lens between the eyes, and a ring of light on the
     * plating around it turning with the spiral.
     *
     * The lens is AEGIS's core window on a different set of cells -- promoted
     * from the middle outwards so a pulse spreads instead of switching, and
     * slid towards the side the hull leans to. What is new is the ring:
     * `this.spin` is the arm angle `_updateColossus` is firing at *this* frame,
     * so the lit arcs cannot end up anywhere except on the cells the last pair
     * of bullets left from. Getting that for free is the whole reason the angle
     * is handed over instead of being reinvented here.
     */
    _drawCrown(g, geo, cell, p) {
        const crown = geo.crown;
        if (!crown) {
            return;
        }
        const t = this.t;
        const box = crown.coreBox;
        const cx = box.cx + p.coreBias;
        for (let i = 0; i < crown.core.length; i += 2) {
            const c = crown.core[i];
            const r = crown.core[i + 1];
            const dx = (c - cx) / box.rx;
            const dy = (r - box.cy) / box.ry;
            const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
            this._promote(g, geo, cell, c, r, p.core * (1 - t.core.falloff * d));
        }

        // The ring. While the crown emits it burns in as many arcs as there
        // are arms, sitting on the sectors the bullets are leaving from. While
        // it winds up it runs a *single* arc around instead, turning the way
        // the coming spiral will: that direction is the whole content of the
        // warning, and a wall of bullets you can only read once it is on top of
        // you is not a pattern, it is a die roll.
        const ring = t.ring;
        const seq = this.crownWarn > this.emit01;
        const arcs = seq ? 1 : Math.max(1, this.arms);
        const level = seq ? this.crownWarn : this.emit01;
        const lift = (seq ? ring.warnLift : ring.lift + this.rage01 * ring.rageLift) * level;
        const cut = seq ? ring.warnCut : ring.cut;
        const at = seq
            ? this.time * ring.seqRate * 6.2832 * this.spinDir
            : this.spin;
        const step = 6.2832 / arcs;
        const half = step / 2;
        const idle = ring.idle * (1 - level);
        for (let i = 0, j = 0; i < crown.ring.length; i += 2, j++) {
            // Angle to the nearest arc, folded into 0..half.
            const d = Math.abs((((crown.ringA[j] - at) % step) + step * 1.5) % step - half);
            const k = 1 - d / half;
            const f = k > cut ? (k - cut) / (1 - cut) : 0;
            const promote = lift * f * f + idle;
            if (promote <= 0.01) {
                continue;
            }
            this._promote(g, geo, cell, crown.ring[i], crown.ring[i + 1], promote);
        }
    }

    /**
     * HYDRA's two side heads. Neither can turn -- the hull is one cached raster
     * -- so what a head does instead is move the light inside itself: the
     * promoted disc sits on its mouth, slides towards the ships and grows out
     * into the plating as the fan winds up. Both heads fire in the same frame,
     * so both flash together; only the muzzle flame is drawn outside the
     * silhouette, hanging off the columns under the mouth for the same reason
     * AEGIS's barrel flame does -- that is where the bullets leave from.
     */
    _drawHeads(g, geo, cell, p) {
        const heads = geo.heads;
        if (!heads || !p.heads) {
            return;
        }
        const t = this.t.heads;
        const open = t.openCells * clamp01(this.plant);
        for (let i = 0; i < heads.length && i < 2; i++) {
            const head = heads[i];
            const h = p.heads[i];
            if (h.dead) {
                this._drawDeadHead(g, geo, cell, head, i, h);
            }
            // A hit is the whole head going white for four frames, and nothing
            // else on the hull moving: that is the point of it.
            if (h.hurt > 0.01) {
                for (let n = 0; n < head.cells.length; n += 2) {
                    this._promote(g, geo, cell, head.cells[n], head.cells[n + 1], h.hurt * 0.95);
                }
            }
            if (h.k <= 0.02) {
                continue;
            }
            const rad = head.r + open;
            const cx = head.gbox.cx + this.aimH * t.biasCells;
            for (let n = 0; n < head.cells.length; n += 2) {
                const c = head.cells[n];
                const r = head.cells[n + 1];
                const dx = c - cx;
                const dy = r - head.gbox.cy;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d > rad) {
                    continue;
                }
                this._promote(g, geo, cell, c, r, h.k * (1 - t.falloff * (d / rad)));
            }
            if (this.headFlash[i] > 0) {
                this._drawMuzzle(g, geo, cell, head, clamp01(this.headFlash[i] / t.flashSec));
            }
        }
    }

    /**
     * A destroyed side head, and its rebuild.
     *
     * Dead, it is pulled *down* the ramp -- the only direction that reads as
     * "off" on plating this dark -- and the stump it hangs from throws sparks.
     * The rebuild grows back out of that stump: every cell knows how far it is
     * from it (`sd`), so the head fills in from the arm outwards behind a lit
     * front instead of fading in as one block. The eyes come last, which
     * `pose()` handles by holding the mouth level down until `eyesAt`.
     */
    _drawDeadHead(g, geo, cell, head, i, h) {
        const t = this.t.heads;
        for (let n = 0, j = 0; n < head.cells.length; n += 2, j++) {
            const d = head.sd[j];
            if (d <= h.grow - t.growFront) {
                continue;               // rebuilt: the sprite's own colour
            }
            if (d <= h.grow) {
                // The growth front.
                this._promote(g, geo, cell, head.cells[n], head.cells[n + 1], t.growLift);
                continue;
            }
            this._promote(g, geo, cell, head.cells[n], head.cells[n + 1], -t.dead);
        }
        // Sparks at the stump. Time-hashed rather than drawn from the particle
        // system: the draw must not consume the simulation's noise.
        for (let k = 0; k < t.stumpCells; k++) {
            const ph = this.time * t.stumpRate + k * 2.39 + i * 1.7;
            const a = 1 - (ph % 1);
            if (a < 0.15) {
                continue;
            }
            const dc = Math.sin(ph * 3.1 + k) * 2;
            const dr = -(1 - a) * 4;
            g.globalAlpha = clamp01(a * 0.9);
            g.fillStyle = this.ramp[a > 0.6 ? TOP : a > 0.3 ? TOP - 1 : RUNG[4]];
            g.fillRect(Math.round(head.stump.c + dc) * cell,
                Math.round(head.stump.r + dr) * cell, cell, cell);
        }
        g.globalAlpha = 1;
    }

    /** The fan leaving a mouth: cells under the head's own bottom edge. */
    _drawMuzzle(g, geo, cell, head, a) {
        const t = this.t.heads;
        for (let c = Math.round(head.gbox.c0); c <= Math.round(head.gbox.c1); c++) {
            const base = geo.lowest[c];
            if (base < 0) {
                continue;
            }
            for (let k = 1; k <= t.flameCells; k++) {
                const f = 1 - (k - 1) / t.flameCells;
                // Leaning the way the fan was thrown, and in solid ramp
                // rungs, so the flame stays pixel art instead of a gradient.
                const tilt = Math.round(this.aimH * t.flameTilt * (k / t.flameCells));
                g.globalAlpha = a * f;
                g.fillStyle = this.ramp[k > 2 ? RUNG[4] : k > 1 ? TOP - 1 : TOP];
                g.fillRect((c + tilt) * cell, (base + k) * cell, cell, cell);
            }
        }
        g.globalAlpha = 1;
    }

    _drawSparks(g, geo, cell) {
        for (const p of this.sparks) {
            const a = 1 - p.age / p.life;
            g.globalAlpha = clamp01(a * 0.85);
            g.fillStyle = this.ramp[a > 0.6 ? TOP : a > 0.3 ? TOP - 1 : RUNG[4]];
            g.fillRect((p.c * geo.cols + p.dc) * cell, p.r * cell, cell, cell);
        }
        g.globalAlpha = 1;
    }

    /**
     * The enrage charge: the hull itself heats up from the core outwards. Drawn
     * as vertical slices of the cached raster added back on top of itself, so
     * the glow stops exactly at the silhouette without a second raster.
     */
    _drawCharge(g, cv, geo, cell, h, p) {
        if (p.charge <= 0.01) {
            return;
        }
        const c = this.t.charge;
        const rx = cv.width / geo.cols;
        for (let i = 0; i < c.bands; i++) {
            const c0 = (i / c.bands) * geo.cols;
            const c1 = ((i + 1) / c.bands) * geo.cols;
            const d = Math.abs((c0 + c1) / 2 - geo.cols / 2) / (geo.cols / 2);
            const a = p.charge * c.max * Math.max(0, 1 - d * c.falloff);
            if (a <= 0.01) {
                continue;
            }
            g.globalAlpha = Math.min(1, a);
            g.drawImage(cv, c0 * rx, 0, (c1 - c0) * rx, cv.height,
                c0 * cell, 0, (c1 - c0) * cell, h);
        }
        g.globalAlpha = 1;
    }

    /** One expanding ring of cells on the phase change. */
    _drawFlare(g, cell, w, h, p) {
        if (p.flare < 0) {
            return;
        }
        const t = this.t.rage;
        const a = 1 - p.flare;
        const rad = (t.ringCells + p.flare * (w / cell) * 0.42) * cell;
        g.strokeStyle = "rgba(" + this.hot + "," + (a * 0.55).toFixed(3) + ")";
        g.lineWidth = cell;
        g.strokeRect(w / 2 - rad, h / 2 - rad * 0.55, rad * 2, rad * 1.1);
    }
}
