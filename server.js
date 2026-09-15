const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// The short URL should open the game instead of returning 404
app.get("/", (req, res) => {
    res.redirect("/wild-west-fps-arsenal.html");
});

/* =========================================================================
   PLAYER REGISTRY

   The server is the single source of truth for who is in the game, how much
   health they have, and when they die. A client never invents a player and
   never decides its own death - it only reacts to these events:

     welcome        -> the newcomer alone: your id + everyone present
     player-joined  -> everyone else, when someone arrives
     player-left    -> everyone, when someone disconnects
     player-moved   -> everyone else, when someone moves          (step 3+4)
     player-shot    -> everyone else, when someone fires           (step 7)
     player-health  -> everyone, whenever a health value changes   (step 8+9)
     player-died    -> everyone, when health reaches zero          (step 8+9)
     player-respawn -> everyone, when a dead player comes back     (step 8+9)

   A player record carries its own transform, so welcome and player-joined
   already tell a newcomer where everybody is standing and how hurt they are.
   ========================================================================= */
const players = {};   // socket.id -> player record

const MAX_HEALTH = 100;
const RESPAWN_MS = 4000;

/* =========================================================================
   GAME MODES

   Everything that differs between modes lives here, so adding one later is a
   new entry rather than a hunt through the file. The active mode is sent to
   every client in the welcome payload, and the client uses it to decide what
   its bullets are allowed to collide with in the first place.
   ========================================================================= */
const MODES = {
    coop: { id: "coop", label: "CO-OP", friendlyFire: false },
    ffa: { id: "ffa", label: "FREE FOR ALL", friendlyFire: true }
};
const MODE = MODES.coop;

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

function playerList() {
    return Object.keys(players).map((id) => players[id]);
}

