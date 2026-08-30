/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - the places the run flies through.
 *
 * A backdrop is decorative: it never touches the simulation, so it does not
 * travel in the snapshot. `backgroundForWave(wave)` is pure, which is what
 * keeps host and guests looking at the same sky without a single extra byte on
 * the bus.
 *
 * Each entry names a `kind` (the painter) plus its parameters, so 20+ places
 * come out of ~17 painters. A painter may implement any of:
 *   - `init(bd)`   one-off state (dust, cloud bands, orbits…)
 *   - `paint(bd, g)`  static art, baked **once** into an offscreen layer at
 *     half resolution. Use it for anything that does not move.
 *   - `update(bd, ts)` / `live(bd, g)`  per-frame state and drawing. Only for
 *     what genuinely moves: it runs at 60 fps behind the whole game.
 * Direction A places (below) bake from two more phases instead of `paint`:
 *   - `field(bd, x, y)`  the place as a scalar 0..1, sampled once per art
 *     pixel and snapped to the place's ramp through an ordered dither. It may
 *     return its own `rgb` to send that pixel to a second ramp.
 *   - `hard(bd, g, pix)`  hard-edged art laid over the quantised field, drawn
 *     in art pixels rather than logical ones.
 *   - `occlude(bd, x, y)`  how much of a baked star this place hides, 0..1.
 *     A place with nothing solid in it may use it for the other reason a
 *     star gets dropped: the plate behind it is already lit.
 *   - `blit(bd, g)`  the baked layer on screen, if one `drawImage` of it is
 *     not enough. Only MOLTEN WORLD, whose plane slides against itself.
 * Painters draw in **logical arena coordinates** (the 680x540 space), over the
 * box the camera can reach when it pulls back for a colossus.
 *
 * Each entry also carries the `desc` the glossary shows, so the catalogue of
 * places lives here and not in a second list that would drift from it.
 *
 * `BACKGROUNDS` order is the order they show up in a run: append at the end.
 *
 * -------------------------------------------------------------------------
 * PLACES study, Direction A -- places 1-5 (2026-08-29)
 * -------------------------------------------------------------------------
 * The study built VIOLET NEBULA both ways -- quantised, and deliberately
 * smooth -- and Direction A won: the seam at the play field was an accident,
 * not a depth cue. `deep`, `planet_blue`, `nebula_violet`, `belt` and
 * `blackhole` are now baked on the same 3 px lattice and the same 8-rung ramps
 * the sprites live on. Places 6-27 were still soft gradient art at the time;
 * `system` has been converted since (below), and the rest still are.
 *
 * Departures from the study, and why:
 *   1. The study kept a 1428x1162 upscaled copy of every bake (~6.6 MB each,
 *      "roughly 32 MB" by its own port note). Here the 476x388 buffer is kept
 *      and `drawImage` scales it with filtering off, which is one raster call
 *      either way and 9x less memory. That is also what the soft places
 *      already do with their half-resolution layer.
 *   2. The study drifts the baked plane but not the live one. With a 30 px
 *      horizon that slides the grains 28 px across their own hole, so `live`
 *      takes the drift too on a Direction A place: the sky is one rigid plane.
 *   3. Drift stays on the engine's `t * 0.0016` (a 3927-frame period), not the
 *      study's 1400. Five places breathing out of step with the other 22 is a
 *      worse defect than a slow breath.
 *   4. EVENT HORIZON's dust is the study's Keplerian inspiral, not the
 *      Newtonian integrator it replaces, which the brief asked to keep. The
 *      disc is a plane at 0.42 squash and the grains ride *in* it; a
 *      screen-plane 2D integrator cannot do that, which is exactly why the old
 *      painter had to draw the disc separately from its dust. The behaviour
 *      the entry promises survives -- omega goes as r^-1.5, so a grain both
 *      brightens and accelerates on the way in, and is gone at the horizon --
 *      and it drops the `Math.random()` the old `orbiter` used, which this
 *      file's own rules forbid.
 *   5. The singularity moved from `-H * 0.3` (entirely above the arena, so the
 *      hole and the photon ring were never on screen and the thumbnail was a
 *      smear of dust) to `H * 0.30`, inside it. The `desc` moved with it.
 *   6. The veil is per place now (`p.veil`, 0-22%) instead of the flat 30% laid
 *      over all 27. `bgScrim` falls back to `BG_SCRIM` for the rest.
 *   7. Point lights take `p.starRamp` rather than the top of the place's own
 *      ramp. The study's rule broke the one hard constraint the veil exists
 *      for: EVENT HORIZON's ramp is entirely warm, so its 300 baked stars came
 *      out as 3 px amber squares on black -- the size, the colour and the
 *      surround of a bullet. Measured on the composed arena 1500 frames in,
 *      counting warm blobs of 40 px or less sitting on a surround under
 *      luminance 40: EVENT HORIZON 1 (a grain on the disc's own edge) and
 *      VIOLET NEBULA 0, against dozens before. The other three are at 0
 *      because nothing in them is warm at all.
 *   8. ASTEROID BELT's far rocks are sized in art pixels. The study's 1-4.4 px
 *      radius rounds to exactly one art pixel for all 520 of them at its own
 *      default scale, so the band baked as dither noise and the lit-edge
 *      branch never ran once. They are 1-3 art pixels across now.
 *   9. The same place's mid rocks were painted one rung over the haze they sit
 *      on and could not be seen: body two rungs over it, lit edge four, shadow
 *      under it.
 *  10. A grain on the far side of the disc is hidden by the horizon. The disc
 *      is squashed and the hole is not, so the innermost grains crossed the
 *      black circle and lit up inside it.
 *
 * -------------------------------------------------------------------------
 * GAS GIANT DESCENT, smooth branch (2026-08-29)
 * -------------------------------------------------------------------------
 * Place 6 is the study's **version B**. The study itself prefers A, its pixel
 * version, and it is right about the reasons -- but A is the treatment places
 * 1-5 already have, and the catalogue would then read pixel for six places,
 * soft for twenty-one and pixel again for none. B keeps place 6 in the same
 * language as the twenty-one it sits among, and it is the version the study
 * itself calls the fallback that still reads. Nothing here forecloses A: the
 * quantise helper would go in `beltTile` and the ramp in `p`.
 *
 * The whole study lands on the shared `surface` painter as parameters, so the
 * other six atmosphere worlds run on the same code path. Verified rather than
 * asserted: 26 of the 27 places hash byte-identical over the full 1428x1162
 * box **and** their 272 px glossary thumbnail, before and after.
 *
 * Axes added to `surface`: `flow`, `bandForm`, `bandSpread`, `skyStops`,
 * `glow`, `decks[]` (rate, thickness, gap, wave, alpha, filaments, streaks),
 * `flakes`, `vortices`, `density`. Identity on all of them is today's bank
 * world, so a place that sets none of them is unchanged.
 *
 * Departures from the study, and why:
 *   1. Version A is not built. See above -- the choice is B, not a limitation.
 *   2. `bandSpread` defaults to today's [0.30, 0.60] rather than the study's
 *      [0, 1]. The study calls the clustering a bug and it is right, but the
 *      six bank worlds were composed against it and re-tuning them is not this
 *      port. The axis is here; flipping one is a two-word edit to its entry.
 *   3. The study places a streak at `b.y + b.h * (b.h + 2)`, which is h
 *      squared: on 9-70 px bands that is 100-5000 px down the tile, and every
 *      second streak was culled before it drew. Fixed to the evident intent
 *      (2 px clear of the band edge), which is what makes the sheet's counts
 *      -- 2 far, 3 mid, 1 near -- real. Streaks are the most planet-like
 *      feature after the vortices, so half of them missing is not cosmetic.
 *   4. Tiles are baked at `layerScale`, the same 0.5 every soft place already
 *      uses, not at the study's full box resolution. That is 4 tiles + a mask
 *      + a scratch at 714x581 instead of 1428x1164: ~10 MB rather than ~40,
 *      and it is the resolution the study itself rendered and measured at.
 *   5. The tile wraps at `bd.h` (1162 px here) rather than the study's 1164,
 *      because that is the box this engine actually has. Periods come out at
 *      7263 / 3873 / 2767 / 1056 frames instead of 7275 / 3880 / 2771 / 1058.
 *   6. Drift stays the engine's `t * 0.0016`, not the study's 0.0031, for the
 *      same reason the Direction A places kept it: one place breathing out of
 *      step with the other 26 is the worse defect.
 *   7. The engine's near star field takes the place's `flow` (`bgFlow`). The
 *      study left this open and recommended exactly this; without it the
 *      backdrop rises while the stars fall, which is visible. Every other
 *      place is +1 and reads as before.
 *   8. The near plane's density ramp is strips of constant alpha, not the
 *      study's scratch plus `destination-in`. It is the same picture -- max
 *      channel difference 2 over the box -- for one box area of fill instead
 *      of three, and no scratch canvas: 8.5 ms a frame down to 4.6 at zoom 1
 *      on a CPU rasteriser. This place is blit-bound by construction, which is
 *      the cheap side of the trade on a GPU-backed canvas and the expensive
 *      one without, so the box areas are worth counting. Measured against the
 *      soft places it sits among: 4.6 ms against ICE WORLD's 1.3 at zoom 1,
 *      21.9 against 6.2 with the camera pulled back for a colossus.
 *   9. A place carrying its own `p.veil` is now composed at full value, not at
 *      the 0.85 the soft places are dimmed to. That was already true of the
 *      five Direction A places; it is what "the composition buys the contrast"
 *      means, and without it the descent gradient flattens.
 *
 * Measured here, at frame 1500, on the 680x540 arena on a 3 px lattice, in
 * linear light: mean L 0.0397, 95th percentile 0.0854, brightest 0.1398. The
 * 4:1 threshold against the brightest enemy bullet (#ffb45e, L = 0.543) puts
 * the ceiling on p95 at 0.098, so the place clears it with **no veil at all**
 * and `veil` is 0 -- the second place in the catalogue that needs none. The
 * study's own version B, run headless from its page for comparison, measures
 * p95 0.0854 and mean 0.0422 on the same lattice.
 *
 * -------------------------------------------------------------------------
 * INNER SYSTEM, Direction A -- place 7 (2026-08-29)
 * -------------------------------------------------------------------------
 * The sixth conversion, and the first place whose hard art *moves*: the dust
 * plane, the five orbital lanes and the star bake, and five bodies ride over
 * them as sprites rasterised once per lighting direction and blitted on the
 * lattice. `pixelSystem` replaces the old soft `system` painter, which is gone.
 *
 * The composition is one ramp for everything and a second one for the star
 * alone. The cool ramp is the place tint rotated to its complement and held
 * under 0.045 chroma, so nothing the field can produce is in the family the
 * enemies fire in; that is what buys the star the right to stay warm. The star
 * pays for it with size instead -- its warm core is 72 px across against the
 * 40 px ceiling a bullet has to fit under.
 *
 * Departures from the study, and why:
 *   1. `occlude` is used, where the study left it returning 0 everywhere and
 *      listed that as a gap. The study still had a rule for its stars -- place
 *      one only where the plate behind it is under luminance 46 -- and that is
 *      exactly the phase the contract already has. It drops 3 of the 170 here,
 *      which is the 3% of the box the dust actually lights.
 *   2. There is no `update`. Every angle is a function of `bd.t`, so the place
 *      keeps no state at all and `backdropThumb` takes it straight to frame
 *      1500 instead of stepping it there 1500 times.
 *   3. Drift is not quantised to the lattice. `Backdrop.draw` puts one
 *      continuous `sin(t * 0.0016) * DRIFT` on the plate and the live layer
 *      together, so the plane is rigid -- which is what the study's
 *      quantisation is for -- and a seventh place breathing on a period of its
 *      own is the worse defect. Same call, and the same reason, as places 1-5.
 *   4. The study's own integer hash is dropped for this file's `mkNoise`,
 *      which is the "fold it into the shared generator" its port notes ask
 *      for. Its lattice wraps every 64 units; the belt samples +-53 of it and
 *      the grain 0-50, so nothing tiles inside the box.
 *   5. The sprite baker is a shared helper (`shadedSphere`) taking an explicit
 *      four-tone palette, which is the smaller of the two shapes the port
 *      notes offer -- no `bodyPalettes` array beside `landRamp`.
 *   6. No `liveHard` phase was added. The study asks for one so a moving solid
 *      can stay on the lattice, but `live` on a Direction A place already runs
 *      inside the drift translate in logical coordinates and `snapTo` already
 *      puts an element on the bake grid; five `drawImage`s with smoothing off
 *      is the whole of it. A sixth phase would carry one place.
 *   7. The star moved from 0.28 / 0.12 of the arena to 0.17 / 0.24, which is
 *      where the study puts it. The reason is the pulled-back camera: at 0.24
 *      across, the colossus hull's left wing tip covers the star, and the star
 *      is the one element in the composition that cannot be behind the boss.
 *   8. Orbit radii stay absolute logical px while the star is a fraction of
 *      the arena, because only the short side of the arena is a fixed size.
 *      Same split `pixelHorizon` already uses.
 *
 * Measured here, on the composed 680x540 arena at frame 1500, by the study's
 * own detector (a warm blob is luminance >= 100, r-b >= 40, r >= g, 40 px or
 * less on its longest side, sitting on a 4 px surround under luminance 40):
 * **0 features pass all four tests**, at veil 0, 12 and 30 alike. Twenty warm
 * blobs exist and every one of them fails on size or on surround: they are the
 * corona and the fragments of it, the largest 81 px across. Mean luminance
 * 22.6 and p95 69 before the veil, 20.6 and 61 at `veil: 12` -- which puts the
 * place between ASTEROID BELT (18.1 / 22) and VIOLET NEBULA (38.4 / 59), and
 * well under BLUE MARBLE (48.3 / 98) and GAS GIANT DESCENT (76.8 / 123).
 *
 * `topRung: 6` is load-bearing rather than a safety net: the field peaks at
 * rung 6.76 and the cap clips 78 art pixels that would otherwise come out at
 * #5f7098, the brightest thing outside the star. It clips the corona's second
 * ramp too -- 134 art pixels -- but all of them lie inside the 452 the star's
 * core disc covers, and `hard` paints that straight from `landRamp[7]` rather
 * than through the ramp, so the star keeps its top rung either way.
 *
 * Measured against this arena rather than carried over: the box is the same
 * 1428x1162 the study drew for, so its geometry transfers unchanged. The two
 * numbers that had to be checked here are the belt's separation from the wave
 * -- scenery rocks drift at 0.10-0.32 px/frame and 6-9 px wide against
 * `spawnRock`'s 0.7-2.0 px/frame and 32-80 px -- and the live budget, which
 * comes out at 12 rasterising calls for the three quiet places, 6 for
 * `system`, 78 for `belt` and 96 for `blackhole`, against the ~122 average
 * the animator ports quote.
 *
 * -------------------------------------------------------------------------
 * ICE WORLD, quantised branch (2026-08-30)
 * -------------------------------------------------------------------------
 * The 7th Direction A conversion, and the first place whose whole idea is an
 * *edge*: cold air carries no moisture, so it carries no haze, so nothing here
 * softens with distance. The study built it both ways and the soft branch is
 * what settles it -- `surface` composites additively over a gradient, and
 * additive compositing cannot make an occluding edge, so a far ridge drawn
 * that way brightens the sky behind it instead of hiding it. Aerial
 * perspective enforced by the blend mode is the exact thing this place is
 * about not having.
 *
 * The study also proposes four axes on the shared painter (`clarity`,
 * `relief`, `halo`, `settle`) with ice as the only non-zero row. They are not
 * added: with ice on `pixelIce` all seven rows are zero, so every branch would
 * be dead code carried by the one place that no longer uses the painter. The
 * axis table is still the right design language for the desert's dune line and
 * the jungle's canopy when those convert; it belongs in whichever port first
 * has a caller.
 *
 * Departures from the study, and why:
 *   1. The eddy period is 480 frames, not 240. Its own numbers disagree -- see
 *      `ICE_EDDY_RATE` -- and the entry's superlative is the thing that turns
 *      on which of them wins.
 *   2. The shelf cracks sit in the first 26 px under the near range instead of
 *      the 100 px band the study puts them in. At this composition that band
 *      is almost entirely below the arena floor, so six of its seven cracks
 *      were art nobody could see.
 *   3. No baked stars, and therefore no `occlude`. The study's sky is empty on
 *      purpose and its measured feature count depends on it: the top of this
 *      ramp is bright enough that a 1-2 art px point light IS the thing the
 *      count exists to forbid. Its own note that `occlude` should "cover the
 *      three ranges so baked halo pixels do not print through rock" describes
 *      something `field` already does -- a pixel under a ridge line returns
 *      rock and never asks for the halo. The engine's own 44 near stars still
 *      draw over the place, so the sky is not literally starless in play.
 *   4. Drift is the shared `sin(t * 0.0016) * DRIFT`, not the study's 3 px on
 *      a 900-frame period. Same call, and the same reason, as places 1-6.
 *   5. Geometry is anchored on the arena (ridge bases as fractions of its
 *      height, halo centre as fractions of both) rather than on the box, so it
 *      composes where the study composed it. Its own numbers are box-relative
 *      art pixels against a box 14 px shorter than this one.
 *
 * Measured here on the composed 680x540 arena at frame 1500, by the study's
 * own detector (a connected run at luminance >= 0.62, under 40 px on both
 * axes, on a 4 px surround under 0.30): **0 features at `veil: 6`**, from 9 at
 * veil 0 -- so the veil is load-bearing rather than taste, exactly as the
 * study says. Mean luminance 0.156 (the study's number to three places), p95
 * 0.262, brightest pixel 0.587 against a 0.80 enemy core. Live cost 15
 * rasterising calls a frame, worst case, against 78 for the belt and the 86
 * this place used to spend on 16 ellipses and 70 motes.
 *
 * The regression for all of it: every place composed at frame 1500 plus its
 * 272 px glossary thumbnail, hashed. 26 of 27 byte-identical.
 *
 * -------------------------------------------------------------------------
 * COMET TRAIL, quantised branch (2026-08-30)
 * -------------------------------------------------------------------------
 * The 8th Direction A conversion and the first place that **moves**: every
 * other one bakes because everything hard-edged in it is a function of
 * position, and a comet is not. It is also the place where a soft backdrop was
 * most obviously soft -- it is held at normal zoom against ordinary waves, so
 * nothing large ever sits in front of it to hide a gradient while the near star
 * field and the 32 px hulls are hard-edged an inch away.
 *
 * What the old painter did not do is the thing the catalogue line already
 * promised: its tail pointed along the velocity. Both tails start from the
 * anti-solar direction now and only the dust bends off it, which is what makes
 * the angle between them open from 18 degrees at entry to 153 at exit.
 *
 * Departures from the study, and why:
 *   1. **No per-frame `getImageData`.** The study draws the tails with canvas
 *      gradients into an art-resolution buffer and quantises the readback of
 *      their bounding box every frame. A GPU readback in the middle of every
 *      frame is a cost no other place here pays, and it is avoidable: the
 *      tails are scanline-filled straight into the buffer at the rung the
 *      gradient asks for, through the same ordered dither the bake uses. Same
 *      result, no readback, and no antialiased edge to undo afterwards.
 *      Measured: 24k art pixels a frame on average, 48k worst, and **two**
 *      canvas calls -- one `putImageData` over the dirty rect and one blit --
 *      against the study's own 6 calls plus 38k/86k.
 *   2. **The star keeps its shape and gives up rung 7.** The study reserves
 *      rung 7 for the nucleus and the star's core; its core measures pale
 *      because it paints one from a near-white gradient, and this ramp's rung
 *      7 is the entry's own gold. A 9 px block of that is *warm* by the
 *      measurement's own test, which is the one thing a backdrop may not
 *      contain. INNER SYSTEM's answer -- be warm, and pay for it by being 72 px
 *      across -- would mean a 56 px sun in a composition that does not want
 *      one. The core stops at rung 6 instead.
 *   3. **`starRamp` is dimmer than the study's.** It cut the top rung's share
 *      to 3.5% to keep baked stars out of the count; that lever does not exist
 *      here, because `_bakeField` buckets a star by `round(a * 3) / 3` and
 *      `starList` always spreads `a` over a 0.5-wide band, which puts 48% of
 *      them on the top rung at any usable `aMin`. Measured with the study's own
 *      ramp: 24 small bright regions. Every rung is under the measurement's own
 *      0.70 threshold instead, so the share stops mattering.
 *   4. Geometry is anchored on the arena and the crossing scales with its
 *      width, so the head takes the same 43 seconds to cross whatever shape the
 *      window is. The orbit's slope is fixed, because the anti-orbital
 *      direction is what the dust bends towards and it may not change with the
 *      window.
 *   5. Drift is the shared `sin(t * 0.0016) * DRIFT`, not the study's 7 px on a
 *      1400-frame period, and it is not quantised to the lattice. Same call,
 *      and the same reason, as places 1-7.
 *
 * Measured here on the composed 680x540 arena, by the study's own detector (a
 * connected region over luminance 0.70 on a 2 px grid, under 40 px on both
 * axes, warm if its mean R exceeds 1.12x its mean B): **one small bright
 * region and zero warm ones** at `veil: 12`, and the one is the nucleus -- 6 px,
 * pale, and the thing that should be the brightest in a place named after it.
 * Mean arena luminance 0.041, brightest pixel 0.783. The head is inside the
 * arena for 62% of a crossing and some part of the comet is visible for 79%;
 * the rest is the empty sky the entry's last clause is about.
 *
 * `THUMB_WARMUP` still lands well: at frame 1500 the head is at arena
 * (456, 238) with activity 0.99, 86 frames short of closest approach. That was
 * already the constant's reason and it survives the new 2600-frame crossing --
 * worth re-checking if either ever moves again.
 *
 * -------------------------------------------------------------------------
 * RINGED GIANT, quantised branch (2026-08-30)
 * -------------------------------------------------------------------------
 * The 9th Direction A conversion, and the one where the contract already held
 * the answer to the place's hardest problem. Translucency, occlusion and
 * behind-versus-in-front are three descriptions of one number, and `occlude` is
 * that number: drawn soft, a ring plane is the same arcs stroked twice with
 * alpha and a hope about the ordering; drawn as a plane with an opacity
 * profile, the body test and the ring test are evaluated at the same art pixel
 * and which one wins is the sign of one plane coordinate. `pixelGiant`
 * replaces the entry's use of the shared `planet` painter, whose ring
 * machinery is deleted with it -- ECLIPSE is the only place left on `planet`
 * and it has no rings.
 *
 * The place gains three things it did not have: the planet's shadow across the
 * far arc, solved as a cylinder rather than drawn; nine belts in *latitude*
 * evaluated on the sphere, so the weather curves with the body and compresses
 * toward the limb instead of lying flat across the disc; and the turn, which is
 * the only thing here that cannot bake.
 *
 * Departures from the study, and why:
 *   1. **No per-frame readback, and no per-frame work at all.** The study
 *      strokes 31 arcs into an art-pixel buffer and then quantises the whole
 *      thing with a `getImageData`/`putImageData` pair -- 40,860 pixels a frame
 *      -- and its own port notes say not to ship that. Its replacement (art-
 *      pixel spans, 90-160 `fillRect`s) is not needed either: the density table
 *      steps one cell every 86.7 frames, so the live layer is a pure function
 *      of 96 states. It is rasterised into the buffer on a roll step and blitted
 *      the other 86 frames out of 87. Measured: **one rasterising call a frame**
 *      for the live layer (two for the place, counting the bake's own blit),
 *      418 art pixels and one `putImageData` every 86.7 frames.
 *   2. **A clump promotes the band it lands on** instead of taking an absolute
 *      rung. The study's rungs -- 2 in umbra, 4 in penumbra, 5 or 6 in the light
 *      -- are the same numbers wherever the plate is dark and a silent no-op
 *      where it is not: the B ring bakes at rung 5, so 24 of the 31 clumps
 *      repainted **nothing at all** and the turn was invisible. Promotion
 *      cannot have that failure. Measured after: 418 art pixels a cell of which
 *      11.4% land back on the plate, against 226 and 71% before.
 *   3. **The Encke gap and the F strand are dropped unconditionally**, not
 *      below 0.85 zoom. The study makes the bake depend on the camera for them,
 *      which would mean a re-bake on the wave-30 pull-back; it does not have to,
 *      because the art lattice here is 3 *logical* px and does not change with
 *      the camera at all. Both features are under two art pixels at every zoom,
 *      so the study's own rule -- "anything under two art pixels is dropped
 *      rather than dithered" -- settles it once. Encke's 5 px fold into the A
 *      ring's outer step, which is 22 px, the same width as the Cassini.
 *   4. **`occlude` returns a fraction**, the first partial return in the
 *      catalogue and exactly what the study asks for, plus INNER SYSTEM's rule
 *      as a third clause: a star is hidden by the body, dimmed by a band's own
 *      opacity, and dropped where the plate is already lit (luminance 46). That
 *      last clause is what makes a star visible through the C ring, whose plate
 *      is rung 2, and invisible through B, whose plate is rung 5.
 *   5. **The star ramp comes down.** The study's #4a5866 / #8a97a3 / #d6dde4
 *      tops out at luminance 0.863 against the 0.62 the small-bright-feature
 *      detector cuts at; measured with it, this arena has 8 features. Every
 *      rung is under the threshold instead and it has 0. Third ramp to come
 *      down for this reason, after EVENT HORIZON and COMET TRAIL.
 *   6. The clump thresholds are retuned, because the counts are what the study
 *      tuned and the thresholds belong to its own generator: on `mkNoise` its
 *      0.70 leaves 17 clumps of 192 against its 31, and 0.65 lands on 31 with
 *      the same run structure. Same for the dense cut, 0.86 -> 0.82 for 5.
 *   7. Drift is the shared `sin(t * 0.0016) * DRIFT`, not the study's 6 px on a
 *      2992-frame period. Same call, and the same reason, as places 1-8. There
 *      is no `update` either: every angle is a function of `bd.t`.
 *
 * Two of the study's headline numbers are rejected by its own metrics, which is
 * now the fourth time.
 *
 * The first is **"both reworked branches put zero pixels in the enemy-fire
 * band"**. They cannot. Measured on the undithered field, the top two rungs of
 * this ramp are reached only on the body -- 622 art pixels of the arena, and 0
 * anywhere in the rings -- so any 8-rung quantisation of this composition paints
 * them, and rung 6 (#c9a463, the place's own gold) is inside the band's
 * brightness and chroma at any veil under 22. What the arena actually holds at
 * veil 16 is 7,755 pixels in the band, in 421 components under 40 px and **0
 * thin ones**: that is the ordered dither of a large lit planet, not 421
 * features. The study's detector has no surround test, which is the clause the
 * catalogue's own detector has had since ICE WORLD precisely so that the texture
 * of something big is not counted as a speck on a dark field. By that detector
 * the place measures **0 small bright features** at veil 6 and above, against
 * BLUE MARBLE's 13 -- and BLUE MARBLE is the nearest thing to it in the
 * catalogue. The study's own sentence is the resolution: every small bright
 * thing in this sky is cool, and every warm thing is large.
 *
 * The second is the **veil of 11**; see the entry.
 *
 * Measured here on the composed 680x540 arena at frame 1500: mean luminance
 * 0.162, p95 0.392, brightest pixel 0.690 (sRGB), 0.0404 / 0.1333 / 0.4379 in
 * linear light. The ramp's top rung is 36 arena pixels -- four art pixels of
 * cream on the lit limb -- so `topRung` is deliberately absent here: it would
 * be clipping nothing, which is the mirror of INNER SYSTEM, where it clips 78.
 * The regression is the same as the last three: 26 of 27 places byte-identical
 * over the composed frame and the 272 px thumbnail.
 * -------------------------------------------------------------------------
 * MOLTEN WORLD, quantised branch (2026-08-30)
 * -------------------------------------------------------------------------
 * The 10th Direction A conversion, and the place the shared veil was invented
 * for: it painted in the same warm reds as enemy fire and scattered 70 rising
 * 1-3 px embers the exact size of a bullet core. The study's finding is that
 * the veil was never doing the work -- its warm-feature count is *flat* from
 * veil 0 to veil 30, because a 30% black wash dims a bullet-sized ember and
 * the bullet next to it by the same fraction. What fixes the place is the
 * composition: the embers are deleted rather than resized, the crust goes
 * near-black, and the only hot thing left is one connected flow 430 px long,
 * which can never fall inside a 40 px window.
 *
 * The one thing here is superheated air. This is the only place where distance
 * dissolves instead of sharpening, and it is drawn by sliding whole art pixels
 * sideways: `blit` emits the baked plane as runs of art rows with independent
 * x offsets instead of the single `drawImage` every other place uses. That is
 * the one departure from the shared draw path in the whole catalogue, and it
 * is what makes the three ranges each sit a rung lighter than the one in front
 * -- the exact inversion of ICE WORLD nine waves earlier, which puts all three
 * on the same rung to prove that cold air carries no haze.
 *
 * Departures from the study, and why:
 *   1. The row blit is a RUN blit. The offset is quantised to whole art pixels
 *      (`Math.round`, which is also what makes it read as heat rather than as
 *      a compression artefact), so it is piecewise constant down the plane:
 *      the 388 rows of the box collapse into ~30 blits, pixel-identical to one
 *      blit a row. The study costed 128-136 blits a frame and argued it was
 *      worth it; it does not have to be paid.
 *   2. The flow is three concentric bands read off the distance to a per-row
 *      centre, not a stroked polyline read back out of a canvas channel. Same
 *      three rungs and the same undithered core; no second offscreen buffer.
 *      Its halo is a falloff rather than two stacked hard-edged strokes -- on
 *      an 8-rung ramp a stroke edge is a visible contour, and a falloff is
 *      what gives the dither something to scatter.
 *   3. No plane drift of its own. The study drifts +-9 px on a 1400-frame
 *      period; drift stays on the engine's `t * 0.0016`, same call and same
 *      reason as places 1-9.
 *   4. Geometry is anchored on the arena (the horizon as a fraction of its
 *      height) rather than on the box, so it composes where the study composed
 *      it: 0.46 of the study's box is 0.42 of this arena.
 *   5. No baked stars, no `occlude`, and `starRamp` is not needed. A point
 *      light here would be a bright warm feature a few pixels across on a dark
 *      surround, which is the definition of the thing being counted. The place
 *      answers it the opposite way to ICE WORLD, which took its stars onto a
 *      cool ramp: this one has no point lights at all and puts its one hot
 *      ramp on a feature that is never small.
 *
 * Two core changes it needed, both of which the other nine places bake through
 * unchanged: `field` may return a `flat` rung (this rung, undithered -- a
 * dithered flow core is a dotted line, and two dozen 3 px dots of #ffd06a are
 * two dozen bullets) and its own `cap`, since the sky stops at rung 6 and the
 * land at 5. The land cap is the one that had to be re-measured: the study
 * counts 32 warm features at cap 6, from the crack network dithering across
 * the 5/6 boundary and scattering isolated art pixels of #d85a12 through
 * near-black crust. On this arena the same sweep is 1 at cap 6 and 0 at cap 5
 * -- the direction of its result holds and the size of it does not, which is
 * the usual outcome of taking a study's canvas number literally. A painter may
 * also take over the layer blit.
 *
 * Measured on the composed 680x540 arena at frame 1500. The study's own
 * result does not survive the re-run, and what replaces it is better: the
 * warm-feature detector the last three ports were settled with reads **0 for
 * the old painter too**, at every veil. It is blind here, and the reason is
 * the reason the place was broken -- a feature only counts on a surround under
 * 0.30, and the old sky averaged 0.363. The defect was never a speck on a dark
 * field; it was that there was no dark field.
 *
 * So the instrument is the bottom quarter of the frame, where the flow front
 * is and where bullets pile up, against an enemy core at about 0.80:
 *
 *   was, veil 30   median 0.175   p99 0.628   whole frame mean 0.260
 *   is,  veil 6    median 0.046   p99 0.781   whole frame mean 0.088
 *
 * A bullet now sits on a field four times darker, and the p99 that went up is
 * the flow -- one connected component 278 px long, which is a structure and
 * not a speck. That is also what settles `veil: 6` as a measurement rather
 * than as taste: going on to 30 buys 0.008 of median darkness and costs the
 * flow 0.243 of its peak, which is most of the one thing the place has. Live
 * cost 56 rasterising calls a frame, 29 of them run blits, against 87 for the
 * painter it replaces and the 128-136 row blits the study costed itself at.
 * See `tools/neon_strike_bench/probe_molten.mjs`.
 *
 * What it leaves the shared painter: five worlds on `surface`, down from six,
 * and the ember block goes with it: `motes` had two directions and the other
 * five worlds all use the same one, so the sign is deleted rather than
 * defaulted. First time in the programme the shared painter has got smaller.
 * A two-place shared painter is not a shared painter, though, and the five
 * that are left should be reviewed as a group before the next breakout rather
 * than one at a time.
 *
 */

// The static layer is soft gradient art, so half resolution is free quality.
const LAYER_SCALE = 0.5;
// Slow parallax breathing applied to the static layer, in logical pixels. The
// baked box is this much taller on each side so the edge never shows.
const DRIFT = 14;
// Veil between the backdrop and the play field, for the places still painted
// the old way. Sixteen of the 27 are still on it, and about half of those
// (supernova, binary, graveyard...) paint in the same warm reds and the same
// 1-3 px motes the enemy bullets use, adding up in `lighter` until a bullet is
// indistinguishable from scenery. One flat number fixes those and flattens the
// rest, which is why a Direction A place carries its own `p.veil` instead --
// see `bgScrim`. The place this was invented for is no longer one of them, and
// what it measured on the way out is worth keeping: MOLTEN WORLD's warm-feature
// count was identical at veil 0 and at veil 30, so the number was never what
// was doing the work there.
export const BG_SCRIM = "rgba(5,6,14,0.30)";
// Where an atmosphere's sky colours sit down the box, by default. A place may
// pass its own `skyStops` when three stops cannot hold it -- the gas giant runs
// near-black to lit haze and needs four.
const SKY_STOPS = [0, 0.55, 1];
// One baked sky pixel, in logical pixels. At 3 the whole box bakes into a
// 476x388 buffer that is blown back up with filtering off, so the sky lands on
// the same lattice as the sprites in front of it.
const ART_PIX = 3;
// Bayer 4x4 ordered dither, and how much of a rung its threshold is worth. It
// is what carries a gradient across a ramp only eight rungs deep: at 0 every
// Direction A place bands into visible steps.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const DITHER = 1;
// EVENT HORIZON's geometry, in logical pixels: the horizon, where the disc
// starts and ends, and how flat it is seen from here.
const HOLE_R = 30;
const DISC_R0 = 52;
const DISC_R1 = 300;
const DISC_SQ = 0.42;
// BLUE MARBLE's star, as a direction rather than a sprite: up and to the
// right of the globe, which is what puts the terminator across its far half.
const SUN_X = 0.55;
const SUN_Y = -0.62;
const SUN_Z = 0.56;
// INNER SYSTEM's geometry, in logical pixels. The ecliptic is seen 0.2 rad off
// horizontal and squashed to a third of its depth, so an orbit is an ellipse
// and the sign of `sin(th)` alone says which half of it a body is on. Radii
// are absolute rather than a fraction of the arena, for the same reason EVENT
// HORIZON's disc is: only the short side of the arena is a fixed size.
const SYS_TILT_C = Math.cos(0.2);
const SYS_TILT_S = Math.sin(0.2);
const SYS_SQUASH = 0.34;
// The five orbits: radius, and how bright the dust lane on it is. A lane is
// `14 + 0.045 r` wide, which makes the outer ones broad and faint and the
// inner ones tight and sharp without a second number per orbit.
const SYS_ORBITS = [
    { R: 150, s: 0.85 },
    { R: 250, s: 1.0 },
    { R: 380, s: 0.92 },
    { R: 500, s: 0.78 },
    { R: 670, s: 0.62 },
];
// The rubble belt between the third and fourth orbits.
const SYS_BELT_R = 435;
const SYS_BELT_W = 48;
// The star: the core disc `hard` paints, and the radius inside which a
// far-side body is dropped rather than drawn as a dark bite out of the glare.
const SYS_CORE_R = 36;
const SYS_OCCULT_R = 52;
// Above this baked luminance a star is not placed. The dust plane fills the
// frame in this place, so a point light on a lit lane reads as noise rather
// than as a star behind it; rungs 0-3 of the place's ramp pass, 4-6 do not.
const SYS_STAR_MAX = 46;
// Crescent directions a body is rasterised in: every 22.5 degrees of orbit,
// which is a new sprite every 56 frames on the innermost body and every 375
// on the outermost.
const SYS_PHASES = 16;
// The five bodies: orbit radius, body radius, period in frames, where each one
// starts, and its own four tones dark to lit. They are hard art on palettes of
// their own rather than on the place's ramp -- five bodies at five distances
// cannot be told apart on eight shared rungs.
const SYS_BODIES = [
    { R: 150, r: 5, per: 900, th0: 0.7, pal: ["#0a0e18", "#2b3a55", "#4a5c7d", "#7f93b5"] },
    { R: 250, r: 7, per: 1500, th0: 0.35, pal: ["#0a1216", "#26414a", "#40606c", "#6f8fa8"] },
    { R: 380, r: 9, per: 2400, th0: 1.6, pal: ["#100c07", "#33291a", "#4d3f28", "#6b5a3a"] },
    { R: 500, r: 13, per: 3800, th0: 5.383, pal: ["#080c12", "#1f2c3d", "#3a4c66", "#59708f"] },
    { R: 670, r: 11, per: 6000, th0: 5.912, pal: ["#0a0a12", "#262a44", "#414669", "#6b6f9c"] },
];
// The field of a place that paints nothing at all, shared so the bake does not
// allocate one per art pixel.
/* ICE WORLD ----------------------------------------------------------------
 * The three ranges, near to far: where the base of each sits as a fraction of
 * the arena height, how far its crests rise above that, and which of the four
 * land rungs its body is painted in. Near is the darkest and the lowest, which
 * is the only depth cue in the place -- there is no haze to give another.
 */
const ICE_RIDGES = [
    { seed: 0x7777, n: 21, base: 0.961, amp: 24, rung: 0 },
    { seed: 0x4242, n: 13, base: 0.806, amp: 66, rung: 1 },
    { seed: 0x2329, n: 9, base: 0.617, amp: 102, rung: 2 },
];
// Snow, in art pixels, on every crest and always on this rung.
const ICE_CAP = 2;
const ICE_CAP_RUNG = 6;
const ICE_LAST = 7;
// The 22 degree halo: radius, the width of its falloff, and how far the disc
// inside it sits under the sky it stands in.
const ICE_HALO_R = 192;
const ICE_HALO_W = 5.7;
const ICE_HALO_HOLE = 0.022;
const ICE_SKY = [0.09, 0.66, 1.45];     // base, span, gamma down the box
const ICE_CRACKS = 7;
const ICE_CRACK_BAND = 26;              // logical px of shelf they may sit in
const ICE_CRACK_SEED = 0x0c1a;
// Fourteen flakes, falling 0.06-0.11 px a frame with a 7 px eddy. The eddy's
// period is 480 frames and not the study's 240, because those two numbers plus
// its own 7 px amplitude do not agree with each other: 7 px on a 240-frame
// sine peaks at 0.183 px/frame, where the study's own motion table claims
// 0.092 and rests the entry's superlative on it. At 240 the fastest thing here
// measures 0.214 px/frame; at 480 it is 0.143, which is what the table meant.
// That is what "the slowest weather of any of the places" is now worth: every
// other place whose scenery moves is quicker at its liveliest -- the gas
// giant's SLOWEST deck alone is 0.160 and its near one 1.10, the belt's rocks
// reach 0.32 -- and the three quiet Direction A places have no moving scenery
// at all. (Not the study's stronger form, "slower than the slowest element
// anywhere else": the belt's slowest rock drifts at 0.10 and no flake speed
// that still crosses the arena beats that.) Measured in `probe_ice.mjs`.
const ICE_FLAKES = 14;
const ICE_FLAKE_SEED = 0x0f1a;
const ICE_FLAKE_WRAP = 40;
const ICE_FALL = [0.06, 0.11];
const ICE_EDDY = 7;
const ICE_EDDY_RATE = 6.2832 / 480;

/* -------------------------------------------------------------------------- */
/* COMET TRAIL                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One crossing, in frames. The head's whole path is a pure function of it and
 * of `bd.t`, and the crossing index seeds its own generator, so nothing here
 * reads the frame counter as a random source: the same sequence replays from
 * any instant, which is what lets `backdropThumb` jump straight to frame 1500.
 */
const COMET_T = 2600;
// Where the head enters and how far it travels, as fractions of the arena
// width, so the crossing takes the same 43 seconds whatever shape the window
// is. The slope is fixed instead, because the anti-orbital direction is what
// the dust tail bends towards and it may not change with the window.
const COMET_X0 = -0.256;
const COMET_SPAN = 1.606;
const COMET_SLOPE = 0.13 / 0.42;
const COMET_Y0 = [0.006, 0.148];        // of H: the band a crossing enters in
// Activity: 1 at the closest approach and floored well above 0, so the comet
// is never a bare dot. The exit is brighter than the entry (0.39 against 0.25)
// because r grows more slowly on the way out -- the arc is asymmetric on
// purpose, and it is what tells a player they watched something happen.
const COMET_PERI = 230;
const COMET_ACT = [1.2, 0.15];
// The star. It sits inside the arena, which is the one change here worth
// arguing about: anti-solar geometry is unreadable if the thing being pointed
// away from is off screen, and it puts the only warm feature in the place
// permanently in frame. The small-bright-feature measurement is the defence.
const COMET_STAR = [0.824, 0.056];
const COMET_GLOW = [[260, 0.075], [120, 0.2], [40, 0.42]];
const COMET_CORE = [14, 0.95, 0.55, 0.7];   // radius, peak, mid stop, mid value
const COMET_STAR_LIT = 46;                  // baked-star cut-off, luminance
const COMET_SEED = 0x1e25;
const COMET_KSEED = 0x1421;

/**
 * The ion tail: a straight polyline along the anti-solar direction with a
 * travelling ripple on it. It ignores velocity entirely -- that is the whole
 * point of having two tails, and it is why this one swings 135 degrees across
 * a crossing while the dust swings about half as far.
 */
const COMET_ION = {
    n: 12, len: [150, 480], w: [9, 7],
    amp: 5, period: 110, crest: 1.1,
    alpha: [0.16, 0.24],                    // A = 0.40 * (0.4 + 0.6a)
    stops: [[0, 1], [0.6, 0.45], [1, 0]],
};
const COMET_FADE = [[0, 1], [1, 0]];

/**
 * The dust tail: an 18-node syndyne. Each step goes along
 * `normalise(anti-solar + 1.25 * u * anti-orbital)`, so it leaves the head
 * pointing away from the star and curves back along the path as it goes.
 *
 * Four nested striae, two of them sheared across the tail so the grain lanes
 * are not concentric. The gradient's peak is 0.3 of the way DOWN the tail and
 * not at the head: with it at the head the base of the dust tail measured as
 * one warm 20 x 24 px region at peak activity, which is exactly the thing a
 * backdrop may not contain. Moving the peak gives the head's cyan coma back to
 * the head and puts the gold 110 px behind it.
 */
const COMET_DUST = {
    n: 18, len: [120, 250], bend: 1.25,
    w0: 8, w1: [40, 50], flare: 0.75,
    alpha: [0.05, 0.16],                    // A = 0.16a + 0.05
    stops: [[0, 0.34], [0.3, 0.78], [0.6, 0.42], [1, 0]],
    // width scale, brightness, shear across the tail
    striae: [[1, 0.62, 6], [0.75, 0.76, 0], [0.52, 0.9, -5], [0.28, 1.05, 0]],
};

const COMET_COMA = {
    r: [12, 26], b: [0.35, 0.65],
    stops: [[0, 0.55], [0.35, 0.3], [1, 0]],
};

/**
 * Knots in the ion tail: spawned on the crossing's own generator, travelling
 * outward and retired past the tail's end. Peak alpha is capped at 0.34 so a
 * knot can never reach the top rung -- at 0.55 it did, and a lone bright block
 * halfway down the tail is a bullet.
 */
const COMET_KNOT = {
    every: [78, 52], speed: 2.4, over: 1.05,
    r: [5, 4], alpha: 0.34, cap: 60,
};

/* --- RINGED GIANT ---------------------------------------------------------
 *
 * The ring plane is the body's own equatorial plane, so everything about the
 * rings comes out of one orthonormal basis rather than out of drawn ellipses:
 * `GIANT_E1`/`GIANT_E2` span it in screen coordinates with a real z, and
 * `GIANT_AXIS` is its normal, which is also the body's pole. That third
 * component is the whole difference between this and the old painter -- it is
 * what lets the planet's shadow be solved rather than drawn, and it is what
 * makes the belts curve with the body instead of lying flat across the disc.
 */
const GIANT_TILT = -0.3;
// sin of the opening angle: 0.22 is 12.7 degrees, the tilt the entry has always
// had. The plane's z scale follows from it, so this one number is the camera.
const GIANT_SQUASH = 0.22;
const GIANT_COS = Math.cos(GIANT_TILT);
const GIANT_SIN = Math.sin(GIANT_TILT);
const GIANT_DEPTH = Math.sqrt(1 - GIANT_SQUASH * GIANT_SQUASH);
const GIANT_E1 = [GIANT_COS, GIANT_SIN, 0];
const GIANT_E2 = [-GIANT_SIN * GIANT_SQUASH, GIANT_COS * GIANT_SQUASH, GIANT_DEPTH];
const GIANT_AXIS = [GIANT_DEPTH * GIANT_SIN, -GIANT_DEPTH * GIANT_COS, GIANT_SQUASH];
// Positive z, so the shadow wedge falls on the far half -- the half the entry
// says passes behind the body.
const GIANT_LIGHT = (function normalise() {
    const v = [-1, -0.25, 0.35];
    const m = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / m, v[1] / m, v[2] / m];
})();

/**
 * The bands, in multiples of the body radius, with the fraction of the light
 * each one stops. Two of the study's seven are not here: the Encke gap (5
 * logical px) and the F strand (4). The lattice is 3 logical px and does not
 * change with the camera, so both are under two art pixels at every zoom --
 * "anything under two art pixels is dropped rather than dithered" is the
 * study's own rule and it applies unconditionally here. Dropping Encke leaves
 * the A ring in two steps of its own brightness, 1.785-1.935 and 1.935-2.000,
 * and every gap that has to read is now at or above the Cassini's 22 px.
 */
const GIANT_BANDS = [
    { a: 1.28, b: 1.47, op: 0.13, fin: 0.02 },
    { a: 1.47, b: 1.72, op: 0.4 },
    { a: 1.72, b: 1.785, op: 0.03 },
    { a: 1.785, b: 1.935, op: 0.26 },
    { a: 1.935, b: 2.0, op: 0.22, fout: 0.015, fk: 0.85 },
];
const GIANT_R0 = GIANT_BANDS[0].a;
const GIANT_R1 = GIANT_BANDS[GIANT_BANDS.length - 1].b;
// Base value of a ring pixel, how much its opacity adds, and a fine radial
// ripple so a band is grain and not a flat stripe.
const GIANT_RING_V = [0.16, 1.38, 0.035, 190];
// The umbra takes a ring point down to a tenth of lit; the penumbra is the last
// 6% of the perpendicular distance and the first 15% downstream.
const GIANT_UMBRA = 0.9;
const GIANT_PENUMBRA = [0.94, 0.15];
// ...and the rings' own shadow on the body, solved the same way round: the
// light ray from a surface point is crossed with the ring plane and the
// crossing radius looked up in the same table.
const GIANT_RING_SHADOW = 0.8;
// Terminator, limb darkening, and the atmosphere rim: 21 logical px of the lit
// limb, adding at most 0.34, source-over so it cannot exceed the top rung.
const GIANT_TERM = [-0.1, 0.16];
const GIANT_LIMB = 0.52;
const GIANT_RIM = [0.935, 0.998, 2.4, 0.34];
const GIANT_BODY_V = [0.3, 0.62, 0.035];

// Nine belts in latitude rather than fourteen ellipses across the disc, so the
// weather curves with the body and compresses toward the limb. Same seed the
// study tuned them against.
const GIANT_BELT_SEED = 2830;
const GIANT_BELTS = 9;
const GIANT_BELT_LAT0 = -1.02;
const GIANT_BELT_W = [0.07, 0.1];
const GIANT_BELT_A = [0.16, 0.24];
const GIANT_BELT_GAP = [0.015, 0.05];
const GIANT_BELT_FALL = 2.4;
const GIANT_BELT_BASE = 0.48;
// The mid-latitude group -- the decks the player flew through twelve waves
// earlier -- is the only one that carries filaments, and they go to the second
// ramp so they read as a different material, exactly as that place separates
// its filaments from its decks.
const GIANT_FIL = [3, 5];
const GIANT_FIL_SEED = 0x2b0e;
const GIANT_FIL_N = [3.5, 22];
const GIANT_FIL_AMP = 0.2;
const GIANT_FIL_GATE = 0.2;
const GIANT_FIL_CUT = 0.055;

// The turn. Bands B and A-inner carry a seeded azimuthal density table that
// rolls one cell every 86.7 frames -- 3.75 degrees a step, one turn in 8320
// frames (138.7 s). Stepping rather than sliding is what pixel art does, and
// it keeps every clump edge on the lattice.
const GIANT_CELLS = 96;
const GIANT_ROLL = 86.666;
const GIANT_CLUMP_SEED = 9214;
const GIANT_CLUMP_NOISE = 0x24ea;
const GIANT_CLUMP_MIX = [0.55, 0.45, 0.16, 5.5];
const GIANT_CLUMP_BANDS = [1, 3];
// The study's cut of 0.70 belongs to its own generator: on this file's shared
// noise it leaves 17 clumps of 192 against its 31, because `mkNoise` smooths
// where its hash does not and the tail of the distribution is thinner. 0.65
// lands on the same 31 and the same run structure, and 0.82 on the same 5 hot
// ones -- the counts are the thing the sheet tuned, not the thresholds.
const GIANT_CLUMP_CUT = 0.65;
const GIANT_CLUMP_HOT = 0.82;
const GIANT_CLUMP_W = 0.3;
const GIANT_CLUMP_ARC = 0.92;
// Three seats inside the band, picked per cell, so a clump is a lump in the
// ring rather than a segment of a drawn circle.
const GIANT_CLUMP_R = [0.34, 0.32];
// A clump PROMOTES the band it lands on -- one rung, two for a dense one --
// rather than taking a colour of its own. The study's absolute rungs (2 in
// umbra, 4 in penumbra, 5 or 6 in the light) are the same numbers wherever the
// plate is dark, and a silent no-op where it is not: the B ring bakes at rung 5
// and its 5 is what most clumps were painted with, so 24 of the 31 repainted
// nothing at all. Promotion cannot have that failure. The cap keeps them off
// the cream, which is the one rung this sky spends on the body.
const GIANT_CLUMP_STEP = [1, 2];
const GIANT_CLUMP_TOP = 6;

const GIANT_STAR_SEED = 0x117b;
const GIANT_STARS = 150;
// A star does not go on a plate that is already lit. Same rule and same number
// as INNER SYSTEM: it is what makes a star visible through the C ring and
// invisible through B, which is the sentence the study asks `occlude` for.
const GIANT_STAR_LIT = 46;

// MOLTEN WORLD, in logical pixels unless the name says art pixels. The
// horizon is a fraction of the arena: composition rather than physics, since
// it is what opens a valley mouth for the flow to run out of and what keeps a
// 200 px colossus hull against sky.
const LAVA_HORIZON = 0.42;
// The valley mouth: its half-width as a fraction of the box, then where the
// front edge of the plain sits at the mouth, how much further it falls away
// outside it, and how much noise breaks the line.
const LAVA_VALLEY_W = 0.15;
const LAVA_PLAIN = [18, 190, 24];
// The three ranges between the plain and the sky, near to far: where the base
// of the range sits relative to the horizon, how tall its peaks are, how much
// of the valley mouth it feels, the frequency and phase of its silhouette, the
// rung it sits on out of `LAVA_LAST`, how much noise mottles it, and the lit
// lip along its own crest. Each range is a rung lighter than the one in front,
// and that IS the place: the exact inversion of ICE WORLD, which puts all
// three on the same rung to prove that cold air carries no haze.
const LAVA_RANGES = [
    { base: 34, amp: 210, valley: 0.78, f: 0.006, ph: 0, rung: 1, nz: 0.9, lip: 7, lipK: 1.4 },
    { base: 4, amp: 150, valley: 0.34, f: 0.0044, ph: 21.5, rung: 3, nz: 0.8, lip: 7, lipK: 1.3 },
    { base: -12, amp: 86, valley: 0, f: 0.003, ph: 43, rung: 5.4, nz: 0.6, lip: 6, lipK: 0.7 },
];
// The rung a value of 1 lands on. All three of this place's ramps are the
// usual eight deep, so it is the bake's own `last` and the ranges can be
// written as the rungs they are.
const LAVA_LAST = 7;
// The land is capped two rungs under its ramp: 6 and 7 exist so the crack
// network has somewhere to reach for, and are never spent. At cap 6 the
// network dithers across the 5/6 boundary and scatters isolated 3 px #d85a12
// through near-black crust, which is the one thing in the study that measured
// badly.
const LAVA_LAND_CAP = 5;
// The two smoke plumes: x as a fraction of the box, half-width, and height.
// They are the only thing between the far range and the top of the box.
const LAVA_PLUMES = [[0.3, 40, 400], [0.71, 32, 320]];
const LAVA_PLUME_TOP = 26;
const LAVA_PLUME_CUT = 0.42;
const LAVA_PLUME_RUNG = 1.6;
// The crack network, in art pixels: how many, the seed they meander off, and
// the three passes stamped along each one -- half-width at the horizon, how
// much wider at the floor of the box, and what it adds to the crust value.
// The break between crust and crack is deliberate and large: rungs 0-3 are
// basalt and 4-5 are incandescence, with nothing in between.
const LAVA_CRACKS = 15;
const LAVA_CRACK_SEED = 20260829;
const LAVA_CRACK_PASS = [[1, 1.75, 0.3], [0.6, 0.9, 0.34], [0.45, 0.5, 0.4]];
// The flow, in art pixels and read off the distance to a per-row centre: the
// undithered core, the band around it, its fringe, and the two falloffs that
// pool light on the crust either side. It is the only feature in the place
// above luminance 100, and it is one connected component spanning the arena,
// so it can never fall inside a 40 px window -- which is the whole reason the
// embers could go.
const LAVA_FLOW_CORE = [1.95, 5.7];
const LAVA_FLOW_BAND = [3.45, 12.6];
const LAVA_FLOW_FRINGE = [4.45, 13.6];
const LAVA_FLOW_HALO = [[10.5, 54, 0.44], [5.7, 24, 0.55]];
// Where the flow comes out from under the plain, and the two sines that
// meander it down the valley.
const LAVA_FLOW_TOP = 8;
const LAVA_FLOW_AMP = [9, 36];
// The flow front, where the ground glow breathes: how far down the box under
// the horizon, its half-height, and the alpha it breathes between. One fill,
// and the only additive thing left in the place.
const LAVA_GLOW = { at: 0.35, half: 130, a: 0.05, amp: 0.03, rate: 0.008 };
// Ash. The one particle left, and it cannot be mistaken for fire on any of
// four axes at once: it is darker than its surround rather than brighter, it
// falls with gravity rather than rising against it, it is 2-3 art pixels where
// an enemy core is 1-4 logical, and it is an occluder -- you see it only where
// it crosses light. ICE WORLD's rule holds either way: a particle has to read
// as mass, and this one reads as mass by blocking instead of by glowing.
const LAVA_ASH = 26;
const LAVA_ASH_SEED = 4471;
const LAVA_ASH_FALL = [0.3, 0.58];
const LAVA_ASH_SWAY = 7;
const LAVA_ASH_RATE = 0.011;
const LAVA_ASH_WRAP = 40;
// The lightest ash that still sits under luminance 40 against the brightest
// rung of the horizon, so it is never the bright thing in its own
// neighbourhood.
const LAVA_ASH_COLOR = "rgba(50,36,28,0.92)";
// The shimmer, which is the whole place in five numbers: where the heat zone
// starts above the horizon and over how many px it reaches full strength; its
// amplitude in ART pixels, because one is invisible at thumbnail size and
// three reads as a wobble rather than as heat; the wave down the plane and how
// fast it travels; and the second-order beat that keeps the wave off a loop.
const LAVA_SHIM_TOP = 74;
const LAVA_SHIM_SPAN = 210;
const LAVA_SHIM_AMP = 2;
const LAVA_SHIM_K = 0.03;
const LAVA_SHIM_RATE = 0.021;
const LAVA_SHIM_BEAT = [1.7, 0.008, 0.007];

const FIELD_DARK = { v: 0 };
// The arena the glossary thumbnails are composed in. Painters place things in
// logical pixels, so a still has to be taken at the size they were written for
// and scaled down afterwards, not painted small.
const THUMB_W = 680;
const THUMB_H = 540;
// Frames of warm-up before the still is taken, so the live painters have
// something on screen. The comet sets the number: it starts off the left edge
// and needs about this long to reach the middle.
const THUMB_WARMUP = 1500;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** Deterministic xorshift: the same place looks the same on every machine. */
function mkRng(seed) {
    let s = seed || 1;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

function hexRGB(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex, a) {
    const c = hexRGB(hex);
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** Soft radial glow: the building block of nearly everything in here. */
function blob(g, x, y, r, color, alpha) {
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, rgba(color, alpha));
    grd.addColorStop(0.45, rgba(color, alpha * 0.34));
    grd.addColorStop(1, rgba(color, 0));
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, 6.2832);
    g.fill();
}

/** A star with a glow and a thin cross flare. */
function sun(g, x, y, r, color, alpha = 1) {
    g.save();
    g.globalCompositeOperation = "lighter";
    blob(g, x, y, r * 6, color, 0.3 * alpha);
    blob(g, x, y, r * 2.2, color, 0.55 * alpha);
    g.fillStyle = rgba("#ffffff", 0.92 * alpha);
    g.beginPath();
    g.arc(x, y, r, 0, 6.2832);
    g.fill();
    g.strokeStyle = rgba(color, 0.35 * alpha);
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x - r * 5, y);
    g.lineTo(x + r * 5, y);
    g.moveTo(x, y - r * 4);
    g.lineTo(x, y + r * 4);
    g.stroke();
    g.restore();
}

/** Speckle of faint far-away stars, for the layers that want their own. */
function speckle(g, bd, n, color, maxA) {
    for (let i = 0; i < n; i++) {
        const x = bd.x0 + bd.rng() * bd.w;
        const y = bd.y0 + bd.rng() * bd.h;
        const s = bd.rng() * 1.4 + 0.3;
        g.fillStyle = rgba(color, 0.1 + bd.rng() * maxA);
        g.fillRect(x, y, s, s);
    }
}


/* -------------------------------------------------------------------------- */
/* Direction A helpers                                                         */
/* -------------------------------------------------------------------------- */

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

/** Hermite ramp between two edges. A terminator is one, and so is a penumbra. */
function smoothstep(x, e0, e1) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
}

/**
 * The veil this place needs, as a canvas fill. Direction A gives every place
 * its own number in the data file -- none at all for DEEP SPACE, 22% under an
 * accretion disc -- because the flat 30% that used to go over all 27 was a fix
 * for nine of them and a tax on the other eighteen. Everything not ported yet
 * still gets the flat one.
 *
 * @param {object} def - one entry of BACKGROUNDS
 * @returns {string}
 */
export function bgScrim(def) {
    const veil = def && def.p ? def.p.veil : undefined;
    return veil === undefined ? BG_SCRIM : "rgba(6,4,12," + (veil / 100).toFixed(3) + ")";
}

/**
 * Which way the scenery of a place moves, +1 (falls past you) or -1 (rises).
 * The engine's own near star field takes it too: on a descent place the
 * backdrop rises, and a star field still drifting down is a contradiction you
 * can see. One sign, and the parallax agrees everywhere.
 *
 * @param {object} def - one entry of BACKGROUNDS
 * @returns {number}
 */
export function bgFlow(def) {
    return def && def.p && def.p.flow ? def.p.flow : 1;
}

/**
 * Mulberry32. A second generator next to `mkRng`, kept because the study's
 * literal seeds are what place the stars and the rocks: reseeding them off the
 * id would reshuffle art that was tuned by eye against these exact layouts.
 */
function mulberry32(seed) {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Integer hash in 0..1, for a value that has to stay put across respawns. */
function hash2(x, y, s) {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(s | 0, 0xc2b2ae35);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2545f491);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
}

/** A ramp as RGB triplets, so the bake never parses a hex per art pixel. */
function rampRGB(ramp) {
    return ramp.map(hexRGB);
}

/**
 * Value noise on a 64x64 lattice, smoothstepped and summed over `oct` octaves.
 * Every Direction A place is a couple of these read through a shaping function:
 * it is the one thing that gives eight rungs something to quantise.
 */
function mkNoise(seed) {
    const G = 64;
    const rng = mulberry32(seed);
    const grid = new Float32Array(G * G);
    for (let i = 0; i < G * G; i++) {
        grid[i] = rng();
    }
    const at = (x, y) => grid[((((y % G) + G) % G) * G) + (((x % G) + G) % G)];
    const smp = (x, y) => {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        const fx = x - xi;
        const fy = y - yi;
        const ux = fx * fx * (3 - 2 * fx);
        const uy = fy * fy * (3 - 2 * fy);
        const a = at(xi, yi);
        const b = at(xi + 1, yi);
        const c = at(xi, yi + 1);
        const d = at(xi + 1, yi + 1);
        const top = a + (b - a) * ux;
        const bot = c + (d - c) * ux;
        return top + (bot - top) * uy;
    };
    return (x, y, oct) => {
        let s = 0;
        let amp = 0.5;
        let f = 1;
        let norm = 0;
        for (let o = 0; o < oct; o++) {
            s += smp(x * f, y * f) * amp;
            norm += amp;
            amp *= 0.5;
            f *= 2.07;
        }
        return s / norm;
    };
}

/**
 * Snap a live element onto the baked art grid. The lattice is anchored on the
 * corner of the box, not on the arena, so a grain and the pixel of sky under
 * it line up; a live element drawn off it is the one thing that gives the
 * direction away.
 */
function snapTo(origin, v) {
    return origin + Math.floor((v - origin) / ART_PIX) * ART_PIX;
}

/** The far stars a Direction A place bakes into its own layer, in box coords. */
function starList(bd, seed, n, aMin) {
    const rng = mulberry32(seed);
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({
            x: bd.x0 + rng() * bd.w,
            y: bd.y0 + rng() * bd.h,
            a: aMin + rng() * 0.5,
            big: rng() > 0.87,
        });
    }
    return out;
}

