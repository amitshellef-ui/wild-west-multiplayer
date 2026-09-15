/* =========================================================================
   THE BOSS - server side (step 12)

   Online there was no boss at all: the local simulation is switched off inside
   a room, and nothing on the server took its place. A room ran out of things
   to be afraid of after the first minute.

   Now the boss is the room's, exactly like the bandits are. One arrives every
   90 seconds, the next name down the list, and everyone in the room fights the
   same one at the same time.

   The eight of them differ in more than health. Each has an ability, and the
   ability is the reason the fight feels different:

     burst     three rounds per trigger pull
     charge    closes the distance at a run and hits you with his shoulder
     snipe     one accurate round from further than you can answer
     spray     a wall of lead, cheap per bullet
     dynamite  lobs a stick that lands where you were
     ghost     disappears and reappears somewhere else
     slam      hits the ground and hurts everyone standing near it
     poison    throws a bottle that leaves a cloud sitting on the ground

   All of it is simulated here. The clients are told what happened - the shot,
   the throw, the explosion, the cloud - and they draw it. No client decides
   how much anything costs, including its own damage.

   The movement is the bandit movement with the boss's own numbers: bigger
   body, closer preferred range, and its own speed. The numbers are the ones
   the browser used, so it fights the way it always did.
   ========================================================================= */
const nav = require("./navigation");

/* The table is duplicated in the client, which owns the colours and the
   model. Anything here that the client also reads - the name, the ability
   label, the health - has to match it, so the bar says what the fight is. */
const BOSS_TYPES = [
    { id: "burst", name: "BLACK-JACK McCREADY", ability: "TRIPLE BURST", hp: 900, fireDelay: 850, speed: 3.1 },
    { id: "charge", name: "IRON-LUNG HANK", ability: "BULL CHARGE", hp: 1100, fireDelay: 1100, speed: 3.6 },
    { id: "snipe", name: "WIDOW-MAKER SAL", ability: "LONGSHOT", hp: 750, fireDelay: 2100, speed: 2.6 },
    { id: "spray", name: "MACHINE-GUN MURPHY", ability: "LEAD STORM", hp: 1000, fireDelay: 120, speed: 3.0 },
    { id: "dynamite", name: "DYNAMITE DAISY", ability: "TNT TOSS", hp: 850, fireDelay: 1600, speed: 3.2 },
    { id: "ghost", name: "GHOST-WALKER COLE", ability: "VANISH", hp: 800, fireDelay: 900, speed: 4.0 },
    { id: "slam", name: "THUNDER-HOOF BART", ability: "EARTHQUAKE", hp: 1300, fireDelay: 1400, speed: 2.8 },
    { id: "poison", name: "POISON-DOC REED", ability: "TOXIC CLOUD", hp: 880, fireDelay: 1300, speed: 3.0 }
];

const BOSS = {
    firstBossMs: 90000,        // after the room starts
    nextBossMs: 90000,         // after one dies
    radius: 0.85,
    eyeHeight: 1.75 * 1.62,
    sightRange: 55,
    engageRange: 42,
    keepDistance: 9,
    fireRange: 38,
    snipeRange: 70,
    bulletLife: 3.5,

    /* Abilities */
    ghostEveryMs: 4500,
    ghostForMs: 1800,
    blinkMin: 8,               // never right on top of you
    blinkMax: 26,              // and never out of the fight - see tickAbility
    chargeEveryMs: 5500,
    chargeForMs: 900,
    chargeTrigger: 22,         // starts the run from this far out
    chargeSpeed: 14,
    chargeHitRange: 2.4,
    chargeDamage: 22,
    slamEveryMs: 4800,
    slamTrigger: 8,
    slamRadius: 6.5,
    slamDamage: 24,

    /* Thrown things */
    tntSpeed: 16, tntFuse: 1.15, tntRadius: 7.5, tntDamage: 38,
    poisonSpeed: 10, poisonFuse: 0.85,
    cloudRadius: 4.2, cloudLife: 5.2, cloudTick: 0.45, cloudDamage: 6,
    gravity: 18
};

