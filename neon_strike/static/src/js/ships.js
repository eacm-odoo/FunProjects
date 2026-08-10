/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - the player hulls, as data.
 *
 * One entry per flyable hull: sprite, colour and the blurb reused by the
 * glossary and the menu picker. They are cosmetic — every hull flies, shoots
 * and takes damage exactly the same — so a player can fly whichever they like
 * without touching the balance.
 *
 * **The array order is wire format**: `SHIP_COLORS` is the slot palette the
 * engine and `neon.strike.participant.color` (Python) both index by slot, and
 * the chosen hull travels in the snapshot as an index. Append at the end,
 * never insert in the middle.
 */

export const SHIPS = [
    {
        id: "needle", sprite: "ship0", tint: "#5ee1ff",
        label: "NEEDLE", sub: "interceptor",
        desc: "Sharp hull with a swept wing.",
    },
    {
        id: "hammer", sprite: "ship1", tint: "#ff8fb3",
        label: "HAMMER", sub: "gunship",
        desc: "Heavy chassis with twin forward cannons.",
    },
    {
        id: "wraith", sprite: "ship2", tint: "#7bffb0",
        label: "WRAITH", sub: "stealth",
        desc: "Long fuselage with canards and rear fins.",
    },
    {
        id: "coral", sprite: "ship3", tint: "#ffd166",
        label: "CORAL", sub: "rings",
        desc: "Round hull with side thruster rings.",
    },
];

// Slot palette: in co-op the colour is what tells the four ships apart, so it
// stays tied to the slot even when two players fly the same hull.
export const SHIP_COLORS = SHIPS.map((s) => s.tint);

/** Index of a hull id, or 0 for anything unknown (an old saved preference). */
export function hullIndex(id) {
    const i = SHIPS.findIndex((s) => s.id === id);
    return i < 0 ? 0 : i;
}
