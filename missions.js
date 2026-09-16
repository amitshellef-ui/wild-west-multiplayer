/* =========================================================================
   MISSIONS - server side (step 24)

   From wave 2 on, every time a wave turns over the room is handed a job for up
   to forty seconds, in turn:

     bank    defend the bank. It has 700 health, and bandit rounds that hit its
             walls take it off. Still standing after 40 seconds: done.
     wagon   escort the wagon. 450 health, 2 m/s along the main street. It only
             rolls while a player walks within 8 m of it and no bandit stands
             within 4 m. Reaching the end: done. Destroyed or out of time: not.
     hold    hold the ground. A ring of 6 m; it counts up while a living player
             is inside and no bandit is. 22 seconds of that: done.

   Winning is worth 25 health to everybody standing (here) and 30 rounds (on
   the page). Losing costs nothing but the reward. A boss riding in calls the
   mission off, with no penalty - one fight at a time.

   Half the bandits go for the objective instead of the nearest player: the ones
   with an even id that were not summoned, and only while no player is within
   10 m of them. They see `room.mission.target` exactly the way they see a
   player - see stepBandit in bandits.js - so routing, line of sight, range and
   shooting are the same code they always ran.

   All positions below were checked against the navigation grid: the wagon
   routes are clear for a body 2 m wide end to end, every hold zone is open
   ground with a path from the town centre, and the bank's door point is a
   walkable cell with a route to it.
   ========================================================================= */

const MISSION = {
    firstWave: 2,              // the first wave that brings a mission
    ms: 40000,                 // how long any mission may run
    order: ["bank", "wagon", "hold"],
    healthReward: 25,          // to every player standing, on success
    sendEveryTicks: 8,         // mission-state at most 2.5 a second...
    heartbeatTicks: 20,        // ...and at least once a second

    bank: {
        hp: 700,
        box: [-15.75, -16.5, -6.25, -8.5, 4.4],   // minX, minZ, maxX, maxZ, top - collider 1
        door: { x: -11, z: -6.6 },                // where the attackers walk to
        aim: { x: -11, y: 1.8, z: -12.5 },        // the middle of the building: any side is a wall
        keep: 9
    },

    wagon: {
        hp: 450,
        speed: 2,
        escortRange: 8,
        blockRange: 4,
        hitRadius: 1.4,
        hitY: 1,
        keep: 3,
        routes: [
            [-12, 0.5, 45, 0.5],               // 57 m - clear for the wagon, checked
            [-32, 0, 20, 0]                    // 52 m
        ]
    },

    hold: {
        radius: 6,
        needMs: 22000,
        keep: 3,
        spots: [[0, 0], [0, 40], [-25, 45], [-30, -30], [30, 30], [40, -8]]
    },

    attractRange: 10           // a bandit this close to a player fights the player
};

function initRoom(room) {
    room.mission = null;
    room.missionIndex = 0;
    room.lastHoldSpot = -1;
    room.lastRoute = -1;
}

function standing(room, players) {
    const out = [];
    for (const id in players) {
        const p = players[id];
        if (p.room === room.code && p.alive && !p.downed && !p.away) out.push(p);
    }
    return out;
}

/* The wagon starts from whichever end of whichever route is closer to where
   the players are, so nobody has to run across town before it will move. */
function pickRoute(room, players) {
    const ps = standing(room, players);
    let cx = 0, cz = 0;
    for (let i = 0; i < ps.length; i++) { cx += ps[i].x; cz += ps[i].z; }
    if (ps.length) { cx /= ps.length; cz /= ps.length; }

    let best = null, bestD = Infinity;
    const routes = MISSION.wagon.routes;
    for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        const ends = [[r[0], r[1], r[2], r[3]], [r[2], r[3], r[0], r[1]]];
        for (let k = 0; k < 2; k++) {
            const d = Math.hypot(ends[k][0] - cx, ends[k][1] - cz) + (i === room.lastRoute ? 15 : 0);
            if (d < bestD) { bestD = d; best = { i: i, e: ends[k] }; }
        }
    }
    room.lastRoute = best.i;
    return best.e;
}

function pickHoldSpot(room) {
    const spots = MISSION.hold.spots;
    let i = Math.floor(Math.random() * spots.length);
    if (i === room.lastHoldSpot) i = (i + 1) % spots.length;
    room.lastHoldSpot = i;
    return spots[i];
}

/* A new mission for the room. Returns the packet the clients need to build it,
   or null if this wave does not bring one. */
function start(room, players, now) {
    if ((room.wave || 1) < MISSION.firstWave) return null;
    const k = MISSION.order[room.missionIndex % MISSION.order.length];
    room.missionIndex++;

    const m = {
        k: k,
        startedAt: now,
        endsAt: now + MISSION.ms,
        hp: 0, maxHp: 0,
        progress: 0,
        contested: false,
        moving: false,
        sentKey: "",
        ticks: 0
    };

    if (k === "bank") {
        const c = MISSION.bank;
        m.hp = m.maxHp = c.hp;
        m.x = c.door.x; m.z = c.door.z;
        m.box = c.box;
        m.target = { id: "#mission", x: c.door.x, z: c.door.z, y: 1.8, aim: c.aim, keep: c.keep };
    } else if (k === "wagon") {
        const c = MISSION.wagon;
        const r = pickRoute(room, players);
        m.hp = m.maxHp = c.hp;
        m.x = r[0]; m.z = r[1];
        m.ex = r[2]; m.ez = r[3];
        m.sx = r[0]; m.sz = r[1];
        m.target = { id: "#mission", x: m.x, z: m.z, y: c.hitY, keep: c.keep };
        m.target.aim = m.target;
    } else {
        const c = MISSION.hold;
        const s = pickHoldSpot(room);
        m.x = s[0]; m.z = s[1];
        m.r = c.radius;
        m.target = { id: "#mission", x: m.x, z: m.z, y: 1.72, keep: c.keep, noFire: true };
    }

    room.mission = m;
    return startPacket(m, now);
}

