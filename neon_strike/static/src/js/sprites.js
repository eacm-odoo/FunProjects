/** @odoo-module **/
/* Part of Odoo. See LICENSE file for full copyright and licensing details.
 * Neon Strike - banco de sprites pixel art (estilo cyberpunk).
 *
 * Cada sprite es una rejilla de caracteres (1 char = 1 pixel logico). Las rejillas
 * simetricas se escriben a media anchura y se espejan (`mir: true`) para ahorrar
 * datos. Los digitos son indices de paleta:
 *
 *   . transparente   0 blanco caliente   1 casco oscuro   2 casco medio
 *   3 metal          4 TINTE             5 tinte oscuro   6 tinte claro
 *   7 cristal        8 neon acento       9 acento oscuro
 *
 * 4/5/6 se recolorean en tiempo de dibujo con el color de la nave/enemigo, de modo
 * que un mismo sprite sirve para los 4 slots de jugador y para variantes de enemigo.
 * Los sprites se rasterizan una vez a un canvas offscreen y se cachean por
 * (nombre, color, escala, flash).
 */

const BASE = {
    ".": null,
    0: "#ffffff",
    1: "#150c2b",
    2: "#2e1c56",
    3: "#6b7099",
    7: "#cdf6ff",
    8: "#ff2fd0",
    9: "#54104f",
};

/* ------------------------------------------------------------------ */
/* Datos de los sprites                                                */
/* ------------------------------------------------------------------ */

