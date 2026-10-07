/* =========================================================================
   BOOGIE BOMB - server side (step F7a)

   Three of them lie on the ground somewhere in town at the start of every game
   (a new room, a room filling up again, "new game" after the dragon). Whoever
   walks over one first is carrying it; G throws it, and every bandit and the
   boss within `radius` of where it lands dances - no walking, no shooting, no
   abilities - for `banditMs` / `bossMs`, and can be shot all the while.

   The room holds them, not the pages: otherwise each player would see them in
   a different place and two could take the same one. The pages only draw them
   and say "I am standing on it" / "it landed here"; the server checks both.
   ========================================================================= */
const nav = require("./navigation");

const BOOGIE = {
    perGame: 3,
    apart: 15,          // m between two of them on the ground
    pickReach: 1.8,     // m from the player's position (the page asks at 1.4)
    throwReach: 32,     // m - how far from the thrower it may land (an 18 m/s lob lands ~25 m off at most)
    radius: 7,          // m around where it lands
    banditMs: 4000,
    bossMs: 2500,
    dragonMs: 5000      // the dragon does not dance: it goes up and hangs there (the user's call, 2026-10-07)
};

/* Ground a player can walk to and a bandit could stand on, away from the others. */
function placeAll(room) {
    room.boogie = { items: [], nextId: 1 };
    for (let tries = 0; tries < 400 && room.boogie.items.length < BOOGIE.perGame; tries++) {
        const p = nav.randomNavPoint(true);
        if (!p || nav.collidesAt(p.x, p.z, 0.8)) continue;
        if (room.boogie.items.some((it) => Math.hypot(it.x - p.x, it.z - p.z) < BOOGIE.apart)) continue;
        room.boogie.items.push({ id: room.boogie.nextId++, x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100, holder: null, used: false });
    }
}

function initRoom(room) {
    placeAll(room);
}

/* What the pages draw: [id, x, z, holder id or "" ] for each one not yet thrown. */
function publicState(room) {
    if (!room.boogie) return [];
    return room.boogie.items.filter((it) => !it.used).map((it) => [it.id, it.x, it.z, it.holder || ""]);
}

function holding(room, playerId) {
    return !!(room.boogie && room.boogie.items.some((it) => it.holder === playerId && !it.used));
}

/* "I am standing on it." Returns true when it is now theirs. */
function pick(room, p, id) {
    if (!room.boogie || !p || !p.alive || p.downed) return false;
    const it = room.boogie.items.find((i) => i.id === id);
    if (!it || it.used || it.holder) return false;
    if (holding(room, p.id)) return false;                       // one at a time
    if (Math.hypot(p.x - it.x, p.z - it.z) > BOOGIE.pickReach) return false;
    it.holder = p.id;
    return true;
}

/* "Mine landed here." Returns { x, z, bandits: [ids], boss: ms } or null. */
function land(room, p, x, z, now) {
    if (!room.boogie || !p || !p.alive || p.downed) return null;
    if (typeof x !== "number" || typeof z !== "number" || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    const it = room.boogie.items.find((i) => i.holder === p.id && !i.used);
    if (!it) return null;
    if (Math.hypot(p.x - x, p.z - z) > BOOGIE.throwReach) return null;
    it.used = true;
    const out = { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, bandits: [], boss: 0 };
    for (const id in (room.bandits || {})) {
        const b = room.bandits[id];
        if (!b.alive || b.kind === "egg") continue;
        if (Math.hypot(b.x - x, b.z - z) > BOOGIE.radius) continue;
        b.danceUntil = now + BOOGIE.banditMs;
        out.bandits.push(b.id);
    }
    const B = room.boss;
    if (B && B.alive && Math.hypot(B.x - x, B.z - z) <= BOOGIE.radius + (B.radius || 0.85)) {
        const ms = B.type && B.type.id === "dragon" ? BOOGIE.dragonMs : BOOGIE.bossMs;
        B.danceWant = ms;                     // boss.js starts it the moment the boss is free (step F7a)
        B.danceAsk = now;
        out.boss = ms;
    }
    return out;
}

/* Somebody left the room: what they carried goes back on the ground where they were. */
function drop(room, p) {
    if (!room.boogie || !p) return false;
    const it = room.boogie.items.find((i) => i.holder === p.id && !i.used);
    if (!it) return false;
    it.holder = null;
    if (typeof p.x === "number" && !nav.collidesAt(p.x, p.z, 0.8)) { it.x = Math.round(p.x * 100) / 100; it.z = Math.round(p.z * 100) / 100; }
    return true;
}

module.exports = { BOOGIE, initRoom, publicState, pick, land, drop, holding };
