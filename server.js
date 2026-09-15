const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const mapData = require("./map-data");
const nav = require("./navigation");
const bandits = require("./bandits");
const boss = require("./boss");
const waves = require("./waves");

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
const ROOM_LIMIT = 8;                  // players per private room

const rooms = {};                      // code -> room record
const players = {};                    // socket.id -> player record

function createRoom(code, modeId) {
    rooms[code] = {
        code: code,
        mode: MODES[modeId] || MODES[DEFAULT_MODE],
        createdAt: Date.now()
    };
    bandits.initRoom(rooms[code]);
    boss.initRoom(rooms[code]);
    waves.initRoom(rooms[code]);
    return rooms[code];
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
        .map((id) => players[id]);
}

function roomCount(code) {
    let n = 0;
    for (const id in players) if (players[id].room === code) n++;
    return n;
}

/* A private room disappears once the last person walks out of it. */
function dropRoomIfEmpty(code) {
    if (code === PUBLIC_ROOM) return;
    if (roomCount(code) === 0 && rooms[code]) {
        delete rooms[code];
        console.log("Room closed:", code);
    }
}

const MAX_HEALTH = 100;
const RESPAWN_MS = 4000;

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
    p.health = Math.max(0, Math.min(MAX_HEALTH, value));
    io.to(p.room).emit("player-health", {
        id: p.id,
        health: p.health,
        by: attackerId || null,
        headshot: !!headshot
    });
    if (p.health <= 0 && p.alive) kill(p, attackerId);
}

function kill(victim, attackerId) {
    victim.alive = false;
    victim.deaths++;
    const killer = attackerId ? players[attackerId] : null;
    if (killer && killer.id !== victim.id) killer.kills++;

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
        const s = pickSpawn(rooms[p.room]);
        p.x = s[0]; p.y = 1.72; p.z = s[1];
        p.yaw = Math.random() * Math.PI * 2;
        p.pitch = 0;
        p.health = MAX_HEALTH;
        p.alive = true;
        io.to(p.room).emit("player-respawn", {
            id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, health: p.health
        });
    }, RESPAWN_MS);
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

    if (roomWasEmpty && rooms[code]) {
        bandits.initRoom(rooms[code]);
        boss.initRoom(rooms[code]);
        waves.initRoom(rooms[code]);
        console.log("Room", code, "was empty - back to wave 1:", bandits.BANDIT.startCount,
            "bandits, up to", waves.capFor(rooms[code]),
            "| boss in", (boss.BOSS.firstBossMs / 1000) + "s");
    }

    // A fresh start in the new room, so nobody arrives already hurt or dead
    const s = pickSpawn(rooms[code]);
    p.x = s[0]; p.y = 1.72; p.z = s[1];
    p.yaw = 0; p.pitch = 0;
    p.health = MAX_HEALTH;
    p.alive = true;

    socket.emit("room-joined", {
        code: code,
        mode: rooms[code].mode,
        players: playersIn(code),
        wave: rooms[code].wave || 1,
        cap: waves.capFor(rooms[code])
    });
    socket.to(code).emit("player-joined", p);

    if (previous) dropRoomIfEmpty(previous);
    console.log("Player", p.id.slice(0, 6), "->", code, "(" + roomCount(code) + " inside)");
}