function startPacket(m, now) {
    const out = { k: m.k, ms: Math.max(0, m.endsAt - now), x: Math.round(m.x * 100) / 100, z: Math.round(m.z * 100) / 100 };
    if (m.k === "bank") { out.hp = m.maxHp; out.h = m.hp; }
    if (m.k === "wagon") { out.hp = m.maxHp; out.h = m.hp; out.e = [m.sx, m.sz, m.ex, m.ez]; }
    if (m.k === "hold") { out.r = m.r; out.need = MISSION.hold.needMs; out.p = Math.round(m.progress); }
    return out;
}

/* What a player walking in mid-mission needs: the same as the start packet,
   with the clock and the damage where they are now. */
function publicState(room, now) {
    return room.mission ? startPacket(room.mission, now) : null;
}

function end(room, ok, why) {
    const m = room.mission;
    if (!m) return null;
    room.mission = null;
    return { k: m.k, ok: !!ok, why: why };
}

/* Called by the server when something bigger than a mission turns up. */
function cancel(room, why) {
    return end(room, false, why || "boss");
}

/* One simulation step. Writes `sink.missionEnd` when the mission is over and
   `sink.missionState` when the clients should hear about it. */
function stepRoom(room, players, now, dt, sink) {
    const m = room.mission;
    if (!m) return sink;

    // what the bullets did this tick, measured in bandits.js
    if (sink.missionHits && sink.missionHits.length && m.maxHp) {
        for (let i = 0; i < sink.missionHits.length; i++) m.hp -= sink.missionHits[i];
        if (m.hp <= 0) {
            m.hp = 0;
            sink.missionEnd = end(room, false, "destroyed");
            return sink;
        }
    }

    const ps = standing(room, players);

    if (m.k === "wagon") {
        const c = MISSION.wagon;
        let escorted = false, blocked = false;
        for (let i = 0; i < ps.length; i++) {
            if (Math.hypot(ps[i].x - m.x, ps[i].z - m.z) <= c.escortRange) { escorted = true; break; }
        }
        for (const id in room.bandits) {
            const b = room.bandits[id];
            if (b.alive && Math.hypot(b.x - m.x, b.z - m.z) <= c.blockRange) { blocked = true; break; }
        }
        m.contested = blocked;
        m.moving = escorted && !blocked;
        if (m.moving) {
            const dx = m.ex - m.x, dz = m.ez - m.z;
            const d = Math.hypot(dx, dz);
            const step = c.speed * dt;
            if (d <= step) {
                m.x = m.ex; m.z = m.ez;
                sink.missionEnd = end(room, true, "arrived");
                return sink;
            }
            m.x += dx / d * step; m.z += dz / d * step;
            m.target.x = m.x; m.target.z = m.z;
        }
    } else if (m.k === "hold") {
        const r = m.r;
        let inside = false, contested = false;
        for (let i = 0; i < ps.length; i++) {
            if (Math.hypot(ps[i].x - m.x, ps[i].z - m.z) <= r) { inside = true; break; }
        }
        for (const id in room.bandits) {
            const b = room.bandits[id];
            if (b.alive && Math.hypot(b.x - m.x, b.z - m.z) <= r) { contested = true; break; }
        }
        m.contested = contested;
        m.moving = inside && !contested;
        if (m.moving) {
            m.progress += dt * 1000;
            if (m.progress >= MISSION.hold.needMs) {
                m.progress = MISSION.hold.needMs;
                sink.missionEnd = end(room, true, "held");
                return sink;
            }
        }
    }

    if (now >= m.endsAt) {
        // the bank only has to still be there; the other two had a job to finish
        sink.missionEnd = end(room, m.k === "bank", m.k === "bank" ? "survived" : "time");
        return sink;
    }

    /* 2.5 a second only while something the page cannot work out for itself
       is changing - health, the wagon's position, who is standing where;
       otherwise a once-a-second heartbeat. The clock and the ground being held
       only ever count at one speed, so the page runs those between packets. */
    m.ticks++;
    const beat = m.ticks - (m.sentTick || 0) >= MISSION.heartbeatTicks;     // a second of silence
    if (beat || m.ticks % MISSION.sendEveryTicks === 0) {
        const st = {
            l: Math.max(0, Math.ceil((m.endsAt - now) / 100)),     // tenths of a second left
            c: m.contested ? 1 : 0,
            g: m.moving ? 1 : 0
        };
        if (m.maxHp) st.h = Math.round(m.hp);
        if (m.k === "wagon") { st.x = Math.round(m.x * 100); st.z = Math.round(m.z * 100); }
        if (m.k === "hold") st.p = Math.round(m.progress / 100);            // tenths of a second held
        const key = st.c + "|" + st.g + "|" + st.h + "|" + st.x + "|" + st.z;
        if (key !== m.sentKey || beat) {
            m.sentKey = key;
            m.sentTick = m.ticks;
            sink.missionState = st;
        }
    }
    return sink;
}

/* Which of the room's bandits the objective pulls in, and where it is. Read by
   bandits.js for every bandit, every tick - so it stays cheap. */
function targetFor(room, b, nearDist) {
    const m = room.mission;
    if (!m || !m.target || b.summoned || (b.id % 2) !== 0) return null;
    if (nearDist < MISSION.attractRange) return null;
    return m.target;
}

module.exports = { MISSION, initRoom, start, cancel, stepRoom, publicState, targetFor };
