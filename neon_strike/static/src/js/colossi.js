/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - colossal bosses.
 *
 * One shows up every 10 waves, cycling through the five. They are far too big
 * for the 680x540 arena: while one is alive the playable field widens by
 * `field` and the camera pulls back far enough to frame all of it plus the
 * whole hull, so your ship looks tiny next to it. The zoom is computed by each
 * client from its own canvas (`_fitZoom`): it is a render concern, and the
 * simulation stays in the same logical space so host and guest agree.
 *
 * Data only: the AI of each one lives in `_updateColossus` keyed by index, and
 * the order of this array is the wire format (the snapshot sends the index).
 */

export const COLOSSI = [
    {
        id: "aegis",
        name: "AEGIS-01",
        title: "Bulwark",
        sprite: "colossus0",
        tint: "#ff4d4d",
        w: 850,          // logical width; the arena is only 680 wide
        field: 1.34,   // how much wider the playable field gets (see _applyField)
        hp: 300,       // starting hull; `+ wave * 28` on top (see mkColossus)
        val: 20000,
        // Vertical band it patrols and how fast it slides sideways. AEGIS is
        // the one colossus that ignores `speed`: it flies the motion profile in
        // `aegis_motion.js`, whose `descend.restY` mirrors the `y` below.
        y: 150,
        speed: 0.9,
        desc: "Siege slab wider than the arena. It plants itself, sweeps a curtain with a single gap, then answers with twin salvos.",
    },
    {
        id: "hydra",
        name: "HYDRA-07",
        title: "Serpent Crown",
        sprite: "colossus1",
        tint: "#9b5de5",
        w: 780,
        field: 1.36,
        hp: 600,
        val: 24000,
        y: 165,
        speed: 1.15,
        desc: "Three heads: the crown spits spirals, the two arms spray aimed fans and can be shot off. Each one you take tightens the spiral, and grows back.",
    },
    {
        id: "vulcan",
        name: "VULCAN",
        title: "Forge Titan",
        sprite: "colossus2",
        tint: "#ffb347",
        w: 800,
        field: 1.4,
        // 1000 rather than the 800 it was tuned at, because the vent window is
        // a damage multiplier and this is what pays for it. Measured on the
        // bench: a player who camps the core through every vent and ignores the
        // fans puts out x1.246 of what the old VULCAN took, so half of that
        // (+12% at wave 30) is the lift -- the best case stays about 11%
        // shorter, which is the reward, and nobody who never uses the window
        // pays more than the extra pressure the cycle brings anyway.
        hp: 1000,
        val: 28000,
        // Mirrored by `VULCAN_MOTION.descend.restY`: it walks its own lane
        // (see `vulcan_motion.js`) and the profile takes over from the entrance.
        y: 160,
        speed: 0.75,
        desc: "A walking foundry on a heat cycle: forge beams, an overheat that leaves the core open, then molten rings and asteroids. Hit a shoulder to bring the overheat forward.",
    },
    {
        id: "nyx",
        name: "NYX",
        title: "Eclipse",
        sprite: "colossus3",
        tint: "#4de3c1",
        w: 820,
        field: 1.44,
        // 630 rather than the 1000 it was tuned at, and for the mirror of the
        // reason VULCAN's went the other way: the ring phase can only ever
        // *cost* damage against a hull that used to have no armour at all, so
        // the catalogue has to hand some back. Measured at wave 40 under one
        // constant stream (`probe_nyx_ttk.mjs`): the fight that shipped takes
        // 3671 f; at the old hull the ring flown takes 5016 and the ring
        // ignored 7956. At this hull a player who closes every circle is back
        // on 3650-3740 -- the old fight, within the bench's own noise -- while
        // one who sits every circle out pays between 40% and 100% more.
        //
        // That second figure is a range and not a number on purpose: with the
        // armour up for most of the cycle almost all the damage lands in the
        // 1400 f base windows, so time to kill *steps* by about a cycle
        // depending on which window the last hit falls in. Swept over eight
        // hulls it reads 4597/4751/5571/7266/5076/5276/7469/8001. The flown
        // case is smooth, which is why it is the one this number is set on.
        // Re-run that probe if `NYX.armour`, `NYX.live` or the exposed window
        // move. The wave term (`+ wave * 28`) dominates by the second time NYX
        // comes round, so at wave 90 the same cut leaves the flown fight about
        // 15% longer than it used to be.
        hp: 630,
        val: 32000,
        y: 180,
        speed: 0.6,
        desc: "Ring station in permanent eclipse. Four beams turn like clock hands, and when the rim lights every lance there is one pocket left moving -- go with it.",
    },
    {
        id: "omega",
        name: "OMEGA",
        title: "Worldbreaker",
        sprite: "colossus4",
        tint: "#ff2fd0",
        w: 1000,
        field: 1.5,
        hp: 1300,
        val: 40000,
        y: 175,
        speed: 1.0,
        desc: "The last hull. Its eye sweeps a beam across the whole arena, it seeds kamikazes and closes in on whoever is left standing.",
    },
];

/** Which colossus belongs to a wave (one every COLOSSUS_WAVES waves). */
export const COLOSSUS_WAVES = 10;

export function colossusForWave(wave) {
    if (!wave || wave % COLOSSUS_WAVES !== 0) {
        return -1;
    }
    return (wave / COLOSSUS_WAVES - 1) % COLOSSI.length;
}