/* Per-ability gunplay. Anything missing falls back to the first row. */
const GUN = {
    burst: { shots: 3, spread: 0.022, perMetre: 0.0016, damage: 15, speed: 42, spacing: 0.055 },
    charge: { shots: 1, spread: 0.04, perMetre: 0, damage: 15, speed: 42 },
    snipe: { shots: 1, spread: 0.006, perMetre: 0, damage: 32, speed: 72 },
    spray: { shots: 1, spread: 0.055, perMetre: 0.0012, damage: 8, speed: 48 },
    ghost: { shots: 1, spread: 0.022, perMetre: 0.0016, damage: 15, speed: 42 },
    slam: { shots: 1, spread: 0.022, perMetre: 0.0016, damage: 18, speed: 42 },
    dynamite: { shots: 0 },
    poison: { shots: 0 }
};

function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }

/* ---- Room lifecycle ---------------------------------------------------- */
function initRoom(room, now) {
    room.boss = null;
    room.bossIndex = 0;
    room.bossAlive = false;                 // read by bandits.js: no respawns mid-fight
    room.nextBossAt = (now === undefined ? Date.now() : now) + BOSS.firstBossMs;
    room.hazards = [];
    room.clouds = [];
    room.nextHazardId = 1;
}

/* Far enough away that it does not land on top of anybody, close enough that
   it is walking towards the fight rather than across the map. */
function pickBossSpawn(room, players) {
    let fallback = nav.randomNavPoint();
    for (let attempt = 0; attempt < 60; attempt++) {
        const p = nav.randomNavPoint();
        if (nav.collidesAt(p.x, p.z, BOSS.radius)) continue;
        let nearest = Infinity;
        for (const id in players) {
            const pl = players[id];
            if (pl.room !== room.code) continue;
            const d = Math.hypot(pl.x - p.x, pl.z - p.z);
            if (d < nearest) nearest = d;
        }
        if (nearest === Infinity) return p;          // empty room, anywhere walkable
        fallback = p;
        if (nearest > 16 && nearest < 60) return p;
    }
    return fallback;
}

function spawnBoss(room, players, now) {
    const type = BOSS_TYPES[room.bossIndex % BOSS_TYPES.length];
    const typeIndex = room.bossIndex % BOSS_TYPES.length;
    room.bossIndex++;

    const p = pickBossSpawn(room, players);
    room.boss = {
        typeIndex: typeIndex,
        type: type,
        x: p.x, z: p.z,
        yaw: Math.random() * Math.PI * 2,
        health: type.hp,
        maxHealth: type.hp,
        alive: true,
        state: "chase",             // it came here for a reason
        path: null,
        pathIndex: 0,
        repathAt: 0,
        losAt: 0,
        hasLos: false,
        patrolTarget: null,
        stuckCheckAt: 0,
        lastX: p.x, lastZ: p.z,
        strafeAt: 0,
        wedgedFor: 0,
        strafeDir: Math.random() > 0.5 ? 1 : -1,
        lastShot: now + 900,        // a breath before the first round
        abilityAt: now + 2000,
        ghostUntil: 0,
        chargeUntil: 0
    };
    room.bossAlive = true;
    return room.boss;
}

/* ---- Helpers shared with the bandit brain ------------------------------- */
function moveAxis(b, dx, dz) {
    if (dx !== 0 && !nav.collidesAt(b.x + dx, b.z, BOSS.radius)) b.x += dx;
    if (dz !== 0 && !nav.collidesAt(b.x, b.z + dz, BOSS.radius)) b.z += dz;
}

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

/* Everyone standing inside the blast, not just whoever it was aimed at. The
   browser only ever had one player to hurt; a room has as many as fit. */
function splash(room, players, x, z, radius, damage, falloff, sink, y) {
    for (const id in players) {
        const p = players[id];
        if (p.room !== room.code || !p.alive) continue;
        /* A stick of dynamite lying on the ground is measured in three
           dimensions, the way the browser measured it - standing next to it is
           not the same as standing on it. A cloud and a ground slam are flat. */
        const d = y === undefined
            ? Math.hypot(p.x - x, p.z - z)
            : Math.hypot(p.x - x, (p.y || 1.72) - y, p.z - z);
        if (d > radius) continue;
        const amount = falloff ? Math.round(damage * (1 - d / radius)) : damage;
        if (amount > 0) sink.hits.push({ playerId: p.id, damage: amount, from: "boss" });
    }
}

