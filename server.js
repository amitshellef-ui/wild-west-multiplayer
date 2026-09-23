const express = require("express");
const crypto = require("crypto");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const mapData = require("./map-data");
const nav = require("./navigation");
const bandits = require("./bandits");
const boss = require("./boss");
const waves = require("./waves");
const missions = require("./missions");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// The short URL should open the game instead of returning 404
app.get("/", (req, res) => {
    res.redirect("/wild-west-fps-arsenal.html");
});

/* =========================================================================
   GAME MODES

   Everything that differs between modes lives here, so adding one later is a
   new entry rather than a hunt through the file. A mode belongs to a room, not
   to the server, so two groups can play different things at the same time.
   ========================================================================= */
const MODES = {
    coop: { id: "coop", label: "CO-OP", friendlyFire: false },
    ffa: { id: "ffa", label: "FREE FOR ALL", friendlyFire: true }
};
const DEFAULT_MODE = "coop";

/* =========================================================================
   ROOMS

   Every player is always inside exactly one room, and every broadcast is
   scoped to that room. PUBLIC is the lobby everybody lands in, so the game
   still works for someone who just opens the link; a private room is created
   on demand and addressed by a short code.

   Codes avoid characters that get misread when spoken or typed: no O or 0,
   no I or 1, no B or 8.
   ========================================================================= */
const PUBLIC_ROOM = "PUBLIC";
const CODE_ALPHABET = "ACDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;
const ROOM_LIMIT = 8;                  // players per room - lobby included
const MAX_LOBBIES = 6;                 // 48 people in lobbies, which is already
                                       // past what the free instance enjoys

/* Eight is not a guess. Every player's position is relayed to every other
   player twenty times a second, so the traffic inside a room grows with the
   square of the people in it: eight players is about a thousand messages a
   second and the server keeps perfect time, sixteen is four thousand and it
   starts to slip. Measured against the deployed server, not assumed.

   The limit used to be enforced in exactly one of the three doors into a room.
   The lobby had no limit at all, and a shared link went straight past it. So a
   popular evening put everybody in one room and the room was the thing that
   broke. Now all three doors count, and the lobby is many small lobbies rather
   than one big one.

   The whole server is a separate question from one room. Measured: 24 people
   across four rooms cost the deployed instance nothing it could not keep up
   with. Past forty or so, in any arrangement, the simulation loop is what runs
   out first. MAX_LOBBIES is set below that on purpose. */
function isLobby(code) {
    return code === PUBLIC_ROOM || /^PUBLIC([2-9]|1[0-9])$/.test(code);
}

function roomHasSpace(code) {
    return roomCount(code) < ROOM_LIMIT;
}

/* Where a newcomer with no room code lands: the fullest lobby that still has
   space. Filling one before opening the next is deliberate - people came here
   to find other people, and spreading them one to a room hides them. */
function pickLobby() {
    let best = null, bestCount = -1;
    for (const code in rooms) {
        if (!isLobby(code) || !roomHasSpace(code)) continue;
        const n = roomCount(code);
        if (n > bestCount) { bestCount = n; best = code; }
    }
    if (best) return best;

    for (let i = 2; i <= MAX_LOBBIES; i++) {
        const code = PUBLIC_ROOM + i;
        if (!rooms[code]) {
            createRoom(code, DEFAULT_MODE);
            console.log("Lobby", code, "opened - the others are full");
            return code;
        }
    }
    return PUBLIC_ROOM;          // everything is full; crowded beats shut out
}

const rooms = {};                      // code -> room record
const players = {};                    // player id -> player record (see RECONNECTING)
const MAX_HEALTH = 100;                // where every room starts (step 32: it grows - maxHealthOf)

function createRoom(code, modeId) {
    rooms[code] = {
        code: code,
        mode: MODES[modeId] || MODES[DEFAULT_MODE],
        createdAt: Date.now()
    };
    resetRoomState(rooms[code], Date.now());
    return rooms[code];
}

/* A room back at the start of a game: wave 1, the first boss 90 seconds away,
   the opening bandits, no mission - and not won. The same reset for a new room,
   a room going from empty to occupied, and "new game" on the victory screen. */
function resetRoomState(room, now) {
    bandits.initRoom(room);
    boss.initRoom(room, now);
    waves.initRoom(room, now);
    missions.initRoom(room);
    room.won = null;
    room.wipeAt = 0;
    room.startedAt = now;
    room.maxHealth = MAX_HEALTH;              // step 32: back to 100 with the game
}
createRoom(PUBLIC_ROOM, DEFAULT_MODE);

function makeRoomCode() {
    for (let attempt = 0; attempt < 200; attempt++) {
        let code = "";
        for (let i = 0; i < CODE_LENGTH; i++) {
            code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
        }
        if (!rooms[code]) return code;
    }
    return null;
}

function playersIn(code) {
    return Object.keys(players)
        .filter((id) => players[id].room === code)
        .map((id) => publicPlayer(players[id]));
}

function roomCount(code) {
    let n = 0;
    for (const id in players) if (players[id].room === code) n++;
    return n;
}

/* A room disappears once the last person walks out of it. The first lobby
   stays for ever because it is where the front door leads; the extra ones are
   opened on demand and closed the same way. */
function dropRoomIfEmpty(code) {
    if (code === PUBLIC_ROOM) return;
    if (roomCount(code) === 0 && rooms[code]) {
        delete rooms[code];
        console.log("Room closed:", code);
    }
}

const RESPAWN_MS = 4000;
/* Step 32: every boss the room brings down (all but the last - that one ends the
   game) raises everybody's most health by BOSS_HEALTH_BONUS and fills it: 100, 125,
   150... for everyone in the room, whoever fired the last shot. The room keeps it
   until a new game (or until it empties); a latecomer walks in with the room's. */
const BOSS_HEALTH_BONUS = 25;
function maxHealthOf(p) {
    const room = p && p.room ? rooms[p.room] : null;
    return (room && room.maxHealth) || MAX_HEALTH;
}
function raiseRoomHealth(room) {
    room.maxHealth = (room.maxHealth || MAX_HEALTH) + BOSS_HEALTH_BONUS;
    io.to(room.code).emit("max-health", { max: room.maxHealth, add: BOSS_HEALTH_BONUS });
    for (const id in players) {
        const p = players[id];
        // the downed and the dead get the new top when they are back on their feet
        if (p.room === room.code && p.alive && !p.downed) setHealth(p, p.health + BOSS_HEALTH_BONUS, null, false);
    }
}

/* =========================================================================
   RECONNECTING (step 22)

   A wifi blip used to be the end of you: the socket dropped, the player was
   deleted, and whatever came back a second later was a stranger at wave 1 with
   no score. Now a dropped player is only *away* for RECONNECT_MS. They keep
   their seat in the room, their slot, their score, their health and where they
   were standing; the simulation stops seeing them, the other players stop
   drawing them, and if they come back in time it is as though nothing happened.

   How they prove who they are: the first connection is handed a random token,
   which the page keeps and sends again when it reconnects. The token never goes
   to anybody else - which is why nothing sends raw player records any more, see
   publicPlayer() - because anyone holding it could take an away player's seat.

   A player's id is the id of the socket they first arrived on, and it stays
   theirs across reconnects; `socket.data.pid` is how a handler finds them.
   ========================================================================= */
const RECONNECT_MS = 20000;
const tokens = {};                     // token -> player id

function newToken() {
    return crypto.randomBytes(16).toString("hex");
}

