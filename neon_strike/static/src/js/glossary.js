/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - glossary of ships, enemies, boss, asteroids and power-ups.
 *
 * Data-only catalogue: name, sprite, tint and one line of behaviour. The tints
 * and sprites are the same ones the engine uses in game, so what you see here
 * is literally what shows up while playing. The behaviour lines describe the
 * real AI in `game_engine.js`: if the engine changes, review them.
 *
 * `px` is the pixel size the card is rasterized at (~120-130 px wide for all of
 * them, whatever the sprite grid is).
 */

export const GLOSSARY = [
    {
        title: "PLAYER SHIPS",
        note: "One hull per slot. They change the look and colour, not the stats: they all fly and shoot the same.",
        items: [
            {
                sprite: "ship0", tint: "#5ee1ff", px: 8,
                label: "NEEDLE", sub: "interceptor · slot 1",
                desc: "Sharp hull with a swept wing.",
            },
            {
                sprite: "ship1", tint: "#ff8fb3", px: 8,
                label: "HAMMER", sub: "gunship · slot 2",
                desc: "Heavy chassis with twin forward cannons.",
            },
            {
                sprite: "ship2", tint: "#7bffb0", px: 8,
                label: "WRAITH", sub: "stealth · slot 3",
                desc: "Long fuselage with canards and rear fins.",
            },
            {
                sprite: "ship3", tint: "#ffd166", px: 8,
                label: "CORAL", sub: "rings · slot 4",
                desc: "Round hull with side thruster rings.",
            },
        ],
    },
    {
        title: "ENEMIES",
        items: [
            {
                sprite: "drone0", tint: "#ff5d8f", px: 8,
                label: "DRONE · A", sub: "diamond chassis · 100 pts",
                desc: "Drifts down in a gentle zigzag. One shot kills it.",
            },
            {
                sprite: "drone1", tint: "#ff5d8f", px: 8,
                label: "DRONE · B", sub: "cross chassis · 100 pts",
                desc: "Same threat as A, different chassis.",
            },
            {
                sprite: "speedy0", tint: "#ffd166", px: 9,
                label: "SPEEDY · A", sub: "dart · 150 pts",
                desc: "Falls fast and steers towards you. One shot kills it.",
            },
            {
                sprite: "speedy1", tint: "#ffd166", px: 9,
                label: "SPEEDY · B", sub: "delta · 150 pts",
                desc: "Same threat as A, different chassis.",
            },
            {
                sprite: "tank0", tint: "#9b5de5", px: 6,
                label: "TANK · A", sub: "armoured hex · 300 pts",
                desc: "Slow, with 4 armour. Fires aimed shots.",
            },
            {
                sprite: "tank1", tint: "#9b5de5", px: 6,
                label: "TANK · B", sub: "turreted hex · 300 pts",
                desc: "Same threat as A, different chassis.",
            },
            {
                sprite: "sniper0", tint: "#4de3c1", px: 8,
                label: "SNIPER", sub: "aimed cannon · 400 pts",
                desc: "Stops mid-screen and shoots accurately. It warns you: a sight line appears before it fires.",
            },
            {
                sprite: "kami0", tint: "#ff8f3d", px: 9,
                label: "KAMIKAZE", sub: "unstable core · 350 pts",
                desc: "Chases you, accelerating, and blows up on contact. Dodge it or shoot it down first.",
            },
        ],
    },
    {
        title: "BOSS AND ASTEROIDS",
        items: [
            {
                sprite: "boss0", tint: "#ff4d4d", px: 3,
                label: "DREADNOUGHT", sub: "boss · 5,000 pts",
                desc: "Shows up every 4 waves. Alternates spread fire with aimed bursts. When it dies it drops 3 capsules and gives the whole team a life.",
            },
            {
                sprite: "rock0", tint: "#8a8faf", px: 10,
                label: "ASTEROID · A", sub: "50 pts",
                desc: "Bounces off the side walls. Big ones split in two when broken.",
            },
            {
                sprite: "rock1", tint: "#8a8faf", px: 10,
                label: "ASTEROID · B", sub: "50 pts",
                desc: "Same hazard as A, different silhouette.",
            },
        ],
    },
    {
        title: "POWER-UPS",
        note: "Dropped by downed enemies. Just fly over one to pick it up.",
        items: [
            {
                sprite: "pupT", tint: "#5ee1ff", px: 8,
                label: "TRIPLE SHOT", sub: "capsule T",
                desc: "You start firing a three-way spread.",
            },
            {
                sprite: "pupS", tint: "#7bffb0", px: 8,
                label: "SHIELD", sub: "capsule S",
                desc: "Takes one hit for you before it breaks.",
            },
            {
                sprite: "pupB", tint: "#ffb347", px: 8,
                label: "BOMB", sub: "capsule B",
                desc: "Clears the screen: enemies, asteroids and bullets.",
            },
            {
                sprite: "pupL", tint: "#ff8fb3", px: 8,
                label: "EXTRA LIFE", sub: "capsule +",
                desc: "Adds one life (up to 5).",
            },
        ],
    },
];
