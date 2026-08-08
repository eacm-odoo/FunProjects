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
 *
 * The colossal boss group is generated from `colossi.js` so their names and
 * behaviour lines never drift from the ones the engine uses.
 */

import { COLOSSI } from "./colossi";

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
        title: "COLOSSAL BOSSES",
        note: "One every 10 waves. They are wider than the arena itself: while one is alive the camera pulls back, the arena shrinks into the middle of the screen and your ship looks tiny. The purple frame marks how far you can still fly.",
        items: COLOSSI.map((c) => ({
            sprite: c.sprite,
            tint: c.tint,
            px: 1.5,
            label: c.name,
            sub: c.title.toLowerCase() + " · wave " + (COLOSSI.indexOf(c) + 1) * 10,
            desc: c.desc,
        })),
    },
    {
        title: "POWER-UPS",
        note: "Dropped by downed enemies, and on a timer plus every 25% of a boss's health while one is up. Just fly over one to pick it up. The timed ones show as letters next to your lives and refresh instead of stacking.",
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
            {
                sprite: "pupR", tint: "#ffd166", px: 8,
                label: "RAPID FIRE", sub: "capsule R · 10 s",
                desc: "Your cannons cycle 40% faster.",
            },
            {
                sprite: "pupV", tint: "#ff8f3d", px: 8,
                label: "OVERCHARGE", sub: "capsule V · 10 s",
                desc: "+1 damage on every bullet you fire.",
            },
            {
                sprite: "pupP", tint: "#c9a4ff", px: 8,
                label: "PIERCING", sub: "capsule P · 9 s",
                desc: "Bullets go through two extra enemies.",
            },
            {
                sprite: "pupH", tint: "#4de3c1", px: 8,
                label: "HOMING", sub: "capsule H · 10 s",
                desc: "Bullets steer towards the closest hull.",
            },
            {
                sprite: "pupD", tint: "#8be9ff", px: 8,
                label: "WINGMAN", sub: "capsule D · 15 s",
                desc: "An escort drone orbits you and fires on its own.",
            },
            {
                sprite: "pupG", tint: "#e2e0ff", px: 8,
                label: "PHASE SHIFT", sub: "capsule G · 4 s",
                desc: "Four seconds where nothing can touch you.",
            },
            {
                sprite: "pupF", tint: "#8bd0ff", px: 8,
                label: "FREEZE", sub: "capsule F · instant",
                desc: "Pins every enemy bullet on screen for 3 s.",
            },
            {
                sprite: "pupX", tint: "#ffe066", px: 8,
                label: "OVERLOAD", sub: "capsule X · instant",
                desc: "Stuns every enemy for 2.5 s; bosses just take the hit.",
            },
            {
                sprite: "pupC", tint: "#ff6fa5", px: 8,
                label: "COMBO SURGE", sub: "capsule C · instant",
                desc: "Adds 6 to the team combo and refills its timer.",
            },
            {
                sprite: "pupY", tint: "#ffcc33", px: 8,
                label: "PAYDAY", sub: "capsule Y · instant",
                desc: "Cash bonus scaled by the wave and your combo.",
            },
        ],
    },
];
