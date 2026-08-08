/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - permanent perk catalogue (run upgrades).
 *
 * Data only: the engine reads it, nothing here touches the DOM or Odoo, so the
 * file also loads as native ESM outside Odoo (design sprite gallery).
 *
 * Every 5 cleared waves each ship is offered 3 perks and keeps 1 for the rest
 * of the run (they are wiped on `reset()`). A perk is described with:
 *   - `kind`     "passive" (always on) | "conditional" (situational bonus)
 *                | "active" (triggered with the 1..4 keys, has a cooldown)
 *   - `mods`     numeric modifiers summed into `ship.mods` (see MOD_KEYS)
 *   - `flags`    behaviour switches the engine branches on (`ship.flags`)
 *   - `cd`       cooldown in frames (actives only)
 *   - `req`      "coop" -> only offered in multiplayer
 *
 * Adding a perk = one entry here + (if it carries a flag) the branch in
 * `game_engine.js`. The order of this array is the wire format: the snapshot
 * sends perk INDEXES, so append at the end, never insert in the middle.
 */

// Modifier keys and how the engine reads them. All of them are summed across
// the perks a ship owns, so they start at 0 and stack additively.
export const MOD_KEYS = {
    fireRate: "delta on the fire delay (negative = faster)",
    dmg: "flat damage added to each bullet",
    bulletSpeed: "delta on the bullet speed multiplier",
    side: "extra side bullets per volley",
    pierce: "extra enemies a bullet goes through",
    crit: "critical chance 0..1",
    critMul: "extra critical multiplier (base x2)",
    moveSpeed: "delta on the ship follow speed",
    hitbox: "delta on the collision radius (negative = smaller)",
    lives: "extra lives granted when picked",
    maxLives: "delta on the life cap",
    inv: "delta on the invulnerability window after a hit",
    magnet: "capsule attraction radius in logical px",
    luck: "extra capsule drop chance",
    scoreMul: "delta on the score multiplier",
    dashCd: "delta on the dash cooldown",
    dashCharges: "extra dash charges",
};

const CYAN = "#5ee1ff";
const GREEN = "#7bffb0";
const GOLD = "#ffd166";
const VIOLET = "#c9a4ff";
const PINK = "#ff8fb3";
const ORANGE = "#ffb347";

