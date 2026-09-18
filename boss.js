/* =========================================================================
   THE BOSS - server side (step 12)

   Online there was no boss at all: the local simulation is switched off inside
   a room, and nothing on the server took its place. A room ran out of things
   to be afraid of after the first minute.

   Now the boss is the room's, exactly like the bandits are. One arrives every
   90 seconds, the next name down the list, and everyone in the room fights the
   same one at the same time.

   The ten of them (eight until step 27, nine until 28) differ in more than health. Each has an
   ability, and the ability is the reason the fight feels different:

     skeleton  a quick-draw revolver, one round a draw (step 30a - the first boss,
               instead of the old triple-burst gunman; its abilities come in 30b-30d)
     charge   closes the distance at a run and hits you with his shoulder
     robot     spins up a gatling, plants its feet and hoses where it faces
               (step 27 - see ROBOT)
     snipe     one accurate round from further than you can answer
     spray     a wall of lead, cheap per bullet
     dynamite  lobs a stick that lands where you were
     ghost     disappears and reappears somewhere else
     slam      hits the ground and hurts everyone standing near it
     poison    throws a bottle that leaves a cloud sitting on the ground
     dragon    breathes fire that burns on the ground, swoops - and is the last
               (step 28 - see DRAGON; killing it wins the game)

   All of it is simulated here. The clients are told what happened - the shot,
   the throw, the explosion, the cloud - and they draw it. No client decides
   how much anything costs, including its own damage.

   The movement is the bandit movement with the boss's own numbers: bigger
   body, closer preferred range, and its own speed. The numbers are the ones
   the browser used, so it fights the way it always did.
   ========================================================================= */
const nav = require("./navigation");
const bandits = require("./bandits");

/* The table is duplicated in the client, which owns the colours and the
   model. Anything here that the client also reads - the name, the ability
   label, the health - has to match it, so the bar says what the fight is. */