function pickSpawn() {
    return SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
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

/* ---- Health ---- */
function setHealth(p, value, attackerId, headshot) {
    p.health = Math.max(0, Math.min(MAX_HEALTH, value));
    io.emit("player-health", {
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

    io.emit("player-died", {
        id: victim.id,
        by: killer ? killer.id : null,
        respawnIn: RESPAWN_MS
    });
    console.log("Kill:", (killer ? killer.id.slice(0, 6) : "bots/world"), "->", victim.id.slice(0, 6));

    setTimeout(() => {
        const p = players[victim.id];
        if (!p || p.alive) return;           // left, or already brought back
        const s = pickSpawn();
        p.x = s[0]; p.y = 1.72; p.z = s[1];
        p.yaw = Math.random() * Math.PI * 2;
        p.pitch = 0;
        p.health = MAX_HEALTH;
        p.alive = true;
        io.emit("player-respawn", {
            id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, health: p.health
        });
    }, RESPAWN_MS);
}

io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);

    const spawn = pickSpawn();
    players[socket.id] = {
        id: socket.id,
        joinedAt: Date.now(),
        x: spawn[0], y: 1.72, z: spawn[1],
        yaw: 0, pitch: 0,
        movedAt: Date.now(),
        health: MAX_HEALTH,
        alive: true,
        kills: 0,
        deaths: 0,
        lastHitAt: 0,
        lastDeltaAt: 0
    };

    socket.emit("welcome", { id: socket.id, mode: MODE, players: playerList() });
    socket.broadcast.emit("player-joined", players[socket.id]);
    console.log("Players online:", Object.keys(players).length);

    /* ---- Position + rotation relay (steps 3 and 4) ---- */
    socket.on("move", (m) => {
        const p = players[socket.id];
        if (!p) return;
        const move = readMove(m);
        if (!move) return;
        p.x = move.x; p.y = move.y; p.z = move.z;
        p.yaw = move.yaw; p.pitch = move.pitch;
        p.movedAt = Date.now();
        socket.broadcast.emit("player-moved", {
            id: socket.id,
            x: move.x, y: move.y, z: move.z,
            yaw: move.yaw, pitch: move.pitch
        });
    });

    /* ---- Shot relay (step 7): muzzle flash, tracers and sound only ---- */
    socket.on("shoot", (m) => {
        if (!players[socket.id]) return;
        const shot = readShot(m);
        if (!shot) return;
        socket.broadcast.emit("player-shot", {
            id: socket.id, w: shot.w, o: shot.o, e: shot.e
        });
    });

    /* =====================================================================
       HITS ON OTHER PLAYERS (step 8)

       The client says who it hit and with how many pellets; the server owns
       what that costs. Checked before anything is applied:
         - shooter and victim both exist and are alive
         - one damage report per weapon cooldown (a burst cannot be replayed)
         - pellet count fits the weapon
         - the victim is inside the weapon's range

       Line of sight is deliberately not checked: doing it honestly needs the
       map geometry on the server, which arrives with step 11. Until then a
       determined cheater can still claim a hit through a wall - but not an
       impossible weapon, an impossible rate, or an impossible distance.
       ===================================================================== */
    socket.on("hit", (m) => {
        // In a co-operative mode players cannot hurt each other at all. Enforced
        // here and not only on the client, so a modified client cannot shoot its
        // team mates either.
        if (!MODE.friendlyFire) return;

        const shooter = players[socket.id];
        if (!shooter || !shooter.alive) return;
        if (!m || typeof m !== "object") return;

        if (typeof m.w !== "number" || (m.w | 0) !== m.w || m.w < 0 || m.w >= WEAPONS.length) return;
        const w = WEAPONS[m.w];

        const now = Date.now();
        if (now - shooter.lastHitAt < w.fireCd * 0.7) return;   // rate limit, with jitter slack

        if (!Array.isArray(m.targets) || m.targets.length === 0 || m.targets.length > 8) return;

        // First pass: validate everything and total the pellets
        const accepted = [];
        let pellets = 0;
        for (let i = 0; i < m.targets.length; i++) {
            const t = m.targets[i];
            if (!t || typeof t.id !== "string") continue;
            const victim = players[t.id];
            if (!victim || !victim.alive || victim.id === shooter.id) continue;

            const body = strictCount(t.body, w.pellets);
            const head = strictCount(t.head, w.pellets);
            if (body < 0 || head < 0) return;        // impossible claim: drop the packet
            if (body + head <= 0) continue;

            if (distanceBetween(shooter, victim) > w.range * 1.15 + 3) continue;

            pellets += body + head;
            accepted.push({ victim: victim, body: body, head: head });
        }
        // One trigger pull can never land more pellets than the weapon fires.
        // The winchester's boss reward throws two extra rays; they simply do not
        // count against players, which is cheaper than trusting a client to say
        // whether it has earned the reward.
        if (accepted.length === 0 || pellets > w.pellets) return;

        shooter.lastHitAt = now;

        // Second pass: apply
        for (let i = 0; i < accepted.length; i++) {
            const a = accepted[i];
            const damage = a.body * w.body + a.head * w.head;
            setHealth(a.victim, a.victim.health - damage, shooter.id, a.head > 0);
        }
    });

    /* =====================================================================
       LOCAL DAMAGE AND HEALING (step 9)

       Bandits, the boss and out-of-combat regeneration all still run on the
       client, so the server cannot see them. The client batches the net change
       and reports it, which keeps the authoritative health value honest enough
       for player-versus-player to work.

       This part is trusted, and it is the one hole left: a modified client
       could under-report bandit damage. It closes in step 11, when the bots
       themselves move to the server. The caps below at least stop the absurd
       cases - no instant full heal, no more than a few reports a second.
       ===================================================================== */
    socket.on("health-delta", (m) => {
        const p = players[socket.id];
        if (!p || !p.alive) return;
        if (!m || typeof m.d !== "number" || !Number.isFinite(m.d)) return;

        const now = Date.now();
        if (now - p.lastDeltaAt < 200) return;      // at most 5 a second
        p.lastDeltaAt = now;

        const d = Math.max(-MAX_HEALTH, Math.min(20, m.d));
        if (d === 0) return;
        setHealth(p, p.health + d, null, false);
    });

    socket.on("disconnect", () => {
        console.log("Player disconnected:", socket.id);
        delete players[socket.id];
        io.emit("player-left", { id: socket.id });
        console.log("Players online:", Object.keys(players).length);
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
    console.log("Game mode:", MODE.label, "| friendly fire:", MODE.friendlyFire);
});
