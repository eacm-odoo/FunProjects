/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - pixel art sprite bank (cyberpunk style).
 *
 * Each sprite is a character grid (1 char = 1 logical pixel). Symmetric grids
 * are written at half width and mirrored (`mir: true`) to save data. Digits are
 * palette indices:
 *
 *   . transparent    0 hot white         1 dark hull      2 mid hull
 *   3 metal          4 TINT              5 dark tint      6 light tint
 *   7 glass          8 neon accent       9 dark accent
 *
 * A sprite may also carry a `ramp`: a core cell plus, per index, an RGB slope
 * per unit of distance from it (`at` slides the base along it, `k` scales it,
 * `unit` says how many cells one unit is, so the same table fits any grid),
 * so a zone shades across the hull instead of being one flat tone. It is the
 * model the player hulls were designed in, and it costs nothing at draw time --
 * the raster is cached like any other.
 *
 * 4/5/6 are re-tinted at draw time with the ship/enemy colour, so one sprite
 * serves the 4 player slots and the enemy variants alike. Sprites are rasterized
 * once to an offscreen canvas and cached by (name, colour, scale, flash).
 */

const BASE = {
    ".": null,
    0: "#ffffff",
    1: "#150c2b",
    2: "#2e1c56",
    3: "#6b7099",
    7: "#cdf6ff",
    8: "#ff2fd0",
    9: "#54104f",
};

/**
 * The same palette read as a *ramp*: the bank's indices ordered darkest to
 * brightest -- dark hull, dark accent, mid hull, dark tint, metal, TINT, light
 * tint, glass, hot white -- and the rung each one sits on. The neon accent (8)
 * shares the tint's rung, so a lit strip flares with the plating around it
 * instead of against it.
 *
 * An effect brightens a cell by walking it up this ramp rather than washing
 * light over it, which is what keeps it inside a colour the sprite already
 * uses. It lives here, next to `palette()`, because it is a property of the
 * bank and not of any one animator: `colossus_animator.js` and
 * `drone_animator.js` both read it, and a second copy of the order would drift
 * from the colours the first time either is retuned.
 */
export const RAMP_CHARS = ["1", "9", "2", "5", "3", "4", "6", "7", "0"];
export const RUNG = { 1: 0, 9: 1, 2: 2, 5: 3, 3: 4, 4: 5, 8: 5, 6: 6, 7: 7, 0: 8 };
/**
 * The three rungs that are shades of the hull's own tint (5 dark, 4 flat, 6
 * light). They belong on any hull whether or not the art happens to use them;
 * every other rung is a fixed colour, and one the art never uses has no
 * business appearing under an effect.
 */
export const TINT_RUNGS = [RUNG[5], RUNG[4], RUNG[6]];

/**
 * Fold the rungs an effect may land on onto the ones a hull is actually
 * painted with: `used[rung]` in, one `rung -> rung` table out.
 *
 * A promotion may only ever brighten a cell into a tone that is already on
 * screen somewhere, so a fixed palette entry the art never uses does not
 * belong on that hull -- promoted through rung 4, a cell of a violet chest
 * would put the bank's grey-blue on it. Those fold onto the nearest rung the
 * art does use, darker side first. The three tint shades always belong: they
 * are the hull's own colour, darker and lighter.
 *
 * It lives here rather than in an animator because it is a property of the
 * *bank* -- `colossus_animator.js`, `drone_animator.js` and `fry_animator.js`
 * all need exactly this table, and three copies of it would drift apart the
 * first time the ramp is retouched.
 *
 * @param {Uint8Array} used flags per rung, index 0..RAMP_CHARS.length - 1
 * @returns {Int8Array} the rung each rung resolves to
 */
export function rungFold(used) {
    const top = RAMP_CHARS.length - 1;
    const rungs = new Int8Array(top + 1);
    for (let i = 0; i <= top; i++) {
        rungs[i] = i;
        if (used[i] || TINT_RUNGS.indexOf(i) >= 0) {
            continue;
        }
        let best = i;
        let bestD = top + 1;
        for (let j = 0; j <= top; j++) {
            if (used[j] && Math.abs(j - i) < bestD) {
                bestD = Math.abs(j - i);
                best = j;
            }
        }
        rungs[i] = best;
    }
    return rungs;
}

/* ------------------------------------------------------------------ */
/* Sprite data                                                         */
/* ------------------------------------------------------------------ */

/**
 * The Needle's shading, shared by every level of that hull.
 *
 * The design it is ported from stores flat symbols and ramps their colour by
 * distance from a core cell; this is that ramp, per palette index, in RGB per
 * unit of distance. It lives out here as one constant because the hull has five
 * levels on progressively larger grids, and the gradient has to be *identical*
 * across them -- one table referenced five times cannot drift, five copies
 * would. `ramp.unit` is what makes that work: it is the grid's size relative to
 * level 1's, so a distance of one unit covers the same fraction of the hull
 * whatever the level, and the same slopes paint the same gradient.
 */
