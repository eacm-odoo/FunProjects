/** @odoo-module **/
import { rpc } from "@web/core/network/rpc";

/**
 * Every server call the board makes.
 *
 * These go through the module's own routes instead of `call_kw` because the
 * board runs in two places: the backend client action, and the public
 * `/battleship` page where the visitor has no account and therefore no access
 * rights on `battleship.game`. The controller is what decides who owns a game
 * (the logged in user, the session token of an anonymous player, or a seat in
 * an online room), so the client never has to know which of the cases it is in.
 *
 * Nothing here sends an identity: the seat a player holds online is read from
 * their session on the server, which is why no route takes a side.
 */
export const api = {
    state: (gameId) => rpc("/battleship/state", { game_id: gameId }),
    newGame: (mode, difficulty) => rpc("/battleship/new", { mode, difficulty }),
    // Every shell of a finished game, oldest first. The board it is played
    // back on is the one already on screen, so this carries nothing else.
    replay: (gameId) => rpc("/battleship/replay", { game_id: gameId }),
    placeShip: (gameId, side, index, cell, direction) =>
        rpc("/battleship/place", { game_id: gameId, side, index, cell, direction }),
    randomFleet: (gameId, side) => rpc("/battleship/random", { game_id: gameId, side }),
    ready: (gameId) => rpc("/battleship/ready", { game_id: gameId }),
    fire: (gameId, cell, target) => rpc("/battleship/fire", { game_id: gameId, cell, target }),

    feedback: (kind, subject, description, gameId) =>
        rpc("/battleship/feedback", {
            kind, subject, description, game_id: gameId,
        }),

    createRoom: (nickname, mode, difficulty) =>
        rpc("/battleship/room/create", { nickname, mode, difficulty }),
    startRoom: (gameId) => rpc("/battleship/room/start", { game_id: gameId }),
    joinRoom: (code, nickname) => rpc("/battleship/room/join", { code, nickname }),
    rename: (gameId, nickname) => rpc("/battleship/room/rename", { game_id: gameId, nickname }),
    leaveRoom: (gameId) => rpc("/battleship/room/leave", { game_id: gameId }),
    ping: (gameId) => rpc("/battleship/room/ping", { game_id: gameId }),
    rematch: (gameId) => rpc("/battleship/room/rematch", { game_id: gameId }),
};