/* ---- Shooting ---------------------------------------------------------- */
function fire(room, b, target, dist, sink) {
    const g = GUN[b.type.id] || GUN.burst;
    const ox = b.x, oy = BOSS.eyeHeight, oz = b.z;
    const tx = target.x, ty = target.y || 1.72, tz = target.z;

    let bx = tx - ox, by = ty - oy, bz = tz - oz;
    const len = Math.hypot(bx, by, bz) || 1;
    bx /= len; by /= len; bz /= len;

    const spread = g.spread + dist * (g.perMetre || 0);

    for (let i = 0; i < g.shots; i++) {
        const off = g.spacing ? (i - (g.shots - 1) / 2) * g.spacing : 0;
        let dx = bx + (Math.random() - 0.5) * spread * 2 + off;
        let dy = by + (Math.random() - 0.5) * spread * 1.5;
        let dz = bz + (Math.random() - 0.5) * spread * 2;
        const n = Math.hypot(dx, dy, dz) || 1;
        dx /= n; dy /= n; dz /= n;

        room.bullets.push({
            x: ox, y: oy, z: oz,
            dx: dx, dy: dy, dz: dz,
            life: 0,
            from: -1,
            dmg: g.damage,
            spd: g.speed
        });

        sink.bossShots.push({
            k: b.type.id,
            o: [round2(ox), round2(oy), round2(oz)],
            d: [round3(dx), round3(dy), round3(dz)]
        });
    }
}

/* A stick of dynamite or a bottle of something worse. It is thrown at where
   the player is standing, arcs, bounces, and goes off on its fuse - so running
   away from where it lands works, and standing still does not. */
function throwHazard(room, b, target, kind, sink) {
    const from = { x: b.x, y: BOSS.eyeHeight, z: b.z };
    let dx = target.x - from.x;
    let dy = (target.y || 1.72) - from.y + 4;
    let dz = target.z - from.z;
    const n = Math.hypot(dx, dy, dz) || 1;
    dx /= n; dy /= n; dz /= n;

    const speed = kind === "tnt" ? BOSS.tntSpeed : BOSS.poisonSpeed;
    const fuse = kind === "tnt" ? BOSS.tntFuse : BOSS.poisonFuse;
    const id = room.nextHazardId++;

    room.hazards.push({
        id: id, kind: kind,
        x: from.x, y: from.y, z: from.z,
        vx: dx * speed, vy: dy * speed, vz: dz * speed,
        life: fuse
    });

    sink.hazards.push({
        i: id, k: kind,
        o: [round2(from.x), round2(from.y), round2(from.z)],
        v: [round2(dx * speed), round2(dy * speed), round2(dz * speed)],
        f: fuse
    });
}

function stepHazards(room, players, dt, sink) {
    for (let i = room.hazards.length - 1; i >= 0; i--) {
        const h = room.hazards[i];
        h.life -= dt;
        h.vy -= BOSS.gravity * dt;
        h.x += h.vx * dt;
        h.y += h.vy * dt;
        h.z += h.vz * dt;
        if (h.y < 0.12) {
            h.y = 0.12;
            h.vy *= -0.2;
            h.vx *= 0.4;
            h.vz *= 0.4;
        }
        if (h.life > 0) continue;

        room.hazards.splice(i, 1);
        sink.booms.push({ i: h.id, k: h.kind, p: [round2(h.x), round2(h.y), round2(h.z)] });

        if (h.kind === "tnt") {
            splash(room, players, h.x, h.z, BOSS.tntRadius, BOSS.tntDamage, true, sink, h.y);
        } else {
            room.clouds.push({
                x: h.x, z: h.z,
                life: BOSS.cloudLife,
                tick: 0
            });
        }
    }

    for (let i = room.clouds.length - 1; i >= 0; i--) {
        const c = room.clouds[i];
        c.life -= dt;
        c.tick += dt;
        if (c.tick > BOSS.cloudTick) {
            c.tick = 0;
            splash(room, players, c.x, c.z, BOSS.cloudRadius, BOSS.cloudDamage, false, sink);
        }
        if (c.life <= 0) room.clouds.splice(i, 1);
    }
}