const NEEDLE_SHADING = {
    // Tinted zones take the slot colour as their base, so the ramp
    // rides on top of whichever hull colour the player is flying.
    // `at` is where along the ramp that base sits: 6 is the mean
    // distance of the tinted cells, which makes the slot colour the
    // hull's AVERAGE rather than one of its ends -- the ship still
    // reads as its colour in co-op, and the shading works both ways
    // around it. (Measured against the design: anchoring at 0 costs
    // 18.6 mean RGB error, at 6 it is 13.6.)
    // `k` is the design file's own "ramp strength" slider. The
    // slopes are its measured ones, but they were drawn for a
    // 378 px canvas with bloom: at the 28 px this hull is actually
    // flown at, the tint's own ramp spans 8% of luminance end to
    // end and simply is not there. x5 puts it at 43%, which reads
    // in the arena without the hull leaving its colour. The other
    // two zones need none: the accent's ramp already spans 36% and
    // the hull tones' 180%. Scaling the accent was tried and makes
    // it WORSE -- its cells all sit far from the core, so a bigger
    // slope pushes both ends into the clamp and flattens the tip.
    4: { slope: [2.38, 1.97, 0.14], at: 6, k: 5 },
    // The canopy's ramp is RE-ANCHORED, not just steepened, and the
    // reason is in `_drawHitbox`: over this hull the engine paints
    // an additive white disc of radius 13 at 0.16 and then a near
    // opaque white dot of radius 4, on a hull 28.5 px wide. The
    // middle of the ship is therefore covered by the dot and
    // everything within 13 px of it is lifted by ~41 luminance
    // before the player sees it. The design's own canopy tones
    // (29..58 flat, 51..92 under its preview bloom) land inside
    // that wash and come out as one flat slab -- which is exactly
    // what four rounds of "I still cannot see it" were about.
    // Widening the ends instead of the gain is what survives it:
    // 22..129 is 14 luminance per cell row against the 5 the
    // design's own numbers give, and it is still darker at the
    // core than the reference's darkest canopy pixel.
    1: { base: [16, 22, 37], slope: [12.3, 14.2, 18.1] },
    // The wings are the accent, a fixed colour here as everywhere
    // else in the bank, so they carry the design's own base and
    // slope -- but anchored at the wing root (`at: 5`, the nearest
    // wing cell) and stretched, or the whole zone sits so far out
    // that both its ends clamp and the tip stops being the bright
    // one. Root to tip is now 40..91 in luminance against the
    // design's 63..86, and the root stays inside the magenta
    // family rather than going plum.
    9: { base: [138, 3, 118], slope: [11.93, 1.84, 11.73], at: 5, k: 2.6 },
};