export const PERKS = [
    /* ---------------------------------------------------------------- */
    /* Weapons (passive)                                                 */
    /* ---------------------------------------------------------------- */
    {
        id: "overclock",
        name: "Overclock",
        kind: "passive",
        tag: "Weapon",
        tint: CYAN,
        desc: "Your cannons cycle 20% faster.",
        mods: { fireRate: -0.2 },
    },
    {
        id: "twin_barrel",
        name: "Twin Barrel",
        kind: "passive",
        tag: "Weapon",
        tint: CYAN,
        desc: "One extra bullet per volley, angled outwards.",
        mods: { side: 1 },
    },
    {
        id: "scatter_pods",
        name: "Scatter Pods",
        kind: "passive",
        tag: "Weapon",
        tint: CYAN,
        desc: "Two extra bullets per volley, but each one hits for less.",
        mods: { side: 2, dmg: -0.34 },
    },
    {
        id: "heavy_slugs",
        name: "Heavy Slugs",
        kind: "passive",
        tag: "Weapon",
        tint: CYAN,
        desc: "+1 damage per bullet, 15% slower fire rate.",
        mods: { dmg: 1, fireRate: 0.15 },
    },
    {
        id: "piercing_rounds",
        name: "Piercing Rounds",
        kind: "passive",
        tag: "Weapon",
        tint: CYAN,
        desc: "Bullets go through one extra enemy before dying.",
        mods: { pierce: 1 },
    },
    {
        id: "homing_chips",
        name: "Homing Chips",
        kind: "passive",
        tag: "Weapon",
        tint: CYAN,
        desc: "Bullets steer towards the closest enemy.",
        flags: ["homing"],
    },
    {
        id: "ricochet_rounds",
        name: "Ricochet Rounds",
        kind: "passive",
        tag: "Weapon",
        tint: CYAN,
        desc: "Bullets bounce off the side walls instead of leaving the field.",
        flags: ["ricochet"],
    },
    {
        id: "explosive_tips",
        name: "Explosive Tips",
        kind: "passive",
        tag: "Weapon",
        tint: CYAN,
        desc: "Every impact detonates and splashes damage around it.",
        flags: ["explosive"],
    },
    {
        id: "arc_capacitor",
        name: "Arc Capacitor",
        kind: "passive",
        tag: "Weapon",
        tint: CYAN,
        desc: "Hits arc a lightning bolt to a second nearby enemy.",
        flags: ["chain"],
    },
    {
        id: "critical_array",
        name: "Critical Array",
        kind: "passive",
        tag: "Weapon",
        tint: CYAN,
        desc: "22% of your bullets crit for triple damage.",
        mods: { crit: 0.22, critMul: 1 },
    },
    {
        id: "broadside",
        name: "Broadside",
        kind: "passive",
        tag: "Weapon",
        tint: CYAN,
        desc: "Every other volley also fires sideways and backwards.",
        flags: ["broadside"],
    },

    /* ---------------------------------------------------------------- */
    /* Hull and support (passive)                                        */
    /* ---------------------------------------------------------------- */
    {
        id: "drone_wing",
        name: "Drone Wing",
        kind: "passive",
        tag: "Support",
        tint: GREEN,
        desc: "A friendly drone orbits your hull and fires on its own.",
        flags: ["drone"],
    },
    {
        id: "nano_weave",
        name: "Nano Weave",
        kind: "passive",
        tag: "Hull",
        tint: GREEN,
        desc: "Rebuilds your shield 12 s after losing it.",
        flags: ["shield_regen"],
    },
    {
        id: "reinforced_hull",
        name: "Reinforced Hull",
        kind: "passive",
        tag: "Hull",
        tint: GREEN,
        desc: "+1 life now and a life cap raised by 2.",
        mods: { lives: 1, maxLives: 2 },
    },
    {
        id: "compact_frame",
        name: "Compact Frame",
        kind: "passive",
        tag: "Hull",
        tint: GREEN,
        desc: "Your hitbox shrinks by 35%.",
        mods: { hitbox: -0.35 },
    },
    {
        id: "phase_engine",
        name: "Phase Engine",
        kind: "passive",
        tag: "Hull",
        tint: GREEN,
        desc: "You stay invulnerable 80% longer after taking a hit.",
        mods: { inv: 0.8 },
    },
    {
        id: "phoenix_core",
        name: "Phoenix Core",
        kind: "passive",
        tag: "Hull",
        tint: GREEN,
        desc: "Once per run, a lethal hit leaves you at 1 life with a shield.",
        flags: ["phoenix"],
    },
    {
        id: "asteroid_eater",
        name: "Asteroid Eater",
        kind: "passive",
        tag: "Hull",
        tint: GREEN,
        desc: "Asteroids shatter against your hull without hurting you.",
        flags: ["rock_eater"],
    },

    /* ---------------------------------------------------------------- */
    /* Utility (passive)                                                 */
    /* ---------------------------------------------------------------- */
    {
        id: "tractor_beam",
        name: "Tractor Beam",
        kind: "passive",
        tag: "Utility",
        tint: GOLD,
        desc: "Capsules are pulled towards you from far away.",
        mods: { magnet: 130 },
    },
    {
        id: "lucky_charm",
        name: "Lucky Charm",
        kind: "passive",
        tag: "Utility",
        tint: GOLD,
        desc: "Enemies drop capsules far more often.",
        mods: { luck: 0.18 },
    },
    {
        id: "combo_lock",
        name: "Combo Lock",
        kind: "passive",
        tag: "Utility",
        tint: GOLD,
        desc: "Taking a hit no longer resets the team combo.",
        flags: ["combo_keep"],
    },
    {
        id: "sponsor_deal",
        name: "Sponsor Deal",
        kind: "passive",
        tag: "Utility",
        tint: GOLD,
        desc: "Everything you destroy is worth 25% more points.",
        mods: { scoreMul: 0.25 },
    },
    {
        id: "afterburner",
        name: "Afterburner",
        kind: "passive",
        tag: "Utility",
        tint: GOLD,
        desc: "Your ship follows the cursor 35% faster.",
        mods: { moveSpeed: 0.35 },
    },
    {
        id: "field_medic",
        name: "Field Medic",
        kind: "passive",
        tag: "Utility",
        tint: GOLD,
        desc: "You revive downed allies three times faster.",
        flags: ["medic"],
        req: "coop",
    },

    /* ---------------------------------------------------------------- */
    /* Dash (passive) - the dash itself is free, on the Space key         */
    /* ---------------------------------------------------------------- */
    {
        id: "phase_dash",
        name: "Phase Dash",
        kind: "passive",
        tag: "Dash",
        tint: VIOLET,
        desc: "Dash cooldown cut by 40%.",
        mods: { dashCd: -0.4 },
    },
    {
        id: "twin_thrusters",
        name: "Twin Thrusters",
        kind: "passive",
        tag: "Dash",
        tint: VIOLET,
        desc: "One extra dash charge in the tank.",
        mods: { dashCharges: 1 },
    },
    {
        id: "plasma_wake",
        name: "Plasma Wake",
        kind: "passive",
        tag: "Dash",
        tint: VIOLET,
        desc: "Your dash leaves a burning trail that melts enemies.",
        flags: ["dash_trail"],
    },
    {
        id: "ram_prow",
        name: "Ram Prow",
        kind: "passive",
        tag: "Dash",
        tint: VIOLET,
        desc: "Dashing through an enemy rips it apart.",
        flags: ["dash_ram"],
    },
    {
        id: "deflector_dash",
        name: "Deflector Dash",
        kind: "passive",
        tag: "Dash",
        tint: VIOLET,
        desc: "Enemy bullets caught in your dash are turned against them.",
        flags: ["dash_reflect"],
    },
    {
        id: "kinetic_recharge",
        name: "Kinetic Recharge",
        kind: "passive",
        tag: "Dash",
        tint: VIOLET,
        desc: "Every kill during a dash gives the charge back.",
        flags: ["dash_refund"],
    },

    /* ---------------------------------------------------------------- */
    /* Conditional                                                       */
    /* ---------------------------------------------------------------- */
    {
        id: "berserker",
        name: "Berserker",
        kind: "conditional",
        tag: "On low life",
        tint: PINK,
        desc: "On your last life: +50% fire rate and +1 damage.",
        flags: ["berserker"],
    },
    {
        id: "desperation",
        name: "Desperation",
        kind: "conditional",
        tag: "Without shield",
        tint: PINK,
        desc: "While you carry no shield, bullets hit for +0.75 damage.",
        flags: ["desperation"],
    },
    {
        id: "point_blank",
        name: "Point Blank",
        kind: "conditional",
        tag: "Up close",
        tint: PINK,
        desc: "+2 damage against anything within 90 px of your hull.",
        flags: ["point_blank"],
    },
    {
        id: "long_shot",
        name: "Long Shot",
        kind: "conditional",
        tag: "At range",
        tint: PINK,
        desc: "+1.5 damage against enemies still in the upper third.",
        flags: ["long_shot"],
    },
    {
        id: "last_stand",
        name: "Last Stand",
        kind: "conditional",
        tag: "Once per wave",
        tint: PINK,
        desc: "Once per wave a lethal hit is cancelled and leaves you intangible.",
        flags: ["last_stand"],
    },
    {
        id: "adrenaline",
        name: "Adrenaline",
        kind: "conditional",
        tag: "After a hit",
        tint: PINK,
        desc: "For 4 s after being hit: +40% fire rate and +40% speed.",
        flags: ["adrenaline"],
    },
    {
        id: "combo_surge",
        name: "Combo Surge",
        kind: "conditional",
        tag: "On combo",
        tint: PINK,
        desc: "Combo x10: +25% fire rate. Combo x20: +1 damage on top.",
        flags: ["combo_surge"],
    },
    {
        id: "boss_hunter",
        name: "Boss Hunter",
        kind: "conditional",
        tag: "Vs boss",
        tint: PINK,
        desc: "Your bullets deal double damage to bosses.",
        flags: ["boss_hunter"],
    },
    {
        id: "swarm_cleaver",
        name: "Swarm Cleaver",
        kind: "conditional",
        tag: "Vs swarm",
        tint: PINK,
        desc: "+1.5 damage against drones and interceptors.",
        flags: ["swarm_cleaver"],
    },
    {
        id: "guardian_link",
        name: "Guardian Link",
        kind: "conditional",
        tag: "Ally down",
        tint: PINK,
        desc: "While an ally is down: +35% fire rate and +1 damage.",
        flags: ["guardian_link"],
        req: "coop",
    },

    /* ---------------------------------------------------------------- */
    /* Active - bound to keys 1..4 in pick order                          */
    /* ---------------------------------------------------------------- */
    {
        id: "nova_burst",
        name: "Nova Burst",
        kind: "active",
        tag: "Active",
        tint: ORANGE,
        desc: "Fires a 24-bullet ring in every direction.",
        flags: ["nova_burst"],
        cd: 420,
    },
    {
        id: "stasis_field",
        name: "Stasis Field",
        kind: "active",
        tag: "Active",
        tint: ORANGE,
        desc: "Freezes every enemy bullet on screen for 3 s.",
        flags: ["stasis_field"],
        cd: 900,
    },
    {
        id: "emp_pulse",
        name: "EMP Pulse",
        kind: "active",
        tag: "Active",
        tint: ORANGE,
        desc: "Wipes nearby bullets and stuns the enemies caught in the blast.",
        flags: ["emp_pulse"],
        cd: 600,
    },
    {
        id: "overdrive",
        name: "Overdrive",
        kind: "active",
        tag: "Active",
        tint: ORANGE,
        desc: "5 s of triple fire rate.",
        flags: ["overdrive"],
        cd: 900,
    },
    {
        id: "bulwark",
        name: "Bulwark",
        kind: "active",
        tag: "Active",
        tint: ORANGE,
        desc: "Instant shield plus 4 s of invulnerability.",
        flags: ["bulwark"],
        cd: 780,
    },
    {
        id: "orbital_strike",
        name: "Orbital Strike",
        kind: "active",
        tag: "Active",
        tint: ORANGE,
        desc: "Six homing explosive missiles rain down from orbit.",
        flags: ["orbital_strike"],
        cd: 660,
    },
    {
        id: "black_hole",
        name: "Black Hole",
        kind: "active",
        tag: "Active",
        tint: ORANGE,
        desc: "Drops a singularity that drags in and grinds down everything.",
        flags: ["black_hole"],
        cd: 1080,
    },
    {
        id: "time_warp",
        name: "Time Warp",
        kind: "active",
        tag: "Active",
        tint: ORANGE,
        desc: "Slows enemies and their bullets to 40% for 4 s. You keep your speed.",
        flags: ["time_warp"],
        cd: 1200,
    },
    {
        id: "turret_drop",
        name: "Turret Drop",
        kind: "active",
        tag: "Active",
        tint: ORANGE,
        desc: "Deploys an automatic turret that holds the position for 10 s.",
        flags: ["turret_drop"],
        cd: 720,
    },
    {
        id: "decoy_beacon",
        name: "Decoy Beacon",
        kind: "active",
        tag: "Active",
        tint: ORANGE,
        desc: "A holographic decoy pulls enemy fire for 6 s.",
        flags: ["decoy_beacon"],
        cd: 840,
    },
];

/** Perk index by id, so the engine can serialise picks as small integers. */
export const PERK_INDEX = PERKS.reduce((acc, p, i) => {
    acc[p.id] = i;
    return acc;
}, {});

/** Maximum number of actives a ship can hold (keys 1..4). */
export const MAX_ACTIVES = 4;

/**
 * Roll `n` distinct offers for a ship.
 *
 * @param {Object} ship - engine ship (reads `perks` and its active count)
 * @param {Object} ctx - {players, rng}
 * @param {number} [n=3]
 * @returns {number[]} perk indexes
 */
export function rollOffers(ship, ctx, n = 3) {
    const owned = new Set(ship.perks || []);
    const actives = (ship.perks || []).filter((id) => PERKS[PERK_INDEX[id]].kind === "active").length;
    const rng = (ctx && ctx.rng) || Math.random;
    const pool = [];
    PERKS.forEach((p, i) => {
        if (owned.has(p.id)) {
            return;
        }
        if (p.req === "coop" && (!ctx || ctx.players < 2)) {
            return;
        }
        if (p.kind === "active" && actives >= MAX_ACTIVES) {
            return;
        }
        pool.push(i);
    });
    const out = [];
    for (let k = 0; k < n && pool.length; k++) {
        out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    }
    return out;
}