/**
 * The dozen stars that breathe, inside the arena only. They are the whole live
 * layer of three of the five places: one art pixel each, three alpha steps,
 * and they never leave the place's own ramp, so they cannot show a colour the
 * sky behind them does not have.
 */
function twinkleList(bd, seed, n) {
    const rng = mulberry32(seed);
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({
            x: 40 + rng() * (bd.W - 80),
            y: 30 + rng() * (bd.H - 60),
            ph: rng() * 6.2832,
            rate: 0.006 + rng() * 0.01,
            a: 0.3 + rng() * 0.32,
        });
    }
    return out;
}

/** Their phase is the only state three of the five places keep. */
function breathe(bd, ts) {
    for (const t of bd.twinkle) {
        t.ph += t.rate * ts;
    }
}

/**
 * The three colours a point light in this place is allowed to be, dim to
 * bright. The top of the place's own ramp by default, which is what keeps a
 * star inside the sky it is in -- but a place whose ramp is entirely warm has
 * to say otherwise, or its stars come out as 3 px amber squares on black and
 * are exactly what the bullets look like.
 */
function starRamp(bd) {
    return bd.p.starRamp || [bd.p.ramp[5], bd.p.ramp[6], bd.p.ramp[7]];
}

/** Draw them: 12 rasterising calls a frame, worst case. */
function twinkles(bd, g) {
    const ramp = starRamp(bd);
    for (const t of bd.twinkle) {
        const a = t.a * (0.45 + 0.55 * Math.sin(t.ph));
        const q = Math.round(clamp(a, 0, 1) * 3) / 3;
        if (q <= 0) {
            continue;
        }
        g.fillStyle = q > 0.66 ? ramp[2] : q > 0.33 ? ramp[1] : ramp[0];
        g.fillRect(snapTo(bd.x0, t.x), snapTo(bd.y0, t.y), ART_PIX, ART_PIX);
    }
}

