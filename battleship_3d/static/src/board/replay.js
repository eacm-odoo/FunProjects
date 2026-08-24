/** @odoo-module **/

/**
 * A finished game, wound back to the first shell and played forward.
 *
 * The board already knows how to draw a `read_state` payload — the three.js
 * table, the fleet plates, the radio log, every one of them reads the same
 * object — so a replay is not a second way of drawing anything. It is a
 * sequence of payloads: one per shell, each the state the game was in at that
 * moment, handed to exactly the code that draws the live one.
 *
 * That is why the server sends only the shots (`read_replay`). Everything else
 * comes off the payload of the finished game the player is looking at: the
 * fleets are where they were laid, positions never move, and a game that is
 * over reveals all of them. Winding back is only a matter of taking the hits
 * off the hulls and the markers off the water.
 *
 * Nothing here imports from Odoo, and nothing here is a rule: the results are
 * the server's word, taken as they come. All this file does is count.
 */

/** Playback speeds offered on the bar, as multipliers of `REPLAY_STEP`. */
export const REPLAY_SPEEDS = [1, 2, 4];
/** Time one shell gets at 1x. A game runs to a few hundred of them. */
export const REPLAY_STEP = 620;
/**
 * Below this many milliseconds a shell, the sound kit stops being a sound kit:
 * four splashes inside half a second arrive as one smear. The fast speeds are
 * watched, not listened to.
 */
export const REPLAY_SOUND_FLOOR = 260;
/** As deep as the log the server ships, so the bridge reads the same either way. */
const LOG_ROWS = 60;

export class ReplayTape {
    /**
     * @param {object} state payload of the finished game, as the board holds it
     * @param {object[]} shots every shell of it, oldest first, from `read_replay`
     */
    constructor(state, shots) {
        this.shots = shots || [];
        this.frames = this._build(state);
    }

    /** How many shells there are to play. Frame 0 is the board before them. */
    get length() {
        return this.shots.length;
    }

    /** The state the game was in once `index` shells had been fired. */
    frameAt(index) {
        return this.frames[Math.max(0, Math.min(index, this.length))];
    }

    /** The shell that produced `frameAt(index)`, or null for the opening board. */
    shotAt(index) {
        return index > 0 ? this.shots[index - 1] : null;
    }

    /**
     * Every frame, walked forward from an empty sea.
     *
     * The frames share whatever a shell did not touch: one shell lands on one
     * board, so the other three fleets, their markers and their seats are the
     * same objects the frame before was holding. Copy-on-write rather than a
     * deep copy per shell — a four-way runs to several hundred of them, and
     * nothing downstream ever writes to a frame.
     */
    _build(state) {
        const sides = (state.seats || []).map((seat) => seat.side);
        // Where the hulls were laid, with everything that happened to them
        // taken back off: same cells, no hits, nothing sunk.
        const fleets = {};
        const shots = {};
        const hits = {};
        for (const side of sides) {
            fleets[side] = (state["fleet_" + side] || []).map((ship) => ({
                ...ship, hits: 0, sunk: false,
            }));
            shots[side] = [];
            hits[side] = [];
        }
        let seats = (state.seats || []).map((seat) => ({ ...seat, out: false }));
        let tally = Object.fromEntries(sides.map((side) => [side, { shots: 0, hits: 0 }]));
        let log = [];

        const frames = [this._frame(state, sides, { fleets, shots, hits, seats, tally, log })];
        for (const shot of this.shots) {
            const { target, shooter, cell } = shot;
            if (!sides.includes(target)) {
                // A log line about a board this payload does not have. It
                // cannot be drawn, and skipping it keeps the count honest:
                // the frame is still pushed, so the bar does not lose a step.
                frames.push(frames[frames.length - 1]);
                continue;
            }
            shots[target] = [...shots[target], cell];
            // Which hull took it is read off the cells, which are the same
            // ones the server laid; whether that counted as a hit is the
            // server's own word, carried by the shot.
            const struck = fleets[target].find((ship) => ship.cells.includes(cell));
            if (struck) {
                hits[target] = [...hits[target], cell];
                const wounded = { ...struck, hits: struck.hits + 1 };
                wounded.sunk = wounded.hits >= wounded.size;
                fleets[target] = fleets[target].map((ship) => (ship === struck ? wounded : ship));
                if (wounded.sunk && fleets[target].every((ship) => ship.sunk)) {
                    seats = seats.map((seat) =>
                        seat.side === target ? { ...seat, out: true } : seat
                    );
                }
            }
            if (tally[shooter]) {
                tally = {
                    ...tally,
                    [shooter]: {
                        shots: tally[shooter].shots + 1,
                        hits: tally[shooter].hits + (shot.result !== "miss" ? 1 : 0),
                    },
                };
            }
            log = [
                {
                    shooter,
                    target,
                    coord: shot.coord,
                    result: shot.result,
                    ship_name: shot.ship_name,
                },
                ...log,
            ].slice(0, LOG_ROWS);
            frames.push(this._frame(state, sides, { fleets, shots, hits, seats, tally, log }));
        }
        return frames;
    }

    /**
     * One payload, shaped exactly like the live one.
     *
     * The finished state is the floor it is built on, so everything a replay
     * has no opinion about — the mode, the seats' names, the commander's file,
     * the room code — is whatever the board already had. `state` stays `done`
     * for the same reason: a replay is a game being looked back at, not one
     * being played, and a board that claimed to be in a battle would light a
     * turn nobody is taking and dim the grids of a sweep nobody is firing.
     */
    _frame(state, sides, { fleets, shots, hits, seats, tally, log }) {
        const frame = { ...state, seats, tally, log };
        for (const side of sides) {
            frame["fleet_" + side] = fleets[side];
            frame["shots_" + side] = shots[side];
            frame["hits_" + side] = hits[side];
        }
        return frame;
    }
}
