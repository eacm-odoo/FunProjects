/**
 * How sharp the headset draws the scene.
 *
 * three.js starts every session at the browser's recommended resolution and
 * with the strongest fixed foveation (the edges of the view drawn at a lower
 * resolution), which shows on the Quest as pixelated text. The scene is light
 * (a teacher and a dozen nodes over the passthrough view), so it can afford
 * more pixels and less foveation.
 *
 * URL options, to tune it on the device without a new build:
 *   ?xrscale=1.2    resolution against the recommended one, from 0.5 to 2
 *   ?foveation=0.5  from 0 (the edges at full resolution) to 1 (the lowest)
 */

export const XR_SCALE = 1.4;
export const XR_FOVEATION = 0.2;
const SCALE_RANGE = [0.5, 2];

function numberIn(raw, [min, max], fallback) {
    const value = raw === null || raw.trim() === "" ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** @returns {{scale: number, foveation: number}} from the page's query string */
export function xrQuality(search = "") {
    const params = new URLSearchParams(search);
    return {
        scale: numberIn(params.get("xrscale"), SCALE_RANGE, XR_SCALE),
        foveation: numberIn(params.get("foveation"), [0, 1], XR_FOVEATION),
    };
}
