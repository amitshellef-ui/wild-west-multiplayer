/* =========================================================================
   BANDITS - server side (step 11b)

   Until now every player simulated their own bandits, which meant nobody was
   ever fighting the same enemy: you shot a bandit your friend could not see,
   standing where his bandit was not. Now one simulation runs here, per room,
   and the clients only draw what it reports.

   What lives here: spawning, pathing, chasing and dying.
   What does not, yet: bandits shooting back, the boss, and waves. Those are
   the next step, so for now a bandit will hunt you down and then stand there.

   The movement rules are the same ones the browser used - same speeds, same
   repath interval, same stuck recovery - so the bandits behave the way the
   game always felt, just from one authority instead of several.
   ========================================================================= */
const nav = require("./navigation");

const BANDIT = {
    maxHealth: 100,
    radius: 0.5,
    eyeHeight: 1.62,
    chaseSpeed: 3.4,
    patrolSpeed: 3.4 * 0.55,
    sightRange: 55,
    engageRange: 42,
    keepDistance: 11,          // stops closing in once this near
    respawnMs: 2600,
    startCount: 3,
    spawnEveryMs: 15000,
    maxAlive: 12
};

const TICK_MS = 50;            // 20 simulation steps a second

/* ---- Room lifecycle ---------------------------------------------------- */
function initRoom(room) {
    room.bandits = {};
    room.nextBanditId = 1;
    room.nextSpawnAt = Date.now() + BANDIT.spawnEveryMs;
    for (let i = 0; i < BANDIT.startCount; i++) spawnBandit(room);
}

function banditList(room) {
    return Object.keys(room.bandits).map((id) => room.bandits[id]);
}

function aliveCount(room) {
    let n = 0;
    for (const id in room.bandits) if (room.bandits[id].alive) n++;
    return n;
}

/* Somewhere walkable, and not on top of a player. */
function pickBanditSpawn(room, players) {
    for (let attempt = 0; attempt < 60; attempt++) {
        const p = nav.randomNavPoint();
        let tooClose = false;
        for (const id in players) {
            const pl = players[id];
            if (pl.room !== room.code) continue;
            if (Math.hypot(pl.x - p.x, pl.z - p.z) < 18) { tooClose = true; break; }
        }
        if (!tooClose) return p;
    }
    return nav.randomNavPoint();
}

function spawnBandit(room, players) {
    const p = pickBanditSpawn(room, players || {});
    const id = room.nextBanditId++;
    room.bandits[id] = {
        id: id,
        x: p.x, z: p.z,
        yaw: Math.random() * Math.PI * 2,
        health: BANDIT.maxHealth,
        alive: true,
        state: "patrol",
        path: null,
        pathIndex: 0,
        repathAt: 0,
        losAt: 0,
        hasLos: false,
        targetId: null,
        patrolTarget: null,
        respawnAt: 0,
        stuckCheckAt: 0,
        lastX: p.x,
        lastZ: p.z,
        moving: false,
        strafeAt: 0,
        strafeDir: Math.random() > 0.5 ? 1 : -1
    };
    return room.bandits[id];
}

/* ---- Movement ---------------------------------------------------------- */
function moveAxis(b, dx, dz) {
    if (dx !== 0 && !nav.collidesAt(b.x + dx, b.z, BANDIT.radius)) b.x += dx;
    if (dz !== 0 && !nav.collidesAt(b.x, b.z + dz, BANDIT.radius)) b.z += dz;
}

/* Bandits push each other apart so a group does not collapse into one body. */
function separate(room, b) {
    for (const id in room.bandits) {
        const o = room.bandits[id];
        if (o === b || !o.alive) continue;
        const dx = b.x - o.x, dz = b.z - o.z;
        const d2 = dx * dx + dz * dz;
        const minD = BANDIT.radius * 3.4;
        if (d2 > 0.0001 && d2 < minD * minD) {
            const d = Math.sqrt(d2);
            const push = (minD - d) * 0.5;
            moveAxis(b, (dx / d) * push, (dz / d) * push);
        }
    }
}

/* The closest living player in this room, or null if the room is empty. */
function nearestPlayer(room, players, fromX, fromZ) {
    let best = null, bestD = Infinity;
    for (const id in players) {
        const p = players[id];
        if (p.room !== room.code || !p.alive) continue;
        const d = Math.hypot(p.x - fromX, p.z - fromZ);
        if (d < bestD) { bestD = d; best = p; }
    }
    return best ? { player: best, dist: bestD } : null;
}

