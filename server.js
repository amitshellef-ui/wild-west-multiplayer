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
   never invents a player - it only reacts to these three events:

     welcome       -> sent to the newcomer alone: your id + everyone present
     player-joined -> sent to everyone else when someone arrives
     player-left   -> sent to everyone when someone disconnects

   Position, rotation and combat state come in later steps; right now a player
   record is only an identity.
   ========================================================================= */
const players = {};   // socket.id -> player record

function playerList() {
    return Object.keys(players).map((id) => players[id]);
}

io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);

    players[socket.id] = {
        id: socket.id,
        joinedAt: Date.now()
    };

    // The newcomer gets their own id plus the full roster (themselves included)
    socket.emit("welcome", {
        id: socket.id,
        players: playerList()
    });

    // Everyone already in the game hears about the new arrival
    socket.broadcast.emit("player-joined", players[socket.id]);

    console.log("Players online:", Object.keys(players).length);

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