export const SPRITES = {
    /* --- Player ships (16x18) --------------------------------------- */

    // Slot 0 - "Needle": the design's own grid, ported whole -- flat symbols
    // plus a ramp, which is how that art is built and why it is the one sprite
    // here with a `ramp`. Baking the ramp into palette steps was tried and is
    // wrong: the cyan varies by 15 luminance over the hull and the nearest two
    // bank steps are 86 apart, so every quantisation either flattened it or
    // banded it into arcs (measured: flat 29.6 mean RGB error, banded 39.7).
    //
    // Two departures from the design file. It is cut at row 20, where the
    // hull's dark edges stop -- the six rows under that are the exhaust and
    // `ship_flight.js` draws the flame, so keeping them would paint it twice.
    // And it is NOT mirrored: the art is symmetric about a *column*, a one
    // pixel white spine that a half-width grid cannot express. 19 columns, so
    // it draws at px 1.5 -- see `HULL_PX` in the engine.
    ship0: {
        ramp: { row: 13, col: 9, unit: 1, by: NEEDLE_SHADING },
        rows: [
            ".........0.........", ".........0.........", ".........0.........",
            "........404........", "........404........", "........404........",
            "......1140411......", "......1140411......", "......1444441......",
            ".....114111411.....", ".....114111411.....", "....91141114119....",
            "...9911411141199...", "..999144111441999..", "..999144111441999..",
            ".99991441114419999.", "999...4400044...999", "9......10001......9",
            ".......10001.......", ".......14441.......", ".......14441.......",
        ],
    },

    // Slot 0, level 2 - the Needle after its first upgrades: a second pair of
    // swept wings, shoulder pods and lights, on a 34x40 grid measured at 8.4 px
    // a cell, cut where the hull ends and the exhaust begins.
    //
    // It is shaded DIFFERENTLY from level 1, and that is measured, not chosen.
    // Level 1's art is a ramp: four flat symbols whose colour is a function of
    // distance from a core. Level 2's is not -- correlating its cells against
    // distance gives r = +0.02 for the plating and -0.05 for the tint, i.e.
    // nothing. Its hull is shaded panel by panel, the way a pixel artist
    // shades, so the tone lives in the GRID here (the bank's own ramp of
    // indices: 1/2/3 dark, 5/4/6 tinted, 7/0 white) rather than in a formula.
    //
    // The one zone that does ramp is the accent: r = +0.51 against distance,
    // brightening toward the wingtips. So the wings keep the ramp, and keep it
    // by REFERENCE -- `NEEDLE_SHADING[9]`, the same object level 1 uses, so the
    // two hulls cannot drift. `unit` and the core row are fitted so the wing
    // cells span 5.00..9.84 of it against level 1's 5.00..9.85: the wings of
    // both levels walk the same stretch of the same gradient.
    //
    // The accent is split by SHAPE: the two big connected runs of magenta are
    // the wings and take index 9 (ramped); the seven small ones -- shoulder
    // pods, wing tips, the light in the middle of the canopy -- are lights and
    // take index 8, flat. Ramping those is what a radial gradient gets wrong on
    // this hull: they sit near the core, where the wing's slope paints black.
    ship0lv2: {
        ramp: { row: 15.5, col: 16.5, unit: 2.3, by: { 9: NEEDLE_SHADING[9] } },
        rows: [
            "................00................", "................00................", "................00................",
            "................00................", "...............6006...............", "...............4004...............",
            "...............4004...............", "..............460064..............", "..............440044..............",
            ".............24600642.............", "............2244004422............", "............2144774412............",
            "...........221442244122...........", "...........215422224512...........", ".........1121142222411211.........",
            ".........8821141771411288.........", ".........8821551441551288.........", ".........8211421221241128.........",
            "........542154222222451245........", ".......83211442122124411238.......", "......2232114411221144112322......",
            "......9222114411881144112229......", ".....999221144347743441122999.....", "....99992211443400434411229999....",
            "...9999964411426006241144699999...", "...9999944411426006241144499999...", "..999999444114260062411444999999..",
            ".99999944441142400424114444999999.", "9999...14441142466424114441...9999", "999.....445114246642411544.....999",
            "9........4511454444541154........9", "9.........42115444451124.........9", "..........82121544512128..........",
            "..........82121544512128..........", "..........82121144112128..........", ".............21111112.............",
            ".............21211212.............", ".............52222225.............", ".............44122144.............",
            ".............04222240.............",
        ],
    },

    // Slot 0, level 3 - vertical fins over a second pair of canards, and the swept wings grown into a full delta. Ported the same way as level 2: the
    // design's own grid (44x53, measured at 7.38 px a cell), cut where the
    // hull ends and the exhaust begins, folded to be symmetric, and shaded cell
    // by cell with the bank's own ramp of indices rather than by a formula --
    // every level past the first is shaded panel by panel in the source art.
    //    // The wings keep the shared accent ramp: `unit` and the core row are fitted
    // so their cells span 5.00..9.85 of it against level 1's 5.00..9.85, which is
    // what keeps one gradient across all five hulls.
    ship0lv3: {
        ramp: { row: 46.5, col: 21.5, unit: 2.55, by: { 9: NEEDLE_SHADING[9] } },
        rows: [
            ".....................77.....................", ".....................00.....................",
            ".....................00.....................", ".....................00.....................",
            "....................1001....................", "....................6006....................",
            "....................6006....................", "...................140041...................",
            "....................4004....................", "...................140041...................",
            "..................24400442..................", "..................14477441..................",
            "..................14700741..................", "..............17..14700741..71..............",
            "..............87..24700742..78..............", "..............88..24700742..88..............",
            "..............888.54700745.888..............", ".............8888.44700744.8888.............",
            ".............8888.44700744.8888.............", ".............8822.44700744.2288.............",
            ".............8821.44477444.1288.............", ".............2221.44422444.1222.............",
            ".............2221.44222244.1222.............", ".............222144422224441222.............",
            ".............121144112211441121.............", ".......71....111444212212444111....17.......",
            "......199....114444222222444411....991......", ".......99....544444288882444445....99.......",
            "......9991...544442212212244445...1999......", "......9991...544422227722224445...1999......",
            "......9991...544422270072224445...1999......", "......9991..34154222700722245143..1999......",
            ".....99291..25454212700721245452..19299.....", ".....9922119223542157007512453229112299.....",
            ".....9922999222221447007441222229992299.....", "....299229992222214470074412222299922992....",
            "....222299992222254470074452222299992222....", "...22229999922222544700744522222999992222...",
            "..2222999999222225444774445222229999992222..", ".122299999922222254470074452222229999992221.",
            ".121999999922222254440044452222229999999121.", "..1999999992222224444004444222222999999991..",
            "..9999992244222214414004144122224422999999..", ".999999.2244422214414004144122244422.999999.",
            "9999.....2444421.4412002144.1244442.....9999", "999.......54441..4521771254..14445.......999",
            "99........54441..2222772222..14445........99", "..........14741..2222662222..14741..........",
            "...........5781..2222662222..1875...........", "...........8881..1222442221..1888...........",
            "...........888....45222254....888...........", "............88....44222244....88............",
            "............11....44222244....11............",
        ],
    },

    // Slot 0, level 4 - tall fins, mid-set cyan wings and twin nacelles that carry their own burn. Ported the same way as level 2: the
    // design's own grid (36x39, measured at 9.97 px a cell), cut where the
    // hull ends and the exhaust begins, folded to be symmetric, and shaded cell
    // by cell with the bank's own ramp of indices rather than by a formula --
    // every level past the first is shaded panel by panel in the source art.
    //
    // Its nacelles carry a burn of their own in the design. The engine draws
    // one flame, at the ship's centre, so the central exhaust is cut as on
    // every level and the two side ones stay baked into the art: nothing can
    // animate them, and removing them costs the hull a signature.
    // The wings keep the shared accent ramp: `unit` and the core row are fitted
    // so their cells span 5.01..9.83 of it against level 1's 5.00..9.85, which is
    // what keeps one gradient across all five hulls.
    ship0lv4: {
        ramp: { row: 5.5, col: 17.5, unit: 2.98, by: { 9: NEEDLE_SHADING[9] } },
        rows: [
            ".................00.................", ".................77.................",
            "................1001................", "................2002................",
            "................5005................", "................4004................",
            "................4004................", "...............240042...............",
            "...............240042...............", "..........88...340043...88..........",
            "..........88...240042...88..........", ".........888...240042...888.........",
            ".........888..15477451..888.........", ".........1221.24422442.1221.........",
            ".........5421.44222244.1245.........", ".........4421.64222246.1244.........",
            ".........2421.64122146.1242.........", "........92511244188144211529........",
            "........92211444188144411229........", ".......9911116445225446111199.......",
            "......199211164411114461112991......", "......999111164412214461111999......",
            ".....99992552644111144625529999.....", "....9999946415444224445146499999....",
            "...999344462214547745412264443999...", "..99944444611144400444111644444999..",
            ".1944454446111444004441116444544491.", ".9991..2216211544004451126122..1999.",
            "999......172125440044521271......999", "91.......112225540045522211.......19",
            ".........122221420024122221.........", ".........222121420024121222.........",
            ".........552111627726111255.........", ".........5582.16222261.2855.........",
            ".........5885..612216..5885.........", ".........2385..612216..5832.........",
            "..........878..512215..878..........", "..........808..152251..808..........",
            "..........88....4224....88..........",
        ],
    },

    // Slot 0, level 5 - wings from edge to edge, the longest fuselage of the five, and the nacelles at full size. Ported the same way as level 2: the
    // design's own grid (45x45, measured at 9.40 px a cell), cut where the
    // hull ends and the exhaust begins, folded to be symmetric, and shaded cell
    // by cell with the bank's own ramp of indices rather than by a formula --
    // every level past the first is shaded panel by panel in the source art.
    //
    // Its nacelles carry a burn of their own in the design. The engine draws
    // one flame, at the ship's centre, so the central exhaust is cut as on
    // every level and the two side ones stay baked into the art: nothing can
    // animate them, and removing them costs the hull a signature.
    // The wings keep the shared accent ramp: `unit` and the core row are fitted
    // so their cells span 4.99..9.84 of it against level 1's 5.00..9.85, which is
    // what keeps one gradient across all five hulls.
    ship0lv5: {
        ramp: { row: 42, col: 22, unit: 3.13, by: { 9: NEEDLE_SHADING[9] } },
        rows: [
            ".....................202.....................", ".....................303.....................",
            ".....................505.....................", ".....................606.....................",
            ".....................606.....................", "....................14041....................",
            "....................14041....................", "....................44044....................",
            "...................1440441...................", "...................1440441...................",
            "..................114404411..................", "..................144474441..................",
            "...............9.22444244422.9...............", "..............99.22444244422.99..............",
            ".............999.12445254421.999.............", ".............999.11442224411.999.............",
            "............999222542222245222999............", "............992224422222224422299............",
            "............991224422777224422199............", "............999124422707224421999............",
            "..........9.999124411707114421999.9..........", "..........9.911154441707144451119.9..........",
            ".........19.122154602707206451221.91.........", ".........99.233254602707206452332.99.........",
            "........19922335447427072474453322991........", "........99222212447427072474421222299........",
            ".......9992211124474122214744211122999.......", "......999922121244721222127442121229999......",
            ".....99999229212444212221244421292299999.....", "....9999991992124444122214444212991999999....",
            "...999999999921244445111544442129999999999...", "...99999..9122111244511154421112219..99999...",
            "..99999...1222111.445222544.1112221...99999..", ".19999....8222288.445888544.8822228....99991.",
            ".9999......82222..445222544..22228......9999.", "9999.......04441..545121545..14440.......9999",
            "99.........4122....4512154....2214.........99", "9...........822....4522254....228...........9",
            "............222....4522254....222............", "............425....4525254....524............",
            "............375....4456544....573............", "............808.....44644.....808............",
            "............808.....44044.....808............", "............108.....46064.....801............",
            "....................47074....................",
        ],
    },

    // Slot 1 - "Hammer": heavy gunship with two forward cannons.
    ship1: { mir: true, rows: [
        "..11..11", "..14..17", "..14.117", "..14.147", "..14.147", ".1141447",
        ".1441447", "11441447", "18441447", "18444447", "18444445", ".1444445",
        "..144445", "..114445", "...11445", "...1.155", "....1.15", "......9.",
    ] },

    // Slot 2 - "Wraith": long stealth hull, canards and rear fins.
    ship2: { mir: true, rows: [
        ".......6", ".......4", "......14", "......17", "......17", ".....114",
        "...81144", "...81144", ".....144", ".....144", "....1144", "...81144",
        "..881444", ".8811444", "88.11445", "....1145", ".....115", "......9.",
    ] },

    // Slot 3 - "Coral": round hull with side thruster rings.
    ship3: { mir: true, rows: [
        "......11", ".....144", ".....147", "....1147", "...31447", "..831447",
        ".8831447", ".8831447", ".8831444", "..831444", "...31444", "....1445",
        "....1445", "....1145", ".....145", ".....155", "......15", "......9.",
    ] },

    /* --- Enemies (facing down) --------------------------------------- */

    drone0: { mir: true, rows: [
        ".....11.", "....1441", "...14441", "..144441", ".1444441", "11447744",
        "11447744", ".1444441", "..144441", "...14441", "....1441", "..8..11.",
        ".8......",
    ] },
    drone1: { mir: true, rows: [
        "8.....1.", ".8...144", "..8.1444", "...11444", "..114444", ".1144774",
        "11444774", ".1144444", "..114444", "...11444", "..8.1444", ".8...144",
        "8.....1.",
    ] },

    speedy0: { mir: true, rows: [
        "....155", "....155", "...1145", "...1144", "8..1144", "88.1144",
        ".881144", "..11447", "...1447", "...1447", "...1444", "....144",
        "....144", ".....14", ".....11", "......1",
    ] },
    speedy1: { mir: true, rows: [
        "....144", "...1144", "..11444", ".811444", "8811447", ".811447",
        "..11444", "...1444", "...1447", "....144", "....144", ".....14",
        ".....11", "......1",
    ] },

    tank0: { mir: true, rows: [
        ".....11111", "...1144441", "..11444444", ".114444442", "1144444442",
        "1442222442", "1442277442", "1442277442", "1442222442", "1144444442",
        ".114444442", "..11444444", "...1144441", "..8..11111", ".8........",
        "8.........",
    ] },
    tank1: { mir: true, rows: [
        "....111111", "..11444441", ".114444442", "1144444442", "3144422442",
        "3144277442", "3144277442", "3144422442", "1144444442", ".114444442",
        "..11444444", "...1144441", "....114441", ".....11111", "..8...9..9",
        ".8........",
    ] },

    // Sniper: platform with a long central cannon.
    sniper0: { mir: true, rows: [
        "....1111", "..114444", ".1144444", "11444444", "14442244", "14422774",
        "14422774", "14442244", "11444444", ".1144444", "..114444", "8..11444",
        "88...144", ".8...114", "......14", "......14", "......17", "......11",
    ] },

    // Kamikaze: diamond hull with an overloaded core.
    kami0: { mir: true, rows: [
        "..11445", ".114445", "8114445", "1140045", "1400005", "1400005",
        "1140045", "8114445", ".114445", "..11445", "...1145", "....115",
        ".....11", "......9",
    ] },

    // Boss: 44x24 dreadnought with a reactor core.
    boss0: { mir: true, rows: [
        "...................991",
        "..................9444",
        ".................14444",
        "................144444",
        "..............11222222",
        "............1124444444",
        "..........114224444444",
        "........11444224442222",
        "......1144444224422777",
        ".1..112444444224227770",
        "3311422444444224277000",
        "3344422444444224277000",
        "3344422444444224277000",
        "3344422444444224277000",
        ".144422444444224227770",
        "..11422444444224422777",
        "....112444444224442222",
        "......1144444224444444",
        "........11222222222222",
        "..........114224444444",
        "............1114444444",
        "...............1144444",
        ".................11444",
        "...................111",
    ] },


    /* --- Boss family (one every 4 waves, they rotate) -----------------
       boss0 dreadnought · boss1 warden · boss2 lancer · boss3 hive ·
       boss4 prism. Same scale as boss0; the AI of each lives in
       `_updateBoss`. */

    boss1: { mir: true, rows: [
        "........................",
        "..............1111111111",
        ".............14444444444",
        "...........1144444444444",
        "..383.....14444444444444",
        ".33333..1144444444444444",
        ".33333114444444444444447",
        ".33333444444444444447777",
        ".33333442222444222277770",
        ".33333442222444222277000",
        ".33333442222444222777000",
        ".33333442222444222277000",
        ".33333442222444222277770",
        ".33333444444444444447777",
        ".33333111444444444444447",
        ".33333...144444444444444",
        ".99999....11444444444444",
        ".99999......144444444444",
        ".99999.......14444444444",
        "..............1111111111",
        "........................",
        "........................",
    ] },
    boss2: { mir: true, rows: [
        "...............11111",
        "..............144444",
        ".............1444444",
        "............14444444",
        "..111111111144444444",
        "...12282224444444444",
        "...12222224444444447",
        "....1222224444444777",
        ".....122224444447777",
        ".....122224444447777",
        "..111222224444447777",
        "..122222444444444777",
        "..999111111444444447",
        "..999......144444444",
        "..999.......11444444",
        ".9999.........144444",
        ".999...........14443",
        ".999............1133",
        "..................33",
        "..................33",
        "..................33",
        "..................33",
        "..................33",
        "..................00",
        "..................00",
        "..................00",
    ] },
    boss3: { mir: true, rows: [
        ".......................1",
        "..............1111111114",
        "...........1114444444444",
        ".........114444444444444",
        ".......11444444444444444",
        "......144444444444444444",
        ".....1449994449994449994",
        "....14499899499899499899",
        "....14998889998889998889",
        "...144499899499899499899",
        "....14449994449994449994",
        "....14444444444444444477",
        "....14444444444444447770",
        "....14444444444444477700",
        "....14444444444444447770",
        "....11114444444444444477",
        ".....9999994499999944999",
        ".....9999994499999944999",
        ".....9999991199999911999",
        ".....999999..999999..999",
        "........................",
        "........................",
    ] },
    boss4: { mir: true, rows: [
        "..................1111",
        ".................14444",
        "................144444",
        "...............1222244",
        ".............112222444",
        "............1422224444",
        "...........14222244447",
        "......8...142222244777",
        ".........1422222447777",
        "........14222224477770",
        "......1142222244477700",
        ".....14422222444477000",
        "....144444444444777000",
        "....144422222444477000",
        ".....14442222244477700",
        "......1444222224477770",
        ".......144222224447777",
        "......8.14422222444777",
        ".........1142222244447",
        "...........14222224444",
        "............1222224444",
        ".............122222444",
        "..............12222244",
        "...............1444444",
        "................144444",
        ".................11111",
    ] },

    /* --- WARDEN armour plate (6x12) ---------------------------------------
       Not mirrored: one plate, drawn on the left and flipped for the right by
       `boss_animator.js`. It slides outward and dims as the armour drops, which
       is the tell for the hurt window. Banded so the travel is readable. */
    bossPlate: { rows: [
        ".3333.",
        "366663",
        "366663",
        "322223",
        "322223",
        "366663",
        "366663",
        "322223",
        "322223",
        "366663",
        "366663",
        ".3333.",
    ] },

    /* --- LANCER emplacement (18x17) ---------------------------------------
       The furniture LANCER plants on its dive: a head that anchors a beam, a
       stem and a base plate. Tinted gold like its parent, with the stem left in
       the bank's fixed violet so it reads as something the boss dropped rather
       than as an enemy that shoots -- it never fires, it only holds a lance.
       Mirrored, so the half below is columns 0..8 of the 18. */
    lnode0: { mir: true, rows: [
        "......154",
        ".....1544",
        "...154444",
        "..1544447",
        "..1544470",
        "..1544470",
        "...154447",
        ".....1544",
        "......154",
        ".......92",
        ".......92",
        ".......92",
        ".......92",
        ".......92",
        "....33333",
        "..3333333",
        "133333333",
    ] },

    /* --- Colossal bosses (they do not fit the arena: the camera pulls back) --

       One per milestone wave. Drafted with geometric primitives and frozen
       here as plain art: 4/5/6 take the boss tint, 0/7 are the glowing core.
       They are drawn several hundred logical px wide, so the pixels are
       deliberately chunky. */

    colossus0: { mir: true, rows: [
        "..............................................",
        "......................................11111111",
        ".....................................144444444",
        "....................................1444444444",
        "..................................114444444444",
        ".................................1444444444444",
        "................................14444444444444",
        "......1181111181111181111181111184444484444447",
        "......1444444444444444444444444444444444477777",
        "......1444222244444422224444442222444444777777",
        "......1444222244444422224444442222444447777770",
        "......1444222244444422224444442222444477777000",
        "......1444222244444422224444442222444477770000",
        "......1444222244444422224444442222444777700000",
        "......1444222244444422224444442222444477770000",
        "......1444222244444422224444442222444477777000",
        "......1444222244444422224444442222444447777770",
        "......1444222244444422224444442222444444777777",
        "......1444444444444444444444444444444444477777",
        "......1444444444444444444444444444444444444447",
        "....111444444433333344444444333333444444444444",
        ".......114444433333344444444333333444444444444",
        ".........1114433333344444444333333444444444444",
        "............1133333311111111333333111111111111",
        "..............399993........399993............",
        "..............399993........399993............",
        "..............399993........399993............",
        "..............399993..........................",
    ] },
    colossus1: { mir: true, rows: [
        ".......................................9......",
        "......................................999....1",
        "..................................9...99911114",
        ".................................999..19994444",
        ".................................9991149994444",
        "..................................999449994444",
        "..................................999444777444",
        "..................................999477707774",
        "..................................199977000774",
        "...................................99977707774",
        "...................................19444777444",
        "....................................1444444444",
        "......................111111111111114444444444",
        "....................11222222222222222244444444",
        "..................1125555555555552222224444488",
        "...............1115555555555555555522299949994",
        ".............112555555555555555555552299949994",
        "............1255555555552222225555522299949994",
        "..........115555555522222111112222222299929988",
        ".........1225555552211111.....1222222299929992",
        "........122555555211.........12222222222222222",
        "........1255552211............1222222222222222",
        ".......125555221..............1222222222222288",
        "......145555221...............1222222222222222",
        "....1144444221.................122222222222222",
        "..11444777444..................122222222222222",
        "..14447777744...................12222222222288",
        ".1444447774441...................1122222222222",
        "..14444444444......................12222222222",
        "..14444444441.......................1112222222",
        "...199941999...........................1111112",
        "....9991.9999................................1",
    ] },
    colossus2: { mir: true, rows: [
        "......................33333...............",
        "......................33333...............",
        "......................33333....33333......",
        "......................33333....33333......",
        "............33333.....33333....33333......",
        "............33333.....33333....33333......",
        "............33333.....33333....33333......",
        "............33333.....33333....33333......",
        "............33333.....33333....33333......",
        "........3333444441111144444111144444111111",
        "......333333334444444444444444444444444444",
        ".....3333333332222222222222222222222222222",
        ".....3338883333222222222222222222222222222",
        "....33388888333444444444444444444444444444",
        "...333338883334444444444444444444444444444",
        "..3333333333334444444444449999999999999990",
        "..3333333333344444444444449988888888000000",
        ".33333333344444444444444449988888880000000",
        ".33333333444444444444444449988888800000000",
        ".33333333444444444444444449988888000000000",
        ".33333334444444444444444449988888800000000",
        ".33333334444444444444444449988888880000000",
        ".33333334444444444444444449988888888000000",
        ".33393934444444444444444449999999999999990",
        ".33999994444444444444444444444444444444444",
        "..9999999422222222222222222222222222222222",
        "..9999999422222222222222222222222222222222",
        ".99999999941114444444444444444444444444444",
        "99999999999...1444444444444444444444444444",
        "999.999.999....114444444444444444444444444",
        "99..999..999.....1444444444444444444444444",
        "9...999...9.......111111111111111111111111",
        "....999...................................",
        ".....9....................................",
    ] },
    colossus3: { mir: true, rows: [
        "............................................",
        "...........................................1",
        "..............................11111111111114",
        "..............3..........1111144444444444444",
        "............33333...111114444444444444444444",
        "...........333333311422222444444444444444441",
        "..........333383333444222224444111111111111.",
        "...........33333334444422222111.............",
        "...........13333344444112222................",
        "..........144434444411..12221..............9",
        "........114444444411.....12221.......9999999",
        ".......14444444411........12221....999999999",
        "......1444444411...........12221.99999999990",
        ".....144444441..............1222199999900000",
        ".....14444444...............1222299990000000",
        "....143444441................122229900000000",
        "....33333444..................12222000000000",
        "...33333332211111111111111111122222222222222",
        "..333383333222222222222222222222222222222222",
        "...33333332211111111111111111122222222222222",
        "....33333444..................12222000000000",
        "....143444441................122229900000000",
        ".....14444444...............1222299990000000",
        ".....144444441..............1222199999900000",
        "......1444444411...........12221.99999999990",
        ".......14444444411........12221....999999999",
        "........114444444411.....12221.......9999999",
        "..........144434444411..12221..............9",
        "...........13333344444112222................",
        "...........33333334444422222111.............",
        "..........333383333444222224444111111111111.",
        "...........333333311422222444444444444444441",
        "............33333...111114444444444444444444",
        "..............3..........1111144444444444444",
        "..............................11111111111114",
        "...........................................1",
    ] },
    colossus4: { mir: true, rows: [
        "........................................1111111111",
        ".......................................14444444444",
        ".......................................14444444444",
        "......................................144444444444",
        ".....................................1444444444444",
        "....................................14444444444444",
        "11111111111111111111111111111111111144444444444444",
        ".1444444444444444444444444444444444444444444444449",
        "..812244444224444422444442244444444444444444999999",
        "....1228444422444442244444224444444444444499999997",
        ".....124444422444442244444224444444444444999977777",
        "......12444482244444224444422444444444449999777777",
        "......12444442244844224444422444444444499997777770",
        ".......1211444224444422444442244444444499977777000",
        ".......12..144224444428444442244444444499977770000",
        "........11..14422444442244484224444444999777700000",
        ".........11..1142244444224444422444444499977770000",
        ".........12....12244444224444422844444499977777000",
        "..........11....1224444422444442244444499997777770",
        "..........12.....124144422444442244444449999777777",
        "...........11.....12.11442244444224444444999977777",
        "...........12.....12...112244444224444444499999997",
        "......99....1199...11.99.1114499424444444444999999",
        "......99......99......99....1199444444444444444449",
        "......99......99......99......99114444444444444444",
        "......99......99......99......99..1444444444444444",
        "......99......99......99......99..1114444444444444",
        ".....................................1444444444444",
        "......................................144444444444",
        ".......................................14444444444",
        ".......................................14444444444",
        "........................................1444444444",
        ".........................................144444444",
        "..........................................11111111",
        "..................................................",
        "..................................................",
    ] },

    /* --- Power-ups (16x16, capsule with a glyph) --------------------- */

    // Triple shot.
    pupT: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444111114461.",
        ".16444551554461.",
        ".16444441444461.",
        ".15444441444451.",
        ".15444441444451.",
        ".15444441444451.",
        "..154444144451..",
        "...1544454451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    // Shield.
    pupS: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444411144461.",
        ".16444155514461.",
        ".16444144454461.",
        ".15444511144451.",
        ".15444455514451.",
        ".15444144414451.",
        "..154451115451..",
        "...1544555451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    // Bomb.
    pupB: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444444444461.",
        ".16444144414461.",
        ".16444514154461.",
        ".15444111114451.",
        ".15444515154451.",
        ".15444154514451.",
        "..154454445451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    // Extra life.
    pupL: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444441444461.",
        ".16444441444461.",
        ".16444111114461.",
        ".15444111114451.",
        ".15444551554451.",
        ".15444441444451.",
        "..154444544451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },


    /* --- Extra capsules: same frame, different glyph ------------------
       R rapid fire · V overcharge · P piercing · H homing · D wingman ·
       G phase · F freeze · X overload · C combo · Y payday. */

    pupR: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444411444461.",
        ".16444144144461.",
        ".16441444414461.",
        ".15444444444451.",
        ".15444411444451.",
        ".15444144144451.",
        "..154144441451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    pupV: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444441144461.",
        ".16444411444461.",
        ".16444114444461.",
        ".15444111114451.",
        ".15444441144451.",
        ".15444411444451.",
        "..154411444451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    pupP: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444411444461.",
        ".16444111144461.",
        ".16441111114461.",
        ".15444411444451.",
        ".15441111114451.",
        ".15444411444451.",
        "..154441144451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    pupH: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444411444461.",
        ".16444144144461.",
        ".16441400414461.",
        ".15441400414451.",
        ".15444144144451.",
        ".15444411444451.",
        "..154444444451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    pupD: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444411444461.",
        ".16444111144461.",
        ".16441111114461.",
        ".15441411414451.",
        ".15444411444451.",
        ".15444444444451.",
        "..154441144451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    pupG: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444411444461.",
        ".16444155144461.",
        ".16441500514461.",
        ".15441500514451.",
        ".15444155144451.",
        ".15444411444451.",
        "..154444444451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    pupF: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444414444461.",
        ".16441414144461.",
        ".16444111444461.",
        ".15441111114451.",
        ".15444111444451.",
        ".15441414144451.",
        "..154441444451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    pupX: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16441444414461.",
        ".16444144144461.",
        ".16444411444461.",
        ".15444411444451.",
        ".15444144144451.",
        ".15441444414451.",
        "..154444444451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    pupC: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16441414444461.",
        ".16444141444461.",
        ".16444414144461.",
        ".15444441414451.",
        ".15444414144451.",
        ".15444141444451.",
        "..154141444451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    pupY: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444411444461.",
        ".16444100144461.",
        ".16441011014461.",
        ".15441011014451.",
        ".15444100144451.",
        ".15444411444451.",
        "..154444444451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },

    /* --- Asteroids (12x12, no mirroring) ----------------------------- */

    rock0: { rows: [
        "...466664...", ".44666666644", "446666666654", "466661666554",
        "466611665554", "466661665554", "446666655554", "446666555554",
        ".4466555554.", ".446555554..", "..44555554..", "....44554...",
    ] },
    rock1: { rows: [
        "..4466664...", ".4666666664.", "446666666654", "466666116654",
        "466661166554", "466666665554", "446666555554", ".46665555554",
        ".44665555554", "..4455555554", "...445555...", "....4554....",
    ] },
};