export const SPRITES = {
    /* --- Naves de jugador (16x18) ----------------------------------- */

    // Slot 0 - "Aguja": interceptor afilado, ala en flecha con borde neon.
    ship0: { mir: true, rows: [
        ".......6", "......16", "......16", "......17", ".....117", ".....147",
        "....1147", "....1147", "...81147", "..881447", ".8814447", "88814447",
        ".8114445", "...11445", ".....145", ".....115", "......15", "......9.",
    ] },

    // Slot 1 - "Martillo": cañonera pesada con dos cañones frontales.
    ship1: { mir: true, rows: [
        "..11..11", "..14..17", "..14.117", "..14.147", "..14.147", ".1141447",
        ".1441447", "11441447", "18441447", "18444447", "18444445", ".1444445",
        "..144445", "..114445", "...11445", "...1.155", "....1.15", "......9.",
    ] },

    // Slot 2 - "Espectro": stealth largo, canards y aletas traseras.
    ship2: { mir: true, rows: [
        ".......6", ".......4", "......14", "......17", "......17", ".....114",
        "...81144", "...81144", ".....144", ".....144", "....1144", "...81144",
        "..881444", ".8811444", "88.11445", "....1145", ".....115", "......9.",
    ] },

    // Slot 3 - "Coral": casco redondo con anillos de propulsion laterales.
    ship3: { mir: true, rows: [
        "......11", ".....144", ".....147", "....1147", "...31447", "..831447",
        ".8831447", ".8831447", ".8831444", "..831444", "...31444", "....1445",
        "....1445", "....1145", ".....145", ".....155", "......15", "......9.",
    ] },

    /* --- Enemigos (miran hacia abajo) -------------------------------- */

    drone0: { mir: true, rows: [
        ".....11.", "....1441", "...14441", "..144441", ".1444441", "11447744",
        "11447744", ".1444441", "..144441", "...14441", "....1441", "..8..11.",
        ".8......",
    ] },
    drone1: { mir: true, rows: [
        "8.....1.", ".8...144", "..8.1444", "...11444", "..114444", ".1144774",
        "11444774", ".1144444", "..114444", "...11444", "..8.1444", ".8...144",
        "8.....1.",
    ] },

    speedy0: { mir: true, rows: [
        "....155", "....155", "...1145", "...1144", "8..1144", "88.1144",
        ".881144", "..11447", "...1447", "...1447", "...1444", "....144",
        "....144", ".....14", ".....11", "......1",
    ] },
    speedy1: { mir: true, rows: [
        "....144", "...1144", "..11444", ".811444", "8811447", ".811447",
        "..11444", "...1444", "...1447", "....144", "....144", ".....14",
        ".....11", "......1",
    ] },

    tank0: { mir: true, rows: [
        ".....11111", "...1144441", "..11444444", ".114444442", "1144444442",
        "1442222442", "1442277442", "1442277442", "1442222442", "1144444442",
        ".114444442", "..11444444", "...1144441", "..8..11111", ".8........",
        "8.........",
    ] },
    tank1: { mir: true, rows: [
        "....111111", "..11444441", ".114444442", "1144444442", "3144422442",
        "3144277442", "3144277442", "3144422442", "1144444442", ".114444442",
        "..11444444", "...1144441", "....114441", ".....11111", "..8...9..9",
        ".8........",
    ] },

    // Francotirador: plataforma con cañon largo central.
    sniper0: { mir: true, rows: [
        "....1111", "..114444", ".1144444", "11444444", "14442244", "14422774",
        "14422774", "14442244", "11444444", ".1144444", "..114444", "8..11444",
        "88...144", ".8...114", "......14", "......14", "......17", "......11",
    ] },

    // Kamikaze: casco romboidal con nucleo sobrecargado.
    kami0: { mir: true, rows: [
        "..11445", ".114445", "8114445", "1140045", "1400005", "1400005",
        "1140045", "8114445", ".114445", "..11445", "...1145", "....115",
        ".....11", "......9",
    ] },

    // Jefe: acorazado de 44x24 con nucleo reactor.
    boss0: { mir: true, rows: [
        "...................991",
        "..................9444",
        ".................14444",
        "................144444",
        "..............11222222",
        "............1124444444",
        "..........114224444444",
        "........11444224442222",
        "......1144444224422777",
        ".1..112444444224227770",
        "3311422444444224277000",
        "3344422444444224277000",
        "3344422444444224277000",
        "3344422444444224277000",
        ".144422444444224227770",
        "..11422444444224422777",
        "....112444444224442222",
        "......1144444224444444",
        "........11222222222222",
        "..........114224444444",
        "............1114444444",
        "...............1144444",
        ".................11444",
        "...................111",
    ] },

    /* --- Power-ups (16x16, capsula con glifo) ------------------------ */

    // Triple disparo.
    pupT: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444111114461.",
        ".16444551554461.",
        ".16444441444461.",
        ".15444441444451.",
        ".15444441444451.",
        ".15444441444451.",
        "..154444144451..",
        "...1544454451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    // Escudo.
    pupS: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444411144461.",
        ".16444155514461.",
        ".16444144454461.",
        ".15444511144451.",
        ".15444455514451.",
        ".15444144414451.",
        "..154451115451..",
        "...1544555451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    // Bomba.
    pupB: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444444444461.",
        ".16444144414461.",
        ".16444514154461.",
        ".15444111114451.",
        ".15444515154451.",
        ".15444154514451.",
        "..154454445451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },
    // Vida extra.
    pupL: { rows: [
        "................",
        ".....111111.....",
        "....16006661....",
        "...1640444461...",
        "..164444444461..",
        ".16444441444461.",
        ".16444441444461.",
        ".16444111114461.",
        ".15444111114451.",
        ".15444551554451.",
        ".15444441444451.",
        "..154444544451..",
        "...1544444451...",
        "....15555551....",
        ".....111111.....",
        "................",
    ] },

    /* --- Asteroides (12x12, sin espejo) ------------------------------ */

    rock0: { rows: [
        "...466664...", ".44666666644", "446666666654", "466661666554",
        "466611665554", "466661665554", "446666655554", "446666555554",
        ".4466555554.", ".446555554..", "..44555554..", "....44554...",
    ] },
    rock1: { rows: [
        "..4466664...", ".4666666664.", "446666666654", "466666116654",
        "466661166554", "466666665554", "446666555554", ".46665555554",
        ".44665555554", "..4455555554", "...445555...", "....4554....",
    ] },
};

