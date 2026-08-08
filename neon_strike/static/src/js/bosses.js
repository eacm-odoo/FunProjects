/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - regular bosses (the ones every 4 waves).
 *
 * These are the "normal" bosses: they fit the arena and do not touch the
 * camera. The colossal ones live in `colossi.js` and take over the waves that
 * are a multiple of 10.
 *
 * They rotate so the boss wave is not the same fight every time: `hp` and
 * `val` are multipliers over the shared boss formula, and the AI of each one
 * lives in `_updateBoss` in the engine, keyed by index. Data only: the order
 * of this array is the wire format (the snapshot sends the index).
 */

export const BOSSES = [
    {
        id: "dreadnought",
        name: "DREADNOUGHT",
        sprite: "boss0",
        tint: "#ff4d4d",
        r: 44,
        hp: 1,
        val: 1,
        desc: "The classic siege hull. Sweeps the arena side to side while alternating radial bursts with aimed triple salvos.",
    },
    {
        id: "warden",
        name: "WARDEN",
        sprite: "boss1",
        tint: "#4de3c1",
        r: 46,
        hp: 1.35,
        val: 1.3,
        desc: "Fights in cycles: it raises armour and rakes a bullet curtain with one gap, then drops the armour and answers with aimed fans. Hurt it while the shield is down.",
    },
    {
        id: "lancer",
        name: "LANCER",
        sprite: "boss2",
        tint: "#ffd166",
        r: 34,
        hp: 0.8,
        val: 1.2,
        desc: "Light and aggressive. Charges a telegraphed lance beam from above, then dives straight through the arena and climbs back up.",
    },
    {
        id: "hive",
        name: "HIVE",
        sprite: "boss3",
        tint: "#9b5de5",
        r: 42,
        hp: 0.9,
        val: 1.3,
        desc: "Carrier: it barely shoots, it keeps opening its bays and pouring out interceptors. The swarm stops when the hive does.",
    },
    {
        id: "prism",
        name: "PRISM",
        sprite: "boss4",
        tint: "#8be9ff",
        r: 36,
        hp: 0.85,
        val: 1.4,
        desc: "Never stands still: it blinks across the arena leaving a shockwave ring behind and spins a three-armed spiral of fire between jumps.",
    },
];

/** A boss every 4 waves; the ones that are also colossus waves are skipped. */
export const BOSS_WAVES = 4;

/**
 * Which boss belongs to a wave, or -1 if it is not a boss wave.
 *
 * The index counts the boss waves seen so far and leaves out the ones a
 * colossus takes over (multiples of 20, i.e. multiples of both 4 and 10), so
 * the rotation stays complete instead of silently skipping a boss forever.
 *
 * @param {number} wave
 * @param {number} [colossusEvery=10]
 */
export function bossForWave(wave, colossusEvery = 10) {
    if (!wave || wave % BOSS_WAVES !== 0 || wave % colossusEvery === 0) {
        return -1;
    }
    const step = (BOSS_WAVES * colossusEvery) / gcd(BOSS_WAVES, colossusEvery);
    const seen = Math.floor(wave / BOSS_WAVES) - Math.floor(wave / step);
    return (seen - 1) % BOSSES.length;
}

function gcd(a, b) {
    return b ? gcd(b, a % b) : a;
}
