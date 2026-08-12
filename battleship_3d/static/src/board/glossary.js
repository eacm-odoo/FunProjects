/** @odoo-module **/
/**
 * What the five hulls are, and what knowing them is worth.
 *
 * Data only: the models themselves come from `ships.js`, so the glossary shows
 * the same mesh that ends up on the board rather than a picture of it. `name`
 * has to match the server's FLEET (`models/battleship_game.py`) — that is the
 * key both the builders and the payload are keyed on.
 */

export const GLOSSARY = [
    {
        name: "Carrier",
        size: 5,
        sub: "fleet carrier · 5 cells",
        desc: "Flight deck the whole length of the hull, island to starboard, "
            + "two aircraft parked aft. The longest ship you have and the one "
            + "the enemy finds first.",
    },
    {
        name: "Battleship",
        size: 4,
        sub: "fast battleship · 4 cells",
        desc: "Two triple turrets forward, the second firing over the first, "
            + "a third aft. Pagoda bridge and two raked funnels amidships.",
    },
    {
        name: "Cruiser",
        size: 3,
        sub: "heavy cruiser · 3 cells",
        desc: "Twin turrets fore and aft, one funnel, and a crane over the "
            + "stern for the floatplane.",
    },
    {
        name: "Submarine",
        size: 3,
        sub: "fleet submarine · 3 cells",
        desc: "Rides lower than anything else: conning tower with periscopes, "
            + "a deck gun forward, planes at bow and stern. Same length as the "
            + "cruiser — three hits in a row never tell you which one you found.",
    },
    {
        name: "Destroyer",
        size: 2,
        sub: "destroyer · 2 cells",
        desc: "Torpedo tubes amidships, depth-charge racks aft. Two cells is "
            + "the hardest thing on the board to corner, and the last one left "
            + "in most games.",
    },
];

export const GLOSSARY_NOTE =
    "An enemy ship is only ever listed as \"Ship 5\" until it sinks. Its "
    + "silhouette is the one thing that gives it away before then.";
