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
const missions = require("./missions");

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

/* ---- The dragon's brood (step 33d2) -------------------------------------
   After its ROAR the dragon lays eggs in an arc in front of it. They live in the
   room's bandit list - same hit report, same snapshot, same death - as two kinds:

     egg    eggHealth, does not move. hatchMs after it lands it hatches, unless a
            shot got there first (then it bursts, and nothing comes out).
     hatch  the hatchling: health, runs at `speed` straight for the nearest living
            player (faster than a walk, slower than a sprint), and at biteRange
            leaps. The bite lands biteLeapMs later if the player is still within
            biteReach - so stepping back as it leaps is a dodge. biteEveryMs apart.

   Eggs per roar: eggs, +eggsPerPlayer for every player in the room past the first,
   at most eggsMax - and never past `cap` eggs and hatchlings alive at once. Like
   any summoned help they never come back after dying, and they are not the wave's. */
const BROOD = {
    eggHealth: 15, hatchMs: 3000, eggRadius: 0.35,
    health: 30, radius: 0.35, speed: 6,
    biteRange: 2, biteLeapMs: 250, biteReach: 2.6, biteDamage: 8, biteEveryMs: 1200,
    eggs: 3, eggsPerPlayer: 1, eggsMax: 5, cap: 8,
    layNear: 3, layFar: 4.5, layArc: 1.25       // metres in front of it, and radians either side
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

function spawnBandit(room, players, at) {
    const p = at || pickBanditSpawn(room, players || {});
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
    /* A mission objective says where to put the round, which is not always
       where the bandit walks to: the bank is walked to at its door and shot at
       in the middle, so a round from any side lands in a wall. */
    const at = target.aim || target;
    const tx = at.x, ty = at.y || 1.72, tz = at.z;

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
    return blockedAt(ax, az, bx, bz) >= 0;
}

/* The same sweep, answering how far along it the wall was: -1 for clear. */
function blockedAt(ax, az, bx, bz) {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(dist / 0.5));
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        if (nav.collidesAt(ax + (bx - ax) * t, az + (bz - az) * t, 0.08)) return t;
    }
    return -1;
}

/* Step 24: did a round that just hit a wall hit the bank's wall? */
function inBank(box, x, y, z) {
    const pad = 0.15;
    return y <= box[4] && x >= box[0] - pad && x <= box[2] + pad && z >= box[1] - pad && z <= box[3] + pad;
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
        const m = room.mission;
        /* step 31b: the ghost's SPECTRAL SHOT (`thru`) goes through the town - no wall
           stops it, so it never hits the bank's wall either - and is gone after
           `maxLife` seconds instead of the usual road. */
        const wallAt = bl.thru ? -1 : blockedAt(bl.x, bl.z, nx, nz);
        if (wallAt >= 0) {
            if (m && m.box && sink.missionHits) {
                const hx = bl.x + (nx - bl.x) * wallAt, hy = bl.y + (ny - bl.y) * wallAt, hz = bl.z + (nz - bl.z) * wallAt;
                if (inBank(m.box, hx, hy, hz)) sink.missionHits.push(bl.dmg || BANDIT.bulletDamage);
            }
            room.bullets.splice(i, 1);
            continue;
        }

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
        /* The wagon is in the way of whatever passes close enough to it - a
           round meant for the player walking beside it included. */
        if (!struck && m && m.k === "wagon" && sink.missionHits) {
            const w = missions.MISSION.wagon;
            if (segmentDistance(m.x, w.hitY, m.z, bl.x, bl.y, bl.z, nx, ny, nz) < w.hitRadius) {
                sink.missionHits.push(bl.dmg || BANDIT.bulletDamage);
                struck = true;
            }
        }
        bl.x = nx; bl.y = ny; bl.z = nz;
        bl.life += dt;
        if (struck || bl.life > (bl.maxLife || BANDIT.bulletLife)) room.bullets.splice(i, 1);
    }
}