/* What other players may know about a player. Deliberately short: no token,
   no timers, no rate-limit bookkeeping. One exception (step 26c): a body lying
   there with a team mate already kneeling over it says who, and how much of
   the revive is left - otherwise somebody who walks in halfway through sees the
   reviver standing and a bar that never started. */
function publicPlayer(p) {
    const out = {
        id: p.id, slot: p.slot,
        x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
        health: p.health, alive: p.alive, away: !!p.away, downed: !!p.downed,
        kills: p.kills, deaths: p.deaths
    };
    if (p.downed && p.revive) {
        out.revive = { by: p.revive.by, ms: REVIVE_MS, left: Math.max(0, REVIVE_MS - (Date.now() - p.revive.startedAt)) };
    }
    return out;
}

/* The simulation's view of the world: everybody who is actually connected. An
   away player is not a target, does not keep a room busy, and is not shot. */
function activePlayers() {
    const out = {};
    for (const id in players) if (!players[id].away) out[id] = players[id];
    return out;
}

const awayTimers = {};                 // player id -> removal timer

function removePlayer(p) {
    const room = p.room;
    delete players[p.id];
    if (p.token) delete tokens[p.token];
    clearTimeout(awayTimers[p.id]);
    delete awayTimers[p.id];
    if (room) {
        scoresChanged(room);
        io.to(room).emit("player-left", { id: p.id });
        dropRoomIfEmpty(room);
    }
}

/* =========================================================================
   SLOTS AND THE POSITION PACKET (step 14)

   Position was the whole bill. Every move a player sent was relayed on its own,
   to every other player, twenty times a second, and each copy carried a twenty
   character socket id. Eight people in a room came to about a thousand messages
   a second and 101 KB/s off the server - which on a plan that includes 5 GB a
   month is roughly fourteen hours of play before the whole thing is spun down
   until the first of the next month.

   Two changes, no loss of fidelity:

     a slot   a small number that means "this player" inside this room, handed
              out on arrival and given back on leaving. Twenty characters
              become one or two.

     a batch  the room's movement goes out as one packet on its own clock,
              fifteen times a second, carrying only the players who actually
              moved since the last one. N x N packets become N.

   Fifteen a second with the client's 110ms interpolation delay still leaves a
   packet either side of what is being drawn, which is the only thing that
   delay has to guarantee.
   ========================================================================= */
const MOVE_SEND_HZ = 15;
const MAX_SLOTS = 64;

function assignSlot(p, code) {
    const taken = {};
    for (const id in players) {
        const other = players[id];
        if (other === p || other.room !== code) continue;
        if (typeof other.slot === "number") taken[other.slot] = true;
    }
    for (let i = 0; i < MAX_SLOTS; i++) {
        if (!taken[i]) { p.slot = i; return i; }
    }
    p.slot = 0;                 // rooms are capped well below this
    return 0;
}

function round2(v) { return Math.round(v * 100) / 100; }

/* =========================================================================
   THE SCOREBOARD (step 16)

   Once the fight became one shared fight there was finally something worth
   comparing. The server already counted kills and deaths for its own reasons;
   now it also counts what each player did to the boss, and tells the room.

   A row is [slot, kills, deaths, bossDamage, bossKills]. The whole table goes
   out at most once a second, and only when something on it changed - a room
   where nobody is dying sends nothing at all.

   Scores belong to the room, not to the player: walking into a room starts you
   at zero, the same way walking in starts you at wave one.
   ========================================================================= */
function scoreRows(code) {
    const rows = [];
    for (const id in players) {
        const p = players[id];
        if (p.room !== code) continue;
        rows.push([p.slot, p.kills, p.deaths, Math.round(p.bossDamage), p.bossKills]);
    }
    return rows;
}

function scoresChanged(code) {
    if (rooms[code]) rooms[code].scoresDirty = true;
}

/* Verified against the map's own collision and navigation data: every one of
   these is clear of geometry, sits on a walkable navigation cell, and has a
   path back to the town centre. */
const SPAWNS = [
    [0, 3], [-20, 0], [20, 0], [34, -2], [0, -26], [-40, 22],
    [40, -22], [12, 32], [28, 22], [-30, -20], [8, -40], [44, 4]
];

/* The damage table lives here, not on the client. A client reports *that* it
   hit and *where* - never how much that is worth. */
const WEAPONS = [
    { id: "winchester", body: 37, head: 96, pellets: 1, range: 200, fireCd: 430 },
    { id: "smg", body: 13, head: 26, pellets: 1, range: 90, fireCd: 75 },
    { id: "sniper", body: 120, head: 220, pellets: 1, range: 280, fireCd: 980 },
    { id: "ar", body: 22, head: 44, pellets: 1, range: 160, fireCd: 105 },
    { id: "shotgun", body: 14, head: 20, pellets: 8, range: 45, fireCd: 720 },
    { id: "deagle", body: 58, head: 115, pellets: 1, range: 120, fireCd: 260 }
];

/* Coming back to life inside somebody's line of fire is not a fight, it is a
   punishment. Pick the spawn that is furthest from the bandits currently alive
   in that room, and fall back to a random one if the room has none. */
function pickSpawn(room) {
    if (!room || !room.bandits) return SPAWNS[Math.floor(Math.random() * SPAWNS.length)];

    let best = null, bestScore = -1;
    for (let i = 0; i < SPAWNS.length; i++) {
        const s = SPAWNS[i];
        let nearest = Infinity;
        for (const id in room.bandits) {
            const b = room.bandits[id];
            if (!b.alive) continue;
            const d = Math.hypot(b.x - s[0], b.z - s[1]);
            if (d < nearest) nearest = d;
        }
        // a little noise so the same corner is not used every single time
        const score = (nearest === Infinity ? 999 : nearest) + Math.random() * 6;
        if (score > bestScore) { bestScore = score; best = s; }
    }
    return best || SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
}

/* =========================================================================
   LINE OF FIRE (step 15)

   Until now a client could report a hit on anything in range, wall or no
   wall. The server now asks whether any part of the body - head, chest, either
   shoulder - could be seen from the shooter's eyes, at the target's position
   now or anywhere in the last 300ms. The reason for the history is in
   bandits.js: the browser draws bodies slightly in the past, so the honest
   answer to "could they see it?" is about where it *was*.

   Measured against the browser's own bullet ray before this was switched on:
   about one honest hit in seven hundred is refused. The counters below log
   what it actually does in play, so that number can be checked against real
   games rather than trusted.
   ========================================================================= */
const LINE_OF_FIRE = { checked: 0, refused: 0, since: Date.now() };

function inLineOfFire(shooter, target, scale, headY) {
    LINE_OF_FIRE.checked++;
    const ex = shooter.x, ey = shooter.y || 1.72, ez = shooter.z;
    if (nav.bodyVisible(ex, ey, ez, target.x, target.z, scale, headY)) return true;
    const t = target.trail;
    if (t) {
        for (let i = t.length - 2; i >= 0; i -= 2) {
            if (nav.bodyVisible(ex, ey, ez, t[i], t[i + 1], scale, headY)) return true;
        }
    }
    LINE_OF_FIRE.refused++;
    return false;
}