/* ------------------------------------------------------------------ */
/* Rasterizado + cache                                                 */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
    const A = hexToRgb(a);
    const B = hexToRgb(b);
    return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(
        A[2] + (B[2] - A[2]) * t
    )})`;
}

function expand(def) {
    if (def._grid) {
        return def._grid;
    }
    let grid;
    if (def.mir) {
        const hw = Math.max(...def.rows.map((r) => r.length));
        grid = def.rows.map((r) => {
            const half = r.padStart(hw, ".");
            return half + half.split("").reverse().join("");
        });
    } else {
        grid = def.rows.slice();
    }
    const w = Math.max(...grid.map((r) => r.length));
    def._grid = grid.map((r) => r.padEnd(w, "."));
    return def._grid;
}

export function spriteSize(name) {
    const def = SPRITES[name];
    if (!def) {
        return { w: 0, h: 0 };
    }
    const g = expand(def);
    return { w: g[0].length, h: g.length };
}

const cache = new Map();

/**
 * Devuelve un canvas con el sprite rasterizado.
 * @param {string} name clave en SPRITES
 * @param {string} tint color hex para los indices 4/5/6
 * @param {number} px tamaño del pixel logico
 * @param {boolean} flash pinta la silueta en blanco (impacto)
 * @returns {HTMLCanvasElement|null}
 */
export function sprite(name, tint, px, flash) {
    const key = name + "|" + tint + "|" + px + "|" + (flash ? 1 : 0);
    let cv = cache.get(key);
    if (cv) {
        return cv;
    }
    const def = SPRITES[name];
    if (!def) {
        return null;
    }
    const grid = expand(def);
    const w = grid[0].length;
    const h = grid.length;
    cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(w * px));
    cv.height = Math.max(1, Math.round(h * px));
    const g = cv.getContext("2d");
    const pal = Object.assign({}, BASE, {
        4: tint,
        5: mix(tint, "#0a0418", 0.45),
        6: mix(tint, "#ffffff", 0.55),
    });
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const ch = grid[y][x];
            const col = pal[ch];
            if (!col) {
                continue;
            }
            g.fillStyle = flash ? (ch === "1" || ch === "9" ? "#ffb9f2" : "#ffffff") : col;
            g.fillRect(Math.round(x * px), Math.round(y * px), Math.ceil(px), Math.ceil(px));
        }
    }
    cache.set(key, cv);
    return cv;
}

/**
 * Dibuja un sprite centrado en (x, y) del contexto dado.
 * @param {CanvasRenderingContext2D} g
 * @param {string} name
 * @param {number} x centro
 * @param {number} y centro
 * @param {Object} [o]
 * @param {string} [o.tint="#5ee1ff"]
 * @param {number} [o.px=2] tamaño de pixel
 * @param {boolean} [o.flash]
 * @param {number} [o.rot] rotacion en radianes (asteroides)
 * @param {number} [o.alpha]
 */
export function drawSprite(g, name, x, y, o = {}) {
    const px = o.px || 2;
    const cv = sprite(name, o.tint || "#5ee1ff", px, !!o.flash);
    if (!cv) {
        return;
    }
    g.save();
    if (o.alpha != null) {
        g.globalAlpha = o.alpha;
    }
    g.imageSmoothingEnabled = false;
    if (o.rot) {
        g.translate(x, y);
        g.rotate(o.rot);
        g.drawImage(cv, -cv.width / 2, -cv.height / 2);
    } else {
        g.drawImage(cv, Math.round(x - cv.width / 2), Math.round(y - cv.height / 2));
    }
    g.restore();
}

/** Tamaño de pixel para que un sprite ocupe `target` px de ancho logico. */
export function pxFor(name, target) {
    const s = spriteSize(name);
    return s.w ? Math.max(1, Math.round((target / s.w) * 2) / 2) : 2;
}