/* ---- Movement ---------------------------------------------------------- */
function moveAxis(b, dx, dz) {
    const r = b.radius || BANDIT.radius;          // step 33d2: a hatchling is smaller
    if (dx !== 0 && !nav.collidesAt(b.x + dx, b.z, r)) b.x += dx;
    if (dz !== 0 && !nav.collidesAt(b.x, b.z + dz, r)) b.z += dz;
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
        if (b.summoned) {
            if (b.removeAt && now >= b.removeAt) delete room.bandits[b.id];
            return;
        }
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

    /* step 33d2: the dragon's brood - an egg only waits, a hatchling only chases */
    if (b.kind === "egg") {
        if (now < b.hatchAt) return;
        hatchEgg(b);
    }
    if (b.kind === "hatch") { stepHatchling(room, b, players, now, dt, sink); return; }

    let near = nearestPlayer(room, players, b.x, b.z);

    /* --- a mission objective (step 24) ---
       Half the town goes for it rather than for the nearest player, unless a
       player is right on top of them. It stands in for the player completely:
       everything below - sight, routing, range, shooting, facing - runs
       against it unchanged. It knows where the bank is, so it does not have to
       stumble on it first. */
    const objective = missions.targetFor(room, b, near ? near.dist : Infinity);
    if (objective) {
        near = { player: objective, dist: Math.hypot(objective.x - b.x, objective.z - b.z) };
        if (b.targetId !== objective.id) { b.losAt = 0; b.path = null; b.repathAt = 0; }
        b.state = "chase";
        b.targetId = objective.id;
    } else if (b.targetId === "#mission") {
        b.targetId = null;
        b.losAt = 0;
        b.path = null;
    }
    const keep = objective && objective.keep !== undefined ? objective.keep : BANDIT.keepDistance;

    /* --- can it see anyone? checked a few times a second, not every tick --- */
    if (now >= b.losAt) {
        b.losAt = now + 180 + Math.random() * 100;
        if (near && (objective || near.dist < BANDIT.sightRange)) {
            b.hasLos = nav.losClear(b.x, b.z, near.player.x, near.player.z);
        } else {
            b.hasLos = false;
        }
        if (objective) {
            // already chasing it, see above
        } else if (b.hasLos && near && near.dist < BANDIT.engageRange) {
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
        if (objective) {
            // close enough to the objective and able to see it: stop walking
            if (b.hasLos && near.dist < keep) wantsMove = false;
        } else if (b.hasLos && near.dist < keep + 4 && near.dist > keep - 4) {
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
    if (!moved && b.state === "chase" && near && b.hasLos && !(objective && objective.noFire)) {
        if (now >= b.strafeAt) {
            b.strafeAt = now + 1100 + Math.random() * 1800;
            b.strafeDir *= -1;
        }
        const tx = near.player.x - b.x, tz = near.player.z - b.z;
        const len = Math.hypot(tx, tz) || 1;
        const px = -tz / len, pz = tx / len;
        const back = near.dist < keep - 3 ? -1 : 0;
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
    if (b.hasLos && near && near.dist < BANDIT.fireRange && !(objective && objective.noFire) &&
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

/* ---- The brood (step 33d2), see BROOD above ----------------------------- */
function hatchEgg(b) {
    b.kind = "hatch";
    b.health = b.maxHealth = BROOD.health;
    b.radius = BROOD.radius;
    b.state = "chase";
    b.path = null; b.repathAt = 0;
    b.biteAt = 0; b.bite = null;
}

function stepHatchling(room, b, players, now, dt, sink) {
    /* a leap in the air lands where it lands: the player it went for, if still in reach */
    if (b.bite && now >= b.bite.at) {
        const v = players[b.bite.id];
        if (v && v.alive && v.room === room.code &&
            Math.hypot(v.x - b.x, v.z - b.z) <= BROOD.biteReach && nav.losClear(b.x, b.z, v.x, v.z)) {
            sink.hits.push({ playerId: v.id, damage: BROOD.biteDamage, from: b.id });
        }
        b.bite = null;
    }

    const near = nearestPlayer(room, players, b.x, b.z);
    let moved = false;
    if (near) {
        const t = near.player;
        b.targetId = t.id;
        /* nothing between them on the ground (losClear - the walking grid's lineClear
           calls a player standing against a wall unreachable even from a metre off) */
        if (!b.bite && near.dist <= BROOD.biteRange && now >= b.biteAt && nav.losClear(b.x, b.z, t.x, t.z)) {
            b.bite = { id: t.id, at: now + BROOD.biteLeapMs };
            b.biteAt = now + BROOD.biteEveryMs;
            if (sink.bites) sink.bites.push({ id: b.id });
        }
        /* routing: straight at it when the way is open (or it is a few metres off with
           nothing between), otherwise the grid's path, waypoint by waypoint */
        if (now >= b.repathAt || !b.path || b.pathIndex >= b.path.length) {
            b.repathAt = now + 300 + Math.random() * 200;
            let local;
            if (nav.lineClear(b.x, b.z, t.x, t.z) || (near.dist < 4 && nav.losClear(b.x, b.z, t.x, t.z))) {
                b.path = [{ x: t.x, z: t.z }]; b.pathIndex = 0; b.direct = true;
            } else if (near.dist < FINE.reach + (b.fine ? FINE.margin : 0) && (local = finePath(b, t))) {
                // once on one it keeps to it out to reach + margin: a way round a building can
                // lead away first, and back on the coarse grid it would only turn round again
                b.path = local; b.pathIndex = 0; b.direct = false; b.fine = true;
            } else {
                b.fine = false;
                const to = approachPoint(b, t);
                const route = nav.findPath(b.x, b.z, to.x, to.z);
                if (route === undefined) b.repathAt = now + 50 + Math.random() * 100;
                else {
                    b.path = route; b.pathIndex = 0; b.direct = false;
                    b.repathAt = now + 600 + Math.random() * 300;       // a long route: asked for no more often than a bandit's
                }
            }
        }
        /* it runs until it is on top of you - nothing to keep its distance for */
        if (near.dist > 1.1 && b.path && b.pathIndex < b.path.length) {
            const wp = b.direct ? { x: t.x, z: t.z } : b.path[b.pathIndex];
            const dx = wp.x - b.x, dz = wp.z - b.z;
            const d = Math.hypot(dx, dz);
            if (!b.direct && d < 0.6) b.pathIndex++;
            else if (d > 0.01) {
                const step = Math.min(d, BROOD.speed * dt);
                moveAxis(b, (dx / d) * step, (dz / d) * step);
                moved = true;
            }
        }
        const want = Math.atan2(t.x - b.x, t.z - b.z);
        let dy = want - b.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        b.yaw += dy * Math.min(1, 12 * dt);
    }

    separate(room, b);
    b.moving = moved;
    recordTrail(b);

    if (now >= b.stuckCheckAt) {
        b.stuckCheckAt = now + 800;
        if (moved && Math.hypot(b.x - b.lastX, b.z - b.lastZ) < 0.22) {
            b.wedgedFor = (b.wedgedFor || 0) + 800;
            b.path = null; b.repathAt = 0;
            if (b.wedgedFor >= 1600) {
                const spot = nav.freeSpotNear(b.x, b.z, 2, 12, BROOD.radius);
                if (spot) { b.x = spot.x; b.z = spot.z; }
                b.wedgedFor = 0;
            }
        } else b.wedgedFor = 0;
        b.lastX = b.x; b.lastZ = b.z;
    }
}

/* The last few metres (step 33d2). The walking grid pads every wall by 1.3 m and its
   cells are big: fine for a bandit that shoots from eleven metres, not for something
   that has to reach you - it gives up on a player against a wall, in the corral or in
   the mine. Within FINE.reach of the player it finds its way on a grid of FINE.cell
   squares tested against the colliders themselves (clear by FINE.clear - a player is
   0.42). The whole town is worked out once, here, as the server starts: ~130 ms, the
   way the walking grid is. Worked out as it went, the first chase past new ground cost
   the server a 130 ms tick. Breadth-first from the player's square out to its own, no
   corner cutting. */
const FINE = { cell: 0.5, reach: 14, margin: 6, clear: 0.4 };     // margin: room to go round a building
const fineGrid = (function () {
    const N = nav.NAV, C = FINE.cell;
    const g = { ox: Math.floor(N.minX / C), oz: Math.floor(N.minZ / C) };
    g.w = Math.ceil((N.minX + N.w * N.cell) / C) - g.ox;
    g.h = Math.ceil((N.minZ + N.h * N.cell) / C) - g.oz;
    g.free = new Uint8Array(g.w * g.h);
    for (let z = 0; z < g.h; z++) {
        for (let x = 0; x < g.w; x++) {
            g.free[z * g.w + x] = nav.collidesAt((x + g.ox + 0.5) * C, (z + g.oz + 0.5) * C, FINE.clear) ? 0 : 1;
        }
    }
    return g;
})();
function fineFree(cx, cz) {
    const x = cx - fineGrid.ox, z = cz - fineGrid.oz;
    return x >= 0 && z >= 0 && x < fineGrid.w && z < fineGrid.h && fineGrid.free[z * fineGrid.w + x] === 1;
}
function finePath(b, t) {
    const C = FINE.cell, R = Math.ceil((FINE.reach + FINE.margin) / C);
    const gx = Math.floor(t.x / C), gz = Math.floor(t.z / C);
    const sx = Math.floor(b.x / C), sz = Math.floor(b.z / C);
    if (Math.abs(sx - gx) > R || Math.abs(sz - gz) > R) return null;
    const W = 2 * R + 1, key = (x, z) => (z - gz + R) * W + (x - gx + R);
    const from = new Int32Array(W * W).fill(-1);
    const q = [gx, gz];
    from[key(gx, gz)] = key(gx, gz);
    const D = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (let h = 0; h < q.length; h += 2) {
        const x = q[h], z = q[h + 1];
        if (x === sx && z === sz) {
            const out = [];
            let cx = x, cz = z;
            while (!(cx === gx && cz === gz)) {
                const f = from[key(cx, cz)];
                cx = (f % W) + gx - R; cz = Math.floor(f / W) + gz - R;
                out.push({ x: (cx + 0.5) * C, z: (cz + 0.5) * C });
            }
            out[out.length - 1] = { x: t.x, z: t.z };
            return out;
        }
        for (let d = 0; d < 8; d++) {
            const nx = x + D[d][0], nz = z + D[d][1];
            if (Math.abs(nx - gx) > R || Math.abs(nz - gz) > R) continue;
            const k = key(nx, nz);
            if (from[k] >= 0) continue;
            const isStart = nx === sx && nz === sz;
            if (!isStart && !fineFree(nx, nz)) continue;
            if (d > 3 && (!fineFree(x + D[d][0], z) || !fineFree(x, z + D[d][1]))) continue;
            from[k] = key(x, z);
            q.push(nx, nz);
        }
    }
    return null;
}

/* Where to run to for a player: the player, unless they stand in a grid cell the
   walking grid calls blocked (against a wall - hiding from the roar, say). Then the
   grid would send it to the nearest free cell, which can be the far side of that wall;
   instead, a free spot 0.8-6 m from them with nothing between on the ground, the one
   nearest the hatchling. */
function approachPoint(b, t) {
    if (!nav.isBlocked(nav.toCellX(t.x), nav.toCellZ(t.z))) return t;
    let best = null, bestD = Infinity;
    for (const r of [0.8, 1.3, 2, 3, 4.5, 6]) {
        for (let k = 0; k < 16; k++) {
            const a = k * Math.PI / 8, x = t.x + Math.sin(a) * r, z = t.z + Math.cos(a) * r;
            if (nav.isBlocked(nav.toCellX(x), nav.toCellZ(z)) || nav.collidesAt(x, z, BROOD.radius + 0.1)) continue;
            if (!nav.losClear(x, z, t.x, t.z)) continue;
            const d = Math.hypot(x - b.x, z - b.z);
            if (d < bestD) { bestD = d; best = { x: x, z: z }; }
        }
        if (best) return best;
    }
    return t;
}

/* Eggs and hatchlings alive in the room right now. */
function broodCount(room) {
    let n = 0;
    for (const id in room.bandits) {
        const b = room.bandits[id];
        if (b.alive && (b.kind === "egg" || b.kind === "hatch")) n++;
    }
    return n;
}

/* How many eggs this roar lays: by the room's head count, under the cap. */
function eggsFor(room, players) {
    let inRoom = 0;
    for (const id in players) if (players[id].room === room.code) inRoom++;
    const want = Math.min(BROOD.eggsMax, BROOD.eggs + BROOD.eggsPerPlayer * Math.max(0, inRoom - 1));
    return Math.max(0, Math.min(want, BROOD.cap - broodCount(room)));
}

/* The eggs drop in an arc in front of it (yaw), on ground it can see from where it
   stands (up against a wall, anywhere round it within layFar + 1.5). Returns
   [[id, x, z], ...] for the ones that found a place. */
/* Free ground an egg can drop on, seen from where the dragon stands. */
function eggGround(x, z, px, pz) {
    return !nav.collidesAt(px, pz, BROOD.eggRadius + 0.15) && nav.lineClear(x, z, px, pz);
}
/* When the random tries all miss - a tight corner, where only a sliver of the ring round the
   dragon is free (5-30% of it, 2026-09-25: 2-3 eggs of 5 in about one wall spot in ten) - go round
   the ring in order: the free spot nearest the egg's own place in the arc, clear of the eggs
   already down if there is one. Null only if there is no free ground at all. */
function eggFallback(x, z, want, laid) {
    return ringFallback(x, z, BROOD.layNear, BROOD.layFar + 1.5, (px, pz) => eggGround(x, z, px, pz), (px, pz, a) => {
        let off = Math.abs(a - want) % (Math.PI * 2);
        if (off > Math.PI) off = Math.PI * 2 - off;
        const crowded = laid.some((e) => Math.hypot(e[1] - px, e[2] - pz) < BROOD.eggRadius * 2 + 0.2);
        return off + (crowded ? 10 : 0);
    });
}
/* Round a ring from rMin to rMax out, every 0.5 m and 0.1 rad, in order: of the spots that
   fit, the one with the lowest score(px, pz, angle). Null if none fits. Shared by the eggs
   and the summons - what "fits" and what is "better" is theirs. */
function ringFallback(x, z, rMin, rMax, fits, score) {
    let best = null, bestScore = Infinity;
    for (let r = rMin; r <= rMax + 1e-9; r += 0.5) {
        for (let a = 0; a < Math.PI * 2; a += 0.1) {
            const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
            if (!fits(px, pz)) continue;
            const sc = score(px, pz, a);
            if (sc < bestScore) { bestScore = sc; best = { x: px, z: pz }; }
        }
    }
    return best;
}

function layEggs(room, players, x, z, yaw, count, now) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const mid = count === 1 ? 0 : -BROOD.layArc + (2 * BROOD.layArc) * i / (count - 1);
        /* 16 tries in its place in the arc; then, up against a wall, anywhere round it
           a little further out; then, if those all missed, round the ring in order
           (eggFallback) - the room gets every egg it was promised */
        let at = null;
        for (let k = 0; k < 40 && !at; k++) {
            const round = k >= 16;
            const a = round ? Math.random() * Math.PI * 2 : yaw + mid + (Math.random() - 0.5) * 0.3 * (1 + k / 4);
            const r = BROOD.layNear + Math.random() * (BROOD.layFar - BROOD.layNear + (round ? 1.5 : 0));
            const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
            if (eggGround(x, z, px, pz)) at = { x: px, z: pz };
        }
        if (!at) at = eggFallback(x, z, yaw + mid, out);
        if (at) {
            const px = at.x, pz = at.z;
            const b = spawnBandit(room, players, { x: px, z: pz });
            b.kind = "egg";
            b.summoned = true;
            b.health = b.maxHealth = BROOD.eggHealth;
            b.radius = BROOD.eggRadius;
            b.hatchAt = (now === undefined ? Date.now() : now) + BROOD.hatchMs;
            b.yaw = Math.random() * Math.PI * 2;
            b.lastShot = Infinity;
            out.push([b.id, round2(px), round2(pz)]);
        }
    }
    return out;
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
        if (regularCount(room) < waves.capFor(room)) spawnBandit(room, players);
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
function snapshot(room, now) {
    const out = [];
    const t = now === undefined ? Date.now() : now;
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
        /* step 33d2: the brood, and only the brood, carries a 7th field - 1 an egg
           (+ tenths of a second to hatching), 2 a hatchling. Older clients ignore it. */
        if (b.kind === "egg") out[out.length - 1].push(1, Math.max(0, Math.round((b.hatchAt - t) / 100)));
        else if (b.kind === "hatch") out[out.length - 1].push(2);
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
    while (regularCount(room) < room_cap && added < most) {
        spawnBandit(room, players);
        added++;
    }
    return added;
}

/* How many of the room's bandits are the town's own - the ones the wave
   allowance is about. A boss's summoned help is on top of that, not instead. */
function regularCount(room) {
    let n = 0;
    for (const id in room.bandits) if (!room.bandits[id].summoned) n++;
    return n;
}

/* Help, arriving (step 21). Placed in a loose ring around (x, z) on ground a
   bandit can stand on and walk away from; they are ordinary bandits in every
   way except that none of them comes back after dying. Returns how many came. */
/* Free ground a summoned bandit can stand on, in sight of whoever called it. */
function summonGround(x, z, px, pz) {
    return !nav.collidesAt(px, pz, BANDIT.radius + 0.2) && nav.lineClear(x, z, px, pz);
}
function summon(room, players, x, z, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
        let at = null;
        for (let k = 0; k < 24 && !at; k++) {
            const a = Math.random() * Math.PI * 2, r = 5 + Math.random() * 6;
            const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
            if (summonGround(x, z, px, pz)) at = { x: px, z: pz };
        }
        /* In a tight spot the 24 random tries can all miss free ground that is there - the
           sniper came up one or two short in 1.3% of her calls (2026-09-26; free ground
           existed in all but 2 of 53). Then round the ring in order, clear of the ones
           already called if it can be - the same fallback as the dragon's eggs. */
        if (!at) at = ringFallback(x, z, 5, 11, (px, pz) => summonGround(x, z, px, pz),
            (px, pz) => (out.some((b) => Math.hypot(b.x - px, b.z - pz) < BANDIT.radius * 2 + 0.5) ? 10 : 0) + Math.random());
        if (!at) continue;
        const b = spawnBandit(room, players, at);
        b.summoned = true;
        b.state = "chase";
        out.push(b);
    }
    return out.length;
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
        if (b.summoned) b.removeAt = Date.now() + 2500;     // long enough to be seen falling
        else b.respawnAt = Date.now() + waves.difficultyFor(room).respawnMs;
        b.path = null;
        return { killed: true, bandit: b };
    }
    // being shot at makes them come looking
    b.state = "chase";
    return { killed: false, bandit: b };
}

module.exports = {
    BANDIT, TICK_MS, initRoom, stepRoom, snapshot, hurt, aliveCount, banditList, fillTo,
    recordTrail, TRAIL_LENGTH, applyWave, summon, regularCount,
    BROOD, layEggs, eggsFor, broodCount                              // step 33d2
};