function stepBandit(room, b, players, now, dt) {
    if (!b.alive) {
        if (b.respawnAt && now >= b.respawnAt) {
            const p = pickBanditSpawn(room, players);
            b.x = p.x; b.z = p.z;
            b.health = BANDIT.maxHealth;
            b.alive = true;
            b.state = "patrol";
            b.path = null;
            b.respawnAt = 0;
            b.lastX = b.x; b.lastZ = b.z;
        }
        return;
    }

    const near = nearestPlayer(room, players, b.x, b.z);

    /* --- can it see anyone? checked a few times a second, not every tick --- */
    if (now >= b.losAt) {
        b.losAt = now + 180 + Math.random() * 100;
        if (near && near.dist < BANDIT.sightRange) {
            b.hasLos = nav.losClear(b.x, b.z, near.player.x, near.player.z);
        } else {
            b.hasLos = false;
        }
        if (b.hasLos && near && near.dist < BANDIT.engageRange) {
            b.state = "chase";
            b.targetId = near.player.id;
        } else if (b.state === "chase" && (!near || near.dist > 60)) {
            b.state = "patrol";
            b.targetId = null;
        }
    }

    /* --- where is it trying to get to? --- */
    let goal = null, wantsMove = true;
    if (b.state === "chase" && near) {
        goal = { x: near.player.x, z: near.player.z };
        if (b.hasLos && near.dist < BANDIT.keepDistance + 4 && near.dist > BANDIT.keepDistance - 4) {
            wantsMove = false;
        }
    } else {
        if (!b.patrolTarget || Math.hypot(b.patrolTarget.x - b.x, b.patrolTarget.z - b.z) < 2.2) {
            b.patrolTarget = nav.randomNavPoint();
            b.path = null;
        }
        goal = b.patrolTarget;
    }

    /* --- routing --- */
    if (now >= b.repathAt || !b.path) {
        b.repathAt = now + 450 + Math.random() * 350;
        if (nav.lineClear(b.x, b.z, goal.x, goal.z)) {
            b.path = [{ x: goal.x, z: goal.z }];
            b.pathIndex = 0;
        } else {
            b.path = nav.findPath(b.x, b.z, goal.x, goal.z);
            b.pathIndex = 0;
        }
    }

    /* --- walking --- */
    const speed = b.state === "chase" ? BANDIT.chaseSpeed : BANDIT.patrolSpeed;
    let moved = false;
    if (wantsMove && b.path && b.pathIndex < b.path.length) {
        const wp = b.path[b.pathIndex];
        const dx = wp.x - b.x, dz = wp.z - b.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.0) {
            b.pathIndex++;
        } else {
            const step = speed * dt;
            moveAxis(b, (dx / d) * step, (dz / d) * step);
            moved = true;
        }
    }
    /* Holding position does not mean standing still. A bandit that has closed
       to its preferred range sidesteps instead, the way it always did in the
       browser - otherwise it freezes into a target dummy. */
    if (!moved && b.state === "chase" && near && b.hasLos) {
        if (now >= b.strafeAt) {
            b.strafeAt = now + 1100 + Math.random() * 1800;
            b.strafeDir *= -1;
        }
        const tx = near.player.x - b.x, tz = near.player.z - b.z;
        const len = Math.hypot(tx, tz) || 1;
        const px = -tz / len, pz = tx / len;
        const back = near.dist < BANDIT.keepDistance - 3 ? -1 : 0;
        const step = speed * 0.65 * dt;
        moveAxis(b,
            px * step * b.strafeDir + (tx / len) * step * back,
            pz * step * b.strafeDir + (tz / len) * step * back);
        moved = true;
    }

    separate(room, b);
    b.moving = moved;

    /* --- stuck recovery: same idea as the browser had --- */
    if (now >= b.stuckCheckAt) {
        b.stuckCheckAt = now + 800;
        if (moved && Math.hypot(b.x - b.lastX, b.z - b.lastZ) < 0.22) {
            const spot = nav.randomNavPoint();
            b.path = null;
            b.repathAt = 0;
            // a short hop rather than a teleport across the map
            if (Math.hypot(spot.x - b.x, spot.z - b.z) < 6) { b.x = spot.x; b.z = spot.z; }
        }
        b.lastX = b.x; b.lastZ = b.z;
    }

    /* --- facing --- */
    let faceX, faceZ;
    if (b.state === "chase" && near) { faceX = near.player.x; faceZ = near.player.z; }
    else if (b.path && b.path[b.pathIndex]) { faceX = b.path[b.pathIndex].x; faceZ = b.path[b.pathIndex].z; }
    if (faceX !== undefined) {
        const want = Math.atan2(faceX - b.x, faceZ - b.z);
        let d = want - b.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        b.yaw += d * Math.min(1, 9 * dt);
    }
}

function stepRoom(room, players, now, dt) {
    if (!room.bandits) initRoom(room);

    // reinforcements keep coming, but only while somebody is there to fight
    let occupied = false;
    for (const id in players) if (players[id].room === room.code) { occupied = true; break; }
    if (!occupied) return;

    if (now >= room.nextSpawnAt) {
        room.nextSpawnAt = now + BANDIT.spawnEveryMs;
        if (Object.keys(room.bandits).length < BANDIT.maxAlive) spawnBandit(room, players);
    }

    for (const id in room.bandits) stepBandit(room, room.bandits[id], players, now, dt);
}

/* What the clients need in order to draw them. Kept short on purpose: this
   goes out several times a second to everyone in the room. */
function snapshot(room) {
    const out = [];
    for (const id in room.bandits) {
        const b = room.bandits[id];
        out.push([
            b.id,
            Math.round(b.x * 100) / 100,
            Math.round(b.z * 100) / 100,
            Math.round(b.yaw * 100) / 100,
            Math.round(b.health),
            b.alive ? (b.state === "chase" ? 2 : 1) : 0
        ]);
    }
    return out;
}

function hurt(room, banditId, amount) {
    const b = room.bandits && room.bandits[banditId];
    if (!b || !b.alive) return null;
    b.health -= amount;
    if (b.health <= 0) {
        b.health = 0;
        b.alive = false;
        b.respawnAt = Date.now() + BANDIT.respawnMs;
        b.path = null;
        return { killed: true, bandit: b };
    }
    // being shot at makes them come looking
    b.state = "chase";
    return { killed: false, bandit: b };
}

module.exports = { BANDIT, TICK_MS, initRoom, stepRoom, snapshot, hurt, aliveCount, banditList };
