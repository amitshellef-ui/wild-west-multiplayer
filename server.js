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
   PLAYER REGISTRY (multiplayer, step 2)

   The server is the single source of truth for who is in the game. A client
   never invents a player - it only reacts to these events:

     welcome       -> sent to the newcomer alone: your id + everyone present
     player-joined -> sent to everyone else when someone arrives
     player-left   -> sent to everyone when someone disconnects
     player-moved  -> sent to everyone else when someone moves (step 3+4)

   A player record carries its own transform, so welcome and player-joined
   already tell a newcomer where everybody is standing. Without that, remote
   players would be invisible until the moment they happen to move.
   ========================================================================= */
const players = {};   // socket.id -> player record

// Where a fresh player stands until their first update arrives
const SPAWN = { x: 0, y: 1.72, z: 3, yaw: 0, pitch: 0 };

function playerList() {
    return Object.keys(players).map((id) => players[id]);
}

/* Movement packets come straight off the wire, so nothing is trusted: every
   field must be present and be a finite number, or the packet is dropped.
   Real anti-cheat (speed limits, hit validation) comes with server authority
   in a later step - this is only structural validation. */
const MOVE_FIELDS = ["x", "y", "z", "yaw", "pitch"];

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

io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);

    players[socket.id] = {
        id: socket.id,
        joinedAt: Date.now(),
        x: SPAWN.x, y: SPAWN.y, z: SPAWN.z,
        yaw: SPAWN.yaw, pitch: SPAWN.pitch,
        movedAt: Date.now()
    };

    // The newcomer gets their own id plus the full roster (themselves included)
    socket.emit("welcome", {
        id: socket.id,
        players: playerList()
    });

    // Everyone already in the game hears about the new arrival
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

        // Relayed to everyone except the sender, who already knows
        socket.broadcast.emit("player-moved", {
            id: socket.id,
            x: move.x, y: move.y, z: move.z,
            yaw: move.yaw, pitch: move.pitch
        });
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
});