setInterval(() => {
    if (LINE_OF_FIRE.checked === 0) return;
    const pct = (100 * LINE_OF_FIRE.refused / LINE_OF_FIRE.checked).toFixed(2);
    console.log("Line of fire, last " + Math.round((Date.now() - LINE_OF_FIRE.since) / 60000) +
        " min: " + LINE_OF_FIRE.checked + " hits checked, " + LINE_OF_FIRE.refused +
        " refused (" + pct + "%)");
    LINE_OF_FIRE.checked = 0;
    LINE_OF_FIRE.refused = 0;
    LINE_OF_FIRE.since = Date.now();
}, 5 * 60 * 1000);

function distanceBetween(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/* Returns -1 for anything that is not a whole number inside the range. The
   caller drops the whole packet on -1 rather than clamping: a client claiming
   more pellets than its weapon can fire is not a client to negotiate with. */
function strictCount(v, hi) {
    if (typeof v !== "number" || !Number.isFinite(v)) return -1;
    if (v < 0 || v > hi || (v | 0) !== v) return -1;
    return v | 0;
}

/* ---- Packet validation. Nothing off the wire is trusted. ---- */
const MOVE_FIELDS = ["x", "y", "z", "yaw", "pitch"];
const MAX_TRACERS = 12;

function isVec3(v) {
    return Array.isArray(v) && v.length === 3 &&
        typeof v[0] === "number" && Number.isFinite(v[0]) &&
        typeof v[1] === "number" && Number.isFinite(v[1]) &&
        typeof v[2] === "number" && Number.isFinite(v[2]);
}

function readMove(m) {
    if (!m || typeof m !== "object") return null;
    const out = {};
    for (const key of MOVE_FIELDS) {
        const v = m[key];
        if (typeof v !== "number" || !Number.isFinite(v)) return null;
        out[key] = v;
    }
    return out;
}

function readShot(m) {
    if (!m || typeof m !== "object") return null;
    if (typeof m.w !== "number" || !Number.isFinite(m.w) || m.w < 0 || m.w > 32) return null;
    if (!isVec3(m.o)) return null;
    if (!Array.isArray(m.e) || m.e.length === 0 || m.e.length > MAX_TRACERS) return null;
    for (let i = 0; i < m.e.length; i++) if (!isVec3(m.e[i])) return null;
    return { w: m.w | 0, o: m.o, e: m.e };
}

function readCode(v) {
    if (typeof v !== "string") return null;
    const code = v.trim().toUpperCase();
    if (code.length < 3 || code.length > 8) return null;
    if (!/^[A-Z0-9]+$/.test(code)) return null;
    return code;
}

/* ---- Health ---- */
function setHealth(p, value, attackerId, headshot) {
    p.health = Math.max(0, Math.min(maxHealthOf(p), value));
    io.to(p.room).emit("player-health", {
        id: p.id,
        health: p.health,
        by: attackerId || null,
        headshot: !!headshot
    });
    if (p.health <= 0 && p.alive) kill(p, attackerId);
}

/* =========================================================================
   DOWNED AND REVIVED (step 23)

   In co-op nobody gets up on their own any more. A player whose health runs
   out goes down where they stand, and stays down until a team mate stands
   within reach and holds E on them for REVIVE_MS - then they are back on their
   feet with REVIVE_HEALTH. Bandits and the boss ignore a downed player.

   The one exception is a room with nobody left standing. A rule that only a
   team mate can revive you has no answer when there are no team mates on their
   feet - one player alone, or a squad that all went down together - and that
   room would sit there for ever. So when every connected player in a room is
   down, they all get up together after WIPE_MS. While even one is standing,
   nobody comes back alone.

   Free-for-all has no team mates, so it keeps the old respawn timer.

   The server keeps the clock on a revive; the page only says when E is pressed
   and released. Moving out of reach, dying, or dropping the connection
   cancels it.
   ========================================================================= */
const REVIVE_MS = 5000;
const REVIVE_HEALTH = 50;
const REVIVE_START_RANGE = 3.0;        // metres between reviver and body to begin
const REVIVE_HOLD_RANGE = 3.5;         // a little slack to keep going, for latency
const WIPE_MS = 3000;

function respawnPlayer(p) {
    const s = pickSpawn(rooms[p.room]);
    p.x = s[0]; p.y = 1.72; p.z = s[1];
    p.yaw = Math.random() * Math.PI * 2;
    p.pitch = 0;
    p.health = maxHealthOf(p);
    p.alive = true;
    p.downed = false;
    p.revive = null;
    io.to(p.room).emit("player-respawn", {
        id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, health: p.health
    });
}

function kill(victim, attackerId) {
    victim.alive = false;
    victim.deaths++;
    const killer = attackerId ? players[attackerId] : null;
    if (killer && killer.id !== victim.id) killer.kills++;
    scoresChanged(victim.room);

    const room = rooms[victim.room];
    const coop = room && !room.mode.friendlyFire;

    if (coop) {
        victim.downed = true;
        victim.downedAt = Date.now();
        victim.revive = null;
        io.to(victim.room).emit("player-died", {
            id: victim.id, by: killer ? killer.id : null, respawnIn: 0, downed: true,
            x: Math.round(victim.x * 100) / 100, z: Math.round(victim.z * 100) / 100
        });
        console.log("Down:", victim.id.slice(0, 6), "in", victim.room);
        return;
    }

    io.to(victim.room).emit("player-died", {
        id: victim.id,
        by: killer ? killer.id : null,
        respawnIn: RESPAWN_MS
    });
    console.log("Kill:", (killer ? killer.id.slice(0, 6) : "bots/world"),
        "->", victim.id.slice(0, 6), "in", victim.room);

    setTimeout(() => {
        const p = players[victim.id];
        if (!p || p.alive) return;           // left, or already brought back
        respawnPlayer(p);
    }, RESPAWN_MS);
}

function cancelRevive(target, why) {
    if (!target.revive) return;
    target.revive = null;
    io.to(target.room).emit("revive-progress", { id: target.id, by: null, why: why || "stopped" });
}

/* Once a tick per room: revives in progress, and the room nobody is standing in. */
function stepRevives(room, now) {
    const code = room.code;
    let downed = 0, standing = 0;
    for (const id in players) {
        const p = players[id];
        if (p.room !== code) continue;
        if (p.downed) downed++;
        else if (p.alive && !p.away) standing++;

        if (!p.downed || !p.revive) continue;
        const r = players[p.revive.by];
        if (!r || r.room !== code || !r.alive || r.away || p.away) { cancelRevive(p, "interrupted"); continue; }
        if (Math.hypot(r.x - p.x, r.z - p.z) > REVIVE_HOLD_RANGE) { cancelRevive(p, "too far"); continue; }
        if (now - p.revive.startedAt < REVIVE_MS) continue;

        // up again
        const by = p.revive.by;
        p.revive = null;
        p.downed = false;
        p.alive = true;
        p.health = REVIVE_HEALTH;
        io.to(code).emit("player-revived", {
            id: p.id, by: by, health: p.health,
            x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100
        });
        io.to(code).emit("player-health", { id: p.id, health: p.health, by: null, headshot: false });
        console.log("Revive:", by.slice(0, 6), "->", p.id.slice(0, 6), "in", code);
        standing++; downed--;
    }

    if (room.mode.friendlyFire) return;
    if (downed > 0 && standing === 0) {
        if (!room.wipeAt) {
            room.wipeAt = now + WIPE_MS;
            io.to(code).emit("team-wiped", { in: WIPE_MS });
            console.log("Team wiped in", code, "- everybody up in", WIPE_MS / 1000 + "s");
        } else if (now >= room.wipeAt) {
            room.wipeAt = 0;
            for (const id in players) {
                const p = players[id];
                if (p.room === code && p.downed) respawnPlayer(p);
            }
        }
    } else if (room.wipeAt) {
        /* somebody is standing again - a team mate joined, or came back from a
           dropped connection - so the fallen wait for them instead. Say so, or
           the pages keep counting down to a wipe that is not coming. */
        room.wipeAt = 0;
        io.to(code).emit("team-wiped", { in: 0, cancelled: true });
    }
}

/* =========================================================================
   MISSIONS (step 24)

   Every wave from the second on hands the room a job - defend the bank, escort
   the wagon, hold a patch of ground - for up to forty seconds. The rules are in
   missions.js; what lives here is telling the room, and paying out.
   ========================================================================= */
function startMission(room, now) {
    if (room.mission) finishMission(room, missions.cancel(room, "wave"));
    const pkt = missions.start(room, activePlayers(), now);
    if (!pkt) return;
    io.to(room.code).emit("mission", pkt);
    console.log("Mission in", room.code + ":", pkt.k, "- wave", room.wave);
}

/* Winning is worth health to everybody on their feet. The rounds are handed out
   by the page itself when it hears the result, the same way a wave's are. */
function finishMission(room, res) {
    if (!res) return;
    io.to(room.code).emit("mission-end", res);
    if (res.ok) {
        for (const id in players) {
            const p = players[id];
            if (p.room !== room.code || !p.alive || p.downed || p.away) continue;
            setHealth(p, p.health + missions.MISSION.healthReward, null, false);
        }
    }
    console.log("Mission in", room.code + ":", res.k, res.ok ? "done" : "failed", "(" + res.why + ")");
}

/* =========================================================================
   THE END OF THE GAME (step 28)

   The dragon is the last boss (`final` on its row in boss.js). When it falls the
   game is won: the room is told, with the final table, and it stops - every
   bandit still standing drops, no wave turns over, no boss comes. It stays that
   way until somebody in the room presses "new game" (`room-restart`), which puts
   it back to the start exactly the way an empty room is reset when somebody walks
   in, with everybody back on their feet at a spawn point and the scores at zero.

   Somebody who walks into a won room - or comes back to one - is shown the same
   screen and the same button. A won room that everybody leaves is reset by the
   next person through the door, like any empty room.
   ========================================================================= */
const RESTART_GAP_MS = 1000;

function winRoom(room, killer, typeIndex, fallen, headshot, now) {
    const code = room.code;
    // the table as it stands, with who each slot was - someone may leave before it is read
    const rows = [];
    for (const id in players) {
        const p = players[id];
        if (p.room !== code) continue;
        rows.push([p.slot, p.kills, p.deaths, Math.round(p.bossDamage), p.bossKills, p.id]);
    }
    room.won = {
        by: killer.id, t: typeIndex,
        x: Math.round(fallen.x * 100) / 100, z: Math.round(fallen.z * 100) / 100,
        headshot: !!headshot,
        wave: room.wave || 1,
        ms: now - (room.startedAt || now),
        scores: rows
    };
    // the town goes quiet: whoever was still shooting drops where they stand
    for (const id in room.bandits) {
        const b = room.bandits[id];
        b.alive = false;
        b.health = 0;
    }
    room.bullets = [];
    room.hazards = [];
    room.clouds = [];
    room.nextBossAt = Infinity;
    if (room.mission) finishMission(room, missions.cancel(room, "won"));
    io.to(code).emit("bandits", { b: bandits.snapshot(room) });      // now, not on the next heartbeat
    io.to(code).emit("room-won", room.won);
    console.log("Room", code, "WON - the dragon fell to", killer.id.slice(0, 6), "on wave", room.won.wave,
        "after", Math.round(room.won.ms / 1000) + "s");
}

/* ---- Moving between rooms ---- */
function placeInRoom(socket, p, code) {
    const previous = p.room;

    /* Walking into an empty room should feel like starting a game, not like
       joining someone else's siege. Bandits only ever accumulate - by the time
       a room has been sitting for a few minutes it is at the cap, and the first
       person through the door would have arrived to a dozen of them. So the
       room is reset the moment it goes from nobody to somebody, exactly the
       way the single player game resets when you press start. */
    const roomWasEmpty = roomCount(code) === 0;
    if (previous) {
        socket.leave(previous);
        socket.to(previous).emit("player-left", { id: p.id });
    }

    p.room = code;
    socket.join(code);
    assignSlot(p, code);

    if (roomWasEmpty && rooms[code]) {
        resetRoomState(rooms[code], Date.now());
        console.log("Room", code, "was empty - back to wave 1:", bandits.BANDIT.startCount,
            "bandits, up to", waves.capFor(rooms[code]),
            "| boss in", (boss.BOSS.firstBossMs / 1000) + "s");
    }

    // A fresh start in the new room, so nobody arrives already hurt or dead
    p.kills = 0; p.deaths = 0; p.bossDamage = 0; p.bossKills = 0;
    if (previous) scoresChanged(previous);
    scoresChanged(code);
    const s = pickSpawn(rooms[code]);
    p.x = s[0]; p.y = 1.72; p.z = s[1];
    p.yaw = 0; p.pitch = 0;
    p.health = maxHealthOf(p);               // step 32: the room's, which a latecomer shares
    p.alive = true;
    p.downed = false;
    p.revive = null;

    socket.emit("room-joined", {
        code: code,
        mode: rooms[code].mode,
        players: playersIn(code),
        wave: rooms[code].wave || 1,
        cap: waves.capFor(rooms[code]),
        banditHp: waves.difficultyFor(rooms[code]).health,
        scores: scoreRows(code),
        mission: missions.publicState(rooms[code], Date.now()),
        won: rooms[code].won || null,
        maxHealth: maxHealthOf(p)
    });
    socket.to(code).emit("player-joined", publicPlayer(p));

    if (previous) dropRoomIfEmpty(previous);
    console.log("Player", p.id.slice(0, 6), "->", code, "(" + roomCount(code) + " inside)");
}

io.on("connection", (socket) => {
    const auth = socket.handshake.auth || {};
    const offered = (typeof auth.token === "string" && /^[0-9a-f]{32}$/.test(auth.token)) ? auth.token : null;
    const back = offered && tokens[offered] ? players[tokens[offered]] : null;

    /* Coming back inside the window, to a seat that is still waiting. A token for
       a player who is not away - the same page open twice - is not a way in:
       that connection simply becomes a new player. */
    if (back && back.away && back.room && rooms[back.room]) {
        clearTimeout(awayTimers[back.id]);
        delete awayTimers[back.id];
        back.away = false;
        back.socketId = socket.id;
        socket.data.pid = back.id;
        socket.join(back.room);
        const room = rooms[back.room];
        socket.emit("welcome", { id: back.id, token: back.token, resumed: true });
        socket.emit("room-joined", {
            code: back.room,
            mode: room.mode,
            players: playersIn(back.room),
            wave: room.wave || 1,
            cap: waves.capFor(room),
            banditHp: waves.difficultyFor(room).health,
            scores: scoreRows(back.room),
            mission: missions.publicState(room, Date.now()),
            won: room.won || null,
            maxHealth: maxHealthOf(back),
            resumed: true
        });
        socket.to(back.room).emit("player-back", publicPlayer(back));
        console.log("Player", back.id.slice(0, 6), "back in", back.room,
            "after", Math.round((Date.now() - back.awayAt) / 100) / 10 + "s");
        registerHandlers(socket);
        return;
    }

    console.log("Player connected:", socket.id);
    const spawn = pickSpawn();
    players[socket.id] = {
        id: socket.id,
        token: newToken(),
        socketId: socket.id,
        away: false,
        joinedAt: Date.now(),
        room: null,
        x: spawn[0], y: 1.72, z: spawn[1],
        yaw: 0, pitch: 0,
        movedAt: Date.now(),
        health: MAX_HEALTH,
        alive: true,
        kills: 0,
        deaths: 0,
        bossDamage: 0,
        bossKills: 0,
        lastHitAt: 0,
        lastBanditHitAt: 0,
        lastBossHitAt: 0,
        lastDeltaAt: 0,
        lastRoomAt: 0,
        reloadAt: 0
    };
    const me = players[socket.id];
    socket.data.pid = me.id;
    tokens[me.token] = me.id;

    /* A shared link carries its room code in the connection query, so a friend
       who clicks it lands straight inside instead of in the lobby - unless the
       room is already full, in which case they are told why and put in a lobby
       rather than being made the ninth person in an eight person room. */
    const wanted = readCode(socket.handshake.query && socket.handshake.query.room);
    let startRoom;
    if (wanted && rooms[wanted] && roomHasSpace(wanted)) {
        startRoom = wanted;
    } else {
        startRoom = pickLobby();
        if (wanted && rooms[wanted]) {
            socket.emit("room-error", { reason: "ROOM_FULL", code: wanted });
        } else if (wanted) {
            socket.emit("room-error", { reason: "NO_SUCH_ROOM", code: wanted });
        }
    }

    socket.emit("welcome", { id: me.id, token: me.token, resumed: false });
    placeInRoom(socket, me, startRoom);
    registerHandlers(socket);
});

/* Every event a connected player can send. Registered for a brand new
   connection and for one that has come back, identically. */
function registerHandlers(socket) {

    /* ---- Room controls ---- */
    socket.on("create-room", (m) => {
        const p = players[socket.data.pid];
        if (!p) return;
        const now = Date.now();
        if (now - p.lastRoomAt < 1000) return;      // no hammering
        p.lastRoomAt = now;

        const code = makeRoomCode();
        if (!code) { socket.emit("room-error", { reason: "FULL" }); return; }

        const modeId = (m && typeof m.mode === "string" && MODES[m.mode]) ? m.mode : DEFAULT_MODE;
        createRoom(code, modeId);
        console.log("Room created:", code, rooms[code].mode.label);
        placeInRoom(socket, p, code);
    });

    socket.on("join-room", (m) => {
        const p = players[socket.data.pid];
        if (!p) return;
        const now = Date.now();
        if (now - p.lastRoomAt < 1000) return;
        p.lastRoomAt = now;

        const code = readCode(m && m.code);
        if (!code) { socket.emit("room-error", { reason: "BAD_CODE" }); return; }
        if (!rooms[code]) { socket.emit("room-error", { reason: "NO_SUCH_ROOM", code: code }); return; }
        if (code === p.room) { socket.emit("room-error", { reason: "ALREADY_HERE", code: code }); return; }

        /* Asking for a full lobby is asking to play, not asking for that exact
           room - so it sends you to one with space. Asking for a full private
           room is asking for those particular people, and gets an answer. */
        if (!roomHasSpace(code)) {
            if (isLobby(code)) {
                placeInRoom(socket, p, pickLobby());
                return;
            }
            socket.emit("room-error", { reason: "ROOM_FULL", code: code });
            return;
        }
        placeInRoom(socket, p, code);
    });

    socket.on("leave-room", () => {
        const p = players[socket.data.pid];
        if (!p || isLobby(p.room)) return;
        const now = Date.now();
        if (now - p.lastRoomAt < 1000) return;
        p.lastRoomAt = now;
        placeInRoom(socket, p, pickLobby());
    });

    /* ---- Position + rotation (steps 3 and 4, batched in step 14) ----
       Nothing leaves here any more. The move is recorded and marked, and the
       room's next position packet carries it along with everybody else's. */
    socket.on("move", (m) => {
        const p = players[socket.data.pid];
        if (!p || !p.room || p.downed) return;          // lying where they fell
        const move = readMove(m);
        if (!move) return;
        p.x = move.x; p.y = move.y; p.z = move.z;
        p.yaw = move.yaw; p.pitch = move.pitch;
        p.movedAt = Date.now();
        p.moveDirty = true;
        bandits.recordTrail(p);
    });

    /* ---- Shot relay (step 7): muzzle flash, tracers and sound only ---- */
    socket.on("shoot", (m) => {
        const p = players[socket.data.pid];
        if (!p || !p.room) return;
        const shot = readShot(m);
        if (!shot) return;
        socket.to(p.room).emit("player-shot", {
            id: p.id, w: shot.w, o: shot.o, e: shot.e
        });
    });

    /* ---- Reload relay (step 26c): so the others see the soldier change
       magazines. Looks only, like the shot relay - the server does not count
       ammunition and does not start now. `ms` is how long the reload takes,
       worked out by the page from the rounds it is loading. */
    socket.on("reload", (m) => {
        const p = players[socket.data.pid];
        if (!p || !p.room || !p.alive || p.downed || p.away) return;
        const ms = m && m.ms;
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 300 || ms > 12000) return;
        const now = Date.now();
        if (now - p.reloadAt < 500) return;
        p.reloadAt = now;
        socket.to(p.room).emit("player-reload", { id: p.id, ms: Math.round(ms) });
    });

    /* =====================================================================
       HITS ON OTHER PLAYERS (step 8)

       The client says who it hit and with how many pellets; the server owns
       what that costs. Checked before anything is applied:
         - the room's mode allows players to hurt each other at all
         - shooter and victim are in the same room and both alive
         - one damage report per weapon cooldown
         - the pellet count fits the weapon
         - the victim is inside the weapon's range

         - there is no wall between them (step 15)
       ===================================================================== */
    socket.on("hit", (m) => {
        const shooter = players[socket.data.pid];
        if (!shooter || !shooter.alive || !shooter.room) return;

        const room = rooms[shooter.room];
        if (!room || !room.mode.friendlyFire) return;   // co-operative: nothing to do
        if (room.won) return;                           // the game is over (step 28)

        if (!m || typeof m !== "object") return;
        if (typeof m.w !== "number" || (m.w | 0) !== m.w || m.w < 0 || m.w >= WEAPONS.length) return;
        const w = WEAPONS[m.w];

        const now = Date.now();
        if (now - shooter.lastHitAt < w.fireCd * 0.7) return;

        if (!Array.isArray(m.targets) || m.targets.length === 0 || m.targets.length > 8) return;

        const accepted = [];
        let pellets = 0;
        for (let i = 0; i < m.targets.length; i++) {
            const t = m.targets[i];
            if (!t || typeof t.id !== "string") continue;
            const victim = players[t.id];
            if (!victim || !victim.alive || victim.away || victim.id === shooter.id) continue;
            if (victim.room !== shooter.room) continue;       // no shooting across rooms

            const body = strictCount(t.body, w.pellets);
            const head = strictCount(t.head, w.pellets);
            if (body < 0 || head < 0) return;
            if (body + head <= 0) continue;

            if (distanceBetween(shooter, victim) > w.range * 1.15 + 3) continue;
            // a player's head is where their eyes are
            if (!inLineOfFire(shooter, victim, 1, victim.y || 1.72)) continue;

            pellets += body + head;
            accepted.push({ victim: victim, body: body, head: head });
        }
        if (accepted.length === 0 || pellets > w.pellets) return;

        shooter.lastHitAt = now;
        for (let i = 0; i < accepted.length; i++) {
            const a = accepted[i];
            setHealth(a.victim, a.victim.health - (a.body * w.body + a.head * w.head),
                shooter.id, a.head > 0);
        }
    });

    /* =====================================================================
       HITS ON BANDITS (step 11b)

       The bandits belong to the room, so the shot is checked against the same
       weapon table the players are checked against: a real weapon, a plausible
       rate, a plausible distance, and a pellet count the gun could actually
       throw. A client cannot invent a kill.
       ===================================================================== */
    socket.on("bandit-hit", (m) => {
        const shooter = players[socket.data.pid];
        if (!shooter || !shooter.alive || !shooter.room) return;
        const room = rooms[shooter.room];
        if (!room || !room.bandits) return;

        if (!m || typeof m !== "object") return;
        if (typeof m.w !== "number" || (m.w | 0) !== m.w || m.w < 0 || m.w >= WEAPONS.length) return;
        const w = WEAPONS[m.w];

        const now = Date.now();
        if (now - shooter.lastBanditHitAt < w.fireCd * 0.7) return;

        if (!Array.isArray(m.targets) || m.targets.length === 0 || m.targets.length > 8) return;

        const accepted = [];
        let pellets = 0;
        for (let i = 0; i < m.targets.length; i++) {
            const t = m.targets[i];
            if (!t || typeof t.id !== "number") continue;
            const b = room.bandits[t.id];
            if (!b || !b.alive) continue;

            const body = strictCount(t.body, w.pellets);
            const head = strictCount(t.head, w.pellets);
            if (body < 0 || head < 0) return;
            if (body + head <= 0) continue;

            const dist = Math.hypot(shooter.x - b.x, shooter.z - b.z);
            if (dist > w.range * 1.15 + 3) continue;
            if (!inLineOfFire(shooter, b, 1)) continue;

            pellets += body + head;
            accepted.push({ b: b, body: body, head: head });
        }
        if (accepted.length === 0 || pellets > w.pellets) return;

        shooter.lastBanditHitAt = now;
        for (let i = 0; i < accepted.length; i++) {
            const a = accepted[i];
            const damage = a.body * w.body + a.head * w.head;
            const res = bandits.hurt(room, a.b.id, damage);
            if (res && res.killed) {
                shooter.kills++;
                scoresChanged(room.code);
                io.to(room.code).emit("bandit-died", {
                    id: a.b.id, by: shooter.id, x: a.b.x, z: a.b.z, headshot: a.head > 0
                });
            }
        }
    });

    /* =====================================================================
       HITS ON THE BOSS (step 12)

       Same contract as a bandit: the client says it hit and where on the body,
       the server owns the rest. Kept separate from bandit-hit because the boss
       is one entity with its own cooldown - otherwise a player could spend the
       same trigger pull twice, once on each path.
       ===================================================================== */
    socket.on("boss-hit", (m) => {
        const shooter = players[socket.data.pid];
        if (!shooter || !shooter.alive || !shooter.room) return;
        const room = rooms[shooter.room];
        if (!room || !room.boss || !room.boss.alive) return;

        if (!m || typeof m !== "object") return;
        if (typeof m.w !== "number" || (m.w | 0) !== m.w || m.w < 0 || m.w >= WEAPONS.length) return;
        const w = WEAPONS[m.w];

        const now = Date.now();
        if (now - shooter.lastBossHitAt < w.fireCd * 0.7) return;

        const body = strictCount(m.body, w.pellets);
        const head = strictCount(m.head, w.pellets);
        if (body < 0 || head < 0) return;
        if (body + head <= 0 || body + head > w.pellets) return;

        const b = room.boss;
        if (Math.hypot(shooter.x - b.x, shooter.z - b.z) > w.range * 1.15 + 3) return;
        // step 33b: the dragon up in the air in an EMBER RAIN is seen over walls it would be behind on the ground
        const lift = boss.liftOf(b, now);
        if (!inLineOfFire(shooter, b, 1.75, lift > 0 ? 1.62 * 1.75 + lift : undefined)) return;

        shooter.lastBossHitAt = now;
        const typeIndex = b.typeIndex;
        const healthBefore = b.health;
        const res = boss.hurt(room, body * w.body + head * w.head, now);
        /* What the shot actually took off, not what it was worth - the last
           shot on a boss with 20 left counts 20, not 96. */
        if (res) {
            shooter.bossDamage += Math.max(0, healthBefore - res.boss.health);
            scoresChanged(room.code);
        }
        /* step 30b: a round through the skeleton's skull while it counts a duel down
           breaks it - the shot never comes, and it goes down on one knee */
        if (res && !res.killed && head > 0 && boss.duelHeadshot(room, now)) {
            io.to(room.code).emit("boss-duel", { e: "break", by: shooter.id });
        }
        if (res && res.killed && res.boss.type.final) {
            // the last boss (step 28): no next wave, no next boss - the game is won
            shooter.kills++;
            shooter.bossKills++;
            io.to(room.code).emit("boss-died", {
                by: shooter.id, t: typeIndex,
                x: Math.round(res.boss.x * 100) / 100,
                z: Math.round(res.boss.z * 100) / 100,
                headshot: head > 0,
                nextIn: 0, won: true
            });
            winRoom(room, shooter, typeIndex, res.boss, head > 0, now);
            return;
        }
        if (res && res.killed) {
            shooter.kills++;
            shooter.bossKills++;
            /* Winning is worth a wave. The browser did this too - it is the
               reason the number moves at all when a fight runs long. */
            const up = waves.advance(room, activePlayers(), now, "boss");
            bandits.applyWave(room);
            bandits.fillTo(room, activePlayers(), up.cap);
            io.to(room.code).emit("wave", up);
            startMission(room, now);
            io.to(room.code).emit("boss-died", {
                by: shooter.id, t: typeIndex,
                x: Math.round(res.boss.x * 100) / 100,
                z: Math.round(res.boss.z * 100) / 100,
                headshot: head > 0,
                nextIn: boss.BOSS.nextBossMs
            });
            raiseRoomHealth(room);                 // step 32: +25 most health for everybody in the room
            console.log("Boss down:", res.boss.type.name, "in", room.code,
                "by", shooter.id.slice(0, 6), "- most health now", room.maxHealth);
        }
    });

    /* =====================================================================
       HEALING AND THE LAST TRUSTED PATH (step 9)

       Everything that hurts a player now happens here - bandits since 11c, the
       boss since 12 - so what is left on this path is out-of-combat recovery
       and the small top-up for a kill. It is still a client saying a number,
       so it is still capped: 20 a report, five reports a second.
       ===================================================================== */
    socket.on("health-delta", (m) => {
        const p = players[socket.data.pid];
        if (!p || !p.alive) return;
        if (!m || typeof m.d !== "number" || !Number.isFinite(m.d)) return;

        const now = Date.now();
        if (now - p.lastDeltaAt < 200) return;
        p.lastDeltaAt = now;

        const d = Math.max(-maxHealthOf(p), Math.min(20, m.d));
        if (d === 0) return;
        setHealth(p, p.health + d, null, false);
    });

    /* ---- Reviving a team mate (step 23) ----
       The page says when E goes down on somebody and when it comes up; the
       server does the counting and the checking. */
    socket.on("revive-start", (m) => {
        const r = players[socket.data.pid];
        if (!r || !r.alive || r.away || !r.room || !m || typeof m.id !== "string") return;
        const room = rooms[r.room];
        if (!room || room.mode.friendlyFire) return;
        const t = players[m.id];
        if (!t || t === r || t.room !== r.room || !t.downed || t.away) return;
        if (Math.hypot(r.x - t.x, r.z - t.z) > REVIVE_START_RANGE) return;
        if (t.revive && t.revive.by !== r.id && players[t.revive.by] && players[t.revive.by].alive) return;   // someone is already on it
        if (t.revive && t.revive.by === r.id) return;                                                      // already counting
        // one body at a time: letting go of anyone else
        for (const id in players) {
            const q = players[id];
            if (q.revive && q.revive.by === r.id) cancelRevive(q, "switched");
        }
        t.revive = { by: r.id, startedAt: Date.now() };
        io.to(r.room).emit("revive-progress", { id: t.id, by: r.id, ms: REVIVE_MS });
    });

    /* ---- "New game" on the victory screen (step 28) ----
       Anybody in a won room may press it, once; the first press restarts the
       room for everybody, and any press after that finds a room that is not
       won any more and does nothing. */
    socket.on("room-restart", () => {
        const p = players[socket.data.pid];
        if (!p || !p.room || p.away) return;
        const room = rooms[p.room];
        if (!room || !room.won) return;
        const now = Date.now();
        if (now - (p.restartAt || 0) < RESTART_GAP_MS) return;
        p.restartAt = now;

        const code = room.code;
        resetRoomState(room, now);
        for (const id in players) {
            const q = players[id];
            if (q.room !== code) continue;
            q.kills = 0; q.deaths = 0; q.bossDamage = 0; q.bossKills = 0;
        }
        room.scoresDirty = false;
        // first the room's new state, so the pages reset before anybody is moved
        io.to(code).emit("room-restarted", {
            by: p.id,
            wave: room.wave || 1,
            cap: waves.capFor(room),
            banditHp: waves.difficultyFor(room).health,
            scores: scoreRows(code),
            maxHealth: room.maxHealth                 // step 32: 100 again
        });
        // then everybody on their feet, at a spawn point, full health
        for (const id in players) {
            const q = players[id];
            if (q.room === code) respawnPlayer(q);
        }
        console.log("Room", code, "- new game, started by", p.id.slice(0, 6));
    });

    socket.on("revive-stop", (m) => {
        const r = players[socket.data.pid];
        if (!r || !m || typeof m.id !== "string") return;
        const t = players[m.id];
        if (t && t.revive && t.revive.by === r.id) cancelRevive(t, "released");
    });

    /* Not gone - away. The seat, the slot and the score wait RECONNECT_MS for
       the same page to come back; after that it is a normal departure. */
    socket.on("disconnect", () => {
        const p = players[socket.data.pid];
        if (!p || p.socketId !== socket.id) return;     // a newer connection already owns them
        p.away = true;
        p.awayAt = Date.now();
        p.socketId = null;
        p.moveDirty = false;
        console.log("Player", p.id.slice(0, 6), "away from", p.room, "- holding the seat",
            RECONNECT_MS / 1000 + "s");
        if (p.room) io.to(p.room).emit("player-away", { id: p.id });
        awayTimers[p.id] = setTimeout(() => {
            const q = players[p.id];
            if (!q || !q.away) return;
            console.log("Player", q.id.slice(0, 6), "did not come back");
            removePlayer(q);
        }, RECONNECT_MS);
    });
}

