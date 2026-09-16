/* =========================================================================
   WAVES - server side (step 13)

   The wave counter was the last thing still living in the browser. It worked
   by accident: every client counted to forty-five seconds on its own clock and
   added one, and since they had all started at roughly the same moment they
   usually agreed. Usually. Somebody who walked in late was on wave 1 while the
   room was on wave 4, and the number on their screen meant nothing.

   Now the room has a wave, and the wave has a job: it is the difficulty dial.

     wave 1   6 bandits at once
     wave 2   8
     wave 3   10        two more every wave
     ...
     wave 6   16        and it stops there

   Sixteen is not a round number, it is a measured one. A room with sixteen
   bandits and a boss costs about 2ms of a 50ms tick, with the slow ticks
   landing near 17ms; at twenty the slow ticks pass 25ms and the worst of them
   overrun the budget entirely, and every player in every room feels that as
   bandits skating across the ground. If the server ever gets more room to
   breathe, `maxCap` is the one number to raise.

   The clock matches what the browser did: forty-five seconds a wave, frozen
   while a boss is on the field, and one free wave for killing it.
   ========================================================================= */

const WAVE = {
    everyMs: 45000,        // a wave is forty-five seconds long
    startCap: 6,           // bandits alive at once in wave 1
    perWave: 2,            // and two more with every wave after it
    maxCap: 16,            // measured ceiling - see the note above
    ammoReward: 16         // rounds handed out when a wave turns over
};

/* ---- How dangerous each bandit is (step 19) --------------------------------
   The cap decides how many there are. This decides what each of them is worth.
   Measured before this existed: from wave 2 on the town is already at its cap
   the whole time, so more reinforcements change nothing - the pressure a wave
   puts on you is how fast a bandit comes back, how often it shoots, how close
   its rounds land and how much it takes to put down.

   All four move in a straight line from wave 1, which is exactly the game as
   it always was, to wave `fullAtWave`, where the cap tops out too, and stay
   there. Each pair is [wave 1, full strength]. */
const DIFFICULTY = {
    fullAtWave: 6,
    respawnMs: [2600, 1500],       // a dead bandit is back this soon
    fireDelay: [1750, 1150],       // ms between its shots
    spreadScale: [1.0, 0.6],       // x the aim error - lower lands closer
    health: [100, 150]             // what it takes to drop one
};

function difficulty(wave) {
    const n = (typeof wave === "number" && wave > 0) ? wave : 1;
    const t = Math.min(1, (n - 1) / (DIFFICULTY.fullAtWave - 1));
    const at = (pair) => pair[0] + (pair[1] - pair[0]) * t;
    return {
        respawnMs: Math.round(at(DIFFICULTY.respawnMs)),
        fireDelay: Math.round(at(DIFFICULTY.fireDelay)),
        spreadScale: Math.round(at(DIFFICULTY.spreadScale) * 1000) / 1000,
        health: Math.round(at(DIFFICULTY.health))
    };
}

/* What the bandit simulation reads. Kept on the room so it is worked out once
   a wave, not once a bullet. */
function difficultyFor(room) {
    if (!room) return difficulty(1);
    if (!room.difficulty || room.difficultyWave !== room.wave) {
        room.difficulty = difficulty(room.wave);
        room.difficultyWave = room.wave;
    }
    return room.difficulty;
}

function banditCap(wave) {
    const n = (typeof wave === "number" && wave > 0) ? wave : 1;
    return Math.min(WAVE.maxCap, WAVE.startCap + (n - 1) * WAVE.perWave);
}

/* What the bandit simulation asks before it spawns anything. */
function capFor(room) {
    return banditCap(room ? room.wave : 1);
}

function initRoom(room, now) {
    room.wave = 1;
    room.nextWaveAt = (now === undefined ? Date.now() : now) + WAVE.everyMs;
}

function secondsToWave(room, now) {
    if (!room || !room.nextWaveAt) return -1;
    return Math.max(0, Math.ceil((room.nextWaveAt - now) / 1000));
}

/* One wave on, and the room gets whatever that buys it. Returns the packet the
   clients need, or null if nothing changed. */
function advance(room, players, now, reason) {
    room.wave = (room.wave || 1) + 1;
    room.nextWaveAt = now + WAVE.everyMs;
    return {
        n: room.wave,
        cap: capFor(room),
        hp: difficultyFor(room).health,
        in: WAVE.everyMs / 1000,
        up: true,
        why: reason || "clock"
    };
}

function stepRoom(room, players, now, sink) {
    if (room.wave === undefined) initRoom(room, now);

    let occupied = false;
    for (const id in players) if (players[id].room === room.code) { occupied = true; break; }
    if (!occupied) {
        // an empty town is not fighting its way through anything
        room.nextWaveAt = now + WAVE.everyMs;
        return sink;
    }

    /* A boss fight is not a wave. The browser froze the counter the same way,
       so the wave that starts after it is the reward for winning, not something
       that ticked past while you were busy. */
    if (room.bossAlive) {
        room.nextWaveAt = Math.max(room.nextWaveAt, now + 1000);
        return sink;
    }

    if (now >= room.nextWaveAt) {
        if (sink) sink.wave = advance(room, players, now, "clock");
    }
    return sink;
}

module.exports = {
    WAVE, DIFFICULTY, banditCap, capFor, initRoom, stepRoom, advance, secondsToWave,
    difficulty, difficultyFor
};