/** Rec. 709 luminance of an RGB triplet, on the same 0-255 scale. */
function lum(c) {
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * A shaded ball, rasterised once per lighting direction at art resolution.
 * `radius` is in logical pixels and `pal` is four tones dark to lit; the
 * result is `phases` canvases the caller blits with smoothing off, one per
 * 2*pi/phases of crescent direction.
 *
 * It is a shared helper rather than a routine inside one painter because a
 * moving solid is the one thing Direction A had no way to draw: `hard` runs at
 * bake time, so anything that moves has to be a sprite, and a sprite that is
 * not on the lattice is what gives the whole plane away.
 */
function shadedSphere(radius, pal, phases) {
    const ra = radius / ART_PIX;
    const s = Math.ceil(ra * 2) + 2;
    const rgb = rampRGB(pal);
    const out = [];
    for (let k = 0; k < phases; k++) {
        const a = (k * 6.2832) / phases;
        const lx = Math.cos(a);
        const ly = Math.sin(a);
        // The light leans 0.8 out of the screen, so a body lit from behind
        // keeps a rim instead of going flat black.
        const ln = Math.sqrt(lx * lx + ly * ly + 0.64);
        const cv = document.createElement("canvas");
        cv.width = s;
        cv.height = s;
        const g = cv.getContext("2d");
        const img = g.createImageData(s, s);
        const data = img.data;
        for (let j = 0; j < s; j++) {
            for (let i = 0; i < s; i++) {
                const nx = (i + 0.5 - s / 2) / ra;
                const ny = (j + 0.5 - s / 2) / ra;
                const d2 = nx * nx + ny * ny;
                if (d2 > 1) {
                    continue;
                }
                // Lambert against the sphere normal, on the same Bayer
                // threshold the field uses: a 6 px ball has a terminator two
                // pixels wide and it steps without it.
                const bay = (BAYER[(j & 3) * 4 + (i & 3)] / 16 - 0.46) * 0.07;
                const lamb = (nx * lx + ny * ly + Math.sqrt(1 - d2) * 0.8) / ln + bay;
                const col = rgb[lamb < 0.03 ? 0 : lamb < 0.3 ? 1 : lamb < 0.62 ? 2 : 3];
                const o = (j * s + i) * 4;
                data[o] = col[0];
                data[o + 1] = col[1];
                data[o + 2] = col[2];
                data[o + 3] = 255;
            }
        }
        g.putImageData(img, 0, 0);
        out.push(cv);
    }
    return out;
}

/**
 * INNER SYSTEM as a scalar. Everything static about the place comes out of
 * this one function: the ecliptic dust plane, the five dust lanes, the rubble
 * belt, the grain and the star's corona. `u` runs along the ecliptic and `w`
 * across it un-squashed, so `r` is a true orbital radius and every feature is
 * a function of it rather than of where it lands on screen.
 */
function systemField(bd, x, y) {
    const dx = x - bd.cx;
    const dy = y - bd.cy;
    const u = dx * SYS_TILT_C + dy * SYS_TILT_S;
    const v = -dx * SYS_TILT_S + dy * SYS_TILT_C;
    const w = v / SYS_SQUASH;
    const r = Math.sqrt(u * u + w * w);
    // Everything in the plane thins out with distance from the star.
    const fall = 1 / (1 + Math.pow(r / 260, 1.5));
    // The plane itself: a Gaussian across the ecliptic that flares as it goes.
    const th = 26 + 0.085 * r;
    const haze = Math.exp(-((v / th) * (v / th))) * fall;
    // The lanes, brighter on the near half than the far one.
    let bands = 0;
    for (const o of bd.orbits) {
        const t = (r - o.R) / o.wd;
        if (t > -2.6 && t < 2.6) {
            bands += Math.exp(-t * t) * o.s * (v > 0 ? 1.15 : 0.85);
        }
    }
    bands *= fall * 0.92 + 0.1;
    // The belt, sampled in the plane's own coordinates so it lies in the plane
    // rather than across the screen.
    let belt = 0;
    const bt = (r - SYS_BELT_R) / SYS_BELT_W;
    if (bt > -2.4 && bt < 2.4) {
        belt = Math.exp(-bt * bt) * Math.max(0, bd.rubble(u * 0.075, w * 0.075, 1) * 1.7 - 0.72);
    }
    const grain = (bd.grain(x * 0.035, y * 0.035, 1) - 0.5) * 0.045;
    const d = Math.sqrt(dx * dx + dy * dy);
    const halo = Math.exp(-Math.pow(d / 190, 1.2)) * 0.2;
    const cool = 0.032 + haze * 0.62 + bands * 0.55 + belt * 0.4 + grain + halo;
    // Inside the corona the place changes ramp. It is the one warm thing in
    // the composition, and 136 px of it is the whole warm budget.
    const glow = Math.exp(-Math.pow(d / 60, 1.4));
    return glow > 0.3
        ? { v: Math.min(1, glow * 0.96 + cool * 0.12), rgb: bd.rgbAlt }
        : { v: cool };
}

/* -------------------------------------------------------------------------- */
/* Belt decks                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The planes of a `bandForm: "belt"` world, on the shared `surface` painter.
 *
 * A belt world is a stack of full-width tiles that wrap vertically and each
 * translate at their own rate. The rate difference is the whole point: shear
 * between two decks is only visible as a rate difference, so a single plane --
 * which is all `bandForm: "bank"` has ever had -- cannot paint this place.
 *
 * Everything below is bake-time except `beltBlit`, which is `drawImage` only.
 * A tile is the size of the box at `layerScale`, the same buffer every soft
 * place already keeps; a belt world just keeps one per plane plus a mask and a
 * scratch to apply it in.
 */

// The study's literal seed. The band layout, the filaments and the vortex
// placements were tuned by eye against this stream, so it is kept rather than
// reseeded off the place id -- the same reason `mulberry32` is in this file at
// all.
/**
 * ICE WORLD's sky: a plain gamma ramp down the box with one ring standing in
 * it. Both are pure functions of position, which is what lets the whole place
 * bake and leaves fourteen flakes as its only live work.
 */
function iceSky(bd, x, y) {
    const t = clamp((y - bd.y0) / bd.h, 0, 1);
    let v = ICE_SKY[0] + ICE_SKY[1] * Math.pow(t, ICE_SKY[2]);
    const halo = bd.p.halo;
    if (halo > 0) {
        const d = Math.hypot(x - bd.cx, y - bd.cy);
        const e = (d - ICE_HALO_R) / ICE_HALO_W;
        v += halo * Math.exp(-e * e);
        if (d < ICE_HALO_R - ART_PIX * 2) {
            // The inside of a halo is darker than the sky around it, which is
            // the one thing that stops the ring reading as a lens flare.
            v -= ICE_HALO_HOLE;
        }
    }
    return v;
}

/* ---------------------------- COMET TRAIL --------------------------------- */

/**
 * Where the head is, how bright it is and which way both tails point. A pure
 * function of `bd.t`: there is no state to step, so a thumbnail can be taken
 * at any instant and a guest never has to be told anything.
 */
function cometGeom(bd) {
    const cross = Math.floor(bd.t / COMET_T);
    const local = bd.t - cross * COMET_T;
    // The crossing seeds itself, so the entry height and the knot cadence are
    // the same on every machine and replay from any scrub position.
    const rng = mulberry32((COMET_SEED ^ Math.imul(cross, 2654435761)) >>> 0);
    const y0 = bd.H * (COMET_Y0[0] + rng() * COMET_Y0[1]);
    const vx = (bd.W * COMET_SPAN) / COMET_T;
    const vy = vx * COMET_SLOPE;
    const hx = bd.W * COMET_X0 + vx * local;
    const hy = y0 + vy * local;
    const dx = hx - bd.cx;
    const dy = hy - bd.cy;
    const r = Math.hypot(dx, dy) || 1;
    const a = clamp(Math.pow(COMET_PERI / r, COMET_ACT[0]), COMET_ACT[1], 1);
    const vs = Math.hypot(vx, vy) || 1;
    return {
        cross, local, hx, hy, r, a,
        // Anti-solar. Recomputed every frame from the head and the star, with
        // no velocity term anywhere in it -- which is the entry's own promise
        // and the thing the painter it replaces never actually did.
        ux: dx / r, uy: dy / r,
        vhx: vx / vs, vhy: vy / vs,
        li: COMET_ION.len[0] + COMET_ION.len[1] * a,
        ld: COMET_DUST.len[0] + COMET_DUST.len[1] * a,
        rc: COMET_COMA.r[0] + COMET_COMA.r[1] * a,
        b: COMET_COMA.b[0] + COMET_COMA.b[1] * a,
    };
}

/** The star's glow as a scalar, so the whole of it bakes through `field`. */
function cometSky(bd, x, y) {
    const d = Math.hypot(x - bd.cx, y - bd.cy);
    let v = 0;
    for (const g of COMET_GLOW) {
        if (d < g[0]) {
            v += g[1] * (1 - d / g[0]);
        }
    }
    if (d < COMET_CORE[0]) {
        const u = d / COMET_CORE[0];
        v += u < COMET_CORE[2]
            ? COMET_CORE[1] + (COMET_CORE[3] - COMET_CORE[1]) * (u / COMET_CORE[2])
            : COMET_CORE[3] * (1 - (u - COMET_CORE[2]) / (1 - COMET_CORE[2]));
    }
    return v;
}

/** A gradient's value at `u`, from the stop list the study writes them as. */
function cometStop(stops, u) {
    for (let i = 1; i < stops.length; i++) {
        if (u <= stops[i][0]) {
            const a = stops[i - 1];
            const b = stops[i];
            return a[1] + (b[1] - a[1]) * ((u - a[0]) / (b[0] - a[0] || 1));
        }
    }
    return stops[stops.length - 1][1];
}

/**
 * One art pixel, snapped to a ramp through the same ordered dither the bake
 * uses.
 *
 * This is why the tails are rasterised here rather than drawn with canvas
 * fills and quantised afterwards, which is what the study does: a canvas fill
 * antialiases every diagonal edge into colours that are not on the ramp, and
 * un-antialiasing it again costs a `getImageData` per frame -- a GPU readback
 * in the middle of the frame, which no other place in this file needs. Writing
 * the pixels straight is both cheaper and exactly on the ramp by construction.
 */
function cometPixel(s, x, y, ramp, alpha) {
    const t = Math.min(1, alpha) * s.last;
    let k = Math.floor(t);
    if (t - k > BAYER[(y & 3) * 4 + (x & 3)] / 16) {
        k++;
    }
    if (k > s.cap) {
        k = s.cap;
    }
    if (k <= 0) {
        return;
    }
    const c = ramp[k];
    const i = (y * s.aw + x) * 4;
    s.data[i] = c[0];
    s.data[i + 1] = c[1];
    s.data[i + 2] = c[2];
    s.data[i + 3] = 255;
}

/** One convex quad, scanline-filled. Four corners, in order, in art pixels. */
function cometQuad(s, q, ramp, alpha) {
    if (alpha <= 0) {
        return;
    }
    let ymin = q[1];
    let ymax = q[1];
    for (let i = 3; i < 8; i += 2) {
        if (q[i] < ymin) { ymin = q[i]; }
        if (q[i] > ymax) { ymax = q[i]; }
    }
    const yA = Math.max(0, Math.ceil(ymin - 0.5));
    const yB = Math.min(s.ah - 1, Math.floor(ymax - 0.5));
    for (let y = yA; y <= yB; y++) {
        const yc = y + 0.5;
        let lo = Infinity;
        let hi = -Infinity;
        for (let e = 0; e < 4; e++) {
            const ax = q[e * 2];
            const ay = q[e * 2 + 1];
            const bx = q[((e + 1) & 3) * 2];
            const by = q[((e + 1) & 3) * 2 + 1];
            if ((ay <= yc) === (by <= yc)) {
                continue;
            }
            const x = ax + ((yc - ay) / (by - ay)) * (bx - ax);
            if (x < lo) { lo = x; }
            if (x > hi) { hi = x; }
        }
        if (hi < lo) {
            continue;
        }
        const xA = Math.max(0, Math.ceil(lo - 0.5));
        const xB = Math.min(s.aw - 1, Math.floor(hi - 0.5));
        for (let x = xA; x <= xB; x++) {
            cometPixel(s, x, y, ramp, alpha);
        }
        if (xA < s.x0) { s.x0 = xA; }
        if (xB > s.x1) { s.x1 = xB; }
        if (y < s.y0) { s.y0 = y; }
        if (y > s.y1) { s.y1 = y; }
    }
}

/** A radial falloff, as concentric rungs. The coma and every knot. */
function cometDisc(s, cx, cy, r, ramp, stops, scale) {
    const yA = Math.max(0, Math.ceil(cy - r - 0.5));
    const yB = Math.min(s.ah - 1, Math.floor(cy + r - 0.5));
    for (let y = yA; y <= yB; y++) {
        const dy = y + 0.5 - cy;
        const w = Math.sqrt(Math.max(0, r * r - dy * dy));
        const xA = Math.max(0, Math.ceil(cx - w - 0.5));
        const xB = Math.min(s.aw - 1, Math.floor(cx + w - 0.5));
        for (let x = xA; x <= xB; x++) {
            const dx = x + 0.5 - cx;
            cometPixel(s, x, y, ramp,
                cometStop(stops, Math.sqrt(dx * dx + dy * dy) / r) * scale);
        }
        if (xA < s.x0) { s.x0 = xA; }
        if (xB > s.x1) { s.x1 = xB; }
        if (y < s.y0) { s.y0 = y; }
        if (y > s.y1) { s.y1 = y; }
    }
}

/**
 * A tail, as a strip of quads: one per node segment, each at the rung its own
 * stretch of the gradient asks for. Runs of equal alpha are not merged --
 * the dither wants the fractional part, so two neighbouring segments at 0.41
 * and 0.44 are not the same band even though they round the same way.
 *
 * `off` shears the ribbon across itself, which is what stops four nested
 * striae from reading as concentric rings.
 */
function cometRibbon(s, pts, wOf, off, ramp, aOf) {
    const n = (pts.length >> 1) - 1;
    const l = new Float64Array((n + 1) * 2);
    const r = new Float64Array((n + 1) * 2);
    for (let i = 0; i <= n; i++) {
        const u = i / n;
        const p = i * 2;
        const q = Math.min(i + 1, n) * 2;
        const o = Math.max(i - 1, 0) * 2;
        let tx = pts[q] - pts[o];
        let ty = pts[q + 1] - pts[o + 1];
        const m = Math.hypot(tx, ty) || 1;
        tx /= m;
        ty /= m;
        const w = wOf(u);
        const c = off * u;
        l[p] = pts[p] - ty * (w - c);
        l[p + 1] = pts[p + 1] + tx * (w - c);
        r[p] = pts[p] + ty * (w + c);
        r[p + 1] = pts[p + 1] - tx * (w + c);
    }
    for (let i = 0; i < n; i++) {
        const p = i * 2;
        const q = p + 2;
        cometQuad(s, [l[p], l[p + 1], l[q], l[q + 1], r[q], r[q + 1], r[p], r[p + 1]],
            ramp, aOf((i + 0.5) / n));
    }
}

/* -------------------------------------------------------------------------- */
/* RINGED GIANT                                                                */
/* -------------------------------------------------------------------------- */

/** How much of the light a ring point stops, from the band table. 0 in a gap. */
function giantRingOp(rho) {
    for (let i = 0; i < GIANT_BANDS.length; i++) {
        const b = GIANT_BANDS[i];
        if (rho >= b.a && rho < b.b) {
            let e = 1;
            if (b.fin) {
                e = smoothstep(rho, b.a, b.a + b.fin);
            }
            if (b.fout) {
                e *= 1 - smoothstep(rho, b.b - b.fout, b.b) * b.fk;
            }
            return b.op * e;
        }
    }
    return 0;
}

/** How bright it is once it has stopped that much of it. */
function giantRingVal(rho, op) {
    const k = GIANT_RING_V;
    return clamp(k[0] + k[1] * op + k[2] * Math.sin(rho * k[3]), 0, 1);
}

/**
 * The planet's shadow on the rings, computed rather than drawn. The ring plane
 * IS the body's equatorial plane, so the shadow is a cylinder: a ring point is
 * in umbra when it is downstream of the light and its distance from the light
 * axis is under one body radius. One test, no artwork, and it is the reason the
 * rings read as a plane instead of as a pair of arcs.
 *
 * `u`/`w` are the point's plane coordinates in logical px, unsquashed.
 */
function giantRingShadow(bd, u, w) {
    const L = GIANT_LIGHT;
    const px = u * GIANT_E1[0] + w * GIANT_E2[0];
    const py = u * GIANT_E1[1] + w * GIANT_E2[1];
    const pz = u * GIANT_E1[2] + w * GIANT_E2[2];
    const pr = px * L[0] + py * L[1] + pz * L[2];
    if (pr >= 0) {
        return 1;
    }
    const qx = px - pr * L[0];
    const qy = py - pr * L[1];
    const qz = pz - pr * L[2];
    const inside = 1 - smoothstep(Math.hypot(qx, qy, qz), bd.R * GIANT_PENUMBRA[0], bd.R);
    const entry = smoothstep(-pr, 0, bd.R * GIANT_PENUMBRA[1]);
    return 1 - GIANT_UMBRA * inside * entry;
}

/**
 * ...and the rings' shadow on the body, the same solve the other way round:
 * the light ray leaving a surface point is crossed with the ring plane and the
 * crossing radius looked up in the same band table. It puts a thin dark line
 * with a Cassini gap in it across the northern third, which no amount of
 * hand-placed ellipses gets right.
 */
function giantRingShadowOnBody(bd, nx, ny, nz) {
    const A = GIANT_AXIS;
    const L = GIANT_LIGHT;
    const la = L[0] * A[0] + L[1] * A[1] + L[2] * A[2];
    if (Math.abs(la) < 1e-4) {
        return 1;
    }
    const t = (-bd.R * (nx * A[0] + ny * A[1] + nz * A[2])) / la;
    if (t <= 0) {
        return 1;
    }
    const qx = bd.R * nx + t * L[0];
    const qy = bd.R * ny + t * L[1];
    const qz = bd.R * nz + t * L[2];
    return 1 - GIANT_RING_SHADOW * giantRingOp(Math.hypot(qx, qy, qz) / bd.R);
}

// One object rather than a fresh one per art pixel: the bake asks 184k times
// and `field` already allocates its own return.
const GIANT_BELT_OUT = { v: 0, land: false };

/**
 * The weather, as a function of latitude on the sphere. The three cloud decks
 * of the inside-the-deck place are these same three belt classes seen from
 * without: broad zones, belt edges, and the filament detail the mid-latitude
 * group carries.
 */
function giantBelt(bd, lat, lon) {
    let v = GIANT_BELT_BASE;
    let fil = 0;
    for (let i = 0; i < bd.belts.length; i++) {
        const b = bd.belts[i];
        const d = (lat - b.c) / b.w;
        const g = Math.exp(-d * d * GIANT_BELT_FALL);
        v += b.a * g;
        if (b.fil && g > GIANT_FIL_GATE) {
            fil += (bd.fil(lon * GIANT_FIL_N[0], lat * GIANT_FIL_N[1], 1) - 0.5) * GIANT_FIL_AMP * g;
        }
    }
    GIANT_BELT_OUT.v = clamp(v + fil, 0, 1);
    GIANT_BELT_OUT.land = Math.abs(fil) > GIANT_FIL_CUT;
    return GIANT_BELT_OUT;
}

/**
 * RINGED GIANT as a scalar. One pass covers the whole place: the ring bands and
 * the shadow wedge across them, the body, its belts and filaments, the rings'
 * shadow on it and the atmosphere rim. Which of the body and the rings wins at
 * a given art pixel is the sign of one plane coordinate -- the near half of the
 * plane composites over the disc, the far half is simply behind it -- which is
 * the whole reason this place is quantised rather than drawn twice with alpha.
 */
function giantField(bd, x, y) {
    const dx = x - bd.cx;
    const dy = y - bd.cy;
    const u = dx * GIANT_COS + dy * GIANT_SIN;
    const w = (-dx * GIANT_SIN + dy * GIANT_COS) / GIANT_SQUASH;
    const rho = Math.hypot(u, w) / bd.R;
    const op = rho > GIANT_R0 && rho < GIANT_R1 ? giantRingOp(rho) : 0;
    const rv = op > 0 ? giantRingVal(rho, op) * giantRingShadow(bd, u, w) : 0;
    const dd = Math.hypot(dx, dy) / bd.R;
    if (dd > 1) {
        return op > 0 ? { v: rv } : FIELD_DARK;
    }
    const nx = dx / bd.R;
    const ny = dy / bd.R;
    const nz = Math.sqrt(Math.max(0, 1 - dd * dd));
    const L = GIANT_LIGHT;
    const lam = nx * L[0] + ny * L[1] + nz * L[2];
    const lit = smoothstep(lam, GIANT_TERM[0], GIANT_TERM[1]);
    const limb = 1 - GIANT_LIMB * (1 - nz);
    const A = GIANT_AXIS;
    const lat = nx * A[0] + ny * A[1] + nz * A[2];
    const t1 = nx * GIANT_E1[0] + ny * GIANT_E1[1] + nz * GIANT_E1[2];
    const t2 = nx * GIANT_E2[0] + ny * GIANT_E2[1] + nz * GIANT_E2[2];
    const belt = giantBelt(bd, lat, Math.atan2(t2, t1));
    let v = (GIANT_BODY_V[0] + GIANT_BODY_V[1] * belt.v) * lit * limb + GIANT_BODY_V[2];
    v *= giantRingShadowOnBody(bd, nx, ny, nz);
    const rim = smoothstep(dd, GIANT_RIM[0], GIANT_RIM[1])
        * clamp((lam + 0.02) * GIANT_RIM[2], 0, 1);
    v = Math.min(1, v + rim * GIANT_RIM[3]);
    // The near half of the plane passes over the body. Anything under a ring is
    // on the ring's own ramp, so the filament ramp stops there.
    if (w > 0 && op > 0) {
        return { v: v * (1 - op) + rv * Math.min(1, op * 1.6) };
    }
    return belt.land && rim <= 0.2 ? { v, rgb: bd.rgbAlt } : { v };
}

/**
 * One clump of the turning ring, straight into the art-pixel buffer.
 *
 * The study strokes an arc and then quantises the readback of the whole buffer
 * with a `getImageData`/`putImageData` pair -- 40,860 pixels a frame behind a
 * bullet pattern -- and its own port notes say not to ship that. The sector is
 * exact in plane coordinates, so testing each art pixel of its bounding box is
 * the same silhouette with nothing to undo: hard-edged by construction, on the
 * bake's own lattice, and never dithered, which is what makes the crawl the
 * study worries about impossible rather than merely unlikely.
 */
function giantArc(bd, r0, r1, a0, a1, front, col) {
    const s = bd.clump;
    // The sector spans 3.75 degrees, so its bulge is under half an art pixel:
    // the four corners plus a pad are the bounding box.
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (let i = 0; i < 4; i++) {
        const r = i < 2 ? r0 : r1;
        const a = i & 1 ? a1 : a0;
        const pu = Math.cos(a) * r;
        const pw = Math.sin(a) * r * GIANT_SQUASH;
        const sx = bd.cx + pu * GIANT_COS - pw * GIANT_SIN;
        const sy = bd.cy + pu * GIANT_SIN + pw * GIANT_COS;
        bx0 = Math.min(bx0, sx);
        bx1 = Math.max(bx1, sx);
        by0 = Math.min(by0, sy);
        by1 = Math.max(by1, sy);
    }
    const pad = ART_PIX * 2;
    const i0 = clamp(Math.floor((bx0 - pad - bd.x0) / ART_PIX), 0, s.aw - 1);
    const i1 = clamp(Math.ceil((bx1 + pad - bd.x0) / ART_PIX), 0, s.aw - 1);
    const j0 = clamp(Math.floor((by0 - pad - bd.y0) / ART_PIX), 0, s.ah - 1);
    const j1 = clamp(Math.ceil((by1 + pad - bd.y0) / ART_PIX), 0, s.ah - 1);
    const rr = bd.R * bd.R;
    for (let py = j0; py <= j1; py++) {
        const dy = bd.y0 + (py + 0.5) * ART_PIX - bd.cy;
        for (let px = i0; px <= i1; px++) {
            const dx = bd.x0 + (px + 0.5) * ART_PIX - bd.cx;
            // The far half goes behind the body; the near half over it.
            if (!front && dx * dx + dy * dy <= rr) {
                continue;
            }
            const u = dx * GIANT_COS + dy * GIANT_SIN;
            const w = (-dx * GIANT_SIN + dy * GIANT_COS) / GIANT_SQUASH;
            const r = Math.hypot(u, w);
            if (r < r0 || r > r1) {
                continue;
            }
            let a = Math.atan2(w, u);
            if (a < 0) {
                a += 6.2832;
            }
            if (a < a0 || a > a1) {
                continue;
            }
            const o = (py * s.aw + px) * 4;
            s.data[o] = col[0];
            s.data[o + 1] = col[1];
            s.data[o + 2] = col[2];
            s.data[o + 3] = 255;
        }
    }
}

/**
 * Repaint the whole live layer for one cell of the roll.
 *
 * It is a pure function of that cell, and the table rolls one cell every 86.7
 * frames, so the layer has 96 states and the other 86 frames out of 87 are a
 * single blit. That is what makes the turn -- the one thing the entry promises
 * that no bake can deliver -- cost about one rasterising call a frame.
 */
function giantRoll(bd, cell) {
    const s = bd.clump;
    s.data.fill(0);
    const step = 6.2832 / GIANT_CELLS;
    const last = bd.rgb.length - 1;
    for (let bi = 0; bi < GIANT_CLUMP_BANDS.length; bi++) {
        const b = GIANT_BANDS[GIANT_CLUMP_BANDS[bi]];
        const tab = bd.clumpTab[bi];
        const half = (b.b - b.a) * bd.R * GIANT_CLUMP_W * 0.5;
        for (let k = 0; k < GIANT_CELLS; k++) {
            const dens = tab[(k + cell) % GIANT_CELLS];
            if (dens < GIANT_CLUMP_CUT) {
                continue;
            }
            const a0 = k * step;
            const mid = a0 + step * 0.5;
            const seat = GIANT_CLUMP_R[0] + GIANT_CLUMP_R[1] * ((k * 7 + bi * 13) % 3);
            const rho = b.a + (b.b - b.a) * seat;
            const r = rho * bd.R;
            // The rung the bake put under this clump, shadow included, so the
            // promotion is measured against the plate it lands on: a clump in
            // the umbra comes out nearly black on its own, for free.
            const sh = giantRingShadow(bd, Math.cos(mid) * r, Math.sin(mid) * r);
            const plate = clamp(Math.round(giantRingVal(rho, giantRingOp(rho)) * sh * last), 0, last);
            const rung = Math.min(plate + GIANT_CLUMP_STEP[dens > GIANT_CLUMP_HOT ? 1 : 0],
                GIANT_CLUMP_TOP);
            giantArc(bd, r - half, r + half, a0, a0 + step * GIANT_CLUMP_ARC,
                Math.sin(mid) > 0, bd.rgb[rung]);
        }
    }
    s.g.putImageData(s.img, 0, 0);
}

const BELT_SEED = 20260829;
// Band edges are polylines sampled this often across the box. At 24 logical px
// the wave (2-14 px amplitude, 0.0035-0.0115 rad per px) is smooth and a deck
// bakes in ~120 segments an edge.
const BELT_STEP = 24;
// The vortex is baked square and stretched at draw time, so one sprite serves
// both of them at two sizes. `VORTEX_CULL` is how far off the box its centre
// may sit before the blit is skipped.
const VORTEX_SIZE = 220;
const VORTEX_RINGS = 34;
const VORTEX_CULL = 260;
// Where a bank world puts its cloud centres, as a fraction of the box: today
// every one of the six is hard-coded to 30-60% of it. The study calls that a
// bug rather than a style and wants [0, 1] everywhere; the six were composed
// against it, so it stays the default and the axis is here for when they are
// re-tuned one at a time.
const BAND_SPREAD = [0.3, 0.6];
// The screen-space density ramp is applied as strips of constant alpha rather
// than through a scratch and a `destination-in`. The strips write one box area
// between them where the mask wrote three, and at 48 logical px a step is a
// third of an RGB level on a plane this faint. Checked against the mask rather
// than assumed: over the whole 1428x1162 box the two agree to a maximum
// channel difference of 2, and 1044 pixels of 1.66 M differ by more than 1.
const DENSITY_STRIP = 48;

/** An offscreen the size of `w` x `h` logical px, drawn in logical px. */
function beltCanvas(w, h, k) {
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(w * k));
    cv.height = Math.max(1, Math.round(h * k));
    const g = cv.getContext("2d");
    g.setTransform(k, 0, 0, k, 0, 0);
    return g;
}

