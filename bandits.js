/* =========================================================================
   BANDITS - server side (step 11b)

   Until now every player simulated their own bandits, which meant nobody was
   ever fighting the same enemy: you shot a bandit your friend could not see,
   standing where his bandit was not. Now one simulation runs here, per room,
   and the clients only draw what it reports.

   What lives here: spawning, pathing, chasing, shooting and dying. The boss
   is its own module next door, and shares this file's bullet list.
   What does not, yet: the wave timer.

   Their bullets travel rather than hitting instantly, exactly as they did in
   the browser, because being able to see a shot coming and step out of its way
   is most of what the fight feels like. The server moves them and decides what
   they hit; the clients are told where each one started and draw it flying.

   The movement rules are the same ones the browser used - same speeds, same
   repath interval, same stuck recovery - so the bandits behave the way the
   game always felt, just from one authority instead of several.
   ========================================================================= */
const nav = require("./navigation");
const waves = require("./waves");

/* The numbers below are the wave 1 bandit. Health, respawn time, rate of fire
   and aim all tighten as the room's wave climbs - see DIFFICULTY in waves.js,
   which is what the code reads; these stay as the reference point. */
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
    /* How many may be alive at once is not a constant any more - it is what the
       room's current wave allows. See waves.js. */

    /* Shooting - the same numbers the browser used */
    fireDelay: 1750,
    fireRange: 38,
    aimSpread: 0.035,          // grows with distance, see fire()
    spreadPerMetre: 0.0016,
    bulletSpeed: 42,
    bulletDamage: 10,
    bulletLife: 3.5,
    hitRadius: 0.62
};

const TICK_MS = 50;            // 20 simulation steps a second

/* ---- Room lifecycle ---------------------------------------------------- */
function initRoom(room) {
    room.bandits = {};
    room.bullets = [];
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
    const hp = waves.difficultyFor(room).health;
    room.bandits[id] = {
        id: id,
        x: p.x, z: p.z,
        yaw: Math.random() * Math.PI * 2,
        health: hp,
        maxHealth: hp,
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
        wedgedFor: 0,
        strafeDir: Math.random() > 0.5 ? 1 : -1,
        lastShot: Date.now() + Math.random() * 1200
    };
    return room.bandits[id];
}

/* ---- Shooting ----------------------------------------------------------
   A bullet is aimed at where the player is standing now, with a spread that
   widens with range, and then it is on its own: it does not steer. Walking
   sideways beats it, which is the point. */
function fire(room, b, target, sink) {
    const ox = b.x, oy = BANDIT.eyeHeight, oz = b.z;
    const tx = target.x, ty = target.y || 1.72, tz = target.z;

    let dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;

    const dist = Math.hypot(tx - ox, tz - oz);
    const spread = (BANDIT.aimSpread + dist * BANDIT.spreadPerMetre) *
        waves.difficultyFor(room).spreadScale;
    dx += (Math.random() - 0.5) * spread * 2;
    dy += (Math.random() - 0.5) * spread * 1.5;
    dz += (Math.random() - 0.5) * spread * 2;
    const n = Math.hypot(dx, dy, dz) || 1;
    dx /= n; dy /= n; dz /= n;

    room.bullets.push({
        x: ox, y: oy, z: oz,
        dx: dx, dy: dy, dz: dz,
        life: 0,
        from: b.id
    });

    sink.shots.push({
        id: b.id,
        o: [round2(ox), round2(oy), round2(oz)],
        d: [round3(dx), round3(dy), round3(dz)]
    });
}

/* How close did a segment pass to a point? A bullet crosses 2.1 metres in a
   single server tick while a player is barely a metre wide, so testing only
   the places the bullet lands misses more than a third of the shots that
   actually went through someone. Testing the whole path it swept does not. */
function segmentDistance(px, py, pz, ax, ay, az, bx, by, bz) {
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const ab2 = abx * abx + aby * aby + abz * abz;
    let t = 0;
    if (ab2 > 0) {
        t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / ab2;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
    }
    const cx = ax + abx * t, cy = ay + aby * t, cz = az + abz * t;
    return Math.hypot(px - cx, py - cy, pz - cz);
}