/* ---- Abilities ---------------------------------------------------------- */
function tickAbility(room, b, players, near, now, dt, sink) {
    const id = b.type.id;

    if (id === "ghost") {
        if (now >= b.abilityAt) {
            b.abilityAt = now + BOSS.ghostEveryMs;
            b.ghostUntil = now + BOSS.ghostForMs;

            /* Vanishing means reappearing somewhere you were not looking - not
               leaving the county. The browser picked any point on the map,
               which put it 40 metres away four times out of five and quietly
               ended the fight: it could not shoot from there, and nobody could
               find it to shoot back. So the blink stays inside the fight, far
               enough to break your aim and no further. */
            let placed = false;
            for (let k = 0; k < 40 && !placed; k++) {
                const dest = nav.randomNavPoint();
                if (nav.collidesAt(dest.x, dest.z, BOSS.radius)) continue;
                if (near) {
                    const d = Math.hypot(dest.x - near.player.x, dest.z - near.player.z);
                    if (d <= BOSS.blinkMin || d > BOSS.blinkMax) continue;
                }
                b.x = dest.x; b.z = dest.z;
                placed = true;
            }
            if (placed) {
                b.path = null; b.repathAt = 0;
                b.lastX = b.x; b.lastZ = b.z;
                sink.blinks.push({ p: [round2(b.x), round2(b.z)] });
            }
        }
        return;
    }

    if (id === "charge") {
        if (b.hasLos && near && near.dist < BOSS.chargeTrigger && now >= b.abilityAt) {
            b.abilityAt = now + BOSS.chargeEveryMs;
            b.chargeUntil = now + BOSS.chargeForMs;
            sink.roars.push({ p: [round2(b.x), round2(b.z)] });
        }
        if (b.chargeUntil && now < b.chargeUntil && near) {
            const step = BOSS.chargeSpeed * dt;
            const d = near.dist || 0.01;
            moveAxis(b, ((near.player.x - b.x) / d) * step, ((near.player.z - b.z) / d) * step);
            if (near.dist < BOSS.chargeHitRange) {
                b.chargeUntil = 0;
                sink.hits.push({ playerId: near.player.id, damage: BOSS.chargeDamage, from: "boss" });
                sink.slams.push({ p: [round2(b.x), round2(b.z)], k: "charge" });
            }
        }
        return;
    }

    if (id === "slam") {
        if (near && near.dist < BOSS.slamTrigger && now >= b.abilityAt) {
            b.abilityAt = now + BOSS.slamEveryMs;
            splash(room, players, b.x, b.z, BOSS.slamRadius, BOSS.slamDamage, false, sink);
            sink.slams.push({ p: [round2(b.x), round2(b.z)], k: "slam" });
        }
    }
}