/**
 * One deck's bands, boundary filaments and streaks, in tile coordinates. State
 * only: this is the `init` half of the study and it touches no pixels.
 */
function beltDeck(rng, d, w, tileH) {
    const list = [];
    let y = 0;
    let i = 0;
    while (y < tileH) {
        // Thickness is biased low: a deck is mostly thin bands with a few fat
        // ones, which is what a banded planet actually looks like.
        const h = d.h[0] + (d.h[1] - d.h[0]) * Math.pow(rng(), 1.5);
        list.push({
            y,
            h,
            // Belts (dark) and zones (light) alternate down the tile.
            belt: i % 2 === 0,
            a1: d.wave[0] + (d.wave[1] - d.wave[0]) * rng(),
            a2: d.wave[0] + (d.wave[1] - d.wave[0]) * rng(),
            f1: 0.0035 + 0.008 * rng(),
            f2: 0.0035 + 0.008 * rng(),
            p1: rng() * 6.2832,
            p2: rng() * 6.2832,
            al: d.alpha[0] + (d.alpha[1] - d.alpha[0]) * rng(),
        });
        y += h + d.gap[0] + (d.gap[1] - d.gap[0]) * rng();
        i++;
    }
    // Filaments sit on a band edge: the tearing where two rates meet.
    const fil = [];
    for (let k = 0; k < (d.fil || 0); k++) {
        const b = list[Math.floor(rng() * list.length)];
        fil.push({
            x: rng() * w,
            y: b.y + b.h * (rng() < 0.5 ? 0 : 1),
            w: 60 + rng() * 240,
            h: 2 + rng() * 5,
            a: 0.04 + rng() * 0.08,
        });
    }
    // Streaks are full-width lines riding a boundary, and after the vortices
    // they are the most planet-like thing in the place.
    const streak = [];
    for (let k = 0; k < (d.streaks || 0); k++) {
        const b = list[Math.floor(rng() * list.length)];
        streak.push({
            y: rng() < 0.5 ? b.y - 2 : b.y + b.h + 2,
            h: 4 + rng() * 5,
            f: 0.0022 + 0.004 * rng(),
            p: rng() * 6.2832,
            a: 6 + rng() * 10,
        });
    }
    return { list, fil, streak };
}

/**
 * Bake one deck as a tile that wraps vertically. Every element is drawn three
 * times -- one tile height up, in place, and one down -- so a band crossing
 * the seam comes out whole on both sides of it and the wrap is invisible.
 */
function beltTile(bd, d, deck, k, tileH) {
    const g = beltCanvas(bd.w, tileH, k);
    const wraps = [-tileH, 0, tileH];
    const dark = d.dark || bd.p.beltColor;
    const light = d.light || bd.p.band;
    const edge = (y, b) => {
        g.beginPath();
        g.moveTo(0, y + b.a1 * Math.sin(b.p1));
        for (let x = 0; x <= bd.w; x += BELT_STEP) {
            g.lineTo(x, y + b.a1 * Math.sin(x * b.f1 + b.p1));
        }
        for (let x = bd.w; x >= 0; x -= BELT_STEP) {
            g.lineTo(x, y + b.h + b.a2 * Math.sin(x * b.f2 + b.p2));
        }
        g.closePath();
    };
    for (const b of deck.list) {
        for (const wy of wraps) {
            const y = b.y + wy;
            if (y + b.h < -40 || y > tileH + 40) {
                continue;
            }
            edge(y, b);
            // Soft: a band fades in and out across its own height. This is the
            // whole difference between the two versions of the study -- the
            // pixel one fills the same shape flat at one rung of a ramp.
            const grd = g.createLinearGradient(0, y, 0, y + b.h);
            grd.addColorStop(0, "rgba(0,0,0,0)");
            grd.addColorStop(0.5, b.belt ? dark : light);
            grd.addColorStop(1, "rgba(0,0,0,0)");
            g.globalAlpha = b.al;
            g.fillStyle = grd;
            g.fill();
        }
    }
    for (const st of deck.streak) {
        for (const wy of wraps) {
            const y = st.y + wy;
            if (y < -40 || y > tileH + 40) {
                continue;
            }
            g.beginPath();
            g.moveTo(0, y + st.a * Math.sin(st.p));
            for (let x = 0; x <= bd.w; x += BELT_STEP) {
                g.lineTo(x, y + st.a * Math.sin(x * st.f + st.p));
            }
            for (let x = bd.w; x >= 0; x -= BELT_STEP) {
                g.lineTo(x, y + st.h + st.a * Math.sin(x * st.f + st.p));
            }
            g.closePath();
            g.globalAlpha = 0.42;
            g.fillStyle = bd.p.streak;
            g.fill();
        }
    }
    for (const f of deck.fil) {
        for (const wy of wraps) {
            const y = f.y + wy;
            if (y < -40 || y > tileH + 40) {
                continue;
            }
            // Three nested ellipses: wide and thin at the core, shorter and
            // taller outside it, which reads as a filament rather than a blob.
            for (let n = 0; n < 3; n++) {
                g.globalAlpha = f.a * (1 - n * 0.3);
                g.fillStyle = bd.p.filament;
                g.beginPath();
                g.ellipse(f.x, y, f.w * (1 - n * 0.22), f.h * (1 + n * 0.9), 0, 0, 6.2832);
                g.fill();
            }
        }
    }
    g.globalAlpha = 1;
    return g.canvas;
}

/**
 * The motes of a belt world, baked into a plane of their own instead of
 * simulated. They are far away, so they move at a plane's rate rather than at
 * their own, and they sit deliberately between two band decks: nothing at that
 * size and alpha can be mistaken for a bullet.
 */
function flakeTile(bd, f, list, k, tileH) {
    const g = beltCanvas(bd.w, tileH, k);
    for (const p of list) {
        for (const wy of [-tileH, 0, tileH]) {
            g.globalAlpha = p.a;
            g.fillStyle = f.color;
            g.beginPath();
            g.ellipse(p.x, p.y + wy, p.s, p.s * 0.72, 0, 0, 6.2832);
            g.fill();
        }
    }
    g.globalAlpha = 1;
    return g.canvas;
}

/**
 * The vortex, baked circular and squashed at draw time. It is the one feature
 * that says gas giant rather than warm sky: bands on their own read as haze.
 */
function vortexSprite(bd, k) {
    const v = bd.p.vortices;
    const g = beltCanvas(VORTEX_SIZE, VORTEX_SIZE, k);
    const R = VORTEX_SIZE / 2;
    const rng = mulberry32(7717);
    for (let i = 0; i < VORTEX_RINGS; i++) {
        const t = i / VORTEX_RINGS;
        const rad = R * (1 - t * 0.94);
        g.globalAlpha = (i % 2 ? 0.085 : 0.075) * (1 - t * 0.25);
        g.fillStyle = i % 2 ? v.hi : v.lo;
        g.beginPath();
        // Each ring is offset and turned a little further than the last, which
        // is what gives a stack of ellipses a curl.
        g.ellipse(
            R + Math.sin(t * 9.4) * rad * 0.34,
            R + Math.cos(t * 8.1) * rad * 0.16,
            rad, rad * (0.8 + 0.16 * rng()), t * 2.6, 0, 6.2832
        );
        g.fill();
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "destination-in";
    const vm = g.createRadialGradient(R, R, R * 0.05, R, R, R);
    vm.addColorStop(0, "rgba(0,0,0,1)");
    vm.addColorStop(0.62, "rgba(0,0,0,0.85)");
    vm.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = vm;
    g.fillRect(0, 0, VORTEX_SIZE, VORTEX_SIZE);
    return g.canvas;
}

/** Where a plane has scrolled to, in 0..tileH. */
function beltWrap(v, tileH) {
    const s = v % tileH;
    return s < 0 ? s + tileH : s;
}

/**
 * Blit one wrapping plane. Two source sub-rects rather than two whole tiles, so
 * a plane costs exactly one box area a frame and not two. `dens` is the
 * screen-space alpha ramp [top, bottom] the nearest plane wants, or nothing.
 */
function beltBlit(g, bd, tile, s, k, dens, base) {
    const sw = bd.w * k;
    const rest = bd.h - s;
    if (s > 0.5) {
        beltRun(g, bd, tile, sw, rest, 0, s, k, dens, base);
    }
    if (rest > 0.5) {
        beltRun(g, bd, tile, sw, 0, s, rest, k, dens, base);
    }
    if (dens) {
        g.globalAlpha = base;
    }
}

/**
 * One contiguous run of the tile. With a density ramp it is cut into strips of
 * constant alpha; the cuts land on whole tile pixels, so every strip is scaled
 * exactly as the whole run would be and no seam can open between two of them.
 */
function beltRun(g, bd, tile, sw, sy, dy, hh, k, dens, base) {
    if (!dens) {
        g.drawImage(tile, 0, sy * k, sw, hh * k, bd.x0, bd.y0 + dy, bd.w, hh);
        return;
    }
    const q = 1 / k;
    const n = Math.max(1, Math.round(hh / DENSITY_STRIP));
    let a = 0;
    for (let i = 0; i < n; i++) {
        const b = i === n - 1 ? hh : Math.round(((hh * (i + 1)) / n) / q) * q;
        if (b <= a) {
            continue;
        }
        g.globalAlpha = base * (dens[0] + (dens[1] - dens[0]) * ((dy + (a + b) / 2) / bd.h));
        g.drawImage(tile, 0, (sy + a) * k, sw, (b - a) * k, bd.x0, bd.y0 + dy + a, bd.w, b - a);
        a = b;
    }
}

/** `init` for a belt world: every list the bake will need, and no pixels. */
function beltInit(bd) {
    const rng = mulberry32(BELT_SEED);
    bd.decks = bd.p.decks.map((d) => beltDeck(rng, d, bd.w, bd.h));
    bd.flakeList = [];
    const f = bd.p.flakes;
    if (f) {
        for (let i = 0; i < f.n; i++) {
            bd.flakeList.push({
                x: rng() * bd.w,
                y: rng() * bd.h,
                s: f.size[0] + rng() * (f.size[1] - f.size[0]),
                a: f.alpha[0] + rng() * (f.alpha[1] - f.alpha[0]),
            });
        }
    }
}

/** `paint` for a belt world: every layer, baked once. */
function beltPaint(bd) {
    const k = bd.layerScale;
    bd.planes = bd.p.decks.map((d, i) => ({
        rate: d.rate,
        tile: beltTile(bd, d, bd.decks[i], k, bd.h),
        density: d.density,
    }));
    const f = bd.p.flakes;
    if (f) {
        bd.planes.splice(f.plane, 0, {
            rate: f.rate,
            tile: flakeTile(bd, f, bd.flakeList, k, bd.h),
        });
    }
    bd.vortex = bd.p.vortices ? vortexSprite(bd, k) : null;
}

/** `live` for a belt world: blits only. */
function beltLive(bd, g) {
    const k = bd.layerScale;
    const flow = bd.p.flow || 1;
    const vx = bd.p.vortices;
    g.save();
    g.imageSmoothingEnabled = true;
    const base = g.globalAlpha;
    for (let i = 0; i < bd.planes.length; i++) {
        const pl = bd.planes[i];
        const off = beltWrap(pl.rate * flow * bd.t, bd.h);
        beltBlit(g, bd, pl.tile, off, k, pl.density, base);
        if (vx && vx.plane === i) {
            // The vortices ride this plane, so they take its offset rather
            // than a clock of their own and cannot drift off the deck.
            const ang = bd.t * vx.spin;
            for (const v of vx.list) {
                const y = beltWrap(v.y * bd.h + off, bd.h);
                for (const wy of [y - bd.h, y]) {
                    if (wy < -VORTEX_CULL || wy > bd.h + VORTEX_CULL) {
                        continue;
                    }
                    g.save();
                    g.translate(bd.x0 + v.x * bd.w, bd.y0 + wy);
                    g.scale(2.25 * v.s, 0.88 * v.s);
                    g.rotate(ang * v.dir);
                    g.drawImage(bd.vortex, -VORTEX_SIZE / 2, -VORTEX_SIZE / 2, VORTEX_SIZE, VORTEX_SIZE);
                    g.restore();
                }
            }
        }
    }
    g.restore();
}

/**
 * MOLTEN WORLD's ridged noise, 0..1. Three octaves of `1 - |2n - 1|`: the fold
 * is what turns a hill into a skyline, and the power sharpens the peaks
 * without moving the valleys. The three octaves read three different lines of
 * the same field, and `ph` offsets a whole range onto its own stretch of it.
 */
function lavaRidgeN(n, x, f, ph) {
    const rd = (v) => 1 - Math.abs(2 * v - 1);
    const v = rd(n(x * f + ph, 12.3, 1)) * 0.62
        + rd(n(x * f * 2.6 + ph, 29.7, 1)) * 0.27
        + rd(n(x * f * 6.3 + ph, 51.1, 1)) * 0.11;
    return Math.pow(clamp(v, 0, 1), 1.35);
}

/** How far into the valley mouth a column of the box is, 0..1. */
function lavaValley(bd, x) {
    const u = (x - (bd.x0 + bd.w * 0.5)) / (bd.w * LAVA_VALLEY_W);
    return Math.exp(-u * u);
}

/** How far down the plain a logical y is: 0 at the horizon, 1 at the floor. */
function lavaDep(bd, y) {
    return clamp((y - bd.hy) / (bd.y0 + bd.h - bd.hy), 0, 1);
}

/**
 * The two smoke plumes, as a density 0..1. They lean as they rise and widen
 * with height, and a pixel of sky over `LAVA_PLUME_CUT` becomes smoke.
 */
function lavaPlume(bd, x, y) {
    const by = bd.hy - LAVA_PLUME_TOP;
    if (y > by) {
        return 0;
    }
    let p = 0;
    for (const q of LAVA_PLUMES) {
        const t = (by - y) / q[2];
        if (t > 1) {
            continue;
        }
        const sway = Math.sin(t * 3) * q[1] * 0.9
            + (bd.cloud(x * 0.009, y * 0.005, 1) - 0.5) * 46;
        const dd = (x - (bd.x0 + bd.w * q[0]) - sway) / (q[1] * (0.45 + 1.9 * t));
        const n = bd.cloud(x * 0.013 + 31, y * 0.011 + 17, 1);
        const v = (1 - t * t) * Math.exp(-dd * dd) * (0.55 + 0.85 * n);
        if (v > p) {
            p = v;
        }
    }
    return p;
}

/**
 * How far an art row of the plane slides sideways this frame, in logical
 * pixels and always a whole art pixel. This is the place: superheated air is
 * the one thing in the catalogue that makes distance dissolve instead of
 * sharpen, and it is drawn by sliding whole art pixels rather than by blurring
 * anything. `Math.round` is load-bearing twice over -- sliding a plane by 4.7
 * px reads as a compression artefact rather than as heat, and quantised offsets
 * are what let `blit` send a run of rows in one call.
 */
function lavaShim(bd, ay) {
    const y = bd.y0 + (ay + 0.5) * ART_PIX;
    const g = clamp((y - (bd.hy - LAVA_SHIM_TOP)) / LAVA_SHIM_SPAN, 0, 1);
    if (g <= 0) {
        return 0;
    }
    const b = LAVA_SHIM_BEAT;
    return ART_PIX * Math.round(LAVA_SHIM_AMP * g * Math.sin(
        y * LAVA_SHIM_K + bd.t * LAVA_SHIM_RATE + b[0] * Math.sin(y * b[1] - bd.t * b[2])
    ));
}

/**
 * The silhouettes, decided once per art column rather than drawn: the front
 * edge of the plain, and the crest of each of the three ranges behind it.
 */
function lavaColumns(bd) {
    bd.plain = new Float32Array(bd.aw);
    bd.crest = LAVA_RANGES.map(() => new Float32Array(bd.aw));
    for (let i = 0; i < bd.aw; i++) {
        const x = bd.x0 + (i + 0.5) * ART_PIX;
        const v = lavaValley(bd, x);
        bd.plain[i] = bd.hy + LAVA_PLAIN[0] + (1 - v) * LAVA_PLAIN[1]
            + (bd.relief(x * 0.004, 5.5, 1) - 0.5) * LAVA_PLAIN[2];
        for (let k = 0; k < LAVA_RANGES.length; k++) {
            const d = LAVA_RANGES[k];
            bd.crest[k][i] = bd.hy + d.base
                - d.amp * (1 - v * d.valley) * lavaRidgeN(bd.relief, x, d.f, d.ph);
        }
    }
}

/**
 * The flow, as one x per art row. It is a graph over y -- it only ever runs
 * downhill -- so a centre line and a distance is the whole of it, and there is
 * no second offscreen buffer to keep.
 */
function lavaFlow(bd) {
    bd.flowTop = (bd.hy - bd.y0) / ART_PIX + LAVA_FLOW_TOP;
    bd.flowX = new Float32Array(bd.ah);
    const span = Math.max(1, bd.ah - bd.flowTop);
    for (let ay = 0; ay < bd.ah; ay++) {
        const t = clamp((ay - bd.flowTop) / span, 0, 1);
        const amp = LAVA_FLOW_AMP[0] + LAVA_FLOW_AMP[1] * t;
        bd.flowX[ay] = bd.aw * 0.5 + amp * Math.sin(t * 2.3 + 0.6)
            + amp * 0.3 * Math.sin(t * 6.1 + 2.2);
    }
}

/**
 * The crack network, stamped into a byte per art pixel. Fifteen walks whose
 * heading is noise-perturbed and clamped nearly flat, so the network lies
 * along the plain instead of climbing out of it, with every other one forking
 * once: a network reads as a network, a set of strokes reads as scratches.
 */
function lavaCracks(bd) {
    const aw = bd.aw;
    const ah = bd.ah;
    const buf = new Uint8Array(aw * ah);
    const rng = mulberry32(LAVA_CRACK_SEED);
    const top = (bd.hy - bd.y0) / ART_PIX;
    const grow = (x, y, a, len, step) => {
        const pts = [[x, y]];
        for (let s = 0; s < len; s++) {
            a += (bd.crust(x * 0.05, y * 0.05, 1) - 0.5) * 0.44;
            a = Math.atan2(clamp(Math.sin(a), -0.44, 0.44), Math.cos(a));
            x += Math.cos(a) * step;
            y += Math.sin(a) * step * 0.32;
            if (y < top - 1 || y > ah + 6 || x < -60 || x > aw + 60) {
                break;
            }
            pts.push([x, y]);
        }
        return pts;
    };
    const paths = [];
    for (let i = 0; i < LAVA_CRACKS; i++) {
        const p = grow(
            rng() * aw,
            top + 16 + Math.pow(rng(), 1.15) * (ah - top - 16),
            (rng() - 0.5) * 0.6 + (rng() < 0.5 ? 0 : Math.PI),
            46 + Math.floor(rng() * 70), 2.4
        );
        if (p.length > 22) {
            paths.push(p);
        }
    }
    for (const p of paths.slice()) {
        if (rng() > 0.55) {
            continue;
        }
        const i = 3 + Math.floor(rng() * (p.length - 5));
        const q = grow(
            p[i][0], p[i][1],
            (rng() - 0.5) * 1.6 + (rng() < 0.5 ? 0 : Math.PI),
            22 + Math.floor(rng() * 24), 2
        );
        if (q.length > 18) {
            paths.push(q);
        }
    }
    let reach = 1;
    for (const q of LAVA_CRACK_PASS) {
        reach = Math.max(reach, q[0] + q[1] + 1);
    }
    for (const p of paths) {
        for (let i = 1; i < p.length; i++) {
            const ax = p[i - 1][0];
            const ay = p[i - 1][1];
            const dx = p[i][0] - ax;
            const dy = p[i][1] - ay;
            const len2 = dx * dx + dy * dy || 1;
            const dep = clamp((p[i][1] - top) / (ah - top), 0, 1);
            const x0 = Math.max(0, Math.floor(Math.min(ax, p[i][0]) - reach));
            const x1 = Math.min(aw - 1, Math.ceil(Math.max(ax, p[i][0]) + reach));
            const y0 = Math.max(0, Math.floor(Math.min(ay, p[i][1]) - reach));
            const y1 = Math.min(ah - 1, Math.ceil(Math.max(ay, p[i][1]) + reach));
            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    const t = clamp(((x - ax) * dx + (y - ay) * dy) / len2, 0, 1);
                    const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
                    let v = 0;
                    for (const q of LAVA_CRACK_PASS) {
                        v += q[2] * clamp(q[0] + q[1] * dep + 0.5 - d, 0, 1);
                    }
                    if (v <= 0) {
                        continue;
                    }
                    const o = y * aw + x;
                    buf[o] = Math.min(255, buf[o] + Math.round(v * 255));
                }
            }
        }
    }
    bd.crack = buf;
}