io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);

    const spawn = pickSpawn();
    players[socket.id] = {
        id: socket.id,
        joinedAt: Date.now(),
        room: null,
        x: spawn[0], y: 1.72, z: spawn[1],
        yaw: 0, pitch: 0,
        movedAt: Date.now(),
        health: MAX_HEALTH,
        alive: true,
        kills: 0,
        deaths: 0,
        lastHitAt: 0,
        lastBanditHitAt: 0,
        lastBossHitAt: 0,
        lastDeltaAt: 0,
        lastRoomAt: 0
    };
    const me = players[socket.id];

    /* A shared link carries its room code in the connection query, so a friend
       who clicks it lands straight inside instead of in the lobby. */
    const wanted = readCode(socket.handshake.query && socket.handshake.query.room);
    const startRoom = (wanted && rooms[wanted]) ? wanted : PUBLIC_ROOM;

    socket.emit("welcome", { id: socket.id });
    placeInRoom(socket, me, startRoom);

    /* ---- Room controls ---- */
    socket.on("create-room", (m) => {
        const p = players[socket.id];
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
        const p = players[socket.id];
        if (!p) return;
        const now = Date.now();
        if (now - p.lastRoomAt < 1000) return;
        p.lastRoomAt = now;

        const code = readCode(m && m.code);
        if (!code) { socket.emit("room-error", { reason: "BAD_CODE" }); return; }
        if (!rooms[code]) { socket.emit("room-error", { reason: "NO_SUCH_ROOM", code: code }); return; }
        if (code === p.room) { socket.emit("room-error", { reason: "ALREADY_HERE", code: code }); return; }
        if (code !== PUBLIC_ROOM && roomCount(code) >= ROOM_LIMIT) {
            socket.emit("room-error", { reason: "ROOM_FULL", code: code });
            return;
        }
        placeInRoom(socket, p, code);
    });

    socket.on("leave-room", () => {
        const p = players[socket.id];
        if (!p || p.room === PUBLIC_ROOM) return;
        const now = Date.now();
        if (now - p.lastRoomAt < 1000) return;
        p.lastRoomAt = now;
        placeInRoom(socket, p, PUBLIC_ROOM);
    });

    /* ---- Position + rotation relay (steps 3 and 4) ---- */
    socket.on("move", (m) => {
        const p = players[socket.id];
        if (!p || !p.room) return;
        const move = readMove(m);
        if (!move) return;
        p.x = move.x; p.y = move.y; p.z = move.z;
        p.yaw = move.yaw; p.pitch = move.pitch;
        p.movedAt = Date.now();
        socket.to(p.room).emit("player-moved", {
            id: socket.id,
            x: move.x, y: move.y, z: move.z,
            yaw: move.yaw, pitch: move.pitch
        });
    });

    /* ---- Shot relay (step 7): muzzle flash, tracers and sound only ---- */
    socket.on("shoot", (m) => {
        const p = players[socket.id];
        if (!p || !p.room) return;
        const shot = readShot(m);
        if (!shot) return;
        socket.to(p.room).emit("player-shot", {
            id: socket.id, w: shot.w, o: shot.o, e: shot.e
        });
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

       Line of sight is deliberately not checked: doing it honestly needs the
       map geometry on the server, which arrives with the shared bots.
       ===================================================================== */
    socket.on("hit", (m) => {
        const shooter = players[socket.id];
        if (!shooter || !shooter.alive || !shooter.room) return;

        const room = rooms[shooter.room];
        if (!room || !room.mode.friendlyFire) return;   // co-operative: nothing to do

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
            if (!victim || !victim.alive || victim.id === shooter.id) continue;
            if (victim.room !== shooter.room) continue;       // no shooting across rooms

            const body = strictCount(t.body, w.pellets);
            const head = strictCount(t.head, w.pellets);
            if (body < 0 || head < 0) return;
            if (body + head <= 0) continue;

            if (distanceBetween(shooter, victim) > w.range * 1.15 + 3) continue;

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
        const shooter = players[socket.id];
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
        const shooter = players[socket.id];
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

        shooter.lastBossHitAt = now;
        const typeIndex = b.typeIndex;
        const res = boss.hurt(room, body * w.body + head * w.head, now);
        if (res && res.killed) {
            shooter.kills++;
            /* Winning is worth a wave. The browser did this too - it is the
               reason the number moves at all when a fight runs long. */
            const up = waves.advance(room, players, now, "boss");
            bandits.fillTo(room, players, up.cap);
            io.to(room.code).emit("wave", up);
            io.to(room.code).emit("boss-died", {
                by: shooter.id, t: typeIndex,
                x: Math.round(res.boss.x * 100) / 100,
                z: Math.round(res.boss.z * 100) / 100,
                headshot: head > 0,
                nextIn: boss.BOSS.nextBossMs
            });
            console.log("Boss down:", res.boss.type.name, "in", room.code,
                "by", shooter.id.slice(0, 6));
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
        const p = players[socket.id];
        if (!p || !p.alive) return;
        if (!m || typeof m.d !== "number" || !Number.isFinite(m.d)) return;

        const now = Date.now();
        if (now - p.lastDeltaAt < 200) return;
        p.lastDeltaAt = now;

        const d = Math.max(-MAX_HEALTH, Math.min(20, m.d));
        if (d === 0) return;
        setHealth(p, p.health + d, null, false);
    });

    socket.on("disconnect", () => {
        const p = players[socket.id];
        const room = p ? p.room : null;
        console.log("Player disconnected:", socket.id);
        delete players[socket.id];
        if (room) {
            io.to(room).emit("player-left", { id: socket.id });
            dropRoomIfEmpty(room);
        }
    });
});

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

    for (const code in rooms) {
        const room = rooms[code];

        /* One sink for both simulations. The bandits and the boss share the
           room's bullet list, so they also share the list of what those
           bullets did - the server applies all of it in one place below. */
        const sink = boss.emptySink();
        bandits.stepRoom(room, players, now, dt, sink);
        boss.stepRoom(room, players, now, dt, sink);
        waves.stepRoom(room, players, now, sink);

        /* The wave turned over: everyone is told once, and the room is brought
           up to the strength its new wave allows. */
        if (sink.wave) {
            bandits.fillTo(room, players, sink.wave.cap);
            io.to(code).emit("wave", sink.wave);
            console.log("Room", code, "-> wave", sink.wave.n, "(up to",
                sink.wave.cap, "bandits)");
        }

        /* A bandit fired: everyone in the room needs to see the muzzle flash
           and the bullet leave. They draw it from this event - the server keeps
           its own copy of the bullet and is the one that decides what it hits. */
        for (let i = 0; i < sink.shots.length; i++) {
            io.to(code).emit("bandit-shot", sink.shots[i]);
        }

        /* The boss arriving is an event in itself - the clients build the
           model, name the bar and play the roar off this one. */
        if (sink.bossSpawn) {
            io.to(code).emit("boss-spawn", sink.bossSpawn);
            console.log("Boss in", code + ":", boss.BOSS_TYPES[sink.bossSpawn.t].name);
        }
        for (let i = 0; i < sink.bossShots.length; i++) io.to(code).emit("boss-shot", sink.bossShots[i]);
        for (let i = 0; i < sink.hazards.length; i++) io.to(code).emit("boss-hazard", sink.hazards[i]);
        for (let i = 0; i < sink.booms.length; i++) io.to(code).emit("boss-boom", sink.booms[i]);
        for (let i = 0; i < sink.slams.length; i++) io.to(code).emit("boss-slam", sink.slams[i]);
        for (let i = 0; i < sink.blinks.length; i++) io.to(code).emit("boss-blink", sink.blinks[i]);
        for (let i = 0; i < sink.roars.length; i++) io.to(code).emit("boss-roar", sink.roars[i]);

        /* A bullet reached a player. This is where the last piece of trust
           goes away: the server no longer has to believe a client that says it
           was shot, because the server is the one that fired. */
        for (let i = 0; i < sink.hits.length; i++) {
            const h = sink.hits[i];
            const victim = players[h.playerId];
            if (!victim || !victim.alive) continue;
            setHealth(victim, victim.health - h.damage, null, false);
        }
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

            /* Once a second, so somebody who joined mid-wave is looking at the
               same number as everybody else rather than counting on their own. */
            if ((tick % 20) === 0) {
                io.to(code).emit("wave", {
                    n: room.wave || 1,
                    cap: waves.capFor(room),
                    in: waves.secondsToWave(room, now)
                });
            }
        }
    }
}, bandits.TICK_MS);

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
    console.log("Server running on port " + PORT);
    console.log("Rooms enabled. Lobby:", PUBLIC_ROOM, "| default mode:", MODES[DEFAULT_MODE].label);
    console.log("Map loaded:", mapData.FINGERPRINT, "|", mapData.COLLIDERS.length, "colliders |",
        nav.blockedCount(), "blocked navigation cells");
    console.log("Bandits simulated here:", bandits.BANDIT.startCount, "to start, one more every",
        (bandits.BANDIT.spawnEveryMs / 1000) + "s");
    console.log("Waves:", (waves.WAVE.everyMs / 1000) + "s each,", waves.WAVE.startCap,
        "bandits in wave 1, +" + waves.WAVE.perWave, "a wave, up to", waves.WAVE.maxCap);
    console.log("Boss simulated here:", boss.BOSS_TYPES.length, "of them, one every",
        (boss.BOSS.firstBossMs / 1000) + "s");
});