/* ------------------------------------------------------------------ */
/* Rasterizing + cache                                                 */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * A hex colour at an alpha, as a canvas fill. Exported because half the render
 * code wants exactly this and three copies of the parse had grown around it
 * (the engine's `glow`, the menu backdrop's `rgba`): this file is the shared
 * leaf module, so the one copy lives here.
 */
export function rgba(hex, a) {
    const c = hexToRgb(hex);
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** RGB triple out of either form `palette()` produces: "#rrggbb" or "rgb(r,g,b)". */
function toRgb(css) {
    if (css[0] === "#") {
        return hexToRgb(css);
    }
    return css.slice(4, -1).split(",").map((n) => parseInt(n, 10));
}

/**
 * A ramp step: `base` walked along `slope` by how far the cell sits from the
 * ramp's core, clamped. This is the whole of the shading model the hull art is
 * drawn in -- flat symbols in the grid, the gradient applied here, once, into
 * the cached raster. `at` slides the base along the ramp (so it can be the
 * zone's middle rather than its end) and `k` scales the slope.
 */
function shade(step, base, dist) {
    const d = (dist - (step.at || 0)) * (step.k || 1);
    const v = [0, 1, 2].map((c) => Math.max(0, Math.min(255, Math.round(base[c] + step.slope[c] * d))));
    return `rgb(${v[0]},${v[1]},${v[2]})`;
}

function mix(a, b, t) {
    const A = hexToRgb(a);
    const B = hexToRgb(b);
    return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(
        A[2] + (B[2] - A[2]) * t
    )})`;
}

function expand(def) {
    if (def._grid) {
        return def._grid;
    }
    let grid;
    if (def.mir) {
        const hw = Math.max(...def.rows.map((r) => r.length));
        grid = def.rows.map((r) => {
            const half = r.padStart(hw, ".");
            return half + half.split("").reverse().join("");
        });
    } else {
        grid = def.rows.slice();
    }
    const w = Math.max(...grid.map((r) => r.length));
    def._grid = grid.map((r) => r.padEnd(w, "."));
    return def._grid;
}

/**
 * The expanded character grid of a sprite, mirroring resolved: one string per
 * row, one char per logical pixel, "." for transparent. Shared (and cached on
 * the definition), so callers must treat it as read only. `colossus_animator`
 * uses it to know which cells an effect may touch without re-reading the art.
 *
 * @param {string} name key in SPRITES
 * @returns {string[]}
 */
export function spriteGrid(name) {
    const def = SPRITES[name];
    return def ? expand(def) : [];
}

export function spriteSize(name) {
    const def = SPRITES[name];
    if (!def) {
        return { w: 0, h: 0 };
    }
    const g = expand(def);
    return { w: g[0].length, h: g.length };
}

const cache = new Map();

/**
 * The palette of a sprite for one tint: palette index (as a string) -> CSS
 * colour, with 4/5/6 resolved from `tint` exactly as the rasterizer does.
 *
 * Exported because `colossus_animator.js` paints effects by *promoting* a cell
 * along this palette instead of washing additive light over the hull, and the
 * two must agree on what a "4" looks like: a second copy of these colours would
 * drift the first time one of them is retuned.
 *
 * @param {string} tint hex colour for indices 4/5/6
 * @returns {Object} index -> CSS colour ("." is absent, it is transparent)
 */
export function palette(tint) {
    return Object.assign({}, BASE, {
        4: tint,
        5: mix(tint, "#0a0418", 0.45),
        6: mix(tint, "#ffffff", 0.55),
    });
}

/**
 * Return a canvas with the sprite rasterized.
 * @param {string} name key in SPRITES
 * @param {string} tint hex colour for indices 4/5/6
 * @param {number} px logical pixel size
 * @param {boolean} flash paint the silhouette white (hit)
 * @returns {HTMLCanvasElement|null}
 */
export function sprite(name, tint, px, flash) {
    const key = name + "|" + tint + "|" + px + "|" + (flash ? 1 : 0);
    let cv = cache.get(key);
    if (cv) {
        return cv;
    }
    const def = SPRITES[name];
    if (!def) {
        return null;
    }
    const grid = expand(def);
    const w = grid[0].length;
    const h = grid.length;
    cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(w * px));
    cv.height = Math.max(1, Math.round(h * px));
    const g = cv.getContext("2d");
    const pal = palette(tint);
    const ramp = def.ramp;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const ch = grid[y][x];
            let col = pal[ch];
            if (!col) {
                continue;
            }
            const step = ramp && ramp.by[ch];
            if (step) {
                const dist = Math.hypot(y - ramp.row, x - ramp.col) / (ramp.unit || 1);
                col = shade(step, step.base || toRgb(col), dist);
            }
            g.fillStyle = flash ? (ch === "1" || ch === "9" ? "#ffb9f2" : "#ffffff") : col;
            g.fillRect(Math.round(x * px), Math.round(y * px), Math.ceil(px), Math.ceil(px));
        }
    }
    cache.set(key, cv);
    return cv;
}

// Tilt frames: the angle the hull is turned around its own nose-to-tail axis
// at each level, and how much nearer the raised wing reads.
const BANK_ANGLES = [0, 0.38, 0.78];
const BANK_PERSP = 0.26;
const bankCache = new Map();

/**
 * Return a canvas with the sprite banked `level` steps (-2..2), i.e. rolled
 * around the axis running from its nose to its tail.
 *
 * There are no tilt image files: the frame is built from the hull's own pixel
 * grid, one logical pixel column at a time. Every column is compressed towards
 * the centre (the hull turns away from us) and scaled vertically by how near
 * that side now is, which is what makes a flat top-down sprite read as banked.
 * The columns stay whole pixels wide, so the result is still pixel art.
 *
 * Cached like `sprite()`. Level 0 is the flat sprite, returned as-is.
 *
 * @param {string} name key in SPRITES
 * @param {string} tint hex colour for indices 4/5/6
 * @param {number} px logical pixel size
 * @param {number} level -2..2, negative banking left
 * @returns {HTMLCanvasElement|null}
 */
export function bankSprite(name, tint, px, level) {
    const lvl = Math.max(-2, Math.min(2, Math.round(level || 0)));
    if (!lvl) {
        return sprite(name, tint, px, false);
    }
    const key = name + "|" + tint + "|" + px + "|b" + lvl;
    let cv = bankCache.get(key);
    if (cv) {
        return cv;
    }
    const base = sprite(name, tint, px, false);
    if (!base) {
        return null;
    }
    const ang = BANK_ANGLES[Math.abs(lvl)];
    const dir = lvl < 0 ? -1 : 1;
    const cos = Math.cos(ang);
    const persp = BANK_PERSP * Math.sin(ang);
    const bw = base.width;
    const bh = base.height;
    cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(bw * cos));
    cv.height = Math.max(1, Math.ceil(bh * (1 + persp)));
    const g = cv.getContext("2d");
    g.imageSmoothingEnabled = false;
    const cx = cv.width / 2;
    const cy = cv.height / 2;
    const step = Math.max(1, Math.round(px));
    for (let sx = 0; sx < bw; sx += step) {
        const sw = Math.min(step, bw - sx);
        // Map both edges of the column, so rounding cannot open a seam.
        const u0 = (sx / bw) * 2 - 1;
        const u1 = ((sx + sw) / bw) * 2 - 1;
        const dx0 = Math.round(cx + u0 * cos * (bw / 2));
        const dw = Math.max(1, Math.round(cx + u1 * cos * (bw / 2)) - dx0);
        // The wing on the outside of the turn rises towards us and is drawn
        // taller; the one on the inside dips away and shrinks.
        const dh = Math.max(1, Math.round(bh * (1 - dir * ((u0 + u1) / 2) * persp)));
        g.drawImage(base, sx, 0, sw, bh, dx0, Math.round(cy - dh / 2), dw, dh);
    }
    bankCache.set(key, cv);
    return cv;
}

/**
 * Draw a sprite centred at (x, y) of the given context.
 * @param {CanvasRenderingContext2D} g
 * @param {string} name
 * @param {number} x centre
 * @param {number} y centre
 * @param {Object} [o]
 * @param {string} [o.tint="#5ee1ff"]
 * @param {number} [o.px=2] pixel size
 * @param {boolean} [o.flash]
 * @param {number} [o.rot] rotation in radians (asteroids)
 * @param {number} [o.alpha]
 */
export function drawSprite(g, name, x, y, o = {}) {
    const px = o.px || 2;
    const cv = sprite(name, o.tint || "#5ee1ff", px, !!o.flash);
    if (!cv) {
        return;
    }
    g.save();
    if (o.alpha != null) {
        g.globalAlpha = o.alpha;
    }
    g.imageSmoothingEnabled = false;
    if (o.rot) {
        g.translate(x, y);
        g.rotate(o.rot);
        g.drawImage(cv, -cv.width / 2, -cv.height / 2);
    } else {
        g.drawImage(cv, Math.round(x - cv.width / 2), Math.round(y - cv.height / 2));
    }
    g.restore();
}

/**
 * The box the painted pixels of a canvas actually occupy, plus a margin, or
 * `null` if nothing is painted on it.
 *
 * Exists for the glossary's animated cards: a card is drawn onto a canvas big
 * enough for the longest plume its hull can throw, every frame of its loop is
 * sampled onto one probe, and the union of what that painted is the size the
 * card canvas gets -- so the art is framed by what it does rather than by a
 * margin written down per hull, and it does not jitter as the animation runs.
 *
 * @param {HTMLCanvasElement} cv
 * @param {number} [pad=0] margin in device pixels
 * @returns {Object|null} `{ x, y, w, h }`
 */
export function canvasBounds(cv, pad = 0) {
    const g = cv.getContext("2d");
    const data = g.getImageData(0, 0, cv.width, cv.height).data;
    let x0 = cv.width;
    let y0 = cv.height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x++) {
            if (data[(y * cv.width + x) * 4 + 3] === 0) {
                continue;
            }
            if (x < x0) { x0 = x; }
            if (x > x1) { x1 = x; }
            if (y < y0) { y0 = y; }
            if (y > y1) { y1 = y; }
        }
    }
    if (x1 < 0) {
        return null;
    }
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(cv.width - 1, x1 + pad);
    y1 = Math.min(cv.height - 1, y1 + pad);
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Pixel size so a sprite spans `target` logical px in width. */
export function pxFor(name, target) {
    const s = spriteSize(name);
    return s.w ? Math.max(1, Math.round((target / s.w) * 2) / 2) : 2;
}