/* -------------------------------------------------------------------------- */
/* Painters                                                                    */
/* -------------------------------------------------------------------------- */

const PAINTERS = {
    // Nothing at all: the engine star field is the whole sky. Still the
    // fallback for an entry whose `kind` does not resolve.
    void: {},

    /* -- Direction A ------------------------------------------------------- */

    /**
     * DEEP SPACE. One plane and nothing to separate it from, which is the
     * place: the field never leaves rung 0, so what you see is 420 baked stars,
     * a dozen of them breathing, and the engine's own 44 near stars on top.
     * The only place in the catalogue that needs no veil at all.
     */
    pixelDeep: {
        init(bd) {
            bd.stars = starList(bd, 0x1a77, 420, 0.18);
            bd.twinkle = twinkleList(bd, 0x2f10, 12);
        },
        field: () => FIELD_DARK,
        update: breathe,
        live: twinkles,
    },

    /**
     * BLUE MARBLE. Two ramps in one bake: the noise decides sea or land per art
     * pixel and the field hands the bake whichever of the two that pixel
     * belongs to, which is the only way a coastline survives eight rungs. The
     * star is a direction rather than a sprite -- lambert against the sphere
     * normal -- so the terminator is baked and the lit half costs nothing.
     */
    pixelMarble: {
        init(bd) {
            bd.cx = bd.x0 + bd.w * 0.3;
            bd.cy = bd.y0 + bd.h * 0.86;
            bd.r = bd.w * 0.42;
            bd.land = mkNoise(0x6c31);
            bd.cloud = mkNoise(0x91ab);
            bd.stars = starList(bd, 0x4b02, 300, 0.24);
            bd.twinkle = twinkleList(bd, 0x7712, 12);
        },
        // The globe is solid: a star behind it is not drawn at all.
        occlude(bd, x, y) {
            const dx = (x - bd.cx) / bd.r;
            const dy = (y - bd.cy) / bd.r;
            return dx * dx + dy * dy <= 1 ? 1 : 0;
        },
        field(bd, x, y) {
            const dx = (x - bd.cx) / bd.r;
            const dy = (y - bd.cy) / bd.r;
            const q = dx * dx + dy * dy;
            if (q > 1) {
                // Outside the disc there is only air, falling off over about a
                // tenth of a radius.
                return { v: clamp(Math.exp(-(Math.sqrt(q) - 1) * 11) * 0.85, 0, 1) * 0.9 };
            }
            const bx = x - bd.x0;
            const by = y - bd.y0;
            const nz = Math.sqrt(Math.max(0, 1 - q));
            const lit = Math.pow(clamp(dx * SUN_X + dy * SUN_Y + nz * SUN_Z, 0, 1), 0.85);
            const l = bd.land(bx * 0.0055, by * 0.0055, 4);
            const isLand = l > 0.52;
            const clouds = clamp((bd.cloud(bx * 0.01 + 4, by * 0.0085, 3) - 0.6) * 2.4, 0, 1);
            // Land sits darker than sea and carries its own relief; cloud is
            // painted over both at nearly full lit value.
            let v = lit * (isLand ? 0.52 + (l - 0.52) * 0.8 : 0.68);
            v = v * (1 - clouds * 0.55) + clouds * lit * 0.95;
            // Limb darkening: the rim of the disc loses nearly half its value.
            v *= 0.55 + 0.45 * clamp((1 - q) * 3.2, 0, 1);
            return { v: clamp(v, 0, 1), rgb: isLand && clouds < 0.4 ? bd.rgbAlt : bd.rgb };
        },
        update: breathe,
        live: twinkles,
    },

    /**
     * VIOLET NEBULA. The place the direction was decided on: it has more
     * gradient in it than anything else in the catalogue, so if the dither
     * holds here it holds everywhere. Three noises -- the gas, the dust lanes
     * cut through it, a fine grain over both -- and a cap at rung 6, so however
     * bright the gas gets it stops short of the pale pink the enemies fire in.
     */
    pixelNebula: {
        init(bd) {
            bd.n1 = mkNoise(0x9e3f);
            bd.n2 = mkNoise(0x51c7);
            bd.n3 = mkNoise(0x2b81);
            bd.cx = bd.x0 + bd.w * 0.42;
            bd.cy = bd.y0 + bd.h * 0.45;
            bd.rr = bd.w * 0.58 * (bd.w * 0.58);
            bd.stars = starList(bd, 0x7b19, 300, 0.24);
            bd.twinkle = twinkleList(bd, 0x3ac5, 12);
        },
        // Gas dims the stars behind it and never quite hides them, which is
        // what the entry promises.
        occlude(bd, x, y) {
            return gasDensity(bd, x, y) * 0.8;
        },
        field(bd, x, y) {
            return { v: gasDensity(bd, x, y) };
        },
        update: breathe,
        live: twinkles,
    },

    /**
     * ASTEROID BELT. Two planes, and the separation between them is the place:
     * 520 rocks baked into the haze band, 26 nearer ones drifting down over it
     * at 0.10-0.32 px a frame and 6-9 px across. The rocks that can kill you
     * are the wave's, at 0.7-2.0 px a frame and 32-80 px across -- an order of
     * magnitude apart on both axes, which is what stops the scenery reading as
     * a target.
     */
    pixelBelt: {
        init(bd) {
            bd.haze = mkNoise(0x33cd);
            bd.stars = starList(bd, 0x5e88, 340, 0.24);
            const rng = mulberry32(0x8ad2);
            bd.far = [];
            for (let i = 0; i < 520; i++) {
                // Rocks crowd the middle of the band and thin towards its
                // edges: depth the haze on its own does not give.
                const band = Math.exp(-Math.pow((rng() * 2 - 1) * 1.5, 2));
                bd.far.push({
                    x: bd.x0 + rng() * bd.w,
                    y: bd.y0 + bd.h * 0.5 + (rng() * 2 - 1) * bd.h * 0.46 * (1 - band * 0.4),
                    // Measured against this arena rather than carried over: the
                    // study's 1-4.4 px radius rounds to one art pixel for every
                    // rock at a 3 px scale, so the whole band came out as
                    // dither noise and the lit-edge branch below never ran.
                    // Sized in art pixels instead: 1, 2 or 3 across.
                    r: ART_PIX * (0.8 + rng() * 2.2),
                    v: 0.3 + rng() * 0.55,
                });
            }
            const m = mulberry32(0x2caf);
            bd.rocks = [];
            for (let i = 0; i < 26; i++) {
                bd.rocks.push({
                    x: m() * bd.W,
                    y: m() * bd.H,
                    r: 3 + m() * 7,
                    sp: 0.1 + m() * 0.22,
                    a: 0.45 + m() * 0.35,
                });
                // The study drew a rotation per rock and never used it. Keep
                // the draw: without it every rock after the first lands
                // somewhere the sheet was not tuned against.
                m();
            }
        },
        occlude(bd, x, y) {
            return clamp(bd.haze((x - bd.x0) * 0.0035, (y - bd.y0) * 0.006, 3) * 0.55, 0, 0.8);
        },
        field(bd, x, y) {
            const by = y - bd.y0;
            const h = bd.haze((x - bd.x0) * 0.0035, by * 0.006, 3);
            const band = Math.exp(-Math.pow((by - bd.h * 0.5) / (bd.h * 0.34), 2));
            return { v: clamp(h * 0.34 * band + 0.05 * band, 0, 1) };
        },
        hard(bd, g, pix) {
            const ramp = bd.p.ramp;
            for (const rk of bd.far) {
                const rp = Math.max(1, Math.round(rk.r / pix));
                const x = Math.floor((rk.x - bd.x0) / pix);
                const y = Math.floor((rk.y - bd.y0) / pix);
                g.fillStyle = ramp[rk.v > 0.68 ? 5 : rk.v > 0.48 ? 4 : 3];
                g.fillRect(x, y, rp, rp);
                if (rp > 1) {
                    // A single lit art pixel along the top edge is all the
                    // shape a 2-3 px rock can carry.
                    g.fillStyle = ramp[rk.v > 0.68 ? 6 : 5];
                    g.fillRect(x, y, Math.max(1, rp - 1), 1);
                }
            }
        },
        update(bd, ts) {
            for (const rk of bd.rocks) {
                rk.y += rk.sp * ts;
                if (rk.y > bd.H + 12) {
                    rk.y = -12;
                }
            }
        },
        live(bd, g) {
            // 26 rocks, 3 rasterising calls each: body, lit top edge, cast
            // shadow down the right.
            const ramp = bd.p.ramp;
            for (const rk of bd.rocks) {
                const rp = Math.max(2, Math.round(rk.r / ART_PIX));
                const x = snapTo(bd.x0, rk.x);
                const y = snapTo(bd.y0, rk.y);
                // The haze this sits on runs at rungs 1-2, so the study's body
                // at rung 3 was a rock you could not see. Body two rungs over
                // it, lit edge four, and the cast shadow goes *under* the haze
                // rather than into it.
                g.fillStyle = ramp[4];
                g.fillRect(x, y, rp * ART_PIX, rp * ART_PIX);
                g.fillStyle = ramp[rk.a > 0.65 ? 6 : 5];
                g.fillRect(x, y, Math.max(ART_PIX, (rp - 1) * ART_PIX), ART_PIX);
                g.fillStyle = ramp[1];
                g.fillRect(x + (rp - 1) * ART_PIX, y + ART_PIX, ART_PIX, Math.max(ART_PIX, (rp - 1) * ART_PIX));
            }
        },
    },

    /**
     * EVENT HORIZON. The only place whose motion is physics rather than a sine,
     * and the only one whose live layer costs anything: 96 grains on a
     * Keplerian inspiral, angular rate going as r^-1.5, so a grain both
     * brightens and whips round as it falls, and is gone the frame it touches
     * the horizon. The disc they ride in, its photon ring and the hole itself
     * do not move, so all three are baked.
     */
    pixelHorizon: {
        init(bd) {
            bd.cx = bd.W * 0.5;
            bd.cy = bd.H * 0.3;
            bd.dust = mkNoise(0x71e9);
            const rng = mulberry32(0x1f3b);
            bd.grains = [];
            for (let i = 0; i < 96; i++) {
                bd.grains.push({
                    a: rng() * 6.2832,
                    r: DISC_R0 + rng() * (DISC_R1 - DISC_R0),
                    s: 0.9 + rng() * 0.5,
                    seed: rng(),
                });
            }
            bd.stars = starList(bd, 0x6f4c, 300, 0.24);
        },
        occlude(bd, x, y) {
            const v = discValue(bd, x, y);
            return v < 0 ? 1 : clamp(v * 1.5, 0, 1);
        },
        field(bd, x, y) {
            const v = discValue(bd, x, y);
            if (v < 0) {
                return FIELD_DARK;
            }
            const dx = x - bd.cx;
            const dy = y - bd.cy;
            // Photon ring: a thin halo standing just off the horizon, in the
            // plane of the screen rather than the plane of the disc.
            const d = Math.sqrt(dx * dx + dy * dy);
            const halo = Math.exp(-Math.abs(d - HOLE_R * 1.55) / 9) * 0.55;
            return { v: clamp(v + halo, 0, 1) };
        },
        hard(bd, g, pix) {
            // Nothing gets out of there, so the hole is punched to black over
            // the ramp rather than being the ramp's darkest rung.
            g.fillStyle = "#000000";
            const rp = HOLE_R / pix;
            const cxp = (bd.cx - bd.x0) / pix;
            const cyp = (bd.cy - bd.y0) / pix;
            for (let py = Math.floor(cyp - rp - 1); py <= Math.ceil(cyp + rp + 1); py++) {
                for (let px = Math.floor(cxp - rp - 1); px <= Math.ceil(cxp + rp + 1); px++) {
                    const dx = px + 0.5 - cxp;
                    const dy = py + 0.5 - cyp;
                    if (dx * dx + dy * dy <= rp * rp) {
                        g.fillRect(px, py, 1, 1);
                    }
                }
            }
        },
        update(bd, ts) {
            for (const gr of bd.grains) {
                gr.a += 0.02 * Math.pow(DISC_R0 / gr.r, 1.5) * gr.s * ts;
                gr.r -= (0.055 + 0.3 * Math.pow(DISC_R0 / gr.r, 2)) * ts * gr.s;
                if (gr.r <= HOLE_R * 1.04) {
                    // Back out at the rim. The re-entry angle is hashed off the
                    // grain instead of drawn, so the place stays a function of
                    // its id and the clock and nothing else.
                    gr.r = DISC_R1 * (0.86 + gr.seed * 0.14);
                    gr.a = hash2(gr.r * 100, gr.seed * 1000, 7) * 6.2832;
                }
            }
        },
        live(bd, g) {
            // 96 rasterising calls, the worst in the catalogue. A grain gets
            // one rung brighter and then twice as wide on the way in, which is
            // the whole read: it is accelerating.
            const ramp = bd.p.ramp;
            for (const gr of bd.grains) {
                const x = bd.cx + Math.cos(gr.a) * gr.r;
                const dy = Math.sin(gr.a) * gr.r * DISC_SQ;
                const y = bd.cy + dy;
                // The disc is squashed and the horizon is not, so the inner
                // grains cross the black circle. The near half of the disc
                // passes in front of the hole and the far half goes behind it:
                // without the second case a grain shows up as a lit speck
                // inside the one thing nothing gets out of.
                const dx = x - bd.cx;
                if (dy < 0 && dx * dx + dy * dy < HOLE_R * HOLE_R) {
                    continue;
                }
                const t = clamp(1 - (gr.r - HOLE_R) / (DISC_R1 - HOLE_R), 0, 1);
                g.fillStyle = ramp[t > 0.86 ? 7 : t > 0.68 ? 6 : t > 0.45 ? 5 : 4];
                g.fillRect(snapTo(bd.x0, x), snapTo(bd.y0, y), t > 0.78 ? ART_PIX * 2 : ART_PIX, ART_PIX);
            }
        },
    },

    /**
     * INNER SYSTEM. The only place with hard art that moves: the dust plane,
     * the five orbital lanes and the star are baked, and the five bodies ride
     * over them as pre-rasterised sprites blitted on the lattice -- so the
     * thing that moves is at the resolution of the sky it crosses.
     *
     * It keeps no state at all. Every angle is a function of `bd.t`, which is
     * why there is no `update`: the thumbnail takes the place straight to
     * frame 1500 instead of stepping it there.
     */
    pixelSystem: {
        init(bd) {
            bd.cx = bd.W * bd.p.cx;
            bd.cy = bd.H * bd.p.cy;
            bd.orbits = SYS_ORBITS.map((o) => ({ R: o.R, s: o.s, wd: 14 + 0.045 * o.R }));
            bd.rubble = mkNoise(0x5b13);
            bd.grain = mkNoise(0x1e5a);
            bd.stars = starList(bd, 0x1e50, 170, 0.24);
            bd.bodies = SYS_BODIES.map((b) => ({
                R: b.R,
                per: b.per,
                th0: b.th0,
                cv: shadedSphere(b.r, b.pal, SYS_PHASES),
            }));
        },
        /**
         * Nothing solid is baked here -- the five things that could hide a
         * star all move -- so `occlude` carries the other rule instead: a star
         * only goes down where the plate behind it is dark. This is the place
         * whose field fills the frame, and a point light on a lit lane is a
         * speck of noise rather than a star behind the dust.
         */
        occlude(bd, x, y) {
            const s = systemField(bd, x, y);
            const ramp = s.rgb || bd.rgb;
            const last = ramp.length - 1;
            const cap = Math.min(bd.p.topRung === undefined ? last : bd.p.topRung, last);
            return lum(ramp[clamp(Math.round(s.v * last), 0, cap)]) >= SYS_STAR_MAX ? 1 : 0;
        },
        field: systemField,
        hard(bd, g, pix) {
            // The orbit hairlines, one art pixel wide and two rungs apart, so
            // the near half of an ellipse passes in front of the far half.
            const ramp = bd.p.ramp;
            for (const o of bd.orbits) {
                const steps = Math.max(160, Math.round(o.R * 1.6));
                for (let i = 0; i < steps; i++) {
                    const th = (i / steps) * 6.2832;
                    const ct = Math.cos(th) * o.R;
                    const st = Math.sin(th) * o.R * SYS_SQUASH;
                    const px = Math.round((bd.cx + ct * SYS_TILT_C - st * SYS_TILT_S - bd.x0) / pix);
                    const py = Math.round((bd.cy + ct * SYS_TILT_S + st * SYS_TILT_C - bd.y0) / pix);
                    g.fillStyle = Math.sin(th) > 0 ? ramp[6] : ramp[4];
                    g.fillRect(px, py, 1, 1);
                }
            }
            // The star's disc, on the second ramp and painted straight rather
            // than through it, so it keeps the top rung the cap takes off the
            // field. It is the one element allowed to be warm, and it pays for
            // that by being 72 px across -- far too big to read as a bullet.
            const land = bd.p.landRamp;
            const cr = SYS_CORE_R / pix;
            const cx = (bd.cx - bd.x0) / pix;
            const cy = (bd.cy - bd.y0) / pix;
            for (let py = Math.floor(cy - cr - 1); py <= Math.ceil(cy + cr + 1); py++) {
                for (let px = Math.floor(cx - cr - 1); px <= Math.ceil(cx + cr + 1); px++) {
                    const dx = px + 0.5 - cx;
                    const dy = py + 0.5 - cy;
                    const d = Math.sqrt(dx * dx + dy * dy);
                    if (d > cr) {
                        continue;
                    }
                    g.fillStyle = d > cr - 1 ? land[6] : land[7];
                    g.fillRect(px, py, 1, 1);
                }
            }
        },
        live(bd, g) {
            // Five blits, and the only ones in the catalogue: everything else
            // that moves in a Direction A place is a `fillRect`. Smoothing has
            // to go off here -- these are 6-11 px sprites blown up three
            // times, and the layer's own flag was restored before this runs.
            g.imageSmoothingEnabled = false;
            for (const b of bd.bodies) {
                const th = b.th0 + bd.t * (6.2832 / b.per);
                const ct = Math.cos(th) * b.R;
                const st = Math.sin(th) * b.R * SYS_SQUASH;
                const x = bd.cx + ct * SYS_TILT_C - st * SYS_TILT_S;
                const y = bd.cy + ct * SYS_TILT_S + st * SYS_TILT_C;
                // A far-side body inside the corona is dropped: it is lost in
                // the glare rather than punched out of it as a dark bite.
                if (Math.sin(th) < 0 && Math.hypot(x - bd.cx, y - bd.cy) < SYS_OCCULT_R) {
                    continue;
                }
                // The crescent points at the star, quantised to the directions
                // the body was rasterised in.
                const ph = Math.round(Math.atan2(bd.cy - y, bd.cx - x) / (6.2832 / SYS_PHASES));
                const cv = b.cv[((ph % SYS_PHASES) + SYS_PHASES) % SYS_PHASES];
                const w = cv.width * ART_PIX;
                g.drawImage(cv, snapTo(bd.x0, x - w / 2), snapTo(bd.y0, y - w / 2), w, w);
            }
        },
    },
    /**
     * ICE WORLD. The only place with no air in the way, and everything in it is
     * that one claim: cold air carries no moisture, so it carries no haze, so
     * nothing here softens with distance.
     *
     * Two consequences, and they are the whole composition. **Hard edges all
     * the way back**: three ridge ranges drawn at identical edge hardness, with
     * their snow caps all on the *same* rung, so depth comes only from
     * occlusion order and silhouette scale -- the reverse of every other place
     * in the catalogue, which fades toward its horizon. And **near-stillness**:
     * clear air is calm air, so the fastest thing here moves 0.14 logical px a
     * frame and a flake takes about 4,800 frames to cross the arena.
     *
     * The 22 degree halo is the evidence of the clear air rather than a second
     * idea -- only suspended crystals make one, and it can only be seen because
     * there is nothing between the eye and it. It is structure, not texture:
     * one ring, one rung over the sky it stands in, and the ridges cut it off
     * where they meet it because they are in front of it.
     *
     * Why this place is quantised and not a `surface` entry with new axes on
     * it: `surface` composites additively over a gradient, and additive
     * compositing cannot make an occluding edge -- a far ridge drawn that way
     * brightens the sky behind it instead of hiding it, which is aerial
     * perspective enforced by the blend mode. "The far ridge cuts as hard as
     * the near one" is not a sentence that renderer can say.
     */
    pixelIce: {
        init(bd) {
            bd.aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            // Near range first: the loops below take the first line they are
            // under, so the order is the occlusion order.
            bd.ridges = ICE_RIDGES.map((d) => {
                const rng = mulberry32(d.seed);
                const cp = [];
                for (let i = 0; i <= d.n; i++) {
                    cp.push(rng());
                }
                const h = new Float32Array(bd.aw);
                for (let i = 0; i < bd.aw; i++) {
                    const t = (i / bd.aw) * d.n;
                    const k = Math.floor(t);
                    const f = t - k;
                    const a = cp[k];
                    const b = cp[k + 1] === undefined ? cp[0] : cp[k + 1];
                    // Smoothstep between control points: a ridge line is a
                    // silhouette, and a linear one reads as a folded strip.
                    h[i] = bd.H * d.base - (a + (b - a) * (f * f * (3 - 2 * f))) * d.amp;
                }
                return { h, rung: d.rung };
            });
            bd.cx = bd.W * bd.p.cx;
            bd.cy = bd.H * bd.p.cy;
            // The shelf cracks, in art pixels, on the near range and inside the
            // arena rather than the 100 px band under it the study puts them
            // in -- at this composition that band is almost entirely below the
            // floor, and a shelf crack nobody can see is not a feature.
            const rng = mulberry32(ICE_CRACK_SEED);
            bd.cracks = [];
            for (let i = 0; i < ICE_CRACKS; i++) {
                bd.cracks.push({
                    x: rng() * bd.aw,
                    y: (bd.H * ICE_RIDGES[0].base + 4 + rng() * ICE_CRACK_BAND - bd.y0) / ART_PIX,
                    w: 14 + rng() * 46,
                });
            }
            const rf = mulberry32(ICE_FLAKE_SEED);
            bd.flakes = [];
            for (let i = 0; i < ICE_FLAKES; i++) {
                bd.flakes.push({
                    x: rf() * bd.W,
                    y: rf() * (bd.H + ICE_FLAKE_WRAP),
                    v: ICE_FALL[0] + rf() * (ICE_FALL[1] - ICE_FALL[0]),
                    ph: rf() * 6.2832,
                    // Six logical px minimum -- two art pixels, and above the
                    // 1-4 px an enemy core is. A flake has to read as mass.
                    s: rf() < 0.35 ? ART_PIX * 3 : ART_PIX * 2,
                    rung: rf() < 0.4 ? 5 : 6,
                });
            }
        },
        field(bd, x, y) {
            const i = clamp(Math.floor((x - bd.x0) / ART_PIX), 0, bd.aw - 1);
            for (const r of bd.ridges) {
                const h = r.h[i];
                if (y < h) {
                    continue;
                }
                // The settled snow. All three ranges wear it on the same rung
                // and at the same two art pixels, which IS the no-haze claim:
                // a far cap that read dimmer than a near one would be aerial
                // perspective drawn by hand.
                return y < h + ICE_CAP * ART_PIX
                    ? { v: ICE_CAP_RUNG / ICE_LAST }
                    : { v: r.rung / ICE_LAST, rgb: bd.rgbAlt };
            }
            return { v: iceSky(bd, x, y) };
        },
        hard(bd, g, pix) {
            // Cracks: one art pixel, stepping a row every ninth column, in the
            // darkest of the four land rungs. The only hard art in the place --
            // the ranges themselves come out of `field`, because a silhouette
            // whose edge is decided per art pixel is exactly what the dither
            // must not be allowed to soften.
            g.fillStyle = bd.p.landRamp[3];
            for (const c of bd.cracks) {
                for (let k = 0; k < c.w; k++) {
                    g.fillRect(
                        Math.floor(c.x + k) % bd.aw,
                        Math.floor(c.y + k / 9),
                        1, 1
                    );
                }
            }
        },
        live(bd, g) {
            // Fourteen rects, and they are the entire live layer: the cheapest
            // place in the catalogue. Everything else is a pure function of
            // position and bakes, and the flakes are only here because they
            // move relative to the plane. No `update` either -- their path is a
            // function of `bd.t`, so `backdropThumb` takes them straight to
            // frame 1500 instead of stepping them there.
            const ramp = bd.p.ramp;
            for (const f of bd.flakes) {
                const y = ((f.y + bd.t * f.v) % (bd.H + ICE_FLAKE_WRAP)) - ICE_FLAKE_WRAP / 2;
                const x = (f.x + Math.sin(bd.t * ICE_EDDY_RATE + f.ph) * ICE_EDDY + bd.W)
                    % bd.W;
                g.fillStyle = ramp[f.rung];
                g.fillRect(snapTo(bd.x0, x), snapTo(bd.y0, y), f.s, f.s);
            }
        },
    },

    // Coloured gas clouds with a couple of dark dust lanes for depth.
    nebula: {
        paint(bd, g) {
            const { c1, c2 } = bd.p;
            g.globalCompositeOperation = "lighter";
            for (let i = 0; i < 24; i++) {
                blob(
                    g,
                    bd.x0 + bd.rng() * bd.w,
                    bd.y0 + bd.rng() * bd.h,
                    100 + bd.rng() * 260,
                    bd.rng() < 0.5 ? c1 : c2,
                    0.05 + bd.rng() * 0.08
                );
            }
            g.globalCompositeOperation = "source-over";
            for (let i = 0; i < 8; i++) {
                g.save();
                g.translate(bd.x0 + bd.rng() * bd.w, bd.y0 + bd.rng() * bd.h);
                g.rotate((bd.rng() - 0.5) * 2);
                g.fillStyle = "rgba(3,4,10,0.5)";
                g.beginPath();
                g.ellipse(0, 0, 60 + bd.rng() * 180, 12 + bd.rng() * 26, 0, 0, 6.2832);
                g.fill();
                g.restore();
            }
            g.globalCompositeOperation = "lighter";
            speckle(g, bd, 90, "#ffffff", 0.35);
            g.globalCompositeOperation = "source-over";
        },
    },

    // Tunnel of light: concentric rings turning at different speeds.
    wormhole: {
        init(bd) {
            bd.cx = bd.W * 0.5;
            bd.cy = bd.H * 0.32;
        },
        live(bd, g) {
            g.save();
            g.globalCompositeOperation = "lighter";
            g.translate(bd.cx, bd.cy);
            for (let i = 0; i < 14; i++) {
                const ph = (bd.t * 0.006 + i / 14) % 1;
                const r = 40 + ph * 620;
                g.save();
                g.rotate(bd.t * 0.002 * (i % 2 ? 1 : -1) + i);
                g.scale(1, 0.7);
                g.strokeStyle = rgba(i % 2 ? bd.p.c1 : bd.p.c2, 0.34 * (1 - ph));
                g.lineWidth = 3 + ph * 10;
                g.beginPath();
                g.arc(0, 0, r, 0, 6.2832);
                g.stroke();
                g.restore();
            }
            blob(g, 0, 0, 90, bd.p.c1, 0.5);
            g.restore();
        },
    },

    // Two stars locked together, with the gas bridge between them.
    binary: {
        paint(bd, g) {
            const { a, b } = bd.p;
            g.save();
            g.globalCompositeOperation = "lighter";
            const grd = g.createLinearGradient(bd.W * 0.22, -bd.H * 0.1, bd.W * 0.8, bd.H * 0.16);
            grd.addColorStop(0, rgba(a, 0.22));
            grd.addColorStop(0.5, rgba("#ffffff", 0.10));
            grd.addColorStop(1, rgba(b, 0.22));
            g.fillStyle = grd;
            g.save();
            g.translate(bd.W * 0.5, bd.H * 0.03);
            g.rotate(0.16);
            g.fillRect(-bd.W * 0.34, -34, bd.W * 0.68, 68);
            g.restore();
            g.restore();
            sun(g, bd.W * 0.22, -bd.H * 0.1, 30, a);
            sun(g, bd.W * 0.8, bd.H * 0.16, 20, b);
            speckle(g, bd, 60, "#ffffff", 0.3);
        },
    },

    // Neutron star: the beams sweep past every couple of seconds.
    pulsar: {
        init(bd) {
            bd.cx = bd.W * 0.5;
            bd.cy = -bd.H * 0.12;
        },
        live(bd, g) {
            g.save();
            g.globalCompositeOperation = "lighter";
            g.translate(bd.cx, bd.cy);
            g.rotate(bd.t * 0.011);
            for (const s of [1, -1]) {
                const grd = g.createLinearGradient(0, 0, 0, s * 1300);
                grd.addColorStop(0, rgba(bd.p.c1, 0.42));
                grd.addColorStop(1, rgba(bd.p.c1, 0));
                g.fillStyle = grd;
                g.beginPath();
                g.moveTo(0, 0);
                g.lineTo(-120, s * 1300);
                g.lineTo(120, s * 1300);
                g.closePath();
                g.fill();
            }
            g.restore();
            sun(g, bd.cx, bd.cy, 12, bd.p.c1, 0.9 + Math.sin(bd.t * 0.3) * 0.1);
        },
    },

    // A star tearing itself apart: shock rings expanding out of the remnant.
    supernova: {
        init(bd) {
            bd.cx = bd.W * 0.5;
            bd.cy = bd.H * 0.1;
        },
        paint(bd, g) {
            g.globalCompositeOperation = "lighter";
            for (let i = 0; i < 16; i++) {
                blob(
                    g,
                    bd.cx + (bd.rng() - 0.5) * bd.W * 1.2,
                    bd.cy + (bd.rng() - 0.5) * bd.H,
                    80 + bd.rng() * 200,
                    bd.rng() < 0.5 ? bd.p.c1 : bd.p.c2,
                    0.05 + bd.rng() * 0.06
                );
            }
            g.globalCompositeOperation = "source-over";
        },
        live(bd, g) {
            g.save();
            g.globalCompositeOperation = "lighter";
            for (let i = 0; i < 3; i++) {
                const ph = ((bd.t * 0.0022 + i / 3) % 1);
                const r = 30 + ph * 900;
                g.strokeStyle = rgba(i % 2 ? bd.p.c2 : bd.p.c1, 0.4 * (1 - ph) * (1 - ph));
                g.lineWidth = 6 + ph * 26;
                g.beginPath();
                g.arc(bd.cx, bd.cy, r, 0, 6.2832);
                g.stroke();
            }
            const f = 0.8 + Math.sin(bd.t * 0.17) * 0.12 + Math.sin(bd.t * 0.41) * 0.08;
            blob(g, bd.cx, bd.cy, 190, bd.p.c1, 0.3 * f);
            blob(g, bd.cx, bd.cy, 70, "#ffffff", 0.5 * f);
            g.restore();
        },
    },

    // Looking straight into the crowded middle of the galaxy.
    galaxy: {
        paint(bd, g) {
            g.save();
            g.globalCompositeOperation = "lighter";
            g.translate(bd.W * 0.5, bd.H * 0.35);
            g.rotate(-0.35);
            for (let arm = 0; arm < 2; arm++) {
                for (let i = 0; i < 460; i++) {
                    const t = i / 460;
                    const ang = arm * Math.PI + t * 4.2;
                    const r = 30 + t * 780;
                    const sp = (bd.rng() - 0.5) * (40 + t * 150);
                    const x = Math.cos(ang) * r + sp;
                    const y = (Math.sin(ang) * r + sp) * 0.42;
                    g.fillStyle = rgba(bd.rng() < 0.25 ? bd.p.c2 : bd.p.c1, 0.1 + bd.rng() * 0.4);
                    g.fillRect(x, y, 1.4, 1.4);
                }
            }
            g.scale(1, 0.42);
            blob(g, 0, 0, 260, bd.p.c1, 0.22);
            blob(g, 0, 0, 90, "#fff3d0", 0.4);
            g.restore();
        },
    },

    /**
     * A world going past: the planet limb fills one side of the sky. `style`
     * picks the surface treatment, and the terminator always comes from the
     * same direction as the light in `p.lit`.
     *
     * ECLIPSE is the only place left on it, and the ring machinery is gone with
     * RINGED GIANT: three of the four things that place needed -- the ring-plane
     * basis, the cylindrical shadow solve, the clump roll -- are dead weight in
     * a ringless world, and the fourth replaces the banding helper this shares
     * with the marble. Extending it in place would have been a painter that is
     * half rings behind a `rings: true` flag.
     */
    planet: {
        paint(bd, g) {
            const p = bd.p;
            const cx = p.cx * bd.W;
            const cy = p.cy * bd.H;
            const r = p.r * bd.W;
            if (p.star) {
                sun(g, cx + p.lit * r * 2.6, cy - r * 1.4, 18, p.star);
            }
            // Body.
            g.save();
            g.beginPath();
            g.arc(cx, cy, r, 0, 6.2832);
            g.clip();
            const grd = g.createRadialGradient(cx + p.lit * r * 0.4, cy - r * 0.35, r * 0.1, cx, cy, r);
            grd.addColorStop(0, p.hi);
            grd.addColorStop(1, p.base);
            g.fillStyle = grd;
            g.fillRect(cx - r, cy - r, r * 2, r * 2);
            surface(g, bd, cx, cy, r, p);
            // Terminator: the unlit side goes to nothing.
            const sh = g.createLinearGradient(cx + p.lit * r, cy, cx - p.lit * r, cy);
            sh.addColorStop(0, "rgba(2,3,8,0)");
            sh.addColorStop(0.55, "rgba(2,3,8,0.55)");
            sh.addColorStop(1, "rgba(2,3,8,0.95)");
            g.fillStyle = sh;
            g.fillRect(cx - r, cy - r, r * 2, r * 2);
            g.restore();
            // Atmosphere rim.
            g.save();
            g.globalCompositeOperation = "lighter";
            g.strokeStyle = rgba(p.atmo || p.hi, 0.5);
            g.lineWidth = 6;
            g.beginPath();
            g.arc(cx, cy, r + 2, -1.2 + (p.lit < 0 ? Math.PI : 0), 1.5 + (p.lit < 0 ? Math.PI : 0));
            g.stroke();
            g.restore();
            speckle(g, bd, 50, "#ffffff", 0.3);
        },
    },

    // A moon right below: craters and a hard horizon, no atmosphere.
    moon: {
        paint(bd, g) {
            const top = bd.H * 0.62;
            g.fillStyle = bd.p.base;
            g.fillRect(bd.x0, top, bd.w, bd.y0 + bd.h - top);
            for (let i = 0; i < 120; i++) {
                const x = bd.x0 + bd.rng() * bd.w;
                const y = top + bd.rng() * (bd.y0 + bd.h - top);
                const r = 6 + bd.rng() * 46;
                g.fillStyle = rgba(bd.p.hi, 0.1 + bd.rng() * 0.12);
                g.beginPath();
                g.arc(x, y, r, 0, 6.2832);
                g.fill();
                g.fillStyle = "rgba(0,0,0,0.18)";
                g.beginPath();
                g.arc(x - r * 0.2, y - r * 0.2, r * 0.8, 0, 6.2832);
                g.fill();
            }
            const grd = g.createLinearGradient(0, top - 60, 0, top + 40);
            grd.addColorStop(0, rgba(bd.p.hi, 0));
            grd.addColorStop(1, rgba(bd.p.hi, 0.3));
            g.fillStyle = grd;
            g.fillRect(bd.x0, top - 60, bd.w, 100);
            speckle(g, bd, 70, "#ffffff", 0.35);
        },
    },

    /**
     * Flying inside a planet's atmosphere. Two forms on one code path:
     *
     * `bandForm: "bank"` -- the default, and what the four other worlds are: a
     * baked sky with 16 soft ellipses scrolling over it in `lighter`, plus
     * `motes` (spores, sand) falling over that.
     *
     * `bandForm: "belt"` -- GAS GIANT DESCENT: the sky plus a stack of tiles
     * that wrap and translate at their own rates, so the decks shear against
     * each other; vortices riding one of them; and a screen-space density ramp
     * on the nearest, so the deck thickens as you sink into it. Everything is
     * baked in `paint` and `live` is blits only. See the belt-deck helpers.
     */
    surface: {
        init(bd) {
            bd.bands = [];
            if (bd.p.bandForm === "belt") {
                beltInit(bd);
            } else {
                for (let i = 0; i < 16; i++) {
                    bd.bands.push({
                        y: bd.rng(),
                        h: 14 + bd.rng() * 60,
                        a: 0.05 + bd.rng() * 0.16,
                        w: 0.5 + bd.rng() * 0.6,
                        x: bd.rng(),
                    });
                }
            }
            bd.motes = [];
            if (bd.p.motes) {
                for (let i = 0; i < 70; i++) {
                    bd.motes.push({
                        x: bd.x0 + bd.rng() * bd.w,
                        y: bd.y0 + bd.rng() * bd.h,
                        v: 0.4 + bd.rng() * 2.2,
                        s: 1 + bd.rng() * 2,
                    });
                }
            }
        },
        paint(bd, g) {
            // Three stops at 0 / 0.55 / 1 unless the place says otherwise: the
            // gas giant needs four to get the near-black top and the lit floor
            // into the same gradient.
            const stops = bd.p.skyStops || SKY_STOPS;
            const grd = g.createLinearGradient(0, bd.y0, 0, bd.y0 + bd.h);
            for (let i = 0; i < bd.p.sky.length; i++) {
                grd.addColorStop(stops[i], bd.p.sky[i]);
            }
            g.fillStyle = grd;
            g.fillRect(bd.x0, bd.y0, bd.w, bd.h);
            if (bd.p.glow) {
                // The light comes from below because you are falling towards
                // it. Centred just under the box so only its shoulder shows.
                const cx = bd.x0 + bd.w * 0.5;
                const cy = bd.y0 + bd.h * 1.02;
                const gl = g.createRadialGradient(cx, cy, 40, cx, cy, bd.w * 0.62);
                gl.addColorStop(0, rgba(bd.p.glow, 0.3));
                gl.addColorStop(1, rgba(bd.p.glow, 0));
                g.fillStyle = gl;
                g.fillRect(bd.x0, bd.y0, bd.w, bd.h);
            }
            if (bd.p.bandForm === "belt") {
                beltPaint(bd);
            }
        },
        update(bd, ts) {
            bd.scroll = (bd.scroll || 0) + (bd.p.speed || 0.7) * ts;
            for (const m of bd.motes) {
                m.y += m.v * ts;
                if (m.y > bd.y0 + bd.h) { m.y = bd.y0; }
                if (m.y < bd.y0) { m.y = bd.y0 + bd.h; }
            }
        },
        live(bd, g) {
            if (bd.p.bandForm === "belt") {
                beltLive(bd, g);
            } else {
                const sp = bd.p.bandSpread || BAND_SPREAD;
                const span = sp[1] - sp[0];
                g.save();
                g.globalCompositeOperation = bd.p.dark ? "source-over" : "lighter";
                for (const b of bd.bands) {
                    let y = bd.y0 + ((b.y * bd.h + bd.scroll) % bd.h);
                    const x = bd.x0 + b.x * bd.w * span;
                    g.fillStyle = rgba(bd.p.band, b.a);
                    g.beginPath();
                    g.ellipse(x + bd.w * sp[0], y, bd.w * 0.36 * b.w, b.h * 0.5, 0, 0, 6.2832);
                    g.fill();
                }
                g.restore();
            }
            if (bd.motes.length) {
                g.save();
                g.globalCompositeOperation = "lighter";
                g.fillStyle = rgba(bd.p.moteColor || "#ffffff", 0.55);
                for (const m of bd.motes) {
                    g.fillRect(m.x, m.y, m.s, m.s);
                }
                g.restore();
            }
            if (bd.p.lightning && Math.floor(bd.t * 0.02) % 37 === 0) {
                const f = Math.abs(Math.sin(bd.t * 0.6));
                g.save();
                g.globalCompositeOperation = "lighter";
                blob(g, bd.W * 0.3, bd.H * 0.2, 300, bd.p.band, 0.22 * f);
                g.restore();
            }
        },
    },

    // Rocks as far as the eye can see. They are scenery: the asteroids you can
    // actually hit are the engine's, much closer to the camera.
    belt: {
        paint(bd, g) {
            for (let i = 0; i < 150; i++) {
                const x = bd.x0 + bd.rng() * bd.w;
                const y = bd.y0 + bd.rng() * bd.h;
                const r = 3 + bd.rng() * 20;
                const a = 0.1 + bd.rng() * 0.3;
                g.save();
                g.translate(x, y);
                g.rotate(bd.rng() * 6.2832);
                g.fillStyle = rgba(bd.p.base, a);
                g.beginPath();
                for (let k = 0; k < 7; k++) {
                    const ang = (k / 7) * 6.2832;
                    const rr = r * (0.7 + bd.rng() * 0.5);
                    g[k ? "lineTo" : "moveTo"](Math.cos(ang) * rr, Math.sin(ang) * rr);
                }
                g.closePath();
                g.fill();
                g.fillStyle = rgba(bd.p.hi, a * 0.5);
                g.fillRect(-r * 0.3, -r * 0.5, r * 0.5, r * 0.3);
                g.restore();
            }
            speckle(g, bd, 60, "#ffffff", 0.3);
        },
    },

    // Hulls that never made it home.
    graveyard: {
        paint(bd, g) {
            speckle(g, bd, 90, "#ffffff", 0.35);
            for (let i = 0; i < 7; i++) {
                const x = bd.x0 + bd.rng() * bd.w;
                const y = bd.y0 + bd.rng() * bd.h;
                const l = 70 + bd.rng() * 260;
                const h = l * (0.12 + bd.rng() * 0.1);
                g.save();
                g.translate(x, y);
                g.rotate((bd.rng() - 0.5) * 2.4);
                g.fillStyle = rgba(bd.p.base, 0.55);
                g.beginPath();
                g.moveTo(-l / 2, -h / 2);
                g.lineTo(l / 2, -h * 0.2);
                g.lineTo(l / 2, h * 0.2);
                g.lineTo(-l / 2, h / 2);
                g.closePath();
                g.fill();
                g.fillStyle = rgba("#000000", 0.4);
                g.fillRect(-l / 2, 0, l, h / 2);
                // A few panels still have power.
                for (let k = 0; k < 5; k++) {
                    g.fillStyle = rgba(bd.p.hi, 0.15 + bd.rng() * 0.45);
                    g.fillRect(-l / 2 + bd.rng() * l, -h * 0.3 + bd.rng() * h * 0.6, 3, 2);
                }
                g.restore();
            }
        },
    },

    // Somebody still lives out here.
    station: {
        init(bd) {
            bd.cx = bd.p.cx * bd.W;
            bd.cy = bd.p.cy * bd.H;
            bd.r = bd.p.r * bd.W;
            bd.lights = [];
            for (let i = 0; i < 26; i++) {
                bd.lights.push({ a: bd.rng() * 6.2832, ph: bd.rng() * 6.2832 });
            }
        },
        paint(bd, g) {
            speckle(g, bd, 80, "#ffffff", 0.3);
            g.save();
            g.translate(bd.cx, bd.cy);
            g.scale(1, 0.36);
            g.strokeStyle = rgba(bd.p.base, 0.85);
            g.lineWidth = bd.r * 0.16;
            g.beginPath();
            g.arc(0, 0, bd.r, 0, 6.2832);
            g.stroke();
            g.strokeStyle = rgba(bd.p.base, 0.5);
            g.lineWidth = bd.r * 0.05;
            for (let i = 0; i < 6; i++) {
                const a = (i / 6) * 6.2832;
                g.beginPath();
                g.moveTo(0, 0);
                g.lineTo(Math.cos(a) * bd.r, Math.sin(a) * bd.r);
                g.stroke();
            }
            g.restore();
            g.fillStyle = rgba(bd.p.base, 0.9);
            g.beginPath();
            g.arc(bd.cx, bd.cy, bd.r * 0.16, 0, 6.2832);
            g.fill();
        },
        live(bd, g) {
            g.save();
            g.globalCompositeOperation = "lighter";
            for (const l of bd.lights) {
                const x = bd.cx + Math.cos(l.a) * bd.r;
                const y = bd.cy + Math.sin(l.a) * bd.r * 0.36;
                const f = 0.35 + Math.abs(Math.sin(bd.t * 0.03 + l.ph)) * 0.65;
                g.fillStyle = rgba(bd.p.hi, f);
                g.fillRect(x - 1.5, y - 1.5, 3, 3);
            }
            g.restore();
        },
    },

    // Charged particles hitting a magnetosphere: curtains of light.
    aurora: {
        init(bd) {
            bd.curtains = [];
            for (let i = 0; i < 5; i++) {
                bd.curtains.push({
                    x: bd.x0 + (i + 0.5) * (bd.w / 5),
                    w: 60 + bd.rng() * 120,
                    ph: bd.rng() * 6.2832,
                    sp: 0.006 + bd.rng() * 0.012,
                    c: bd.rng() < 0.5 ? bd.p.c1 : bd.p.c2,
                });
            }
        },
        live(bd, g) {
            g.save();
            g.globalCompositeOperation = "lighter";
            for (const c of bd.curtains) {
                const x = c.x + Math.sin(bd.t * c.sp + c.ph) * 90;
                const grd = g.createLinearGradient(x, bd.y0, x, bd.y0 + bd.h);
                grd.addColorStop(0, rgba(c.c, 0));
                grd.addColorStop(0.4, rgba(c.c, 0.20));
                grd.addColorStop(0.75, rgba(c.c, 0.07));
                grd.addColorStop(1, rgba(c.c, 0));
                g.fillStyle = grd;
                g.save();
                g.translate(x, 0);
                g.rotate(Math.sin(bd.t * c.sp * 0.6 + c.ph) * 0.12);
                g.fillRect(-c.w / 2, bd.y0, c.w, bd.h);
                g.restore();
            }
            g.restore();
        },
    },

    // Ice shards big enough to have their own gravity, catching the light.
    crystal: {
        paint(bd, g) {
            speckle(g, bd, 70, "#ffffff", 0.3);
            for (let i = 0; i < 34; i++) {
                const x = bd.x0 + bd.rng() * bd.w;
                const y = bd.y0 + bd.rng() * bd.h;
                const l = 30 + bd.rng() * 150;
                g.save();
                g.translate(x, y);
                g.rotate(bd.rng() * 6.2832);
                const grd = g.createLinearGradient(0, -l / 2, 0, l / 2);
                grd.addColorStop(0, rgba(bd.p.c1, 0.34));
                grd.addColorStop(1, rgba(bd.p.c2, 0.08));
                g.fillStyle = grd;
                g.beginPath();
                g.moveTo(0, -l / 2);
                g.lineTo(l * 0.14, 0);
                g.lineTo(0, l / 2);
                g.lineTo(-l * 0.14, 0);
                g.closePath();
                g.fill();
                g.strokeStyle = rgba(bd.p.c1, 0.3);
                g.lineWidth = 1;
                g.stroke();
                g.restore();
            }
        },
    },

    /**
     * COMET TRAIL. Two tails out of one head, and the whole place is the angle
     * between them opening as it passes: gold dust curving back along the
     * orbit, a blue ion tail pinned dead anti-solar. From 18 degrees at entry
     * to 90 at closest approach to 153 at exit.
     *
     * The eighth Direction A conversion and the first one that **moves**. Every
     * other place bakes once because everything hard-edged in it is a function
     * of position; a comet is not, so the head, the tails and the knots are
     * rasterised into an art-resolution buffer every frame and blitted up.
     *
     * The study quantises by drawing the tails with canvas gradients and
     * running `getImageData` over their bounding box each frame. That is not
     * taken: a GPU readback in the middle of every frame is a cost no other
     * place here pays, and it is avoidable. The tails are scanline-filled
     * straight into the buffer at the rung the gradient asks for instead --
     * same ordered dither, same result, no readback and no antialiased edge to
     * undo. See `cometPixel`.
     *
     * The one thing the old painter never did is the thing its own catalogue
     * line promised: the tail pointed along the velocity, not away from the
     * star. Both tails start from the anti-solar direction now, and only the
     * dust bends off it.
     */
    pixelComet: {
        init(bd) {
            bd.cx = bd.W * COMET_STAR[0];
            bd.cy = bd.H * COMET_STAR[1];
            // 240 of them, and the brightness band is what keeps the top rung
            // of `starRamp` off the field: see the entry.
            bd.stars = starList(bd, 0x2f7c, 240, 0.24);
            const aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            const ah = Math.max(1, Math.ceil(bd.h / ART_PIX));
            const cv = document.createElement("canvas");
            cv.width = aw;
            cv.height = ah;
            const g = cv.getContext("2d");
            const img = g.createImageData(aw, ah);
            const last = bd.rgb.length - 1;
            bd.surf = {
                cv, g, img, data: img.data, aw, ah, last,
                cap: Math.min(bd.p.topRung === undefined ? last : bd.p.topRung, last),
                // The rect the last frame dirtied, so only that much has to be
                // cleared and only that much is uploaded.
                px0: 0, py0: 0, px1: -1, py1: -1,
                x0: 0, y0: 0, x1: 0, y1: 0,
            };
        },
        /**
         * A baked star only goes down where the plate behind it is dark. The
         * star's own corona is the one lit thing in this sky, and a point
         * light inside it is a speck of noise rather than a star behind it.
         */
        occlude(bd, x, y) {
            const ramp = bd.rgbAlt;
            const last = ramp.length - 1;
            const cap = Math.min(bd.p.topRung === undefined ? last : bd.p.topRung, last);
            const v = cometSky(bd, x, y);
            return lum(ramp[clamp(Math.round(v * last), 0, cap)]) >= COMET_STAR_LIT ? 1 : 0;
        },
        field(bd, x, y) {
            const v = cometSky(bd, x, y);
            // Empty sky is rung 0 of the ion ramp; the corona is the warm one.
            // Both ramps start on the same near-black, so there is no seam
            // where the glow runs out.
            return v > 0 ? { v: clamp(v, 0, 1), rgb: bd.rgbAlt } : FIELD_DARK;
        },
        hard(bd, g, pix) {
            // The star's core, painted straight off the second ramp rather
            // than through it, so it is a disc and not the top of a dithered
            // falloff.
            //
            // It stops at rung 6 and does NOT take the study's rung 7. The
            // study's core measures pale because it paints one from a
            // near-white gradient; this ramp's rung 7 is the entry's own gold,
            // and a 9 px block of it is warm by the measurement's own test --
            // mean R over 1.12 x mean B, which is what an enemy core looks
            // like. The sibling answer (INNER SYSTEM's star is warm and pays
            // for it by being 72 px across, far too big to read as a bullet) is
            // not available either: nothing in this composition wants a 56 px
            // sun in it. So the star keeps its shape and gives up its top rung,
            // the nucleus keeps rung 7 alone, and the brightest thing in the
            // place is the comet -- which is the right answer for a place named
            // after one.
            const land = bd.p.landRamp;
            const cx = Math.round((bd.cx - bd.x0) / pix);
            const cy = Math.round((bd.cy - bd.y0) / pix);
            g.fillStyle = land[6];
            g.fillRect(cx - 1, cy - 1, 3, 3);
            g.fillStyle = land[5];
            g.fillRect(cx - 2, cy - 1, 1, 3);
            g.fillRect(cx + 2, cy - 1, 1, 3);
            g.fillRect(cx - 1, cy - 2, 3, 1);
            g.fillRect(cx - 1, cy + 2, 3, 1);
        },
        live(bd, g) {
            const s = bd.surf;
            const G = cometGeom(bd);
            const px = ART_PIX;
            const ax = (v) => (v - bd.x0) / px;
            const ay = (v) => (v - bd.y0) / px;
            const nx = -G.uy;
            const ny = G.ux;

            // --- the two node runs, in art pixels ------------------------
            const ion = new Float64Array((COMET_ION.n + 1) * 2);
            for (let i = 0; i <= COMET_ION.n; i++) {
                const arc = (G.li * i) / COMET_ION.n;
                const o = COMET_ION.amp * (i / COMET_ION.n)
                    * Math.sin((6.2832 * (arc - bd.t * COMET_ION.crest)) / COMET_ION.period);
                ion[i * 2] = ax(G.hx + G.ux * arc + nx * o);
                ion[i * 2 + 1] = ay(G.hy + G.uy * arc + ny * o);
            }
            const dn = COMET_DUST.n;
            const dust = new Float64Array((dn + 1) * 2);
            dust[0] = ax(G.hx);
            dust[1] = ay(G.hy);
            let dx = G.hx;
            let dy = G.hy;
            const step = G.ld / dn;
            for (let i = 1; i <= dn; i++) {
                // The syndyne: anti-solar at the head, bending towards the
                // anti-orbital direction the further down the tail it gets.
                const u = i / dn;
                const bx = G.ux - COMET_DUST.bend * u * G.vhx;
                const by = G.uy - COMET_DUST.bend * u * G.vhy;
                const m = Math.hypot(bx, by) || 1;
                dx += (bx / m) * step;
                dy += (by / m) * step;
                dust[i * 2] = ax(dx);
                dust[i * 2 + 1] = ay(dy);
            }

            // --- what has to be cleared and uploaded ---------------------
            const tip = COMET_DUST.w1[0] + COMET_DUST.w1[1] * G.a;
            const pad = (20 + tip) / px;
            s.x0 = s.aw;
            s.y0 = s.ah;
            s.x1 = -1;
            s.y1 = -1;
            for (const run of [ion, dust]) {
                for (let i = 0; i < run.length; i += 2) {
                    if (run[i] - pad < s.x0) { s.x0 = run[i] - pad; }
                    if (run[i] + pad > s.x1) { s.x1 = run[i] + pad; }
                    if (run[i + 1] - pad < s.y0) { s.y0 = run[i + 1] - pad; }
                    if (run[i + 1] + pad > s.y1) { s.y1 = run[i + 1] + pad; }
                }
            }
            s.x0 = clamp(Math.floor(s.x0), 0, s.aw);
            s.y0 = clamp(Math.floor(s.y0), 0, s.ah);
            s.x1 = clamp(Math.ceil(s.x1), 0, s.aw - 1);
            s.y1 = clamp(Math.ceil(s.y1), 0, s.ah - 1);
            // The union with last frame's rect: what this frame does not paint
            // still has to stop showing what the last one did.
            const ux0 = s.px1 < s.px0 ? s.x0 : Math.min(s.x0, s.px0);
            const uy0 = s.px1 < s.px0 ? s.y0 : Math.min(s.y0, s.py0);
            const ux1 = s.px1 < s.px0 ? s.x1 : Math.max(s.x1, s.px1);
            const uy1 = s.px1 < s.px0 ? s.y1 : Math.max(s.y1, s.py1);
            for (let y = uy0; y <= uy1; y++) {
                s.data.fill(0, (y * s.aw + ux0) * 4, (y * s.aw + ux1 + 1) * 4);
            }

            // --- the art, in the order the study draws it ----------------
            // Dust first and outermost stria first: they are nested, and each
            // one is painted with the brightness of everything covering it, so
            // the cross-section comes out as banded grain lanes.
            const dustA = COMET_DUST.alpha[0] + COMET_DUST.alpha[1] * G.a;
            let cum = 0;
            for (const st of COMET_DUST.striae) {
                cum += st[1];
                const k = dustA * cum;
                cometRibbon(s, dust,
                    (u) => ((COMET_DUST.w0 + tip * Math.pow(u, COMET_DUST.flare)) * st[0]) / px,
                    st[2] / px, bd.rgbAlt,
                    (u) => k * cometStop(COMET_DUST.stops, u));
            }
            const ionA = COMET_ION.alpha[0] + COMET_ION.alpha[1] * G.a;
            const ionW = (COMET_ION.w[0] + COMET_ION.w[1] * G.a) / 2 / px;
            cometRibbon(s, ion, () => ionW, 0, bd.rgb,
                (u) => ionA * cometStop(COMET_ION.stops, u));

            // Knots, off the crossing's own generator so they are the same on
            // every machine and replay from any instant.
            const krng = mulberry32((COMET_KSEED ^ Math.imul(G.cross, 40503)) >>> 0);
            let born = 0;
            for (let k = 0; born < COMET_T && k < COMET_KNOT.cap; k++) {
                const at = born;
                born += COMET_KNOT.every[0] + krng() * COMET_KNOT.every[1];
                const age = G.local - at;
                if (age < 0) {
                    continue;
                }
                const arc = age * COMET_KNOT.speed;
                if (arc > G.li * COMET_KNOT.over) {
                    continue;
                }
                const o = COMET_ION.amp * (arc / G.li)
                    * Math.sin((6.2832 * (arc - bd.t * COMET_ION.crest)) / COMET_ION.period);
                const fade = 1 - arc / (G.li * COMET_KNOT.over);
                cometDisc(s, ax(G.hx + G.ux * arc + nx * o), ay(G.hy + G.uy * arc + ny * o),
                    (COMET_KNOT.r[0] + COMET_KNOT.r[1] * fade) / px,
                    bd.rgb, COMET_FADE, COMET_KNOT.alpha * fade * G.a);
            }
            cometDisc(s, ax(G.hx), ay(G.hy), G.rc / px, bd.rgb, COMET_COMA.stops, G.b);

            // The nucleus: two art pixels at the top of the ramp, and the only
            // thing in the place allowed to be the brightest thing in it.
            const cx = Math.round(ax(G.hx));
            const cy = Math.round(ay(G.hy));
            const top = bd.rgb[s.last];
            for (let y = cy - 1; y <= cy; y++) {
                if (y < 0 || y >= s.ah) {
                    continue;
                }
                for (let x = cx - 1; x <= cx; x++) {
                    if (x < 0 || x >= s.aw) {
                        continue;
                    }
                    const i = (y * s.aw + x) * 4;
                    s.data[i] = top[0];
                    s.data[i + 1] = top[1];
                    s.data[i + 2] = top[2];
                    s.data[i + 3] = 255;
                }
            }

            // --- one upload, one blit ------------------------------------
            s.g.putImageData(s.img, 0, 0, ux0, uy0, ux1 - ux0 + 1, uy1 - uy0 + 1);
            s.px0 = s.x0;
            s.py0 = s.y0;
            s.px1 = s.x1;
            s.py1 = s.y1;
            g.imageSmoothingEnabled = false;
            g.drawImage(s.cv, bd.x0, bd.y0, bd.w, bd.h);
        },
    },

    /**
     * RINGED GIANT. The ninth Direction A conversion, and the one where the
     * contract already contained the answer to the place's hardest problem.
     *
     * Translucency, occlusion and behind-versus-in-front are three descriptions
     * of one number, and `occlude` is that number. Drawn soft, a ring plane is
     * the same arcs stroked twice with alpha, hoping the ordering reads; drawn
     * as a plane with an opacity profile, the body test and the ring test are
     * evaluated at the same art pixel and which one wins is the sign of one
     * plane coordinate. The arcs-drawn-twice problem stops existing.
     *
     * The body is not new work either: it is the converted marble with the
     * noise swapped for a belt table, which is what lands the two gas giants of
     * a run -- this and the deck you fly through twelve waves earlier -- on the
     * same value language.
     *
     * The one thing here that cannot bake is the turn, and it does not have to
     * run: the density table steps one cell every 86.7 frames, so the live
     * layer has 96 states and 86 frames out of 87 are one blit.
     */
    pixelGiant: {
        init(bd) {
            bd.cx = bd.W * bd.p.cx;
            bd.cy = bd.H * bd.p.cy;
            bd.R = bd.W * bd.p.r;
            bd.fil = mkNoise(GIANT_FIL_SEED);
            bd.stars = starList(bd, GIANT_STAR_SEED, GIANT_STARS, 0.24);
            // Nine belts walking north from -1.02 rad, alternating light and
            // dark, on the study's own seed.
            const rb = mulberry32(GIANT_BELT_SEED);
            bd.belts = [];
            let lat = GIANT_BELT_LAT0;
            for (let i = 0; i < GIANT_BELTS; i++) {
                const w = GIANT_BELT_W[0] + rb() * GIANT_BELT_W[1];
                bd.belts.push({
                    c: lat + w,
                    w,
                    a: (i % 2 ? -1 : 1) * (GIANT_BELT_A[0] + rb() * GIANT_BELT_A[1]),
                    fil: i >= GIANT_FIL[0] && i <= GIANT_FIL[1],
                });
                lat += w * 2 + GIANT_BELT_GAP[0] + rb() * GIANT_BELT_GAP[1];
            }
            // The azimuthal density of the two clumping bands: half of it flat
            // random per cell, half a slow noise, so clumps come in groups.
            const rc = mulberry32(GIANT_CLUMP_SEED);
            const noise = mkNoise(GIANT_CLUMP_NOISE);
            bd.clumpTab = [];
            for (let b = 0; b < GIANT_CLUMP_BANDS.length; b++) {
                const row = new Float32Array(GIANT_CELLS);
                for (let k = 0; k < GIANT_CELLS; k++) {
                    row[k] = rc() * GIANT_CLUMP_MIX[0]
                        + GIANT_CLUMP_MIX[1]
                            * noise(k * GIANT_CLUMP_MIX[2], b * GIANT_CLUMP_MIX[3], 1);
                }
                bd.clumpTab.push(row);
            }
            const aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            const ah = Math.max(1, Math.ceil(bd.h / ART_PIX));
            const cv = document.createElement("canvas");
            cv.width = aw;
            cv.height = ah;
            const g = cv.getContext("2d");
            const img = g.createImageData(aw, ah);
            bd.clump = { cv, g, img, data: img.data, aw, ah };
            bd.rollCell = -1;
        },
        /**
         * The first partial return in the catalogue, and the study is right
         * that one function does three jobs here: it hides a star behind the
         * body, dims one behind a ring by that band's own opacity, and -- on
         * INNER SYSTEM's rule, with INNER SYSTEM's number -- drops one that
         * would land on a plate already lit. That last clause is what makes a
         * star visible through the C ring and invisible through B.
         */
        occlude(bd, x, y) {
            const dx = x - bd.cx;
            const dy = y - bd.cy;
            if (dx * dx + dy * dy <= bd.R * bd.R) {
                return 1;
            }
            const u = dx * GIANT_COS + dy * GIANT_SIN;
            const w = (-dx * GIANT_SIN + dy * GIANT_COS) / GIANT_SQUASH;
            const rho = Math.hypot(u, w) / bd.R;
            const op = rho > GIANT_R0 && rho < GIANT_R1 ? giantRingOp(rho) : 0;
            if (op <= 0) {
                return 0;
            }
            const last = bd.rgb.length - 1;
            const cap = Math.min(bd.p.topRung === undefined ? last : bd.p.topRung, last);
            const v = giantRingVal(rho, op) * giantRingShadow(bd, u, w);
            return lum(bd.rgb[clamp(Math.round(v * last), 0, cap)]) >= GIANT_STAR_LIT ? 1 : op;
        },
        field: giantField,
        live(bd, g) {
            const cell = Math.floor(bd.t / GIANT_ROLL) % GIANT_CELLS;
            if (cell !== bd.rollCell) {
                bd.rollCell = cell;
                giantRoll(bd, cell);
            }
            g.imageSmoothingEnabled = false;
            g.drawImage(bd.clump.cv, bd.x0, bd.y0, bd.w, bd.h);
        },
    },

    /**
     * MOLTEN WORLD. A cold basalt plain lit from underneath, where the only
     * light is structure and the air above it will not hold still. The crust
     * is near-black so the shimmer has hard edges to displace, the light is
     * confined to one flow and a dull crack network so the displacement reads
     * on structure rather than on fog, and the sky is lit from below so the
     * brightest air is the air closest to the ground -- which is the air that
     * shimmers hardest.
     */
    pixelMolten: {
        init(bd) {
            bd.aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            bd.ah = Math.max(1, Math.ceil(bd.h / ART_PIX));
            bd.hy = bd.H * LAVA_HORIZON;
            bd.rgbRidge = rampRGB(bd.p.ridgeRamp);
            bd.rgbFlow = rampRGB(bd.p.flowRamp);
            bd.cloud = mkNoise(0x4a17);
            bd.crust = mkNoise(0x21c9);
            bd.relief = mkNoise(0x7d05);
            lavaColumns(bd);
            lavaFlow(bd);
            lavaCracks(bd);
            const rng = mulberry32(LAVA_ASH_SEED);
            bd.ash = [];
            for (let i = 0; i < LAVA_ASH; i++) {
                bd.ash.push({
                    x: bd.x0 + rng() * bd.w,
                    y: rng() * (bd.h + LAVA_ASH_WRAP),
                    v: LAVA_ASH_FALL[0] + rng() * (LAVA_ASH_FALL[1] - LAVA_ASH_FALL[0]),
                    ph: rng() * 6.2832,
                    // Two or three art pixels. An enemy core is 1-4 logical.
                    s: (rng() < 0.5 ? 2 : 3) * ART_PIX,
                });
            }
        },
        // One entry point and four materials: the plain (crust, crack network
        // and flow), the three ranges, the smoke, and the sky.
        field(bd, x, y) {
            const ax = clamp(Math.floor((x - bd.x0) / ART_PIX), 0, bd.aw - 1);
            const pt = bd.plain[ax];
            if (y >= pt) {
                const ay = clamp(Math.floor((y - bd.y0) / ART_PIX), 0, bd.ah - 1);
                const dep = lavaDep(bd, y);
                const d = ay >= bd.flowTop
                    ? Math.abs(ax + 0.5 - bd.flowX[ay])
                    : Infinity;
                if (d < LAVA_FLOW_FRINGE[0] + LAVA_FLOW_FRINGE[1] * dep) {
                    // The flow takes a flat rung with the dither skipped
                    // entirely. A dithered core turns the one hot thing in the
                    // place into a dotted line, and two dozen 3 px dots of
                    // #ffd06a are two dozen bullets.
                    return {
                        v: 1,
                        rgb: bd.rgbFlow,
                        flat: d < LAVA_FLOW_CORE[0] + LAVA_FLOW_CORE[1] * dep
                            ? 2
                            : d < LAVA_FLOW_BAND[0] + LAVA_FLOW_BAND[1] * dep ? 1 : 0,
                    };
                }
                let halo = 0;
                for (const q of LAVA_FLOW_HALO) {
                    halo += q[2] * clamp(1 - d / (q[0] + q[1] * dep), 0, 1);
                }
                const n = bd.crust(x * 0.01 + 13, y * 0.024 + 29, 1) * 0.4
                    + bd.crust(x * 0.038 + 47, y * 0.08 + 7, 1) * 0.32
                    + bd.crust(x * 0.0035, y * 0.009, 1) * 0.28;
                const v = 0.11
                    + 0.24 * clamp((y - pt) / (bd.y0 + bd.h - pt), 0, 1)
                    + (n - 0.5) * 0.3
                    + (bd.crack[ay * bd.aw + ax] / 255) * 1.15
                    + halo * 1.15;
                return { v: clamp(v, 0, 1), rgb: bd.rgbAlt, cap: LAVA_LAND_CAP };
            }
            const nz = bd.crust(x * 0.03, y * 0.05, 1);
            for (let k = 0; k < LAVA_RANGES.length; k++) {
                const ct = bd.crest[k][ax];
                if (y < ct) {
                    continue;
                }
                // Near range first: the loop takes the first crest it is
                // under, so the order is the occlusion order. A silhouette
                // decided per art pixel is exactly what the dither must not be
                // allowed to soften, which is why none of this is `hard` art.
                const r = LAVA_RANGES[k];
                return {
                    v: (r.rung + (nz - 0.5) * r.nz + (y - ct < r.lip ? r.lipK : 0)) / LAVA_LAST,
                    rgb: bd.rgbRidge,
                };
            }
            if (lavaPlume(bd, x, y) > LAVA_PLUME_CUT) {
                return {
                    v: (LAVA_PLUME_RUNG + (nz - 0.5) * 1.2) / LAVA_LAST,
                    rgb: bd.rgbRidge,
                };
            }
            // The sky, lit from below: brightest at the horizon and clipped by
            // `topRung` so it can never reach the pale pink of enemy fire.
            const t = clamp((y - bd.y0) / (bd.hy - bd.y0), 0, 1);
            return {
                v: clamp(
                    Math.pow(t, 2.1) * 0.78
                    + (bd.cloud(x * 0.0055, y * 0.01, 1) - 0.5) * 0.12 * t
                    + (bd.cloud(x * 0.003 + 53, y * 0.016 + 11, 1) - 0.44) * 0.18 * t
                    + Math.exp(-Math.pow((bd.hy - y) / ((bd.hy - bd.y0) * 0.22), 2)) * 0.36,
                    0, 1
                ),
            };
        },
        /**
         * The plane, emitted as runs of art rows that share a slide instead of
         * as one image. The shimmer is the plane moving against itself, so it
         * cannot bake: the offset is a function of row and frame together. But
         * it is quantised to whole art pixels and therefore piecewise constant
         * down the plane, so the 388 rows of the box come out in about thirty
         * calls, pixel-identical to one call a row. The still sky above the
         * heat zone is simply the first of those runs.
         */
        blit(bd, g) {
            let start = 0;
            let off = lavaShim(bd, 0);
            for (let r = 1; r <= bd.ah; r++) {
                // Past the last row, a value that cannot match flushes the run.
                const o = r < bd.ah ? lavaShim(bd, r) : off - 1;
                if (o === off) {
                    continue;
                }
                g.drawImage(
                    bd.layer, 0, start, bd.aw, r - start,
                    bd.x0 + off, bd.y0 + start * ART_PIX, bd.w, (r - start) * ART_PIX
                );
                start = r;
                off = o;
            }
        },
        live(bd, g) {
            // The flow front breathing: one fill, and the only additive thing
            // left in the place now the embers are gone.
            const fy = bd.hy + (bd.y0 + bd.h - bd.hy) * LAVA_GLOW.at;
            const grd = g.createLinearGradient(0, fy - LAVA_GLOW.half, 0, fy + LAVA_GLOW.half);
            grd.addColorStop(0, rgba(bd.p.glow, 0));
            grd.addColorStop(0.5, rgba(bd.p.glow, 1));
            grd.addColorStop(1, rgba(bd.p.glow, 0));
            g.save();
            g.globalCompositeOperation = "lighter";
            g.globalAlpha = LAVA_GLOW.a + LAVA_GLOW.amp * Math.sin(bd.t * LAVA_GLOW.rate);
            g.fillStyle = grd;
            g.fillRect(bd.x0, fy - LAVA_GLOW.half, bd.w, LAVA_GLOW.half * 2);
            g.restore();
            // Ash: 26 rects, source-over, and the only thing here that moves
            // relative to the plane. No `update` -- every one of them is a pure
            // function of `bd.t`, so a still can be taken at frame 1500 without
            // stepping there, and pause and slow motion scale the clock for
            // free.
            g.fillStyle = LAVA_ASH_COLOR;
            for (const a of bd.ash) {
                const y = bd.y0 + ((a.y + bd.t * a.v) % (bd.h + LAVA_ASH_WRAP))
                    - LAVA_ASH_WRAP / 2;
                const x = a.x + Math.sin(bd.t * LAVA_ASH_RATE + a.ph) * LAVA_ASH_SWAY;
                g.fillRect(snapTo(bd.x0, x), snapTo(bd.y0, y), a.s, a.s);
            }
        },
    },
};

