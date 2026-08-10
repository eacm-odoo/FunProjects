/** @odoo-module **/
import { rpc } from "@web/core/network/rpc";

/**
 * Every server call the board makes.
 *
 * These go through the module's own routes instead of `call_kw` because the
 * board runs in two places: the backend client action, and the public
 * `/battleship` page where the visitor has no account and therefore no access
 * rights on `battleship.game`. The controller is what decides who owns a game
 * (the logged in user, or the session token of an anonymous player), so the
 * client never has to know which of the two cases it is in.
 */
export const api = {
    state: (gameId) => rpc("/battleship/state", { game_id: gameId }),
    newGame: (mode) => rpc("/battleship/new", { mode }),
    placeShip: (gameId, side, index, cell, direction) =>
        rpc("/battleship/place", { game_id: gameId, side, index, cell, direction }),
    randomFleet: (gameId, side) => rpc("/battleship/random", { game_id: gameId, side }),
    ready: (gameId) => rpc("/battleship/ready", { game_id: gameId }),
    fire: (gameId, cell) => rpc("/battleship/fire", { game_id: gameId, cell }),
};
