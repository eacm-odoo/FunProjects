/**
 * Where and how the lesson goes when the user points at a surface.
 *
 * Heights come from a local-floor space, so y is meters above the floor:
 * anything from DESK_MIN_HEIGHT up is furniture (a desk, a coffee table, a
 * shelf) and gets the small desk layout; a rug or a step stays "floor". Only
 * surfaces that face up count: a wall or a tilted cushion is no place to
 * stand on.
 */

export const DESK_MIN_HEIGHT = 0.3;
/** Cosine of the steepest tilt accepted (about 35 degrees). */
export const MIN_SURFACE_UP = 0.82;

/** @param {number} normalY vertical component of the surface normal */
export function isPlaceable(normalY) {
    return normalY >= MIN_SURFACE_UP;
}

/**
 * @param {{x: number, y: number, z: number}} hit surface point the user picked
 * @param {{x: number, y: number, z: number}} viewer the user's head
 * @returns {{position: {x: number, y: number, z: number}, yaw: number, layout: "floor"|"desk"}}
 *   yaw turns the lesson (which faces +Z at rest) toward the viewer
 */
export function placementFor(hit, viewer) {
    return {
        position: { x: hit.x, y: hit.y, z: hit.z },
        yaw: Math.atan2(viewer.x - hit.x, viewer.z - hit.z),
        layout: hit.y >= DESK_MIN_HEIGHT ? "desk" : "floor",
    };
}