/**
 * VIOLET NEBULA's gas, 0..1. Read twice per art pixel -- once for the field,
 * once to work out how much of the star behind it survives -- so it is a
 * function rather than a closure the painter has to carry.
 */
function gasDensity(bd, x, y) {
    const bx = x - bd.x0;
    const by = y - bd.y0;
    let d = bd.n1(bx * 0.0042, by * 0.0055, 3);
    // The sine is what stacks the gas into layers instead of leaving it a
    // cloud: one band every ~1010 px of box, warped by the noise itself.
    d = d * 0.86 + 0.26 * Math.sin(by * 0.0062 + d * 3.4) + 0.14;
    // Dust lanes: wherever the second noise crosses its own midpoint the gas
    // is cut down to a third over a band about 0.085 of the noise wide.
    const lane = bd.n2(bx * 0.0016 + by * 0.0009, by * 0.0022, 2);
    d *= 0.34 + 0.66 * clamp(Math.abs(lane - 0.5) / 0.085, 0, 1);
    const dx = x - bd.cx;
    const dy = y - bd.cy;
    d *= 0.42 + 0.58 * Math.exp(-(dx * dx + dy * dy * 1.35) / bd.rr);
    d *= 0.88 + 0.24 * bd.n3(bx * 0.011, by * 0.013, 2);
    return clamp(d, 0, 1);
}

