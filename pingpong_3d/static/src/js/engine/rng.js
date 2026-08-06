/** @odoo-module **/

/* Seeded pseudo-random numbers.
 *
 * Serves carry randomness, and both peers have to agree on it. The generator is
 * re-seeded at every point from (match seed, point index) so a divergence heals
 * at the next serve instead of compounding for the rest of the match. Solo mode
 * passes Math.random and behaves exactly as before.
 */

/** Small, fast, good enough for gameplay. Returns a function in [0, 1). */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Mix two integers into a seed. */
export function hashSeed(a, b) {
    let h = (a >>> 0) ^ Math.imul(b >>> 0, 0x9E3779B1);
    h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
    return (h ^ (h >>> 16)) >>> 0;
}
