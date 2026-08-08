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
        // Vertical band it patrols and how fast it slides sideways.
        y: 150,
        speed: 0.9,
        desc: "Siege slab wider than the arena. It sweeps a curtain of fire with a single gap and answers with twin siege salvos.",
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
        desc: "Three heads on one chest. The crown spits spirals, the side heads spray aimed fans, and it enrages below half hull.",
    },
    {
        id: "vulcan",
        name: "VULCAN",
        title: "Forge Titan",
        sprite: "colossus2",
        tint: "#ffb347",
        w: 800,
        field: 1.4,
        hp: 800,
        val: 28000,
        y: 160,
        speed: 0.75,
        desc: "A walking foundry. It hurls asteroid barrages, vents molten rings and cuts the arena with two forge beams.",
    },
    {
        id: "nyx",
        name: "NYX",
        title: "Eclipse",
        sprite: "colossus3",
        tint: "#4de3c1",
        w: 820,
        field: 1.44,
        hp: 1000,
        val: 32000,
        y: 180,
        speed: 0.6,
        desc: "Ring station in permanent eclipse. Four beams turn like clock hands while the rim keeps launching interceptors.",
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