/* Same reasoning for the town: sample along the sweep so a fast bullet cannot
   step straight through a wall. */
function pathBlocked(ax, az, bx, bz) {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(dist / 0.5));
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        if (nav.collidesAt(ax + (bx - ax) * t, az + (bz - az) * t, 0.08)) return true;
    }
    return false;
}

function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }

/* Bullets move, hit the town, hit a player, or run out of road. */
function stepBullets(room, players, dt, sink) {
    if (!room.bullets) room.bullets = [];

    for (let i = room.bullets.length - 1; i >= 0; i--) {
        const bl = room.bullets[i];
        /* The boss shares this list, and its rounds are not all the same round:
           a sniper's travels faster and costs more than a bandit's. A bullet
           that does not say carries the bandit's numbers. */
        const travel = (bl.spd || BANDIT.bulletSpeed) * dt;
        const nx = bl.x + bl.dx * travel;
        const ny = bl.y + bl.dy * travel;
        const nz = bl.z + bl.dz * travel;

        if (ny <= 0.03) { room.bullets.splice(i, 1); continue; }
        if (pathBlocked(bl.x, bl.z, nx, nz)) { room.bullets.splice(i, 1); continue; }

        let struck = false;
        for (const id in players) {
            const p = players[id];
            if (p.room !== room.code || !p.alive) continue;
            const d = segmentDistance(p.x, p.y || 1.72, p.z, bl.x, bl.y, bl.z, nx, ny, nz);
            if (d < BANDIT.hitRadius) {
                sink.hits.push({
                    playerId: p.id,
                    damage: bl.dmg || BANDIT.bulletDamage,
                    from: bl.from
                });
                struck = true;
                break;
            }
        }
        bl.x = nx; bl.y = ny; bl.z = nz;
        bl.life += dt;
        if (struck || bl.life > BANDIT.bulletLife) room.bullets.splice(i, 1);
    }
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

/* Where it stood over the last third of a second. The browser draws every body
   110ms in the past, and a hit report takes a round trip on top of that - so
   by the time the server hears "I hit it", the bandit may have stepped behind
   a corner the shooter could still see. Asking where it was, not just where it
   is, is what takes wrongly refused honest hits from about 1% to about 0.1%. */
const TRAIL_LENGTH = 7;               // 7 ticks x 50ms = 300ms

function recordTrail(e) {
    if (!e.trail) e.trail = [];
    e.trail.push(e.x, e.z);
    if (e.trail.length > TRAIL_LENGTH * 2) e.trail.splice(0, 2);
}

function stepBandit(room, b, players, now, dt, sink) {
    if (!b.alive) {
        /* Nobody comes back while a boss is on the field - the browser held
           them back the same way, so a boss fight is a boss fight and not a
           boss fight plus a fresh dozen. */
        if (b.respawnAt && now >= b.respawnAt && !room.bossAlive) {
            const p = pickBanditSpawn(room, players);
            b.x = p.x; b.z = p.z;
            b.maxHealth = waves.difficultyFor(room).health;
            b.health = b.maxHealth;
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
            const route = nav.findPath(b.x, b.z, goal.x, goal.z);
            if (route === undefined) {
                /* this tick's search allowance is spent - keep the route we
                   have and ask again in a tick or two */
                b.repathAt = now + 50 + Math.random() * 100;
            } else {
                b.path = route;
                b.pathIndex = 0;
            }
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
    recordTrail(b);

    /* --- stuck recovery: same idea as the browser had --- */
    if (now >= b.stuckCheckAt) {
        b.stuckCheckAt = now + 800;
        /* The same two-stage recovery the boss uses, and it matters more than it
           used to: a bandit wedged in a wall is not just an odd sight, it is
           holding one of the slots the wave allows, so the room is quietly
           easier than the wave says it is. */
        if (moved && Math.hypot(b.x - b.lastX, b.z - b.lastZ) < 0.22) {
            b.wedgedFor = (b.wedgedFor || 0) + 800;
            b.path = null;
            b.repathAt = 0;
            if (b.wedgedFor >= 1600) {
                const spot = nav.freeSpotNear(b.x, b.z, 2, 12, BANDIT.radius);
                if (spot) { b.x = spot.x; b.z = spot.z; }
                b.wedgedFor = 0;
            }
        } else {
            b.wedgedFor = 0;
        }
        b.lastX = b.x; b.lastZ = b.z;
    }

    /* --- shooting --- */
    if (b.hasLos && near && near.dist < BANDIT.fireRange &&
        now - b.lastShot > waves.difficultyFor(room).fireDelay) {
        b.lastShot = now + (Math.random() - 0.5) * 350;
        fire(room, b, near.player, sink);
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

function stepRoom(room, players, now, dt, sink) {
    if (!room.bandits) initRoom(room);
    if (!room.bullets) room.bullets = [];
    sink = sink || { shots: [], hits: [] };

    // reinforcements keep coming, but only while somebody is there to fight
    let occupied = false;
    for (const id in players) if (players[id].room === room.code) { occupied = true; break; }
    if (!occupied) return sink;      // nothing happened, but the caller still needs the shape

    if (now >= room.nextSpawnAt) {
        room.nextSpawnAt = now + BANDIT.spawnEveryMs;
        if (Object.keys(room.bandits).length < waves.capFor(room)) spawnBandit(room, players);
    }

    for (const id in room.bandits) stepBandit(room, room.bandits[id], players, now, dt, sink);
    stepBullets(room, players, dt, sink);
    return sink;
}

/* What the clients need in order to draw them. Kept short on purpose: this
   goes out ten times a second to everyone in the room, and by wave six there
   are sixteen of them in it - at which point this is about half the traffic.

   Same whole numbers as the player packet: centimetres and hundredths of a
   radian, written without a decimal point. */
function snapshot(room) {
    const out = [];
    for (const id in room.bandits) {
        const b = room.bandits[id];
        out.push([
            b.id,
            Math.round(b.x * 100),
            Math.round(b.z * 100),
            Math.round(b.yaw * 100),
            Math.round(b.health),
            b.alive ? (b.state === "chase" ? 2 : 1) : 0
        ]);
    }
    return out;
}

/* A wave turning over does not wait fifteen seconds to be felt: the room is
   brought up to its new allowance there and then. Capped per call so a bug in
   the wave counter cannot empty the spawn table into one tick. */
function fillTo(room, players, cap, limit) {
    const room_cap = typeof cap === "number" ? cap : waves.capFor(room);
    /* Six covers the biggest honest jump - a room still on its opening three
       when the first wave turns over and asks for eight. */
    const most = limit || 6;
    let added = 0;
    while (Object.keys(room.bandits).length < room_cap && added < most) {
        spawnBandit(room, players);
        added++;
    }
    return added;
}

/* A wave turning over makes the bandits already standing tougher too, by the
   same amount it adds to a fresh one - so a bandit hurt to half keeps its
   wound, and nobody is walking round wave 6 with wave 2's health. Every bandit
   in a room therefore shares one maximum, which is what the clients draw the
   health bar against. */
function applyWave(room) {
    const hp = waves.difficultyFor(room).health;
    for (const id in room.bandits) {
        const b = room.bandits[id];
        const was = b.maxHealth || BANDIT.maxHealth;
        if (hp <= was) continue;
        if (b.alive) b.health += hp - was;
        b.maxHealth = hp;
    }
}

function hurt(room, banditId, amount) {
    const b = room.bandits && room.bandits[banditId];
    if (!b || !b.alive) return null;
    b.health -= amount;
    if (b.health <= 0) {
        b.health = 0;
        b.alive = false;
        b.respawnAt = Date.now() + waves.difficultyFor(room).respawnMs;
        b.path = null;
        return { killed: true, bandit: b };
    }
    // being shot at makes them come looking
    b.state = "chase";
    return { killed: false, bandit: b };
}

module.exports = {
    BANDIT, TICK_MS, initRoom, stepRoom, snapshot, hurt, aliveCount, banditList, fillTo,
    recordTrail, TRAIL_LENGTH, applyWave
};
