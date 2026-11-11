/**
 * Where and how the lesson goes when the user points at a surface.
 *
 * The diagram alone can also be carried (by the bar under it) and let go
 * near a table, where it stands on it, or near a wall, where it hangs flat
 * against it (surfaceKind, boardPlacement).
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

/** Sine of the steepest tilt for a wall (about 20 degrees off vertical). */
export const MAX_WALL_UP = 0.35;
/** A board hanging on a wall stands this far off it, so nothing sinks into the wall. */
export const WALL_GAP = 0.03;

/**
 * What a surface is good for, for the diagram let go near it.
 * @param {number} normalY vertical component of the surface normal
 * @param {number} height meters above the floor
 * @returns {"table"|"wall"|null} the floor and slopes take nothing
 */
export function surfaceKind(normalY, height) {
    if (isPlaceable(normalY)) {
        return height >= DESK_MIN_HEIGHT ? "table" : null;
    }
    return Math.abs(normalY) <= MAX_WALL_UP ? "wall" : null;
}

/**
 * Where the board goes on a surface.
 * @param {object} options
 * @param {"table"|"wall"} options.kind
 * @param {{x: number, y: number, z: number}} options.point the surface point
 * @param {{x: number, y: number, z: number}} options.normal the surface normal
 * @param {{x: number, y: number, z: number}} options.viewer the user's head
 * @param {number} [options.lift] on a table, from the board's origin down to its bottom (meters)
 * @returns {{position: {x: number, y: number, z: number}, yaw: number}} yaw turns the board's front (+Z)
 */
export function boardPlacement({ kind, point, normal, viewer, lift = 0 }) {
    if (kind === "wall") {
        // Flat against the wall, its front facing out of it.
        const length = Math.hypot(normal.x, normal.z) || 1;
        const nx = normal.x / length;
        const nz = normal.z / length;
        return {
            position: { x: point.x + nx * WALL_GAP, y: point.y, z: point.z + nz * WALL_GAP },
            yaw: Math.atan2(nx, nz),
        };
    }
    // Standing on the table, facing the user.
    return {
        position: { x: point.x, y: point.y + lift, z: point.z },
        yaw: Math.atan2(viewer.x - point.x, viewer.z - point.z),
    };
}