/**
 * EVENT HORIZON's accretion disc, 0..1, or -1 inside the horizon. The disc is
 * a plane seen at 0.42 squash, so the distance that matters is measured in the
 * plane and not on the screen.
 */
function discValue(bd, x, y) {
    const dx = x - bd.cx;
    const dy = (y - bd.cy) / DISC_SQ;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < HOLE_R) {
        return -1;
    }
    if (d > DISC_R1 * 1.25) {
        return 0;
    }
    // Ramp up out of the horizon, fade out past the rim, and brighten steeply
    // towards the inner edge where the gas is moving fastest.
    const band = clamp((d - HOLE_R) / (DISC_R0 - HOLE_R), 0, 1) *
        clamp((DISC_R1 * 1.2 - d) / (DISC_R1 * 0.55), 0, 1);
    const inner = Math.pow(clamp(1 - (d - DISC_R0) / (DISC_R1 - DISC_R0), 0, 1), 1.5);
    // Texture read in polar space, so the streaks run the way the disc turns.
    const tex = 0.72 + 0.42 * bd.dust(Math.atan2(dy, dx) * 7, d * 0.055, 3);
    return clamp(band * (0.3 + 0.85 * inner) * tex, 0, 1);
}

/** Surface detail inside an already-clipped planet disc. */
function surface(g, bd, cx, cy, r, p) {
    if (p.style === "rock") {
        for (let i = 0; i < 60; i++) {
            const a = bd.rng() * 6.2832;
            const d = bd.rng() * r;
            g.fillStyle = rgba("#000000", 0.06 + bd.rng() * 0.14);
            g.beginPath();
            g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 3 + bd.rng() * 22, 0, 6.2832);
            g.fill();
        }
    } else {
        // "marble": continents / ice caps as soft irregular masses.
        for (let i = 0; i < 26; i++) {
            const a = bd.rng() * 6.2832;
            const d = bd.rng() * r * 0.95;
            g.fillStyle = rgba(p.land || p.hi, 0.16 + bd.rng() * 0.3);
            g.save();
            g.translate(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
            g.rotate(bd.rng() * 6.2832);
            g.beginPath();
            g.ellipse(0, 0, 14 + bd.rng() * r * 0.35, 8 + bd.rng() * r * 0.18, 0, 0, 6.2832);
            g.fill();
            g.restore();
        }
    }
}

/* -------------------------------------------------------------------------- */
/* The places                                                                  */
/* -------------------------------------------------------------------------- */