/* =========================================================================
   THE SIMULATION LOOP

   One timer drives every room. It steps the bandits at a fixed rate so their
   speed never depends on how busy the server is, and sends a snapshot at half
   that rate - the clients smooth between snapshots the same way they already
   smooth other players, so ten a second is plenty and costs a fraction of the
   bandwidth.
   ========================================================================= */
let lastTick = Date.now();
let tickCount = 0;

setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.25, (now - lastTick) / 1000);
    lastTick = now;

    /* One route-search allowance shared by every room this tick - see
       navigation.js. A room that has just filled for a new wave borrows a
       little time from the next tick instead of stalling everybody's. */
    nav.beginTick();
    const active = activePlayers();        // away players are invisible to the simulation

    for (const code in rooms) {
        const room = rooms[code];

        /* A won room (step 28) is frozen: nothing moves, fires, spawns or ticks
           down until somebody starts a new game. Revives still finish, so a
           player lying there when the dragon fell can be picked up. */
        if (room.won) { stepRevives(room, now); continue; }

        /* One sink for both simulations. The bandits and the boss share the
           room's bullet list, so they also share the list of what those
           bullets did - the server applies all of it in one place below. */
        const sink = boss.emptySink();
        bandits.stepRoom(room, active, now, dt, sink);
        boss.stepRoom(room, active, now, dt, sink);
        waves.stepRoom(room, active, now, sink);

        /* The wave turned over: everyone is told once, and the room is brought
           up to the strength its new wave allows. */
        if (sink.wave) {
            bandits.applyWave(room);
            bandits.fillTo(room, active, sink.wave.cap);
            io.to(code).emit("wave", sink.wave);
            const d = waves.difficultyFor(room);
            console.log("Room", code, "-> wave", sink.wave.n, "(up to",
                sink.wave.cap, "bandits,", d.health, "hp, fire every", d.fireDelay + "ms, back in",
                d.respawnMs + "ms, aim x" + d.spreadScale + ")");
        }

        /* A bandit fired: everyone in the room needs to see the muzzle flash
           and the bullet leave. They draw it from this event - the server keeps
           its own copy of the bullet and is the one that decides what it hits. */
        for (let i = 0; i < sink.shots.length; i++) {
            io.to(code).emit("bandit-shot", sink.shots[i]);
        }

        /* The boss arriving is an event in itself - the clients build the
           model, name the bar and play the roar off this one. */
        /* The mission's own step: what the bullets did to it, the wagon's
           wheels, the ground being held, and the clock. A boss riding in calls
           it off - one fight at a time - and a new wave brings the next one. */
        missions.stepRoom(room, active, now, dt, sink);
        if (sink.missionEnd) finishMission(room, sink.missionEnd);
        if (sink.bossSpawn && room.mission) finishMission(room, missions.cancel(room, "boss"));
        if (sink.wave) startMission(room, now);
        if (sink.missionState && room.mission) io.to(code).emit("mission-state", sink.missionState);

        if (sink.bossSpawn) {
            io.to(code).emit("boss-spawn", sink.bossSpawn);
            console.log("Boss in", code + ":", boss.BOSS_TYPES[sink.bossSpawn.t].name);
        }
        if (sink.bossPhase) {
            io.to(code).emit("boss-phase", sink.bossPhase);
            console.log("Boss in", code + ":", boss.BOSS_TYPES[sink.bossPhase.t].name, "enraged",
                sink.bossPhase.s ? "(" + sink.bossPhase.s + " summoned)" : "");
        }
        for (let i = 0; i < sink.bossShots.length; i++) io.to(code).emit("boss-shot", sink.bossShots[i]);
        for (let i = 0; i < sink.hazards.length; i++) io.to(code).emit("boss-hazard", sink.hazards[i]);
        for (let i = 0; i < sink.booms.length; i++) io.to(code).emit("boss-boom", sink.booms[i]);
        for (let i = 0; i < sink.slams.length; i++) io.to(code).emit("boss-slam", sink.slams[i]);
        // step 31d: nothing fills `blinks` any more - GHOST DASH took VANISH's place
        for (let i = 0; i < sink.blinks.length; i++) io.to(code).emit("boss-blink", sink.blinks[i]);
        for (let i = 0; i < sink.roars.length; i++) io.to(code).emit("boss-roar", sink.roars[i]);
        // step 30b: the skeleton's HIGH NOON - a mark, and how it ended (shot / lost)
        for (let i = 0; i < sink.duels.length; i++) io.to(code).emit("boss-duel", sink.duels[i]);
        // step 30c: its BONE SCATTER - collapse, gone, rise, strike, the blow, done
        for (let i = 0; i < sink.scatters.length; i++) io.to(code).emit("boss-scatter", sink.scatters[i]);
        // step 30d: its BONE HARVEST - summon, spin (a ring each), cut (who it reached), tired, done
        for (let i = 0; i < sink.harvests.length; i++) io.to(code).emit("boss-harvest", sink.harvests[i]);
        // step 31b: the ghost's SPECTRAL SHOT - aim (the flash), done (the round itself is a boss-shot)
        for (let i = 0; i < sink.spectrals.length; i++) io.to(code).emit("boss-spectral", sink.spectrals[i]);
        // step 31c: its GRAVE BURST - raise, cast (the circle), burst, judge (who it got), done
        for (let i = 0; i < sink.graves.length; i++) io.to(code).emit("boss-grave", sink.graves[i]);
        // step 31d: its GHOST DASH - mist, gone, mark (the whirl), appear, dash, hit, recover, done
        for (let i = 0; i < sink.dashes.length; i++) io.to(code).emit("boss-dash", sink.dashes[i]);
        // step 33b: the dragon's EMBER RAIN - takeoff, spit, rain (where and when each lands), hit, hover, land, done
        for (let i = 0; i < sink.embers.length; i++) io.to(code).emit("boss-ember", sink.embers[i]);
        // step 33c: its TAIL SWEEP - charge, sweep, hit (who, and from where they are thrown), recover, done
        for (let i = 0; i < sink.tails.length; i++) io.to(code).emit("boss-tail", sink.tails[i]);

        /* A bullet reached a player. This is where the last piece of trust
           goes away: the server no longer has to believe a client that says it
           was shot, because the server is the one that fired. */
        for (let i = 0; i < sink.hits.length; i++) {
            const h = sink.hits[i];
            const victim = players[h.playerId];
            if (!victim || !victim.alive) continue;
            setHealth(victim, victim.health - h.damage, null, false);
        }

        stepRevives(room, now);
    }

    // Snapshot every other tick: 10 a second
    const tick = tickCount++;
    if ((tick % 2) === 0) {
        for (const code in rooms) {
            const room = rooms[code];
            if (!room.bandits) continue;
            let occupied = false;
            for (const id in players) if (players[id].room === code) { occupied = true; break; }
            if (!occupied) continue;
            /* A won room: the fallen bandits once a second (a latecomer still sees
               them lying there), no boss clock, no wave clock - nothing is coming. */
            if (room.won) {
                if ((tick % 20) === 0) io.to(code).emit("bandits", { b: bandits.snapshot(room) });
                continue;
            }
            io.to(code).emit("bandits", { b: bandits.snapshot(room) });

            /* The boss goes out at the same rate while it is alive, and once a
               second as a countdown while it is not - so a player who walked in
               halfway through sees the same clock as everybody else, and one
               who walked in mid-fight can build the model from this alone. */
            const bs = boss.snapshot(room, now);
            if (bs) {
                io.to(code).emit("boss", { t: room.boss.typeIndex, hp: room.boss.maxHealth, b: bs });
            } else if ((tick % 20) === 0) {
                io.to(code).emit("boss", { in: boss.secondsToBoss(room, now) });
            }

            if ((tick % 20) === 0 && room.scoresDirty) {
                room.scoresDirty = false;
                io.to(code).emit("scores", { s: scoreRows(code) });
            }

            /* Once a second, so somebody who joined mid-wave is looking at the
               same number as everybody else rather than counting on their own. */
            if ((tick % 20) === 0) {
                io.to(code).emit("wave", {
                    n: room.wave || 1,
                    cap: waves.capFor(room),
                    hp: waves.difficultyFor(room).health,
                    in: waves.secondsToWave(room, now)
                });
            }
        }
    }
}, bandits.TICK_MS);

