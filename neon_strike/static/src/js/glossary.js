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
 * The boss and colossal boss groups are generated from `bosses.js` and
 * `colossi.js` so their names and behaviour lines never drift from the ones
 * the engine uses.
 *
 * An item that carries `practice` can be fought on its own: the card grows a
 * button and the engine is started with that descriptor (see `practice` in
 * `game_engine.js`). This catalogue is the only place the list of practisable
 * targets exists -- the backend *Practice* menu just opens the picker, so
 * nothing about the roster has to be repeated in Python.
 */

import { BOSSES } from "./bosses";
import { COLOSSI } from "./colossi";
import { SHIPS } from "./ships";

export const GLOSSARY = [
    {
        title: "PLAYER SHIPS",
        note: "Pick yours in the menu. They change the look and colour, not the stats: they all fly and shoot the same.",
        // Straight from the same catalogue the picker and the engine read.
        items: SHIPS.map((s) => ({
            sprite: s.sprite, tint: s.tint, px: 8,
            label: s.label, sub: s.sub, desc: s.desc,
        })),
    },
    {
        title: "ENEMIES",
        note: "Enemy fire is colour coded, and the colour tells you what to do about it. Pink is a spread that was not aimed at anybody: read the gaps. Amber was fired at where you were: keep moving sideways. Cyan is fast and precise, it is already where it is going. Violet is a slow heavy curtain: find the hole, you cannot outrun it.",
        items: [
            {
                sprite: "drone0", tint: "#ff5d8f", px: 8,
                label: "DRONE · A", sub: "diamond chassis · 100 pts",
                practice: { type: "drone", v: 0 },
                desc: "Drifts down in a gentle zigzag, leaning into it. One shot kills it early on; it grows a point of hull every 9 waves, and you can read how many it has left off the hull itself: the brighter the core, the more it is going to take. The lamps on one side light up just before it turns that way.",
            },
            {
                sprite: "drone1", tint: "#ff5d8f", px: 8,
                label: "DRONE · B", sub: "cross chassis · 100 pts",
                practice: { type: "drone", v: 1 },
                desc: "Same threat as A, different chassis. It reads the same way: brighter core, more hull left.",
            },
            {
                sprite: "speedy0", tint: "#ffd166", px: 9,
                label: "SPEEDY · A", sub: "dart · 150 pts",
                practice: { type: "speedy", v: 0 },
                desc: "Falls fast and steers towards you. One shot kills it early on; it grows a point of hull every 10 waves.",
            },
            {
                sprite: "speedy1", tint: "#ffd166", px: 9,
                label: "SPEEDY · B", sub: "delta · 150 pts",
                practice: { type: "speedy", v: 1 },
                desc: "Same threat as A, different chassis.",
            },
            {
                sprite: "tank0", tint: "#9b5de5", px: 6,
                label: "TANK · A", sub: "armoured hex · 300 pts",
                practice: { type: "tank", v: 0 },
                desc: "Slow, with 4 armour and a point more every 5 waves. Its aimed shot is telegraphed: a line points at you first.",
            },
            {
                sprite: "tank1", tint: "#9b5de5", px: 6,
                label: "TANK · B", sub: "turreted hex · 300 pts",
                practice: { type: "tank", v: 1 },
                desc: "Same threat as A, different chassis.",
            },
            {
                sprite: "sniper0", tint: "#4de3c1", px: 8,
                label: "SNIPER", sub: "aimed cannon · 400 pts",
                practice: { type: "sniper", v: 0 },
                desc: "Stops mid-screen and shoots accurately. It warns you for a good three quarters of a second: a dashed sight line settles on you before it fires.",
            },
            {
                sprite: "kami0", tint: "#ff8f3d", px: 9,
                label: "KAMIKAZE", sub: "unstable core · 350 pts",
                practice: { type: "kami", v: 0 },
                desc: "Chases you, accelerating, and blows up on contact. Dodge it or shoot it down first; it toughens up every 8 waves.",
            },
        ],
    },
    {
        title: "BOSSES",
        note: "One every 4 waves, rotating through the five so the boss wave is never the same fight. Any of them drops 3 capsules and gives the whole team a life when it dies. On waves that are a multiple of 10 a colossal boss takes over instead.",
        items: BOSSES.map((b) => ({
            sprite: b.sprite,
            tint: b.tint,
            px: 3,
            label: b.name,
            sub: "boss · " + (5000 * b.val).toLocaleString("en-US") + " pts",
            desc: b.desc,
            practice: { boss: BOSSES.indexOf(b) },
        })),
    },
    {
        title: "ASTEROIDS",
        items: [
            {
                sprite: "rock0", tint: "#8a8faf", px: 10,
                label: "ASTEROID · A", sub: "50 pts",
                practice: { rock: 0 },
                desc: "Bounces off the side walls. Big ones split in two when broken.",
            },
            {
                sprite: "rock1", tint: "#8a8faf", px: 10,
                label: "ASTEROID · B", sub: "50 pts",
                practice: { rock: 1 },
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
            practice: { colossus: COLOSSI.indexOf(c) },
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
                desc: "Adds one bomb to your stock (up to 3). Press X to spend one: it clears enemies, asteroids and bullets and leaves you invulnerable for a moment. Bombed kills pay half and build no combo.",
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
