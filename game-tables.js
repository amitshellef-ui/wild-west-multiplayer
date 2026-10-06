/* =========================================================================
   GAME TABLES - one copy of the numbers the server and the page must agree on

   Read by the server (require("./game-tables")) and by the page (a <script> tag
   next to it, so it also works with the page opened straight from disk). Until
   2026-09-26 every one of these tables was typed twice, once in each, and
   tests/t9-tables.js checked that the two copies still matched. Code review
   stage 4 moves them here one table at a time; a new boss's numbers go straight
   here.

   Only numbers both sides use. What only the page needs (models, sounds, spread,
   magazine sizes) stays in the page; what only the server needs stays there.
   ========================================================================= */
(function (root, tables) {
    if (typeof module === "object" && module.exports) module.exports = tables;
    else root.GAME_TABLES = tables;
})(this, {
    /* The weapons (stage 4a). The page sends a weapon's INDEX (`w`), so the order
       is part of the protocol. Online the server decides what a hit costs: `body`
       and `head` per pellet, at most `pellets` of them, out to `range` metres, one
       report per `fireCd` ms. The page shoots with the same numbers (and calls
       `body` dmg). */
    WEAPONS: [
        { id: "winchester", body: 37, head: 96, pellets: 1, range: 200, fireCd: 430 },
        { id: "smg", body: 13, head: 26, pellets: 1, range: 90, fireCd: 75 },
        { id: "sniper", body: 120, head: 220, pellets: 1, range: 280, fireCd: 980 },
        { id: "ar", body: 22, head: 44, pellets: 1, range: 160, fireCd: 105 },
        { id: "shotgun", body: 14, head: 20, pellets: 8, range: 45, fireCd: 720 },
        { id: "deagle", body: 58, head: 115, pellets: 1, range: 120, fireCd: 260 },
        /* step F6: the shield, thrown - one hit a throw (no head bonus), out to 40 m.
           fireCd is the shortest time between two throws that come straight back. */
        { id: "shield", body: 70, head: 70, pellets: 1, range: 40, fireCd: 600 }
    ]
});