/* =========================================================================
   THE POSITION PACKET

   One broadcast per room, and only for the players who moved since the last
   one - standing still costs nothing at all. Rows are
   [slot, x, y, z, yaw, pitch], rounded to the centimetre and to about half a
   degree, which is finer than anything a player can see at the far end of an
   interpolated body.

   Your own row is in there too. Sending one packet to the room is a single
   serialisation, where excluding yourself would mean building a different
   packet for every listener - the row costs less than the packet would.

   Everything is a whole number: positions in centimetres, angles in hundredths
   of a radian. Not for precision - a centimetre and a third of a degree are
   both far below anything visible on an interpolated body at ten metres - but
   because "-1234" is shorter on the wire than "-12.34", and this packet is
   three quarters of what the game costs to run.
   ========================================================================= */
setInterval(() => {
    for (const code in rooms) {
        let rows = null;
        for (const id in players) {
            const p = players[id];
            if (p.room !== code || !p.moveDirty) continue;
            p.moveDirty = false;
            (rows || (rows = [])).push([
                p.slot,
                Math.round(p.x * 100), Math.round(p.y * 100), Math.round(p.z * 100),
                Math.round(p.yaw * 100), Math.round(p.pitch * 100)
            ]);
        }
        if (rows) io.to(code).emit("players", { m: rows });
    }
}, Math.round(1000 / MOVE_SEND_HZ));