const BOSS_TYPES = [
    // step 30a - the skeleton cowboy, a model of its own. It draws from the hip, fires one
    // round and holsters again, so the delay is a whole draw (GUN.skeleton)
    { id: "skeleton", name: "BONES McCREADY", ability: "QUICK DRAW", hp: 900, fireDelay: 1100, speed: 3.0 },
    { id: "charge", name: "IRON-LUNG HANK", ability: "BULL CHARGE", hp: 1100, fireDelay: 1100, speed: 3.6 },
    // step 27 - the first boss with a model of its own. Its gun is a cycle, not a
    // fire delay (see ROBOT); fireDelay is the gap between rounds while it fires.
    { id: "robot", name: "TIN-STAR MARSHAL", ability: "GATLING ARM", hp: 1400, fireDelay: 90, speed: 2.4, radius: 0.95 },
    { id: "snipe", name: "WIDOW-MAKER SAL", ability: "LONGSHOT", hp: 750, fireDelay: 2100, speed: 2.6 },
    { id: "spray", name: "MACHINE-GUN MURPHY", ability: "LEAD STORM", hp: 1000, fireDelay: 120, speed: 3.0 },
    { id: "dynamite", name: "DYNAMITE DAISY", ability: "TNT TOSS", hp: 850, fireDelay: 1600, speed: 3.2 },
    { id: "ghost", name: "GHOST-WALKER COLE", ability: "VANISH", hp: 800, fireDelay: 900, speed: 4.0 },
    { id: "slam", name: "THUNDER-HOOF BART", ability: "EARTHQUAKE", hp: 1300, fireDelay: 1400, speed: 2.8 },
    { id: "poison", name: "POISON-DOC REED", ability: "TOXIC CLOUD", hp: 880, fireDelay: 1300, speed: 3.0 },
    // step 28 - the last one. Breathes fire from a distance (see DRAGON) and swoops;
    // killing it ends the game (`final` - server.js freezes the room and says so).
    { id: "dragon", name: "THE WYRM OF RED MESA", ability: "HELLFIRE", hp: 2400, fireDelay: 1600, speed: 3.4, radius: 1.3, keepDistance: 12, final: true }
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

/* ---- The robot's gatling (step 27) ------------------------------------------
   Not a round at a time. A cycle: it spins the barrels up (heard, not fired),
   then fires a round every roundMs for fireMs, then cools down. While it spins
   and fires it stands still and turns slowly (fireTurn, radians a second), and
   the rounds go where it is facing, not where you are - so the answer to it is
   to move round its side. Anybody who comes within stompTrigger gets stomped.
   Phase two ("OVERDRIVE") spins up faster, fires longer, and vents a cloud of
   steam round its feet at the end of every burst: getting close costs. */
const ROBOT = {
    spinMs: 800, fireMs: 2500, coolMs: 2000, roundMs: 90,
    fireTurn: 0.9,             // radians a second while planted
    stompTrigger: 4, stompRadius: 5, stompDamage: 20, stompEveryMs: 4000,
    p2: { spinMs: 300, fireMs: 4000, coolMs: 2000, fireTurn: 1.2 },
    steamRadius: 3, steamDamage: 4, steamLife: 3
};

/* ---- The dragon (step 28) -----------------------------------------------------
   The last boss. It keeps its distance (keepDistance 12 on its row) and breathes
   fire: a fireball lobbed to land where you are standing when it lets go, which
   bursts into a pool of fire on the ground - so the answer is to keep moving, and
   not to go back to where it just landed. Anybody within swoopTrigger with a line
   to it gets swooped: a run at breakneck speed that hits hard if it arrives.
   Phase two ("THE SKY BURNS") roars four bandits in, breathes two fireballs at a
   time in a fan, and swoops far more often. */
const DRAGON = {
    breathSpeed: 18,           // metres a second along the ground; the arc takes what it takes
    breathMinFlight: 0.35,     // seconds - even point blank it is a lob, not a shove
    poolRadius: 4.2, poolDamage: 8, poolLife: 4,     // bites every BOSS.cloudTick like the poison
    swoopTrigger: 22, swoopEveryMs: 6000, swoopForMs: 1400, swoopSpeed: 16,
    swoopHitRange: 2.9, swoopDamage: 30,
    p2: { summon: 4, breaths: 2, fanSpread: 0.35, swoopEveryMs: 3500 }
};

/* ---- Phase two (step 21) ---------------------------------------------------
   Below 30% health every boss changes. All of them fire a third faster, move a
   little quicker and are drawn enraged; each also gets one thing of its own, so
   the end of a fight is not just the start of it with less health left.

     skeleton  only the common part for now (draws a third faster) - step 30
     charge    charges back to back
     snipe     calls three bandits to her and backs off to 18 metres
     spray     every 3 seconds, a ring of 12 rounds in every direction
     dynamite  three sticks in a fan
     ghost     vanishes twice as often
     slam      a wider, more frequent quake
     poison    two bottles a throw, and the cloud lingers for 8 seconds
     robot     OVERDRIVE: spins up in 0.3s, fires for 4s, and vents steam (ROBOT.p2)
     dragon    THE SKY BURNS: four bandits, two fireballs a breath, swoops (DRAGON.p2) */
const PHASE2 = {
    at: 0.3,
    fireScale: 0.75,           // x the time between shots
    speedScale: 1.15,
    chargeEveryMs: 2800,
    summonCount: 3,
    snipeKeepDistance: 18,
    ringEveryMs: 3000,
    ringRounds: 12,
    fanSticks: 3,
    fanSpread: 0.35,           // radians between sticks
    ghostEveryMs: 2200,
    slamRadius: 9,
    slamTrigger: 11,
    slamEveryMs: 3200,
    poisonBottles: 2,
    poisonSpread: 0.22,
    cloudLife: 8
};

/* Per-ability gunplay. Anything missing falls back to the first row. */
const GUN = {
    skeleton: { shots: 1, spread: 0.02, perMetre: 0.0014, damage: 24, speed: 46 },
    charge: { shots: 1, spread: 0.04, perMetre: 0, damage: 15, speed: 42 },
    snipe: { shots: 1, spread: 0.006, perMetre: 0, damage: 32, speed: 72 },
    spray: { shots: 1, spread: 0.055, perMetre: 0.0012, damage: 8, speed: 48 },
    robot: { shots: 1, spread: 0.055, perMetre: 0.0012, damage: 8, speed: 48 },
    ghost: { shots: 1, spread: 0.022, perMetre: 0.0016, damage: 15, speed: 42 },
    slam: { shots: 1, spread: 0.022, perMetre: 0.0016, damage: 18, speed: 42 },
    dynamite: { shots: 0 },
    poison: { shots: 0 },
    dragon: { shots: 0 }
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
function pickBossSpawn(room, players, radius) {
    let fallback = nav.randomNavPoint();
    for (let attempt = 0; attempt < 60; attempt++) {
        const p = nav.randomNavPoint();
        if (nav.collidesAt(p.x, p.z, radius || BOSS.radius)) continue;
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

    const radius = type.radius || BOSS.radius;      // step 27: a bigger body keeps out of walls
    const p = pickBossSpawn(room, players, radius);
    room.boss = {
        typeIndex: typeIndex,
        type: type,
        x: p.x, z: p.z,
        yaw: Math.random() * Math.PI * 2,
        health: type.hp,
        maxHealth: type.hp,
        radius: radius,
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
    const r = b.radius || BOSS.radius;
    if (dx !== 0 && !nav.collidesAt(b.x + dx, b.z, r)) b.x += dx;
    if (dz !== 0 && !nav.collidesAt(b.x, b.z + dz, r)) b.z += dz;
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
    const g = GUN[b.type.id] || GUN.skeleton;
    const ox = b.x, oy = BOSS.eyeHeight, oz = b.z;
    const tx = target.x, ty = target.y || 1.72, tz = target.z;

    let bx = tx - ox, by = ty - oy, bz = tz - oz;
    const len = Math.hypot(bx, by, bz) || 1;
    bx /= len; by /= len; bz /= len;

    const spread = g.spread + dist * (g.perMetre || 0);
    const shots = g.shots;

    for (let i = 0; i < shots; i++) {
        const off = g.spacing ? (i - (shots - 1) / 2) * g.spacing : 0;
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
function throwHazard(room, b, target, kind, sink, turn) {
    const from = { x: b.x, y: BOSS.eyeHeight, z: b.z };
    let dx = target.x - from.x;
    let dy = (target.y || 1.72) - from.y + 4;
    let dz = target.z - from.z;
    if (turn) {                                  // swing it sideways for a fan
        const c = Math.cos(turn), sn = Math.sin(turn);
        const rx = dx * c - dz * sn, rz = dx * sn + dz * c;
        dx = rx; dz = rz;
    }
    const n = Math.hypot(dx, dy, dz) || 1;
    dx /= n; dy /= n; dz /= n;

    const speed = kind === "tnt" ? BOSS.tntSpeed : BOSS.poisonSpeed;
    const fuse = kind === "tnt" ? BOSS.tntFuse : BOSS.poisonFuse;
    const id = room.nextHazardId++;

    room.hazards.push({
        id: id, kind: kind,
        x: from.x, y: from.y, z: from.z,
        vx: dx * speed, vy: dy * speed, vz: dz * speed,
        life: fuse,
        cloudLife: (kind === "poison" && b.phase === 2) ? PHASE2.cloudLife : BOSS.cloudLife
    });

    sink.hazards.push({
        i: id, k: kind,
        o: [round2(from.x), round2(from.y), round2(from.z)],
        v: [round2(dx * speed), round2(dy * speed), round2(dz * speed)],
        f: fuse
    });
}

/* The dragon's breath (step 28): lobbed so that it comes down where the target is
   standing now, at breathSpeed along the ground - so it lands on a player who
   stays put, and behind one who keeps moving. It bursts on the ground (stepHazards)
   into a pool of fire. `turn` swings it sideways for the fan of phase two. */
function breathFire(room, b, target, sink, turn) {
    const oy = BOSS.eyeHeight;
    let tx = target.x - b.x, tz = target.z - b.z;
    if (turn) {
        const c = Math.cos(turn), sn = Math.sin(turn);
        const rx = tx * c - tz * sn, rz = tx * sn + tz * c;
        tx = rx; tz = rz;
    }
    const flat = Math.hypot(tx, tz) || 0.01;
    const T = Math.max(DRAGON.breathMinFlight, flat / DRAGON.breathSpeed);
    const vx = tx / T, vz = tz / T;
    const vy = (0.12 - oy) / T + 0.5 * BOSS.gravity * T;    // on the ground at T
    const id = room.nextHazardId++;
    room.hazards.push({
        id: id, kind: "fire",
        ox: b.x, oz: b.z, x: b.x, z: b.z,
        vx: vx, vz: vz,
        t: 0, T: T                                          // lands at T - see stepHazards
    });
    sink.hazards.push({
        i: id, k: "fire",
        o: [round2(b.x), round2(oy), round2(b.z)],
        v: [round2(vx), round2(vy), round2(vz)],
        f: round2(T)
    });
}

function stepHazards(room, players, dt, sink) {
    for (let i = room.hazards.length - 1; i >= 0; i--) {
        const h = room.hazards[i];
        if (h.kind === "fire") {
            /* On its arc by the clock, not step by step - so it comes down exactly
               where it was aimed, at exactly T, whatever the tick length. Fire does
               not bounce: it bursts where it lands. */
            h.t += dt;
            if (h.t < h.T) continue;
            h.x = h.ox + h.vx * h.T;
            h.z = h.oz + h.vz * h.T;
            room.hazards.splice(i, 1);
            sink.booms.push({ i: h.id, k: "fire", p: [round2(h.x), 0.12, round2(h.z)], l: DRAGON.poolLife, r: DRAGON.poolRadius });
            // the pool bites straight away - landing on somebody is not a free second
            room.clouds.push({ x: h.x, z: h.z, life: DRAGON.poolLife, tick: BOSS.cloudTick, r: DRAGON.poolRadius, dmg: DRAGON.poolDamage });
            continue;
        }
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
        sink.booms.push({ i: h.id, k: h.kind, p: [round2(h.x), round2(h.y), round2(h.z)], l: h.cloudLife });

        if (h.kind === "tnt") {
            splash(room, players, h.x, h.z, BOSS.tntRadius, BOSS.tntDamage, true, sink, h.y);
        } else {
            room.clouds.push({
                x: h.x, z: h.z,
                life: h.cloudLife || BOSS.cloudLife,
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
            splash(room, players, c.x, c.z, c.r || BOSS.cloudRadius, c.dmg || BOSS.cloudDamage, false, sink);
        }
        if (c.life <= 0) room.clouds.splice(i, 1);
    }
}

/* The robot's round: along the way it is facing, dropping towards the target's
   chest - so a player who has got round its side is not hit, however near. */
function fireFacing(room, b, target, sink) {
    const g = GUN.robot;
    const oy = BOSS.eyeHeight;
    const hx = Math.sin(b.yaw), hz = Math.cos(b.yaw);
    const flat = Math.max(1, Math.hypot(target.x - b.x, target.z - b.z));
    const drop = ((target.y || 1.72) - oy) / flat;
    const spread = g.spread + flat * g.perMetre;
    let dx = hx + (Math.random() - 0.5) * spread * 2;
    let dy = drop + (Math.random() - 0.5) * spread * 1.5;
    let dz = hz + (Math.random() - 0.5) * spread * 2;
    const n = Math.hypot(dx, dy, dz) || 1;
    dx /= n; dy /= n; dz /= n;
    room.bullets.push({ x: b.x, y: oy, z: b.z, dx: dx, dy: dy, dz: dz, life: 0, from: -1, dmg: g.damage, spd: g.speed });
    sink.bossShots.push({ k: "robot", o: [round2(b.x), round2(oy), round2(b.z)], d: [round3(dx), round3(dy), round3(dz)] });
}

/* A cloud with its own size and bite (the robot's steam), next to the poison's. */
function ventSteam(room, b, sink) {
    const id = room.nextHazardId++;
    room.clouds.push({ x: b.x, z: b.z, life: ROBOT.steamLife, tick: 0, r: ROBOT.steamRadius, dmg: ROBOT.steamDamage });
    sink.booms.push({ i: id, k: "steam", p: [round2(b.x), 0.12, round2(b.z)], l: ROBOT.steamLife, r: ROBOT.steamRadius });
}

/* spin -> fire -> cool -> ready. b.gState is sent to the clients (snapshot) so
   they can spin the barrels and hold the gun up for exactly as long as it lasts. */
function tickRobot(room, b, players, near, now, dt, sink) {
    const G = b.phase === 2 ? ROBOT.p2 : ROBOT;
    if (!b.gState) b.gState = "ready";
    if (b.gState === "ready") {
        if (b.hasLos && near && near.dist < BOSS.fireRange && now >= b.abilityAt) {
            b.gState = "spin"; b.gUntil = now + G.spinMs;
        }
    } else if (b.gState === "spin") {
        if (now >= b.gUntil) { b.gState = "fire"; b.gUntil = now + G.fireMs; b.gNext = now; }
    } else if (b.gState === "fire") {
        // a round every roundMs; with nobody to aim at it keeps the barrels turning
        while (now >= b.gNext && b.gNext < b.gUntil) {
            if (near) fireFacing(room, b, near.player, sink);
            b.gNext += ROBOT.roundMs;
        }
        if (now >= b.gUntil) {
            b.gState = "cool"; b.gUntil = now + G.coolMs;
            if (b.phase === 2) ventSteam(room, b, sink);
        }
    } else if (b.gState === "cool") {
        if (now >= b.gUntil) b.gState = "ready";
    }
    // the stomp is its own clock, gun or no gun
    if (near && near.dist < ROBOT.stompTrigger && now >= (b.stompAt || 0)) {
        b.stompAt = now + ROBOT.stompEveryMs;
        splash(room, players, b.x, b.z, ROBOT.stompRadius, ROBOT.stompDamage, false, sink);
        sink.slams.push({ p: [round2(b.x), round2(b.z)], k: "stomp", r: ROBOT.stompRadius });
    }
}

/* ---- Abilities ---------------------------------------------------------- */
function tickAbility(room, b, players, near, now, dt, sink) {
    const id = b.type.id;

    if (id === "robot") { tickRobot(room, b, players, near, now, dt, sink); return; }

    /* The dragon's swoop (step 28): the charge, with its own numbers. It rides
       on chargeUntil so the walking stands aside and the clients see the flag. */
    if (id === "dragon") {
        if (b.hasLos && near && near.dist < DRAGON.swoopTrigger && now >= b.abilityAt) {
            b.abilityAt = now + (b.phase === 2 ? DRAGON.p2.swoopEveryMs : DRAGON.swoopEveryMs);
            b.chargeUntil = now + DRAGON.swoopForMs;
            sink.roars.push({ p: [round2(b.x), round2(b.z)] });
        }
        if (b.chargeUntil && now < b.chargeUntil && near) {
            const step = DRAGON.swoopSpeed * dt;
            const d = near.dist || 0.01;
            moveAxis(b, ((near.player.x - b.x) / d) * step, ((near.player.z - b.z) / d) * step);
            if (Math.hypot(near.player.x - b.x, near.player.z - b.z) < DRAGON.swoopHitRange) {
                b.chargeUntil = 0;
                sink.hits.push({ playerId: near.player.id, damage: DRAGON.swoopDamage, from: "boss" });
                sink.slams.push({ p: [round2(b.x), round2(b.z)], k: "swoop" });
            }
        }
        return;
    }

    if (id === "ghost") {
        if (now >= b.abilityAt) {
            b.abilityAt = now + (b.phase === 2 ? PHASE2.ghostEveryMs : BOSS.ghostEveryMs);
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
                if (nav.collidesAt(dest.x, dest.z, b.radius || BOSS.radius)) continue;
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
            b.abilityAt = now + (b.phase === 2 ? PHASE2.chargeEveryMs : BOSS.chargeEveryMs);
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
        const p2 = b.phase === 2;
        if (near && near.dist < (p2 ? PHASE2.slamTrigger : BOSS.slamTrigger) && now >= b.abilityAt) {
            b.abilityAt = now + (p2 ? PHASE2.slamEveryMs : BOSS.slamEveryMs);
            const radius = p2 ? PHASE2.slamRadius : BOSS.slamRadius;
            splash(room, players, b.x, b.z, radius, BOSS.slamDamage, false, sink);
            sink.slams.push({ p: [round2(b.x), round2(b.z)], k: "slam", r: radius });
        }
    }
}

/* ---- The boss itself ---------------------------------------------------- */
/* The moment it turns. Once only - health does not go back up. */
function enterPhase2(room, b, players, now, sink) {
    b.phase = 2;
    b.ringAt = now + 1200;
    let summoned = 0;
    if (b.type.id === "snipe") summoned = bandits.summon(room, players, b.x, b.z, PHASE2.summonCount);
    if (b.type.id === "dragon") {
        summoned = bandits.summon(room, players, b.x, b.z, DRAGON.p2.summon);
        b.abilityAt = Math.min(b.abilityAt, now + 1500);   // and it comes for you
    }
    sink.bossPhase = { t: b.typeIndex, s: summoned };
    sink.roars.push({ p: [round2(b.x), round2(b.z)] });
}

/* A ring of rounds in every direction, at chest height further out. */
function ringVolley(room, b, sink) {
    const g = GUN.spray;
    const oy = BOSS.eyeHeight;
    const drop = (1.72 - oy) / 12;               // level off to a standing player about 12 m away
    for (let i = 0; i < PHASE2.ringRounds; i++) {
        const a = (i / PHASE2.ringRounds) * Math.PI * 2 + Math.random() * 0.1;
        let dx = Math.cos(a), dy = drop, dz = Math.sin(a);
        const n = Math.hypot(dx, dy, dz);
        dx /= n; dy /= n; dz /= n;
        room.bullets.push({ x: b.x, y: oy, z: b.z, dx: dx, dy: dy, dz: dz, life: 0, from: -1, dmg: g.damage, spd: g.speed });
        sink.bossShots.push({ k: "spray", o: [round2(b.x), round2(oy), round2(b.z)], d: [round3(dx), round3(dy), round3(dz)] });
    }
}

function stepBoss(room, b, players, now, dt, sink) {
    const near = nearestPlayer(room, players, b.x, b.z);
    if (b.phase !== 2 && b.health <= b.maxHealth * PHASE2.at) enterPhase2(room, b, players, now, sink);
    const keepDistance = (b.phase === 2 && b.type.id === "snipe") ? PHASE2.snipeKeepDistance
        : (b.type.keepDistance || BOSS.keepDistance);                 // step 28: the dragon stands off at 12

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
        if (b.hasLos && near.dist < keepDistance + 4 && near.dist > keepDistance - 4) {
            wantsMove = false;
        }
        /* A boss with a distance of its own (the dragon, step 28) does not walk
           into you when you are too close - it backs off (the strafe below) to
           where it breathes from. The others close in, as they always have. */
        if (b.type.keepDistance && b.hasLos && near.dist <= keepDistance - 4) wantsMove = false;
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
    const charging = b.chargeUntil && now < b.chargeUntil;
    // the robot plants its feet while the barrels spin and fire (step 27)
    const planted = b.gState === "spin" || b.gState === "fire";
    const baseSpeed = b.type.speed * (b.phase === 2 ? PHASE2.speedScale : 1);
    const speed = b.state === "chase" ? baseSpeed : baseSpeed * 0.55;
    let moved = false;
    if (!charging && !planted && wantsMove && b.path && b.pathIndex < b.path.length) {
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
    if (!charging && !planted && !moved && b.state === "chase" && near && b.hasLos) {
        if (now >= b.strafeAt) {
            b.strafeAt = now + 1100 + Math.random() * 1800;
            b.strafeDir *= -1;
        }
        const tx = near.player.x - b.x, tz = near.player.z - b.z;
        const len = Math.hypot(tx, tz) || 1;
        const px = -tz / len, pz = tx / len;
        const back = near.dist < keepDistance - 3 ? -1 : 0;
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
                const spot = nav.freeSpotNear(b.x, b.z, 2, 14, b.radius || BOSS.radius);
                if (spot) { b.x = spot.x; b.z = spot.z; }
                b.wedgedFor = 0;
            }
        } else {
            b.wedgedFor = 0;
        }
        b.lastX = b.x; b.lastZ = b.z;
    }

    bandits.recordTrail(b);

    /* --- shooting --- */
    const range = b.type.id === "snipe" ? BOSS.snipeRange : BOSS.fireRange;
    const fireDelay = b.type.fireDelay * (b.phase === 2 ? PHASE2.fireScale : 1);
    if (b.type.id !== "robot" && b.hasLos && near && near.dist < range && now - b.lastShot > fireDelay) {
        b.lastShot = now + (Math.random() - 0.5) * 350;
        const p2 = b.phase === 2;
        if (b.type.id === "dynamite") {
            const n = p2 ? PHASE2.fanSticks : 1;
            for (let i = 0; i < n; i++) throwHazard(room, b, near.player, "tnt", sink, (i - (n - 1) / 2) * PHASE2.fanSpread);
        } else if (b.type.id === "poison") {
            const n = p2 ? PHASE2.poisonBottles : 1;
            for (let i = 0; i < n; i++) throwHazard(room, b, near.player, "poison", sink, (i - (n - 1) / 2) * PHASE2.poisonSpread * 2);
        } else if (b.type.id === "dragon") {
            if (!(b.chargeUntil && now < b.chargeUntil)) {      // not in the middle of a swoop
                const n = p2 ? DRAGON.p2.breaths : 1;
                for (let i = 0; i < n; i++) breathFire(room, b, near.player, sink, (i - (n - 1) / 2) * DRAGON.p2.fanSpread);
            }
        } else {
            fire(room, b, near.player, near.dist, sink);
        }
    }
    if (b.phase === 2 && b.type.id === "spray" && near && near.dist < 30 && now >= b.ringAt) {
        b.ringAt = now + PHASE2.ringEveryMs;
        ringVolley(room, b, sink);
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
        if (planted) {
            // slowly: getting round its side is the way out of the stream
            const turn = (b.phase === 2 ? ROBOT.p2.fireTurn : ROBOT.fireTurn) * dt;
            b.yaw += Math.max(-turn, Math.min(turn, d));
        } else b.yaw += d * Math.min(1, 9 * dt);
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
        bossSpawn: null, bossDied: null, bossPhase: null, wave: null,
        missionHits: [], missionEnd: null, missionState: null      // step 24, see missions.js
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
        (b.chargeUntil && b.chargeUntil > t) ? 1 : 0,
        b.phase === 2 ? 1 : 0,
        // step 27: the robot's gun - 1 spinning up, 2 firing (0 for everybody else)
        b.gState === "spin" ? 1 : (b.gState === "fire" ? 2 : 0)
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
    BOSS, BOSS_TYPES, PHASE2, ROBOT, DRAGON, GUN, initRoom, stepRoom, snapshot, hurt,
    secondsToBoss, clearBoss, emptySink
};
