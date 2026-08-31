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
 * -------------------------------------------------------------------------
 * PULSAR study -- the eleventh conversion (2026-08-30)
 * -------------------------------------------------------------------------
 * `pulsar` was the emptiest entry in the catalogue: two gradient wedges on a
 * rotating transform, a 12 px sun, and black. It is now five depths, four of
 * them baked -- 460 far stars, two nebula sheets, a torus of two rings, jets
 * along the rotation axis, an asteroid belt of ~150 rocks and a silhouette
 * along the bottom of the box -- with the two beam cones, the core, its halo
 * and the wisps live. Pure render change; no `game_engine.js`.
 *
 * The finding is not in any of that. It is that **the study's own default
 * makes every behaviour its sheet promises impossible**, and only sweeping the
 * angle found it. A beam traces a cone of half-angle `alpha` about the
 * rotation axis, so it sweeps past a line of sight only if the cone reaches
 * it -- and the camera sits `90 - theta` = 56 degrees off that axis. The study
 * ships 22 degrees on a slider that stops at 45, so no setting it offers
 * sweeps anything. Measured over a rotation at 22: the projected beam wobbles
 * inside a 58 degree wedge it never leaves, **48.9%** of the arena is never
 * lit at all, a point that is lit is crossed **0.79** times a rotation, and
 * the pulse term saturates into a plateau **163 frames** wide. At 72 the same
 * three numbers are 100%, 1.31 and 31 frames. Seven claims in the sheet -- a
 * crossing every 120 frames, a ~27 frame spike, `sqrt(1 - s^2)` doing real
 * work, light leaving the arena for the core -- are false together at 22 and
 * true together above 56. See `PULSAR_ALPHA`; the sweep is in
 * `tools/neon_strike_bench/probe_pulsar.mjs`.
 *
 * Five things worth repeating:
 *   1. **A study can be internally inconsistent, and the sheet is not the
 *      arbiter of itself.** This one describes a lighthouse in prose, ships a
 *      nodding rod in code, and then rewrites the glossary line to promise the
 *      lighthouse. The prose and the glossary agree with each other and not
 *      with the default, so the default is what moves -- and the way to tell
 *      which side to take was the name of the place.
 *   2. **A published headline can be right about the shape and wrong about the
 *      value.** Its `s = sin(alpha) * cos(phi)` holds only for an axis lying in
 *      the sky plane; with 34 degrees of inclination the real `m . z` carries a
 *      constant term that saturates the 12th power. Its "27 frames" is the
 *      right target and lands at 31 here, on an angle it never tried.
 *   3. **The study's "one real engine ask" was already in the file.** It wants
 *      an art-pixel context for `live` so the beams dither like the field.
 *      COMET TRAIL's art-resolution surface with a dirty rectangle is exactly
 *      that, and it needed no engine change at all -- the second time reading
 *      an older port's departures answered a newer study's ask for free.
 *   4. **Rasterise the shape, not its bounding box.** The dirty region the
 *      study proposes -- the union of the beam boxes and the wisp annulus --
 *      is 166,064 art cells. The cones are trapezoids and the wisp arcs are
 *      strips of quads in torus coordinates, so painting each shape into an
 *      accumulator and resolving once visits **23,837 cells a frame, mean**,
 *      which is the comet's own budget for a place with far more moving in it.
 *      Two rasterising calls a frame. That also retired the study's `r < 470`
 *      screen gate, which existed to keep an `atan2` off the canvas and cut
 *      the outer arcs on a visible circle.
 *   5. **Fourth star ramp to come down.** #5f7f96 / #9dc6dd / #dff4ff measures
 *      0.48 / 0.75 / 0.94 against the detector's 0.62, and `starList` puts
 *      about half the stars on the top rung whatever the study does to its own
 *      distribution -- the same lever that was not there for COMET TRAIL. On a
 *      ramp where every rung is under the threshold the standing detector
 *      reads **0 features at every veil from 0 to 30**.
 *
 * Measured on the composed 680x540 arena. `veil: 11` is the study's own
 * recommendation and it survives: the study's no-surround count goes 1 -> 0
 * between veil 8 and 11, linear p95 is 0.035 against the 0.136 the giant's
 * veil was set on, and mean arena luminance is 6.8% against the study's 7.5%.
 * Strobe over 480 frames -- two rotations, four crossings -- peaks at 0.037%
 * of full white in one frame, at phi 184 degrees, mid-sweep and not on a pulse
 * frame, which is the shape a strobe is not; the study measured 0.034% and the
 * same story. 26 of 27 places came out byte-identical, `cometQuad` included
 * after it was split into the shared `artQuad`/`artRow`.
 * *
 * -------------------------------------------------------------------------
 * OCEAN WORLD study -- the twelfth conversion (2026-08-30)
 * -------------------------------------------------------------------------
 * The first converted place whose whole subject is a PLANE seen edge on, and
 * that makes every number in it a function of one variable: how far down the
 * water a row is. 30 crest rows at `horizon + WH * u^1.75`; the length of a
 * dash, the gap to the next, its height, its rung cap and the speed it travels
 * all read off the same `u`. Five rate bands a factor of 2.6 apart, far to
 * near -- the three far ones bake and only scroll, the two near ones are live,
 * because a crest line lengthening, breaking and reforming is the point.
 * `field` is sky on one ramp and water on a second, which is where the hard
 * teal horizon comes from: a palette change, not a drawn line.
 *
 * Five things worth repeating:
 *   1. **The port is CHEAPER than the painter it replaces, by 2.4x.** The
 *      study draws the reflection as four sheared blits, each far band as two,
 *      and every dash, glitter, foam and spore as its own `fillRect`: about
 *      420 canvas calls a frame, in a catalogue whose most expensive place is
 *      97 and whose ocean was 87. Everything under the horizon goes into one
 *      art-resolution surface instead -- COMET TRAIL's and PULSAR's idiom --
 *      and the whole water becomes 2 calls. **Measured 36 a frame against 87.**
 *      Third study in a row to price a per-element approach it did not have
 *      to pay; look for the surface before paying it.
 *   2. **Brightness control belongs in the cap, not in the veil.** `oceanCap`
 *      takes the smaller of two: depth (near water is seen at a steeper angle
 *      and gives back less sky) and where the pixel is in the ARENA, holding
 *      the bottom 200 px two rungs under the rest because that is where the
 *      player sits. It is worth more than any veil: the bottom band goes from
 *      **0.208 mean and 0.0893 linear p95 to 0.116 and 0.0206 at veil 0** --
 *      already four times better than the bar RINGED GIANT's veil was set on,
 *      before a single point of scrim. That is what lets this place carry the
 *      brightest sky in the catalogue and still be flown in.
 *   3. **Clip a live surface to the band it clears.** Two bugs at once: the
 *      first far band's crest row sits 4 px ABOVE the horizon, so it was
 *      painting water-ramp notches into the sky -- a visible comb along the
 *      skyline -- and anything written outside the cleared band would have
 *      been a smear that never went away. `oceanPix` takes the band, and both
 *      stop existing. Only rendering it and looking found the comb.
 *   4. **Point-sampling a minified sparse layer throws it away.** The
 *      reflection squashes the sky by 0.32, so three source rows fold into
 *      one -- and this sky is 4% cloud, so a point sample returned a whisper
 *      and the headline feature of the new glossary line was invisible. Take
 *      the brightest row of the range: same three reads, and the reflection
 *      appears. Also worth having: writing it as art pixels rather than
 *      blitting through a negative scale costs no call at all, lands on the
 *      lattice, and lets the swell be a continuous function of the source row
 *      instead of the study's four hard slices.
 *   5. **Fifth star ramp to come down**, and this time it was predicted rather
 *      than discovered: #9fe8f2 / #cdf6fb / #eafeff measures 0.85 / 0.93 /
 *      0.98 against the detector's 0.62. Assume it every time.
 *
 * Measured on the composed 680x540 arena at frame 1500. `veil: 8` is the
 * study's own number and it survives, but as a small correction rather than as
 * the fix: 0 features on the standing detector AND on the study's own at every
 * veil from 0 to 30, and 8 buys 6% of the bottom band's mean over 0. What did
 * the work is the cap.
 * *
 * -------------------------------------------------------------------------
 * ION STORM study -- the thirteenth conversion (2026-08-30)
 * -------------------------------------------------------------------------
 * The first place whose sky cannot bake at all. Seven curtains slide, lean and
 * fold across the box; inside each, rays on an 18 px pitch flare and die on
 * their own 0.3-0.7 s clocks. `field` holds only what is behind them -- a dust
 * band and 430 stars -- and every art pixel of the front is decided again
 * every frame. A curtain takes 18% of a star it crosses and no more, and that
 * translucency is what fills a frame that used to be five soft bars.
 *
 * Six things worth repeating:
 *   1. **Third study running whose "one real engine ask" was already in the
 *      file.** It asks for `hard(bd, g, pix)` to run per frame over an arena
 *      window handed to the painter. COMET TRAIL's art-resolution surface is
 *      that, PULSAR proved it a second time, and here it also makes the
 *      breakup's `topRung` 6 -> 7 free: `field` takes the entry's cap and the
 *      live pass owns its own. Read the older ports' departures before
 *      implementing a newer study's ask.
 *   2. **Find the invariant and the per-pixel cost collapses.** A curtain's
 *      cross-section is a pure function of the distance from its spine, so a
 *      row is one 1-D profile shifted to wherever the spine is on that row --
 *      a multiply and a lookup per art pixel, and ~380 profile cells a frame
 *      to build all seven. That is what makes the WHOLE BOX cost 1.70 ms
 *      against the study's own 2.1-2.7 for a 275x228 window and 5.9 for the
 *      box, so the engine keeps a contract with no camera in it. Which is not
 *      hypothetical: this place gets a colossus, and the pull-back, on wave
 *      450.
 *   3. **An additive layer has to be held to the ramp.** The curtain adds to
 *      the plate so a star can burn through it -- and a star under a top-rung
 *      ray adds past 255 and clips to a near-white speck, which is a bullet.
 *      Clamping the sum to the place's own brightest tone keeps the star
 *      visible under everything below the top rung and keeps Direction A's own
 *      guarantee: the frame cannot show a colour neither ramp has.
 *   4. **First study in the programme whose star ramp did not have to come
 *      down.** #202b2f / #354247 / #4a595e tops out at luminance 0.338 against
 *      the detector's 0.62, and the sheet says so and shows the working. Four
 *      ports in a row had to fix this; a study that measures its own point
 *      lights can have its palette taken as it stands.
 *   5. **Time the phases; do not reason about them.** The first working
 *      version cost 4.16 ms and every guess about where was wrong. Hoisting
 *      the loop's property loads and flattening the ramps bought 7%. The
 *      patch grid, which looked like the problem, was 0.011 ms. What was left
 *      was two loops that had to be restructured. The same instrument then
 *      found PULSAR spending most of its frame on two `Math.pow` calls per
 *      beam pixel: an interpolated 258-entry table took it from 3.08 ms to
 *      1.45 and the composed frame came out **byte-identical**.
 *   6. A per-cell colour is a weighted mean of the curtain tints over that
 *      cell, so it is read off the field BEFORE the patch scales it. The
 *      study divides after, which drags every curtain under a patch toward
 *      green by the patch's own gain -- a uniform scale cannot change a mean.
 *
 * Measured on the composed 680x540 arena. Strobe over 600 frames at `veil: 6`:
 * peak frame-to-frame change **0.666/255 mean (0.26%)** and **7.73/255 in the
 * worst 68x60 cell (3.0%)**, against the study's own 0.873 and 21.96 -- and
 * through a whole breakup, 0.675 and 7.91, which is the event reading as
 * structure and not as a flash, exactly as the sheet claims. Arena mean 18.55
 * against its 17.4, and against 22.21 for the painter this replaces at the
 * flat scrim: the port is darker than what it replaces. The standing
 * small-bright-feature detector reads **0 at every veil from 0 to 30**; the
 * study's own lower bar reads 3 pale / 3 bright at veil 6 against its 1 / 9,
 * and all three are baked stars with a faint curtain over them at luminance
 * 0.39 -- a third of the player's own fire. Longest bright run 99 px, which is
 * how a ray fails a 40 px test by construction.
 *
 * -------------------------------------------------------------------------
 * LOW MOON ORBIT, quantised branch -- the fourteenth conversion (2026-08-30)
 * -------------------------------------------------------------------------
 * The branch question settled itself here: the reference is flat-tone
 * hard-edged pixel art with no gradient anywhere in it, and the one element
 * that contradicted the glossary line -- a 100 px soft gradient laid across
 * the horizon -- is exactly what cannot survive quantisation. There was no
 * argument to have.
 *
 * Two rules hold the whole place together and neither is drawn. The horizon is
 * a *decision*: `field` asks per art pixel which side of `horizonAt(column)`
 * it is on, so no dither can straddle it and the edge comes out one art pixel
 * wide, #0a0b10 against #9db9c0, luminance 4 against 180. And one camera fixes
 * everything under it -- a pixel `dy` art rows below the line looks at depth
 * `z = f*h/dy`, so a crater of screen half-width `a` is exactly `a*dy/f` tall.
 * That single rule is what makes 350 craters read as one plane receding rather
 * than as ellipses of assorted flatness, and it is why none of their heights
 * were chosen. The light is the same idea: one direction everywhere, so a far
 * rim, a near wall and a boulder's shadow all agree about where the sun is.
 *
 * Crater tones are written on rung *centres*. The Bayer term is +-0.4 of a
 * rung and a boundary is 0.5 away, so the dither cannot move one -- a crater
 * edge is as hard as the horizon, and the dither's texture lives on the open
 * plain, which its two world-space mottles keep deliberately off the centres.
 *
 * Departures from the study, and why:
 *   1. **The depth range follows the box, not the arena.** The study authors
 *      its craters and boulders against the 68 art rows the arena holds; the
 *      box the camera reaches for a colossus is 1.86x deeper, and stopping
 *      where the study stops leaves 239 logical px of bare plain under the
 *      pull-back. The range extends and the count follows the same power law
 *      rather than the same number: `dy = D*u^p` puts `N/(p*D^(1/p))` craters
 *      per row at the horizon, so holding that density while D grows by k
 *      costs `k^(1/p)` of them -- 200 becomes 278. The boulders' count does
 *      not move at all, because their density is areal and the wedge of ground
 *      the deeper limit adds is 0.004% of it.
 *   2. **`flashRamp` is not a contract change.** The study calls its two flash
 *      tones "the one thing the design needs that does not exist" and offers
 *      to add a ramp to the contract. It is already there: `p` is per place
 *      and free-form, the way MOLTEN WORLD carries a `flowRamp` and AURORA a
 *      `dustRamp`. Two hexes in this entry's own `p`, and nothing shared moves.
 *   3. **Which four rows of the noise lattice the horizon reads is the one
 *      free choice, and it is spent on the study's own measured figure.** The
 *      amplitudes are its; `mkNoise` is this file's, so the relief they
 *      produce had to be re-measured rather than carried over. The first set
 *      tried gave 9.2 logical px across the arena's 227 columns and a horizon
 *      that read as a ruled line; the shipped set gives **14.8**, which is the
 *      number the sheet publishes.
 *   4. **`topRung` is 6, not the sheet's 7.** The razor rim and the boulders
 *      are `flat` rungs and bypass the cap either way, so what 7 buys is the
 *      dithered lit crater rims -- and they are small, scattered and bright.
 *      Measured at veil 12: 71 bright regions at cap 7 against 45 at cap 6,
 *      for art nobody reported missing at either.
 *   5. **`veil` is 14 and it is the study's own number.** Its harness applies
 *      `veil * 0.014` and recommends 10, which is alpha 0.14; this engine's
 *      veil is `veil / 100`, so the same wash is 14 here. It arrives at the
 *      same place from the other end too: 14 is where the standing detector
 *      goes to zero, because nothing in the frame is over luminance 0.62 any
 *      more. Its reason is the far plain, not the impacts -- rung 6 is
 *      luminance 145 and enemy cores sit at 150-190, too close for a large
 *      area directly behind them.
 *   6. **The rock's star occlusion is `live`, not `occlude`.** In this engine
 *      `occlude` is a bake-time phase: it decides once how much of a baked
 *      star a place hides forever, which is right for the ground and wrong for
 *      a rock that is over a given star for four frames. `occlude` takes the
 *      ground (and the six art rows over the line, where the plain's own top
 *      rung is brighter than the whole star ramp), and the rock repaints the
 *      handful of stars it covers in rung 0 as it falls. Same picture, and the
 *      only way the rock is ever seen -- it has no trail, no glow and no fire,
 *      because there is no air for any of them.
 *   7. Drift is the shared `sin(t * 0.0016) * DRIFT`, not the study's 2 art px
 *      on a 900-frame period, and it is not quantised to the lattice. Same
 *      call, and the same reason, as places 1-13. Its "still to check" about
 *      drift slack answers itself here: the box already carries 297 logical px
 *      of margin above the arena, against the +-14 the drift uses.
 *   8. The harness's manual trigger is not ported, exactly as its notes ask:
 *      it pushes an impact at `f + 92`, which is not a function of the frame
 *      counter, and the whole schedule's value is that it is.
 *
 * Measured here on the composed 680x540 arena at frame 1500, by the standing
 * small-bright-feature detector (a connected run at luminance >= 0.62, under
 * 40 px on both axes, on a 4 px surround under 0.30): **0 features at veil 14
 * and above**, from 34 at veil 0 -- and **0 at the flash as well**, which is
 * the study's own claim tested where it matters. The flash is the brightest
 * thing the place ever paints (0.717 against the frame's 0.609) and it is
 * still not a feature, because it lands on lit ground and the test is as much
 * about the surround as the blob. Linear-light arena mean 0.049 and p95 0.208,
 * which puts it between RINGED GIANT (0.040 / 0.133) and GAS GIANT DESCENT
 * (0.273 / 0.285) -- it is a lit ground plane filling two fifths of the frame,
 * so it belongs at that end. Live cost **4 to 25 rasterising calls a frame,
 * mean 9.1** over 600 frames, against the sheet's own 4-25.
 *
 * One number the study could not have: the schedule puts 60% of its impacts
 * below the arena floor, where only the colossus camera reaches them. That is
 * not a defect -- the same 60% falls out of its own geometry, because the box
 * has the same proportions -- but it makes "one impact every 420 frames" read
 * as less than it is. Measured over 4200 frames, **81.6% of frames have some
 * impact art inside the arena** and 18.9% have ejecta in flight, because a
 * scar outlives the rock that made it by 2400 frames. See
 * `tools/neon_strike_bench/probe_moon.mjs`.
 *
 * -------------------------------------------------------------------------
 * PLANETARY NEBULA -- place 28, and the first one added (2026-08-30)
 * -------------------------------------------------------------------------
 * Every port before this one replaced a painter under an entry that already
 * existed. This one is a new entry: the catalogue goes from 27 places to 28,
 * the route from 81 waves to 84, and the soft EMERALD NEBULA it was studied
 * against stays exactly where it is. Appended, it takes waves 82-84 -- so the
 * study's own closing line about the composition, "that is the last sky in the
 * game: a ring, a hull, and one flash going out through it", is literally true
 * of where it landed rather than aspirational. Nothing else in the file changes shape --
 * `backgroundForWave` is already `% BACKGROUNDS.length` and the glossary
 * already counts the array rather than a constant.
 *
 * The place is one object seen from outside, which the catalogue did not have.
 * Every other cloud in it is weather you fly through; this one has a centre
 * you can point at, an edge where it stops, and a flash that crosses it on a
 * clock. It is radial rather than layered, and that is its own function rather
 * than a parameterisation of `gasDensity`: parameterising the layered one
 * would have made this place a configuration of the violet nebula, and it
 * would have put the violet nebula's measured output at risk for nothing.
 * What is shared is the lattice, the dither, the ramp machinery and the star
 * system -- and VIOLET NEBULA is byte-identical, arena and thumbnail, before
 * and after.
 *
 * Departures from the study, and why:
 *   1. **`field` returns a rung, not a value.** The study's own first
 *      departure is that `field` carries a second channel so `live` can
 *      band-limit the echo without recomputing five noises. Taken further
 *      here: `field` fills four per-cell tables *and* does its own quantise,
 *      so the plate and the tables are one thing rather than two that have to
 *      agree. `base` and `gas` are bytes on a fixed scale for the same reason
 *      -- a cell the echo leaves alone is then repainted with exactly the
 *      colour already under it, and the annulus cannot show as a seam.
 *   2. **The live pass walks a rect, not the lattice.** The map from screen to
 *      shell space is a rotation and a squash, so it never expands a distance:
 *      a cell whose shell radius is R is at most R from the centre on screen.
 *      One bound covers the whole annulus and shrinks to the cavity for the
 *      277 dark frames of the cycle. Measured: **33% of the lattice visited a
 *      frame on average and 7 rasterising calls**, flat, against the study's
 *      own fallback of baking eight echo phases at eight times the memory.
 *   3. **The star ramp comes down two steps.** Its hue was chosen for the
 *      right reason -- a warm star reads as a bullet -- but its top rung is
 *      #eafcff at luminance 0.97, and 24 of the 190 baked stars came out as
 *      3 px near-white blocks on black sky, which is the other half of what a
 *      bullet looks like. Every rung under the detector's 0.62 instead: **28
 *      small bright features to 0**, at every veil from 0 to 30. Fifth star
 *      ramp in the programme to need this.
 *   4. **Rung 6 is #5cdc9c and not the study's #7bffb0**, and this is the one
 *      finding worth carrying forward. The study measures its bright-feature
 *      count at frame 1500, where the echo is between shells -- so it never
 *      measured the event its place is named for. When the front crosses the
 *      main shell it promotes a long arc of the rim to the top gas rung at
 *      once, and #7bffb0 is linear luminance 0.789 against an enemy core's
 *      0.547. Measured over a whole 720-frame cycle, the share of the arena
 *      brighter than an enemy core **peaked at 9.08%**, against 0.00% for
 *      every other place in the catalogue and 1.58% for LAVA WORLD's flow,
 *      which is the hottest thing in it. The echo's own amplitude is not the
 *      lever: 0.15 instead of the study's 0.45 still peaks at 3.49%, because
 *      the ramp's last step is a *leap* (0.331 to 0.789) rather than a step,
 *      so anything that reaches rung 6 at all lands there. One hex fixes it.
 *      #5cdc9c is 0.559 -- the same luminance AURORA's own top used rung
 *      already ships at -- and it takes the quiet field and the crossing both
 *      to **0.00%** while leaving the ring its brightest arc. The lesson is
 *      the general one: **measure a place at the phase of its own event, not
 *      at frame 1500**, and check the ramp's spacing before blaming the effect
 *      that rides it.
 *   5. Rung 7 goes unspent. The sheet reserves #c8fff0 for the central source
 *      "by budget, not by ramp cap", but its own painter caps every cell at 6
 *      and never reaches it -- and a 9 px block of luminance 0.95 is precisely
 *      the small bright feature the measurement forbids. It stays in the ramp
 *      and stays unreachable, which is what `topRung` is for.
 *   6. No diffraction crosses on the stars. The bake draws a point light as
 *      one or two art pixels; a four-armed cross is four more small bright
 *      islands per star, which is the thing the count exists to prevent.
 *   7. The twinkle is this file's baseline -- a dozen stars inside the arena
 *      on `twinkleList` -- rather than scintillating all 190. The study's own
 *      note says "the existing baseline", and the existing baseline is that.
 *      It costs the one property the study claims for the whole place: the
 *      twinkle's phase is stepped state, so `backdropThumb` steps this place
 *      to 1500 rather than jumping there. Everything else in it, the echo
 *      included, is a pure function of the clock, and stepping is what the
 *      thumbnail already does for every place that keeps any state at all.
 *   8. Drift is the shared `sin(t * 0.0016) * DRIFT`, not the study's 14 px on
 *      an 1800-frame period. Same call, and the same reason, as places 1-14.
 *   9. **The veil's upper bound is not reproduced.** The study says past 14
 *      the dark columns lose their read against the bank. Measured in linear
 *      light against the gas beside them, the columns hold 6.1:1 at veil 0,
 *      5.6:1 at the shipped 9, 5.4:1 at 14 and still 4.5:1 at 30 -- the
 *      silhouettes are `landRamp` and never enter the dither, so a wash that
 *      dims both cannot close a ratio. `veil: 9` is kept as the study's own
 *      number, but it is taste here rather than a measurement: the detector
 *      reads 0 at every veil from 0 to 30 once rung 6 comes down.
 *
 * Measured on the composed 680x540 arena at `veil: 9`, sampled every 60 frames
 * across a full echo cycle: **0 small bright features at every phase**. Linear
 * arena mean 0.032 and p95 0.138 in the quiet, rising to 0.062 and 0.456 for
 * the ~57 frames the front is over the main shell -- which is the event doing
 * its job while staying under the 0.547 an enemy core sits at. Against the
 * places it sits among: VIOLET NEBULA 0.029 / 0.056, ICE WORLD 0.032 / 0.060,
 * RINGED GIANT 0.040 / 0.133, OCEAN WORLD 0.055 / 0.158. The 53 bright regions
 * it does hold are the rim and the filament, the longest 165 px across, which
 * is how an arc fails a 40 px test by construction. See
 * `tools/neon_strike_bench/probe_shell.mjs`.
 *
 * -------------------------------------------------------------------------
 * BINARY SUNS, quantised branch -- the fifteenth conversion (2026-08-31)
 * -------------------------------------------------------------------------
 * The first port whose central question is a colour, and the first where
 * taking the study's recommendation costs the entry a sentence.
 *
 * The companion was `#ff6b8a`, which is not a colour like the ones the enemies
 * fire in -- it is literally `BULLET_COLS[0]` -- painted as a soft radial blob
 * 40 px across, sitting still on black while real cores crossed it. It is
 * blue-white now. The physics agrees (mass transfer runs from the evolved,
 * swollen, cool star to the compact hot one, so a gold giant with a blue-white
 * companion is the pairing that produces the stream the place is named for)
 * and so does the composition (a warm half and a cool half meeting at the
 * stream is a structure two warm blobs cannot have). The cost is real, the
 * study states it plainly, and it is worth restating: at 130 px a red blob
 * reads as a second sun and a blue-white point reads as a star and a
 * spotlight, so a place called BINARY SUNS gives up a little of its own name.
 * The `desc` is rewritten in the same entry as the art, which is the only
 * honest way to ship it.
 *
 * The other half of the defect was not colour at all. The gold giant's centre
 * sat 54 px **above the top edge of the arena**, so the larger of the two
 * stars was a clipped sliver and the "bridge" was a 68 px gradient bar. Both
 * stars are inside the frame now, at a size that survives the 130 px card.
 *
 * The sheet is ONE shared plane centred between the stars rather than a ring
 * around one of them, with the radius measured after the squash so it reads as
 * a tilted sheet running off every edge of the box. Which of the two ramps a
 * pixel takes is `d_blue^2 / (d_blue^2 + d_gold^2)`, and that changeover is
 * **dithered rather than drawn** -- a second Bayer tap two rows and one column
 * away, scaled by the local value -- because the two ramps otherwise meet on a
 * hard vertical seam down the middle of the frame.
 *
 * Departures from the study, and why:
 *   1. **The bake covers the box, not the arena.** The study bakes 227x188 art
 *      pixels -- the arena plus its own drift padding -- and every previous
 *      conversion has had to do the same sum: the camera pulls back for a
 *      colossus, so a place that stops at the arena edge stops being a place.
 *   2. **`live` re-quantises only the cells that can ever change.** The study
 *      walks its whole arena every frame, which is the honest reading of "the
 *      subject is material in motion". It does not have to: the four periodic
 *      terms are independent sines, so the extremes of each are known, and a
 *      cell whose rung AND ramp are the same at every corner of that box can
 *      never move. `binaryActive` decides it once, at bake time, from a
 *      superset of the states the place actually visits -- so it can cost a
 *      few cells that never move and can never miss one that does. Measured:
 *      **47,088 of 184,688 art pixels, 25.5%**, and two rasterising calls a
 *      frame (one upload over a constant dirty rect, one blit).
 *   3. **The ten scalars per art pixel are packed to that list**, not kept per
 *      cell. Ten Float32Arrays over the box would be 7.4 MB for a place that
 *      moves in a quarter of it; the packed form is 1.7 MB. `occlude` is not
 *      tabled at all -- it re-samples, which is 520 evaluations against the
 *      184,688 the bake already did, and tabling it would cost more memory
 *      than the entire live pass.
 *   4. **`hard` exists here only because it runs after the point lights.** A
 *      baked star standing on a cell the live pass repaints would be erased
 *      every frame, so the 199 star pixels that land on active cells are
 *      copied into the overlay and put back on top of it. That is the phase's
 *      one job in this place, and it is the first time the ordering inside
 *      `_bakeField` -- field, then stars, then `hard` -- has been load-bearing.
 *   5. **Sixth star ramp to come down.** #6d7d99 / #a9bcd6 / #e8f1ff measures
 *      0.49 / 0.73 / 0.94 against the detector's 0.62, and about 115 of the
 *      520 land inside the arena, so the sky was 129 near-white blocks of 3-6
 *      px on black. Every rung under the threshold instead: **129 features to
 *      0**, at every veil from 0 to 30. Blacking the ramp out entirely also
 *      reads 0, which is the control that says none of the art was ever one.
 *   6. **Two caps, one `topRung`.** The gold ramp stops at 6 -- a 9 px block of
 *      its rung 7 measures mean R over 1.12x mean B on a dark surround, the
 *      same failure COMET TRAIL's core took -- and the cool ramp keeps all
 *      eight, being nowhere near the palette the enemies fire in. One entry
 *      field cannot hold two ramps, so `topRung` is the cool cap and the gold
 *      one is applied per sample, which the contract already allows.
 *   7. `veil: 13` is the study's own 8: its harness applies `veil / 60` and
 *      this engine's is `veil / 100`, so the same wash is 13 here. Second time
 *      a study's veil has needed only that conversion.
 *   8. Drift is the shared `sin(t * 0.0016) * DRIFT`, not the study's 9 px on
 *      a 1795-frame sine snapped to whole art rows. Same call, and the same
 *      reason, as places 1-14 -- and it takes the study's row-offset indexing
 *      with it, because the engine translates the plate and the live layer
 *      together and the plane is rigid without anyone arranging it.
 *   9. Where the sheet's own two halves disagree, section 2 wins over the port
 *      notes' summary: squash 0.34 and tilt -0.22 rather than 0.30 and -0.20,
 *      seven arms at pitch 5.5 rather than three at 2.4, control offset 0.22
 *      rather than 0.30. Section 2 agrees with the code it shipped, and the
 *      code is what was measured.
 *
 * Measured here on the composed 680x540 arena at frame 1500. The companion
 * decision, on the study's own warm metric (9 px blocks whose mean R exceeds
 * 1.12x their mean B, clustered, under 40 px, on a dark surround): **0 warm
 * features either way**, so the number that discriminates is the warm area --
 * red 11.3% against blue-white 6.4% unveiled, 7.9% against 4.6% at the
 * shipped veil. The study predicted 10.9 / 6.2 and 7.4 / 4.5 on its own
 * canvas, which is as close as two different arenas and two different veil
 * formulas get. The standing detector reads **0 at every veil from 0 to 30**.
 * Linear arena mean 0.0158, p95 0.0463, p99 0.145, and **0.00% of the arena
 * brighter than an enemy core** -- which makes this, after the port, the
 * darkest place in the catalogue: VIOLET NEBULA is 0.029, ICE WORLD 0.032,
 * GAS GIANT DESCENT 0.273. Peak frame-to-frame change in arena mean over 640
 * frames is 0.000088 in linear light, 0.02% of an enemy core, so the sheet's
 * "no eclipse" claim holds: nothing crosses anything and there is no
 * full-frame step. Periods land exactly where it says -- 90 frames for the arm
 * pattern, 628 for a full turn of the sheet, 167 for the stream's flow.
 * See `tools/neon_strike_bench/probe_binary.mjs`.
 *
 * One finding worth carrying, because it will recur: **the conversion makes
 * one of the study's own numbers go the wrong way, and that is correct.** The
 * painter this replaces measures 0% warm area, better than anything the port
 * can offer -- because half of what the place is called after was off the top
 * of the screen and the rest was a dim additive gradient. A metric that
 * rewards an absent composition is measuring the wrong thing. The feature
 * count is what tracks the hazard, it is 0 on both, and the place is *darker*
 * than what it replaces on the number that matters: arena mean 0.0158 against
 * the old painter's 0.0248.
 *
 * -------------------------------------------------------------------------
 * ORBITAL STATION, Direction A -- the sixteenth conversion (2026-08-31)
 * -------------------------------------------------------------------------
 * The first place in the catalogue whose **subject is not baked at all**.
 * Everything else bakes because everything hard-edged in it is a function of
 * position; a ring that turns is not, so `field` carries only the dust and the
 * whole station is rasterised into an art-resolution overlay every frame.
 *
 * It also fixes the two things the old entry got wrong about itself. Its own
 * description said the ring turns, and nothing in the painter turned: it was a
 * static wheel with 26 additively-composited 3 px pale points blinking around
 * the rim -- the size, the colour and the surround of a bullet, and the only
 * motion in the place. Now the ring turns, the hub is despun, and nothing
 * blinks at all.
 *
 * Departures from the study, and why:
 *   1. **Star occlusion is paint order, and costs nothing.** The study keeps a
 *      box-sized composite surface and re-blits the baked plane into it every
 *      frame so the station can cover stars, and lists that as a departure
 *      with a memory cost. `Backdrop.draw` already blits the plate and then
 *      calls `live`, so an opaque overlay over it IS the occlusion. Fourth
 *      time an older port's shape has answered a newer study's ask for free.
 *   2. **The dirty rectangle is fixed**, and there is no union with the last
 *      frame's. COMET TRAIL recomputes its bounds every frame because its
 *      subject travels; the ring's bounds do not move, so 124x66 art px of the
 *      476x388 box -- 4.4% -- is cleared, painted and uploaded, forever.
 *   3. **Two canvas calls, not 488.** The study fills each run of plating with
 *      `fillRect` on the composite. Every part of this station is an
 *      axis-aligned run, so they are written straight into the ImageData: one
 *      `putImageData` over the fixed rect and one blit, which with the plate's
 *      own blit is 3 rasterising calls a frame against the 26 the old painter
 *      spent and the 488 the study costed itself at.
 *   4. **`occlude` carries INNER SYSTEM's rule instead.** The study leaves it
 *      returning 1 everywhere. With the silhouette handled by paint order the
 *      phase is free for the other reason a star gets dropped: the plate
 *      behind it is already lit, which here is the dust bias the station sits
 *      in.
 *   5. **Every point light came down under the detector's threshold**, which
 *      is the one real change to the study's art. Its five lights are
 *      luminance 0.79 / 0.84 / 0.67 / 0.87 / 0.64 against the standing
 *      detector's 0.62, and its defence of them is the surround clause -- they
 *      are embedded in an opaque silhouette rather than floating on black.
 *      That defence is real and it is also **a cliff**: near plating measures
 *      0.337 against the surround test's 0.30, so any veil over about 11%
 *      pushes it under and every window in the place becomes a small bright
 *      feature at once. Measured with the study's own colours: 18 features at
 *      veil 0, 17 at veil 10 and **36 at veil 15**, at the worst phase of the
 *      turn. Scaling each light to just under 0.62 on its own hue reads **0 at
 *      every veil from 0 to 30 and at every phase**, and the defence stops
 *      depending on a number set elsewhere. The windows still read as lit --
 *      1.8:1 over the plating they sit in, and warm against blue-grey.
 *   6. **Far-arc windows are dimmer than near-arc ones.** A window seen across
 *      the ring is dimmer, which is depth; it is also the only way those
 *      windows clear the bar, because far plating is two rungs down at 0.170
 *      and cannot embed a light the way near plating can.
 *   7. **Window pitch is the sheet's 12 logical px, not the 15 its code
 *      shipped.** At 15 a 45 px module carries two portholes where the sheet's
 *      prose promises a run of 3-7; at 12 the arcs carry three and the place
 *      reads as rows. Where a sheet and its own code disagree, the tie-break
 *      is what the place is for.
 *   8. **The star ramp came down**, the seventh of nine studies to need it.
 *      Its top rung `#dfe9f8` is luminance 0.91 against the detector's 0.62:
 *      114 features at veil 0 with its ramp, 0 with every rung under the
 *      threshold. Blacking the ramp out entirely also reads 0, which is the
 *      control that says none of the art was ever one.
 *   9. **Drift is the shared `sin(t * 0.0016) * DRIFT`**, not the study's 9 px
 *      on an 1800-frame sine. Same call, and the same reason, as places 1-15:
 *      the engine translates the plate and the live layer together, so the
 *      plane is rigid without the study's blit-offset machinery.
 *  10. **The noise is `mkNoise`**, not the study's own two bilinear lattices,
 *      which is the "fold it into the shared generator" every port note asks
 *      for. Its 24x20 cell size is kept as the sample rate.
 *
 * The veil is **10**, and it is the only number here the study's own reasoning
 * does not survive. It asks for 8 on a `v/54.5` scale, which converts to 15 --
 * and 15 is on the wrong side of the cliff in departure 5, so the conversion
 * cannot be taken on its own. Priced both ways: over the whole arena this is
 * the second darkest place in the catalogue after DEEP SPACE (linear mean
 * 0.0064, p95 0.0122 against a 4:1 ceiling of 0.098) and clears every bar at
 * veil 0. What binds is the station's own quadrant, where linear p95 is 0.0954
 * at veil 0 -- 2.6% under that same ceiling, which is no margin at all. Veil
 * 10 puts it at 0.0781, 20% under, and costs the windows 0.06 of luminance.
 *
 * Measured on the composed 680x540 arena, over a whole 1440-frame revolution
 * rather than at frame 1500, because this place's event IS the turn: **0 small
 * bright features at every veil from 0 to 30 and every phase**, 0 by the
 * study's own pale test (L > 140, saturation under 0.40), and **0.00% of the
 * arena brighter than an enemy core**. Peak frame-to-frame change in arena
 * mean is 0.000204 in linear light, 0.037% of an enemy core. 3 rasterising
 * calls a frame against the old painter's 26. Rotation lands where the sheet
 * says: 0.25 degrees a frame, and a module clears its own width in 60.
 * See `tools/neon_strike_bench/probe_station.mjs`.
 *
 * One thing the study flagged for the owner rather than settling, and the
 * answer it got: the description ends *Somebody out here is still home*, and
 * `STORY.md` says the VESTA is the only ark still flying. Those are not in
 * conflict -- this is a station of one of the two civilisations, not an ark,
 * and both of them are very much alive and shooting at you. So it is drawn as
 * a place that is genuinely inhabited: 18 of 24 modules lit, an intact craft
 * docked at the hub, another leaving. The bitterness is the game's, not the
 * art's -- the lights are on, somebody is home, and they fire on you anyway.
 *
 * -------------------------------------------------------------------------
 * SUPERNOVA, Direction A (2026-08-31)
 * -------------------------------------------------------------------------
 * The place the file's own veil comment named as one of the offenders. It was
 * three concentric rings expanding at 900 px a cycle out of a flickering core,
 * in the enemy-fire hues -- an entry whose `desc` ended by apologising for it.
 * The study replaces the reading rather than recolouring it: a shell thrown
 * outward and lopsided, its centre just outside the arena's lower-left corner,
 * so no complete arc is ever in the frame. 34 filament strands, 12 spokes and
 * an edge-on sheet layer are decided per art pixel as a HARD THRESHOLD -- open
 * arcs, no two sharing a centre, ragged at every scale down to the art pixel,
 * and with zero radial rate. The only smooth arc with a radial velocity left
 * on screen is the boss's attack, which is what makes the two unconfusable.
 *
 * Nothing moves. The one live term is a light echo: a Gaussian front sliding
 * outward along the shock at 0.45 px a frame, lifting the DUST it crosses by a
 * quarter of the ramp and touching neither the filaments nor the stars. What
 * travels is which dust is lit. Two fronts half a period apart so the layer is
 * never idle, both pure in the frame counter, so there is no `update`.
 *
 * The palette went cool on the study's recommendation, checked here against
 * the thing it could not check: the neighbours. DESERT WORLD (#e8c07a) is in
 * front, CRYSTAL FIELD after it and ECLIPSE and GALACTIC CORE three places
 * later, so waves 61-78 do not flatten into one teal stretch. The tint moves
 * with it, #ff8f5e to #3fb9a6.
 *
 * Departures from the study, and why:
 *   1. `live` writes an OVERLAY, not the baked plate. The study's own port
 *      note names re-quantising the plate in place as its departure; here the
 *      plate stays the unlit truth and the lane is cleared and repainted, so a
 *      pixel the front has left cannot keep a rung it picked up -- which the
 *      in-place version can, for any pixel that flips within the envelope's
 *      tail and is then never revisited. Costs one `drawImage` a frame; the
 *      place runs at 2 rasterising calls against the old painter's 21.
 *   2. Three numbers RE-SOLVED against this file's noise generator, which is
 *      not the study's. `SN_DUST.span` (0.30 -> 0.21): the study's cut needs
 *      the field to reach 0.86 and this one tops out at 0.842, so the dust
 *      plateau the sheet describes was unreachable and the haze never left
 *      rung 0. `SN_SIL` (0.40/0.52 -> 0.30/0.50): the top rung reached 0.6% of
 *      the arena against the "few per cent" the sheet measures. `SN_STAR_A`
 *      (the shared 0.24 -> 0.06): `_bakeField` buckets a star by
 *      `round(a * 3) / 3`, so 0.24 puts half the field on the top rung where
 *      the study's is 12%.
 *   3. The star ramp's top is #8fa0a6, not the study's #dfe6ff. That one is
 *      luminance 220 and it FAILS this catalogue's own small-bright-feature
 *      detector -- 13 of them in the arena, which is 13 more than any
 *      converted place is allowed. The study only ever tested its stars for
 *      hue. Every other place's top star sits at 152-165; this is 157.
 *   4. The drift is not quantised to the lattice. The study asks for the
 *      offset to be rounded so the dither is never resampled; the engine
 *      drifts all 28 places together on one sine and the other 22 quantised
 *      places already live with it, so a per-place exception here would be a
 *      bigger defect than the one it fixes. Same reasoning as departure 3 of
 *      the places 1-5 study.
 *   5. The sheet's own published cycle -- 1780 frames, a 1.8-unit swing in
 *      arena mean -- is not reproducible from the constants it ships: at rate
 *      0.45 and pad 2.2 x 240 the period cannot fall below 2347 whatever the
 *      dust does. Sixth study whose headline its own code rejects. The period
 *      here is derived the way its code derives it (3700 frames, 61 s) and the
 *      place is placed against the catalogue instead, which is measurable.
 *   6. Prose against code, twice more: the sheet says 14 spokes and a 200 px
 *      echo envelope, its code ships 12 and 240. The code is what its measured
 *      figures were taken on, so the code wins.
 *
 * Measured on the composed 680x540 arena at frame 1500, and over a whole
 * 3700-frame echo cycle: **0 small bright features** at veil 0 and at veil 11,
 * **0.000% of the arena warm above luminance 140 and 0.000% above 40** --
 * which is the palette result, against RINGED GIANT's 31.8% and BINARY SUNS'
 * 12.0% on the same meter. Arena mean 24.3 unveiled, 22.0 veiled, which puts
 * the place between INNER SYSTEM and MOLTEN WORLD rather than at either end.
 * Frame-to-frame change in arena mean luminance: 0.052 of 255 on average and
 * 0.104 at peak, i.e. 0.04% a frame, against a place that used to flicker a
 * 380 px core at 3.9 Hz. The live pass visits 45k art pixels a frame out of
 * 180k and repaints far fewer. See `tools/neon_strike_bench/probe_supernova.mjs`
 * and `probe_family.mjs`, the latter being the whole catalogue on one meter.
 *
 * -------------------------------------------------------------------------
 * ECLIPSE, Direction A (2026-08-31)
 * -------------------------------------------------------------------------
 * The last user of the shared soft `planet` painter, so that painter, its
 * `surface()` helper and `sun()` are deleted with it -- nothing else called
 * any of the three.
 *
 * The study's answer to "which moment" is that they are the same moment at
 * different times, so the place PLAYS the eclipse instead of freezing it: the
 * star crosses behind the disc over one pass, putting first contact, the
 * diamond ring, totality, the second diamond ring and last contact in it.
 * Totality is the middle 56% of the pass -- solved numerically from the chord
 * here, not taken on trust, and it comes out at exactly the sheet's 0.56.
 *
 * Nothing bakes. Every rung the place lights is a function of where the star
 * is, and past 1.95 R the haze is under a thousandth of one, so the plate is
 * flat rung 0 plus the star field and the whole of the art is one annulus
 * re-baked into an overlay every tenth frame. Inside the disc: nothing, and
 * `occlude` returns 1 across it -- a silhouette that let stars through would
 * read as glass.
 *
 * Departures from the study, and why:
 *   1. The pass starts at p = 0.60, not at first contact. The study assumes a
 *      free-running frame counter; here `bd.t` is zero every time the block
 *      begins, and three waves is 1800-3000 frames of a 10800 frame pass -- so
 *      starting at 0 would have shown the player the entry partial, every
 *      time, and never the totality the glossary line describes. 0.60 opens
 *      inside totality, brings the second diamond ring in at frame 1944 and
 *      the exit partial after it, and puts `backdropThumb`'s frame 1500 in
 *      late totality, which is what the catalogue card should show.
 *   2. Over the ring's solid bands the streamer takes the BRIGHTER of the two
 *      rather than adding to it. Added -- which is what the study ships -- it
 *      puts a per-cell brightness variation on exactly the bands that are
 *      snapped to exact rungs to keep the dither off them, and just inside the
 *      contacts, where a streamer is still short enough to sit entirely inside
 *      the ring, that variation breaks the bright arc into cell-sized chips:
 *      four small bright features measured at p = 0.235. The study's own
 *      thirteen sample points step over that window.
 *   3. The star field's top rung is #989dae, not the study's #dfe6ff. Same
 *      call as SUPERNOVA's: that one is luminance 230 and fails this
 *      catalogue's detector. The study only ever tested its stars for hue --
 *      correctly, since a warm point light here would be the eclipsed star
 *      itself, which is behind the disc.
 *   4. The drift is not quantised to the lattice, for the same reason as
 *      SUPERNOVA's departure 4: one sine drifts all 28 places together.
 *   5. `live` re-bakes on `floor(t / 10) * 10` rather than on `f % 10 === 0`.
 *      The engine's clock is scaled -- slow motion, hitstop -- so `bd.t` is
 *      not an integer, and a modulo test would almost never fire. Quantising
 *      the PHASE instead keeps what is on screen a pure function of the
 *      counter, which is what two clients in a co-op match need.
 *   6. The glossary line gains the study's own optional clause, "once it lines
 *      up", because the transit ships: the entry now shows a partial phase 44%
 *      of the time and the line has to cover it.
 *
 * Measured on the composed 680x540 arena at thirteen points across the pass:
 * **0 small bright features at ten of them and 1 at the other three**, and
 * that one is the brightest 90 px of the limb arc curving inside a 40 px box
 * -- the subject of the place, not a speck. **0.000% of the arena warm above
 * luminance 140 at every phase.** Arena mean 12.5 of 255 at totality against
 * the sheet's 11.9, which makes this the darkest place in the catalogue after
 * SHIP GRAVEYARD, CRYSTAL FIELD and DEEP SPACE -- and is why the veil is 0.
 * 2 rasterising calls a frame, on a re-bake frame and between them alike.
 * See `tools/neon_strike_bench/probe_eclipse.mjs`.
 *
 * -------------------------------------------------------------------------
 * WORMHOLE, Direction A (2026-08-31)
 * -------------------------------------------------------------------------
 * The place that measured WORST on the small-bright-feature detector of all
 * 28: sixteen. It was concentric rings rushing outward from a bright centre at
 * 5.05 features a second -- ripples on a pond, in the shape and the cadence of
 * the boss's shockwave.
 *
 * The study inverts all three things that make a ring on screen read as
 * something that will hit you. The mouth is a PLANE at a squash, mapped per
 * art pixel, and depth is the log of the plane radius -- so equal steps in
 * depth are equal steps in `u = ln r` and the perspective compression is one
 * constant, 0.46 in u, a radius ratio of 1.58 a turn. The features move INWARD
 * and shrink, their spacing tightens ahead of them, and they arrive at 1.2 a
 * second onto a 26 px region instead of sweeping outward across 680 px of play
 * field. Nothing pulses: the light is one continuous crest sliding along the
 * rib phase, so every art pixel is always somewhere on the crest and the eye
 * sees a spiral winding into the core rather than a ring arriving.
 *
 * Departures from the study, and why:
 *   1. The walls stop at rung 5, not the study's 6. Rung 6 is #9ad6f2 at
 *      luminance 203, brighter than anything else this catalogue paints on a
 *      dark field, and the dither scatters single top-rung art pixels through
 *      the throat -- three of them measured as small bright features, and 3 px
 *      of pale cyan on dark is a bullet. Cyan and white belong to the core
 *      now, which is also what the study's own palette note says the ramp is
 *      for: violet at the mouth's rim, cold and then hot toward the middle.
 *      The study measured this place for hue and for frame-to-frame change,
 *      both of which it passes, and never for luminance on a dark surround.
 *   2. The star field's top rung is #979ead, not #dfe9ff -- luminance 232, and
 *      the same call as SUPERNOVA's and ECLIPSE's.
 *   3. Its departure 3 does not exist here. It asks for a per-zoom re-bake
 *      because lambda, the core radius and the vignette knee are functions of
 *      the camera; in this file the painter draws over the whole box the
 *      camera can REACH, once, in logical coordinates, and the colossus camera
 *      just crops less of it. So there is no invalidation and no cache. What
 *      is inherited instead is the cost: the ribs are a third tighter on
 *      screen while the camera is pulled back, the same as every other place.
 *   4. Its departure 2 shrinks. Three baked scalars per art pixel over the
 *      whole box would be 2.2 MB; the vignette cannot reach a rung past 2.42
 *      sigmas, so the live list is the ELLIPSE and not the box -- 79k art
 *      pixels of 185k -- and the phases are baked already folded (`vg * wall`,
 *      the striation phase, the rib phase) so it is five arrays over 79k, 1.6
 *      MB, and the frame does two table lookups and eight flops on each.
 *   5. The drift is not quantised to the lattice. Same reason as the other two
 *      ports in this pass.
 *
 * Measured on the composed 680x540 arena at veil 6: **0 small bright features,
 * down from 16.** Mean frame-to-frame luminance change 0.156 of 100 against
 * the sheet's 0.19 and peak 0.227 against its 0.28, both on the arena with the
 * scrim on -- the sheet's own numbers, reproduced. Peak contrast 86.1 against
 * its 91.6, the difference being departure 1. Arena mean 17.1 of 255. 2
 * rasterising calls a frame against the old painter's 14 stroked ellipses and
 * their transforms, and the live pass touches a fixed 404 x 250 art-pixel
 * rectangle. See `tools/neon_strike_bench/probe_wormhole.mjs`.
 *
 * One thing worth an owner's eye rather than a meter: GALACTIC CORE is the
 * entry immediately before this one, and a two-armed spiral crowding toward a
 * bright middle is not a thousand miles from a galaxy seen face on. They are
 * far apart in hue (gold against violet), in edge (soft blobs against hard
 * quantised ribs) and in structure (arms spreading out against ribs crowding
 * in), and the two `desc` lines say different things -- but waves 76-81 do put
 * them back to back.
 *
 */

// The static layer is soft gradient art, so half resolution is free quality.
const LAYER_SCALE = 0.5;
// Slow parallax breathing applied to the static layer, in logical pixels. The
// baked box is this much taller on each side so the edge never shows.
const DRIFT = 14;
// Veil between the backdrop and the play field, for the places still painted
// the old way. SEVEN of the 28 are still on it -- it was twelve before
// SUPERNOVA, ECLIPSE and WORMHOLE were converted, and those three took the
// worst of the offenders with them -- and the ones left (graveyard, crystal,
// galaxy...) paint in the same warm reds and the same 1-3 px motes the enemy
// bullets use, adding up in `lighter` until a bullet is indistinguishable from
// scenery. One flat number fixes those and flattens the
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

/* PULSAR. One rotation, in frames. Not a tuning: the glossary line promises a
 * beam past the arena every couple of seconds, the two beams are antipodal, so
 * 240 frames is the number that makes the sentence true. The painter this
 * replaces turned at 0.011 rad/frame, which is 4.8 s between crossings. */
const PULSAR_PERIOD = 240;
const PULSAR_OMEGA = 6.2832 / PULSAR_PERIOD;
// The star, as a fraction of the arena: centred, and 12% of the arena's height
// ABOVE its top edge. It is outside the play field, which is the whole reason
// the pulse has to be legible through structure -- from inside the arena you
// never see the core, only what it is doing.
const PULSAR_STAR = [0.5, -0.12];
// The rotation axis, as two angles: leaning right of vertical in the sky plane,
// and inclined out of it toward the viewer. The inclination opens the torus
// into an ellipse instead of a bar and fixes the diagonal the composition
// hangs on; it is also half of the sweep condition below.
const PULSAR_PSI = 28 * (Math.PI / 180);
const PULSAR_THETA = 34 * (Math.PI / 180);
/**
 * How far the magnetic axis leans off the rotation axis. The one number in the
 * place that had to be changed rather than ported, and it is the difference
 * between a pulsar and a lamp on a stick.
 *
 * The beam direction traces a cone of half-angle alpha about the rotation
 * axis, so a beam sweeps past a given line of sight only if that cone reaches
 * it -- and the camera's line of sight sits `90 - PULSAR_THETA` = 56 degrees
 * off the axis. The study shipped 22 degrees on a slider that stops at 45, so
 * in its own composition NO setting sweeps: the projected beam wobbles by
 * +-29 degrees about a fixed diagonal it never leaves, most of the arena is
 * never crossed at all, and the pulse term saturates into a 65%-duty plateau.
 * Seven separate claims in the sheet -- a crossing every 120 frames, the 27
 * frame spike, `sqrt(1 - s^2)` doing real work, light leaving the arena for
 * the core -- are all false at 22 and all true together above 56.
 *
 * 72 is measured rather than picked: see `probe_pulsar.mjs`, which sweeps it.
 * It is the largest value that still gives the pulse its full amplitude --
 * the term is normalised by `sin alpha` rather than by its own reach, so past
 * 73 degrees the spike stops reaching 1 and by 90 it peaks at 0.11 -- and
 * being the largest is what buys the sharpest spike (31 frames, against the
 * sheet's own "about 27") and the most crossings. At 72 every pixel of the
 * arena is swept, a point is crossed 1.31 times a rotation, and it spends 9.5
 * frames of 240 under a beam: mostly nothing, then a brief arrival.
 *
 * A point is crossed 1.31 times rather than twice because the two crossings
 * are not alike -- half a rotation apart, one beam is broadside and long and
 * the other is turned toward the camera, foreshortened and short. That is the
 * sheet's own mechanism working, not a shortfall: what the near beam stops
 * spending on the arena is what lands on the core.
 */
const PULSAR_ALPHA = 72 * (Math.PI / 180);

/** A 3-vector back at unit length. */
function norm3(v) {
    const m = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / m, v[1] / m, v[2] / m];
}

const PULSAR_AXIS = norm3([
    Math.sin(PULSAR_PSI) * Math.cos(PULSAR_THETA),
    -Math.cos(PULSAR_PSI) * Math.cos(PULSAR_THETA),
    Math.sin(PULSAR_THETA),
]);
// An orthonormal basis of the plane the magnetic axis revolves in -- the plane
// perpendicular to the rotation axis, which is also the plane the torus lies
// in. `u` is z minus its axis component, so it points as nearly at the viewer
// as anything in that plane can.
const PULSAR_U = norm3([
    -PULSAR_AXIS[2] * PULSAR_AXIS[0],
    -PULSAR_AXIS[2] * PULSAR_AXIS[1],
    1 - PULSAR_AXIS[2] * PULSAR_AXIS[2],
]);
const PULSAR_V = norm3([
    PULSAR_AXIS[1] * PULSAR_U[2] - PULSAR_AXIS[2] * PULSAR_U[1],
    PULSAR_AXIS[2] * PULSAR_U[0] - PULSAR_AXIS[0] * PULSAR_U[2],
    PULSAR_AXIS[0] * PULSAR_U[1] - PULSAR_AXIS[1] * PULSAR_U[0],
]);
/**
 * The inverse of the 2x2 matrix that projects that plane onto the screen.
 * `IM * q` takes any point of the sky back to torus coordinates, which makes
 * the torus radius through a pixel one multiply-add pair rather than a search
 * -- and the sign of the second coordinate is which half of the ring is in
 * front. It is the whole reason the rings are cheap.
 */
const PULSAR_IM = (function invert() {
    const det = PULSAR_U[0] * PULSAR_V[1] - PULSAR_V[0] * PULSAR_U[1];
    return [PULSAR_V[1] / det, -PULSAR_V[0] / det, -PULSAR_U[1] / det, PULSAR_U[0] / det];
})();
// The jets run along the rotation axis, so their screen direction is its
// projection: the one element that crosses the arena corner to corner.
const PULSAR_JETD = (function project() {
    const m = Math.hypot(PULSAR_AXIS[0], PULSAR_AXIS[1]) || 1;
    return [PULSAR_AXIS[0] / m, PULSAR_AXIS[1] / m];
})();
// Jets: how far along the axis either way, half-width at the base and how much
// it flares per px of reach, the amplitude, and the knot noise that stops them
// reading as two smooth cones.
const PULSAR_JET = { len: 900, w0: 14, flare: 0.1, amp: 0.42, knot: [0.55, 0.75, 70], fall: 1.4 };
// The two rings, as radius / sigma / amplitude in torus space. Both radii were
// raised from a first pass at 165 and 300, where the whole torus sat above the
// arena's top edge and the play field got none of it. At 300 and 520 the near
// arc crosses the arena's upper half and the outer one grazes its middle,
// which is the only version of this torus the player ever sees.
const PULSAR_TORUS = [[300, 34, 0.42], [520, 62, 0.28]];
// Front half brighter than the back half. Which is which is the sign of the
// projected z of the torus angle -- the same trick the giant's rings use.
const PULSAR_FACE = [1.25, 0.8];
// Filaments along the rings: base, span, and the two noise scales.
const PULSAR_FIL = [0.62, 0.55, 2.2, 190];
// The two nebula sheets: the noise scale gas is drawn at, the cut that turns
// noise into cloud, the gamma on what survives, the scale and cut of the sheet
// mask, and the illumination by proximity to the star.
const PULSAR_NEB = {
    scale: 230, cut: [3, 1.52], gamma: 1.15, amp: 1.15,
    mask: 520, maskCut: [3.1, 1.55], illum: [0.1, 1.15, 430],
};
// Eight faint radial spikes. `cos(4a)` gives eight lobes, the power sharpens
// them to spokes, and the falloff keeps them near the star.
const PULSAR_SPIKE = { lobes: 4, sharp: 26, amp: 0.18, fall: 260 };
// The asteroid belt, in fractions of arena height and box pixels: the band it
// fills, the grid it is jittered on, the chance of one rock in a cell rather
// than two, the near/far scale, the two radii, and the rim brightness. Scaling
// with depth is what makes the field recede.
const PULSAR_BELT = {
    y0: 0.38, y1: 1.04, grid: 74, single: 0.62, scale: [0.45, 1.15],
    rx: [7, 20], ry: [5, 11], rim: [0.2, 0.34], seed: 90210,
};
// A rock's rim: how far out from its centre the lit crescent starts, and how
// nearly the surface has to face the star to catch it. The rim lights only on
// the side facing the star, so rocks left of centre are lit from the upper
// right and rocks right of centre from the upper left -- that directional rim
// is what stops 150 ellipses reading as 150 identical lozenges.
const PULSAR_RIM = [0.58, 0.42];
// Rock body and rim mottle: the two noise scales and the levels they ride.
const PULSAR_ROCK_BODY = [0.02, 0.04, 21, 15];
const PULSAR_ROCK_LIT = [0.55, 0.65, 13];
// The near silhouette along the bottom of the box, below the arena floor: how
// far down it starts, the sine and the noise that shape its skyline, and the
// lit lip on its top edge.
const PULSAR_SIL = { at: 1.02, sine: [26, 150, 2], noise: [54, 210, 8.5], lip: 4, lipV: 0.26, v: 0.014 };
// The far stars. 460 in the study; `starList` spreads brightness over its own
// band and the ramp is what keeps them off the top of the frame -- see the
// entry.
const PULSAR_STARS = 460;
const PULSAR_STAR_SEED = 0x117d;
// A star is dropped where the plate behind it already reads this bright, which
// is the same rule COMET TRAIL uses: a point light inside a lit nebula is a
// speck of noise rather than a star behind it.
const PULSAR_STAR_LIT = 60;
// The beam cone: half-width at the source and how much it widens per px of
// reach, the reach itself before foreshortening, the amplitude, and the two
// falloff powers. The cone WIDENS where the painter it replaces tapered a 120
// px base to a point -- a spike is the shape that reads as a rotating bar.
// The perpendicular power is 1.6 rather than 1: it widens the transition zone
// enough that no single dither cell sits on a hard threshold while the beam
// turns across the fixed Bayer matrix, which is the one artefact a sweeping
// beam has on an ordered dither.
const PULSAR_BEAM = { hw: 26, flare: 0.085, len: 1300, amp: 0.42, perp: 1.6, along: 1.3 };
const PULSAR_BEAM_PERP = powTable(PULSAR_BEAM.perp);
const PULSAR_BEAM_ALONG = powTable(PULSAR_BEAM.along);
// How sharply the core answers a pole coming round to the line of sight. 12 is
// the sharpest spike that still survives the 3 px lattice without aliasing to
// a single frame, and it is what makes the pulse ~27 frames wide inside a
// 120-frame gap: mostly nothing, then a brief arrival.
const PULSAR_PULSE_POW = 12;
// The core and its halo, in logical px: the core radius and the brightness it
// runs between, the halo radius and what the pulse adds to it, and the radius
// the whole thing is rasterised inside. Both live outside the arena; they are
// what the box and a camera pulled back for a colossus see.
const PULSAR_CORE = { r: 12, base: 0.35, peak: 0.65, amp: 1.1, halo: 55, haloAmp: 0.22, cut: 62 };
// Wisps: where they launch in torus space, how fast they travel outward, how
// long they live and the radius they expire at, the radial half-thickness of
// one, how many seeded arcs it is made of and how wide those run, the
// amplitude and its fade, and the frames it takes to rise. Three arcs rather
// than a full ring is the point -- it reads as structure leaving rather than
// as a shockwave, and it is where the pulse is legible inside the play field.
const PULSAR_WISP = {
    r0: 300, v: 0.55, life: 600, rMax: 640, band: 12, arcs: 3, w: [0.35, 0.35],
    amp: 0.34, fade: 420, rise: 14, dr: 1.5, am: 0.7, seed: 1000, step: 37,
};
const PULSAR_WISP_DR = powTable(PULSAR_WISP.dr);
const PULSAR_WISP_AM = powTable(PULSAR_WISP.am);
// The grid the belt is bucketed on, in box pixels.
const PULSAR_BKT = 64;

/* OCEAN WORLD. Where the horizon sits, as a fraction of arena height, and how
 * the water recedes: the exponent that turns depth into distance, so a row of
 * crests at `u` lands at `horizon + WH * u^1.75`. Everything in the place --
 * the rate ladder, the dash lengths, the rung caps -- is a function of `u`,
 * which is what keeps the five depths agreeing with each other. */
const OCEAN_HORIZON = 0.4;
const OCEAN_PERSP = 1.75;
// The sun's path on the water, as a fraction of arena width. Off centre, so
// the glitter column is a composition element and not a symmetry axis.
const OCEAN_BLOOM = 0.18;
// The sky, top of the box to the horizon: base, span and the gamma that keeps
// most of the lift near the horizon rather than spreading it up the box.
const OCEAN_SKY = [0.055, 0.44, 0.9];
// The bloom where the sun meets the water: amplitude, its two sigmas, and how
// far above the horizon its centre sits.
const OCEAN_SKY_BLOOM = [0.42, 100, 58, 4];
// The water, horizon to the bottom of the box: how much brighter the far water
// is than the near, the falloff, and the floor it never goes under. Water gets
// DARKER toward the player, which is the whole reason this place can carry a
// bright sky and still leave the bottom of the arena readable.
const OCEAN_WATER = [0.3, 1.5, 0.035];
// The glitter column on the water: amplitude, how far down the water it
// reaches as a fraction of the depth, and its width.
const OCEAN_SEA_BLOOM = [0.2, 0.14, 300];
/**
 * The rung cap, and it is two caps taking the smaller.
 *
 * The first is depth: within 70 logical px of the horizon the water may reach
 * rung 6, and it loses a rung every band or so going down, because near water
 * is seen at a steeper angle and reflects less sky. The second is where the
 * pixel is in the ARENA, and that one is not physics -- the player sits at the
 * bottom centre and everything that can kill them arrives there, so the bottom
 * 200 px of the play field is held two rungs under the rest by construction
 * rather than by a veil. It is the same idea as MOLTEN WORLD's land cap, keyed
 * on position instead of on material.
 */
const OCEAN_CAP_DEPTH = [[70, 6], [140, 5], [220, 4]];
const OCEAN_CAP_FLOOR = 3;
const OCEAN_CAP_BAND = [[340, 3], [280, 4]];
// Cloud banks, high layer then low: centre as a fraction of the box above the
// horizon, thickness, amplitude, and the harmonic that shapes it along x. The
// low layer is the one that gets repeated in the swell.
const OCEAN_BANKS = [
    [[0.22, 8, 0.9, 2], [0.4, 10, 0.8, 3]],
    [[0.62, 11, 1, 2], [0.75, 9, 0.9, 3], [0.9, 7, 0.8, 5]],
];
// A bank's profile along x: the two sines' weights, the cut that turns the
// wave into separate banks rather than a continuous sheet, and its span.
const OCEAN_BANK_P = [0.5, 0.25, 0.7, 0.52];
// Where each cloud layer is drawn, as fractions of the box top to the horizon,
// what a cell needs before it counts as cloud at all, and how fast the layer
// travels. The low layer runs nearly three times the high one: that is the
// only parallax in the sky.
const OCEAN_CLOUD_SPAN = [[0, 0.62], [0.4, 1]];
const OCEAN_CLOUD_CUT = 0.16;
const OCEAN_CLOUD_AMP = 0.2;
const OCEAN_CLOUD_RATE = [0.035, 0.094];
/**
 * The reflection: the low cloud layer again, upside down under the horizon.
 *
 * `gain` and `cap` are what make it a reflection rather than a copy -- the
 * water gives back about six tenths of the sky and cannot give back the top of
 * the ramp at all. `squash` is the compression a near-grazing view puts on it,
 * so the whole sky above the horizon fits into a hundred px under it, and the
 * two sines are the swell that breaks the image up as it comes back.
 */
const OCEAN_REFLECT = { gain: 0.62, cap: 4, cut: 0.3, squash: 0.32, shear: [7, 0.006, 1.9, 3, 0.017, 0.7] };
// The rate ladder, in px per frame, far to near: five bands a factor of ~2.6
// apart, which is what reads as distance when nothing in the frame has an edge
// to measure against. Bands are cut at these values of `u`.
const OCEAN_RATES = [0.012, 0.031, 0.081, 0.211, 0.549];
const OCEAN_BANDS = [0.18, 0.34, 0.55, 0.78];
// The crest rows: how many down the water, the dash length and the gap between
// dashes as functions of `u`, and where a crest stops being one art pixel high
// and becomes two.
const OCEAN_ROWS = 30;
const OCEAN_DASH_L = [3, 40, 1.6];
const OCEAN_DASH_G = [5, 30, 1.3];
const OCEAN_DASH_H = [0.45, 3, 6];
// The three far bands are baked and only scroll. Their jitter along the row,
// the length they take of their own slot, the value of the body and of the
// crest above it, and how often a dash gets one.
const OCEAN_FAR = { jitter: 0.55, len: [0.55, 0.7], body: [0.28, 0.1], crest: 0.55, crestV: 0.52, seed: [911, 137] };
// The two near bands are live, because what they do is the point: a crest line
// lengthens, breaks and reforms. `set` is the swell the whole band breathes
// with, `fr` the rate one dash breathes at, and `cut` the amplitude under
// which a dash is not drawn at all -- which is what makes the line break.
const OCEAN_NEAR = {
    seed: 4477, jitter: 0.5, len: [0.7, 0.6], fr: [0.011, 0.03], crest: 0.45,
    set: [0.55, 0.45, 0.0027, 0.22, 0.0086, 1.3], amp: [0.34, 0.66], cut: 0.21,
    grow: [0.35, 0.95], v: [0.24, 0.1], crestAt: 0.55, crestV: 0.5,
};
// The glitter path: how many, the band of `u` they sit in, how far either side
// of the column, the dash length, and the two rates -- one it flickers at and
// one it jitters across the column at.
const OCEAN_GLITTER = { n: 34, seed: 7717, u: [0.02, 0.5], w: [9, 58], len: [4, 22], fr: [0.05, 0.26], jr: [0.006, 0.012], on: 0.15, jitter: 0.45 };
// Foam: born, lives 40-90 frames, dies. Not a particle that travels -- it
// appears where a crest breaks and is gone, which is the one thing on this
// water that is an event rather than a texture.
const OCEAN_FOAM = { n: 18, seed: 3131, u: [0.45, 0.5], cycle: [120, 140], life: [40, 50], off: 400, w: [6, 9], on: 0.25, crestAt: 0.7 };
// Spores lifting off the crests: the place's own character, kept from the
// painter it replaces. How many, where they start, how big, how fast they
// rise, how far before they are gone, and the sway.
const OCEAN_SPORE = { n: 34, seed: 5150, u: [0.28, 0.66], big: 0.62, size: [6, 9], rate: [0.22, 0.33], span: [260, 420], sway: [0.004, 0.01], amp: [6, 10], fade: 0.12 };
// Both cloud layers stop at rung 4: a cloud is lit sky, not a light source,
// and the top of this ramp belongs to the horizon and the glitter.
const OCEAN_CLOUD_CAP = 4;

/* ION STORM. Seven curtains across the box, and the one seed everything in the
 * place is drawn from: widths, ray tables, phases, patches. Nothing calls a
 * generator at runtime, so frame 1500 is the same frame on every machine. */
const ION_CURTAINS = 7;
const ION_SEED = 0x105704;
// A curtain, in logical px: how far its centre is jittered off its even share
// of the box, and the width band it is picked from.
const ION_CX_JITTER = 30;
const ION_WIDTH = [96, 132];
// How it moves. Slide is bodily, lean is a shear about 42% of the box height,
// and fold is a horizontal displacement that runs down it -- the fold is what
// makes a curtain read as a folded sheet rather than as a bar.
const ION_SLIDE = [60, 30, 350, 430];
const ION_LEAN = [0.06, 0.08, 620, 430, 0.42];
const ION_FOLD = [18, 14, 320, 160, 0.0022, 0.0018];
/**
 * The vertical envelope, as a fraction of box height: where it starts, where
 * it peaks, where it ends, and the two exponents. It rises fast and falls
 * slow, which is what puts the bright part of every curtain in the top half of
 * the arena and leaves the bottom -- where the player sits -- to the stars.
 */
const ION_ENV = [0.02, 0.4, 0.99, 1.35, 1.5];
// Across the width the field falls as (1 - |u|/half)^2 off a floor, so every
// curtain has a bright spine and soft flanks.
const ION_ACROSS = [0.2, 0.8];
/**
 * The rays. Pitch in logical px, then the two thresholds inside a pitch that
 * cut the core out of the gap, and what the gap is worth. A ray is 2-3 ART
 * pixels of hard-edged vertical line and never a 1 px spark, which is the
 * first of the three things that tell it from a bullet.
 */
const ION_PITCH = 18;
const ION_CORE = [0.06, 0.52, 0.13];
const ION_FIELD_GAIN = 1.3;
/**
 * A ray's own clock: the flicker period band in frames, the base gain and the
 * swing on it, the second harmonic that keeps the swing off a pure sine, and
 * the core weight band.
 *
 * The phase walk is the good idea here: `frac(0.618 * k + jitter + 0.5 * (k
 * odd))` spreads phases evenly by the golden ratio AND anti-phases every
 * neighbouring pair, so a curtain's own mean brightness stays flat while the
 * individual rays swing the full range. That is what makes 180 flickering
 * lines read as weather instead of as a strobe.
 */
const ION_RAY_PERIOD = [18, 26];
const ION_RAY_GAIN = [0.3, 0.7];
const ION_RAY_H = [0.75, 0.25, 2.7, 1.7];
const ION_RAY_W = [0.55, 0.45];
const ION_RAY_PHASE = [0.6180339, 0.14];
/**
 * The three pulsating patches: where they sit, their radii, the pulse period
 * band, the drift, and the exponent that keeps each one dark for most of its
 * cycle and peaked briefly. A patch multiplies the field under it, lifting
 * rays about two rungs over roughly a fifth of the arena -- never all of it.
 */
const ION_PATCHES = 3;
const ION_PATCH_X = [0.18, 0.32, 90];
const ION_PATCH_Y = [0.34, 0.22];
const ION_PATCH_R = [[160, 160], [200, 220]];
const ION_PATCH_PER = [180, 900];
const ION_PATCH_DRIFT = [900, 700, 40];
const ION_PATCH_POW = 1.7;
const ION_PATCH_GAIN = [0.85, 1.05];
// The patch field is 160-320 px across and perfectly smooth, so it is
// evaluated on a coarse grid and read back per cell. At 8 art cells that is
// 24 logical px between samples against the narrowest patch's 160, and it
// takes the grid from 12k evaluations a frame to 3k.
const ION_PATCH_GRID = 8;
/**
 * The breakup, and it is a pure function of the frame counter: one epoch in
 * four fires, so about one every 9600 frames. 210 frames long -- 90 in, 60
 * held, 60 out -- and it touches two of the seven curtains, chosen by the
 * epoch so it is never the same two twice running.
 *
 * `rate` is the multiplier on the ray flicker and it is the number that had to
 * be measured rather than felt: the study rejected x3 on a worst-cell reading
 * of 27/255 and shipped 1.5, moving the drama into the fold and the front.
 */
const ION_BREAK = { epoch: 2400, chance: 0.25, life: 210, ramp: [90, 150, 60], curtains: 2 };
const ION_BREAK_FX = { fold: 1.6, field: 0.3, rate: 0.5, front: [6, 120, 0.26], seed: 97 };
// The dust band behind everything: the two noise scales, the cut and gain that
// turn noise into cloud, and where the band sits and how wide it is.
const ION_DUST = { scale: [138, 90, 51, 36], mix: 0.6, cut: 0.58, gain: 1.55, at: 0.52, sigma: 0.3 };
const ION_DUST_RUNGS = 3;
const ION_STARS = 430;
const ION_STAR_SEED = 0x2b91;
/**
 * How much of a star a curtain at full field hides. An aurora is thin: 0.18
 * means the stars burn straight through every curtain, which is what the
 * reference does and what fills a frame that was empty for free.
 */
const ION_OCCLUDE = 0.18;
// The rung a field value lands on, before the cap. 7.6 rather than 7 so the
// top of a bright core reaches the cap instead of stopping one under it.
const ION_RUNG = 7.6;
// Bright cores take a dither offset that depends on x only, so a ray stays one
// unbroken vertical run rather than breaking into halftone pieces under 40 px
// -- which is the whole reason a ray cannot be counted as a bullet.
const ION_COHERENT = 0.45;
const ION_MIN = 0.006;

/* -- LOW MOON ORBIT ------------------------------------------------------- */

// The horizon, as a fraction of arena height, and the one camera the ground
// under it is drawn through: focal length in art pixels, eye height in world
// units. A pixel `dy` art rows under the line looks at depth z = f*h/dy, so a
// crater of screen half-width a is exactly a*dy/f tall -- a sliver at the line,
// near-circular at the player's feet. Both numbers were set by eye in the
// study until that read right, and neither has anything left to tune.
const MOON_HORIZON = 0.62;
const MOON_FOC = 110;
const MOON_CAMH = 34;
// The jag on the line, as [period in art columns, amplitude in art rows], plus
// the ridge term: a crest over 0.72 lifts the line by up to 11 rows.
const MOON_JAG = [[84, 3.1], [29, 1.7], [9.5, 0.9]];
const MOON_RIDGE = [47, 0.72, 11];
const MOON_JAG_SEED = 0x6d0a;
// The lattice rows the four terms are read from. `mkNoise` sampled at an
// integer y is exactly that row of its grid -- the bilinear weight vanishes --
// so four distinct rows are four independent 1D noises out of one table.
//
// Which four is the one free choice here, and it is spent on the study's own
// measured figure: the amplitudes above are its, but this file's generator is
// not, so the relief they produce had to be re-measured rather than carried
// over. These rows put it at 14.8 logical px across the arena's 227 columns,
// which is the number the sheet publishes; the first set tried gave 9.2 and a
// horizon that read as a ruled line.
const MOON_JAG_ROWS = [3, 17, 29, 47];
// The plain's tone: value at the line, what it loses by `dy` 70, and two
// world-space mottles as [x rate, z rate, amplitude]. The mottles are what
// keep the open plain off the rung centres, which is where the dither texture
// lives; the craters are written on the centres so that it cannot reach them.
const MOON_TONE = [0.86, 0.32, 70];
const MOON_MOTTLE = [[0.09, 0.06, 0.014], [0.017, 0.011, 0.026]];
// The razor rim: art rows under the line pinned to the top rung, undithered.
// #0a0b10 against #9db9c0 in one art pixel, which is the no-atmosphere claim.
const MOON_RIM = 2;
const MOON_RIM_RUNG = 7;
// Craters, authored per depth row rather than per screen pixel: `dy` is skewed
// by this exponent so a uniform areal density in world space packs towards the
// horizon on screen. `a` is the screen half-width; `b` follows from the
// perspective rule and is never chosen.
const MOON_CRATERS = 200;
const MOON_DY_SKEW = 1.9;
const MOON_CRATER_A = [3, 1.9, 4, 0.6];
const MOON_DEPTH = 1.35;
// Distant rim arcs, sub-pixel deep: two rows, a bright far arc and a dark one
// under it. All of them sit inside the first 9 art rows, so the box being
// deeper than the study's arena does not change their count.
const MOON_ARCS = 150;
const MOON_ARC_DY = [0.4, 2.6, 9];
const MOON_ARC_A = [6, 1.4, 46];
const MOON_ARC_FLAT = 0.85;
const MOON_CRATER_SEED = 4648;
// One light direction everywhere, low and from the upper left, in ellipse
// space, and what a rim takes on each side of it: +1 rung lit, -2 unlit, -1
// across the terminator, -2 on the floor and -3 when the crater is deep.
const MOON_LIGHT = [-0.82, -0.58];
const MOON_LIT = 0.14;
const MOON_FLOOR_R = 0.66;
const MOON_DEEP = 0.7;
// Boulders and rim fragments: uniform areal density between `MOON_BOULDER_Z`
// and the depth the box bottom is at, silhouetted on a fixed rung, with one
// consistent shadow running right at [length x screen height, drop per column,
// how much of the field it takes].
const MOON_BOULDERS = 150;
const MOON_BOULDER_Z = 5200;
const MOON_BOULDER_SPREAD = 1.55;
const MOON_BOULDER_R = [0.35, 2.2, 5.2];
const MOON_BOULDER_W = 20;
const MOON_BOULDER_RUNG = [1, 4];
const MOON_SHADOW = [3.4, 0.12, 0.17];
const MOON_BOULDER_SEED = 90210;
// 140 point lights, and none within six art rows of the line: the plain's own
// top rung is brighter than the whole star ramp, so a star standing on it
// reads as noise on the ground rather than as a star behind it.
const MOON_STARS = 140;
const MOON_STAR_SEED = 0x6b2d;
const MOON_STAR_A = 0.4;
const MOON_STAR_GAP = 6;
// The impact schedule, and all of it is a pure function of the frame counter:
// one every 420 frames plus up to 231 of jitter, the rock falls for 92, and
// the scar it leaves lives 2400 and steps a rung every 600.
const MOON_PERIOD = 420;
const MOON_JITTER = 0.55;
const MOON_LEAD = 90;
const MOON_FALL = 92;
const MOON_LIFE = 2400;
const MOON_STEP = 600;
const MOON_EVENT_SEED = 0x11ac;
// Where one lands: this far in from the edge, and never in the 16 art rows
// under the line, where a crater would be under a pixel deep.
const MOON_EDGE = 26;
const MOON_DROP = 16;
const MOON_BOTTOM = 8;
// The rock: how far it drifts sideways over the fall, how far above the box it
// starts, and its radius. It is painted in rung 0, the colour of the sky, so
// the only way it is ever seen is the baked stars it puts out.
const MOON_ROCK_DRIFT = 26;
const MOON_ROCK_TOP = 40;
const MOON_ROCK_R = 3;
// The flash: six frames of these radii, the first two on the brighter of the
// two flash tones. It lands on lit ground, so it never has a dark surround.
const MOON_FLASH_R = [4, 5, 4, 3, 2, 1];
const MOON_FLASH_HOT = 2;
// Ejecta: 18 grains in a +-38 degree cone, two art pixels each so none of them
// is ever the 1-4 logical px an enemy core is, under a gravity low enough that
// they hang for 177 frames -- and they all land. Nothing stays up.
const MOON_EJECTA = 18;
const MOON_CONE = 1.32;
const MOON_EJECTA_V = [0.7, 0.42];
const MOON_EJECTA_SPREAD = 1.5;
const MOON_GRAV = 0.012;
const MOON_EJECTA_LIFE = 200;
const MOON_EJECTA_PX = 2;
// The scar, in art pixels around its own origin: the canvas it is drawn into,
// the fresh crater's radius against depth, the rays, and how many scars are
// kept rasterised at once. Seven is the most that are ever live at 420 frames
// and a 2400-frame life, so the cache never thrashes.
const MOON_SCAR = { w: 128, h: 80, cx: 64, cy: 40, cache: 8 };
const MOON_SCAR_R = [3, 0.055, 3.2];
const MOON_RAYS = 7;
const MOON_RAY_LEN = [10, 26, 0.5, 170];
const MOON_RAY_STEP = [1.6, 2.6];
const MOON_RAY_SEED = 0x2f61;
// A cell that takes the dither rather than a pinned rung.
const MOON_FREE = 255;

/* -- PLANETARY NEBULA ----------------------------------------------------- */

// The shell's centre, offset from the arena centre in logical px, and the
// frame it is measured in: rotated 20 degrees and squashed to 0.78. Off-centre
// right and high on purpose, so the widened field of a colossus camera reveals
// the far side of the ring rather than emptying.
const SHELL_C = [74, -34];
const SHELL_ROT = [0.94, 0.34];
const SHELL_SQUASH = 0.78;
// The radius is warped twice before anything is measured against it, as
// [rate, octaves, amplitude]: a low frequency bending the shell out of round,
// a high one roughening its rim.
const SHELL_WARP = [[0.0016, 3, 110], [0.007, 2, 44]];
// The most the two together can move a radius. It is what bounds the live
// pass: a cell whose baked radius is further outside the echo band than this
// cannot be inside it.
const SHELL_WARP_MAX = 77;
// The main shell and the inner ring, as [radius, width, amplitude]. The inner
// one is a fraction of the main radius, so the pair scales together.
const SHELL_MAIN = [250, 38, 0.52];
const SHELL_INNER = [0.652, 22, 0.3];
// The angular patch field, `base + gain * noise(rate)`, and it is the whole
// reason this does not read as a target: the rim is bright in three places and
// thin in two, and the inner ring only exists where the patch clears its gate.
const SHELL_PATCH = { base: 0.35, gain: 1.25, rate: 0.0035 };
const SHELL_INNER_GATE = [0.72, 2.4];
// The floor the empty field sits at, and the cavity the star stands in.
const SHELL_FLOOR = 0.012;
const SHELL_CAVITY = [0.05, 120];
// The ionisation rim: hard on its outside, over the 6 px inside r + 12, fading
// in over the 30 px from r - 35. The one edge here that is a boundary and not
// a falloff, which is why it is a pair of clamps and not a gaussian.
const SHELL_ION = { amp: 0.22, out: 12, hard: 6, in: 35, soft: 30, cap: 1.15 };
// Knots embedded in the shell: the noise that decides them, the cut it has to
// clear, and the band of radius they are masked to.
const SHELL_KNOT = { rate: 0.012, cut: 0.62, amp: 0.7, at: -5, w: 45 };
// The grain over everything, as a multiplier, and the spiral smudge low-left:
// its own thing, seen through the gas.
const SHELL_GRAIN = { rate: 0.05, base: 0.86, gain: 0.28 };
const SHELL_SPIRAL = { x: 300, y: 210, squash: 0.6, reach: 90,
    core: 0.32, coreW: 26, arm: 0.16, armR: 34, armW: 22, turns: 2, pitch: 0.11 };
// The filament wall crossing the upper field: a slope and an intercept, a
// noise that bends it, how far out it reaches, and the 7 px hard crest with a
// 26 px glow on its lit side only.
const SHELL_FIL = { slope: 0.5, at: -220, rate: 0.004, wobble: 90,
    mid: 40, reach: 900, crest: 7, glow: 0.42, off: 20, wide: 30 };
// The two dust columns standing in front of the shell, in logical px from the
// arena centre. Decided per art pixel as a boolean and drawn from `landRamp`,
// which never enters the dither -- the ice-world precedent, and the reason
// their edges are ragged without being soft: every boundary pixel is a full
// step. `sway` is their share of the shared lean; `noise`/`rate`/`off` is the
// roughness that eats their taper.
const SHELL_COLUMNS = [
    { t: 90, u: -200, sway: 1, lo: -230, hi: 320, hw: 52, drop: 240, taper: 700,
        sh: 230, sh2: 110, min: 7, noise: "n3", rate: 0.018, off: 0 },
    { t: 150, u: 250, sway: 0.6, lo: -200, hi: 300, hw: 34, drop: 220, taper: 640,
        sh: 200, sh2: 90, min: 6, noise: "n2", rate: 0.02, off: 5 },
];
const SHELL_SWAY = { rate: 0.006, off: 30, row: 7, amp: 70 };
const SHELL_BANK = { at: 215, rate: 0.005, off: 12, row: 3, amp: 130 };
const SHELL_ROUGH = 0.6;
// Which of the two silhouette rungs a solid pixel takes.
const SHELL_SIL_CUT = { rate: 0.03, off: 40, cut: 0.64 };
// How much of the ramp each live term is worth. The first two were measured
// rather than felt: they are what took the study's own bright-feature count
// from 10 to 4, and the shell rim was left alone because it is one long
// connected arc rather than competing points.
const SHELL_FIL_A = 0.42;
const SHELL_ECHO_A = 0.45;
const SHELL_CORE_A = 0.55;
const SHELL_CORE_W = 34;
// The light echo. The front's radius is a pure function of the frame counter,
// with no stored countdown: it leaves the star, crosses the inner ring at
// about f+115, the main shell between f+150 and f+205, and is past the box
// before the cycle's last 280 frames, which are dark.
const SHELL_PERIOD = 720;
const SHELL_RATE = 1.4;
const SHELL_REACH = 620;
const SHELL_SIGMA = 22;
const SHELL_BAND = 66;
const SHELL_GATE = 2;
// The central source, breathing +-12% on a 300-frame sine, and the radius the
// live pass covers for it alone while no front is travelling.
const SHELL_PULSE = [0.12, 300];
const SHELL_CORE_R = 90;
// `base` and `gas` are kept as bytes on this scale, so a cell's live rung is
// computed from exactly the value its baked rung came from: the two can never
// disagree by a rounding step, and a cell the echo does not reach is never
// repainted with a colour one off the plate's.
const SHELL_Q = 200;
// A table entry at or over this is a silhouette rather than a gas rung.
const SHELL_SIL = 254;
const SHELL_SEEDS = [0x5a31, 0x2c07, 0x71bd, 0x0e49, 0x38f2];
const SHELL_STARS = 190;
const SHELL_STAR_SEED = 0x1417;
const SHELL_TWINKLE_SEED = 0x63d8;
// A shell is thin, so a star reads through it: 0.55 of the gas against the
// violet nebula's 0.80. A silhouette is the other case -- it is an object.
const SHELL_OCCLUDE = 0.55;

/* -- BINARY SUNS ---------------------------------------------------------- */

// Both stars, as fractions of the arena, with their radii in absolute logical
// px: only the short side of the arena is a fixed size, so the split is the
// one INNER SYSTEM and LOW MOON ORBIT already use. Neither is clipped -- the
// donor's old centre sat 54 px above the top edge, and half of what the place
// is called after was never in the frame.
const BIN_DONOR = { cx: 0.3059, cy: 0.4667, core: 22, peak: 1.05, halo: 0.3, hr: 48 };
const BIN_COMP = { cx: 0.6382, cy: 0.437, core: 11, peak: 1.15, halo: 0.32, hr: 40 };
// The 8-fold ray burst on each: amplitude, phase, and the window that keeps it
// from reaching across the box, as `exp(-(d/w)^2)`.
const BIN_RAYS = 8;
const BIN_DONOR_RAY = [0.35, 0.4, 140];
const BIN_COMP_RAY = [0.42, -0.7, 120];
// The surface radius the stream leaves from, on the line to the companion.
const BIN_DONOR_R = 32;
// ONE shared plane, centred between the stars rather than a small ring around
// one of them: rotated, and its y divided by the squash before the radius is
// measured, so it reads as a tilted sheet running off every edge of the box
// instead of an ellipse drawn on glass.
const BIN_PLANE = { cx: 0.4706, cy: 0.4519, tilt: -0.22, squash: 0.34 };
// Its radial profile: a broad annulus plus a filling haze, each [radius,
// sigma, amplitude].
const BIN_RING = [250, 210, 0.52];
const BIN_HAZE = [0, 430, 0.16];
// Seven logarithmic arms -- fine filaments, not three fat bars -- as pitch on
// ln R, and the modulation their sine is shaped through.
const BIN_ARMS = 7;
const BIN_PITCH = 5.5;
const BIN_ARM = [0.42, 0.58];
const BIN_LN_MIN = 12;
// Below this the plane contributes nothing an eight-rung ramp can show, so the
// `atan2` and the `log` are skipped: outside the sheet they are most of what
// the bake would cost.
const BIN_PROF_MIN = 0.002;
// The stream, as a quadratic Bezier: the end point relative to the companion,
// the control point's offset along the perpendicular as a share of the
// separation (leading the orbit -- that is what makes the stream miss the
// companion instead of pointing at it), and how finely it is sampled.
const BIN_STREAM_END = [-44, 30];
const BIN_STREAM_LEAD = 0.22;
const BIN_STREAM_N = 48;
const BIN_STREAM_W = [8, 4];
const BIN_STREAM_A = 0.8;
// How far from the curve's own bounding box a pixel can be and still be tested
// against it. Past this the Gaussian is under a thousandth of a rung.
const BIN_STREAM_PAD = 34;
// The hot spot, where the stream lands: sigma, and the radius past which it is
// not evaluated. 0.03% of the arena's area, and mostly on the cool ramp -- a
// hot spot is hot, so painting it blue-white is both correct and one fewer
// small warm point.
const BIN_HOT = 6;
const BIN_HOT_PAD = 26;
// The mixing weights: how much of the plane, the stream and the hot spot each
// ramp takes, and the master scale over the pair.
const BIN_MIX = { disc: [0.72, 0.88], stream: 0.7, hot: [0.2, 0.38], master: 0.78 };
// The changeover between the two ramps is DITHERED, not drawn: the ramp choice
// takes a second Bayer tap two rows and one column away, at this share of the
// local value. Without it the warm half and the cool half meet on a hard
// vertical seam down the middle of the frame.
const BIN_SEAM = 0.55;
const BIN_SEAM_TAP = [2, 1];
// The gold ramp stops one rung short. A 9 px block of its rung 7 measures mean
// R over 1.12x mean B on a dark surround, which is the same failure COMET
// TRAIL's core took; the cool ramp is nowhere near the enemy palette and keeps
// all eight.
const BIN_GOLD_CAP = 6;
// Every rate is per frame, and every one of them is a pure `sin(k*f)` with no
// stored countdown -- so `backdropThumb` jumps straight to 1500 and two
// machines in a co-op match show the same sky.
const BIN_SPIN = 0.01;
const BIN_FLOW = { rate: 0.006, waves: 3, base: 0.55, amp: 0.45 };
const BIN_FLICK = [[0.11, 0, 0.6], [0.043, 1.7, 0.4]];
const BIN_FLICK_A = 0.28;
const BIN_BREATHE = [0.004, 0.015];
const BIN_STARS = 520;
const BIN_STAR_SEED = 0x5115;
const BIN_STAR_A = 0.3;
// How much of a point light the sheet in front of it puts out.
const BIN_OCCLUDE = 0.9;

/* -- ORBITAL STATION ------------------------------------------------------ */

// The ring: a centre in the arena's own fractions, a radius in art pixels, and
// the squash that turns the circle into the plane it is seen at -- a 342 x 123
// logical ellipse, still top right where the glossary says it is. 57 art px is
// 171 logical, down from the entry's old 204: at 204 the ring's right extreme
// crossed the arena edge, and a module at the extremes fell to 16 px of
// apparent width, which is where the plating stops reading.
const STATION_C = { cx: 0.70, cy: 0.20 };
const STATION_R = 57;
const STATION_SQUASH = 0.36;
// 24 modules. 16 read as a wheel with spokes; 32 mush at the extremes, where
// apparent width is 16 px against 45 across the near and far arcs.
const STATION_MODULES = 24;
const STATION_MOD_HW = 7.46;
const STATION_MOD_H = [5, 1.5];
// Windows are 2 art px -- 6 logical, the catalogue's floor for reading as mass
// -- in runs at this pitch, and every fourth module is dark: 18 of 24 lit.
// 4 art px is the sheet's own 12 logical px. Its code shipped 5, which puts 2
// windows on a 45 px module where the sheet's prose promises a run of 3-7; at
// 4 the arcs carry 3 and the place reads as rows rather than portholes.
const STATION_WIN_PITCH = 4;
const STATION_WIN_DARK = 4;
const STATION_NAV_EVERY = 6;
// The rim truss behind the modules, split by depth: the ring has to read as a
// ring in the gaps between them, not as 24 bricks in a row.
const STATION_RIM = 84;
const STATION_SPOKES = 4;
// Where a spoke starts and how far short of the rim it stops.
const STATION_SPOKE_R = [5, 4];
// One revolution: 0.25 degrees a frame, and a module clears its own width in
// 60. Under about 700 frames it competes with bullet motion; over about 2500
// it stops reading as turning at all inside a single wave.
const STATION_PERIOD = 1440;
// The shuttle leaving the hub: its cycle, and how far it gets along each axis.
const STATION_SHUTTLE = { period: 900, x: [6, 46], y: [8, 20] };
// The dirty rectangle, as art pixels left / right / above / below the centre.
// It never moves, because the ring's bounds do not: the modules travel inside
// a fixed ellipse and everything above the bearing is despun. The widest thing
// in it is the ring itself, and the tallest is a solar array.
const STATION_BOX = [61, 61, 31, 33];
// The dust plane the place sits in. The bias is a gaussian on the station's
// own quadrant, so the ring has a ground to be seen against instead of hanging
// on flat black; `cut` is what keeps the rest of the box dark.
const STATION_FIELD = {
    rate: 0.0168, amp: 0.92, floor: 0.55, gain: 0.75, reach: 5.5, cut: 0.54, lift: 1.05,
};
const STATION_SEED = 0x57a7;
const STATION_STARS = 620;
const STATION_STAR_SEED = 0xb1a5;
const STATION_STAR_A = 0.24;
// A star only goes down where the plate behind it is dark. The station's own
// quadrant is the one lit part of this sky, and a point light inside it reads
// as a speck of noise in the dust rather than as a star behind it.
const STATION_STAR_LIT = 30;

/* -- SUPERNOVA ------------------------------------------------------------ */

// The remnant's centre, just outside the arena's lower-left corner. The shell
// is mostly outside the play field: what reaches it is the upper-left quadrant
// and no complete arc ever crosses the frame, which is the whole reason this
// place cannot be read as the boss shockwave. `cx` is a fraction of the
// arena's width and the rest of its height -- the split INNER SYSTEM and LOW
// MOON ORBIT already use, because only the short side is a fixed size.
const SN_C = { cx: 0.0809, cy: 1.0148 };
const SN_R = 0.8796;
// The shell is a tenth flatter than it is wide.
const SN_ELL = 1.1;
// Where the shock ploughs into denser medium: up and to the right of the
// centre, which lands in the arena's left half. Filament brightness, dust
// density, the Halpha band and the echo's direction of travel are all measured
// from this bearing, and that is why the bright region is off-centre instead of
// the middle being bright. `gain` is base, span and the cosine's power.
const SN_SHOCK = -0.95;
const SN_GAIN = [0.55, 0.85, 1.5];

// 34 filament strands, 22 of them clustered on the rim and 12 inside it. No two
// share a centre and none of the arcs closes: `arc` is the half-width in
// radians (5-26 degrees), `off` scatters the centre as a fraction of R, `amp`
// is the radial noise on the angle and `th` the Gaussian half-thickness in
// LOGICAL px -- that one is absolute because it is measured against the 3 px
// lattice and not against the shell.
const SN_STRANDS = 34;
const SN_RIM_N = 22;
const SN_STRAND_SEED = 64066;
const SN_RIM_STRAND = {
    rad: [0.9, 0.17], off: [0.1095, 0.08], th: [1.7, 2.4],
    arc: [0.09, 0.36], amp: [0.0337, 0.0674], br: [0.82, 0.18], spread: 1.3,
};
const SN_IN_STRAND = {
    rad: [0.46, 0.44], off: [0.2421, 0.1768], th: [2.2, 3.2],
    arc: [0.12, 0.3], amp: [0.0505, 0.0926], br: [0.45, 0.4], spread: 1.55,
};
// Lopsided by construction: r(theta) = R * (1 + 0.20 sin(theta + ph) + 0.09
// sin(2 theta - ph)), before the noise term.
const SN_STRAND_LOBE = [0.2, 0.09];
const SN_STRAND_NOISE = 9;
// The radial filaments. The same silhouette test elongated along r, with the
// angle wobbling as the radius climbs so a spoke is not a drawn line.
const SN_SPOKE_SEED = 65066;
const SN_SPOKE = {
    n: 12, spread: 1.3, r0: [0.3, 0.3], r1: [0.88, 0.4], th: [1.7, 2.8],
    br: [0.55, 0.45], wob: [0.022, 0.13], fade: [70, 110], pad: 40,
};
// The breakup: two low-frequency fields that vary a strand's brightness along
// its length and a knot field that beads it, so no strand runs solid for more
// than about 8 degrees of arc. `[scale, cut, gain]` for the knot.
const SN_BREAK_A = 0.026;
const SN_BREAK_B = 0.03;
const SN_KNOT = [0.055, 0.36, 2.7];
const SN_FIL_MIX = [0.22, 1.02, 0.26, 0.9];
const SN_SPOKE_MIX = [0.3, 1, 0.3, 0.85];
// Fine sheets seen edge-on: ridged noise confined to the shell annulus, at
// `at` of R with width `w`, cut at `cut` over `span`.
const SN_FINE = { at: 0.97, w: 0.16, scale: 0.021, cut: 0.74, span: 0.2, a: 0.7 };
// The silhouette is DECIDED here, not stroked: over `cut` a pixel is filament
// and takes `floor` plus `gain` of the smoothstep, under it there is no
// filament at all. That hard threshold is what makes the boundary ragged at
// every scale down to the art pixel, which no expanding ring is.
// `cut` and `span` re-solved here too, and for the same reason: on the study's
// 0.40 / 0.52 the top rung reached 0.6% of the arena against the "few per cent"
// the sheet measures, because this file's noise is narrower in the tails and
// the strand's two breakup factors multiply. 0.30 / 0.50 keeps the shaping --
// floor 0.26, gain 0.60 -- and doubles the area the filaments actually light.
const SN_SIL = { cut: 0.3, span: 0.5, floor: 0.26, gain: 0.6 };
// The dust. A smooth density ramp rather than a hard cut -- the dither carries
// the gradient instead of filling a rung -- biased onto the shock's side,
// emptied out of the interior cavity over `cavity` px, and mottled so the
// region has no edge. `peak` puts the unlit haze between rungs 0 and 1, which
// is what leaves the echo somewhere to go.
// `span` is 0.21 and not the study's 0.30: its cut needs the noise to reach
// 0.86 before the dust is at full density, and THIS FILE'S generator tops out
// at 0.842 over the box, so the plateau the sheet describes -- "the unlit haze
// sits between rungs 0 and 1" -- was unreachable by construction and the dust
// peaked at 0.058, entirely on rung 0. Solved back onto the sheet's own claim.
// `cut` and `gamma` are the study's, which is what keeps the plateau small.
const SN_DUST = {
    scale: 0.0078, cut: 0.56, span: 0.21, gamma: 1.5, bias: [0.34, 0.66, 1.2],
    cavity: [0.5, 240], mottle: [0.03, 0.4, 0.6], peak: 0.105, min: 0.003,
};
// Halpha knots, immediately behind the shock front and nowhere else. They are
// the second ramp, capped five rungs under the cool one: the brightest warm
// thing in this sky is darker than the dust plateau's own colour, so nothing
// warm here can be mistaken for fire.
const SN_HA = { at: 0.88, w: 42, gamma: 2, scale: 0.042, cut: 0.56, gain: 3.4 };
const SN_HA_TOP = 3;
// The light echo, and it is the only thing in the place that moves. A Gaussian
// brightness front `w` px wide at 1/e travels outward along the shock at `rate`
// logical px a frame and adds `gain` of ramp range to the dust it is crossing:
// what changes is WHICH DUST IS LIT, never where anything is. Two fronts half a
// period apart, phased so one is always inside the arena. `win` is how far from
// a front a pixel is still visited and `pad` the share of `w` the cycle is
// padded by at each end, so a front is outside the paint box when it wraps and
// the cycle has no seam.
const SN_ECHO = { rate: 0.45, w: 240, gain: 0.26, win: 430, pad: 2.2, phase: 0.28 };
// The envelope as a table. `live` evaluates it once per visited art pixel and
// there are tens of thousands of those a frame; two `Math.exp` there cost more
// than the rest of the loop put together, and the curve is one shape read at
// one scale. Same trick and same resolution as `powTable`.
const SN_ENV_N = 256;
// How much of a point light the filaments and the dust put out.
const SN_OCCLUDE = [1.4, 0.8, 0.52];
const SN_STARS = 780;
const SN_STAR_SEED = 0x5f04;
// 0.06, not the catalogue's usual 0.24: `_bakeField` buckets a star by
// `round(a * 3) / 3`, so the shared 0.24 puts HALF of them on the top rung and
// none at all on the bottom one. The study's own field is 12% top, 40% middle,
// 48% bottom, and this is the value that reproduces it -- 8% of the list falls
// under the 0.1 cut-off and is dropped, which is where 780 becomes about 720.
const SN_STAR_A = 0.06;

/* -- ECLIPSE -------------------------------------------------------------- */

// Composition carried over from the entry unchanged: the disc already had the
// top two thirds of the arena, which is the point of it.
const ECL_C = { cx: 0.5, cy: 0.1, r: 0.42 };
// The circumference cut into angular cells. Each carries its own streamer
// amplitude and length and its own limb terrain, so a cell is CONSTANT across
// its whole angular width and every streamer's flanks are hard steps in the
// ramp rather than a dithered fringe.
const ECL_CELLS = 192;
const ECL_SEED = 0x3c11f5;
// Limb terrain, +-0.006 R (+-1.7 logical px of valleys and ridges) from two
// seeded sines. It is what makes the silhouette's edge a decision per art
// pixel rather than a drawn circle, and it is where Baily's beads come from.
const ECL_TERR = [0.006, 0.6, 11, 0.4, 23];
// The ring: three SOLID bands at 6 / 6 / 8 logical px and these weights, as
// edges in `u = rn - E`. Not an exponential falloff -- a band thinner than two
// art pixels breaks into diagonal crumbs wherever the limb runs at 45 degrees
// to the lattice, which is most of it.
const ECL_RING = [0.021, 0.042, 0.07];
const ECL_RING_V = [1, 0.62, 0.3];
// Its angular gain: base, the share the corona's visibility adds, and the arc
// on the star's side during the partial phases with its width in radians. An
// even 360 degree ring in totality, a bright arc on one flank outside it.
const ECL_GAIN = { base: 0.3, cv: 0.7, arc: 1.05, w: 0.42, cap: 1.3 };
// Streamers. 28% of cells are dimmed and shortened to give the comb its gaps,
// and the plumes are grouped by two low-frequency sines so they cluster
// instead of speckling. `cv` scales their LENGTH, never their brightness: a
// half-bright ray dithers into thousands of bullet-sized crumbs, and that one
// change is worth 34 warm features at the contact by the study's own count.
const ECL_STREAM = {
    amp: [0.24, 0.76], len: [0.1, 0.42], mix: [0.5, 0.3, 0.2], lmix: [0.55, 0.25, 0.2],
    dim: 0.28, dimA: 0.45, dimL: 0.5, exp: 1.5, a: 0.9, cap: 6,
    drift: 1800, wob: 0.2,
};
// The haze filling the gaps between the plumes.
const ECL_HAZE = [0.1, 0.1, 0.25, 0.75];
// The star, once it has cleared the limb: three concentric solid bands plus an
// AXIS-ALIGNED cross, all on exact rung values, sized by emergence rather than
// dimmed by it. The core has a one-art-pixel floor so the last light before
// totality is a hard bead and not a fade-out, and there are no diagonal
// spikes: a 1-2 px diagonal is not 4-connected on the lattice and measures as
// a chain of separate bullet-sized features -- 14 of them, in the version that
// had them.
const ECL_STAR = {
    core: [0.012, 0.052], mid: 0.082, out: 0.125, reach: 0.5,
    spike: 0.46, w: [0.011, 0.02],
};
// The transit. `p` runs 0..1 over `period` frames: first contact, the diamond
// ring, totality, the second diamond ring, last contact. The star travels a
// straight chord between these two limb angles, extended `margin` R past each
// contact, so both contacts happen on limb that is inside the arena.
const ECL_TRANSIT = { period: 10800, in: 2.36, out: 0.79, margin: 0.55 };
// Where the pass STARTS when the place is entered. The study assumes a free
// running frame counter; here `bd.t` is zero every time the wave block begins,
// so a pass that started at first contact would show the player the entry
// partial and nothing else -- three waves is 1800-3000 frames of a 10800 frame
// pass. 0.60 opens the block inside totality, which is what the glossary line
// describes, and brings the second diamond ring and last contact into it.
const ECL_START = 0.6;
// How much of `dist` the corona comes up over: 0 to 1 in 14 logical px of star
// travel, about 1.2 s.
const ECL_CV = 0.05;
const ECL_CONTACT = 0.995;
// Baily's beads: only at the contacts, only within this arc of the star's
// bearing, only through a limb valley, and never more than three at once.
const ECL_BEAD = {
    win: 0.045, span: 7, valley: -0.0025, period: [170, 18, 5],
    dur: 28, phase: 37, size: 2, max: 3,
};
// The annulus `live` re-bakes, in R. It never grows: the star's flare is
// 0.46 R long and the star never gets further out than 1.45 R.
const ECL_ANNULUS = [0.98, 1.95];
// ...and how often. 81k art pixels every tenth frame is 8.1k a frame
// amortised, against a baseline of zero: that is the transit, and it cannot be
// had for free.
const ECL_STEP = 10;
const ECL_STARS = 150;
const ECL_STAR_SEED = 0xec11;
const ECL_STAR_A = 0.06;

/* -- WORMHOLE ------------------------------------------------------------- */

// The vanishing point, inherited unchanged: halfway across, 32% down. The
// mouth is a PLANE at a squash, not an oval drawn on glass -- every art pixel
// is mapped into plane coordinates and the radius is measured in the plane, so
// there is no canvas rotate, no canvas scale and no stroked arc anywhere.
const WORM_VP = { x: 0.5, y: 0.32 };
const WORM_SQUASH = 0.62;
// Depth is the log of the plane radius: a rib at depth d projects to a screen
// radius proportional to 1/d, so equal steps in depth are equal steps in
// `u = ln r` and the perspective compression is a single constant. 0.46 in u
// is a radius ratio of 1.58 per turn, which crowds the ribs toward the
// vanishing point the way a throat crowds.
const WORM_LAMBDA = 0.46;
const WORM_RMIN = 7;
// The ladder is never perfectly periodic: each band takes a seeded jitter.
const WORM_JIT = { n: 64, amp: 0.52, seed: 9137 };
// Two arms. The depth phase carries the angular term, which is what makes the
// ribs a spiral rather than a stack of rings.
const WORM_ARMS = 2;
const WORM_WALL_EXP = 1.6;
// Vignette and core, both measured in SCREEN pixels rather than world units,
// so the hot centre keeps its size and the frame keeps its contrast wherever
// the camera is. `[sigma, exponent]` and `[r, weight, r, weight]`.
const WORM_VIG = [250, 2];
const WORM_CORE = [26, 1, 70, 0.28];
// Over this the pixel is inside the core and is allowed the top rung. The
// walls stop at 6.
const WORM_CORE_CAP = 0.35;
// The rung the WALLS stop at. The study says 6, and 6 is #9ad6f2 at luminance
// 203 -- brighter than anything else this catalogue paints on a dark field.
// Left at 6 the dither scatters single top-rung art pixels through the throat
// and three of them measure as small bright features: 3 px of pale cyan on
// dark is a bullet. The study only ever tested this place for hue and for
// frame-to-frame change, both of which it passes. Cyan and white are the
// core's now, which is also what the palette note says the ramp is FOR.
const WORM_WALL_TOP = 5;
// How far out the vignette still reaches a rung, in sigmas: past 2.42 the
// brightest the walls can be is under half a dither step, so the live pass
// never visits it and the plate's own rung 0 is already the right answer.
const WORM_REACH = 2.42;
// The mix: the wall's own share, the swirl's base and amplitude inside it, the
// travelling light's share, and the ceiling the sum is held under so the walls
// can never reach the core's rungs.
const WORM_MIX = { wall: 0.34, swirlBase: 0.7, swirl: 0.3, light: 0.74, cap: 0.82 };
// The striation: three lobes around the angle, sheared along the depth.
const WORM_SWIRL = [3, 2.4];
// The two live terms, and they are the only two. Alternate rib bands shear in
// opposite directions at `om` rad a frame -- one revolution in 5.2 s, so the
// event is neighbouring ribs sliding against each other and it is legible at a
// glance. Rotation is an OFFSET ADDED TO THE BAKED ANGULAR COORDINATE, not a
// transform applied to pixels, so there is no atlas and nothing lands on a
// half pixel. The light is one continuous crest sliding along the rib phase at
// `rate` periods a frame: no on/off duty cycle, so every art pixel is always
// somewhere on the crest and what the eye sees is a spiral winding into the
// core rather than a ring arriving -- 1.2 features a second against the old
// painter's 5.05, travelling INWARD onto a 26 px region instead of outward
// across 680 px of play field.
const WORM_OM = 0.02;
const WORM_RATE = 0.02;
const WORM_LIGHT_EXP = 2.2;
// Both live terms are one curve read at one scale, so both are tables.
const WORM_TAB_N = 256;
const WORM_STARS = 830;
const WORM_STAR_SEED = 0x2f77;
const WORM_STAR_A = 0.06;

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

/**
 * A power curve over 0..1, sampled into a table.
 *
 * `Math.pow` with a fractional exponent is tens of nanoseconds and the falloff
 * curves of a beam or a wisp are evaluated once per art pixel -- 40,000 of
 * them a frame on PULSAR, which is most of what that painter costs. Read back
 * with `powLook`, which interpolates, the error is far under the dither's own
 * threshold step and the picture is the same one.
 */
function powTable(e) {
    const t = new Float32Array(258);
    for (let i = 0; i <= 256; i++) {
        t[i] = Math.pow(i / 256, e);
    }
    t[257] = t[256];
    return t;
}

function powLook(t, x) {
    const p = x * 256;
    const i = p | 0;
    return t[i] + (t[i + 1] - t[i]) * (p - i);
}

/** Rec. 709 luminance of an RGB triplet, on the same 0-255 scale. */
function lum(c) {
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * One row of art pixels, with the surface's dirty rectangle kept up to date.
 * Both the clipping and the bookkeeping live here, so a shape only has to say
 * which span of which row it covers.
 */
function artRow(s, y, xA, xB, put) {
    if (y < 0 || y >= s.ah) {
        return;
    }
    const a = Math.max(0, xA);
    const b = Math.min(s.aw - 1, xB);
    if (b < a) {
        return;
    }
    for (let x = a; x <= b; x++) {
        put(x, y);
    }
    if (a < s.x0) { s.x0 = a; }
    if (b > s.x1) { s.x1 = b; }
    if (y < s.y0) { s.y0 = y; }
    if (y > s.y1) { s.y1 = y; }
    // A surface may also ask for the span per row. One rectangle around two
    // thin diagonal cones is mostly empty -- PULSAR resolves 166k cells a
    // frame to paint 24k of them without this, and 50k with it.
    if (s.span) {
        const k = y * 2;
        if (s.span[k] < 0 || a < s.span[k]) { s.span[k] = a; }
        if (b > s.span[k + 1]) { s.span[k + 1] = b; }
    }
}

/**
 * One convex quad, scanline-filled. Four corners, in order, in art pixels.
 * Shared: it is the comet's tail segments and the pulsar's beam cones and
 * wisp arcs, which are all quads once they are in the right coordinates.
 */
function artQuad(s, q, put) {
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
        artRow(s, y, Math.ceil(lo - 0.5), Math.floor(hi - 0.5), put);
    }
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

/** The comet's own quad: one rung and one alpha across the whole shape. */
function cometQuad(s, q, ramp, alpha) {
    if (alpha <= 0) {
        return;
    }
    artQuad(s, q, (x, y) => cometPixel(s, x, y, ramp, alpha));
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

/* -------------------------------------------------------------------------- */
/* PULSAR                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The rock of the belt covering a point, as a value, or -1 where there is
 * none. Bucketed on a coarse grid: 150 ellipses tested per art pixel would be
 * 28 million tests over the box, and the bucket takes it to about two.
 */
function pulsarRock(bd, x, y) {
    const b = bd.rocks[Math.floor(y / PULSAR_BKT) * bd.rockW + Math.floor(x / PULSAR_BKT)];
    if (!b) {
        return -1;
    }
    for (const c of b) {
        const dx = (x - c.x) / c.rx;
        const dy = (y - c.y) / c.ry;
        const d2 = dx * dx + dy * dy;
        if (d2 >= 1) {
            continue;
        }
        // The lit crescent: far enough out from the centre, and facing the
        // star. Both tests, so the rim is a crescent and not a ring.
        if (d2 > PULSAR_RIM[0] && dx * c.nx + dy * c.ny > PULSAR_RIM[1]) {
            return c.rim * (PULSAR_ROCK_LIT[0]
                + PULSAR_ROCK_LIT[1] * bd.mottle(x / PULSAR_ROCK_LIT[2], y / PULSAR_ROCK_LIT[2], 1));
        }
        return PULSAR_ROCK_BODY[0] + PULSAR_ROCK_BODY[1]
            * bd.mottle(x / PULSAR_ROCK_BODY[2], y / PULSAR_ROCK_BODY[3], 1);
    }
    return -1;
}

/** Where the near silhouette's skyline runs, in logical y, at a box x. */
function pulsarSilhouette(bd, bx) {
    return bd.H * PULSAR_SIL.at
        + PULSAR_SIL.sine[0] * Math.sin(bx / PULSAR_SIL.sine[1] + PULSAR_SIL.sine[2])
        + PULSAR_SIL.noise[0] * bd.sil(bx / PULSAR_SIL.noise[1], PULSAR_SIL.noise[2], 2);
}

/**
 * Everything above the near depth: two nebula sheets, the eight radial spikes,
 * the two torus rings and the jets. All of it a pure function of position, and
 * all of it what the place has never had -- the entry was a beam and a dot on
 * black, and emptiness was the defect.
 */
function pulsarSky(bd, x, y) {
    const qx = x - bd.sx;
    const qy = y - bd.sy;
    // Box coordinates for the noise, so the seeded layouts sit where the study
    // tuned them rather than sliding with the arena's own origin.
    const bx = x - bd.x0;
    const by = y - bd.y0;
    const dist = Math.hypot(qx, qy);
    const N = PULSAR_NEB;
    const mask = clamp(bd.mask(bx / N.mask, by / N.mask, 2) * N.maskCut[0] - N.maskCut[1], 0, 1);
    const illum = N.illum[0] + N.illum[1] * Math.exp(-dist / N.illum[2]);
    let v = Math.pow(clamp(bd.neb(bx / N.scale, by / N.scale, 4) * N.cut[0] - N.cut[1], 0, 1), N.gamma)
        * mask * illum * N.amp;
    if (dist > 6) {
        const ang = Math.atan2(qy, qx);
        v += Math.pow(Math.abs(Math.cos(ang * PULSAR_SPIKE.lobes)), PULSAR_SPIKE.sharp)
            * PULSAR_SPIKE.amp * Math.exp(-dist / PULSAR_SPIKE.fall);
    }
    // The torus lies in the plane perpendicular to the rotation axis, so its
    // projection is exact and cheap: the inverse matrix gives the radius
    // through any pixel, and the same two numbers give the angle -- hence
    // which half of the ring is in front.
    const tx = PULSAR_IM[0] * qx + PULSAR_IM[1] * qy;
    const ty = PULSAR_IM[2] * qx + PULSAR_IM[3] * qy;
    const r = Math.hypot(tx, ty);
    if (r > 1 && r < 700) {
        const ct = tx / r;
        const st = ty / r;
        const face = PULSAR_U[2] * ct + PULSAR_V[2] * st > 0 ? PULSAR_FACE[0] : PULSAR_FACE[1];
        const fil = PULSAR_FIL[0] + PULSAR_FIL[1] * bd.fil(ct * PULSAR_FIL[2] + 4,
            st * PULSAR_FIL[2] + 9 + r / PULSAR_FIL[3], 3);
        for (const ring of PULSAR_TORUS) {
            const d = (r - ring[0]) / ring[1];
            v += Math.exp(-d * d) * ring[2] * face * fil;
        }
    }
    const l = qx * PULSAR_JETD[0] + qy * PULSAR_JETD[1];
    const al = Math.abs(l);
    if (al < PULSAR_JET.len) {
        const pd = Math.abs(qx * PULSAR_JETD[1] - qy * PULSAR_JETD[0]);
        const w = PULSAR_JET.w0 + PULSAR_JET.flare * al;
        if (pd < w) {
            const knot = PULSAR_JET.knot[0] + PULSAR_JET.knot[1]
                * bd.knot(al / PULSAR_JET.knot[2], l > 0 ? 3 : 91, 2);
            const across = 1 - pd / w;
            v += across * across * Math.pow(1 - al / PULSAR_JET.len, PULSAR_JET.fall)
                * PULSAR_JET.amp * knot;
        }
    }
    return v;
}

/** The five depths at a point, near to far: silhouette, belt, then the sky. */
function pulsarPlate(bd, x, y) {
    const top = pulsarSilhouette(bd, x - bd.x0);
    if (y > top) {
        return y - top < PULSAR_SIL.lip ? PULSAR_SIL.lipV : PULSAR_SIL.v;
    }
    const rock = pulsarRock(bd, x - bd.x0, y - bd.y0);
    return rock >= 0 ? rock : pulsarSky(bd, x, y);
}

/** True where the near depths are solid, so a star behind them cannot show. */
function pulsarSolid(bd, x, y) {
    return y > pulsarSilhouette(bd, x - bd.x0) || pulsarRock(bd, x - bd.x0, y - bd.y0) >= 0;
}

/**
 * The two beams at a rotation phase. They are `+m` and `-m` of one magnetic
 * axis, so on screen they are exactly antipodal -- a bar, whose direction
 * makes a full turn once per rotation and whose reach is foreshortened by
 * `sqrt(1 - s^2)`: the beam turned toward the camera is short and dim, and
 * what it stops spending on the arena lands on the core instead. Total light
 * leaving the frame stays near constant; only its distribution moves.
 *
 * @param {number} phi - rotation phase, radians
 * @returns {Array<object>} screen direction, reach, amplitude and pulse
 */
function pulsarBeams(phi) {
    const sa = Math.sin(PULSAR_ALPHA);
    const ca = Math.cos(PULSAR_ALPHA);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const out = [];
    for (const sg of [1, -1]) {
        const mx = sg * (PULSAR_AXIS[0] * ca + (PULSAR_U[0] * c + PULSAR_V[0] * s) * sa);
        const my = sg * (PULSAR_AXIS[1] * ca + (PULSAR_U[1] * c + PULSAR_V[1] * s) * sa);
        const mz = sg * (PULSAR_AXIS[2] * ca + (PULSAR_U[2] * c + PULSAR_V[2] * s) * sa);
        const pl = Math.hypot(mx, my) || 1e-6;
        const inp = Math.sqrt(Math.max(0.02, 1 - mz * mz));
        out.push({
            dx: mx / pl, dy: my / pl,
            len: PULSAR_BEAM.len * inp,
            amp: PULSAR_BEAM.amp * (0.5 + 0.5 * inp),
            // How nearly this pole points at the camera, normalised by the
            // misalignment so the peak does not depend on it, and raised hard
            // enough that it is an arrival rather than a swell.
            pulse: Math.pow(clamp(mz / sa, 0, 1), PULSAR_PULSE_POW),
        });
    }
    return out;
}

/**
 * The wisps alive at a frame. One launches on every beam crossing and travels
 * outward through the torus, so the pulse is legible inside the play field as
 * a thing leaving rather than as everything brightening.
 *
 * They are seeded off the launch index, not stepped, which is what lets the
 * place keep no state and a still at frame 1500 be exact.
 *
 * @param {number} t - the frame counter
 * @returns {Array<object>} radius, amplitude and the seeded arcs of each
 */
function pulsarWisps(t) {
    const half = PULSAR_PERIOD / 2;
    const first = Math.floor(t / half);
    const out = [];
    for (let k = 0; k < 5; k++) {
        const idx = first - k;
        const age = t - idx * half;
        if (idx < 0 || age > PULSAR_WISP.life) {
            continue;
        }
        const r = PULSAR_WISP.r0 + PULSAR_WISP.v * age;
        if (r > PULSAR_WISP.rMax) {
            continue;
        }
        const rng = mulberry32(PULSAR_WISP.seed + idx * PULSAR_WISP.step);
        const arcs = [];
        for (let j = 0; j < PULSAR_WISP.arcs; j++) {
            arcs.push({ a: rng() * 6.2832, w: PULSAR_WISP.w[0] + rng() * PULSAR_WISP.w[1] });
        }
        out.push({
            r, arcs,
            amp: PULSAR_WISP.amp * Math.exp(-age / PULSAR_WISP.fade)
                * smoothstep(age, 0, PULSAR_WISP.rise),
        });
    }
    return out;
}

/**
 * Add a live contribution to one art pixel of the surface.
 *
 * `tag` identifies the element, so a cell an element's own rasterisation
 * reaches twice -- the quads of one wisp arc share their edges -- takes the
 * value once, while two different elements over the same cell still sum. The
 * high bits of the same number are the frame, which is what makes "was this
 * cell painted at all this frame" a single comparison in the resolve pass and
 * saves carrying a list of touched cells.
 */
function pulsarAdd(P, i, v, tag) {
    const st = P.stamp[i];
    if (st === tag) {
        return;
    }
    P.acc[i] = st < P.base ? v : P.acc[i] + v;
    P.stamp[i] = tag;
}

/**
 * The asteroid belt: about 150 discrete rocks on a jittered grid across the
 * near depth, scaling from small at the top of the band to large at the bottom
 * so the field recedes. Bucketed on a coarse grid, because 150 ellipse tests
 * per art pixel is 28 million over the box and the bucket takes it to two.
 */
function pulsarBelt(bd) {
    const rng = mulberry32(PULSAR_BELT.seed);
    const grid = PULSAR_BELT.grid;
    const y0 = bd.H * PULSAR_BELT.y0 - bd.y0;
    const y1 = bd.H * PULSAR_BELT.y1 - bd.y0;
    const starX = bd.sx - bd.x0;
    const starY = bd.sy - bd.y0;
    bd.rockW = Math.ceil(bd.w / PULSAR_BKT) + 1;
    bd.rocks = [];
    for (let gx = 0; gx * grid < bd.w; gx++) {
        for (let gy = 0; y0 + gy * grid < y1; gy++) {
            const n = rng() < PULSAR_BELT.single ? 1 : 2;
            for (let q = 0; q < n; q++) {
                const x = (gx + rng()) * grid;
                const y = y0 + (gy + rng()) * grid;
                if (y > y1) {
                    continue;
                }
                const depth = clamp((y - y0) / (y1 - y0), 0, 1);
                const s = PULSAR_BELT.scale[0] + depth * PULSAR_BELT.scale[1];
                const nx = starX - x;
                const ny = starY - y;
                const nl = Math.hypot(nx, ny) || 1;
                const c = {
                    x, y,
                    rx: (PULSAR_BELT.rx[0] + rng() * PULSAR_BELT.rx[1]) * s,
                    ry: (PULSAR_BELT.ry[0] + rng() * PULSAR_BELT.ry[1]) * s,
                    rim: PULSAR_BELT.rim[0] + depth * PULSAR_BELT.rim[1],
                    nx: nx / nl, ny: ny / nl,
                };
                const i0 = Math.floor((c.x - c.rx) / PULSAR_BKT);
                const i1 = Math.floor((c.x + c.rx) / PULSAR_BKT);
                const j0 = Math.floor((c.y - c.ry) / PULSAR_BKT);
                const j1 = Math.floor((c.y + c.ry) / PULSAR_BKT);
                for (let j = j0; j <= j1; j++) {
                    for (let i = i0; i <= i1; i++) {
                        if (i < 0 || j < 0 || i >= bd.rockW) {
                            continue;
                        }
                        const k = j * bd.rockW + i;
                        (bd.rocks[k] || (bd.rocks[k] = [])).push(c);
                    }
                }
            }
        }
    }
}

/**
 * Which baked cells carry a star, read back off the finished layer once.
 *
 * The live layer paints opaque art pixels over the plate, and a beam that
 * erased every star it crossed would read as the beam wiping the sky. A star
 * survives until the composite under it is brighter than the star itself,
 * which is the study's own rule. Reading the layer beats replaying the bake's
 * star loop: it is one pass, once, and it cannot drift from what was actually
 * painted -- and since the star ramp is its own palette, a colour match is
 * exact rather than a guess.
 */
function pulsarStarMap(bd) {
    const P = bd.pul;
    const map = new Int8Array(P.aw * P.ah).fill(-1);
    const src = bd.layer.getContext("2d").getImageData(0, 0, P.aw, P.ah).data;
    P.sramp = rampRGB(starRamp(bd));
    for (let i = 0; i < map.length; i++) {
        for (let k = 0; k < P.sramp.length; k++) {
            const c = P.sramp[k];
            if (src[i * 4] === c[0] && src[i * 4 + 1] === c[1] && src[i * 4 + 2] === c[2]) {
                map[i] = k;
                break;
            }
        }
    }
    P.star = map;
}

/** One beam cone, as the trapezoid it exactly is: four half-planes, no waste. */
function pulsarBeam(bd, b, tag) {
    const P = bd.pul;
    const hw0 = PULSAR_BEAM.hw;
    const hwF = hw0 + PULSAR_BEAM.flare * b.len;
    const nx = -b.dy;
    const ny = b.dx;
    const tipX = bd.sx + b.dx * b.len;
    const tipY = bd.sy + b.dy * b.len;
    const ax = (v) => (v - bd.x0) / ART_PIX;
    const ay = (v) => (v - bd.y0) / ART_PIX;
    artQuad(P, [
        ax(bd.sx - nx * hw0), ay(bd.sy - ny * hw0),
        ax(tipX - nx * hwF), ay(tipY - ny * hwF),
        ax(tipX + nx * hwF), ay(tipY + ny * hwF),
        ax(bd.sx + nx * hw0), ay(bd.sy + ny * hw0),
    ], (px, py) => {
        const qx = bd.x0 + (px + 0.5) * ART_PIX - bd.sx;
        const qy = bd.y0 + (py + 0.5) * ART_PIX - bd.sy;
        const along = qx * b.dx + qy * b.dy;
        if (along <= 0 || along > b.len) {
            return;
        }
        const perp = Math.abs(qx * b.dy - qy * b.dx);
        const hw = hw0 + PULSAR_BEAM.flare * along;
        if (perp > hw) {
            return;
        }
        pulsarAdd(P, py * P.aw + px, powLook(PULSAR_BEAM_PERP, 1 - perp / hw)
            * powLook(PULSAR_BEAM_ALONG, 1 - along / b.len) * b.amp, tag);
    });
}

/** The core and its halo. Both sit above the arena; the box is who sees them. */
function pulsarCore(bd, pulse) {
    const P = bd.pul;
    const C = PULSAR_CORE;
    const tag = P.base + 2;
    const cx = (bd.sx - bd.x0) / ART_PIX;
    const cy = (bd.sy - bd.y0) / ART_PIX;
    const r = C.cut / ART_PIX;
    const core = (C.base + C.peak * pulse) * C.amp;
    const halo = C.haloAmp * pulse;
    const yA = Math.max(0, Math.ceil(cy - r - 0.5));
    const yB = Math.min(P.ah - 1, Math.floor(cy + r - 0.5));
    for (let py = yA; py <= yB; py++) {
        const dy = py + 0.5 - cy;
        const w = Math.sqrt(Math.max(0, r * r - dy * dy));
        artRow(P, py, Math.ceil(cx - w - 0.5), Math.floor(cx + w - 0.5), (px, y) => {
            const ex = (px + 0.5 - cx) * ART_PIX;
            const ey = dy * ART_PIX;
            const d2 = ex * ex + ey * ey;
            pulsarAdd(P, y * P.aw + px,
                core * Math.exp(-d2 / (C.r * C.r)) + halo * Math.exp(-d2 / (C.halo * C.halo)), tag);
        });
    }
}

/**
 * One wisp: three seeded arcs of a ring travelling outward through the torus.
 *
 * Each arc is laid down as a strip of quads in torus coordinates rather than
 * scanned out of a bounding box -- an arc's box is four times its own area,
 * and the value at a cell costs an `atan2`. The quads share their edges, so
 * the element tag is what stops a cell on a seam being counted twice.
 */
function pulsarWisp(bd, w, tag) {
    const P = bd.pul;
    const band = PULSAR_WISP.band;
    const r0 = w.r - band;
    const r1 = w.r + band;
    const ox = (bd.sx - bd.x0) / ART_PIX;
    const oy = (bd.sy - bd.y0) / ART_PIX;
    const put = (px, py) => {
        const i = py * P.aw + px;
        if (P.stamp[i] === tag) {
            return;
        }
        const qx = bd.x0 + (px + 0.5) * ART_PIX - bd.sx;
        const qy = bd.y0 + (py + 0.5) * ART_PIX - bd.sy;
        const tx = PULSAR_IM[0] * qx + PULSAR_IM[1] * qy;
        const ty = PULSAR_IM[2] * qx + PULSAR_IM[3] * qy;
        const dr = Math.abs(Math.sqrt(tx * tx + ty * ty) - w.r);
        if (dr > band) {
            return;
        }
        const th = Math.atan2(ty, tx);
        let am = 0;
        for (const arc of w.arcs) {
            const d = Math.abs(((th - arc.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
            const k = 1 - clamp(d / arc.w, 0, 1);
            if (k > am) {
                am = k;
            }
        }
        if (am <= 0) {
            return;
        }
        pulsarAdd(P, i, powLook(PULSAR_WISP_DR, 1 - dr / band)
            * powLook(PULSAR_WISP_AM, am) * w.amp, tag);
    };
    for (const arc of w.arcs) {
        const n = Math.max(2, Math.ceil((2 * arc.w * r1) / (ART_PIX * 2)));
        let th = arc.a - arc.w;
        let c = Math.cos(th);
        let s = Math.sin(th);
        let e0x = ox + ((PULSAR_U[0] * c + PULSAR_V[0] * s) * r0) / ART_PIX;
        let e0y = oy + ((PULSAR_U[1] * c + PULSAR_V[1] * s) * r0) / ART_PIX;
        let e1x = ox + ((PULSAR_U[0] * c + PULSAR_V[0] * s) * r1) / ART_PIX;
        let e1y = oy + ((PULSAR_U[1] * c + PULSAR_V[1] * s) * r1) / ART_PIX;
        for (let i = 1; i <= n; i++) {
            th = arc.a - arc.w + (2 * arc.w * i) / n;
            c = Math.cos(th);
            s = Math.sin(th);
            const f0x = ox + ((PULSAR_U[0] * c + PULSAR_V[0] * s) * r0) / ART_PIX;
            const f0y = oy + ((PULSAR_U[1] * c + PULSAR_V[1] * s) * r0) / ART_PIX;
            const f1x = ox + ((PULSAR_U[0] * c + PULSAR_V[0] * s) * r1) / ART_PIX;
            const f1y = oy + ((PULSAR_U[1] * c + PULSAR_V[1] * s) * r1) / ART_PIX;
            artQuad(P, [e0x, e0y, f0x, f0y, f1x, f1y, e1x, e1y], put);
            e0x = f0x;
            e0y = f0y;
            e1x = f1x;
            e1y = f1y;
        }
    }
}

/* -------------------------------------------------------------------------- */
/* OCEAN WORLD                                                                 */
/* -------------------------------------------------------------------------- */

/** The rung a live element lands on, dithered exactly the way the bake is. */
function oceanRung(bd, v, ax, ay, cap) {
    const bay = (BAYER[(ay & 3) * 4 + (ax & 3)] / 16 - 0.46) * DITHER;
    return clamp(Math.round(v * (bd.rgb.length - 1) + bay), 0, cap);
}

/**
 * The rung cap at a logical y, and it is two caps taking the smaller.
 *
 * Depth is physics: near water is seen at a steeper angle and gives back less
 * sky. The arena band is not -- it holds the bottom 200 px of the play field
 * two rungs under the rest, where the player sits and where everything that
 * can kill them arrives. Doing it in the cap rather than in the veil is what
 * lets this place carry a bright sky at all.
 */
function oceanCap(bd, y) {
    if (y < bd.hz) {
        return 6;
    }
    const dy = y - bd.hz;
    let depth = OCEAN_CAP_FLOOR;
    for (const step of OCEAN_CAP_DEPTH) {
        if (dy < step[0]) {
            depth = step[1];
            break;
        }
    }
    let band = 6;
    for (const step of OCEAN_CAP_BAND) {
        if (y > step[0]) {
            band = step[1];
            break;
        }
    }
    return Math.min(depth, band);
}

/** Sky above the horizon on the first ramp, water below it on the second. */
function oceanPlate(bd, x, y) {
    const bloom = x - bd.bloom;
    if (y < bd.hz) {
        const t = clamp((y - bd.y0) / (bd.hz - bd.y0), 0, 1);
        const dx = bloom / OCEAN_SKY_BLOOM[1];
        const dy = (y - (bd.hz - OCEAN_SKY_BLOOM[3])) / OCEAN_SKY_BLOOM[2];
        return {
            v: OCEAN_SKY[0] + OCEAN_SKY[1] * Math.pow(t, OCEAN_SKY[2])
                + OCEAN_SKY_BLOOM[0] * Math.exp(-(dx * dx + dy * dy)),
            sea: false,
        };
    }
    const dy = y - bd.hz;
    const dx = bloom / OCEAN_SEA_BLOOM[2];
    const u = Math.pow(clamp(dy / bd.wh, 0, 1), 1 / OCEAN_PERSP);
    return {
        v: OCEAN_WATER[0] * Math.pow(1 - u, OCEAN_WATER[1]) + OCEAN_WATER[2]
            + OCEAN_SEA_BLOOM[0] * Math.exp(-dy / (OCEAN_SEA_BLOOM[1] * bd.wh)) * Math.exp(-dx * dx),
        sea: true,
    };
}

/** How much cloud one layer puts over a point: two or three banks summed. */
function oceanCloud(bd, x, y, layer) {
    const k = 6.2832 / bd.w;
    const bx = x - bd.x0;
    const span = bd.hz - bd.y0;
    let cov = 0;
    for (const b of OCEAN_BANKS[layer]) {
        const p = OCEAN_BANK_P[0] + OCEAN_BANK_P[0] * Math.sin(k * b[3] * bx + b[3] * 1.7)
            + OCEAN_BANK_P[1] * Math.sin(k * (b[3] * 2 + 1) * bx + b[3] * 0.9);
        const d = (y - (bd.y0 + b[0] * span)) / b[1];
        cov += b[2] * (Math.max(0, p - OCEAN_BANK_P[2]) / OCEAN_BANK_P[3]) * Math.exp(-d * d);
    }
    return Math.min(1, cov);
}

/**
 * The crest rows down the water. Everything about a row -- where it lands, how
 * long its dashes are, how far apart, how tall, and how fast it travels -- is
 * a function of `u`, which is what keeps the five depths agreeing.
 */
function oceanRows(bd) {
    const out = [];
    for (let i = 0; i < OCEAN_ROWS; i++) {
        const u = (i + 0.5) / OCEAN_ROWS;
        let band = OCEAN_BANDS.length;
        for (let b = 0; b < OCEAN_BANDS.length; b++) {
            if (u < OCEAN_BANDS[b]) {
                band = b;
                break;
            }
        }
        out.push({
            u, band,
            y: bd.hz + bd.wh * Math.pow(u, OCEAN_PERSP),
            l: OCEAN_DASH_L[0] + OCEAN_DASH_L[1] * Math.pow(u, OCEAN_DASH_L[2]),
            g: OCEAN_DASH_G[0] + OCEAN_DASH_G[1] * Math.pow(u, OCEAN_DASH_G[2]),
            h: u < OCEAN_DASH_H[0] ? OCEAN_DASH_H[1] : OCEAN_DASH_H[2],
            rate: OCEAN_RATES[band],
        });
    }
    return out;
}

/**
 * A wrapping strip of art cells, as rungs. `0` is transparent and any other
 * value is the rung plus one, so a strip is a byte per art pixel rather than
 * four -- and the reflection can read the sky's rungs back without a canvas
 * readback, which is what lets it be written as art pixels instead of blitted
 * through a negative scale.
 */
function oceanStrip(aw, ah, top, rate) {
    return { rung: new Uint8Array(aw * ah), aw, ah, top, rate };
}

/** One cloud layer, baked. `refl` bakes the dimmer copy the swell gives back. */
function oceanCloudStrip(bd, layer, refl) {
    const span = bd.hz - bd.y0;
    const top = bd.y0 + OCEAN_CLOUD_SPAN[layer][0] * span;
    const bot = bd.y0 + OCEAN_CLOUD_SPAN[layer][1] * span;
    const s = oceanStrip(Math.max(1, Math.ceil(bd.w / ART_PIX)),
        Math.max(1, Math.ceil((bot - top) / ART_PIX)), top, OCEAN_CLOUD_RATE[layer]);
    const cut = refl ? OCEAN_REFLECT.cut : OCEAN_CLOUD_CUT;
    const gain = refl ? OCEAN_REFLECT.gain : 1;
    for (let ay = 0; ay < s.ah; ay++) {
        const y = top + (ay + 0.5) * ART_PIX;
        const base = OCEAN_SKY[0] + OCEAN_SKY[1]
            * Math.pow(clamp((y - bd.y0) / span, 0, 1), OCEAN_SKY[2]);
        for (let ax = 0; ax < s.aw; ax++) {
            const cov = oceanCloud(bd, bd.x0 + (ax + 0.5) * ART_PIX, y, layer);
            if (cov < cut) {
                continue;
            }
            s.rung[ay * s.aw + ax] =
                oceanRung(bd, (base + OCEAN_CLOUD_AMP * cov) * gain, ax, ay, OCEAN_CLOUD_CAP) + 1;
        }
    }
    return s;
}

/** A strip as a canvas, for the two layers that are blitted rather than read. */
function oceanStripCanvas(s, ramp) {
    const cv = document.createElement("canvas");
    cv.width = s.aw;
    cv.height = s.ah;
    const g = cv.getContext("2d");
    const img = g.createImageData(s.aw, s.ah);
    for (let i = 0; i < s.rung.length; i++) {
        if (!s.rung[i]) {
            continue;
        }
        const c = ramp[s.rung[i] - 1];
        img.data[i * 4] = c[0];
        img.data[i * 4 + 1] = c[1];
        img.data[i * 4 + 2] = c[2];
        img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return cv;
}

/**
 * One of the three far bands, baked: rows of crest dashes that only ever
 * scroll. Far water has no business breathing -- at that distance a crest is
 * a mark, and what says how far away it is is how slowly the mark travels.
 */
function oceanFarStrip(bd, band, rows) {
    const rs = rows.filter((r) => r.band === band);
    if (!rs.length) {
        return null;
    }
    const top = rs[0].y - 8;
    const s = oceanStrip(Math.max(1, Math.ceil(bd.w / ART_PIX)),
        Math.max(1, Math.ceil((rs[rs.length - 1].y + 10 - top) / ART_PIX)), top, OCEAN_RATES[band]);
    for (let ri = 0; ri < rs.length; ri++) {
        const r = rs[ri];
        const p = r.l + r.g;
        const rng = mulberry32(OCEAN_FAR.seed[0] * (band + 1) + OCEAN_FAR.seed[1] * ri);
        const ay = Math.floor((r.y - top) / ART_PIX);
        const cap = oceanCap(bd, r.y);
        const n = Math.ceil(bd.w / p) + 1;
        for (let ci = 0; ci < n; ci++) {
            const x0 = (ci * p + rng() * p * OCEAN_FAR.jitter) % bd.w;
            const len = Math.max(ART_PIX, r.l * (OCEAN_FAR.len[0] + OCEAN_FAR.len[1] * rng()));
            const body = OCEAN_FAR.body[0] + OCEAN_FAR.body[1] * rng();
            const crest = rng() < OCEAN_FAR.crest;
            const ax0 = Math.floor(x0 / ART_PIX);
            const axn = Math.max(1, Math.round(len / ART_PIX));
            for (let k = 0; k < axn; k++) {
                const ax = (ax0 + k) % s.aw;
                s.rung[ay * s.aw + ax] = oceanRung(bd, body, ax, ay, cap) + 1;
                if (crest && k > 0 && k < axn - 1 && ay > 0) {
                    s.rung[(ay - 1) * s.aw + ax] =
                        oceanRung(bd, OCEAN_FAR.crestV, ax, ay - 1, cap) + 1;
                }
            }
        }
    }
    return s;
}

/** The near crest lines, the glitter path, the foam and the spores. */
function oceanLists(bd, rows) {
    const near = mulberry32(OCEAN_NEAR.seed);
    bd.oc.dashes = [];
    const rs = rows.filter((r) => r.band >= OCEAN_BANDS.length - 1);
    for (let ri = 0; ri < rs.length; ri++) {
        const r = rs[ri];
        const p = r.l + r.g;
        const n = Math.ceil(bd.w / p) + 1;
        for (let c = 0; c < n; c++) {
            bd.oc.dashes.push({
                y: r.y, h: r.h, rate: r.rate,
                x0: (c * p + near() * p * OCEAN_NEAR.jitter) % bd.w,
                len: r.l * (OCEAN_NEAR.len[0] + OCEAN_NEAR.len[1] * near()),
                ph: near(),
                fr: OCEAN_NEAR.fr[0] + near() * OCEAN_NEAR.fr[1],
                crest: near() < OCEAN_NEAR.crest,
            });
        }
    }
    const gr = mulberry32(OCEAN_GLITTER.seed);
    bd.oc.glitter = [];
    for (let i = 0; i < OCEAN_GLITTER.n; i++) {
        const u = OCEAN_GLITTER.u[0] + OCEAN_GLITTER.u[1] * ((i + gr()) / OCEAN_GLITTER.n);
        const w = OCEAN_GLITTER.w[0] + OCEAN_GLITTER.w[1] * u;
        bd.oc.glitter.push({
            u, w,
            y: bd.hz + bd.wh * Math.pow(u, OCEAN_PERSP),
            x: bd.bloom + (gr() - 0.5) * 2 * w,
            len: OCEAN_GLITTER.len[0] + OCEAN_GLITTER.len[1] * u,
            fr: OCEAN_GLITTER.fr[0] + gr() * OCEAN_GLITTER.fr[1],
            ph: gr() * 6.2832,
            jr: OCEAN_GLITTER.jr[0] + gr() * OCEAN_GLITTER.jr[1],
        });
    }
    const fr = mulberry32(OCEAN_FOAM.seed);
    bd.oc.foam = [];
    for (let i = 0; i < OCEAN_FOAM.n; i++) {
        const u = OCEAN_FOAM.u[0] + OCEAN_FOAM.u[1] * fr();
        let band = OCEAN_BANDS.length;
        for (let b = 0; b < OCEAN_BANDS.length; b++) {
            if (u < OCEAN_BANDS[b]) {
                band = b;
                break;
            }
        }
        bd.oc.foam.push({
            y: bd.hz + bd.wh * Math.pow(u, OCEAN_PERSP),
            x: fr() * bd.w, rate: OCEAN_RATES[band],
            cycle: OCEAN_FOAM.cycle[0] + Math.round(fr() * OCEAN_FOAM.cycle[1]),
            life: OCEAN_FOAM.life[0] + Math.round(fr() * OCEAN_FOAM.life[1]),
            off: Math.round(fr() * OCEAN_FOAM.off),
            w: OCEAN_FOAM.w[0] + OCEAN_FOAM.w[1] * fr(),
        });
    }
    const sr = mulberry32(OCEAN_SPORE.seed);
    bd.oc.spores = [];
    for (let i = 0; i < OCEAN_SPORE.n; i++) {
        const u = OCEAN_SPORE.u[0] + OCEAN_SPORE.u[1] * sr();
        bd.oc.spores.push({
            x: sr() * bd.w,
            y0: bd.hz + bd.wh * Math.pow(u, OCEAN_PERSP),
            size: u > OCEAN_SPORE.big ? OCEAN_SPORE.size[1] : OCEAN_SPORE.size[0],
            rate: OCEAN_SPORE.rate[0] + sr() * OCEAN_SPORE.rate[1],
            span: OCEAN_SPORE.span[0] + sr() * OCEAN_SPORE.span[1],
            ph: sr() * 1000,
            sway: OCEAN_SPORE.sway[0] + sr() * OCEAN_SPORE.sway[1],
            amp: OCEAN_SPORE.amp[0] + sr() * OCEAN_SPORE.amp[1],
        });
    }
}

/**
 * One art cell of the live surface, clipped to the band.
 *
 * The band is what gets cleared and uploaded, so a write outside it would be
 * a smear that never goes away -- and its top edge is the horizon, which is
 * also what keeps the first far band's crest row out of the sky. Drawn
 * without it, that row put a comb of water-ramp notches along the skyline.
 */
function oceanPix(S, x, y, c) {
    if (x < 0 || x >= S.aw || y < S.y0 || y > S.y1) {
        return;
    }
    const o = (y * S.aw + x) * 4;
    S.data[o] = c[0];
    S.data[o + 1] = c[1];
    S.data[o + 2] = c[2];
    S.data[o + 3] = 255;
}

/**
 * A live element, snapped to the art lattice and taking one rung for the whole
 * rect. Dithering it per cell would turn a crest line into a halftone; the
 * rung comes off its own origin, which is what gives two dashes at the same
 * value different weights and stops a row reading as a ruler.
 */
function oceanRect(S, bd, x, y, w, h, v, ramp) {
    const ax = Math.round((x - bd.x0) / ART_PIX);
    const ay = Math.round((y - bd.y0) / ART_PIX);
    oceanBlock(S, ax, ay, w, h, ramp[oceanRung(bd, v, ax, ay, oceanCap(bd, y))]);
}

function oceanBlock(S, ax, ay, w, h, c) {
    const cw = Math.max(1, Math.round(w / ART_PIX));
    const ch = Math.max(1, Math.round(h / ART_PIX));
    for (let j = 0; j < ch; j++) {
        for (let i = 0; i < cw; i++) {
            oceanPix(S, ax + i, ay + j, c);
        }
    }
}

/**
 * The three colours a point light on this water is allowed to be, and they are
 * not the star ramp everywhere: under the arena band cap a glitter dash or a
 * spore drops onto the water's own ramp instead, so nothing bright survives
 * into the bottom of the play field. It is `starRamp` gated by `oceanCap`.
 */
function oceanStarRGB(bd, y, level) {
    const cap = oceanCap(bd, y);
    if (cap <= 3) {
        return bd.rgbAlt[3];
    }
    return cap <= 4 ? bd.rgbAlt[5] : bd.oc.sramp[level];
}

/** The same three colours as CSS, for the one live element drawn on screen. */
function oceanStarCss(bd, y, level) {
    const cap = oceanCap(bd, y);
    if (cap <= 3) {
        return bd.p.landRamp[3];
    }
    return cap <= 4 ? bd.p.landRamp[5] : starRamp(bd)[level];
}

/**
 * The sky, again, upside down under the horizon.
 *
 * The study blits the low cloud strip through a negative vertical scale in
 * four sheared slices. Written as art pixels instead it costs no rasterising
 * call at all, lands exactly on the lattice a -0.32 scale would have missed,
 * and the four hard slices become a continuous swell running down the
 * reflection -- the shear is a function of how far down the source row is
 * rather than of which quarter it fell in.
 */
function oceanReflect(bd, t) {
    const S = bd.oc.surf;
    const R = bd.oc.reflect;
    const sh = OCEAN_REFLECT.shear;
    const strip = R.ah * ART_PIX;
    const off = (t * R.rate) % (R.aw * ART_PIX);
    const back = (y) => bd.hz - (y - bd.hz) / OCEAN_REFLECT.squash - R.top;
    for (let ay = S.y0; ay <= S.y1; ay++) {
        const sp = back(bd.y0 + (ay + 0.5) * ART_PIX);
        if (sp < 0) {
            continue;
        }
        // Three source rows fold into one destination row at this squash, so
        // a point sample throws two thirds of the sky away -- and this sky is
        // 4% cloud, so what came back was a whisper. Take the brightest row of
        // the range instead: it is the same three reads either way.
        const rA = clamp(Math.floor(back(bd.y0 + (ay + 1) * ART_PIX) / ART_PIX), 0, R.ah - 1);
        const rB = clamp(Math.floor(back(bd.y0 + ay * ART_PIX) / ART_PIX), 0, R.ah - 1);
        const kk = (4 * sp) / strip;
        const shear = Math.sin(t * sh[1] + kk * sh[2]) * sh[0] + Math.sin(t * sh[4] + kk * sh[5]) * sh[3];
        const shift = (off - shear) / ART_PIX;
        for (let ax = 0; ax < S.aw; ax++) {
            let sa = Math.floor(ax + shift) % R.aw;
            if (sa < 0) {
                sa += R.aw;
            }
            let r = 0;
            for (let sr = rA; sr <= rB; sr++) {
                const v = R.rung[sr * R.aw + sa];
                if (v > r) {
                    r = v;
                }
            }
            if (r) {
                oceanPix(S, ax, ay, bd.rgb[r - 1]);
            }
        }
    }
}

/** The three far bands, each scrolled by its own rung of the rate ladder. */
function oceanFar(bd, t) {
    const S = bd.oc.surf;
    for (const F of bd.oc.far) {
        const shift = Math.floor(((t * F.rate) % (F.aw * ART_PIX)) / ART_PIX);
        const ay0 = Math.round((F.top - bd.y0) / ART_PIX);
        for (let fy = 0; fy < F.ah; fy++) {
            const ay = ay0 + fy;
            if (ay < 0 || ay >= S.ah) {
                continue;
            }
            const row = fy * F.aw;
            for (let ax = 0; ax < S.aw; ax++) {
                const r = F.rung[row + ((ax + shift) % F.aw)];
                if (r) {
                    oceanPix(S, ax, ay, bd.rgbAlt[r - 1]);
                }
            }
        }
    }
}

/**
 * The two near bands, which are the only thing on this water that is alive.
 *
 * A dash lengthens and shortens on its own rate inside a swell the whole band
 * shares, and below `cut` it is not drawn at all -- that is what makes a crest
 * line break and reform rather than crawl. Unlike the study a dash that runs
 * off the right edge is drawn again at the left rather than being moved, so
 * the seam does not lose one.
 */
function oceanNear(bd, t) {
    const S = bd.oc.surf;
    const N = OCEAN_NEAR;
    const set = clamp(N.set[0] + N.set[1] * Math.sin(t * N.set[2])
        + N.set[3] * Math.sin(t * N.set[4] + N.set[5]), 0, 1);
    for (const d of bd.oc.dashes) {
        const amp = (0.5 + 0.5 * Math.sin(t * d.fr + d.ph * 6.2832)) * (N.amp[0] + N.amp[1] * set);
        if (amp < N.cut) {
            continue;
        }
        let x = (d.x0 + t * d.rate) % bd.w;
        if (x < 0) {
            x += bd.w;
        }
        const len = Math.max(ART_PIX, d.len * (N.grow[0] + N.grow[1] * amp));
        const v = N.v[0] + N.v[1] * amp;
        const crest = d.crest && amp > N.crestAt;
        for (let k = 0; k < 2; k++) {
            if (k && x + len <= bd.w) {
                break;
            }
            const px = bd.x0 + x - k * bd.w;
            oceanRect(S, bd, px, d.y, len, d.h, v, bd.rgbAlt);
            if (crest) {
                oceanRect(S, bd, px + ART_PIX, d.y - ART_PIX, len - ART_PIX * 2, ART_PIX,
                    N.crestV, bd.rgbAlt);
            }
        }
    }
}

/** The sun's path, broken on the surface: a column of flickering dashes. */
function oceanGlitter(bd, t) {
    const S = bd.oc.surf;
    for (const gl of bd.oc.glitter) {
        if (Math.sin(t * gl.fr + gl.ph) < OCEAN_GLITTER.on) {
            continue;
        }
        const x = gl.x + Math.sin(t * gl.jr + gl.ph) * gl.w * OCEAN_GLITTER.jitter;
        oceanBlock(S, Math.round((x - bd.x0) / ART_PIX), Math.round((gl.y - bd.y0) / ART_PIX),
            gl.len, ART_PIX, oceanStarRGB(bd, gl.y, gl.u < 0.2 ? 1 : 0));
    }
}

/** Foam: born where a crest breaks, alive for 40-90 frames, then gone. */
function oceanFoam(bd, t) {
    const S = bd.oc.surf;
    for (const fm of bd.oc.foam) {
        const age = (t + fm.off) % fm.cycle;
        if (age > fm.life) {
            continue;
        }
        const e = Math.sin((Math.PI * age) / fm.life);
        if (e < OCEAN_FOAM.on) {
            continue;
        }
        let x = (fm.x + t * fm.rate) % bd.w;
        if (x < 0) {
            x += bd.w;
        }
        const ax = Math.round(x / ART_PIX);
        const ay = Math.round((fm.y - bd.y0) / ART_PIX);
        oceanBlock(S, ax, ay, fm.w * (0.5 + 0.5 * e), ART_PIX, oceanStarRGB(bd, fm.y, 0));
        if (e > OCEAN_FOAM.crestAt) {
            oceanBlock(S, ax + 1, ay - 1, fm.w * 0.5, ART_PIX,
                oceanStarRGB(bd, fm.y - ART_PIX, 1));
        }
    }
}

/**
 * Spores lifting off the crests. The one live element left on the screen
 * context rather than in the surface: they are the only thing that leaves the
 * water and crosses the sky, and keeping them an explicit short list is worth
 * a rasterising call each -- they are also the only thing here small enough
 * and bright enough to have to be checked against the bullets.
 */
function oceanSpores(bd, g, t) {
    for (const sp of bd.oc.spores) {
        const age = (t * sp.rate + sp.ph) % sp.span;
        if (1 - age / sp.span < OCEAN_SPORE.fade) {
            continue;
        }
        const y = sp.y0 - age;
        g.fillStyle = oceanStarCss(bd, y, 0);
        g.fillRect(snapTo(bd.x0, bd.x0 + sp.x + Math.sin(t * sp.sway + sp.ph) * sp.amp),
            snapTo(bd.y0, y), sp.size, sp.size);
    }
}

/* -------------------------------------------------------------------------- */
/* ION STORM                                                                   */
/* -------------------------------------------------------------------------- */

/** The seven curtains and their ray tables, drawn once from the one seed. */
function ionCurtains(bd) {
    const rng = mulberry32(ION_SEED);
    const out = [];
    for (let i = 0; i < ION_CURTAINS; i++) {
        const half = (ION_WIDTH[0] + rng() * ION_WIDTH[1]) / 2;
        const c = {
            cx: bd.x0 + (bd.w * (i + 0.5)) / ION_CURTAINS + (rng() - 0.5) * ION_CX_JITTER,
            half,
            // Four green curtains and three cyan, and a curtain's colour is
            // the two ramps mixed at the same rung -- one lattice, two ramps.
            tint: i % 2 === 0 ? 0.1 + rng() * 0.22 : 0.74 + rng() * 0.2,
            slideAmp: ION_SLIDE[0] + rng() * ION_SLIDE[1],
            slidePer: ION_SLIDE[2] + rng() * ION_SLIDE[3],
            slidePh: rng(),
            leanAmp: ION_LEAN[0] + rng() * ION_LEAN[1],
            leanPer: ION_LEAN[2] + rng() * ION_LEAN[3],
            leanPh: rng(),
            foldAmp: ION_FOLD[0] + rng() * ION_FOLD[1],
            foldWave: 6.2832 / (ION_FOLD[2] + rng() * ION_FOLD[3]),
            foldRate: ION_FOLD[4] + rng() * ION_FOLD[5],
        };
        c.cells = Math.ceil((2 * half) / ART_PIX) + 1;
        const n = Math.ceil((2 * half) / ION_PITCH) + 2;
        c.rate = new Float32Array(n);
        c.ph = new Float32Array(n);
        c.w = new Float32Array(n);
        c.gain = new Float32Array(n);
        // The 1-D profile across the curtain, rebuilt once a frame: everything
        // that depends on the distance from the spine rather than on where the
        // spine currently is. It is what takes the per-pixel cost from a dozen
        // operations to a multiply and a lookup.
        c.prof = new Float32Array(c.cells);
        for (let k = 0; k < n; k++) {
            c.rate[k] = 1 / (ION_RAY_PERIOD[0] + rng() * ION_RAY_PERIOD[1]);
            c.ph[k] = (k * ION_RAY_PHASE[0] + rng() * ION_RAY_PHASE[1] + (k % 2) * 0.5) % 1;
            c.w[k] = ION_RAY_W[0] + rng() * ION_RAY_W[1];
        }
        out.push(c);
    }
    bd.ion.patch = [];
    for (let i = 0; i < ION_PATCHES; i++) {
        bd.ion.patch.push({
            x: bd.x0 + bd.w * (ION_PATCH_X[0] + ION_PATCH_X[1] * i) + (rng() - 0.5) * ION_PATCH_X[2],
            y: bd.y0 + bd.h * (ION_PATCH_Y[0] + (rng() - 0.5) * ION_PATCH_Y[1]),
            rx: (ION_PATCH_R[0][0] + rng() * ION_PATCH_R[0][1]) / 2,
            ry: (ION_PATCH_R[1][0] + rng() * ION_PATCH_R[1][1]) / 2,
            per: ION_PATCH_PER[0] + rng() * ION_PATCH_PER[1],
            ph: rng(),
            driftPer: ION_PATCH_DRIFT[0] + rng() * ION_PATCH_DRIFT[1],
        });
    }
    return out;
}

/**
 * The breakup at a frame: which epoch, how far into it, and how strong.
 *
 * A pure function of the frame counter, which is what lets the place keep no
 * state at all and a still at frame 1500 be exact -- and it is why the
 * thumbnail does not need the event to be worth looking at.
 */
function ionBreakup(t) {
    const epoch = Math.floor(t / ION_BREAK.epoch);
    const ph = t - epoch * ION_BREAK.epoch;
    if (hash2(epoch * 7 + 3, 0, ION_SEED) >= ION_BREAK.chance || ph >= ION_BREAK.life) {
        return { a: 0, ph: 0, epoch };
    }
    const r = ION_BREAK.ramp;
    return { a: ph < r[0] ? ph / r[0] : ph < r[1] ? 1 : (ION_BREAK.life - ph) / r[2], epoch, ph };
}

/**
 * Everything that depends on the frame and not on the pixel: seven curtain
 * transforms, seven ray-gain tables, the 1-D profile each of them is sampled
 * through, and the patch grid. About 180 scalar gains and 380 profile cells a
 * frame, and then the per-pixel work is one multiply.
 */
function ionStep(bd, t) {
    const P = bd.ion;
    P.bu = ionBreakup(t);
    for (let i = 0; i < P.cur.length; i++) {
        const c = P.cur[i];
        c.slide = c.slideAmp * Math.sin(6.2832 * (t / c.slidePer + c.slidePh));
        c.lean = c.leanAmp * Math.sin(6.2832 * (t / c.leanPer + c.leanPh));
        // Two of the seven, and which two moves with the epoch.
        c.bu = (P.bu.epoch + i) % ION_CURTAINS < ION_BREAK.curtains ? P.bu.a : 0;
        c.fAmp = c.foldAmp * (1 + ION_BREAK_FX.fold * c.bu);
        c.fPhase = t * c.foldRate;
        const rr = 1 + ION_BREAK_FX.rate * c.bu;
        for (let k = 0; k < c.gain.length; k++) {
            const g = 0.5 + 0.5 * Math.sin(6.2832 * (t * c.rate[k] * rr + c.ph[k]));
            const h = ION_RAY_H[0] + ION_RAY_H[1]
                * Math.sin(6.2832 * (t * c.rate[k] * ION_RAY_H[2] * rr + c.ph[k] * ION_RAY_H[3]));
            c.gain[k] = (ION_RAY_GAIN[0] + ION_RAY_GAIN[1] * g * h) * c.w[k];
        }
        const boost = ION_FIELD_GAIN * (1 + ION_BREAK_FX.field * c.bu);
        for (let j = 0; j < c.cells; j++) {
            const u = j * ART_PIX - c.half;
            const e = 1 - Math.abs(u) / c.half;
            if (e <= 0) {
                c.prof[j] = 0;
                continue;
            }
            const up = (u + c.half) / ION_PITCH;
            const fr = up - Math.floor(up);
            c.prof[j] = (ION_ACROSS[0] + ION_ACROSS[1] * e * e) * c.gain[Math.floor(up)]
                * (fr > ION_CORE[0] && fr < ION_CORE[1] ? 1 : ION_CORE[2]) * boost;
        }
    }
    const G = P.grid;
    for (let i = 0; i < P.patch.length; i++) {
        const p = P.patch[i];
        p.cx = p.x + ION_PATCH_DRIFT[2] * Math.sin(6.2832 * (t / p.driftPer + p.ph));
        p.g = Math.pow(0.5 + 0.5 * Math.sin(6.2832 * (t / p.per + p.ph)), ION_PATCH_POW);
    }
    const step = ART_PIX * ION_PATCH_GRID;
    G.v.fill(0);
    for (let i = 0; i < P.patch.length; i++) {
        const p = P.patch[i];
        if (p.g <= 0) {
            continue;
        }
        // Only the grid cells the ellipse can reach: a patch is a fifth of the
        // arena, and most of a frame it is dark anyway.
        const x0 = Math.max(0, Math.floor((p.cx - p.rx - bd.x0) / step));
        const x1 = Math.min(G.w - 1, Math.ceil((p.cx + p.rx - bd.x0) / step));
        const y0 = Math.max(0, Math.floor((p.y - p.ry - bd.y0) / step));
        const y1 = Math.min(G.h - 1, Math.ceil((p.y + p.ry - bd.y0) / step));
        for (let gy = y0; gy <= y1; gy++) {
            const dy = (bd.y0 + gy * step - p.y) / p.ry;
            const dy2 = dy * dy;
            for (let gx = x0; gx <= x1; gx++) {
                const dx = (bd.x0 + gx * step - p.cx) / p.rx;
                const d = dx * dx + dy2;
                if (d < 1) {
                    G.v[gy * G.w + gx] += p.g * (1 - d) * ION_PATCH_GAIN[0];
                }
            }
        }
    }
    P.front = P.bu.a > 0
        ? bd.x0 + ((P.bu.epoch * ION_BREAK_FX.seed * ART_PIX) % bd.w) + P.bu.ph * ION_BREAK_FX.front[0]
        : 0;
}

/**
 * Lay the seven curtains down, a row at a time.
 *
 * The whole reason this is affordable is that a curtain's cross-section is a
 * pure function of the distance from its spine, so a row is the 1-D profile
 * shifted to wherever the spine is on that row -- one multiply and one lookup
 * per art pixel, against the dozen operations a "test every pixel against
 * every curtain" pass would spend, most of them outside every curtain.
 * The spine's offset is rounded to a whole art pixel, which is what the
 * lattice would have done to it anyway.
 */
function ionCurtainPass(bd) {
    const P = bd.ion;
    const pivot = bd.y0 + bd.h * ION_LEAN[4];
    const fr = ION_BREAK_FX.front;
    const acc = P.acc;
    const tacc = P.tacc;
    const stamp = P.stamp;
    const base = P.base;
    P.span.fill(-1);
    for (let ay = 0; ay < P.ah; ay++) {
        const y = bd.y0 + (ay + 0.5) * ART_PIX;
        const ny = (y - bd.y0) / bd.h;
        if (ny <= ION_ENV[0] || ny >= ION_ENV[2]) {
            continue;
        }
        const env = ny < ION_ENV[1]
            ? Math.pow((ny - ION_ENV[0]) / (ION_ENV[1] - ION_ENV[0]), ION_ENV[3])
            : Math.pow((ION_ENV[2] - ny) / (ION_ENV[2] - ION_ENV[1]), ION_ENV[4]);
        const row = ay * P.aw;
        for (let i = 0; i < P.cur.length; i++) {
            const c = P.cur[i];
            const off = c.cx + c.slide + c.lean * (y - pivot)
                + c.fAmp * Math.sin((y - bd.y0) * c.foldWave + c.fPhase);
            const a0 = Math.round((off - c.half - bd.x0) / ART_PIX);
            const tag = P.base + i;
            const jA = Math.max(0, -a0);
            const jB = Math.min(c.cells, P.aw - a0);
            if (jB <= jA) {
                continue;
            }
            if (P.span[ay * 2] < 0 || a0 + jA < P.span[ay * 2]) {
                P.span[ay * 2] = a0 + jA;
            }
            if (a0 + jB - 1 > P.span[ay * 2 + 1]) {
                P.span[ay * 2 + 1] = a0 + jB - 1;
            }
            const tint = c.tint;
            const prof = c.prof;
            const bu = c.bu;
            for (let j = jA; j < jB; j++) {
                const p = prof[j];
                if (p <= 0) {
                    continue;
                }
                let v = env * p;
                if (bu > 0) {
                    const dx = Math.abs(bd.x0 + (a0 + j) * ART_PIX - P.front);
                    if (dx < fr[1]) {
                        const w = 1 - dx / fr[1];
                        v += bu * fr[2] * w * w * env;
                    }
                }
                const i = row + a0 + j;
                if (stamp[i] < base) {
                    acc[i] = v;
                    tacc[i] = v * tint;
                    stamp[i] = tag;
                } else {
                    acc[i] += v;
                    tacc[i] += v * tint;
                    stamp[i] = tag;
                }
            }
        }
    }
}

/**
 * The horizon, in art rows, at art column `c`.
 *
 * It is never drawn. `field` asks per art pixel which side of this it is on,
 * so no dither can straddle it and the edge comes out one art pixel wide by
 * construction: rung 0 above, rung 7 below, #0a0b10 against #9db9c0. That is
 * the whole no-atmosphere claim, and it is a decision rather than a stroke.
 */
function moonHorizon(bd, c) {
    let j = 0;
    for (let k = 0; k < MOON_JAG.length; k++) {
        j += MOON_JAG[k][1] * (bd.jag(c / MOON_JAG[k][0], MOON_JAG_ROWS[k], 1) - 0.5);
    }
    const ridge = bd.jag(c / MOON_RIDGE[0], MOON_JAG_ROWS[3], 1);
    return bd.hr + (ridge > MOON_RIDGE[1] ? j - (ridge - MOON_RIDGE[1]) * MOON_RIDGE[2] : j);
}

/**
 * The ground, resolved once into two tables: the tone of the open plain, which
 * takes the dither, and -- where a pixel is not the plain -- the rung it is
 * pinned to. `field` is then a lookup, which is what lets 350 craters and 150
 * boulders be decided in the order they overlap rather than per pixel.
 */
function moonSurface(bd) {
    const aw = bd.aw;
    const ah = bd.ah;
    const yh = bd.yh;
    const tone = new Float32Array(aw * ah);
    // The un-cratered plain, kept beside it so two craters over one pixel step
    // from the ground rather than from each other.
    const plain = new Float32Array(aw * ah);
    const fixed = new Uint8Array(aw * ah);
    fixed.fill(MOON_FREE);
    for (let c = 0; c < aw; c++) {
        const top = Math.ceil(yh[c]);
        for (let r = 0; r < ah; r++) {
            const i = r * aw + c;
            if (r < top) {
                fixed[i] = 0;
                continue;
            }
            // One camera: the depth a row is at, and the world x it looks at.
            const dy = r - yh[c] + 0.5;
            const z = (MOON_FOC * MOON_CAMH) / Math.max(dy, 0.55);
            const wx = ((c - aw / 2) * z) / MOON_FOC;
            const v = MOON_TONE[0] - MOON_TONE[1] * Math.min(1, dy / MOON_TONE[2])
                + MOON_MOTTLE[0][2] * Math.sin(wx * MOON_MOTTLE[0][0])
                    * Math.sin(z * MOON_MOTTLE[0][1])
                + MOON_MOTTLE[1][2] * Math.sin(wx * MOON_MOTTLE[1][0] + z * MOON_MOTTLE[1][1]);
            tone[i] = v;
            plain[i] = v;
            if (r - top < MOON_RIM) {
                fixed[i] = MOON_RIM_RUNG;
            }
        }
    }
    bd.tone = tone;
    bd.fixed = fixed;
    moonCraters(bd, plain);
    moonBoulders(bd);
}

/**
 * 350 craters, authored per depth row rather than per screen pixel: `dy` is
 * skewed towards the horizon, so a uniform areal density in world space comes
 * out packing as it recedes. The screen half-width `a` is chosen and the
 * height `b = a * dy / f` follows from the camera -- a sliver at the line,
 * near-circular at the player's feet.
 *
 * Every tone written here is a rung *centre*. The Bayer term is +-0.4 of a
 * rung and a boundary is 0.5 away, so the dither cannot move one: a crater
 * edge is as hard as the horizon, and the dither's texture lives on the open
 * plain, which is deliberately left off the centres by its two mottles.
 */
function moonCraters(bd, plain) {
    const aw = bd.aw;
    const ah = bd.ah;
    const yh = bd.yh;
    const tone = bd.tone;
    const fixed = bd.fixed;
    const last = bd.rgb.length - 1;
    const cen = (k) => clamp(k, 0, last) / last;
    const rnd = mulberry32(MOON_CRATER_SEED);
    // The study authors its depth range against the arena. The box the camera
    // can reach for a colossus is 1.86x deeper than that, so the range follows
    // the box and the count follows the same power law: dy = D * u^p puts
    // N / (p * D^(1/p)) craters per row at the horizon, so holding that
    // density while D grows by k costs k^(1/p) of them. Anything else changes
    // the near-horizon density the study set by eye.
    const arena = ((bd.H - bd.H * MOON_HORIZON) / ART_PIX) * MOON_DEPTH;
    const span = Math.max(arena, (bd.y0 + bd.h - bd.H * MOON_HORIZON) / ART_PIX);
    const n = Math.round(MOON_CRATERS * Math.pow(span / arena, 1 / MOON_DY_SKEW));
    const craters = [];
    for (let i = 0; i < n; i++) {
        const dy = 0.6 + Math.pow(rnd(), MOON_DY_SKEW) * span;
        craters.push([dy, rnd() * aw + (rnd() - 0.5) * 40,
            MOON_CRATER_A[0] + Math.pow(rnd(), MOON_CRATER_A[1])
                * (MOON_CRATER_A[2] + dy * MOON_CRATER_A[3])]);
    }
    // The distant rim arcs. All of them sit inside the first 9 art rows, so
    // the deeper box does not change their count.
    for (let i = 0; i < MOON_ARCS; i++) {
        craters.push([MOON_ARC_DY[0] + Math.pow(rnd(), MOON_ARC_DY[1]) * MOON_ARC_DY[2],
            rnd() * aw,
            MOON_ARC_A[0] + Math.pow(rnd(), MOON_ARC_A[1]) * MOON_ARC_A[2]]);
    }
    // Far first, so a near crater is written over what is behind it.
    craters.sort((p, q) => p[0] - q[0]);
    for (const [dy, cc, a] of craters) {
        const b = (a * dy) / MOON_FOC;
        const cr = dy + yh[clamp(Math.round(cc), 0, aw - 1)];
        if (cc + a < -4 || cc - a > aw + 4 || cr - b > ah) {
            continue;
        }
        if (b < MOON_ARC_FLAT) {
            // Under an art pixel deep: a lit far arc and one dark row under
            // it, which is all a crater at that distance can be.
            const r0 = Math.round(cr);
            const c0 = Math.max(0, Math.floor(cc - a));
            const c1 = Math.min(aw - 1, Math.ceil(cc + a));
            for (let c = c0; c <= c1; c++) {
                const t = (c - cc) / a;
                if (Math.abs(t) > 1) {
                    continue;
                }
                if (r0 >= 0 && r0 < ah && r0 >= yh[c]) {
                    const i = r0 * aw + c;
                    if (fixed[i] === MOON_FREE) {
                        tone[i] = cen(Math.round(plain[i] * last) + (t < 0.4 ? 1 : 0));
                    }
                }
                if (r0 + 1 >= 0 && r0 + 1 < ah && r0 + 1 >= yh[c]) {
                    const i = (r0 + 1) * aw + c;
                    if (fixed[i] === MOON_FREE) {
                        tone[i] = cen(Math.round(plain[i] * last) - 1);
                    }
                }
            }
            continue;
        }
        const deep = Math.min(1, a / (14 + dy));
        const c0 = Math.max(0, Math.floor(cc - a));
        const c1 = Math.min(aw - 1, Math.ceil(cc + a));
        const r0 = Math.max(0, Math.floor(cr - b - 1));
        const r1 = Math.min(ah - 1, Math.ceil(cr + b + 1));
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                if (r < yh[c]) {
                    continue;
                }
                const u = (c - cc) / a;
                const v = (r - cr) / Math.max(b, 0.45);
                const d = u * u + v * v;
                if (d > 1.04) {
                    continue;
                }
                const i = r * aw + c;
                if (fixed[i] !== MOON_FREE) {
                    continue;
                }
                const k = Math.round(plain[i] * last);
                if (d > MOON_FLOOR_R) {
                    // The wall, against the one light direction the place has.
                    const lit = MOON_LIGHT[0] * u + MOON_LIGHT[1] * v;
                    tone[i] = cen(k + (lit > MOON_LIT ? 1 : lit < -MOON_LIT ? -2 : -1));
                } else {
                    tone[i] = cen(k - 2 - (deep > MOON_DEEP ? 1 : 0));
                }
            }
        }
    }
}

/**
 * Boulders and rim fragments: dark silhouettes on a pinned rung, each with one
 * long shadow running right. Their depths are drawn so that equal areas of
 * ground hold equal numbers, which is what makes them crowd the horizon
 * without being told to -- and the ones at `dy` under 1 are written *above*
 * the line, so the silhouette breaks the horizon instead of standing under it.
 */
function moonBoulders(bd) {
    const aw = bd.aw;
    const ah = bd.ah;
    const yh = bd.yh;
    const tone = bd.tone;
    const fixed = bd.fixed;
    // The near limit follows the box for the same reason the craters' range
    // does. The count does not: the wedge of ground it adds is 0.004% of the
    // area, so the density is unchanged at 150.
    const zmin = (MOON_FOC * MOON_CAMH)
        / ((bd.y0 + bd.h - bd.H * MOON_HORIZON) / ART_PIX);
    const rng = mulberry32(MOON_BOULDER_SEED);
    const list = [];
    for (let i = 0; i < MOON_BOULDERS; i++) {
        const z = Math.sqrt(rng() * (MOON_BOULDER_Z * MOON_BOULDER_Z - zmin * zmin)
            + zmin * zmin);
        list.push([z, (rng() * 2 - 1) * MOON_BOULDER_SPREAD * z,
            MOON_BOULDER_R[0] + Math.pow(rng(), MOON_BOULDER_R[1]) * MOON_BOULDER_R[2],
            rng()]);
    }
    list.sort((p, q) => q[0] - p[0]);
    for (const [z, wx, wr, jit] of list) {
        const dy = (MOON_FOC * MOON_CAMH) / z;
        const cc = Math.round(aw / 2 + (wx * MOON_FOC) / z);
        if (cc < -3 || cc > aw + 3) {
            continue;
        }
        const base = Math.round(dy + yh[clamp(cc, 0, aw - 1)]);
        const w = Math.max(1, Math.round((MOON_FOC * wr) / z));
        if (w > MOON_BOULDER_W || base > ah + 4) {
            continue;
        }
        const h = Math.max(1, Math.round(w * (1.1 + jit * 1.3)));
        for (let r = base - h; r <= base; r++) {
            const half = Math.max(0, Math.round(w * 0.5
                * (0.35 + (0.65 * (r - (base - h))) / Math.max(1, h))));
            for (let c = cc - half; c <= cc + half; c++) {
                if (c < 0 || c >= aw || r < 0 || r >= ah) {
                    continue;
                }
                fixed[r * aw + c] = r === base - h && h > 2
                    ? MOON_BOULDER_RUNG[1]
                    : MOON_BOULDER_RUNG[0];
            }
        }
        const sl = Math.round(h * MOON_SHADOW[0]);
        for (let k = 1; k <= sl; k++) {
            const c = cc + k;
            const r = base + Math.round(k * MOON_SHADOW[1]);
            if (c < 0 || c >= aw || r < 0 || r >= ah) {
                continue;
            }
            const i = r * aw + c;
            if (fixed[i] === MOON_FREE && r >= yh[c]) {
                tone[i] = Math.max(0.03, tone[i] - MOON_SHADOW[2] * (1 - k / sl));
            }
        }
    }
}

/**
 * Every impact live at frame `bd.t`. The schedule is a pure function of the
 * frame counter with no stored countdown, which is what lets the glossary
 * still be taken at frame 1500 without stepping there, keeps two clients in a
 * co-op match watching the same rock without a byte on the bus, and makes
 * pause and slow motion free.
 */
function moonEvents(bd) {
    const f = bd.t;
    const out = [];
    const k0 = Math.floor(f / MOON_PERIOD) - 6;
    for (let k = k0; k <= k0 + 8; k++) {
        if (k < 0) {
            continue;
        }
        const t0 = k * MOON_PERIOD
            + Math.floor(hash2(k, 0, MOON_EVENT_SEED) * MOON_JITTER * MOON_PERIOD)
            + MOON_LEAD;
        const age = f - t0;
        if (age <= -MOON_FALL || age >= MOON_LIFE) {
            continue;
        }
        const ix = MOON_EDGE + hash2(k, 1, MOON_EVENT_SEED) * (bd.aw - MOON_EDGE * 2);
        // Never in the 16 art rows under the line, where a crater would be
        // under a pixel deep and the scar would have nowhere to go.
        const top = moonHorizon(bd, ix) + MOON_DROP;
        out.push({
            k, age, ix,
            iy: top + hash2(k, 2, MOON_EVENT_SEED) * (bd.ah - MOON_BOTTOM - top),
        });
    }
    return out;
}

/** One art-pixel rectangle of the plane, in logical coordinates. */
function moonRect(bd, g, ac, ar, aw, ah) {
    g.fillRect(bd.x0 + Math.round(ac) * ART_PIX, bd.y0 + Math.round(ar) * ART_PIX,
        Math.max(1, Math.round(aw)) * ART_PIX, Math.max(1, Math.round(ah)) * ART_PIX);
}

/**
 * The scar one impact leaves: a fresh crater and its rays, drawn once into its
 * own art-resolution canvas and blitted from then on. It is redrawn only when
 * its rung steps, which is once every 600 frames -- so a scar costs one draw
 * call a frame for 2400 frames and four rasterisations in its whole life.
 *
 * It cannot be part of the bake for the obvious reason: it postdates it. The
 * alternative the study offers -- re-baking the 128x80 block under each new
 * crater -- is 10,240 field samples in one frame every 420, and this is the
 * cheaper side of that trade at seven live scars.
 */
function moonScar(bd, e, rung) {
    const hit = bd.scars[e.k];
    if (hit && hit.rung === rung) {
        return hit.cv;
    }
    const cv = (hit && hit.cv) || document.createElement("canvas");
    // Assigning the size clears it, which is what a stepped scar needs.
    cv.width = MOON_SCAR.w;
    cv.height = MOON_SCAR.h;
    const g = cv.getContext("2d");
    const put = (ac, ar, aw, ah, col) => {
        g.fillStyle = col;
        g.fillRect(Math.round(ac), Math.round(ar),
            Math.max(1, Math.round(aw)), Math.max(1, Math.round(ah)));
    };
    const land = bd.p.landRamp;
    const yh = moonHorizon(bd, e.ix);
    const dy = Math.max(1, e.iy - yh);
    const rr = Math.max(2, MOON_SCAR_R[0] + dy * MOON_SCAR_R[1]);
    const rb = Math.max(1, ((rr * dy) / MOON_FOC) * MOON_SCAR_R[2]);
    for (let r = -Math.ceil(rb); r <= Math.ceil(rb); r++) {
        const w = Math.round(rr * Math.sqrt(Math.max(0, 1 - (r / rb) * (r / rb))));
        if (w < 1) {
            continue;
        }
        // Fresh rim above, dark floor below. The far wall is the material that
        // came out of the hole, which is why it is on the warm `landRamp` and
        // the surface around it is not: young ground against weathered.
        put(MOON_SCAR.cx - w, MOON_SCAR.cy + r, w * 2, 1,
            r < 0 ? land[Math.min(land.length - 2, rung + 1)] : bd.p.ramp[1]);
    }
    for (let i = 0; i < MOON_RAYS; i++) {
        const ang = hash2(e.k, i * 13, MOON_RAY_SEED) * 6.2832;
        const len = (MOON_RAY_LEN[0] + hash2(e.k, i * 29, MOON_RAY_SEED) * MOON_RAY_LEN[1])
            * (MOON_RAY_LEN[2] + dy / MOON_RAY_LEN[3]);
        for (let t = 2; t < len; t += 1) {
            // A ray runs along the ground, so it is compressed by the same
            // depth the crater is, and it stops at the horizon: past the line
            // there is no ground for it to be on.
            const r = MOON_SCAR.cy + Math.sin(ang) * t * (dy / MOON_FOC) * MOON_RAY_STEP[1];
            if (e.iy - MOON_SCAR.cy + r < yh + 1) {
                break;
            }
            if (((t | 0) + i) % 3 === 0) {
                continue;
            }
            put(MOON_SCAR.cx + Math.cos(ang) * t * MOON_RAY_STEP[0], r, 1, 1,
                land[Math.min(land.length - 3, rung)]);
        }
    }
    bd.scars[e.k] = { rung, cv };
    // Integer-like keys enumerate in ascending order, so the one dropped is
    // always the oldest impact.
    const keys = Object.keys(bd.scars);
    if (keys.length > MOON_SCAR.cache) {
        delete bd.scars[keys[0]];
    }
    return cv;
}

/**
 * The shell, at one point of the plane, into `out`.
 *
 * Radial, not layered, and deliberately not `gasDensity` with a second
 * palette: a configuration of the violet nebula is exactly the relationship
 * this place exists in order not to have. Roughly the same cost -- three
 * gaussians and three noise reads against four octaves and a sine -- and the
 * violet nebula's own output is untouched, so nothing already measured has to
 * be measured again.
 */
function shellSample(bd, wx, wy, out) {
    const ex = wx - SHELL_C[0];
    const ey = wy - SHELL_C[1];
    const dx = ex * SHELL_ROT[0] + ey * SHELL_ROT[1];
    const dy = (-ex * SHELL_ROT[1] + ey * SHELL_ROT[0]) / SHELL_SQUASH;
    const warp =
        (bd.n1(wx * SHELL_WARP[0][0], wy * SHELL_WARP[0][0], SHELL_WARP[0][1]) - 0.5)
            * SHELL_WARP[0][2]
        + (bd.n4(wx * SHELL_WARP[1][0] + 20, wy * SHELL_WARP[1][0], SHELL_WARP[1][1]) - 0.5)
            * SHELL_WARP[1][2];
    const r = Math.hypot(dx, dy) + warp;
    const patch = SHELL_PATCH.base
        + SHELL_PATCH.gain * bd.n5(wx * SHELL_PATCH.rate, wy * SHELL_PATCH.rate, 2);
    const ring = (R, w, amp) => {
        const t = (r - R) / w;
        return amp * Math.exp(-t * t);
    };
    // The patch is what stops this reading as a target: the rim is bright in
    // three places and thin in two, and the inner ring only exists where the
    // patch clears its gate.
    let v = SHELL_FLOOR
        + ring(SHELL_MAIN[0], SHELL_MAIN[1], SHELL_MAIN[2]) * patch
        + ring(SHELL_MAIN[0] * SHELL_INNER[0], SHELL_INNER[1], SHELL_INNER[2])
            * clamp((patch - SHELL_INNER_GATE[0]) * SHELL_INNER_GATE[1], 0, 1);
    v += SHELL_CAVITY[0] * Math.exp(-Math.pow(r / SHELL_CAVITY[1], 2));
    v += SHELL_ION.amp
        * clamp((SHELL_MAIN[0] + SHELL_ION.out - r) / SHELL_ION.hard, 0, 1)
        * clamp((r - SHELL_MAIN[0] + SHELL_ION.in) / SHELL_ION.soft, 0, 1)
        * Math.min(SHELL_ION.cap, patch);
    const kn = bd.n2(wx * SHELL_KNOT.rate, wy * SHELL_KNOT.rate, 2);
    v += SHELL_KNOT.amp * Math.max(0, kn - SHELL_KNOT.cut)
        * Math.exp(-Math.pow((r - SHELL_MAIN[0] - SHELL_KNOT.at) / SHELL_KNOT.w, 2));
    const gx = wx + SHELL_SPIRAL.x;
    const gy = (wy - SHELL_SPIRAL.y) / SHELL_SPIRAL.squash;
    const gr = Math.hypot(gx, gy);
    if (gr < SHELL_SPIRAL.reach) {
        const th = Math.atan2(gy, gx);
        v += SHELL_SPIRAL.core * Math.exp(-Math.pow(gr / SHELL_SPIRAL.coreW, 2))
            + SHELL_SPIRAL.arm
                * Math.exp(-Math.pow((gr - SHELL_SPIRAL.armR) / SHELL_SPIRAL.armW, 2))
                * (0.5 + 0.5 * Math.sin(th * SHELL_SPIRAL.turns + gr * SHELL_SPIRAL.pitch));
    }
    v *= SHELL_GRAIN.base
        + SHELL_GRAIN.gain * bd.n3(wx * SHELL_GRAIN.rate, wy * SHELL_GRAIN.rate, 2);
    // The filament wall: a hard crest with a glow on its lit side only, so it
    // reads as a wall seen edge-on and not as a band of haze.
    let d = (wy - (SHELL_FIL.slope * wx + SHELL_FIL.at)) / Math.hypot(1, SHELL_FIL.slope);
    d += (bd.n4(wx * SHELL_FIL.rate, wy * SHELL_FIL.rate, 2) - 0.5) * SHELL_FIL.wobble;
    const ext = clamp(1 - Math.abs(wx + SHELL_FIL.mid) / SHELL_FIL.reach, 0, 1);
    out.fil = ext * (clamp(1 - Math.abs(d) / SHELL_FIL.crest, 0, 1)
        + SHELL_FIL.glow * clamp(1 - Math.abs(d + SHELL_FIL.off) / SHELL_FIL.wide, 0, 1));
    // The columns and the bank. They lean together, which is one noise read
    // rather than two and is also what makes them look like one weather.
    const sway = (bd.n2(wy * SHELL_SWAY.rate + SHELL_SWAY.off, SHELL_SWAY.row, 2) - 0.5)
        * SHELL_SWAY.amp;
    let sil = 0;
    for (const c of SHELL_COLUMNS) {
        const t = wy - c.t;
        if (t <= c.lo || t >= c.hi) {
            continue;
        }
        const hw = c.hw * (1 - (t + c.drop) / c.taper) * clamp((t + c.sh) / c.sh2, 0, 1);
        const e = Math.abs(wx - c.u - sway * c.sway) / Math.max(c.min, hw)
            + (bd[c.noise](wx * c.rate + c.off, wy * c.rate, 2) - 0.5) * SHELL_ROUGH;
        if (e < 1) {
            sil = 1;
            break;
        }
    }
    if (wy > SHELL_BANK.at
        + (bd.n4(wx * SHELL_BANK.rate + SHELL_BANK.off, SHELL_BANK.row, 2) - 0.5)
            * SHELL_BANK.amp) {
        sil = 1;
    }
    if (sil) {
        sil = bd.n3(wx * SHELL_SIL_CUT.rate + SHELL_SIL_CUT.off, wy * SHELL_SIL_CUT.rate, 2)
            > SHELL_SIL_CUT.cut ? 2 : 1;
    }
    out.v = Math.max(0, v);
    out.r = r;
    out.sil = sil;
}

/**
 * How far the echo front has travelled, in logical px from the shell's centre.
 * Pure in the frame counter: no countdown is stored, so pause freezes it, slow
 * motion slows it, and two clients in a co-op match watch the same flash cross
 * the same gas without a byte on the bus.
 */
function shellFront(t) {
    const f = (((t % SHELL_PERIOD) + SHELL_PERIOD) % SHELL_PERIOD) * SHELL_RATE;
    return f > SHELL_REACH ? 0 : f;
}

/**
 * The rung a value lands on. This is `_bakeField`'s own quantise written out
 * again, on purpose, for the two places that compute their bake AND their
 * per-frame pass from one table: a cell the live pass does not change has to
 * come out at exactly the colour the plate already holds, or the region it
 * repaints shows as a seam. Keep it in step with the quantise in
 * `_bakeField`, which is the only copy that matters.
 */
function artRung(bd, v, cx, cy, cap) {
    const bay = (BAYER[(cy & 3) * 4 + (cx & 3)] / 16 - 0.46) * DITHER;
    return clamp(Math.round(v * (bd.rgb.length - 1) + bay), 0, cap);
}

/**
 * The stream, as a polyline in logical px, and the box that bounds it.
 *
 * P0 is the donor's surface on the line to the companion -- the inner Lagrange
 * side. P2 is short of the companion and below it, where the incoming material
 * meets the sheet. P1 leads the orbit by a fifth of the separation along the
 * perpendicular, and that displacement is the whole of why the stream misses
 * the companion instead of pointing at it.
 */
function binaryStream(bd) {
    const d = bd.donor;
    const c = bd.comp;
    const sep = Math.hypot(c.x - d.x, c.y - d.y);
    const ux = (c.x - d.x) / sep;
    const uy = (c.y - d.y) / sep;
    const p0 = [d.x + ux * BIN_DONOR_R, d.y + uy * BIN_DONOR_R];
    const p2 = [c.x + BIN_STREAM_END[0], c.y + BIN_STREAM_END[1]];
    const p1 = [(p0[0] + p2[0]) / 2 - uy * BIN_STREAM_LEAD * sep,
        (p0[1] + p2[1]) / 2 + ux * BIN_STREAM_LEAD * sep];
    const pts = new Float64Array((BIN_STREAM_N + 1) * 3);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i <= BIN_STREAM_N; i++) {
        const t = i / BIN_STREAM_N;
        const a = (1 - t) * (1 - t);
        const b = 2 * (1 - t) * t;
        const k = t * t;
        const x = a * p0[0] + b * p1[0] + k * p2[0];
        const y = a * p0[1] + b * p1[1] + k * p2[1];
        pts[i * 3] = x;
        pts[i * 3 + 1] = y;
        pts[i * 3 + 2] = t;
        if (x < x0) { x0 = x; }
        if (x > x1) { x1 = x; }
        if (y < y0) { y0 = y; }
        if (y > y1) { y1 = y; }
    }
    return { pts, p2, box: [x0 - BIN_STREAM_PAD, y0 - BIN_STREAM_PAD,
        x1 + BIN_STREAM_PAD, y1 + BIN_STREAM_PAD] };
}

/**
 * The place at one point of the plane, into `out`: ten scalars, of which the
 * live pass needs eight. Everything here is a function of position alone --
 * the phases live in `live` -- which is what lets a place whose whole subject
 * is material in motion still bake all of its geometry.
 */
function binarySample(bd, x, y, out) {
    const d = bd.donor;
    const c = bd.comp;
    const dd = Math.hypot(x - d.x, y - d.y);
    const cd = Math.hypot(x - c.x, y - c.y);
    // Core plus halo, each with an 8-fold ray burst windowed close in. The
    // `atan2` is the expensive part and the window is what bounds it.
    let warm = Math.exp(-(dd / BIN_DONOR.core) * (dd / BIN_DONOR.core)) * BIN_DONOR.peak;
    let halo = BIN_DONOR.halo / (1 + (dd / BIN_DONOR.hr) * (dd / BIN_DONOR.hr));
    if (dd < BIN_DONOR_RAY[2] * 3) {
        const w = Math.exp(-(dd / BIN_DONOR_RAY[2]) * (dd / BIN_DONOR_RAY[2]));
        const s = Math.max(0, Math.sin(BIN_RAYS * Math.atan2(y - d.y, x - d.x) + BIN_DONOR_RAY[1]));
        halo *= 1 + BIN_DONOR_RAY[0] * s * s * s * w;
    }
    warm += halo;
    let cool = Math.exp(-(cd / BIN_COMP.core) * (cd / BIN_COMP.core)) * BIN_COMP.peak;
    let chalo = BIN_COMP.halo / (1 + (cd / BIN_COMP.hr) * (cd / BIN_COMP.hr));
    if (cd < BIN_COMP_RAY[2] * 3) {
        const w = Math.exp(-(cd / BIN_COMP_RAY[2]) * (cd / BIN_COMP_RAY[2]));
        const s = Math.max(0, Math.sin(BIN_RAYS * Math.atan2(y - c.y, x - c.x) + BIN_COMP_RAY[1]));
        chalo *= 1 + BIN_COMP_RAY[0] * s * s * s * w;
    }
    cool += chalo;
    // The shared plane. The radius is measured after the squash, so `R` is a
    // distance in the sheet rather than on the screen.
    const rx = x - bd.plane.x;
    const ry = y - bd.plane.y;
    const pu = rx * bd.plane.ct + ry * bd.plane.st;
    const pv = (-rx * bd.plane.st + ry * bd.plane.ct) / BIN_PLANE.squash;
    const R = Math.hypot(pu, pv);
    const t0 = (R - BIN_RING[0]) / BIN_RING[1];
    const t1 = (R - BIN_HAZE[0]) / BIN_HAZE[1];
    const prof = Math.exp(-t0 * t0) * BIN_RING[2] + Math.exp(-t1 * t1) * BIN_HAZE[2];
    out.dp = prof;
    if (prof > BIN_PROF_MIN) {
        out.dphi = Math.atan2(pv, pu);
        out.dln = Math.log(Math.max(R, BIN_LN_MIN));
    } else {
        out.dp = 0;
        out.dphi = 0;
        out.dln = 0;
    }
    // Which star lights this pixel: 1 at the gold one, 0 at the blue one, and
    // the changeover runs down the middle of the frame. That is the warm half
    // and the cool half the whole composition is built on.
    out.lit = (cd * cd) / (cd * cd + dd * dd + 1);
    out.sw = 0;
    out.st = 0;
    const bx = bd.stream.box;
    if (x > bx[0] && x < bx[2] && y > bx[1] && y < bx[3]) {
        const pts = bd.stream.pts;
        let best = Infinity;
        let bt = 0;
        for (let i = 0; i < pts.length; i += 3) {
            const ex = x - pts[i];
            const ey = y - pts[i + 1];
            const q = ex * ex + ey * ey;
            if (q < best) {
                best = q;
                bt = pts[i + 2];
            }
        }
        const wdt = BIN_STREAM_W[0] - BIN_STREAM_W[1] * bt;
        const u = Math.sqrt(best) / wdt;
        out.sw = Math.exp(-u * u) * BIN_STREAM_A;
        out.st = bt;
    }
    const hx = x - bd.stream.p2[0];
    const hy = y - bd.stream.p2[1];
    out.hs = Math.abs(hx) < BIN_HOT_PAD && Math.abs(hy) < BIN_HOT_PAD
        ? Math.exp(-(hx * hx + hy * hy) / (BIN_HOT * BIN_HOT))
        : 0;
    out.warm = warm;
    out.cool = cool;
}

/**
 * One art pixel's pair of ramp values at a given set of phases, into `out`.
 * The live pass and the bake both go through here, so there is one expression
 * of the mix rather than two that have to be kept level with each other.
 */
function binaryMix(s, arm, flow, flick, breathe, out) {
    const vd = s.dp * arm;
    const vs = s.sw * flow;
    const hv = s.hs * flick;
    out.w = (s.warm * breathe + vd * s.lit * BIN_MIX.disc[0]
        + vs * (1 - s.st) * BIN_MIX.stream + hv * BIN_MIX.hot[0]) * BIN_MIX.master;
    out.c = (s.cool + vd * (1 - s.lit) * BIN_MIX.disc[1]
        + vs * s.st * BIN_MIX.stream + hv * BIN_MIX.hot[1]) * BIN_MIX.master;
}

/**
 * The rung and ramp one art pixel takes, given its two ramp values. Returned
 * as `rung * 2 + isCool`, so the whole decision is one integer a caller can
 * compare -- which is what the active-cell test needs.
 */
function binaryPick(bd, w, c, cx, cy) {
    const tot = Math.min(1, w + c);
    const j = (BAYER[((cy + BIN_SEAM_TAP[0]) & 3) * 4 + ((cx + BIN_SEAM_TAP[1]) & 3)] / 16 - 0.5)
        * BIN_SEAM * tot;
    const cool = c - w > j;
    return artRung(bd, tot, cx, cy, cool ? bd.rgbAlt.length - 1 : BIN_GOLD_CAP) * 2
        + (cool ? 1 : 0);
}

/**
 * Whether an art pixel can ever change, over every phase the place reaches.
 *
 * The four periodic terms are independent sines, so their extremes are taken
 * independently: that is a superset of the states the place actually visits,
 * which costs a few cells that never move and can never miss one that does.
 * Everything it excludes is a pixel the plate holds correctly forever -- and
 * that is what turns a painter which re-quantises its whole arena every frame
 * into one that touches a fifth of it.
 */
function binaryActive(bd, s, cx, cy) {
    const lo = { w: 0, c: 0 };
    const hi = { w: 0, c: 0 };
    const fLo = 1 - BIN_FLICK_A * (BIN_FLICK[0][2] + BIN_FLICK[1][2]);
    const fHi = 1 + BIN_FLICK_A * (BIN_FLICK[0][2] + BIN_FLICK[1][2]);
    binaryMix(s, BIN_ARM[0], BIN_FLOW.base - BIN_FLOW.amp, fLo, 1 - BIN_BREATHE[1], lo);
    binaryMix(s, BIN_ARM[0] + BIN_ARM[1], BIN_FLOW.base + BIN_FLOW.amp, fHi,
        1 + BIN_BREATHE[1], hi);
    // The two corners the ramp choice can flip between as well as the two the
    // rung can: `w` high with `c` low is a different pick from both extremes.
    return binaryPick(bd, lo.w, lo.c, cx, cy) !== binaryPick(bd, hi.w, hi.c, cx, cy)
        || binaryPick(bd, hi.w, lo.c, cx, cy) !== binaryPick(bd, lo.w, hi.c, cx, cy)
        || binaryPick(bd, lo.w, lo.c, cx, cy) !== binaryPick(bd, hi.w, lo.c, cx, cy);
}

/**
 * The dust plane ORBITAL STATION sits in, as a scalar. Two octaves shaped by a
 * gaussian on the station's own quadrant: the ring needs a ground, and the
 * rest of the box needs to stay as dark as the arena the player flies in.
 */
function stationSky(bd, x, y) {
    const f = STATION_FIELD;
    const dx = (x - bd.cx) / bd.w;
    const dy = (y - bd.cy) / bd.h;
    const bias = f.floor + f.gain * Math.exp(-(dx * dx + dy * dy) * f.reach);
    return Math.max(0, bd.n1(x * f.rate, y * f.rate, 2) * f.amp * bias - f.cut) * f.lift;
}

/**
 * One axis-aligned run of art pixels, written straight into the overlay and
 * clipped to its dirty rectangle. Every part of the station is one of these:
 * nothing is ever rotated, so colour runs stay on the lattice and the whole
 * live layer costs one upload and one blit instead of 488 canvas fills.
 */
function stationRect(s, x, y, w, h, col) {
    const cx0 = Math.max(s.x0, Math.round(x));
    const cy0 = Math.max(s.y0, Math.round(y));
    const cx1 = Math.min(s.x1, Math.round(x) + Math.max(1, Math.round(w)) - 1);
    const cy1 = Math.min(s.y1, Math.round(y) + Math.max(1, Math.round(h)) - 1);
    for (let py = cy0; py <= cy1; py++) {
        let o = (py * s.aw + cx0) * 4;
        for (let px = cx0; px <= cx1; px++) {
            s.data[o] = col[0];
            s.data[o + 1] = col[1];
            s.data[o + 2] = col[2];
            s.data[o + 3] = 255;
            o += 4;
        }
    }
}

/** A boom or a spoke: a run of `t`-sized squares between two points. */
function stationLine(s, x0, y0, x1, y1, t, col) {
    const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / t));
    for (let i = 0; i <= n; i++) {
        const k = i / n;
        stationRect(s, x0 + (x1 - x0) * k - t / 2, y0 + (y1 - y0) * k - t / 2, t, t, col);
    }
}

/**
 * The 24 modules at one rotation.
 *
 * Foreshortening is measured in the plane and not on the screen --
 * `sqrt(sin^2 + squash^2 cos^2)` scales the apparent width -- which is what
 * makes the ring read as tilted rather than as an oval painted on glass. The
 * sign of `sin` is the whole of the depth sort: twelve modules cross in front
 * of the hub and twelve behind it every revolution.
 */
function stationModules(bd, rot) {
    const out = [];
    for (let i = 0; i < STATION_MODULES; i++) {
        const th = rot + (i * 6.2832) / STATION_MODULES;
        const ct = Math.cos(th);
        const st = Math.sin(th);
        const k = Math.sqrt(st * st + STATION_SQUASH * STATION_SQUASH * ct * ct);
        out.push({
            i,
            x: bd.acx + STATION_R * ct,
            y: bd.acy + STATION_R * STATION_SQUASH * st,
            hw: Math.max(1.2, STATION_MOD_HW * k),
            h: STATION_MOD_H[0] + STATION_MOD_H[1] * st,
            near: st > 0,
        });
    }
    return out;
}

/** One module: plating, ribs, its run of lit windows, and maybe a nav light. */
function stationModule(bd, s, m) {
    const land = bd.rgbAlt;
    const x = m.x;
    const y = m.y;
    const hw = m.hw;
    const h = m.h;
    const top = y - h / 2;
    stationRect(s, x - hw, top, hw * 2, h, land[m.near ? 4 : 2]);
    // The near top edge stops at rung 5. At rung 6 it was one of the two
    // features in the place that measured pale, and it is 24 of them.
    stationRect(s, x - hw, top, hw * 2, 1, land[m.near ? 5 : 4]);
    stationRect(s, x - hw, y + h / 2 - 1, hw * 2, 1, land[m.near ? 2 : 1]);
    stationRect(s, x - hw, top, 1, h, land[1]);
    stationRect(s, x + hw - 1, top, 1, h, land[1]);
    for (let px = -hw + 3; px < hw - 1; px += 4) {
        stationRect(s, x + px, top + 1, 1, h - 2, land[3]);
    }
    // The windows are steady and source-over, never additive and never
    // blinking: a light that appears and disappears is what a muzzle flash
    // looks like, and this place has 60 of them.
    if (m.i % STATION_WIN_DARK !== STATION_WIN_DARK - 1 && hw > 2.6) {
        // A window on the far arc is seen across the ring and is dimmer for
        // it, which is depth -- and it is also the only reason those windows
        // clear the small-bright-feature bar: the far plating is four rungs
        // down and cannot embed a light the way the near plating does.
        const hi = m.near ? bd.lit.winHi : bd.lit.farHi;
        const lo = m.near ? bd.lit.win : bd.lit.far;
        for (let px = -hw + 2; px < hw - 3; px += STATION_WIN_PITCH) {
            stationRect(s, x + px, top + 1.5, 2, 2,
                (m.i + Math.floor(px)) % 3 === 0 ? hi : lo);
        }
    }
    if (m.i % STATION_NAV_EVERY === 0) {
        stationRect(s, x - 1, y + h / 2 - 2, 2, 2, m.near ? bd.lit.navHi : bd.lit.nav);
    }
}

/** The rim truss, on one side of the plane: what fills the gaps between them. */
function stationRim(bd, s, near) {
    const land = bd.rgbAlt;
    for (let i = 0; i < STATION_RIM; i++) {
        const th = (i * 6.2832) / STATION_RIM;
        const st = Math.sin(th);
        if ((st > 0) !== near) {
            continue;
        }
        const rx = bd.acx + STATION_R * Math.cos(th);
        const ry = bd.acy + STATION_R * STATION_SQUASH * st;
        if (near) {
            stationRect(s, rx, ry, 3, 2, land[3]);
        } else {
            stationRect(s, rx, ry, 2, 1, land[1]);
        }
    }
}

/** The four spokes, on one side of the plane. They turn with the ring. */
function stationSpokes(bd, s, rot, near) {
    const land = bd.rgbAlt;
    for (let k = 0; k < STATION_SPOKES; k++) {
        const th = rot + (k * 6.2832) / STATION_SPOKES;
        const st = Math.sin(th);
        if ((st > 0) !== near) {
            continue;
        }
        const ct = Math.cos(th);
        const r0 = STATION_SPOKE_R[0];
        const r1 = STATION_R - STATION_SPOKE_R[1];
        stationLine(s,
            bd.acx + r0 * ct, bd.acy + r0 * STATION_SQUASH * st,
            bd.acx + r1 * ct, bd.acy + r1 * STATION_SQUASH * st,
            near ? 2 : 1, land[near ? 4 : 2]);
    }
}

/**
 * The hub, which is the half of the idea the old painter never had: it is
 * despun, so the arrays, the tower, the beacon and the docked craft hold
 * perfectly still while the ring turns past them. The bearing under the tower
 * is the joint that says so, and the spokes come out of it.
 */
function stationHub(bd, s) {
    const land = bd.rgbAlt;
    const ramp = bd.rgb;
    const x = bd.acx;
    const y = bd.acy;
    // Solar arrays, on booms long enough to carry them clear of the rim.
    for (const d of [-1, 1]) {
        stationLine(s, x + d * 7, y - 6, x + d * 38, y - 21, 1, land[3]);
        const ax = x + d * 38 - (d < 0 ? 12 : 0);
        const ay = y - 29;
        stationRect(s, ax, ay, 12, 16, ramp[3]);
        stationRect(s, ax, ay, 12, 1, land[4]);
        for (let i = 2; i < 16; i += 3) {
            stationRect(s, ax, ay + i, 12, 1, ramp[4]);
        }
        stationRect(s, ax + 5, ay, 1, 16, land[3]);
    }
    // Radiator fins.
    for (const d of [-1, 1]) {
        const rx = x + d * 6 - (d < 0 ? 3 : 0);
        stationRect(s, rx, y + 5, 3, 9, land[2]);
        stationRect(s, rx, y + 5, 3, 1, land[5]);
    }
    // The bearing. Everything above this line is still.
    stationRect(s, x - 7, y - 1, 14, 4, land[5]);
    stationRect(s, x - 7, y + 1, 14, 1, land[1]);
    stationRect(s, x - 8, y - 2, 16, 1, land[3]);
    // The tower: eight storeys, four of them lit, and a spire.
    for (let i = 0; i < 8; i++) {
        const w = 8 - Math.floor(i / 2.6);
        const yy = y - 5.5 - i * 2.5;
        stationRect(s, x - w / 2, yy, w, 3, land[4]);
        stationRect(s, x - w / 2, yy, w, 1, land[5]);
        if (i % 2 === 0) {
            stationRect(s, x - w / 2 + 1, yy + 1, 2, 2, bd.lit.win);
        }
    }
    stationRect(s, x - 0.5, y - 23, 1, 11, land[5]);
    stationRect(s, x - 1, y - 25, 2, 2, bd.lit.beacon);
    // The docked craft, on the collar's left. It is the clearest read of
    // "occupied" in the place and the reason the entry's last sentence is
    // true. Rung 5, not 6: at 6 its highlight was the other pale feature.
    stationRect(s, x - 17, y + 2, 8, 3, land[5]);
    stationRect(s, x - 15, y + 3, 2, 2, bd.lit.winHi);
    stationLine(s, x - 9, y + 3, x - 5, y + 2, 1, land[3]);
    // ...and one leaving. Pure in the frame counter, like the rotation: no
    // stored countdown, so it replays from any instant.
    const k = (bd.t % STATION_SHUTTLE.period) / STATION_SHUTTLE.period;
    const sx = x + STATION_SHUTTLE.x[0] + k * STATION_SHUTTLE.x[1];
    const sy = y + STATION_SHUTTLE.y[0] + k * STATION_SHUTTLE.y[1];
    stationRect(s, sx, sy, 4, 2, land[5]);
    stationRect(s, sx - 2, sy, 2, 2, bd.lit.beacon);
}

/**
 * The first index of a sorted Float32Array whose value is not below `v`. The
 * echo's index is sorted along its direction of travel, so a front's window is
 * two of these rather than a walk over the whole place.
 */
function lowerBound(arr, v) {
    let a = 0;
    let b = arr.length;
    while (a < b) {
        const m = (a + b) >> 1;
        if (arr[m] < v) {
            a = m + 1;
        } else {
            b = m;
        }
    }
    return a;
}

/**
 * The signed difference between two angles, in (-PI, PI]. Every one of
 * SUPERNOVA's terms is measured as a bearing from the shock, and a bare
 * subtraction puts a seam down the place wherever atan2 wraps.
 */
function angDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) {
        d -= 6.2832;
    }
    while (d < -Math.PI) {
        d += 6.2832;
    }
    return d;
}

/**
 * Ridged noise on `mkNoise`, 0..1: `oct` octaves of `1 - |2n - 1|`. MOLTEN
 * WORLD folds one line of the field into a skyline; this folds the plane, which
 * is what turns a smooth cloud into sheets seen edge-on.
 */
function ridgedN(n, x, y, oct) {
    let v = 0;
    let a = 0.5;
    let f = 1;
    let t = 0;
    for (let i = 0; i < oct; i++) {
        v += a * (1 - Math.abs(2 * n(x * f, y * f, 1) - 1));
        t += a;
        f *= 2.07;
        a *= 0.5;
    }
    return v / t;
}

/**
 * The 34 filament strands. Twenty-two cluster on the rim at 0.90-1.07 of the
 * shell radius and twelve sit inside it at 0.46-0.90; no two share a centre,
 * every arc is open, and the lobe term makes each one lopsided before the noise
 * is added. That is the whole argument that this place cannot be read as the
 * boss's attack: the attack is one closed concentric circle with a radial
 * velocity, and nothing here has any of the three.
 */
function supernovaStrands(bd) {
    const rng = mulberry32(SN_STRAND_SEED);
    const out = [];
    for (let k = 0; k < SN_STRANDS; k++) {
        const s = k < SN_RIM_N ? SN_RIM_STRAND : SN_IN_STRAND;
        out.push({
            rad: bd.sn.r * (s.rad[0] + s.rad[1] * rng()),
            ox: (rng() * 2 - 1) * s.off[0] * bd.sn.r,
            oy: (rng() * 2 - 1) * s.off[1] * bd.sn.r,
            th: s.th[0] + rng() * s.th[1],
            a0: SN_SHOCK + (rng() * 2 - 1) * s.spread,
            arc: s.arc[0] + rng() * s.arc[1],
            amp: (s.amp[0] + rng() * s.amp[1]) * bd.sn.r,
            ph: rng() * 6.2832,
            br: s.br[0] + rng() * s.br[1],
            nz: k * 7,
        });
    }
    return out;
}

/** The radial filaments: the same silhouette test, elongated along r. */
function supernovaSpokes(bd) {
    const rng = mulberry32(SN_SPOKE_SEED);
    const out = [];
    for (let k = 0; k < SN_SPOKE.n; k++) {
        out.push({
            a: SN_SHOCK + (rng() * 2 - 1) * SN_SPOKE.spread,
            r0: bd.sn.r * (SN_SPOKE.r0[0] + SN_SPOKE.r0[1] * rng()),
            r1: bd.sn.r * (SN_SPOKE.r1[0] + SN_SPOKE.r1[1] * rng()),
            th: SN_SPOKE.th[0] + rng() * SN_SPOKE.th[1],
            ph: rng() * 6.2832,
            br: SN_SPOKE.br[0] + rng() * SN_SPOKE.br[1],
            nz: 40 + k * 3,
        });
    }
    return out;
}

/**
 * The place at one art pixel, into `bd.sn`'s four scalar fields: the filament
 * silhouette, the dust, the Halpha knots and the coordinate along the echo's
 * direction of travel. The three the echo needs are kept because a live pass
 * that re-quantises a baked pixel has to compute it from exactly the value its
 * baked rung came from, or the lane it repaints shows as a seam.
 */
function supernovaSample(bd, i, x, y) {
    const P = bd.sn;
    P.u[i] = (x - P.cx) * P.dx + (y - P.cy) * P.dy;
    const gdx = x - P.cx;
    const gdy = (y - P.cy) * SN_ELL;
    const gd = Math.sqrt(gdx * gdx + gdy * gdy);
    const ga = Math.atan2(gdy, gdx);
    const face = Math.max(0, Math.cos(angDiff(ga, SN_SHOCK)));
    const shock = SN_GAIN[0] + SN_GAIN[1] * Math.pow(face, SN_GAIN[2]);
    // The breakup is sampled once per art pixel rather than once per strand:
    // thirty times the cost for no visible gain, because the strands that
    // overlap here are all reading the same field anyway.
    const bkA = P.n.bkA(x * SN_BREAK_A, y * SN_BREAK_A, 3);
    const bkB = P.n.bkB(x * SN_BREAK_B + 40, y * SN_BREAK_B - 40, 3);
    const knot = clamp((P.n.knot(x * SN_KNOT[0] - 9, y * SN_KNOT[0] + 6, 3) - SN_KNOT[1]) * SN_KNOT[2], 0, 1);

    let best = 0;
    for (const st of P.strands) {
        const dx = x - (P.cx + st.ox);
        const dy = (y - (P.cy + st.oy)) * SN_ELL;
        const a = Math.atan2(dy, dx);
        const w = smoothstep(1 - Math.abs(angDiff(a, st.a0)) / st.arc, 0, 1);
        if (w <= 0) {
            continue;
        }
        const rr = st.rad * (1 + SN_STRAND_LOBE[0] * Math.sin(a + st.ph) + SN_STRAND_LOBE[1] * Math.sin(2 * a - st.ph))
            + st.amp * (P.n.str(a * SN_STRAND_NOISE + st.ph, st.nz, 3) - 0.5) * 2;
        const dr = (Math.sqrt(dx * dx + dy * dy) - rr) / st.th;
        const core = Math.exp(-dr * dr);
        if (core < 0.02) {
            continue;
        }
        const v = core * w * st.br * (SN_FIL_MIX[0] + SN_FIL_MIX[1] * bkA)
            * (SN_FIL_MIX[2] + SN_FIL_MIX[3] * knot) * shock;
        if (v > best) {
            best = v;
        }
    }
    for (const sp of P.spokes) {
        if (gd < sp.r0 - SN_SPOKE.pad || gd > sp.r1 + SN_SPOKE.pad) {
            continue;
        }
        const wob = (P.n.str(gd * SN_SPOKE.wob[0] + sp.ph, sp.nz, 1) - 0.5) * SN_SPOKE.wob[1];
        const da = angDiff(ga, sp.a + wob) * gd;
        const core = Math.exp(-(da * da) / (sp.th * sp.th));
        if (core < 0.02) {
            continue;
        }
        const rw = smoothstep(gd, sp.r0, sp.r0 + SN_SPOKE.fade[0])
            * smoothstep(sp.r1 - gd, 0, SN_SPOKE.fade[1]);
        const v = core * rw * sp.br * (SN_SPOKE_MIX[0] + SN_SPOKE_MIX[1] * bkB)
            * (SN_SPOKE_MIX[2] + SN_SPOKE_MIX[3] * knot) * shock;
        if (v > best) {
            best = v;
        }
    }
    // Fine sheets seen edge-on, confined to the shell annulus.
    const an = (gd - P.r * SN_FINE.at) / (P.r * SN_FINE.w);
    const fine = smoothstep(ridgedN(P.n.fine, x * SN_FINE.scale + 7, y * SN_FINE.scale - 13, 4),
        SN_FINE.cut, SN_FINE.cut + SN_FINE.span) * Math.exp(-an * an) * shock * SN_FINE.a;
    if (fine > best) {
        best = fine;
    }
    P.fil[i] = best > SN_SIL.cut
        ? SN_SIL.floor + SN_SIL.gain * smoothstep(best, SN_SIL.cut, SN_SIL.cut + SN_SIL.span)
        : 0;

    let dv = P.n.dust(x * SN_DUST.scale + 19, y * SN_DUST.scale - 7, 5);
    dv = Math.pow(clamp((dv - SN_DUST.cut) / SN_DUST.span, 0, 1), SN_DUST.gamma)
        * (SN_DUST.bias[0] + SN_DUST.bias[1] * Math.pow(face, SN_DUST.bias[2]));
    dv *= clamp((gd - P.r * SN_DUST.cavity[0]) / SN_DUST.cavity[1], 0, 1);
    dv *= SN_DUST.mottle[1] + SN_DUST.mottle[2]
        * P.n.mottle(x * SN_DUST.mottle[0] - 3, y * SN_DUST.mottle[0] + 11, 3);
    P.dust[i] = dv * SN_DUST.peak;

    const hb = (gd - P.r * SN_HA.at) / SN_HA.w;
    P.ha[i] = clamp(Math.exp(-hb * hb) * Math.pow(face, SN_HA.gamma)
        * clamp((P.n.ha(x * SN_HA.scale - 5, y * SN_HA.scale + 3, 3) - SN_HA.cut) * SN_HA.gain, 0, 1), 0, 1);
}

/**
 * The pixels the echo can actually change, sorted along its direction of
 * travel, plus the cycle derived from the range of that coordinate over the
 * dust the arena can see.
 *
 * A dust pixel joins only if its rung really flips somewhere in the gain range,
 * and only if the plate still holds the colour the field asked for -- a star
 * landed on it otherwise, and a lane of light that put stars out as it passed
 * would be the one thing that gives the trick away. Everything else is proved
 * static and is never visited again, which is what takes the live pass from
 * 180k art pixels to a few thousand.
 */
function supernovaIndex(bd) {
    const P = bd.sn;
    const plate = bd.layer.getContext("2d").getImageData(0, 0, P.aw, P.ah).data;
    const n = P.aw * P.ah;
    const keep = [];
    // The cycle is derived from the dust the ARENA sees, not the paint box: a
    // front spends the rest of its travel outside the frame, and padding by the
    // envelope's own width at each end is what leaves the wrap with no seam.
    let uLo = Infinity;
    let uHi = -Infinity;
    for (let i = 0; i < n; i++) {
        if (P.dust[i] <= SN_DUST.min) {
            continue;
        }
        const iy = (i / P.aw) | 0;
        const ix = i - iy * P.aw;
        if (ix >= P.ax0 && ix <= P.ax1 && iy >= P.ay0 && iy <= P.ay1) {
            if (P.u[i] < uLo) {
                uLo = P.u[i];
            }
            if (P.u[i] > uHi) {
                uHi = P.u[i];
            }
        }
        const base = supernovaPack(bd, i, ix, iy, 0);
        if (base === supernovaPack(bd, i, ix, iy, SN_ECHO.gain)) {
            continue;
        }
        const o = i * 4;
        if (((plate[o] << 16) | (plate[o + 1] << 8) | plate[o + 2]) !== base) {
            continue;
        }
        keep.push(i);
    }
    keep.sort((a, b) => P.u[a] - P.u[b]);
    const m = keep.length;
    P.at = Int32Array.from(keep);
    P.eu = new Float32Array(m);
    P.fi = new Float32Array(m);
    P.du = new Float32Array(m);
    P.hq = new Int8Array(m);
    P.bs = new Int32Array(m);
    for (let k = 0; k < m; k++) {
        const i = keep[k];
        const iy = (i / P.aw) | 0;
        const ix = i - iy * P.aw;
        P.eu[k] = P.u[i];
        P.fi[k] = P.fil[i];
        P.du[k] = P.dust[i];
        P.hq[k] = P.ha[i] > 0 ? artRung(bd, P.ha[i], ix, iy, SN_HA_TOP) : 0;
        P.bs[k] = supernovaPack(bd, i, ix, iy, 0);
    }
    const pad = SN_ECHO.pad * SN_ECHO.w;
    const span = uHi > uLo ? uHi - uLo + 2 * pad : 2 * pad;
    P.echo = { s0: uLo - pad, period: Math.max(1, Math.round(span / SN_ECHO.rate)) };
    // The scalar fields have done their job: the live pass reads the compact
    // arrays, so 2.9 MB of them goes back rather than staying for the run.
    P.fil = null;
    P.dust = null;
    P.ha = null;
    P.u = null;
}

/**
 * `exp(-t*t)` over the window the echo is evaluated on, as a table indexed by
 * how far a pixel is from the front as a share of the window.
 */
function supernovaEnvelope() {
    const reach = SN_ECHO.win / SN_ECHO.w;
    const out = new Float32Array(SN_ENV_N + 2);
    for (let i = 0; i <= SN_ENV_N + 1; i++) {
        const t = (i / SN_ENV_N) * reach;
        out[i] = Math.exp(-t * t);
    }
    return out;
}

/** The colour an art pixel takes at a given added echo brightness, packed. */
function supernovaPack(bd, i, ix, iy, gain) {
    const P = bd.sn;
    const d = P.dust[i] + gain;
    const q = artRung(bd, P.fil[i] > d ? P.fil[i] : d, ix, iy, P.top);
    let c = bd.rgb[q];
    if (P.ha[i] > 0) {
        const qs = artRung(bd, P.ha[i], ix, iy, SN_HA_TOP);
        if (qs > 0 && P.secLum[qs] > P.priLum[q]) {
            c = bd.rgbAlt[qs];
        }
    }
    return (c[0] << 16) | (c[1] << 8) | c[2];
}

/**
 * The 192 angular cells: a streamer amplitude and length each, a phase for the
 * slow drift, and the limb's own terrain. Two low-frequency sines group the
 * plumes so they cluster into combs instead of speckling, and 28% of the cells
 * are dimmed and shortened, which is where the comb gets its gaps.
 */
function eclipseCells() {
    const rng = mulberry32(ECL_SEED);
    const s1 = rng() * 6.2832;
    const s2 = rng() * 6.2832;
    const s3 = rng() * 6.2832;
    const s4 = rng() * 6.2832;
    const S = ECL_STREAM;
    const amp = new Float32Array(ECL_CELLS);
    const len = new Float32Array(ECL_CELLS);
    const ph = new Float32Array(ECL_CELLS);
    const terr = new Float32Array(ECL_CELLS);
    for (let i = 0; i < ECL_CELLS; i++) {
        const a = (i / ECL_CELLS) * 6.2832;
        const g = 0.5 + 0.5 * Math.sin(a * 3 + s1);
        const h = 0.5 + 0.5 * Math.sin(a * 7 + s2);
        let av = S.amp[0] + S.amp[1] * (S.mix[0] * g + S.mix[1] * h + S.mix[2] * rng());
        let lv = S.len[0] + S.len[1] * (S.lmix[0] * g + S.lmix[1] * h + S.lmix[2] * rng());
        if (rng() < S.dim) {
            av *= S.dimA;
            lv *= S.dimL;
        }
        amp[i] = av;
        len[i] = lv;
        ph[i] = rng() * 6.2832;
        terr[i] = ECL_TERR[0] * (ECL_TERR[1] * Math.sin(a * ECL_TERR[2] + s3)
            + ECL_TERR[3] * Math.sin(a * ECL_TERR[4] + s4));
    }
    // The beads come out of the five deepest valleys, each on its own period.
    const order = Array.from({ length: ECL_CELLS }, (unused, i) => i).sort((a, b) => terr[a] - terr[b]);
    const beads = [];
    for (let k = 0; k < 5; k++) {
        beads.push({ ai: order[k * 7] });
    }
    return { amp, len, ph, terr, beads };
}

/**
 * Where the star is, as a pure function of the frame counter. `p` runs the
 * whole pass; `dist` is the star's centre from the disc's in R; `cv` is how
 * far the corona has come up and `em` how far the star has cleared the limb.
 * Everything else in the place reads these five numbers and none of them is
 * evaluated per pixel.
 */
function eclipsePhase(bd, f) {
    const T = ECL_TRANSIT;
    const E = bd.ecl.chord;
    const p = (((f / T.period + ECL_START) % 1) + 1) % 1;
    const t = -T.margin + (E.len + 2 * T.margin) * p;
    const nx = E.ix + E.ux * t;
    const ny = E.iy + E.uy * t;
    const dist = Math.sqrt(nx * nx + ny * ny);
    let sth = Math.atan2(ny, nx);
    if (sth < 0) {
        sth += 6.2832;
    }
    return {
        p, dist, sth,
        sx: bd.ecl.cx + nx * bd.ecl.r,
        sy: bd.ecl.cy + ny * bd.ecl.r,
        cv: clamp((ECL_CONTACT - dist) / ECL_CV, 0, 1),
        em: clamp((dist - ECL_CONTACT) / ECL_CV, 0, 1),
    };
}

/**
 * The place at one art pixel, given the transit. Returns the value and leaves
 * the rung cap it needs in `bd.ecl.cap`: 6 for the corona and the streamers, 7
 * for the limb band and for the star, which are the two things allowed to
 * reach the top of the ramp.
 *
 * The limb is decided here and never drawn. Inside `E` the pixel returns 0 and
 * lands on rung 0 with no dither term able to lift it; the pixel immediately
 * outside returns at least 0.92 from the chromospheric ring and lands on rung
 * 7. The edge is one art pixel wide with a seven-rung jump across it, which is
 * the hardest edge this ramp can express.
 */
function eclipseValue(bd, x, y, tp, f) {
    const P = bd.ecl;
    const dx = x - P.cx;
    const dy = y - P.cy;
    const rn = Math.sqrt(dx * dx + dy * dy) / P.r;
    let th = Math.atan2(dy, dx);
    if (th < 0) {
        th += 6.2832;
    }
    const ai = Math.floor((th / 6.2832) * ECL_CELLS) % ECL_CELLS;
    P.cap = ECL_STREAM.cap;
    const E = 1 + P.cell.terr[ai];
    if (rn <= E) {
        return 0;
    }
    const u = rn - E;
    let dth = Math.abs(th - tp.sth);
    if (dth > Math.PI) {
        dth = 6.2832 - dth;
    }
    const w = dth / ECL_GAIN.w;
    const gain = Math.min(ECL_GAIN.cap, ECL_GAIN.base + ECL_GAIN.cv * tp.cv
        + ECL_GAIN.arc * (1 - tp.cv) * Math.exp(-w * w));
    const prof = u < ECL_RING[0] ? ECL_RING_V[0]
        : u < ECL_RING[1] ? ECL_RING_V[1]
            : u < ECL_RING[2] ? ECL_RING_V[2] : 0;
    let v = gain * prof;
    if (tp.cv > 0.02) {
        const S = ECL_STREAM;
        const L = P.cell.len[ai] * (1 + S.wob * Math.sin((6.2832 * f) / S.drift + P.cell.ph[ai])) * tp.cv;
        if (u < L) {
            const sv = P.cell.amp[ai] * Math.pow(1 - u / L, S.exp) * S.a;
            // Over the ring's solid bands the streamer TAKES THE BRIGHTER of
            // the two rather than adding to it. Added, it puts a per-cell
            // brightness variation on exactly the bands that are snapped to
            // exact rungs to keep the dither off them -- and just inside the
            // contacts, where the streamers are still short enough to sit
            // entirely inside the ring, that variation breaks the bright arc
            // into cell-sized chips: four of them measured as small bright
            // features at p = 0.235, which is four more than this catalogue
            // allows. Outside the bands it adds, which is where it is a plume.
            if (u < ECL_RING[2]) {
                if (sv > v) {
                    v = sv;
                }
            } else {
                v += sv;
            }
        }
    }
    v += ECL_HAZE[0] * Math.exp(-u / ECL_HAZE[1]) * (ECL_HAZE[2] + ECL_HAZE[3] * tp.cv);
    if (tp.em > 0) {
        const S = ECL_STAR;
        const e = tp.em;
        const sx = (x - tp.sx) / P.r;
        const sy = (y - tp.sy) / P.r;
        const ds = Math.sqrt(sx * sx + sy * sy);
        let sv = 0;
        if (ds < Math.max(S.core[0], S.core[1] * e)) {
            sv = 1;
        } else if (ds < S.mid * e) {
            sv = 6 / 7;
        } else if (ds < S.out * e) {
            sv = 5 / 7;
        } else if (ds < S.reach) {
            // Two arms, at 0 and 90 degrees. A diagonal is not 4-connected on
            // the lattice, so it measures as a staircase of separate features.
            const len = S.spike * e;
            for (let k = 0; k < 2; k++) {
                const along = k ? Math.abs(sy) : Math.abs(sx);
                if (along > len) {
                    continue;
                }
                const t = 1 - along / len;
                if (Math.abs(k ? sx : sy) < S.w[0] + S.w[1] * t * t) {
                    sv = 6 / 7;
                    break;
                }
            }
        }
        if (sv > 0) {
            P.cap = 7;
            return sv;
        }
    }
    if (v > 1) {
        v = 1;
    }
    // The limb band is snapped to exact rung values, which deliberately makes
    // the ordered dither a no-op there. The dither still runs on the outer
    // corona and the haze, where it earns its keep; a dithered fringe on the
    // limb breaks into single art pixels that measure exactly like enemy fire,
    // and by the study's count that is worth about 30 of them.
    if (u < ECL_RING[2]) {
        P.cap = 7;
        return Math.floor(v * 7 + 0.5) / 7;
    }
    return v;
}

/**
 * Baily's beads: the last of the star showing through a valley on the limb, at
 * the contacts only. Each site has its own period so they never blink
 * together, and three at once is a hard cap.
 */
function eclipseBeads(bd, f, tp, out) {
    out.length = 0;
    if (Math.abs(tp.dist - 1) > ECL_BEAD.win) {
        return out;
    }
    const P = bd.ecl;
    const c0 = Math.round((tp.sth / 6.2832) * ECL_CELLS);
    for (let d = -ECL_BEAD.span; d <= ECL_BEAD.span; d++) {
        const ai = (((c0 + d) % ECL_CELLS) + ECL_CELLS) % ECL_CELLS;
        if (P.cell.terr[ai] > ECL_BEAD.valley) {
            continue;
        }
        const per = ECL_BEAD.period[0] + (ai % ECL_BEAD.period[2]) * ECL_BEAD.period[1];
        if ((f + ai * ECL_BEAD.phase) % per >= ECL_BEAD.dur) {
            continue;
        }
        const a = ((ai + 0.5) / ECL_CELLS) * 6.2832;
        const rr = P.r * (1 + P.cell.terr[ai]);
        out.push(P.cx + Math.cos(a) * rr, P.cy + Math.sin(a) * rr);
        if (out.length >= ECL_BEAD.max * 2) {
            break;
        }
    }
    return out;
}
/**
 * Re-bake the annulus for one instant of the transit, into the overlay the
 * plate is seen through. Everything at rung 0 is left transparent, so the sky
 * under it is the plate's own; and a rung of 1 or 2 over a baked star is left
 * transparent too, which is how a star reads through the dim outer corona
 * without the star field having to know anything about the transit.
 */
function eclipseBake(bd, f) {
    const P = bd.ecl;
    if (!P.starMask) {
        // One readback, once: which plate pixels are point lights and not sky.
        const plate = bd.layer.getContext("2d").getImageData(0, 0, P.aw, P.ah).data;
        const sky = bd.rgb[0];
        P.starMask = new Uint8Array(P.aw * P.ah);
        for (let i = 0; i < P.starMask.length; i++) {
            const o = i * 4;
            if (plate[o] !== sky[0] || plate[o + 1] !== sky[1] || plate[o + 2] !== sky[2]) {
                P.starMask[i] = 1;
            }
        }
    }
    const tp = eclipsePhase(bd, f);
    const d = P.data;
    const inner = P.r * ECL_ANNULUS[0];
    const outer = P.r * ECL_ANNULUS[1];
    const i2 = inner * inner;
    const o2 = outer * outer;
    for (let py = P.y0; py <= P.y1; py++) {
        const row = py * P.aw;
        d.fill(0, (row + P.x0) * 4, (row + P.x1 + 1) * 4);
        const dy = bd.y0 + (py + 0.5) * ART_PIX - P.cy;
        for (let px = P.x0; px <= P.x1; px++) {
            const x = bd.x0 + (px + 0.5) * ART_PIX;
            const dx = x - P.cx;
            const dd = dx * dx + dy * dy;
            if (dd < i2 || dd > o2) {
                continue;
            }
            const v = eclipseValue(bd, x, dy + P.cy, tp, f);
            if (v <= 0) {
                continue;
            }
            // The study quantises `v * cap` rather than `v * 7`, so a streamer
            // at full value lands on the cap and not one rung over it. Scaled
            // back onto the shared quantiser, which is the copy that has to
            // stay in step with `_bakeField`.
            const cap = P.cap;
            const q = artRung(bd, (v * cap) / 7, px, py, cap);
            const i = row + px;
            if (q === 0 || (q <= 2 && P.starMask[i])) {
                continue;
            }
            const c = bd.rgb[q];
            const o = i * 4;
            d[o] = c[0];
            d[o + 1] = c[1];
            d[o + 2] = c[2];
            d[o + 3] = 255;
        }
    }
    P.g.putImageData(P.img, 0, 0, P.x0, P.y0, P.x1 - P.x0 + 1, P.y1 - P.y0 + 1);
}

/**
 * `0.5 + 0.5 cos(2 pi f)` and that curve raised to the light's exponent, as
 * tables indexed by the fractional part. `live` reads both once per visited art
 * pixel and there are 78k of those a frame; a `Math.cos` and a `Math.pow` there
 * cost more than everything else in the loop together.
 */
function wormTables() {
    const cos = new Float32Array(WORM_TAB_N + 2);
    const light = new Float32Array(WORM_TAB_N + 2);
    for (let i = 0; i <= WORM_TAB_N + 1; i++) {
        const c = 0.5 + 0.5 * Math.cos((i / WORM_TAB_N) * 6.2832);
        cos[i] = c;
        light[i] = Math.pow(c, WORM_LIGHT_EXP);
    }
    return { cos, light };
}

/**
 * The throat, baked once per art pixel that the vignette can still reach: the
 * wall profile against the vignette, the core, and the two phases the live
 * terms slide along. Everything that is a function of position and nothing
 * that is a function of the frame.
 *
 * The list is flat and in row-major order rather than a rectangle, because the
 * region is an ellipse: outside 2.42 sigmas the walls cannot reach half a
 * dither step and the plate's rung 0 is already the right answer, which is
 * most of the paint box.
 */
function wormBake(bd) {
    const P = bd.worm;
    const rng = mulberry32(WORM_JIT.seed);
    const jit = new Float32Array(WORM_JIT.n);
    for (let i = 0; i < WORM_JIT.n; i++) {
        jit[i] = (rng() - 0.5) * WORM_JIT.amp;
    }
    const reach = WORM_VIG[0] * WORM_REACH;
    // The dirty rectangle is fixed -- the vignette does not move -- so there
    // is no per-frame bounds pass and no union with the last frame's.
    P.x0 = P.aw;
    P.y0 = P.ah;
    P.x1 = -1;
    P.y1 = -1;
    const at = [];
    const A = [];
    const core = [];
    const phf = [];
    const sw0 = [];
    const par = [];
    for (let py = 0; py < P.ah; py++) {
        const y = bd.y0 + (py + 0.5) * ART_PIX;
        const dy = (y - P.vy) / WORM_SQUASH;
        if (Math.abs(dy) > reach) {
            continue;
        }
        const half = Math.sqrt(reach * reach - dy * dy);
        const x0 = Math.max(0, Math.ceil((P.vx - half - bd.x0) / ART_PIX - 0.5));
        const x1 = Math.min(P.aw - 1, Math.floor((P.vx + half - bd.x0) / ART_PIX - 0.5));
        if (x1 < x0) {
            continue;
        }
        if (x0 < P.x0) {
            P.x0 = x0;
        }
        if (x1 > P.x1) {
            P.x1 = x1;
        }
        if (py < P.y0) {
            P.y0 = py;
        }
        if (py > P.y1) {
            P.y1 = py;
        }
        for (let px = x0; px <= x1; px++) {
            const dx = bd.x0 + (px + 0.5) * ART_PIX - P.vx;
            const r = Math.max(Math.sqrt(dx * dx + dy * dy), WORM_RMIN);
            const u = Math.log(r);
            const bf = u / WORM_LAMBDA;
            const band = Math.floor(bf);
            const th = Math.atan2(dy, dx);
            const ph = bf + jit[((band % WORM_JIT.n) + WORM_JIT.n) % WORM_JIT.n] + (WORM_ARMS * th) / 6.2832;
            const f = ph - Math.floor(ph);
            const ss = Math.sqrt(dx * dx + dy * dy);
            const vg = Math.exp(-Math.pow(ss / WORM_VIG[0], WORM_VIG[1]));
            const wall = Math.pow(0.5 + 0.5 * Math.cos(f * 6.2832), WORM_WALL_EXP);
            const cr = WORM_CORE[1] * Math.exp(-Math.pow(ss / WORM_CORE[0], 2))
                + WORM_CORE[3] * Math.exp(-Math.pow(ss / WORM_CORE[2], 2));
            at.push(py * P.aw + px);
            A.push(vg * wall);
            core.push(cr);
            phf.push(f);
            // The striation's whole argument is that `3 th + 2.4 u` shifts
            // rigidly with the shear, so it is baked as a phase and the frame
            // only has to add to it.
            const s = (WORM_SWIRL[0] * th + WORM_SWIRL[1] * u) / 6.2832;
            sw0.push(s - Math.floor(s));
            par.push(((Math.floor(ph) % 2) + 2) % 2);
        }
    }
    P.at = Int32Array.from(at);
    P.A = Float32Array.from(A);
    P.core = Float32Array.from(core);
    P.phf = Float32Array.from(phf);
    P.sw0 = Float32Array.from(sw0);
    P.par = Uint8Array.from(par);
}

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

    /**
     * WORMHOLE. A mouth with DEPTH, and the light winds inward down it.
     *
     * What shipped before was rings rushing outward from a bright centre --
     * ripples on a pond, at 5.05 features a second, in the shape and the
     * cadence of the boss's shockwave. This inverts all three things that make
     * a ring on screen read as something that will hit you: the features move
     * inward and SHRINK, their spacing tightens ahead of them instead of
     * opening, and they arrive at 1.2 a second. What is left in common with an
     * attack is "ring-shaped", which the asteroids and the shields share too.
     *
     * Nothing in the structure moves and nothing pulses. The ribs are a
     * two-armed spiral baked into a phase, and the light is one continuous
     * crest sliding along that phase -- no duty cycle, so every art pixel is
     * always somewhere on the crest and the eye sees a spiral winding into the
     * core rather than a ring arriving. Both live terms are pure in the frame
     * counter, so there is no `update`.
     */
    pixelWormhole: {
        init(bd) {
            const aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            const ah = Math.max(1, Math.ceil(bd.h / ART_PIX));
            const cv = document.createElement("canvas");
            cv.width = aw;
            cv.height = ah;
            const g = cv.getContext("2d");
            const img = g.createImageData(aw, ah);
            bd.worm = {
                aw, ah, cv, g, img, data: img.data,
                vx: bd.W * WORM_VP.x,
                vy: bd.H * WORM_VP.y,
                tab: wormTables(),
                starMask: null,
            };
            wormBake(bd);
            bd.stars = starList(bd, WORM_STAR_SEED, WORM_STARS, WORM_STAR_A);
        },
        /**
         * Nothing bakes into the plate. Every rung the throat lights is one of
         * the two live terms away, and past the vignette's reach there is
         * nothing at all -- so the plate is the void and the star field, and
         * the live layer is the place.
         */
        field() {
            return FIELD_DARK;
        },
        /** A point light only goes down where the plate behind it is dark. */
        occlude(bd, x, y) {
            const P = bd.worm;
            const dx = x - P.vx;
            const dy = (y - P.vy) / WORM_SQUASH;
            const ss = Math.sqrt(dx * dx + dy * dy);
            const cr = WORM_CORE[1] * Math.exp(-Math.pow(ss / WORM_CORE[0], 2))
                + WORM_CORE[3] * Math.exp(-Math.pow(ss / WORM_CORE[2], 2));
            return cr > WORM_CORE_CAP ? 1 : 0;
        },
        /**
         * The shear and the crest, and only those. Both are offsets added to a
         * baked phase -- the rotation never touches a pixel, so there is no
         * rotation atlas and nothing lands on a half pixel, which is the
         * contract's baked-steps route made unnecessary rather than skipped.
         * A rung of 2 or under leaves the pixel transparent so the star behind
         * it burns through the wall, which is the same paint order the study
         * gets by drawing the star field last.
         */
        live(bd, g) {
            const P = bd.worm;
            const aw = P.aw;
            if (!P.starMask) {
                // One readback, once: which plate pixels are point lights.
                const plate = bd.layer.getContext("2d").getImageData(0, 0, aw, P.ah).data;
                const sky = bd.rgb[0];
                P.starMask = new Uint8Array(aw * P.ah);
                for (let i = 0; i < P.starMask.length; i++) {
                    const o = i * 4;
                    if (plate[o] !== sky[0] || plate[o + 1] !== sky[1] || plate[o + 2] !== sky[2]) {
                        P.starMask[i] = 1;
                    }
                }
            }
            const shear = (WORM_SWIRL[0] * WORM_OM * bd.t) / 6.2832;
            const lp = WORM_RATE * bd.t;
            const base = WORM_MIX.wall * WORM_MIX.swirlBase;
            const amp = WORM_MIX.wall * WORM_MIX.swirl;
            const d = P.data;
            const at = P.at;
            const A = P.A;
            const core = P.core;
            const phf = P.phf;
            const sw0 = P.sw0;
            const par = P.par;
            const mask = P.starMask;
            const cosT = P.tab.cos;
            const litT = P.tab.light;
            const rgb = bd.rgb;
            const n = at.length;
            for (let k = 0; k < n; k++) {
                let s = par[k] ? sw0[k] + shear : sw0[k] - shear;
                s -= Math.floor(s);
                let lf = phf[k] - lp;
                lf -= Math.floor(lf);
                let v = A[k] * (base + amp * powLook(cosT, s) + WORM_MIX.light * powLook(litT, lf));
                if (v > WORM_MIX.cap) {
                    v = WORM_MIX.cap;
                }
                const cr = core[k];
                v += cr;
                const i = at[k];
                const iy = (i / aw) | 0;
                const q = artRung(bd, v, i - iy * aw, iy, cr > WORM_CORE_CAP ? 7 : WORM_WALL_TOP);
                const o = i * 4;
                if (q === 0 || (q <= 2 && mask[i])) {
                    d[o + 3] = 0;
                    continue;
                }
                const c = rgb[q];
                d[o] = c[0];
                d[o + 1] = c[1];
                d[o + 2] = c[2];
                d[o + 3] = 255;
            }
            P.g.putImageData(P.img, 0, 0, P.x0, P.y0, P.x1 - P.x0 + 1, P.y1 - P.y0 + 1);
            g.imageSmoothingEnabled = false;
            g.drawImage(P.cv, bd.x0, bd.y0, bd.w, bd.h);
        },
    },

    /**
     * BINARY SUNS. The fifteenth Direction A conversion, and the one where the
     * study's recommendation costs the place a line of its own description.
     *
     * The companion was `#ff6b8a` -- literally one of the three colours the
     * enemies fire in -- painted as a soft radial blob 40 px across, sitting
     * still on black while real cores crossed it. It is blue-white now. The
     * study argues the swap on physics as well (mass transfer runs from the
     * evolved, swollen, cool star to the compact hot one, so a gold giant with
     * a blue-white companion is the pairing that produces the stream the place
     * is named for), and on composition: a warm half and a cool half meeting
     * at the stream is a structure two warm blobs cannot have. The cost is
     * real and worth stating -- at 130 px a red blob reads as a second sun and
     * a blue-white point reads as a star and a spotlight -- and it is why the
     * `desc` is rewritten in the same entry as the art.
     *
     * The other half of the fix is that nothing is clipped any more. The gold
     * giant's old centre sat 54 px above the top edge, so half of what the
     * place is called after was never in the frame; both stars are inside the
     * arena now, at a size that survives the 130 px thumbnail.
     *
     * The sheet is ONE shared plane centred between the stars, not a ring
     * around one of them: the radius is measured after the squash, so it reads
     * as a tilted sheet running off every edge of the box. Which ramp a pixel
     * takes is `d_blue^2 / (d_blue^2 + d_gold^2)`, and the changeover is
     * dithered rather than drawn -- the two ramps otherwise meet on a hard
     * vertical seam down the middle of the frame.
     */
    pixelBinary: {
        init(bd) {
            bd.aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            bd.ah = Math.max(1, Math.ceil(bd.h / ART_PIX));
            bd.donor = { x: bd.W * BIN_DONOR.cx, y: bd.H * BIN_DONOR.cy };
            bd.comp = { x: bd.W * BIN_COMP.cx, y: bd.H * BIN_COMP.cy };
            bd.plane = {
                x: bd.W * BIN_PLANE.cx, y: bd.H * BIN_PLANE.cy,
                ct: Math.cos(BIN_PLANE.tilt), st: Math.sin(BIN_PLANE.tilt),
            };
            bd.stream = binaryStream(bd);
            bd.stars = starList(bd, BIN_STAR_SEED, BIN_STARS, BIN_STAR_A);
            bd.sample = { warm: 0, cool: 0, dp: 0, dphi: 0, dln: 0, lit: 0, sw: 0, st: 0, hs: 0 };
            bd.mixIn = { warm: 0, cool: 0, dp: 0, dphi: 0, dln: 0, lit: 0, sw: 0, st: 0, hs: 0 };
            bd.mix = { w: 0, c: 0 };
            // The cells `live` has to revisit, and the eight scalars each of
            // them needs, packed to the list rather than kept per art pixel:
            // ten Float32Arrays over the whole box would be 7.4 MB for a
            // place that moves in a fifth of it.
            bd.act = [];
            bd.acc = [];
        },
        /**
         * A point light is put out by whatever the sheet has in front of it.
         * Recomputed rather than tabled: it is 520 samples against the 184,688
         * the bake takes, and tabling it would cost more memory than the whole
         * live pass uses.
         */
        occlude(bd, x, y) {
            const s = bd.sample;
            binarySample(bd, x, y, s);
            return Math.min(1, BIN_OCCLUDE * (s.warm + s.cool + s.dp * 0.8 + s.sw));
        },
        /**
         * The bake does its own quantise and returns the rung, because `live`
         * has to reproduce it exactly for every cell it does NOT touch. It
         * also decides, per pixel, whether the pixel can ever change -- and
         * the cells that cannot are the plate, forever.
         */
        field(bd, x, y) {
            const cx = clamp(Math.floor((x - bd.x0) / ART_PIX), 0, bd.aw - 1);
            const cy = clamp(Math.floor((y - bd.y0) / ART_PIX), 0, bd.ah - 1);
            const s = bd.sample;
            binarySample(bd, x, y, s);
            binaryMix(s, BIN_ARM[0] + BIN_ARM[1] * 0.5, BIN_FLOW.base, 1, 1, bd.mix);
            const pick = binaryPick(bd, bd.mix.w, bd.mix.c, cx, cy);
            if (binaryActive(bd, s, cx, cy)) {
                bd.act.push(cy * bd.aw + cx);
                bd.acc.push(s.warm, s.cool, s.dp, s.dphi, s.dln, s.lit, s.sw, s.st, s.hs);
            }
            return { flat: pick >> 1, rgb: pick & 1 ? bd.rgbAlt : bd.rgb };
        },
        /**
         * Runs after the point lights go down, which is the only reason it is
         * here: a star standing on a cell `live` repaints would be erased by
         * it every frame, so the ones that do are copied into the overlay.
         */
        hard(bd) {
            const n = bd.act.length;
            const act = new Int32Array(bd.act);
            const acc = new Float32Array(bd.acc);
            bd.act = act;
            bd.acc = acc;
            const mask = new Uint8Array(bd.aw * bd.ah);
            let x0 = bd.aw;
            let y0 = bd.ah;
            let x1 = -1;
            let y1 = -1;
            for (let i = 0; i < n; i++) {
                const k = act[i];
                mask[k] = 1;
                const cx = k % bd.aw;
                const cy = (k - cx) / bd.aw;
                if (cx < x0) { x0 = cx; }
                if (cx > x1) { x1 = cx; }
                if (cy < y0) { y0 = cy; }
                if (cy > y1) { y1 = cy; }
            }
            const cv = document.createElement("canvas");
            cv.width = bd.aw;
            cv.height = bd.ah;
            const g = cv.getContext("2d");
            const img = g.createImageData(bd.aw, bd.ah);
            bd.surf = { cv, g, img, data: img.data, x0, y0, x1, y1 };
            // The same decision `_bakeField` just made about each star, redone
            // so the ones over the sheet can be put back on top of the overlay.
            const ramp = rampRGB(starRamp(bd));
            const pix = [];
            for (const s of bd.stars) {
                const a = s.a * (1 - PAINTERS.pixelBinary.occlude(bd, s.x, s.y));
                if (a < 0.1) {
                    continue;
                }
                const q = Math.round(clamp(a, 0, 1) * 3) / 3;
                const col = q > 0.66 ? ramp[2] : q > 0.33 ? ramp[1] : ramp[0];
                const sx = Math.floor((s.x - bd.x0) / ART_PIX);
                const sy = Math.floor((s.y - bd.y0) / ART_PIX);
                const w = s.big ? 2 : 1;
                for (let r = sy; r < sy + w; r++) {
                    for (let c = sx; c < sx + w; c++) {
                        if (c < 0 || c >= bd.aw || r < 0 || r >= bd.ah || !mask[r * bd.aw + c]) {
                            continue;
                        }
                        pix.push(r * bd.aw + c, col[0], col[1], col[2]);
                    }
                }
            }
            bd.starPix = new Int32Array(pix);
        },
        /**
         * Four sines and a ramp choice per active art pixel, into an
         * art-resolution overlay uploaded once. The place's subject is
         * material in motion and the cheapest honest version of that is a
         * phase term over a baked distance field: the stream's geometry, the
         * sheet's arms and the hot spot's kernel are all baked, and only their
         * brightness moves.
         */
        live(bd, g) {
            const s = bd.surf;
            const f = bd.t;
            const flick = 1 + BIN_FLICK_A
                * (BIN_FLICK[0][2] * Math.sin(f * BIN_FLICK[0][0] + BIN_FLICK[0][1])
                    + BIN_FLICK[1][2] * Math.sin(f * BIN_FLICK[1][0] + BIN_FLICK[1][1]));
            const breathe = 1 + BIN_BREATHE[1] * Math.sin(f * BIN_BREATHE[0]);
            const spin = BIN_SPIN * f;
            const act = bd.act;
            const acc = bd.acc;
            const m = bd.mixIn;
            const mix = bd.mix;
            const data = s.data;
            const aw = bd.aw;
            for (let i = 0; i < act.length; i++) {
                const o = i * 9;
                m.warm = acc[o];
                m.cool = acc[o + 1];
                m.dp = acc[o + 2];
                m.lit = acc[o + 5];
                m.sw = acc[o + 6];
                m.st = acc[o + 7];
                m.hs = acc[o + 8];
                const sa = Math.sin(BIN_ARMS * (acc[o + 3] - spin) + BIN_PITCH * acc[o + 4]);
                const arm = BIN_ARM[0] + BIN_ARM[1] * (sa > 0 ? sa * sa : 0);
                const flow = BIN_FLOW.base + BIN_FLOW.amp
                    * Math.sin(6.2832 * (m.st * BIN_FLOW.waves - f * BIN_FLOW.rate));
                binaryMix(m, arm, flow, flick, breathe, mix);
                const k = act[i];
                const cx = k % aw;
                const pick = binaryPick(bd, mix.w, mix.c, cx, (k - cx) / aw);
                const col = (pick & 1 ? bd.rgbAlt : bd.rgb)[pick >> 1];
                const p = k * 4;
                data[p] = col[0];
                data[p + 1] = col[1];
                data[p + 2] = col[2];
                data[p + 3] = 255;
            }
            const sp = bd.starPix;
            for (let i = 0; i < sp.length; i += 4) {
                const p = sp[i] * 4;
                data[p] = sp[i + 1];
                data[p + 1] = sp[i + 2];
                data[p + 2] = sp[i + 3];
                data[p + 3] = 255;
            }
            if (s.x1 < s.x0) {
                return;
            }
            s.g.putImageData(s.img, 0, 0, s.x0, s.y0, s.x1 - s.x0 + 1, s.y1 - s.y0 + 1);
            g.imageSmoothingEnabled = false;
            g.drawImage(s.cv, bd.x0, bd.y0, bd.w, bd.h);
        },
    },

    /**
     * PULSAR. The eleventh Direction A conversion, and the first one where the
     * study's own composition contradicted the sentence the place is named
     * after -- so the port had to decide which of the two to keep.
     *
     * The defect was emptiness: a beam, a dot and black. The fix is five
     * depths, four of them baked -- far stars, two nebula sheets, the torus
     * and jets, an asteroid belt, and a silhouette along the bottom of the box
     * -- so `field` is the layer this place has never had and is the whole of
     * the answer to the emptiness. `live` is four things: the two beam cones,
     * the core, its halo and the wisps, none of which can bake because each
     * depends on the rotation phase.
     *
     * One clock. Rotation is 240 frames, the beams are antipodal, so any line
     * the arena holds is crossed every 120 -- two seconds, which is what the
     * glossary line has always promised and what the painter this replaces
     * missed by a factor of 2.4. The same phase drives the beam direction, the
     * foreshortening, the core and the wisp launches; there is no second rate
     * anywhere in the place.
     *
     * Departures from the study, and why:
     *   1. **The misalignment is 72 degrees, not 22.** See `PULSAR_ALPHA`: at
     *      the study's own default nothing it promises can happen, because the
     *      beam cone never reaches the line of sight and the projected beam
     *      never leaves a 58 degree wedge. This is the one number that had to
     *      move, and moving it makes seven of the sheet's claims true at once.
     *   2. The study asks for an art-pixel context in `live` and calls it "the
     *      one real engine ask in the port". It is not an ask: COMET TRAIL
     *      already keeps an art-resolution surface and re-uploads only the
     *      rectangle the last frame dirtied, so `live` here writes art pixels
     *      through the same dither as `field` with no engine change at all.
     *   3. The dirty rectangle is not the union of the beam boxes. Each
     *      element rasterises only its own shape -- the cones are trapezoids,
     *      the wisps are strips of quads in torus coordinates -- into an
     *      accumulator, and the resolve pass walks the rectangle once. The
     *      union-of-boxes version the study describes visits about 155k cells
     *      a frame where this visits the ~40k it actually paints.
     *   4. Its `r < 470` screen gate on the wisps is dropped. It exists to
     *      keep an `atan2` off most of the canvas, which per-arc rasterisation
     *      already does, and it cuts the outer arcs on a hard circle.
     *   5. `topRung` is 6 and the split cap the study wants is free: `field`
     *      stores the plate clamped to the cap, and `live` composes against
     *      the full ramp, so rung 7 belongs to the beam cores and the wisp
     *      heads and nothing else.
     *   6. The star ramp comes down, as it has for EVENT HORIZON, COMET TRAIL
     *      and RINGED GIANT -- see the entry.
     *   7. The drift stays the engine's, not the study's 1400-frame sine.
     *      Five places breathing out of step with the other 22 is a worse
     *      defect than a slow breath, which the first conversion settled.
     */
    pixelPulsar: {
        init(bd) {
            bd.sx = bd.W * PULSAR_STAR[0];
            bd.sy = bd.H * PULSAR_STAR[1];
            bd.neb = mkNoise(0x7a11);
            bd.mask = mkNoise(0x0b2f);
            bd.fil = mkNoise(0x23c4);
            bd.knot = mkNoise(0x1f60);
            bd.sil = mkNoise(0x33a7);
            bd.mottle = mkNoise(0x5ac2);
            bd.stars = starList(bd, PULSAR_STAR_SEED, PULSAR_STARS, 0.24);
            pulsarBelt(bd);
            const aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            const ah = Math.max(1, Math.ceil(bd.h / ART_PIX));
            const cv = document.createElement("canvas");
            cv.width = aw;
            cv.height = ah;
            const g = cv.getContext("2d");
            const img = g.createImageData(aw, ah);
            const last = bd.rgb.length - 1;
            bd.pul = {
                cv, g, img, data: img.data, aw, ah, last,
                cap: Math.min(bd.p.topRung === undefined ? last : bd.p.topRung, last),
                // The plate the live layer adds to. 16 bits is 300 times finer
                // than the dither's own threshold step and half the memory of
                // a float, which matters at one entry per art pixel of the box.
                f: new Uint16Array(aw * ah),
                acc: new Float32Array(aw * ah),
                stamp: new Int32Array(aw * ah),
                // What each row painted this frame and last, so the resolve
                // walks the cones and not the box around them.
                span: new Int32Array(ah * 2),
                pspan: new Int32Array(ah * 2),
                star: null, frame: 0, base: 0,
                // What this frame painted, and what the last one did: between
                // them, everything that has to be redrawn or cleared.
                x0: 0, y0: 0, x1: -1, y1: -1,
                px0: 0, py0: 0, px1: -1, py1: -1,
            };
        },
        /**
         * A star goes where the near depths are solid, and also where the
         * plate behind it is already lit -- the second is COMET TRAIL's rule,
         * and here it costs nothing, because the bake has already sampled
         * every cell by the time the stars go down.
         */
        occlude(bd, x, y) {
            if (pulsarSolid(bd, x, y)) {
                return 1;
            }
            const P = bd.pul;
            const px = clamp(Math.round((x - bd.x0) / ART_PIX - 0.5), 0, P.aw - 1);
            const py = clamp(Math.round((y - bd.y0) / ART_PIX - 0.5), 0, P.ah - 1);
            const v = P.f[py * P.aw + px] / 65535;
            return lum(bd.rgb[clamp(Math.round(v * P.last), 0, P.cap)]) >= PULSAR_STAR_LIT ? 1 : 0;
        },
        field(bd, x, y) {
            const P = bd.pul;
            const v = pulsarPlate(bd, x, y);
            // The bake samples cell centres, so the cell is recoverable from
            // the coordinate and the plate can be cached on the way past
            // rather than computed a second time for the live layer.
            const px = Math.round((x - bd.x0) / ART_PIX - 0.5);
            const py = Math.round((y - bd.y0) / ART_PIX - 0.5);
            if (px >= 0 && py >= 0 && px < P.aw && py < P.ah) {
                P.f[py * P.aw + px] = Math.round(Math.min(v, P.cap / P.last) * 65535);
            }
            return v > 0 ? { v: Math.min(v, 1) } : FIELD_DARK;
        },
        live(bd, g) {
            const P = bd.pul;
            if (!P.star) {
                pulsarStarMap(bd);
            }
            const B = pulsarBeams((bd.t % PULSAR_PERIOD) * PULSAR_OMEGA);
            const W = pulsarWisps(bd.t);
            // The stamp carries the frame in its high bits; roll it before it
            // can walk off the end of what an Int32Array holds.
            if (P.frame > 0x6ffffff) {
                P.stamp.fill(0);
                P.frame = 0;
            }
            P.frame++;
            P.base = P.frame * 8;
            P.x0 = P.aw;
            P.y0 = P.ah;
            P.x1 = -1;
            P.y1 = -1;
            const prevSpan = P.span;
            P.span = P.pspan;
            P.pspan = prevSpan;
            P.span.fill(-1);
            pulsarBeam(bd, B[0], P.base);
            pulsarBeam(bd, B[1], P.base + 1);
            pulsarCore(bd, Math.max(B[0].pulse, B[1].pulse));
            for (let i = 0; i < W.length; i++) {
                pulsarWisp(bd, W[i], P.base + 3 + i);
            }
            // Everything this frame painted, plus everything the last one did
            // and this one does not: what it stopped painting still has to
            // stop showing.
            let ux0 = P.x0;
            let uy0 = P.y0;
            let ux1 = P.x1;
            let uy1 = P.y1;
            if (P.px1 >= P.px0) {
                ux0 = ux1 < ux0 ? P.px0 : Math.min(ux0, P.px0);
                uy0 = uy1 < uy0 ? P.py0 : Math.min(uy0, P.py0);
                ux1 = Math.max(ux1, P.px1);
                uy1 = Math.max(uy1, P.py1);
            }
            const d = P.data;
            for (let py = uy0; py <= uy1; py++) {
                // This row's cones, plus whatever the last frame left on it:
                // what stopped being painted still has to stop showing.
                let rx0 = P.span[py * 2];
                let rx1 = P.span[py * 2 + 1];
                const px0 = P.pspan[py * 2];
                if (px0 >= 0) {
                    if (rx0 < 0 || px0 < rx0) { rx0 = px0; }
                    const px1 = P.pspan[py * 2 + 1];
                    if (px1 > rx1) { rx1 = px1; }
                }
                if (rx0 < 0) {
                    continue;
                }
                const row = (py & 3) * 4;
                for (let px = rx0; px <= rx1; px++) {
                    const i = py * P.aw + px;
                    const o = i * 4;
                    if (P.stamp[i] < P.base) {
                        d[o] = 0;
                        d[o + 1] = 0;
                        d[o + 2] = 0;
                        d[o + 3] = 0;
                        continue;
                    }
                    // Plate plus live, through one dither: the beam brightens
                    // what it crosses rather than replacing it, so it cannot
                    // show a tone the sky under it does not have.
                    const v = Math.min(1, P.f[i] / 65535 + P.acc[i]);
                    const bay = (BAYER[row + (px & 3)] / 16 - 0.46) * DITHER;
                    const rung = clamp(Math.round(v * P.last + bay), 0, P.last);
                    const s = P.star[i];
                    const col = s >= 0 && rung <= 2 + s ? P.sramp[s] : bd.rgb[rung];
                    d[o] = col[0];
                    d[o + 1] = col[1];
                    d[o + 2] = col[2];
                    d[o + 3] = 255;
                }
            }
            if (ux1 >= ux0) {
                P.g.putImageData(P.img, 0, 0, ux0, uy0, ux1 - ux0 + 1, uy1 - uy0 + 1);
            }
            P.px0 = P.x0;
            P.py0 = P.y0;
            P.px1 = P.x1;
            P.py1 = P.y1;
            g.imageSmoothingEnabled = false;
            g.drawImage(P.cv, bd.x0, bd.y0, bd.w, bd.h);
        },
    },

    /**
     * OCEAN WORLD. The twelfth Direction A conversion, and the first place
     * whose whole subject is a PLANE seen edge on -- which makes every number
     * in it a function of one variable, how far down the water a row is.
     *
     * `field` is the sky above the horizon on one ramp and the water below it
     * on a second, plus the sun's bloom where they meet. Everything else is a
     * depth ladder: 30 crest rows placed at `horizon + WH * u^1.75`, with the
     * length of a dash, the gap to the next, its height and the speed it
     * travels all read off the same `u`. Five rate bands a factor of 2.6
     * apart, far to near; the three far ones bake and only scroll, the two
     * near ones are live because what they do is the point -- a crest line
     * lengthens, breaks and reforms.
     *
     * Two things carry the place. The first is the reflection: the low cloud
     * layer again, mirrored under the horizon and squashed to a third, with a
     * swell running down it. The second is `oceanCap`, which is where the
     * brightness control lives -- near water gives back less sky than far
     * water, AND the bottom 200 px of the arena is held two rungs under the
     * rest because that is where the player sits. Doing it in the cap rather
     * than in a veil is what lets this place carry a bright sky at all.
     *
     * Departures from the study, and why:
     *   1. **One surface instead of 400 rasterising calls.** The study draws
     *      the reflection as four sheared blits, every far band as two, and
     *      every near dash, glitter, foam and spore as its own `fillRect`:
     *      about 420 a frame, against a catalogue whose most expensive place
     *      is 97 and whose ocean is 87. Everything below the horizon is
     *      written into one art-resolution surface instead -- COMET TRAIL's
     *      and PULSAR's idiom -- so the whole water is 2 calls and the port
     *      comes out CHEAPER than the painter it replaces.
     *   2. The reflection is written, not blitted through a negative scale.
     *      That is what makes it land on the lattice, and it lets the shear be
     *      a continuous function of the source row instead of the study's four
     *      hard slices: the swell runs down the reflection rather than
     *      stepping through it in quarters.
     *   3. The sky is dithered. The study quantises it with the dither
     *      amplitude set to zero, which is eight hard bands down the box --
     *      and banding is the defect `DITHER` exists to fix, named in the
     *      first conversion. The hard edge the sheet asks for is the HORIZON,
     *      and that is a ramp change, not a gradient artefact.
     *   4. Its veil is a vertical gradient, weighted to the bottom. Here the
     *      cap already does that structurally and per rung, so the place takes
     *      a flat number like every other one -- see the entry for what it
     *      cost to check.
     *   5. Fifth star ramp to come down. #9fe8f2 / #cdf6fb / #eafeff measures
     *      luminance 0.85 / 0.93 / 0.98 against the 0.62 the detector cuts at,
     *      and a 9 px spore of it against the dark top of the box is a bullet
     *      by every test the programme has.
     *   6. Drift stays the engine's, as it has for eleven places.
     */
    pixelOcean: {
        init(bd) {
            bd.hz = bd.H * OCEAN_HORIZON;
            bd.wh = bd.y0 + bd.h - bd.hz;
            bd.bloom = bd.W * OCEAN_BLOOM;
            bd.oc = { sramp: rampRGB(starRamp(bd)) };
            const rows = oceanRows(bd);
            bd.oc.cloud = [];
            for (let layer = 0; layer < OCEAN_BANKS.length; layer++) {
                const s = oceanCloudStrip(bd, layer, false);
                bd.oc.cloud.push({ s, cv: oceanStripCanvas(s, bd.rgb) });
            }
            bd.oc.reflect = oceanCloudStrip(bd, 1, true);
            bd.oc.far = [];
            for (let band = 0; band < OCEAN_BANDS.length - 1; band++) {
                const s = oceanFarStrip(bd, band, rows);
                if (s) {
                    bd.oc.far.push(s);
                }
            }
            oceanLists(bd, rows);
            const aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            const ah = Math.max(1, Math.ceil(bd.h / ART_PIX));
            const cv = document.createElement("canvas");
            cv.width = aw;
            cv.height = ah;
            const g = cv.getContext("2d");
            const img = g.createImageData(aw, ah);
            // Everything live in this place is under the horizon except the
            // spores, so the surface is a band and not the box: it is cleared
            // and uploaded whole every frame, and that band is a third of it.
            bd.oc.surf = {
                cv, g, img, data: img.data, aw, ah,
                y0: clamp(Math.ceil((bd.hz - bd.y0) / ART_PIX), 0, ah - 1),
                y1: ah - 1,
            };
        },
        field(bd, x, y) {
            const p = oceanPlate(bd, x, y);
            return { v: Math.min(1, p.v), cap: oceanCap(bd, y), rgb: p.sea ? bd.rgbAlt : bd.rgb };
        },
        live(bd, g) {
            const t = bd.t;
            const S = bd.oc.surf;
            g.imageSmoothingEnabled = false;
            // The sky: two cloud layers, each wrapped, the low one running
            // nearly three times the high one. The only parallax up there.
            for (const c of bd.oc.cloud) {
                const sw = c.s.aw * ART_PIX;
                const off = -((t * c.s.rate) % sw);
                for (let k = 0; k < 2; k++) {
                    g.drawImage(c.cv, bd.x0 + off + k * sw, c.s.top, sw, c.s.ah * ART_PIX);
                }
            }
            S.data.fill(0, S.y0 * S.aw * 4, (S.y1 + 1) * S.aw * 4);
            oceanReflect(bd, t);
            oceanFar(bd, t);
            oceanNear(bd, t);
            oceanGlitter(bd, t);
            oceanFoam(bd, t);
            S.g.putImageData(S.img, 0, 0, 0, S.y0, S.aw, S.y1 - S.y0 + 1);
            g.drawImage(S.cv, bd.x0, bd.y0, bd.w, bd.h);
            oceanSpores(bd, g, t);
        },
    },

    /**
     * ION STORM. The thirteenth Direction A conversion, and the first place
     * whose sky cannot bake at all: a curtain moves, so `field` holds only
     * what is behind it and every art pixel of the front is decided again
     * every frame.
     *
     * Seven curtains across the box. Each one slides bodily, leans on a shear
     * about 42% of the box height, and folds -- a horizontal displacement
     * running down it, which is what makes it read as a folded sheet rather
     * than as a bar. Across its width the field falls off to soft flanks; down
     * it, an envelope rises fast and falls slow, so the bright part is in the
     * top half of the arena and the bottom is left to the stars. Inside that,
     * rays on an 18 px pitch, each flaring and dying on its own 0.3-0.7 s
     * clock. Behind everything, a dust band and 430 stars, and the curtain
     * only takes 18% of a star it crosses -- an aurora is thin, and that
     * translucency is what fills a frame that used to be five soft bars.
     *
     * Roughly once every 9600 frames the storm breaks up for 210: two of the
     * seven curtains fold at 2.6x, brighten, flicker half again as fast, and a
     * front runs along the sky at 6 px a frame. It is the one time the cap
     * lifts to rung 7 and the place reaches its own tint. All of it is a pure
     * function of the frame counter, so the place keeps no state and a still
     * at frame 1500 is exact.
     *
     * Departures from the study, and why:
     *   1. **It walks the box, not a window.** The study asks for the arena
     *      rectangle to be passed to the painter, and costs the full box at
     *      5.9 ms against 2.1-2.7 for the window. Neither number has to be
     *      paid: a curtain's cross-section is a pure function of the distance
     *      from its spine, so a row is one 1-D profile shifted to wherever the
     *      spine is -- a multiply and a lookup per art pixel, and ~380 profile
     *      cells a frame to build all seven. That makes the whole box cheaper
     *      than its window, and the engine keeps a contract with no camera in
     *      it. Which matters: the camera does pull back here, on wave 450.
     *   2. **`live` writes art pixels through the dither**, over an
     *      art-resolution surface -- COMET TRAIL's and PULSAR's idiom -- so
     *      the study's "per-frame quantised pass" needs no engine change. The
     *      cap lifting 6 -> 7 for a breakup is then free as well: `field`
     *      takes the entry's `topRung` and the live pass owns its own.
     *   3. Two ramps mixed per element is `ramp` and `landRamp`, and the dust
     *      needs a third -- `dustRamp`, three rungs, returned by `field` with
     *      its own `cap`. The contract already allowed a sample to name its
     *      ramp, so this is a field on the entry and nothing else.
     *   4. The tint is divided by the field BEFORE the patch multiplies it,
     *      not after. The study divides after, which drags every curtain under
     *      a patch toward green by the patch's own gain; the tint is supposed
     *      to be a weighted mean of the tints over a cell, and a uniform scale
     *      cannot change one.
     *   5. Drift stays the engine's, as it has for twelve places.
     */
    pixelIon: {
        init(bd) {
            const aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            const ah = Math.max(1, Math.ceil(bd.h / ART_PIX));
            const cv = document.createElement("canvas");
            cv.width = aw;
            cv.height = ah;
            const g = cv.getContext("2d");
            const img = g.createImageData(aw, ah);
            const last = bd.rgb.length - 1;
            bd.ion = {
                cv, g, img, data: img.data, aw, ah, last,
                cap: Math.min(bd.p.topRung === undefined ? last : bd.p.topRung, last),
                dust: rampRGB(bd.p.dustRamp),
                n1: mkNoise(0x1c47),
                n2: mkNoise(0x53b0),
                acc: new Float32Array(aw * ah),
                tacc: new Float32Array(aw * ah),
                stamp: new Int32Array(aw * ah),
                // The x range each row's curtains actually reached, so the
                // resolve pass walks the curtains rather than the box.
                span: new Int32Array(ah * 2),
                // Both ramps flattened: the resolve reads them 350k times a
                // frame and an array of arrays is two loads where one will do.
                flatA: Float32Array.from(bd.rgb.flat()),
                flatB: Float32Array.from(bd.rgbAlt.flat()),
                grid: {
                    w: Math.ceil(aw / ION_PATCH_GRID) + 1,
                    h: Math.ceil(ah / ION_PATCH_GRID) + 1,
                },
                baked: null, frame: 0, base: 0, front: 0, bu: { a: 0, ph: 0, epoch: 0 },
            };
            bd.ion.grid.v = new Float32Array(bd.ion.grid.w * bd.ion.grid.h);
            bd.ion.cur = ionCurtains(bd);
            bd.stars = starList(bd, ION_STAR_SEED, ION_STARS, 0.24);
        },
        /**
         * Only what is behind the curtains: a dust band on three dim rungs of
         * its own ramp. The stars go on top of it in the shared bake, and
         * nothing dims them there -- a curtain hides 18% of one, and a curtain
         * is live, so that is the live layer's job and not `occlude`'s.
         */
        field(bd, x, y) {
            const D = ION_DUST;
            const bx = x - bd.x0;
            const by = y - bd.y0;
            const d = (y - (bd.y0 + bd.h * D.at)) / (bd.h * D.sigma);
            const n = bd.ion.n1(bx / D.scale[0], by / D.scale[1], 1) * D.mix
                + bd.ion.n2(bx / D.scale[2], by / D.scale[3], 1) * (1 - D.mix);
            const v = (n - D.cut) * D.gain * Math.exp(-d * d);
            return {
                v: (Math.max(0, v) * ION_DUST_RUNGS) / bd.ion.last,
                rgb: bd.ion.dust,
                cap: ION_DUST_RUNGS - 1,
            };
        },
        live(bd, g) {
            const P = bd.ion;
            if (!P.baked) {
                // The plate the curtains are composited over. One readback,
                // once: the curtain attenuates what is behind it rather than
                // covering it, so the live layer has to know what that is.
                P.baked = bd.layer.getContext("2d").getImageData(0, 0, P.aw, P.ah).data;
            }
            if (P.frame > 0x6ffffff) {
                P.stamp.fill(0);
                P.frame = 0;
            }
            P.frame++;
            P.base = P.frame * 8;
            ionStep(bd, bd.t);
            ionCurtainPass(bd);
            // Hoisted out of the loop, all of it: this is 165k iterations a
            // frame and a property load per read costs more than the maths.
            const d = P.data;
            const b = P.baked;
            const acc = P.acc;
            const tacc = P.tacc;
            const stamp = P.stamp;
            const span = P.span;
            const base = P.base;
            const aw = P.aw;
            const gv = P.grid.v;
            const ra = P.flatA;
            const rb = P.flatB;
            const G = P.grid;
            // Rung 7 is this place's own tint, and it belongs to the breakup.
            const top = P.bu.a > 0 ? P.last : P.cap;
            // A curtain ADDS to the plate it stands in front of, which is what
            // lets a star burn through it -- and a star plus a top-rung ray
            // adds past 255 and clips to near-white, a small pale speck on a
            // dark field, which is a bullet. The sum is held to the place's
            // own brightest tone instead: the star still shows through
            // everything under the top rung, and the frame cannot show a
            // colour neither ramp has.
            const capA = bd.rgb[P.last];
            const capB = bd.rgbAlt[P.last];
            d.fill(0);
            for (let ay = 0; ay < P.ah; ay++) {
                const xA = span[ay * 2];
                if (xA < 0) {
                    continue;
                }
                const xB = span[ay * 2 + 1];
                const gy = ((ay / ION_PATCH_GRID) | 0) * G.w;
                const row = ay * aw;
                for (let ax = xA; ax <= xB; ax++) {
                    const i = row + ax;
                    if (stamp[i] < base) {
                        continue;
                    }
                    const f0 = acc[i];
                    const pg = gv[gy + ((ax / ION_PATCH_GRID) | 0)];
                    let f = pg > 0 ? f0 * (1 + ION_PATCH_GAIN[1] * pg) : f0;
                    if (f <= ION_MIN) {
                        continue;
                    }
                    if (f > 1) {
                        f = 1;
                    }
                    // A bright core takes a dither offset that depends on x
                    // only, so a ray stays one unbroken vertical run instead
                    // of breaking into halftone pieces under 40 px -- which is
                    // what a bullet is.
                    const bi = f > ION_COHERENT
                        ? BAYER[(ax & 3) * 4 + ((ax >> 2) & 3)]
                        : BAYER[(ay & 3) * 4 + (ax & 3)];
                    let rung = (f * ION_RUNG + bi / 16 - 0.5) | 0;
                    if (rung > top) {
                        rung = top;
                    }
                    if (rung <= 0) {
                        continue;
                    }
                    // The tint is the mean of the tints over this cell, so it
                    // is read off the field BEFORE the patch scales it: a
                    // uniform gain cannot change a weighted mean.
                    const tn = tacc[i] / f0;
                    const k = rung * 3;
                    const att = 1 - ION_OCCLUDE * f;
                    const o = i * 4;
                    const r0 = b[o] * att + ra[k] + (rb[k] - ra[k]) * tn;
                    const g0 = b[o + 1] * att + ra[k + 1] + (rb[k + 1] - ra[k + 1]) * tn;
                    const b0 = b[o + 2] * att + ra[k + 2] + (rb[k + 2] - ra[k + 2]) * tn;
                    const cr = capA[0] + (capB[0] - capA[0]) * tn;
                    const cg = capA[1] + (capB[1] - capA[1]) * tn;
                    const cb = capA[2] + (capB[2] - capA[2]) * tn;
                    d[o] = r0 < cr ? r0 : cr;
                    d[o + 1] = g0 < cg ? g0 : cg;
                    d[o + 2] = b0 < cb ? b0 : cb;
                    d[o + 3] = 255;
                }
            }
            P.g.putImageData(P.img, 0, 0);
            g.imageSmoothingEnabled = false;
            g.drawImage(P.cv, bd.x0, bd.y0, bd.w, bd.h);
        },
    },

    /**
     * SUPERNOVA. A shell thrown outward and lopsided, ploughing into a dense
     * cloud on one flank. It is a QUANTISED PLACE and a still one: thirty-four
     * filament strands, twelve spokes and a sheet layer are decided per art
     * pixel inside `field` as a hard threshold rather than stroked, the dust is
     * a smooth density the dither carries, and the middle is a cavity with
     * nothing in it at all.
     *
     * Nothing here moves. The one live term is a LIGHT ECHO -- a Gaussian
     * brightness front sliding outward along the shock, lifting the dust it
     * crosses by a quarter of the ramp and touching neither the filaments nor
     * the stars. What travels is which dust is lit; no thing on screen has a
     * position that changes. That is the whole answer to the place the entry
     * used to apologise for: the expanding concentric ring, which the boss owns
     * and this place is now the only thing in the frame that is not.
     */
    pixelSupernova: {
        init(bd) {
            const aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            const ah = Math.max(1, Math.ceil(bd.h / ART_PIX));
            const cv = document.createElement("canvas");
            cv.width = aw;
            cv.height = ah;
            const g = cv.getContext("2d");
            const img = g.createImageData(aw, ah);
            const last = bd.rgb.length - 1;
            const n = aw * ah;
            bd.sn = {
                aw, ah, cv, g, img, data: img.data,
                cx: bd.W * SN_C.cx,
                cy: bd.H * SN_C.cy,
                r: bd.H * SN_R,
                dx: Math.cos(SN_SHOCK),
                dy: Math.sin(SN_SHOCK),
                top: Math.min(bd.p.topRung === undefined ? last : bd.p.topRung, last),
                priLum: Float32Array.from(bd.rgb, lum),
                secLum: Float32Array.from(bd.rgbAlt, lum),
                env: supernovaEnvelope(),
                n: {
                    bkA: mkNoise(0x9e51), bkB: mkNoise(0x2f0d), knot: mkNoise(0x41b3),
                    str: mkNoise(0x7717), fine: mkNoise(0x2903), dust: mkNoise(0x0331),
                    mottle: mkNoise(0x0617), ha: mkNoise(0x0055),
                },
                fil: new Float32Array(n),
                dust: new Float32Array(n),
                ha: new Float32Array(n),
                u: new Float32Array(n),
                ax0: clamp(Math.floor(-bd.x0 / ART_PIX), 0, aw - 1),
                ax1: clamp(Math.floor((bd.W - bd.x0) / ART_PIX), 0, aw - 1),
                ay0: clamp(Math.floor(-bd.y0 / ART_PIX), 0, ah - 1),
                ay1: clamp(Math.floor((bd.H - bd.y0) / ART_PIX), 0, ah - 1),
                // The lit lane's bounding box, so the next frame knows exactly
                // what to put back to the plate's own colour.
                rect: [aw, ah, -1, -1],
                at: null,
            };
            bd.sn.strands = supernovaStrands(bd);
            bd.sn.spokes = supernovaSpokes(bd);
            bd.stars = starList(bd, SN_STAR_SEED, SN_STARS, SN_STAR_A);
        },
        field(bd, x, y) {
            const P = bd.sn;
            const ix = Math.floor((x - bd.x0) / ART_PIX);
            const iy = Math.floor((y - bd.y0) / ART_PIX);
            const i = iy * P.aw + ix;
            supernovaSample(bd, i, x, y);
            const d = P.dust[i];
            const pv = P.fil[i] > d ? P.fil[i] : d;
            // The Halpha knots take the second ramp, but only where they would
            // actually be brighter than the cool rung underneath them: capped
            // three rungs up against a cool ramp capped at five, the warmest
            // thing in this sky is darker than its own dust plateau.
            if (P.ha[i] > 0) {
                const qs = artRung(bd, P.ha[i], ix, iy, SN_HA_TOP);
                if (qs > 0 && P.secLum[qs] > P.priLum[artRung(bd, pv, ix, iy, P.top)]) {
                    return { v: P.ha[i], rgb: bd.rgbAlt, cap: SN_HA_TOP };
                }
            }
            return { v: pv };
        },
        /** Filaments hide a star; the dust barely does, because it is haze. */
        occlude(bd, x, y) {
            const P = bd.sn;
            const ix = clamp(Math.floor((x - bd.x0) / ART_PIX), 0, P.aw - 1);
            const iy = clamp(Math.floor((y - bd.y0) / ART_PIX), 0, P.ah - 1);
            const i = iy * P.aw + ix;
            return clamp(SN_OCCLUDE[0] * P.fil[i] + SN_OCCLUDE[1] * (P.dust[i] / SN_OCCLUDE[2]), 0, 1);
        },
        /**
         * The echo, and only the echo: a binary-search slice of the pre-sorted
         * index either side of each front, re-quantised at the added
         * brightness, and only the pixels whose rung actually changed are
         * written. The lane goes into an overlay rather than into the plate, so
         * the plate stays the unlit truth and a pixel the front has left is put
         * back by clearing it instead of by repainting it -- which is what
         * stops a rung sticking on for the rest of the run.
         *
         * There is no `update`: the front's position is a pure function of the
         * frame counter, so pause freezes it, slow motion slows it,
         * `backdropThumb` jumps straight to 1500, and two clients in a co-op
         * match watch the same gas light up without a byte on the bus.
         */
        live(bd, g) {
            const P = bd.sn;
            if (!P.at) {
                supernovaIndex(bd);
            }
            const E = P.echo;
            const per = E.period;
            const off = SN_ECHO.phase * per;
            const sA = E.s0 + SN_ECHO.rate * ((((bd.t + off) % per) + per) % per);
            const sB = E.s0 + SN_ECHO.rate * ((((bd.t + off + per / 2) % per) + per) % per);
            const d = P.data;
            const r = P.rect;
            const aw = P.aw;
            for (let y = r[1]; y <= r[3]; y++) {
                d.fill(0, (y * aw + r[0]) * 4, (y * aw + r[2] + 1) * 4);
            }
            const at = P.at;
            const eu = P.eu;
            const fi = P.fi;
            const du = P.du;
            const hq = P.hq;
            const bs = P.bs;
            const rgb = bd.rgb;
            const alt = bd.rgbAlt;
            const priL = P.priLum;
            const secL = P.secLum;
            const env = P.env;
            const top = P.top;
            const last = rgb.length - 1;
            let x0 = aw;
            let y0 = P.ah;
            let x1 = -1;
            let y1 = -1;
            for (let pass = 0; pass < 2; pass++) {
                const s = pass ? sB : sA;
                const hi = lowerBound(eu, s + SN_ECHO.win);
                for (let k = lowerBound(eu, s - SN_ECHO.win); k < hi; k++) {
                    // The envelope falls with distance, so the nearer front is
                    // always the brighter one and one lookup answers both.
                    const da = Math.abs(eu[k] - sA);
                    const db = Math.abs(eu[k] - sB);
                    const dv = du[k] + SN_ECHO.gain * powLook(env, (da < db ? da : db) / SN_ECHO.win);
                    const i = at[k];
                    const iy = (i / aw) | 0;
                    const ix = i - iy * aw;
                    const bay = (BAYER[(iy & 3) * 4 + (ix & 3)] / 16 - 0.46) * DITHER;
                    let q = Math.round((fi[k] > dv ? fi[k] : dv) * last + bay);
                    if (q < 0) {
                        q = 0;
                    } else if (q > top) {
                        q = top;
                    }
                    const qs = hq[k];
                    const c = qs > 0 && secL[qs] > priL[q] ? alt[qs] : rgb[q];
                    if (((c[0] << 16) | (c[1] << 8) | c[2]) === bs[k]) {
                        continue;
                    }
                    const o = i * 4;
                    d[o] = c[0];
                    d[o + 1] = c[1];
                    d[o + 2] = c[2];
                    d[o + 3] = 255;
                    if (ix < x0) {
                        x0 = ix;
                    }
                    if (ix > x1) {
                        x1 = ix;
                    }
                    if (iy < y0) {
                        y0 = iy;
                    }
                    if (iy > y1) {
                        y1 = iy;
                    }
                }
            }
            const ux0 = Math.min(r[0], x0);
            const uy0 = Math.min(r[1], y0);
            const ux1 = Math.max(r[2], x1);
            const uy1 = Math.max(r[3], y1);
            if (ux1 >= ux0 && uy1 >= uy0) {
                P.g.putImageData(P.img, 0, 0, ux0, uy0, ux1 - ux0 + 1, uy1 - uy0 + 1);
            }
            r[0] = x0;
            r[1] = y0;
            r[2] = x1;
            r[3] = y1;
            g.imageSmoothingEnabled = false;
            g.drawImage(P.cv, bd.x0, bd.y0, bd.w, bd.h);
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
     * ECLIPSE. A dead world with the star behind it -- and the whole event,
     * slowly, rather than one frame of it: first contact, the diamond ring,
     * totality, the second diamond ring and last contact in one 180 s pass.
     * Totality is the middle 56% of it, so the frame the glossary line
     * describes is still what the player sees for most of the block.
     *
     * The disc is the cheapest readable field in the catalogue and that is its
     * job: rung 0 flat over the top two thirds of the arena, `occlude`
     * returning 1 across it so not one baked star shows through -- a
     * silhouette that let stars through would read as glass. Every rung spent
     * inside it is a rung spent against 1-4 px bullets.
     *
     * Everything lit is in one annulus outside the limb, so the plate holds
     * nothing but sky and stars and the whole of the art is the live layer:
     * the annulus is re-baked into an overlay every tenth frame and blitted
     * over the plate. It has to be live, because it is all a function of where
     * the star is.
     */
    pixelEclipse: {
        init(bd) {
            const aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            const ah = Math.max(1, Math.ceil(bd.h / ART_PIX));
            const cv = document.createElement("canvas");
            cv.width = aw;
            cv.height = ah;
            const g = cv.getContext("2d");
            const img = g.createImageData(aw, ah);
            const ix = Math.cos(ECL_TRANSIT.in);
            const iy = Math.sin(ECL_TRANSIT.in);
            const dx = Math.cos(ECL_TRANSIT.out) - ix;
            const dy = Math.sin(ECL_TRANSIT.out) - iy;
            const len = Math.sqrt(dx * dx + dy * dy);
            const r = bd.W * ECL_C.r;
            const cx = bd.W * ECL_C.cx;
            const cy = bd.H * ECL_C.cy;
            const reach = r * ECL_ANNULUS[1];
            bd.ecl = {
                aw, ah, cv, g, img, data: img.data, cx, cy, r,
                cell: eclipseCells(),
                chord: { ix, iy, ux: dx / len, uy: dy / len, len },
                // The dirty rectangle is fixed: the annulus never grows,
                // because the star's flare is 0.46 R long and the star never
                // gets further out than 1.45 R. So there is no per-frame
                // bounds pass and no union with the last frame's rect.
                x0: clamp(Math.floor((cx - reach - bd.x0) / ART_PIX), 0, aw - 1),
                x1: clamp(Math.ceil((cx + reach - bd.x0) / ART_PIX), 0, aw - 1),
                y0: clamp(Math.floor((cy - reach - bd.y0) / ART_PIX), 0, ah - 1),
                y1: clamp(Math.ceil((cy + reach - bd.y0) / ART_PIX), 0, ah - 1),
                cap: 7, fq: null, starMask: null, beads: [],
            };
            bd.stars = starList(bd, ECL_STAR_SEED, ECL_STARS, ECL_STAR_A);
        },
        /**
         * Nothing bakes. Every rung the place lights depends on where the star
         * is, and outside the annulus the haze is under a thousandth of one --
         * so the plate is the sky, flat, and the point lights on top of it.
         */
        field() {
            return FIELD_DARK;
        },
        /** Opaque, and the transit never changes that. */
        occlude(bd, x, y) {
            const P = bd.ecl;
            const dx = x - P.cx;
            const dy = y - P.cy;
            const rn = Math.sqrt(dx * dx + dy * dy) / P.r;
            let th = Math.atan2(dy, dx);
            if (th < 0) {
                th += 6.2832;
            }
            return rn <= 1 + P.cell.terr[Math.floor((th / 6.2832) * ECL_CELLS) % ECL_CELLS] ? 1 : 0;
        },
        /**
         * One re-bake of the annulus every tenth frame, one blit, and up to
         * three lattice-snapped beads. The phase is quantised to the same tenth
         * frame, so what is on screen is a pure function of `floor(t / 10) * 10`
         * and two clients in a co-op match are never looking at different
         * eclipses -- and there is no `update`, so `backdropThumb` jumps
         * straight to 1500 and pause freezes the star where it is.
         */
        live(bd, g) {
            const P = bd.ecl;
            const fq = Math.floor(bd.t / ECL_STEP) * ECL_STEP;
            if (P.fq !== fq) {
                P.fq = fq;
                eclipseBake(bd, fq);
            }
            g.imageSmoothingEnabled = false;
            g.drawImage(P.cv, bd.x0, bd.y0, bd.w, bd.h);
            const beads = eclipseBeads(bd, fq, eclipsePhase(bd, fq), P.beads);
            if (beads.length) {
                const s = ART_PIX * ECL_BEAD.size;
                g.fillStyle = bd.p.ramp[bd.p.ramp.length - 1];
                for (let i = 0; i < beads.length; i += 2) {
                    g.fillRect(snapTo(bd.x0, beads[i]), snapTo(bd.y0, beads[i + 1]), s, s);
                }
            }
        },
    },

    /**
     * LOW MOON ORBIT. Airless, so nothing here is soft: no haze over the
     * distance, no glow around the impacts, and a horizon that is a decision
     * per art pixel rather than a line anybody draws.
     *
     * One camera and one light hold the whole place together. A pixel `dy` art
     * rows under the line looks at depth `z = f * h / dy`, so a crater of
     * screen half-width `a` is exactly `a * dy / f` tall -- and that single
     * rule is what makes 350 craters read as one ground plane receding rather
     * than as ellipses of assorted flatness. The light never changes direction
     * either, so a far rim, a near wall and a boulder's shadow all agree about
     * where the sun is.
     *
     * The event is a rock arriving. There is no air, so it has no trail and no
     * fire: it is painted in rung 0, the colour of the sky, and the only way
     * it is ever seen is the baked stars it puts out on the way down. What
     * happens at the ground is local and brief -- six frames of flash on lit
     * ground, ejecta that all land, and a scar that stays for 2400 frames and
     * fades a rung at a time.
     */
    pixelMoon: {
        init(bd) {
            bd.aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            bd.ah = Math.max(1, Math.ceil(bd.h / ART_PIX));
            bd.jag = mkNoise(MOON_JAG_SEED);
            bd.hr = (bd.H * MOON_HORIZON - bd.y0) / ART_PIX;
            bd.yh = new Float32Array(bd.aw);
            for (let c = 0; c < bd.aw; c++) {
                bd.yh[c] = moonHorizon(bd, c);
            }
            moonSurface(bd);
            bd.stars = starList(bd, MOON_STAR_SEED, MOON_STARS, MOON_STAR_A);
            bd.scars = {};
        },
        /**
         * No star stands in the ground, and none in the six art rows over the
         * line either: the plain's own top rung is brighter than the whole
         * star ramp, so a point light there reads as a speck on the ground
         * rather than as a star behind it.
         */
        occlude(bd, x, y) {
            const c = clamp(Math.floor((x - bd.x0) / ART_PIX), 0, bd.aw - 1);
            return y >= bd.y0 + (bd.yh[c] - MOON_STAR_GAP) * ART_PIX ? 1 : 0;
        },
        field(bd, x, y) {
            const i = clamp(Math.floor((y - bd.y0) / ART_PIX), 0, bd.ah - 1) * bd.aw
                + clamp(Math.floor((x - bd.x0) / ART_PIX), 0, bd.aw - 1);
            const r = bd.fixed[i];
            // Sky, razor rim and boulders are pinned rungs with the dither
            // bypassed. Everything else is the open plain, which is the only
            // thing here the dither is allowed to touch.
            return r === MOON_FREE ? { v: bd.tone[i] } : { flat: r };
        },
        /**
         * The impact, and nothing else. Measured over 600 frames and counting
         * the plate blit `Backdrop.draw` makes: **25 rasterising calls at the
         * worst overlap and 9.1 on average**. The painter this replaces had no
         * live layer at all, so every item has to pay for itself -- the scars
         * because they postdate the bake, the stars because occlusion is the
         * only way the rock is ever seen, and the flash and the ejecta because
         * they move.
         */
        live(bd, g) {
            const ramp = bd.p.ramp;
            const land = bd.p.landRamp;
            const flash = bd.p.flashRamp;
            g.imageSmoothingEnabled = false;
            for (const e of moonEvents(bd)) {
                const a = e.age;
                if (a >= 3) {
                    // Four steps of 600 frames down `landRamp`, 7 to 4, and
                    // then the event is over: `moonEvents` drops it at 2400.
                    const rung = Math.max(4, 7 - Math.floor(a / MOON_STEP));
                    g.drawImage(moonScar(bd, e, rung),
                        bd.x0 + (Math.round(e.ix) - MOON_SCAR.cx) * ART_PIX,
                        bd.y0 + (Math.round(e.iy) - MOON_SCAR.cy) * ART_PIX,
                        MOON_SCAR.w * ART_PIX, MOON_SCAR.h * ART_PIX);
                }
                if (a > -MOON_FALL && a <= 0) {
                    // The rock. Rung 0 on rung 0, so it is drawn nowhere: what
                    // is drawn is the sky over the stars it is in front of.
                    const p = 1 - -a / MOON_FALL;
                    const rx = e.ix - MOON_ROCK_DRIFT * (1 - p);
                    const ry = e.iy - (e.iy + MOON_ROCK_TOP) * (1 - p * p);
                    g.fillStyle = ramp[0];
                    for (const s of bd.stars) {
                        const sc = Math.floor((s.x - bd.x0) / ART_PIX);
                        const sr = Math.floor((s.y - bd.y0) / ART_PIX);
                        const w = s.big ? 2 : 1;
                        if (sc > rx - MOON_ROCK_R && sc < rx + MOON_ROCK_R + w
                            && sr > ry - MOON_ROCK_R && sr < ry + MOON_ROCK_R + w) {
                            moonRect(bd, g, sc, sr, w, w);
                        }
                    }
                }
                if (a >= 0 && a < MOON_FLASH_R.length) {
                    // Six frames, 15x12 logical px at its peak. It lands on
                    // lit ground, so it never has the dark surround a
                    // bullet-sized bright thing needs to be mistaken for one.
                    const k = Math.floor(a);
                    const rr = MOON_FLASH_R[k];
                    g.fillStyle = flash[k < MOON_FLASH_HOT ? 0 : 1];
                    moonRect(bd, g, e.ix - rr, e.iy - rr * 0.5, rr * 2, Math.max(1, rr));
                    g.fillStyle = flash[1];
                    moonRect(bd, g, e.ix - rr - 1, e.iy - rr * 0.5 - 1, rr * 2 + 2, 1);
                }
                if (a >= 2 && a < MOON_EJECTA_LIFE) {
                    // Ballistic under a gravity low enough to hang for 177
                    // frames, and every grain two art pixels -- over the 1-4
                    // logical px an enemy core is. They all land.
                    const t = a - 2;
                    for (let i = 0; i < MOON_EJECTA; i++) {
                        const ang = -Math.PI / 2
                            + (hash2(e.k, i * 7 + 1, MOON_EVENT_SEED) - 0.5) * MOON_CONE;
                        const sp = MOON_EJECTA_V[0]
                            + hash2(e.k, i * 17 + 2, MOON_EVENT_SEED) * MOON_EJECTA_V[1];
                        const y = e.iy + Math.sin(ang) * sp * t + 0.5 * MOON_GRAV * t * t;
                        if (y > e.iy + 0.5) {
                            continue;
                        }
                        g.fillStyle = i % 4 === 0
                            ? land[3]
                            : land[Math.min(land.length - 1, 5 + (i % 2))];
                        moonRect(bd, g,
                            e.ix + Math.cos(ang) * sp * t * MOON_EJECTA_SPREAD, y,
                            MOON_EJECTA_PX, MOON_EJECTA_PX);
                    }
                }
            }
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

    /**
     * ORBITAL STATION. The sixteenth Direction A conversion, and the first
     * place whose subject is not in the baked layer at all.
     *
     * Everything else in the catalogue bakes because everything hard-edged in
     * it is a function of position. A ring that turns is not: a module's
     * screen position and its apparent width both come out of its angle in the
     * plane, so the whole station is rasterised into an art-resolution overlay
     * every frame and blitted over the plate. `field` carries the dust and
     * nothing else.
     *
     * That also settles the two things the entry used to get wrong. The old
     * painter drew a static wheel with 26 additively-composited 3 px pale
     * points blinking around it -- the size, the colour and the surround of a
     * bullet, and the only motion in a place whose own description says it
     * turns. Now the ring turns and nothing blinks.
     *
     * Nothing is ever rotated. A module is an axis-aligned run of plating
     * whose position and width are computed from the angle, which keeps every
     * colour run on the lattice and costs no atlas: 0 bytes against the >= 32
     * angles a module would need before its travel along the near arc stopped
     * stuttering.
     */
    pixelStation: {
        init(bd) {
            bd.aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            bd.ah = Math.max(1, Math.ceil(bd.h / ART_PIX));
            bd.n1 = mkNoise(STATION_SEED);
            bd.cx = bd.W * STATION_C.cx;
            bd.cy = bd.H * STATION_C.cy;
            // The station is measured in art cells of the box, so its geometry
            // is on the lattice by construction and needs no `snapTo`.
            bd.acx = (bd.cx - bd.x0) / ART_PIX;
            bd.acy = (bd.cy - bd.y0) / ART_PIX;
            bd.stars = starList(bd, STATION_STAR_SEED, STATION_STARS, STATION_STAR_A);
            bd.lit = {
                win: hexRGB(bd.p.lights.win),
                winHi: hexRGB(bd.p.lights.winHi),
                far: hexRGB(bd.p.lights.far),
                farHi: hexRGB(bd.p.lights.farHi),
                nav: hexRGB(bd.p.lights.nav),
                navHi: hexRGB(bd.p.lights.navHi),
                beacon: hexRGB(bd.p.lights.beacon),
            };
            const cv = document.createElement("canvas");
            cv.width = bd.aw;
            cv.height = bd.ah;
            const g = cv.getContext("2d");
            const img = g.createImageData(bd.aw, bd.ah);
            // The dirty rectangle is fixed. The ring's bounds do not move, so
            // there is no union with last frame's rect to keep and no
            // per-frame bounds pass -- a better case than COMET TRAIL, whose
            // idiom this is.
            bd.surf = {
                cv, g, img, data: img.data, aw: bd.aw,
                x0: clamp(Math.floor(bd.acx - STATION_BOX[0]), 0, bd.aw - 1),
                x1: clamp(Math.ceil(bd.acx + STATION_BOX[1]), 0, bd.aw - 1),
                y0: clamp(Math.floor(bd.acy - STATION_BOX[2]), 0, bd.ah - 1),
                y1: clamp(Math.ceil(bd.acy + STATION_BOX[3]), 0, bd.ah - 1),
            };
        },
        /**
         * The station's own occlusion needs no phase at all: it is opaque, it
         * is drawn over the plate every frame, and paint order is the answer.
         * So `occlude` carries the other rule instead, INNER SYSTEM's -- a
         * point light only goes down where the plate behind it is dark.
         */
        occlude(bd, x, y) {
            const last = bd.rgb.length - 1;
            const cap = Math.min(bd.p.topRung === undefined ? last : bd.p.topRung, last);
            const v = stationSky(bd, x, y);
            return lum(bd.rgb[clamp(Math.round(v * last), 0, cap)]) >= STATION_STAR_LIT ? 1 : 0;
        },
        field(bd, x, y) {
            const v = stationSky(bd, x, y);
            return v > 0 ? { v: clamp(v, 0, 1) } : FIELD_DARK;
        },
        /**
         * One clear of the fixed rect, ~490 runs of art pixels into it, one
         * upload and one blit. There is no `update`: the rotation and the
         * shuttle are pure functions of the frame counter, so `backdropThumb`
         * takes the place straight to frame 1500 and two clients in a co-op
         * match watch the same module cross the same star.
         *
         * Reading the engine's scaled clock is also what makes pause freeze
         * the ring, slow motion slow it and stun stutter it. That is right: a
         * ring slowing down with the game still looks like a ring.
         */
        live(bd, g) {
            const s = bd.surf;
            const rot = (6.2832 * (bd.t % STATION_PERIOD)) / STATION_PERIOD;
            for (let y = s.y0; y <= s.y1; y++) {
                s.data.fill(0, (y * s.aw + s.x0) * 4, (y * s.aw + s.x1 + 1) * 4);
            }
            const mods = stationModules(bd, rot);
            // Far side, then the hub, then the near side. Twelve modules and
            // two spokes are behind the tower at any instant and twelve and
            // two are in front of it, which is the entire depth sort.
            stationRim(bd, s, false);
            for (const m of mods) {
                if (!m.near) {
                    stationModule(bd, s, m);
                }
            }
            stationSpokes(bd, s, rot, false);
            stationHub(bd, s);
            stationSpokes(bd, s, rot, true);
            stationRim(bd, s, true);
            for (const m of mods) {
                if (m.near) {
                    stationModule(bd, s, m);
                }
            }
            s.g.putImageData(s.img, 0, 0, s.x0, s.y0, s.x1 - s.x0 + 1, s.y1 - s.y0 + 1);
            g.imageSmoothingEnabled = false;
            g.drawImage(s.cv, bd.x0, bd.y0, bd.w, bd.h);
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

    /**
     * PLANETARY NEBULA. A dying star, the shell it exhaled, and a light echo
     * crossing the gas -- one object seen from outside, which is the thing the
     * catalogue did not have. Every other cloud in it is weather you fly
     * through; this one has a centre you can point at, an edge where it stops,
     * and a flash that crosses it on a clock.
     *
     * It is radial rather than layered, and that is a different function
     * (`shellSample`) rather than a parameterisation of `gasDensity`.
     * Parameterising the layered one would have made this place a
     * configuration of the violet nebula, which is the relationship it exists
     * in order not to have -- and it would have put the violet nebula's own
     * measured output at risk for nothing. What is shared is the lattice, the
     * dither, the ramp machinery and the star system, which is the sharing
     * that was wanted.
     *
     * The composition is built for the camera that ends the game. At normal
     * zoom you are inside the rim and read a curve; when the camera pulls back
     * for a colossus the curve closes into a ring, the cavity becomes the
     * darkest large area in the frame, and the hull is silhouetted against it
     * with the dust columns standing to either side rather than behind it.
     */
    pixelShell: {
        init(bd) {
            bd.aw = Math.max(1, Math.ceil(bd.w / ART_PIX));
            bd.ah = Math.max(1, Math.ceil(bd.h / ART_PIX));
            bd.n1 = mkNoise(SHELL_SEEDS[0]);
            bd.n2 = mkNoise(SHELL_SEEDS[1]);
            bd.n3 = mkNoise(SHELL_SEEDS[2]);
            bd.n4 = mkNoise(SHELL_SEEDS[3]);
            bd.n5 = mkNoise(SHELL_SEEDS[4]);
            bd.cx = bd.W * 0.5;
            bd.cy = bd.H * 0.5;
            const last = bd.rgb.length - 1;
            bd.cap = Math.min(bd.p.topRung === undefined ? last : bd.p.topRung, last);
            const n = bd.aw * bd.ah;
            // The tables `live` and `occlude` read back, filled by the bake as
            // it walks. `base` and `gas` are bytes on `SHELL_Q` rather than
            // floats: a cell's live rung is then computed from exactly the
            // value its baked rung came from, so a cell the echo leaves alone
            // can never be repainted one step off the plate.
            bd.base = new Uint8Array(n);
            bd.gasQ = new Uint8Array(n);
            bd.rad = new Float32Array(n);
            bd.rung = new Uint8Array(n);
            bd.sample = { v: 0, fil: 0, r: 0, sil: 0 };
            bd.stars = starList(bd, SHELL_STAR_SEED, SHELL_STARS, 0.24);
            bd.twinkle = twinkleList(bd, SHELL_TWINKLE_SEED, 12);
            const cv = document.createElement("canvas");
            cv.width = bd.aw;
            cv.height = bd.ah;
            const g = cv.getContext("2d");
            const img = g.createImageData(bd.aw, bd.ah);
            // The echo is an overlay, not a repaint: transparent everywhere it
            // changes nothing, so the plate under it is the bake itself.
            bd.echo = { cv, g, img, data: img.data, px0: 0, py0: 0, px1: -1, py1: -1 };
        },
        occlude(bd, x, y) {
            const i = clamp(Math.floor((y - bd.y0) / ART_PIX), 0, bd.ah - 1) * bd.aw
                + clamp(Math.floor((x - bd.x0) / ART_PIX), 0, bd.aw - 1);
            return bd.rung[i] >= SHELL_SIL
                ? 1
                : Math.min(1, (bd.gasQ[i] / SHELL_Q) * SHELL_OCCLUDE);
        },
        /**
         * The one departure from the contract that costs anything: `field`
         * fills four per-cell tables on its way past, so `live` can band-limit
         * the echo without evaluating five noises again. It also does its own
         * quantise and returns the rung rather than the value, which is what
         * makes the plate and the tables one thing instead of two that have to
         * agree.
         */
        field(bd, x, y) {
            const cx = clamp(Math.floor((x - bd.x0) / ART_PIX), 0, bd.aw - 1);
            const cy = clamp(Math.floor((y - bd.y0) / ART_PIX), 0, bd.ah - 1);
            const i = cy * bd.aw + cx;
            const s = bd.sample;
            shellSample(bd, x - bd.cx, y - bd.cy, s);
            bd.rad[i] = s.r;
            if (s.sil) {
                // A column or the bank: `landRamp`, and it never enters the
                // dither, so its ragged edge is a full step at every pixel.
                bd.rung[i] = SHELL_SIL + s.sil - 1;
                return { flat: s.sil - 1, rgb: bd.rgbAlt };
            }
            bd.gasQ[i] = clamp(Math.round(s.v * SHELL_Q), 0, 255);
            // The core is read back off the stored radius rather than the
            // exact one, so the pulse in `live` starts from the value the bake
            // actually used.
            const core = Math.exp(-Math.pow(bd.rad[i] / SHELL_CORE_W, 2));
            bd.base[i] = clamp(Math.round((bd.gasQ[i] / SHELL_Q
                + SHELL_FIL_A * s.fil + SHELL_CORE_A * core) * SHELL_Q), 0, 255);
            bd.rung[i] = artRung(bd, bd.base[i] / SHELL_Q, cx, cy, bd.cap);
            return { flat: bd.rung[i] };
        },
        update: breathe,
        /**
         * Three things, and each had to be here: the echo band, because its
         * brightness depends on the frame; the central source's pulse, same;
         * and the twinkle, which is the file's own baseline.
         *
         * The pass walks a rect rather than the lattice. The map from screen
         * to shell space never expands a distance, so a cell whose shell
         * radius is R is at most R from the centre on screen -- one bound
         * covers the whole annulus, and for the 277 dark frames of the cycle
         * it shrinks to the cavity. What it writes is an art-pixel overlay
         * with a dirty rect: one upload and one blit, whatever the front is
         * doing.
         */
        live(bd, g) {
            const s = bd.echo;
            const aw = bd.aw;
            const front = shellFront(bd.t);
            const pulse = SHELL_PULSE[0] * Math.sin((bd.t * 6.2832) / SHELL_PULSE[1]);
            const reach = front > 0 ? front + SHELL_BAND + SHELL_WARP_MAX : SHELL_CORE_R;
            const rp = reach / ART_PIX;
            const ccx = (bd.cx + SHELL_C[0] - bd.x0) / ART_PIX;
            const ccy = (bd.cy + SHELL_C[1] - bd.y0) / ART_PIX;
            const bx0 = clamp(Math.floor(ccx - rp), 0, aw - 1);
            const bx1 = clamp(Math.ceil(ccx + rp), 0, aw - 1);
            const by0 = clamp(Math.floor(ccy - rp), 0, bd.ah - 1);
            const by1 = clamp(Math.ceil(ccy + rp), 0, bd.ah - 1);
            // What the last frame wrote has to stop showing before this one
            // decides what it writes.
            if (s.px1 >= s.px0) {
                for (let cy = s.py0; cy <= s.py1; cy++) {
                    s.data.fill(0, (cy * aw + s.px0) * 4, (cy * aw + s.px1 + 1) * 4);
                }
            }
            let dx0 = aw;
            let dy0 = bd.ah;
            let dx1 = -1;
            let dy1 = -1;
            for (let cy = by0; cy <= by1; cy++) {
                const row = cy * aw;
                for (let cx = bx0; cx <= bx1; cx++) {
                    const i = row + cx;
                    if (bd.rung[i] >= SHELL_SIL) {
                        continue;
                    }
                    const r = bd.rad[i];
                    const dr = r - front;
                    const lit = front > 0 && dr > -SHELL_BAND && dr < SHELL_BAND;
                    const hot = r < SHELL_CORE_R;
                    if (!lit && !hot) {
                        continue;
                    }
                    let v = bd.base[i] / SHELL_Q;
                    if (hot) {
                        v += SHELL_CORE_A * Math.exp(-Math.pow(r / SHELL_CORE_W, 2)) * pulse;
                    }
                    if (lit) {
                        // Only gas that already has structure brightens, so the
                        // front reveals the shells in sequence rather than
                        // washing over the field.
                        const t = dr / SHELL_SIGMA;
                        v += SHELL_ECHO_A * Math.exp(-t * t)
                            * Math.min(1, (bd.gasQ[i] / SHELL_Q) * SHELL_GATE);
                    }
                    const k = artRung(bd, v, cx, cy, bd.cap);
                    if (k === bd.rung[i]) {
                        continue;
                    }
                    const col = bd.rgb[k];
                    const o = i * 4;
                    s.data[o] = col[0];
                    s.data[o + 1] = col[1];
                    s.data[o + 2] = col[2];
                    s.data[o + 3] = 255;
                    if (cx < dx0) { dx0 = cx; }
                    if (cx > dx1) { dx1 = cx; }
                    if (cy < dy0) { dy0 = cy; }
                    if (cy > dy1) { dy1 = cy; }
                }
            }
            let ux0 = dx0;
            let uy0 = dy0;
            let ux1 = dx1;
            let uy1 = dy1;
            if (s.px1 >= s.px0) {
                ux0 = Math.min(ux0, s.px0);
                uy0 = Math.min(uy0, s.py0);
                ux1 = Math.max(ux1, s.px1);
                uy1 = Math.max(uy1, s.py1);
            }
            if (ux1 >= ux0 && uy1 >= uy0) {
                s.g.putImageData(s.img, 0, 0, ux0, uy0, ux1 - ux0 + 1, uy1 - uy0 + 1);
                g.imageSmoothingEnabled = false;
                g.drawImage(s.cv, bd.x0, bd.y0, bd.w, bd.h);
            }
            s.px0 = dx0;
            s.py0 = dy0;
            s.px1 = dx1;
            s.py1 = dy1;
            twinkles(bd, g);
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
        id: "pulsar", name: "PULSAR", tint: "#8fd8ff", kind: "pixelPulsar",
        // The ramp is the study's, and this is the one place in the catalogue
        // that can afford its top rung: a block of #a7e4ff measures mean red
        // at 0.65 of mean blue, nothing like an enemy core, so the beams and
        // the wisp heads are allowed to be the brightest thing in the frame.
        // `topRung` 6 holds the BAKED layer one rung under that, which is what
        // leaves the top one to the things that move.
        //
        // The star ramp is not the study's #5f7f96 / #9dc6dd / #dff4ff. Its
        // top two rungs measure luminance 0.75 and 0.94 against the 0.62 the
        // small-bright-feature detector cuts at, and `starList` puts about
        // half of 460 stars on the top rung whatever a study does to its own
        // distribution -- so the fix is the ramp, as it was for EVENT HORIZON,
        // COMET TRAIL and RINGED GIANT. Every rung here is under the threshold
        // and still clear of the plate it lies on.
        p: {
            veil: 11, topRung: 6,
            ramp: ["#05070c", "#0b1522", "#12283c", "#1a415c", "#2b6484", "#4a8fae", "#74bcd8", "#a7e4ff"],
            starRamp: ["#43555f", "#5f7885", "#839aa8"],
        },
        desc: "A neutron star turning overhead every four seconds, its tilted poles sweeping a beam of light past the arena every two.",
    },
    {
        id: "graveyard", name: "SHIP GRAVEYARD", tint: "#9aa6c4", kind: "graveyard",
        p: { base: "#2b3350", hi: "#ff8f5e" },
        desc: "Hulls left where they died, tumbled at every angle and going nowhere. A few panels on them still have power and blink.",
    },
    {
        id: "ocean_world", name: "OCEAN WORLD", tint: "#5ee1ff", kind: "pixelOcean",
        // Two ramps, and which one a pixel takes is which side of the horizon
        // it is on. `ramp` is the sky, `landRamp` the water -- a step cooler
        // and a step darker at every rung, which is the hard teal horizon the
        // glossary line promises, done in the palette rather than with a line.
        //
        // The star ramp is not the study's #9fe8f2 / #cdf6fb / #eafeff. Those
        // measure luminance 0.85 / 0.93 / 0.98 against the 0.62 the
        // small-bright-feature detector cuts at, and a 9 px spore of the top
        // one against the dark top of the box is a bullet by every test the
        // programme has. Fifth star ramp to come down, after EVENT HORIZON,
        // COMET TRAIL, RINGED GIANT and PULSAR; assume the next one too.
        p: {
            veil: 8, topRung: 6,
            ramp: ["#031a24", "#06303f", "#0a4a5e", "#10657c", "#1c8398", "#35a3b4", "#6fcbd6", "#bff0f7"],
            landRamp: ["#02141d", "#04222e", "#062f3d", "#093f4f", "#0d5162", "#146678", "#2b8b9b", "#74d0da"],
            starRamp: ["#3a5f6a", "#4e7a85", "#628f9a"],
        },
        desc: "Over open water: a hard teal horizon, the sky repeated in the swell, and spores lifting off the crests.",
    },
    {
        id: "aurora", name: "ION STORM", tint: "#7bffb0", kind: "pixelIon",
        // Two ramps sampled at the SAME rung and mixed by a per-curtain tint,
        // which is what puts four green curtains and three cyan ones on one
        // lattice: `ramp` is the entry's own green, `landRamp` its cyan. The
        // third is the dust behind them, three rungs deep and all of it under
        // the darkest thing in either sky ramp.
        //
        // The star ramp is the study's, unchanged, and it is the first one in
        // the programme that did not have to come down: its top rung measures
        // luminance 0.338 against the 0.62 the small-bright-feature detector
        // cuts at. A study that measures its own point lights is a study whose
        // palette can be taken as it stands.
        p: {
            veil: 6, topRung: 6,
            ramp: ["#050a0c", "#0a1a18", "#0f3028", "#14503a", "#1b7050", "#2b9c6a", "#4fd28e", "#7bffb0"],
            landRamp: ["#050a0c", "#0a181e", "#0d2c38", "#114353", "#185f74", "#248a9c", "#40b6cb", "#5ee1ff"],
            starRamp: ["#202b2f", "#354247", "#4a595e"],
            dustRamp: ["#070c0e", "#0a1114", "#0d171a"],
        },
        desc: "Charged particles hitting a magnetosphere. Curtains of green and cyan lean and swing across the whole sky, their rays flaring and dying twice a second, and the stars burn straight through them.",
    },
    {
        id: "moon", name: "LOW MOON ORBIT", tint: "#d6d2c8", kind: "pixelMoon",
        // The study's own four ramps, taken as they stand: it measured its
        // point lights (top rung luminance 146 against the detector's 158) and
        // its flash instead of asserting them. `flashRamp` is the one thing it
        // asks for that did not exist -- and it is not a contract change, only
        // a key in this entry's own `p`, the way MOLTEN WORLD carries a
        // `flowRamp` and AURORA a `dustRamp`.
        p: {
            veil: 14, topRung: 6,
            ramp: ["#0a0b10", "#16202a", "#24323d", "#354853", "#47606b", "#5c7a85", "#7896a0", "#9db9c0"],
            landRamp: ["#1b1c26", "#2b2c34", "#3e4048", "#54555d", "#6d6e74", "#8b8b8f", "#a9a8a4", "#c8c4b8"],
            starRamp: ["#39434b", "#57666e", "#84959c"],
            flashRamp: ["#c9d6d6", "#93a5a8"],
        },
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
        id: "binary", name: "BINARY SUNS", tint: "#ffd66b", kind: "pixelBinary",
        // Two ramps, and this is the documented two-ramp mechanism rather than
        // one ramp widened: no rung is spent bridging gold to blue. The gold
        // one stops at 6 -- a 9 px block of its rung 7 measures mean R over
        // 1.12x mean B on a dark surround, the same failure COMET TRAIL's core
        // took -- and the cool one keeps all eight, being nowhere near the
        // palette the enemies fire in. `topRung` is the cool cap; the gold cap
        // is per sample, because one number cannot hold two ramps.
        p: {
            veil: 13, topRung: 7,
            ramp: ["#0a0a10", "#241a12", "#45301a", "#6b4720", "#966228", "#bd8236", "#dda94c", "#ffd66b"],
            landRamp: ["#0a0a10", "#121a2a", "#1c2c48", "#2a4570", "#3d639b", "#5a86c4", "#86ade0", "#c6dcf8"],
            // The study's own cool blue-grey, two steps down. Its hue is right
            // for the reason every star ramp here is chosen -- a warm point
            // light is a bullet -- but #a9bcd6 and #e8f1ff measure luminance
            // 0.73 and 0.94 against the detector's 0.62, and the ~115 of the
            // 520 that land inside the arena were 3-6 px near-white blocks on
            // black. Every rung under the threshold instead. Measured at veil
            // 13: 129 small bright features to 0, and with the ramp blacked
            // out entirely the place already read 0 -- so the stars were all
            // of it, and none of the art was.
            starRamp: ["#4c5870", "#6a7a96", "#879ab8"],
        },
        desc: "A swollen gold star pouring gas onto a small blue-white companion, where it winds into a spinning disc that burns brightest where the stream lands.",
    },
    {
        id: "station", name: "ORBITAL STATION", tint: "#9fd4ff", kind: "pixelStation",
        p: {
            veil: 10, topRung: 6,
            ramp: ["#04060b", "#080d18", "#0d1526", "#131f39", "#1b2c50", "#26406e", "#35578f", "#4a72b0"],
            // The station's metal. The top two rungs are never used: #a8bcd8
            // measures luminance 0.73 against the detector's 0.62 and #7b8fb3
            // is close enough that a lit top edge crossed it. The brightest
            // cool tone the place paints is rung 5, at 0.43.
            landRamp: ["#0b0f18", "#151c2b", "#222c42", "#33405c", "#475779", "#5d7096", "#7b8fb3", "#a8bcd8"],
            starRamp: ["#3f5273", "#5d7396", "#8296bb"],
            // Every light is 6 logical px, steady, and scaled to sit just
            // under the small-bright-feature detector's 0.62 on its own hue --
            // so none of them depends on the surround clause, which the veil
            // can take away. Far-arc windows are dimmer still: that is depth,
            // and far plating is two rungs down and cannot embed a light.
            lights: {
                win: "#d09253", winHi: "#bf9670",
                far: "#ac7844", farHi: "#a3805f",
                nav: "#209cc7", navHi: "#00c4e6", beacon: "#ef8658",
            },
        },
        desc: "A ring station turning slowly at the top right, its windows lit and a craft docked at the still hub at its centre. Somebody out here is still home.",
    },
    {
        id: "desert_world", name: "DESERT WORLD", tint: "#e8c07a", kind: "surface",
        p: { sky: ["#2a1a08", "#8a6220", "#e0b874"], band: "#ffe2a8", speed: 0.9, motes: "sand", moteColor: "#ffe2a8" },
        desc: "Sand blowing across an ochre sky, thick enough that you can read the wind in it.",
    },
    {
        id: "supernova", name: "SUPERNOVA", tint: "#3fb9a6", kind: "pixelSupernova",
        p: {
            // O III against the dust, capped at rung 5. The tint was #ff8f5e
            // and is now rung 6 nudged toward the ramp's middle, so it still
            // reads on an 11 px catalogue card and no longer sits inside the
            // enemy-fire family.
            ramp: ["#06131a", "#0a2430", "#0e3a44", "#12545a", "#1c7a78", "#2aa394", "#58c9b4", "#a8ead8"],
            // Halpha, and it stops at rung 3: top warm luminance 34, under the
            // surround threshold the small-bright-feature detector uses.
            landRamp: ["#160a0c", "#241012", "#33161a", "#451d20", "#5a2528", "#6f2e2f", "#833838", "#a04442"],
            starRamp: ["#3d4a55", "#6b7c88", "#8fa0a6"],
            topRung: 5,
            veil: 11,
        },
        desc: "A shell thrown outward and lopsided, ploughing into a dense cloud on one flank. Oxygen filaments stand cyan against the dust; the middle is empty, and a slow light echo lifts one lane of it at a time.",
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
        id: "eclipse", name: "ECLIPSE", tint: "#ffd9a0", kind: "pixelEclipse",
        p: {
            // Rungs 0-2 are cold -- the field and the deep haze -- and 3-7 are
            // warm. No rung is mid-grey, so nothing in this backdrop can sit
            // at bullet luminance without also being clearly large.
            ramp: ["#04050c", "#0d0a16", "#1d1220", "#3a1e1c", "#63351d", "#94551f", "#c4832f", "#ffd9a0"],
            // The eclipsed star is behind the disc, so nothing in this sky
            // needs a warm point light: the star field ends cool.
            starRamp: ["#3a4460", "#767f9c", "#989dae"],
            // 7, and it is the ring and the star that reach it; the streamers
            // stop at 6.
            topRung: 7,
            // Zero, and this is the place that earns it. Mean arena luminance
            // is 12 of 255 -- rung 0 across the disc with the lit material
            // confined to one annulus -- so there is nothing to knock back,
            // and anything over about 6 starts eating the streamer tips, which
            // are the only thing worth looking at.
            veil: 0,
        },
        desc: "A dead world dead ahead with the star behind it, so what you get is the ring of atmosphere burning around a black disc, once it lines up.",
    },
    {
        id: "galaxy", name: "GALACTIC CORE", tint: "#ffd6a8", kind: "galaxy",
        p: { c1: "#ffd6a8", c2: "#8fb6ff" },
        desc: "Looking straight into the crowded middle of the galaxy: two arms of stars wound around a core bright enough to read by.",
    },
    {
        id: "wormhole", name: "WORMHOLE", tint: "#c9a4ff", kind: "pixelWormhole",
        p: {
            // Violet to cyan to white, so the tint reads at the mouth's rim
            // and the throat goes cold and then hot toward the core.
            ramp: ["#07060f", "#120e26", "#1e1a44", "#2f2a6b", "#4a3f9c", "#6f63c9", "#9ad6f2", "#dff4ff"],
            starRamp: ["#3a4a7a", "#767f9c", "#979ead"],
            // 6 for the walls. The top rung is released only inside the core,
            // which `live` does per pixel: rungs 4-6 cover a large share of the
            // frame, and a wall that could reach rung 7 would be competing with
            // the bullets over most of the play field.
            topRung: 6,
            veil: 6,
        },
        desc: "The mouth of a tunnel, straight ahead. Two ribs of light wind inward, crowding together as they fall away from you.",
    },
    {
        id: "nebula_shell", name: "PLANETARY NEBULA", tint: "#7bffb0", kind: "pixelShell",
        // The whole ramp holds hue 150-165 and never enters the 0-40 band the
        // enemies fire in, so hue is not what the cap is for here. `topRung` 6
        // is the study's own gas cap and rung 7 goes unspent: the sheet
        // reserves #c8fff0 for the central source, but its own painter caps
        // every cell at 6 and never reaches it, and a 9 px block of luminance
        // 0.95 is precisely the small bright feature the measurement forbids.
        //
        // Rung 6 is #5cdc9c and not the study's #7bffb0. That one hex is the
        // only thing in the palette that had to move, and it is brightness
        // rather than hue: #7bffb0 is linear luminance 0.789 against an enemy
        // core's 0.547, and the echo's job is to promote a long arc of the rim
        // to the top gas rung at once. Measured over one 720-frame cycle, the
        // share of the arena brighter than an enemy core peaked at **9.08%**,
        // against 0.00% for every other place in the catalogue and 1.58% for
        // LAVA WORLD's flow, which is the hottest thing in it. Dropping the
        // echo's own amplitude does not reach it -- 0.15 instead of 0.45 still
        // peaks at 3.49% -- because the ramp's last step is a leap (0.331 to
        // 0.789) rather than a step, so anything that touches rung 6 at all
        // lands there. #5cdc9c is 0.559, the same luminance AURORA's own top
        // used rung already ships at, and it takes both the quiet field and
        // the crossing to **0.00%** while leaving the ring its brightest arc.
        p: {
            veil: 9, topRung: 6,
            ramp: ["#041310", "#07241c", "#0a3a2c", "#0f5a42", "#18815c", "#2bb07f", "#5cdc9c", "#c8fff0"],
            // Two rungs, and the painter uses both: the third is the sheet's
            // published palette, kept so the entry reads as the study wrote it.
            landRamp: ["#02090c", "#04121a", "#08222a"],
            // The study's own cyan-blue, held two steps down. Its hue was
            // chosen for the right reason -- a warm star reads as a bullet --
            // but its top rung is #eafcff at luminance 0.97, and 24 of the 190
            // baked stars then came out as 3 px near-white blocks on black
            // sky, which is the other half of what a bullet looks like. Every
            // rung is under the detector's own 0.62 instead, so the count
            // stops depending on how the brightness is shared out. Measured:
            // 28 small bright features to 0, at every veil from 0 to 12.
            starRamp: ["#275a6a", "#43808f", "#66a3b4"],
        },
        desc: "A dying star's exhaled shell, lit from the inside out: concentric rings of ionised oxygen, dust columns standing against them, and a flash of light crossing the gas every few seconds.",
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