const PORT = process.env.PORT || 3000;

// before the port opens, so no player's first seconds pay for cold code
const warmMs = nav.warmUp();

server.listen(PORT, "0.0.0.0", () => {
    console.log("Server running on port " + PORT);
    console.log("Rooms enabled. Lobby:", PUBLIC_ROOM, "| default mode:", MODES[DEFAULT_MODE].label);
    console.log("Room limit:", ROOM_LIMIT, "players - lobby included, up to",
        MAX_LOBBIES, "lobbies opened on demand");
    console.log("Positions batched:", MOVE_SEND_HZ, "packets a second per room, by slot");
    console.log("Map loaded:", mapData.FINGERPRINT, "|", mapData.COLLIDERS.length, "colliders |",
        nav.blockedCount(), "blocked navigation cells");
    const reg = nav.regionReport();
    console.log("Navigation:", reg.regions, "regions - town", reg.town, "cells, sealed off:",
        reg.others.join(", "), "| pathfinder warmed in", warmMs + "ms, budget",
        nav.PATH_BUDGET, "cells a tick");
    console.log("Bandits simulated here:", bandits.BANDIT.startCount, "to start, one more every",
        (bandits.BANDIT.spawnEveryMs / 1000) + "s");
    console.log("Waves:", (waves.WAVE.everyMs / 1000) + "s each,", waves.WAVE.startCap,
        "bandits in wave 1, +" + waves.WAVE.perWave, "a wave, up to", waves.WAVE.maxCap);
    console.log("Boss simulated here:", boss.BOSS_TYPES.length, "of them, one every",
        (boss.BOSS.firstBossMs / 1000) + "s");
});