/* ---- The boss itself ---------------------------------------------------- */
function stepBoss(room, b, players, now, dt, sink) {
    const near = nearestPlayer(room, players, b.x, b.z);

    if (now >= b.losAt) {
        b.losAt = now + 180 + Math.random() * 100;
        if (near && near.dist < BOSS.sightRange) {
            b.hasLos = nav.losClear(b.x, b.z, near.player.x, near.player.z);
        } else {
            b.hasLos = false;
        }
        if (b.hasLos && near && near.dist < BOSS.engageRange) {
            b.state = "chase";
        } else if (b.state === "chase" && (!near || near.dist > 60)) {
            b.state = "patrol";
        }
    }

    tickAbility(room, b, players, near, now, dt, sink);

    /* --- destination --- */
    let goal = null, wantsMove = true;
    if (b.state === "chase" && near) {
        goal = { x: near.player.x, z: near.player.z };
        if (b.hasLos && near.dist < BOSS.keepDistance + 4 && near.dist > BOSS.keepDistance - 4) {
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
    const charging = b.chargeUntil && now < b.chargeUntil;
    const speed = b.state === "chase" ? b.type.speed : b.type.speed * 0.55;
    let moved = false;
    if (!charging && wantsMove && b.path && b.pathIndex < b.path.length) {
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
    if (!charging && !moved && b.state === "chase" && near && b.hasLos) {
        if (now >= b.strafeAt) {
            b.strafeAt = now + 1100 + Math.random() * 1800;
            b.strafeDir *= -1;
        }
        const tx = near.player.x - b.x, tz = near.player.z - b.z;
        const len = Math.hypot(tx, tz) || 1;
        const px = -tz / len, pz = tx / len;
        const back = near.dist < BOSS.keepDistance - 3 ? -1 : 0;
        const step = speed * 0.65 * dt;
        moveAxis(b,
            px * step * b.strafeDir + (tx / len) * step * back,
            pz * step * b.strafeDir + (tz / len) * step * back);
        moved = true;
    }

    /* --- stuck recovery ---
       Two different kinds of stuck. Shuffling on the spot is the common one and
       a short hop fixes it. Not moving *at all* while trying to is the rare one
       - wedged in a pocket the body does not fit through - and a hop does not
       fix that, because there is nowhere within six metres to hop to.

       The browser never had to care: a wedged boss was one player's bad round.
       Here it is the whole room's: while it stands there nothing kills it, so
       no wave turns over and no next boss ever arrives. So it gets moved. */
    if (now >= b.stuckCheckAt) {
        b.stuckCheckAt = now + 800;
        /* `moved` only means it tried. Going nowhere for two checks running is
           a body that does not fit where the path wants it to go: the first
           check throws the route away and asks for a new one, and if that does
           not help either, it is lifted to the nearest ground it fits on. */
        if (moved && Math.hypot(b.x - b.lastX, b.z - b.lastZ) < 0.22) {
            b.wedgedFor += 800;
            b.path = null;
            b.repathAt = 0;
            if (b.wedgedFor >= 1600) {
                const spot = nav.freeSpotNear(b.x, b.z, 2, 14, BOSS.radius);
                if (spot) { b.x = spot.x; b.z = spot.z; }
                b.wedgedFor = 0;
            }
        } else {
            b.wedgedFor = 0;
        }
        b.lastX = b.x; b.lastZ = b.z;
    }

    /* --- shooting --- */
    const range = b.type.id === "snipe" ? BOSS.snipeRange : BOSS.fireRange;
    if (b.hasLos && near && near.dist < range && now - b.lastShot > b.type.fireDelay) {
        b.lastShot = now + (Math.random() - 0.5) * 350;
        if (b.type.id === "dynamite") throwHazard(room, b, near.player, "tnt", sink);
        else if (b.type.id === "poison") throwHazard(room, b, near.player, "poison", sink);
        else fire(room, b, near.player, near.dist, sink);
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
    if (room.boss === undefined) initRoom(room);
    sink = sink || emptySink();

    let occupied = false;
    for (const id in players) if (players[id].room === room.code) { occupied = true; break; }
    if (!occupied) {
        // nobody to fight: the timer waits rather than running down in an empty town
        if (!room.boss) room.nextBossAt = now + BOSS.firstBossMs;
        return sink;
    }

    if (!room.boss && now >= room.nextBossAt) {
        const b = spawnBoss(room, players, now);
        sink.bossSpawn = {
            t: b.typeIndex,
            hp: b.maxHealth,
            x: round2(b.x), z: round2(b.z)
        };
    }

    if (room.boss && room.boss.alive) stepBoss(room, room.boss, players, now, dt, sink);
    stepHazards(room, players, dt, sink);
    return sink;
}

function emptySink() {
    return {
        shots: [], hits: [], bossShots: [], hazards: [],
        booms: [], slams: [], blinks: [], roars: [],
        bossSpawn: null, bossDied: null, wave: null
    };
}

/* What the clients draw: position, facing, health, and whether it is currently
   see-through. Sent at the same rate as the bandit snapshot. */
function snapshot(room, now) {
    const b = room.boss;
    if (!b || !b.alive) return null;
    const t = now === undefined ? Date.now() : now;
    return [
        Math.round(b.x * 100) / 100,
        Math.round(b.z * 100) / 100,
        Math.round(b.yaw * 100) / 100,
        Math.round(b.health),
        b.ghostUntil > t ? 1 : 0,
        (b.chargeUntil && b.chargeUntil > t) ? 1 : 0
    ];
}

function hurt(room, amount, now) {
    const b = room.boss;
    if (!b || !b.alive) return null;
    const t = now === undefined ? Date.now() : now;
    b.health -= amount;
    if (b.health <= 0) {
        b.health = 0;
        b.alive = false;
        room.bossAlive = false;
        room.boss = null;                       // the slot is free for the next one
        room.nextBossAt = t + BOSS.nextBossMs;
        return { killed: true, boss: b };
    }
    return { killed: false, boss: b };
}

/* The countdown the clients put on the wave line, so everybody in the room is
   looking at the same clock. */
function secondsToBoss(room, now) {
    if (!room || room.boss) return -1;
    return Math.max(0, Math.ceil((room.nextBossAt - now) / 1000));
}

function clearBoss(room) {
    room.boss = null;
    room.bossAlive = false;
}

module.exports = {
    BOSS, BOSS_TYPES, initRoom, stepRoom, snapshot, hurt,
    secondsToBoss, clearBoss, emptySink
};