export const BACKGROUNDS = [
    {
        id: "deep", name: "DEEP SPACE", tint: "#8be9ff", kind: "pixelDeep",
        // The ramp is never called above rung 2, so the cap is what the place
        // is rather than a safety net.
        p: {
            veil: 0, topRung: 2,
            ramp: ["#04060c", "#080c16", "#0d1322", "#131b2e", "#1a2340", "#26315a", "#3a4a7a", "#6d80b0"],
        },
        desc: "The sky the star field has all to itself: no gas, no world, nothing painted behind you. Wave 1 is fought in the only place with nothing in it, and the only one that needs no veil between you and it.",
    },
    {
        id: "planet_blue", name: "BLUE MARBLE", tint: "#7fb6ff", kind: "pixelMarble",
        // `ramp` is the old base/hi/atmo run out to eight rungs, `landRamp` the
        // old `land`. Retune the place here: the painter reads nothing else.
        p: {
            veil: 18,
            ramp: ["#02050c", "#061426", "#0b2a4a", "#10426e", "#1a5c8c", "#2b86b0", "#57b3cf", "#a8e0ee"],
            landRamp: ["#04070a", "#0a1410", "#132018", "#1d3020", "#2a4526", "#3d5c2c", "#587a3a", "#86a856"],
        },
        desc: "A living world sitting low on the left, close enough to make out continents through the blue rim of its atmosphere. The star is off to one side, so the far half of it falls away into the dark.",
    },
    {
        id: "nebula_violet", name: "VIOLET NEBULA", tint: "#c9a4ff", kind: "pixelNebula",
        // The old `c1` violet climbing into the old `c2` pink. Capped one rung
        // under the top: the gas may not reach the colour the enemies fire in.
        p: {
            veil: 12, topRung: 6,
            ramp: ["#0a0714", "#1a0f2e", "#2e1748", "#4b2168", "#6f2f86", "#a4508f", "#d98aae", "#f2c4d6"],
            // Same reason as EVENT HORIZON, one order of magnitude smaller: a
            // star taken off the top of this ramp is a pale pink 3 px square,
            // and ten of them landed in a dust lane where nothing else is lit.
            // Stars in a nebula are white anyway, and cool ones read as being
            // behind the gas rather than in it.
            starRamp: ["#4b4470", "#7a74a4", "#b9b6d8"],
        },
        desc: "Violet and pink gas stacked in soft layers, with dark dust lanes cutting across it and stars showing through wherever it thins out. However bright the gas gets, it stops short of the pink the enemies shoot in.",
    },
    {
        id: "belt", name: "ASTEROID BELT", tint: "#c7b8a8", kind: "pixelBelt",
        // From the old base/hi.
        p: {
            veil: 8, topRung: 6,
            ramp: ["#05050a", "#0e0c12", "#1a161c", "#282029", "#3a2f34", "#544344", "#7a6058", "#a8877a"],
        },
        desc: "Rocks as far out as you can see, in two layers: five hundred baked into the haze, a couple of dozen nearer ones drifting down over it. They are scenery and cannot be shot -- the asteroids that can kill you are the near ones the wave spawns, and they come at you five times faster and five times bigger.",
    },
    {
        id: "blackhole", name: "EVENT HORIZON", tint: "#ffb35e", kind: "pixelHorizon",
        // The old `c1` amber. The old `c2` blue is gone: the disc is one
        // temperature now, and the ramp is the only place it can get hot.
        p: {
            veil: 22,
            ramp: ["#04030a", "#120a12", "#241017", "#3d1a1c", "#5e2a1c", "#8c4620", "#c07a2a", "#f0c060"],
            // Stars do not come out of that ramp here: its top three rungs are
            // the amber the enemies fire in, and a star is a 3 px square on
            // black, which is also what a bullet is.
            starRamp: ["#232a38", "#38414f", "#5a6478"],
        },
        desc: "A singularity hanging in the top third of the arena, its accretion disc laid out flat around it. The dust is on real orbits: grains spiral in, go bright as they pick up speed and are gone the moment they reach the horizon.",
    },
    {
        id: "gas_giant", name: "GAS GIANT DESCENT", tint: "#ffca8a", kind: "surface",
        // The GAS GIANT DESCENT study, smooth branch. Rates are logical px per
        // frame and `flow: -1` turns all of them negative: the deck rises past
        // the camera because the camera is falling. The ladder 0.16 / 0.30 /
        // 0.42 / 1.10 steps by about 2.6x, the smallest ratio at which the
        // shear between two decks reads without the near plane looking loose.
        p: {
            veil: 0, flow: -1, bandForm: "belt", bandSpread: [0, 1],
            sky: ["#0b0605", "#3a1d0f", "#70401d", "#a86c31"],
            skyStops: [0, 0.45, 0.8, 1],
            glow: "#d69654",
            beltColor: "#2a1409", band: "#b3743a",
            filament: "#d0995e", streak: "#c0703a",
            decks: [
                // far: thin, low wave, nearly still.
                { rate: 0.16, h: [5, 26], gap: [3, 12], wave: [2, 6], alpha: [0.14, 0.3], fil: 18, streaks: 2, light: "#a06a33" },
                // mid: the carrying plane, and the one the vortices ride.
                { rate: 0.42, h: [9, 44], gap: [5, 20], wave: [4, 10], alpha: [0.16, 0.34], fil: 26, streaks: 3, light: "#b3743a" },
                // near: few, thick, torn, and masked thin at the top of the box.
                { rate: 1.1, h: [16, 70], gap: [26, 80], wave: [6, 14], alpha: [0.1, 0.22], fil: 14, streaks: 1, light: "#c68a4a", dark: "#1e0f07", density: [0.3, 1] },
            ],
            // Ash, baked into a plane of its own between the two band decks:
            // far enough away that nothing at that size can read as a bullet.
            flakes: { plane: 1, rate: 0.3, n: 22, size: [4, 9], alpha: [0.05, 0.09], color: "#8a5a34" },
            vortices: {
                plane: 2, spin: 0.00085, lo: "#25120a", hi: "#c07a3a",
                list: [
                    { x: 0.34, y: 0.28, s: 1, dir: 1 },
                    { x: 0.73, y: 0.74, s: 0.62, dir: -1 },
                ],
            },
        },
        desc: "Falling through the cloud deck of a gas giant. Belts and zones rise past at their own speeds, tearing where they meet, and the haze thickens and brightens the further you sink.",
    },
    {
        id: "system", name: "INNER SYSTEM", tint: "#ffe9a8", kind: "pixelSystem",
        // The place tint rotated to its complement and held cool -- hue
        // 250-256, chroma under 0.045. Nothing the field can produce is in the
        // family the enemies fire in, which is what lets the star keep its
        // warmth on a ramp of its own.
        p: {
            veil: 12, topRung: 6, cx: 0.17, cy: 0.24,
            ramp: ["#04050b", "#0a0d18", "#101728", "#1a2338", "#26304b", "#354260", "#48587a", "#5f7098"],
            // Reached only inside the corona, a feature 136 px wide.
            landRamp: ["#0d0a06", "#241a0c", "#3d2c12", "#5a4319", "#7a5d22", "#9a7a32", "#b89a4c", "#d8bd85"],
            // Deliberately off the top of the main ramp: a baked star has to
            // be a point light in the sky, not the brightest lane in the dust.
            starRamp: ["#2b3550", "#4c6084", "#93a8c9"],
        },
        desc: "A whole system seen from outside it: a yellow star, its dust lit from within, and five planets crawling along wide tilted orbits.",
    },
    {
        id: "ice_world", name: "ICE WORLD", tint: "#bfe9ff", kind: "pixelIce",
        // Eight rungs interpolated from the entry tint down to a near-black of
        // the same hue, with the chroma pulled down as the lightness falls so
        // the dark end never goes purple. Rung 7 is the tint itself and the cap
        // means it is never drawn: nothing the backdrop can paint reaches the
        // colour of the place's own name.
        p: {
            veil: 6, topRung: 6, halo: 0.16, cx: 0.376, cy: 0.505,
            ramp: ["#061420", "#0d2434", "#16394c", "#234f63", "#34677c", "#4b8296", "#79a8b8", "#bfe9ff"],
            // Rock. Four rungs are used -- one per range, plus the cracks --
            // and the four above them exist only because a ramp is eight long.
            landRamp: ["#050e16", "#08161f", "#0c1f2b", "#122a38", "#1a3a4a", "#244c5e", "#305f74", "#40738a"],
        },
        desc: "Air too cold to hold any haze, so nothing here softens with distance: the farthest ridge cuts as hard as the nearest, and a ring of light stands in the crystals overhead. The slowest weather of any of the places.",
    },
    {
        id: "comet", name: "COMET TRAIL", tint: "#a8f0ff", kind: "pixelComet",
        // The old `c1` cyan and `c2` gold, run out to eight rungs each: the
        // ion ramp climbs to the entry tint, the dust ramp to the gold. The cap
        // keeps every tail one rung under the top of its own ramp; the ion's
        // rung 7 is spent on the nucleus alone, and `hard` says why the dust's
        // is spent on nothing.
        p: {
            veil: 12, topRung: 6,
            ramp: ["#05070a", "#0a1720", "#103038", "#1a4c58", "#2a6f7e", "#4a97a4", "#79c4d2", "#a8f0ff"],
            landRamp: ["#07060a", "#1a1410", "#2e2415", "#46381d", "#63512a", "#8a7440", "#bda45a", "#ffd66b"],
            // Stars pale rather than white, and dimmer than the study's
            // #3b4654 / #8fa0b0 / #c6d6e8. Quantising took its count of small
            // bright regions from 1 to 11, nine of them baked stars at the top
            // rung -- hard-edged and opaque where the old speckles were alpha
            // 0.35 -- and it fixed that by cutting the top rung's SHARE to
            // 3.5%. That lever does not exist here: `_bakeField` buckets a star
            // by `round(a * 3) / 3` and `starList` always spreads `a` over a
            // 0.5-wide band, so the top rung's share works out at 48% for any
            // usable `aMin`. Measured with the study's own ramp: 24 small
            // bright regions on the composed arena. Every rung here is under
            // luminance 0.70 instead -- the threshold the measurement is drawn
            // at -- so the share stops mattering.
            starRamp: ["#2c3846", "#5d6f80", "#93a8bd"],
        },
        desc: "A comet crossing on its way in. Gold dust curves back along its path; a blue ion tail points dead away from the star and swings as it passes. It crosses, leaves and comes round again.",
    },
    {
        id: "ringed", name: "RINGED GIANT", tint: "#e8c98f", kind: "pixelGiant",
        // The old `base` #6b4a22 and `hi` #e2b877 are kept as rungs 4 and 7, so
        // the place still looks like itself. Two things changed and they are
        // the whole palette fix. `atmo` #ffd9a0 drawn additively at 50% is
        // retired: rung 7 is a cream, and the rim composites source-over so it
        // cannot exceed it. And the fifty white speckles become baked stars on
        // a cool ramp of their own -- the same fix EVENT HORIZON made when its
        // point lights came out as bullets. Every small bright thing in this
        // sky is cool now, and every warm thing is large.
        // The veil is 16, not the study's 11. Its own two reasons for 11 are
        // both measurable here and neither binds: the shared flat scrim does
        // not "close the Cassini division" (the division reads at rung 1
        // against the A ring's 3 at every veil up to 30), and the standing
        // feature detector is already satisfied at 6. What does bind is that
        // this is the brightest place in the catalogue and wave 30 puts the
        // largest hull in the game in front of it: 16 is the lowest value that
        // brings p95 under 0.136 in linear light, which is 4:1 against the
        // brightest enemy bullet, and it lands the place just under BLUE
        // MARBLE -- the other place that is one big lit planet.
        p: {
            veil: 16, cx: 0.78, cy: 0.2, r: 0.5,
            ramp: ["#090a0c", "#191410", "#2c2116", "#46331d", "#6b4a22", "#9a7238", "#c9a463", "#e8cea0"],
            // The filaments of the mid-latitude belts, one step cooler, so they
            // read as a second material rather than as a brighter zone.
            landRamp: ["#090a0c", "#191411", "#2b2218", "#453522", "#684d2c", "#957442", "#c3a26c", "#e4cda6"],
            // Dimmer than the study's #4a5866 / #8a97a3 / #d6dde4. Its top rung
            // is luminance 0.863 against the 0.62 the small-bright-feature
            // detector cuts at, and 150 baked stars of it measure 8 features on
            // this arena; every rung here is under the threshold, so a star
            // cannot be one. Third star ramp to come down for the same reason.
            starRamp: ["#3a4550", "#5e6b78", "#8e9aa6"],
        },
        desc: "A banded giant filling the top right, its rings turning slowly through the frame: behind the body on one side, out in front of it on the other, with the planet's shadow lying across the far arc.",
    },
    {
        id: "lava_world", name: "MOLTEN WORLD", tint: "#ff7a45", kind: "pixelMolten",
        // Four ramps, and a cap on the two the place is mostly made of.
        // `ramp` is the sky seen from under it -- the tint rotated toward the
        // maroon air reads when the light comes off the ground, clipped at
        // rung 6 so it can never reach the pale pink of enemy fire. `landRamp`
        // is basalt at 0-3 and incandescence at 4-5, capped at 5 (see
        // `LAVA_LAND_CAP`). `ridgeRamp` carries the three ranges on rungs
        // 1/3/5, two rungs off the sky at the back. `flowRamp` is the only hot
        // thing in the place and is never dithered.
        p: {
            veil: 6, topRung: 6, glow: "#ff7a45",
            ramp: ["#0a0208", "#16040e", "#240715", "#360a1a", "#4c0f20", "#6a1524", "#8e1c28", "#b3242c"],
            landRamp: ["#0b0409", "#14060d", "#1e0812", "#2c0b15", "#5a1512", "#952c10", "#d85a12", "#ff9a3c"],
            ridgeRamp: ["#0d020c", "#160411", "#210718", "#2d0a1e", "#3c0e24", "#4e122a", "#631831", "#7c1f38"],
            flowRamp: ["#e0600f", "#ff9a2e", "#ffd06a"],
        },
        desc: "Cold basalt under a red sky, with one flow still running out of the valley. The crust is nearly black and the ranges behind it fade instead of sharpening, because the air over molten ground is too hot to hold still.",
    },
    {
        id: "pulsar", name: "PULSAR", tint: "#8fd8ff", kind: "pulsar",
        p: { c1: "#8fd8ff" },
        desc: "A neutron star turning fast overhead, sweeping two beams of light past the arena every couple of seconds.",
    },
    {
        id: "graveyard", name: "SHIP GRAVEYARD", tint: "#9aa6c4", kind: "graveyard",
        p: { base: "#2b3350", hi: "#ff8f5e" },
        desc: "Hulls left where they died, tumbled at every angle and going nowhere. A few panels on them still have power and blink.",
    },
    {
        id: "ocean_world", name: "OCEAN WORLD", tint: "#5ee1ff", kind: "surface",
        p: { sky: ["#04202c", "#0a5a72", "#3fb6c9"], band: "#9ff2ff", speed: 0.6, motes: "spore", moteColor: "#bffaff" },
        desc: "Over open water: teal sky, long cloud banks and spores drifting up through them.",
    },
    {
        id: "aurora", name: "ION STORM", tint: "#7bffb0", kind: "aurora",
        p: { c1: "#7bffb0", c2: "#5ee1ff" },
        desc: "Charged particles hitting a magnetosphere. Curtains of green and cyan light lean and swing across the whole sky.",
    },
    {
        id: "moon", name: "LOW MOON ORBIT", tint: "#d6d2c8", kind: "moon",
        p: { base: "#1b1c26", hi: "#c8c4b8" },
        desc: "Low over an airless moon: craters below and a hard horizon, with no atmosphere to soften the edge.",
    },
    {
        id: "nebula_emerald", name: "EMERALD NEBULA", tint: "#7bffb0", kind: "nebula",
        p: { c1: "#25c07a", c2: "#5ee1ff" },
        desc: "The same kind of cloud as the violet nebula, in green and cyan: layered gas, dust lanes and stars behind it.",
    },
    {
        id: "jungle_world", name: "JUNGLE WORLD", tint: "#9ade6b", kind: "surface",
        p: { sky: ["#0a2413", "#1f5a24", "#6fae4a"], band: "#c9f08a", speed: 0.7, motes: "spore", moteColor: "#d9ff9a" },
        desc: "Green haze over a canopy, with spores rising through the cloud bands.",
    },
    {
        id: "binary", name: "BINARY SUNS", tint: "#ffd66b", kind: "binary",
        p: { a: "#ffd66b", b: "#ff6b8a" },
        desc: "Two stars locked together, a gold one above and a small red one below, with the gas bridge streaming between them.",
    },
    {
        id: "station", name: "ORBITAL STATION", tint: "#9fd4ff", kind: "station",
        p: { cx: 0.72, cy: 0.18, r: 0.3, base: "#2f3a56", hi: "#8fe0ff" },
        desc: "A ring station still lit, turning slowly at the top right with lights blinking around the rim. Somebody out here is still home.",
    },
    {
        id: "desert_world", name: "DESERT WORLD", tint: "#e8c07a", kind: "surface",
        p: { sky: ["#2a1a08", "#8a6220", "#e0b874"], band: "#ffe2a8", speed: 0.9, motes: "sand", moteColor: "#ffe2a8" },
        desc: "Sand blowing across an ochre sky, thick enough that you can read the wind in it.",
    },
    {
        id: "supernova", name: "SUPERNOVA", tint: "#ff8f5e", kind: "supernova",
        p: { c1: "#ffb45e", c2: "#ff4f7a" },
        desc: "A star tearing itself apart. Shock rings expand out of the remnant one after another while the core flickers. Another place that shares its colours with enemy fire.",
    },
    {
        id: "crystal", name: "CRYSTAL FIELD", tint: "#a8d8ff", kind: "crystal",
        p: { c1: "#a8d8ff", c2: "#c9a4ff" },
        desc: "Ice shards big enough to hold themselves together, each one catching the light down its length.",
    },
    {
        id: "storm_world", name: "STORM WORLD", tint: "#b9a8ff", kind: "surface",
        p: { sky: ["#0a0a1e", "#2b2350", "#5b4e8a"], band: "#c9b8ff", speed: 1.4, motes: null, lightning: true },
        desc: "The night side of a storm world: violet cloud running faster than anywhere else, and lightning that lights the whole sky from behind.",
    },
    {
        id: "eclipse", name: "ECLIPSE", tint: "#ffd9a0", kind: "planet",
        p: { cx: 0.5, cy: 0.1, r: 0.42, lit: -1, base: "#0b0d18", hi: "#2a2f4a", atmo: "#ffd9a0", style: "rock", star: "#fff2c4" },
        desc: "A dead world dead ahead with the star behind it, so what you get is the ring of atmosphere burning around a black disc.",
    },
    {
        id: "galaxy", name: "GALACTIC CORE", tint: "#ffd6a8", kind: "galaxy",
        p: { c1: "#ffd6a8", c2: "#8fb6ff" },
        desc: "Looking straight into the crowded middle of the galaxy: two arms of stars wound around a core bright enough to read by.",
    },
    {
        id: "wormhole", name: "WORMHOLE", tint: "#c9a4ff", kind: "wormhole",
        p: { c1: "#c9a4ff", c2: "#5ee1ff" },
        desc: "The mouth of a tunnel, straight ahead. Rings of light rush out of it, each one turning against the one before it.",
    },
];

/**
 * How many waves are fought in one place before the route moves on. It was one,
 * and one is too short: a wave is 6-17 seconds, so a place arrived, was read as
 * a colour, and was gone -- and the ones with a slow feature in them (the gas
 * giant's vortices turn once every 7400 frames, the comet crosses, the pulsar
 * sweeps) were never on screen long enough to show it. Three waves is a minute
 * or so in one sky, which is long enough to notice where you are.
 *
 * It is only the wave-to-place mapping, so it costs nothing: the function stays
 * pure and the backdrop still never travels in the snapshot.
 */
export const WAVES_PER_PLACE = 3;

/**
 * The place a wave is fought in. `WAVES_PER_PLACE` waves each, in order,
 * cycling: the run keeps moving and a long one ends up going round again. Pure,
 * so every client in a co-op match paints the same sky without it travelling in
 * the snapshot.
 */
export function backgroundForWave(wave) {
    const w = Math.max(0, (wave | 0) - 1);
    return BACKGROUNDS[Math.floor(w / WAVES_PER_PLACE) % BACKGROUNDS.length];
}

/* -------------------------------------------------------------------------- */
/* Backdrop                                                                    */
/* -------------------------------------------------------------------------- */

export class Backdrop {
    /**
     * @param {object} def - one entry of BACKGROUNDS
     * @param {number} W - logical arena width
     * @param {number} H - logical arena height
     * @param {number} [layerScale] - resolution of the baked static layer, as a
     *  fraction of the logical size. The glossary thumbnails pass their own:
     *  baking a 130 px card at half the arena resolution is wasted work.
     */
    constructor(def, W, H, layerScale = LAYER_SCALE) {
        this.def = def;
        this.p = def.p || {};
        this.W = W;
        this.H = H;
        this.layerScale = layerScale;
        // The box the camera can reach: the arena plus the margin the star
        // field already covers, plus room for the parallax drift.
        const mx = W * 0.55;
        const my = H * 0.55;
        this.x0 = -mx;
        this.y0 = -my - DRIFT;
        this.w = W + mx * 2;
        this.h = H + my * 2 + DRIFT * 2;
        this.t = 0;
        this.scroll = 0;
        this.rng = mkRng(hash(def.id));
        this.dust = [];
        this.motes = [];
        this.bands = [];
        this.stars = [];
        this.layer = null;
        this.painter = PAINTERS[def.kind] || PAINTERS.void;
        // A Direction A place bakes from `field` instead of `paint`: it is
        // quantised art, so it is composed at full strength and veiled with its
        // own number rather than dimmed with everyone else's.
        this.pixel = !!this.painter.field;
        this.scrim = bgScrim(def);
        if (this.pixel) {
            this.rgb = rampRGB(this.p.ramp);
            this.rgbAlt = this.p.landRamp ? rampRGB(this.p.landRamp) : this.rgb;
        }
        if (this.painter.init) {
            this.painter.init(this);
        }
        if (this.pixel) {
            this._bakeField();
        } else if (this.painter.paint) {
            this._bake();
        }
    }

    /**
     * Direction A bake. The place is sampled once per art pixel, snapped to its
     * ramp through a Bayer 4x4 threshold, and the point lights go on top: stars
     * first, dimmed by whatever the place puts in front of them, then any
     * hard-edged art.
     *
     * The buffer stays at art resolution -- 476x388 for a 1428x1162 box -- and
     * `draw` scales it up with filtering off. That is one raster call either
     * way and a ninth of the memory of keeping the upscale around.
     */
    _bakeField() {
        const pix = ART_PIX;
        const aw = Math.max(1, Math.ceil(this.w / pix));
        const ah = Math.max(1, Math.ceil(this.h / pix));
        const cv = document.createElement("canvas");
        cv.width = aw;
        cv.height = ah;
        const g = cv.getContext("2d");
        const img = g.createImageData(aw, ah);
        const data = img.data;
        const field = this.painter.field;
        const last = this.rgb.length - 1;
        const cap = Math.min(this.p.topRung === undefined ? last : this.p.topRung, last);
        for (let py = 0; py < ah; py++) {
            const row = (py & 3) * 4;
            const y = this.y0 + (py + 0.5) * pix;
            for (let px = 0; px < aw; px++) {
                const s = field(this, this.x0 + (px + 0.5) * pix, y);
                const ramp = s.rgb || this.rgb;
                // A sample may name a `flat` rung -- this one, undithered --
                // and its own `cap`. Both exist for MOLTEN WORLD, whose flow
                // becomes a dotted line the moment it is dithered and whose
                // land stops two rungs under its own ramp; every other place
                // returns neither and bakes exactly as it did.
                let col;
                if (s.flat === undefined) {
                    const bay = (BAYER[row + (px & 3)] / 16 - 0.46) * DITHER;
                    const top = s.cap === undefined ? cap : Math.min(s.cap, cap);
                    col = ramp[clamp(Math.round(s.v * last + bay), 0, top)];
                } else {
                    col = ramp[s.flat];
                }
                const o = (py * aw + px) * 4;
                data[o] = col[0];
                data[o + 1] = col[1];
                data[o + 2] = col[2];
                data[o + 3] = 255;
            }
        }
        g.putImageData(img, 0, 0);
        // Stars are point lights, so the rung cap does not apply to them: on
        // DEEP SPACE the cap is 2 and the stars are the entire place.
        const occlude = this.painter.occlude;
        const ramp = starRamp(this);
        for (const s of this.stars) {
            const a = s.a * (1 - (occlude ? occlude(this, s.x, s.y) : 0));
            if (a < 0.1) {
                continue;
            }
            const q = Math.round(clamp(a, 0, 1) * 3) / 3;
            g.fillStyle = q > 0.66 ? ramp[2] : q > 0.33 ? ramp[1] : ramp[0];
            const w = s.big ? 2 : 1;
            g.fillRect(Math.floor((s.x - this.x0) / pix), Math.floor((s.y - this.y0) / pix), w, w);
        }
        if (this.painter.hard) {
            this.painter.hard(this, g, pix);
        }
        this.layer = cv;
    }

    /** Render the static art once, at reduced resolution, in logical coordinates. */
    _bake() {
        const k = this.layerScale;
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(this.w * k));
        cv.height = Math.max(1, Math.round(this.h * k));
        const g = cv.getContext("2d");
        g.scale(k, k);
        g.translate(-this.x0, -this.y0);
        this.painter.paint(this, g);
        this.layer = cv;
    }

    update(ts) {
        this.t += ts;
        if (this.painter.update) {
            this.painter.update(this, ts);
        }
    }

    draw(g) {
        g.save();
        // Soft places are drawn dim so the enemies in front of them keep their
        // contrast. A place that carries its own measured `p.veil` pays for its
        // contrast there instead and goes down at full value -- that is every
        // Direction A place, and GAS GIANT DESCENT.
        g.globalAlpha = this.pixel || this.p.veil !== undefined ? 1 : 0.85;
        const drift = Math.sin(this.t * 0.0016) * DRIFT;
        if (this.layer) {
            g.save();
            g.translate(0, drift);
            g.imageSmoothingEnabled = !this.pixel;
            if (this.painter.blit) {
                this.painter.blit(this, g);
            } else {
                g.drawImage(this.layer, this.x0, this.y0, this.w, this.h);
            }
            g.restore();
        }
        if (this.painter.live) {
            if (this.pixel) {
                // The live layer takes the drift too: it is the same plane. Let
                // it stand still and the grains slide across their own hole.
                g.save();
                g.translate(0, drift);
                this.painter.live(this, g);
                g.restore();
            } else {
                this.painter.live(this, g);
            }
        }
        g.restore();
    }
}

/* -------------------------------------------------------------------------- */
/* Thumbnails                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A still of one place, for the glossary card. The painters are written in
 * logical arena pixels, so the frame is composed at arena size and the canvas
 * is scaled down under them; painting it small would shrink the sky but not
 * the things in it.
 *
 * The live painters are stepped forward first, otherwise half the catalogue
 * would come out as an empty box: the comet is still off screen, the shock
 * rings have not left the remnant and the beams have not turned. Only the
 * painters that actually keep state are stepped; the ones that just read the
 * clock are taken straight to the same instant.
 *
 * @param {object} def - one entry of BACKGROUNDS
 * @param {number} [w] - width of the still, in device pixels
 * @returns {HTMLCanvasElement}
 */
export function backdropThumb(def, w = 272) {
    const k = w / THUMB_W;
    const h = Math.round(THUMB_H * k);
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const g = cv.getContext("2d");
    g.fillStyle = "#05060e";
    g.fillRect(0, 0, w, h);
    g.save();
    g.scale(k, k);
    // Only the arena: the painters cover the whole box the camera can reach,
    // and the card is meant to show the part you fly in.
    g.beginPath();
    g.rect(0, 0, THUMB_W, THUMB_H);
    g.clip();
    const bd = new Backdrop(def, THUMB_W, THUMB_H, k);
    if (bd.painter.update) {
        for (let i = 0; i < THUMB_WARMUP; i++) {
            bd.update(1);
        }
    } else {
        bd.t = THUMB_WARMUP;
    }
    bd.draw(g);
    g.fillStyle = bd.scrim;
    g.fillRect(0, 0, THUMB_W, THUMB_H);
    // The star field on top, the way the engine layers it: it is the near
    // layer, and for DEEP SPACE it is the whole picture. Same density the
    // arena shows in game, seeded off the id so a place always looks itself.
    const rng = mkRng(hash(def.id + "stars"));
    for (let i = 0; i < 44; i++) {
        const x = rng() * THUMB_W;
        const y = rng() * THUMB_H;
        const z = rng() * 2 + 0.5;
        // At this scale a sub-pixel star washes out, so it never goes under one
        // device pixel wide.
        const s = Math.max(1 / k, rng() * 1.4 + 0.4);
        g.fillStyle = "rgba(200,220,255," + (0.25 + z * 0.25) + ")";
        g.fillRect(x, y, s, s + z * 2);
    }
    g.restore();
    return cv;
}
