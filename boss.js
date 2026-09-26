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
               instead of the old triple-burst gunman), and HIGH NOON: it marks a
               player, counts three seconds down and fires one shot of 80 - unless
               the player is in cover, or somebody shoots it in the skull first
               (step 30b - see SKELETON). At half health, once, it falls apart and
               comes back together behind somebody (step 30c - BONE SCATTER). The
               last: BONE HARVEST, three rings of bones along the ground - jump the
               low ones, stay down for the high one (step 30d).
     charge   closes the distance at a run and hits you with his shoulder
     robot     spins up a gatling, plants its feet and hoses where it faces
               (step 27 - see ROBOT)
     snipe     one accurate round from further than you can answer
     spray     a wall of lead, cheap per bullet
     dynamite  lobs a stick that lands where you were
     ghost     turns to mist, is gone for a second and comes out of the ground
               beside somebody at a run - GHOST DASH (step 31d, which took the
               old VANISH's place); every few seconds raises its gun in both
               hands for a SPECTRAL SHOT: a fast round that goes through walls
               (step 31b - see GHOST); and raises a hand for a GRAVE BURST:
               hands out of the ground under you (step 31c)
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
    { id: "skeleton", name: "BONES McCREADY", ability: "HIGH NOON", hp: 900, fireDelay: 1100, speed: 3.0 },
    { id: "charge", name: "IRON-LUNG HANK", ability: "BULL CHARGE", hp: 1100, fireDelay: 1100, speed: 3.6 },
    // step 27 - the first boss with a model of its own. Its gun is a cycle, not a
    // fire delay (see ROBOT); fireDelay is the gap between rounds while it fires.
    { id: "robot", name: "TIN-STAR MARSHAL", ability: "GATLING ARM", hp: 1400, fireDelay: 90, speed: 2.4, radius: 0.95 },
    { id: "snipe", name: "WIDOW-MAKER SAL", ability: "LONGSHOT", hp: 750, fireDelay: 2100, speed: 2.6 },
    { id: "spray", name: "MACHINE-GUN MURPHY", ability: "LEAD STORM", hp: 1000, fireDelay: 120, speed: 3.0 },
    { id: "dynamite", name: "DYNAMITE DAISY", ability: "TNT TOSS", hp: 850, fireDelay: 1600, speed: 3.2 },
    { id: "ghost", name: "GHOST-WALKER COLE", ability: "GHOST DASH", hp: 800, fireDelay: 900, speed: 4.0 },
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
    keepDistance: 9,
    fireRange: 38,
    snipeRange: 70,
    bulletLife: 3.5,

    /* Abilities */
    /* step 31d: the ghost's old VANISH (ghostEveryMs / ghostForMs / blinkMin /
       blinkMax - a jump to a random point 8-26 m away) is gone from the server.
       GHOST DASH took its place, and it always comes out 7 m from somebody, so
       the range the blink needed is not a question any more. Offline (the
       browser's own brain) still vanishes: it has numbers of its own. */
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
    // step 33b - EMBER RAIN, see below
    emberFirstMs: 8000, emberEveryMs: 16000, emberRange: 35,
    takeoffMs: 800, liftTo: 6, spitMs: 917, spitAtMs: 583,
    warnMs: 1200, spreadMs: 400, hoverAfterMs: 300, landMs: 700, emberGapMs: 2000,
    emberCount: 12, emberPerPlayer: 2, emberMax: 20, emberNear: 0.5, aroundR: 5, randomR: 16,
    emberRadius: 1.6, emberDamage: 25,
    emberPoolRadius: 1.5, emberPoolLife: 3, emberPoolTick: 0.6, emberPoolDamage: 3,
    // step 33c - TAIL SWEEP, see below
    tailFirstMs: 3000, tailEveryMs: 7000, tailTrigger: 7, tailRange: 8,
    tailChargeMs: 790, tailSweepMs: 500, tailRecoverMs: 625, tailGapMs: 1500,
    tailDamage: 40, tailKnock: 13,
    // step 33d - the ROAR (phase two only), see below
    roarFirstMs: 3000, roarEveryMs: 15000, roarRange: 45,
    roarSwellMs: 1250, roarAfterMs: 958, roarDazeMs: 2000, roarGapMs: 1500,
    layMs: 500, eggsAtMs: 250,           // step 33d2: LayEggs (12 frames), the eggs drop at frame 6
    p2: { summon: 4, breaths: 2, fanSpread: 0.35, swoopEveryMs: 3500, emberEveryMs: 11200, tailEveryMs: 4900 }
};

/* ---- The dragon's ROAR (step 33d) ---------------------------------------------
   Phase two only: roarFirstMs after it turns, then every roarEveryMs, when somebody
   living is within roarRange. Roar, 53 frames:

     swell  roarSwellMs  its chest fills and its throat glows (frames 0-30) - the
                         warning: get something between you and it
     roar   roarAfterMs  the shout (frame 30 on). Everybody living within roarRange
                         with a clear line to it on the ground (nav.losClear - any
                         collider in the way is cover, a barrel as much as a wall) is
                         dazed for roarDazeMs: their screen blurs and shakes. No damage.

     lay    layMs        step 33d2: LayEggs - it crouches and eggsAtMs in the eggs drop in
                         an arc in front of it (bandits.js, BROOD: how many, and what
                         hatches out of them). Skipped when the room is at the brood's cap.

   All through it: planted, no breath; swoop, rain and tail wait roarGapMs after it,
   and it waits as long after them. b.roar = { e, until }. */

/* ---- The dragon's TAIL SWEEP (step 33c) ---------------------------------------
   It keeps its distance, and this is what it does to whoever does not: when somebody
   living is within tailTrigger of it (every tailEveryMs at most, the first tailFirstMs
   after it arrives; p2 30% sooner), and it is not in the air or in a swoop:

     charge   tailChargeMs   TailSweep, frames 0-19: it crouches and draws the tail
                             aside, growling - the warning. It does not turn.
     sweep    tailSweepMs    frames 19-31: the whole body spins once round (the clients
                             turn it - the server's yaw stays where it was), `dir` one
                             way or the other, the tail sweeping the ground out to
                             tailRange. It reaches every bearing once: a player is judged
                             at the moment it crosses where they are (from the line the
                             tail started on), the way the ghost's circle is judged - any
                             sample SKELETON.dodgeFromMs..dodgeToMs after it with their
                             feet above lowClear (a jump) or out beyond tailRange, and it
                             missed. Otherwise tailDamage, and they are thrown outwards at
                             tailKnock m/s (their own page moves them - `hit` says from where).
     recover  tailRecoverMs  frames 31-46, back up

   All through it: planted, no breath. The swoop and EMBER RAIN wait tailGapMs after it,
   and it waits as long after them. b.tail = { e, until, yaw, dir, T0, judged, feet }. */

/* ---- The dragon's EMBER RAIN (step 33b) ---------------------------------------
   Every emberEveryMs (the first emberFirstMs after it arrives; p2 30% sooner) it
   picks everybody living within emberRange - no line needed, it comes down from the
   sky - and goes:

     takeoff  takeoffMs   TakeOff: it beats its wings and rises liftTo metres
     spit     spitMs      SpitUp: head back, and at spitAtMs a mouthful of embers
                          thrown at the sky. That is the moment every landing spot
                          is picked and told (`rain`): emberNear of them round the
                          players - the first one right where each of them is standing,
                          the others within aroundR of one of them - and the rest
                          anywhere within randomR of the dragon. Each lands warnMs
                          (+ up to spreadMs) later, with a ring on the ground until then.
     hover    ...         Hover, high up, until the last one is down and judged
     land     landMs      back down to the ground

   Where one lands: emberDamage to everybody within emberRadius, and a small pool of
   fire (emberPool*) that burns for a while. It is judged the way the ghost's circle is
   (SKELETON dodgeFromMs / dodgeToMs): any sample of where their feet were in that
   window outside it, and it missed - what they saw arrived late, and so does their
   step. Standing still is what it punishes; walking out of the ring is the answer.
   All through it: planted, no breath and no swoop (the swoop waits emberGapMs after
   it). It can be shot the whole time - up in the air, which the line of fire knows
   (liftOf, server.js boss-hit). b.ember = { e, until, spitAt, drops, feet }. */

/* ---- The skeleton's duel, HIGH NOON (step 30b) ------------------------------
   Every duelEveryMs (the first duelFirstMs after it arrives) it picks one player
   it can see within duelRange, marks them - everybody in the room sees a skull
   over them and the same countdown - plants its feet with a hand over the holster,
   and after countdownMs fires one round of duelDamage. The answers: be out of its
   line when the count ends (cover), or put a round through its skull before it
   does - a headshot from anybody breaks the duel, the shot never comes, and it
   goes down on one knee for staggerMs, not moving and not shooting. A mark whose
   player goes down, dies or leaves is dropped. */
const SKELETON = {
    duelFirstMs: 6000, duelEveryMs: 15000, duelRange: 32,
    countdownMs: 3000, duelDamage: 80, missBeyond: 45,
    staggerMs: 2000,
    // step 30c - BONE SCATTER, once, the first time its health reaches scatterAt
    scatterAt: 0.5, collapseMs: 1000, goneMs: 2000, riseMs: 1250,
    meleeMs: 833, meleeHitMs: 375, meleeRange: 3.2, meleeDamage: 30,
    behindDist: 2.4, afterScatterMs: 5000,
    lungeSpeed: 16, lungeStop: 1.2,         // the leap at whoever it came for, until the blow lands
    // step 30d - BONE HARVEST, see below
    harvestFirstMs: 14000, harvestEveryMs: 22000, harvestRange: 22,
    summonMs: 1500, spinMs: 1000, ringAtMs: 300, waves: ["low", "high", "low"],
    ringSpeed: 9, ringStart: 1.0, ringMax: 24, ringDamage: 25, lowClear: 0.3, groundFeet: 0.12,
    dodgeFromMs: 50, dodgeToMs: 250, tiredMs: 3000, gapMs: 3000
};

/* ---- The ghost's SPECTRAL SHOT (step 31b) -------------------------------------
   Next to its ordinary gun. Every spectralEveryMs (the first spectralFirstMs after
   it arrives; p2 in phase two) it picks the nearest player within spectralRange -
   with or without a line to them: whoever is sitting behind a wall is exactly who
   it is for. It stops, raises the gun in both hands (raiseMs), and the gun glows
   for flashMs - the warning, which the clients draw through walls. It follows its
   target until lockMs before the round leaves, and from then on the aim does not
   move: a player who keeps moving through the flash is missed, one who stands is
   hit. One round of spectralDamage at spectralSpeed, which no wall stops (`thru` -
   bandits.js stepBullets) and which is gone after spectralReach metres. Then it
   lowers the gun (lowerMs). All through it: planted, the ordinary gun silent, and
   no VANISH - that waits until the gun is down. Killing it before the round leaves
   is the other answer. b.spectral = { e: aim / lock / lower, target, lockAt, fireAt }.

   GRAVE BURST (step 31c). Every graveEveryMs (the first graveFirstMs after it
   arrives) it picks a living player at random within graveRange - no line needed,
   it comes out of the ground. It stops and raises its left hand (graveRaiseMs), and
   a dark circle of graveRadius opens on the ground right where that player is
   standing at that moment. It fills for graveFillMs - and then the hands burst out
   of it: graveDamage to everybody inside it and on the ground, not only whoever it
   was for. The answers are the ones the skeleton's low ring has - be out of it, or
   in the air - and it is judged the same way, with the same numbers (SKELETON
   dodgeFromMs / dodgeToMs / lowClear): any sample between those two moments after
   the burst with the feet out of the circle or above lowClear, and it missed. Then
   the hand comes down (graveLowerMs). All through it: planted, the ordinary gun
   silent, no VANISH. The SPECTRAL SHOT and it never run together; whichever comes
   second waits gapMs after the other is over. Killing it before the burst is the
   other answer - the circle goes with it.
   b.grave = { e: raise / fill / burst, target, until, i, x, z, T, inside, judged }.

   GHOST DASH (step 31d), which took the old VANISH's place. Every dashEveryMs (the
   first dashFirstMs after it arrives) it picks a living player at random within
   dashRange - no line needed - and goes:

     mist     mistMs      it wraps itself up and thins out. Still there to be shot.
     gone     dashGoneMs  no body at all (`hurt` returns null, like the skeleton's
                          scatter). markLeadMs before it comes out, a whirl of mist
                          opens on the ground where it is going to - the warning.
     appear   appearMs    it unfolds appearDist from its target, at a random angle
                          (not behind - behind is the skeleton's), somewhere the body
                          fits and there is a straight line from there to them. At the
                          end of this part the direction locks, on where they are then.
     dash     dashMaxMs   dashSpeed in a straight line, at most dashReach metres,
                          stopped by a wall. Everybody within dashWidth of the line it
                          takes is hit for dashDamage - once each, however many times
                          the line crosses them.
     recover  recoverMs   planted, not shooting: the window to hurt it.

   The answer is a step to the side once it is out: the aim is locked on where you
   were, not where you are going. In phase two there is no recover after the first
   dash - a short mist (p2.dashMistMs / p2.dashGoneMs), a new mark, a second dash,
   and only then recover. A target that goes down or leaves while it is gone: it
   comes out where it went in and there is no charge. It never runs with a SPECTRAL
   SHOT or a GRAVE BURST - whichever comes second waits gapMs.
   b.dash = { e, until, target, left, fx, fz, mx, mz, marked, ox, oz, dx, dz, gone, hit }. */
const GHOST = {
    spectralFirstMs: 5000, spectralEveryMs: 7000, spectralRange: 45,
    raiseMs: 250, flashMs: 600, lockMs: 250, lowerMs: 500,
    spectralDamage: 60, spectralSpeed: 60, spectralReach: 50,
    // step 31c - GRAVE BURST
    graveFirstMs: 10000, graveEveryMs: 13000, graveRange: 30,
    graveRaiseMs: 500, graveFillMs: 1100, graveLowerMs: 350,
    graveRadius: 2.5, graveDamage: 40, gapMs: 2500,
    // step 31d - GHOST DASH
    dashFirstMs: 8000, dashEveryMs: 12000, dashRange: 40,
    mistMs: 500, dashGoneMs: 1000, markLeadMs: 700, appearMs: 450, appearDist: 7,
    dashSpeed: 16, dashReach: 12, dashMaxMs: 750, dashWidth: 1.8, dashDamage: 35,
    recoverMs: 1000,
    p2: { spectralEveryMs: 5000, dashes: 2, dashMistMs: 400, dashGoneMs: 400 }
};

/* ---- The skeleton's BONE HARVEST (step 30d) ----------------------------------
   Every harvestEveryMs (the first harvestFirstMs after it arrives), when somebody it
   can see is within harvestRange: it pulls bones out of the ground (Summon,
   summonMs), then spins three times (SpinLow / SpinHigh, spinMs each), and every
   spin sends a ring of bones out along the ground, ringAtMs into it - low, high,
   low (`waves`). A ring grows at ringSpeed from ringStart to ringMax, and cuts
   everybody it reaches with a line to it (walls stop it) for ringDamage - unless:
     low   at shin height - jump it (feet above lowClear)
     high  just over a standing head - stay on the ground (feet under groundFeet: any
           jump at all puts the head in it, so hopping non-stop is no answer)
   There is no crouch in the game, so jumping is the whole answer (decided with
   the player). The ring is judged a moment after it reaches you - any sample of
   where your feet were between dodgeFromMs and dodgeToMs after it crossed you that
   was on the safe side counts - because what you saw arrived late and your jump
   reaches the server late too. Then it is exhausted (Exhausted, tiredMs): planted,
   not shooting - the window to hurt it. It never runs with a duel: whichever comes
   second waits gapMs after the other ends. A scatter calls it off; rings already
   out keep going. b.harvest = { e: summon / spin / tired, until, wave }, b.rings. */

/* ---- The skeleton's BONE SCATTER (step 30c) ----------------------------------
   Once only, the first time it is down to half its health: it collapses into a
   heap (collapseMs - it can still be shot), is gone for goneMs - no body, no hits,
   its bones flying through the air to where it will stand again - and comes back
   together (riseMs) behind one player picked at random, behindDist behind where
   they are looking. Then a two-handed blow (Melee - lands meleeHitMs in) of
   meleeDamage on everybody within meleeRange in front of it - and between the
   start of the swing and the blow it leaps at that player (lungeSpeed, stopping
   lungeStop short of them), so walking off is not enough; running is. The warning is the
   rattle of the bones, from where it is going to be: turn round and shoot it while
   it rises, or be somewhere else when it swings. A duel it was counting is called
   off, and it does not start another for afterScatterMs. b.scatter = { e, until,
   target } - e is collapse / gone / rise / strike, in the snapshot too. */

/* ---- Phase two (step 21) ---------------------------------------------------
   Below 30% health every boss changes. All of them fire a third faster, move a
   little quicker and are drawn enraged; each also gets one thing of its own, so
   the end of a fight is not just the start of it with less health left.

     skeleton  only the common part for now (draws a third faster) - step 30
     charge    charges back to back
     snipe     calls three bandits to her and backs off to 18 metres
     spray     every 3 seconds, a ring of 12 rounds in every direction
     dynamite  three sticks in a fan
     ghost     two GHOST DASHes back to back, and a SPECTRAL SHOT every 5 seconds (GHOST.p2)
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
    let fallback = nav.randomNavPoint(true);         // town only: out of the mine shaft there is no way back (H2)
    for (let attempt = 0; attempt < 60; attempt++) {
        const p = nav.randomNavPoint(true);
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
        abilityAt: now + (type.id === "skeleton" ? SKELETON.duelFirstMs : 2000),
        harvestAt: now + SKELETON.harvestFirstMs,       // step 30d - read by the skeleton only
        spectralAt: now + GHOST.spectralFirstMs,        // step 31b - read by the ghost only
        graveAt: now + GHOST.graveFirstMs,              // step 31c - read by the ghost only
        dashAt: now + GHOST.dashFirstMs,                // step 31d - read by the ghost only
        emberAt: now + DRAGON.emberFirstMs,             // step 33b - read by the dragon only
        tailAt: now + DRAGON.tailFirstMs,               // step 33c - read by the dragon only
        roarAt: Infinity,                               // step 33d - set when the dragon turns (phase two)
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
        if (c.tick > (c.every || BOSS.cloudTick)) {          // step 33b: an ember's pool bites at its own pace
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

/* HIGH NOON (step 30b): somebody it can see within duelRange, picked at random so
   standing back does not make the others safe. */
function duelTarget(room, players, b) {
    const seen = [];
    for (const id in players) {
        const p = players[id];
        if (p.room !== room.code || !p.alive) continue;
        if (Math.hypot(p.x - b.x, p.z - b.z) > SKELETON.duelRange) continue;
        if (!nav.losClear(b.x, b.z, p.x, p.z)) continue;
        seen.push(p);
    }
    return seen.length ? seen[Math.floor(Math.random() * seen.length)] : null;
}

/* BONE SCATTER (step 30c): who it comes back behind - anybody standing, at random,
   however far away, so hanging back is no answer. */
function scatterTarget(room, players) {
    const up = [];
    for (const id in players) {
        const p = players[id];
        if (p.room === room.code && p.alive) up.push(p);
    }
    return up.length ? up[Math.floor(Math.random() * up.length)] : null;
}

/* behindDist behind where they are looking (a player looks along -sin/-cos of
   their yaw), swung sideways and nearer or further until the body fits there and
   can walk straight to them - never through a wall into the next room. Only with
   their back to a wall and nothing at either side does it come round in front. */
function spotBehind(p, radius) {
    const yaw = typeof p.yaw === "number" ? p.yaw : 0;
    const back = Math.atan2(Math.sin(yaw), Math.cos(yaw));   // the direction behind them, as a heading
    const swings = [[0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.5, -1.5], [2.2, -2.2, Math.PI]];
    const dists = [SKELETON.behindDist, SKELETON.behindDist + 0.7, SKELETON.behindDist - 0.5];
    for (const group of swings) {
        for (const r of dists) {
            for (const s of group) {
                const a = back + s;
                const x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
                if (nav.collidesAt(x, z, radius) || !nav.lineClear(p.x, p.z, x, z)) continue;
                return { x, z };
            }
        }
    }
    return null;
}

function startScatter(b, now, sink) {
    b.scattered = true;                                          // once only
    b.duel = null;                                               // a count it was running is off
    b.staggerUntil = 0;
    b.harvest = null;                                            // and so is a harvest (its rings fly on)
    b.scatter = { e: "collapse", until: now + SKELETON.collapseMs, target: "" };
    sink.scatters.push({ e: "collapse", p: [round2(b.x), round2(b.z)], ms: SKELETON.collapseMs });
}

/* collapse -> gone -> rise -> strike -> back to the fight */
function tickScatter(room, b, players, now, dt, sink) {
    const s = b.scatter;
    if (s.e === "strike" && !s.struck) {
        // the leap: straight at them, never through a wall, never into them
        const t = s.target && players[s.target];
        if (t && t.room === room.code && t.alive) {
            const dx = t.x - b.x, dz = t.z - b.z, d = Math.hypot(dx, dz);
            const step = Math.min(SKELETON.lungeSpeed * dt, d - SKELETON.lungeStop);
            if (step > 0 && d > 0) moveAxis(b, (dx / d) * step, (dz / d) * step);
        }
    }
    if (s.e === "strike" && !s.struck && now >= s.hitAt) {
        s.struck = true;
        const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), hit = [];
        for (const id in players) {
            const p = players[id];
            if (p.room !== room.code || !p.alive) continue;
            const dx = p.x - b.x, dz = p.z - b.z, d = Math.hypot(dx, dz);
            // the swing is in front of it, not all round
            if (d > SKELETON.meleeRange || (d > 0.8 && (dx * fx + dz * fz) / d < 0.3)) continue;
            hit.push(p.id);
            sink.hits.push({ playerId: p.id, damage: SKELETON.meleeDamage, from: "boss" });
        }
        sink.scatters.push({ e: "blow", p: [round2(b.x), round2(b.z)], hit: hit });
    }
    if (now < s.until) return;
    if (s.e === "collapse") {
        // gone: its bones on their way to whoever it picked. Where exactly is
        // decided when they arrive - behind the way that player is looking then.
        const t = scatterTarget(room, players);
        s.e = "gone"; s.until = now + SKELETON.goneMs; s.target = t ? t.id : "";
        sink.scatters.push({ e: "gone", p: [round2(b.x), round2(b.z)], tgt: s.target, ms: SKELETON.goneMs });
    } else if (s.e === "gone") {
        const t = s.target && players[s.target];
        const spot = t && t.room === room.code && t.alive ? spotBehind(t, b.radius || BOSS.radius) : null;
        if (spot) {
            b.x = spot.x; b.z = spot.z;
            b.yaw = Math.atan2(t.x - b.x, t.z - b.z);
            b.path = null; b.repathAt = 0;
            b.lastX = b.x; b.lastZ = b.z;
        }
        // nobody to come back behind (they went down, or left): it rises where it fell
        s.e = "rise"; s.until = now + SKELETON.riseMs;
        sink.scatters.push({ e: "rise", p: [round2(b.x), round2(b.z)], y: round2(b.yaw), tgt: spot ? s.target : "", ms: SKELETON.riseMs });
    } else if (s.e === "rise") {
        s.e = "strike"; s.until = now + SKELETON.meleeMs; s.hitAt = now + SKELETON.meleeHitMs; s.struck = false;
        sink.scatters.push({ e: "strike", ms: SKELETON.meleeMs });
    } else {
        b.scatter = null;
        b.abilityAt = Math.max(b.abilityAt, now + SKELETON.afterScatterMs);
        b.lastShot = now + 400;                                  // a breath before the revolver
        sink.scatters.push({ e: "done" });
    }
}

/* BONE HARVEST (step 30d): somebody it can see within harvestRange */
function harvestInReach(room, players, b) {
    for (const id in players) {
        const p = players[id];
        if (p.room !== room.code || !p.alive) continue;
        if (Math.hypot(p.x - b.x, p.z - b.z) <= SKELETON.harvestRange && nav.losClear(b.x, b.z, p.x, p.z)) return true;
    }
    return false;
}

function startHarvest(b, now, sink) {
    b.harvest = { e: "summon", until: now + SKELETON.summonMs, wave: -1, ringAt: 0 };
    sink.harvests.push({ e: "summon", ms: SKELETON.summonMs });
}

/* summon -> spin, spin, spin (a ring each) -> tired -> back to the fight */
function tickHarvest(b, now, sink) {
    const h = b.harvest, W = SKELETON.waves;
    if (h.e === "spin" && h.ringAt && now >= h.ringAt) { h.ringAt = 0; launchRing(b, W[h.wave], now, sink); }
    if (now < h.until) return;
    if (h.e === "summon" || h.e === "spin") {
        h.wave++;
        if (h.wave < W.length) {
            h.e = "spin"; h.until = now + SKELETON.spinMs; h.ringAt = now + SKELETON.ringAtMs;
            sink.harvests.push({ e: "spin", i: h.wave, k: W[h.wave], ms: SKELETON.spinMs });
        } else {
            h.e = "tired"; h.until = now + SKELETON.tiredMs;
            sink.harvests.push({ e: "tired", ms: SKELETON.tiredMs });
        }
        return;
    }
    b.harvest = null;                                            // tired is over
    b.harvestAt = now + SKELETON.harvestEveryMs;
    b.abilityAt = Math.max(b.abilityAt, now + SKELETON.gapMs);
    b.lastShot = now + 400;
    sink.harvests.push({ e: "done" });
}

function launchRing(b, kind, now, sink) {
    if (!b.rings) b.rings = [];
    const id = (b.ringSeq = (b.ringSeq || 0) + 1);
    b.rings.push({ id: id, k: kind, x: b.x, z: b.z, t0: now, r: SKELETON.ringStart, crossed: {}, pending: [] });
    sink.harvests.push({ e: "ring", i: id, k: kind, p: [round2(b.x), round2(b.z)], v: SKELETON.ringSpeed, r0: SKELETON.ringStart, max: SKELETON.ringMax });
}

/* The rings: where they have got to, whom they reached this tick (with a line to
   them from where the ring started), and the verdicts that are due. Where every
   player's feet were is kept for the last second and a half while rings are out. */
function stepRings(room, b, players, now, sink) {
    if (!b.rings || !b.rings.length) { b.feet = null; return; }
    if (!b.feet) b.feet = {};
    for (const id in players) {
        const p = players[id];
        if (p.room !== room.code) continue;
        const hist = b.feet[id] || (b.feet[id] = []);
        hist.push([now, (typeof p.y === "number" ? p.y : 1.72) - 1.72]);
        while (hist.length && hist[0][0] < now - 1500) hist.shift();
    }
    for (let i = b.rings.length - 1; i >= 0; i--) {
        const g = b.rings[i];
        const r0 = g.r, r1 = Math.min(SKELETON.ringMax, SKELETON.ringStart + SKELETON.ringSpeed * (now - g.t0) / 1000);
        g.r = r1;
        for (const id in players) {
            const p = players[id];
            if (p.room !== room.code || !p.alive || g.crossed[id]) continue;
            const d = Math.hypot(p.x - g.x, p.z - g.z);
            if (d > r0 && d <= r1 && nav.losClear(g.x, g.z, p.x, p.z)) { g.crossed[id] = 1; g.pending.push({ id: id, T: now }); }
        }
        for (let j = g.pending.length - 1; j >= 0; j--) {
            const c = g.pending[j];
            if (now < c.T + SKELETON.dodgeToMs) continue;
            g.pending.splice(j, 1);
            const p = players[c.id];
            if (!p || p.room !== room.code || !p.alive) continue;
            const hist = (b.feet[c.id] || []).filter((s) => s[0] >= c.T + SKELETON.dodgeFromMs && s[0] <= c.T + SKELETON.dodgeToMs);
            if (!hist.length) hist.push([now, (typeof p.y === "number" ? p.y : 1.72) - 1.72]);
            const dodged = g.k === "low" ? hist.some((s) => s[1] > SKELETON.lowClear) : hist.some((s) => s[1] < SKELETON.groundFeet);
            if (!dodged) sink.hits.push({ playerId: p.id, damage: SKELETON.ringDamage, from: "boss" });
            sink.harvests.push({ e: "cut", i: g.id, k: g.k, p: p.id, hit: !dodged });
        }
        if (r1 >= SKELETON.ringMax && !g.pending.length) b.rings.splice(i, 1);
    }
}

/* mark -> count down -> one shot. b.duel = { target, until }; b.staggerUntil after
   a skull shot broke it (duelHeadshot). Both are in the snapshot for latecomers. */
function tickSkeleton(room, b, players, near, now, dt, sink) {
    stepRings(room, b, players, now, sink);                     // step 30d: rings out fly on, whatever it does next
    if (b.scatter) { tickScatter(room, b, players, now, dt, sink); return; }
    if (!b.scattered && b.health <= b.maxHealth * SKELETON.scatterAt) { startScatter(b, now, sink); return; }
    if (b.harvest) { tickHarvest(b, now, sink); return; }
    if (b.staggerUntil && now < b.staggerUntil) return;         // down on one knee
    if (b.duel) {
        const p = players[b.duel.target];
        if (!p || p.room !== room.code || !p.alive) {           // went down, died or left
            sink.duels.push({ e: "lost", p: b.duel.target });
            b.duel = null;
            b.abilityAt = now + 4000;
            b.harvestAt = Math.max(b.harvestAt || 0, now + SKELETON.gapMs);
            return;
        }
        if (now < b.duel.until) return;
        // the count is out: behind cover (no line) or too far away, it misses
        const hit = Math.hypot(p.x - b.x, p.z - b.z) <= SKELETON.missBeyond && nav.losClear(b.x, b.z, p.x, p.z);
        if (hit) sink.hits.push({ playerId: p.id, damage: SKELETON.duelDamage, from: "boss" });
        sink.duels.push({
            e: "shot", p: p.id, hit: hit,
            o: [round2(b.x), round2(BOSS.eyeHeight), round2(b.z)],
            at: [round2(p.x), round2(p.y || 1.72), round2(p.z)]
        });
        b.duel = null;
        b.abilityAt = now + SKELETON.duelEveryMs;
        b.harvestAt = Math.max(b.harvestAt || 0, now + SKELETON.gapMs);
        b.lastShot = now + 400;                                  // a breath before the revolver again
        return;
    }
    if (now >= b.harvestAt) {
        if (harvestInReach(room, players, b)) { startHarvest(b, now, sink); return; }
        b.harvestAt = now + 1000;                               // nobody near enough - look again in a second
    }
    if (now >= b.abilityAt) {
        const p = duelTarget(room, players, b);
        if (!p) { b.abilityAt = now + 1000; return; }           // nobody in sight - look again in a second
        b.duel = { target: p.id, until: now + SKELETON.countdownMs };
        sink.duels.push({ e: "mark", p: p.id, ms: SKELETON.countdownMs });
    }
}

/* A round through its skull while it counts (server.js, boss-hit with a head):
   the duel is broken - no shot - and it staggers. true if there was one to break. */
function duelHeadshot(room, now) {
    const b = room.boss;
    if (!b || !b.alive || !b.duel) return false;
    b.duel = null;
    b.staggerUntil = now + SKELETON.staggerMs;
    b.abilityAt = now + SKELETON.duelEveryMs;
    b.harvestAt = Math.max(b.harvestAt || 0, now + SKELETON.staggerMs + SKELETON.gapMs);
    b.lastShot = now + SKELETON.staggerMs;
    return true;
}

/* SPECTRAL SHOT (step 31b): the nearest player standing within spectralRange - a
   line to them is not needed, the round does not need one either. */
function spectralTarget(room, players, b) {
    const near = nearestPlayer(room, players, b.x, b.z);
    return near && near.dist <= GHOST.spectralRange ? near.player : null;
}

function startSpectral(b, p, now, sink) {
    const ms = GHOST.raiseMs + GHOST.flashMs;
    b.spectral = { e: "aim", target: p.id, lockAt: now + ms - GHOST.lockMs, fireAt: now + ms };
    sink.spectrals.push({ e: "aim", p: p.id, ms: ms, fl: GHOST.flashMs });
}

/* aim (it follows them) -> lock (it does not) -> the round -> lower -> back to the fight */
function tickSpectral(room, b, players, now, sink) {
    const s = b.spectral;
    if (s.e === "aim") {
        let p = players[s.target];
        if (!p || p.room !== room.code || !p.alive) {           // went down, died or left: the next nearest
            p = spectralTarget(room, players, b);
            if (!p) {                                            // nobody left to aim at - the gun comes down
                b.spectral = null;
                b.lastShot = now + 400;
                b.graveAt = Math.max(b.graveAt || 0, now + GHOST.gapMs);   // step 31c: never back to back
                b.dashAt = Math.max(b.dashAt || 0, now + GHOST.gapMs);     // step 31d: nor a GHOST DASH
                sink.spectrals.push({ e: "done", off: 1 });
                return;
            }
            s.target = p.id;
            const left = Math.max(0, s.fireAt - now);
            sink.spectrals.push({ e: "aim", p: p.id, ms: left, fl: Math.min(GHOST.flashMs, left) });
        }
        if (now < s.lockAt) return;
        s.e = "lock";
        s.at = [p.x, typeof p.y === "number" ? p.y : 1.72, p.z];   // where they are now - not where they will be
    }
    if (s.e === "lock") {
        if (now < s.fireAt) return;
        const ox = b.x, oy = BOSS.eyeHeight, oz = b.z;
        let dx = s.at[0] - ox, dy = s.at[1] - oy, dz = s.at[2] - oz;
        const n = Math.hypot(dx, dy, dz) || 1;
        dx /= n; dy /= n; dz /= n;
        room.bullets.push({
            x: ox, y: oy, z: oz, dx: dx, dy: dy, dz: dz, life: 0, from: -1,
            dmg: GHOST.spectralDamage, spd: GHOST.spectralSpeed,
            thru: 1, maxLife: GHOST.spectralReach / GHOST.spectralSpeed
        });
        sink.bossShots.push({ k: "spectral", o: [round2(ox), round2(oy), round2(oz)], d: [round3(dx), round3(dy), round3(dz)], r: GHOST.spectralReach });
        s.e = "lower"; s.until = now + GHOST.lowerMs;
        return;
    }
    if (now < s.until) return;
    b.spectral = null;
    b.lastShot = now + 400;                                      // a breath before the ordinary gun
    b.graveAt = Math.max(b.graveAt || 0, now + GHOST.gapMs);    // step 31c: never back to back
    b.dashAt = Math.max(b.dashAt || 0, now + GHOST.gapMs);      // step 31d: nor a GHOST DASH
    sink.spectrals.push({ e: "done" });
}

/* GRAVE BURST (step 31c): a living player at random within graveRange - a line to
   them is not needed, it comes up out of the ground. */
function graveTarget(room, players, b) {
    const near = [];
    for (const id in players) {
        const p = players[id];
        if (p.room !== room.code || !p.alive) continue;
        if (Math.hypot(p.x - b.x, p.z - b.z) <= GHOST.graveRange) near.push(p);
    }
    return near.length ? near[Math.floor(Math.random() * near.length)] : null;
}

function startGrave(b, p, now, sink) {
    const id = (b.graveSeq = (b.graveSeq || 0) + 1);
    b.grave = { e: "raise", target: p.id, until: now + GHOST.graveRaiseMs, i: id };
    sink.graves.push({ e: "raise", i: id, p: p.id, ms: GHOST.graveRaiseMs });
}

/* Where every player in the room was, and how high their feet were, for the last
   second and a half - kept only while a circle is open or waiting for its verdict. */
function recordGraveFeet(room, b, players, now) {
    if (!b.graveFeet) b.graveFeet = {};
    for (const id in players) {
        const p = players[id];
        if (p.room !== room.code) continue;
        const hist = b.graveFeet[id] || (b.graveFeet[id] = []);
        hist.push([now, (typeof p.y === "number" ? p.y : 1.72) - 1.72, p.x, p.z]);
        while (hist.length && hist[0][0] < now - 1500) hist.shift();
    }
}

/* raise (the hand comes up) -> fill (the circle is open where they stood) -> burst
   (the hands; the verdict dodgeToMs later) -> back to the fight */
function tickGrave(room, b, players, now, sink) {
    const g = b.grave;
    if (g.e === "raise") {
        let p = players[g.target];
        if (!p || p.room !== room.code || !p.alive) {           // went down, died or left: somebody else
            p = graveTarget(room, players, b);
            if (!p) { endGrave(b, now, sink, true); return; }   // nobody left - the hand comes down
            g.target = p.id;
        }
        if (now < g.until) return;
        g.e = "fill";
        g.x = p.x; g.z = p.z;                                    // where they are now - and it stays there
        g.until = now + GHOST.graveFillMs;
        b.graveFeet = null;
        recordGraveFeet(room, b, players, now);
        sink.graves.push({ e: "cast", i: g.i, p: [round2(g.x), round2(g.z)], r: GHOST.graveRadius, ms: GHOST.graveFillMs });
        return;
    }
    recordGraveFeet(room, b, players, now);
    if (g.e === "fill") {
        if (now < g.until) return;
        g.e = "burst";
        g.T = now;
        g.until = now + Math.max(GHOST.graveLowerMs, SKELETON.dodgeToMs);
        g.inside = [];
        for (const id in players) {
            const p = players[id];
            if (p.room !== room.code || !p.alive) continue;
            if (Math.hypot(p.x - g.x, p.z - g.z) <= GHOST.graveRadius) g.inside.push(id);
        }
        sink.graves.push({ e: "burst", i: g.i, p: [round2(g.x), round2(g.z)] });
        return;
    }
    // burst: the verdict, a moment after - what the player saw arrived late, and so does their answer
    if (!g.judged && now >= g.T + SKELETON.dodgeToMs) {
        g.judged = true;
        const hit = [], safe = [];
        for (const id of g.inside) {
            const p = players[id];
            if (!p || p.room !== room.code || !p.alive) continue;
            const hist = (b.graveFeet[id] || []).filter((s) => s[0] >= g.T + SKELETON.dodgeFromMs && s[0] <= g.T + SKELETON.dodgeToMs);
            if (!hist.length) hist.push([now, (typeof p.y === "number" ? p.y : 1.72) - 1.72, p.x, p.z]);
            const dodged = hist.some((s) => s[1] > SKELETON.lowClear || Math.hypot(s[2] - g.x, s[3] - g.z) > GHOST.graveRadius);
            if (dodged) safe.push(id);
            else { hit.push(id); sink.hits.push({ playerId: id, damage: GHOST.graveDamage, from: "boss" }); }
        }
        sink.graves.push({ e: "judge", i: g.i, hit: hit, safe: safe });
    }
    if (now >= g.until && g.judged) endGrave(b, now, sink, false);
}

function endGrave(b, now, sink, off) {
    b.grave = null;
    b.graveFeet = null;
    b.lastShot = now + 400;                                      // a breath before the ordinary gun
    b.spectralAt = Math.max(b.spectralAt || 0, now + GHOST.gapMs);   // never back to back
    b.dashAt = Math.max(b.dashAt || 0, now + GHOST.gapMs);           // step 31d: nor a GHOST DASH
    sink.graves.push(off ? { e: "done", off: 1 } : { e: "done" });
}

/* ---- GHOST DASH (step 31d) -------------------------------------------------- */
/* Who it comes for: a living player at random within dashRange. No line to them is
   needed - it is not walking there. */
function dashTarget(room, players, b) {
    const near = [];
    for (const id in players) {
        const p = players[id];
        if (p.room !== room.code || !p.alive) continue;
        if (Math.hypot(p.x - b.x, p.z - b.z) <= GHOST.dashRange) near.push(p);
    }
    return near.length ? near[Math.floor(Math.random() * near.length)] : null;
}

/* Where it comes out: appearDist from them at a random angle - swung round, and
   nearer or further, until the body fits there and has a straight line to them. So
   it never turns up inside a wall, and never on the far side of one. */
function spotNear(p, radius) {
    const start = Math.random() * Math.PI * 2;
    const dists = [GHOST.appearDist, GHOST.appearDist - 1.5, GHOST.appearDist + 1.5];
    for (let k = 0; k < 24; k++) {
        const a = start + k * (Math.PI * 2 / 24);
        for (const r of dists) {
            const x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
            if (nav.collidesAt(x, z, radius) || !nav.lineClear(p.x, p.z, x, z)) continue;
            return { x: x, z: z };
        }
    }
    return null;
}

function startDash(b, p, now, sink) {
    b.dash = {
        e: "mist", until: now + GHOST.mistMs, target: p.id,
        left: (b.phase === 2 ? GHOST.p2.dashes : 1) - 1,
        fx: b.x, fz: b.z, marked: false, again: false, hit: [], gone: 0
    };
    sink.dashes.push({ e: "mist", p: [round2(b.x), round2(b.z)], tgt: p.id, ms: GHOST.mistMs });
}

/* How far a point is from the line it just travelled. A charge at 16 m/s covers
   0.8 m a tick, and a body that jumps that far at once steps clean over somebody
   standing in the way - the lesson of the fast round (HANDOFF section 6). */
function distToSegment(px, pz, ax, az, bx, bz) {
    const vx = bx - ax, vz = bz - az;
    const len = vx * vx + vz * vz;
    let t = len > 0 ? ((px - ax) * vx + (pz - az) * vz) / len : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

/* The charge itself, in small steps so that corners stop it and nobody is stepped
   over. Everybody within dashWidth of the line it takes is caught - once each,
   however many times the line comes back past them. */
function stepDash(room, b, players, now, dt, sink) {
    const s = b.dash;
    const step = GHOST.dashSpeed * dt;
    const parts = Math.max(1, Math.ceil(step / 0.25));
    const hit = [];
    for (let i = 0; i < parts && s.gone < GHOST.dashReach && !s.stopped; i++) {
        const want = Math.min(step / parts, GHOST.dashReach - s.gone);
        const ax = b.x, az = b.z;
        moveAxis(b, s.dx * want, s.dz * want);
        const went = Math.hypot(b.x - ax, b.z - az);
        s.gone += went;
        for (const id in players) {
            const p = players[id];
            if (p.room !== room.code || !p.alive || s.hit.indexOf(id) >= 0) continue;
            if (distToSegment(p.x, p.z, ax, az, b.x, b.z) > GHOST.dashWidth) continue;
            s.hit.push(id);
            hit.push(id);
            sink.hits.push({ playerId: id, damage: GHOST.dashDamage, from: "boss" });
        }
        if (went < want - 0.0001) s.stopped = true;              // a wall
    }
    if (hit.length) sink.dashes.push({ e: "hit", ids: hit, p: [round2(b.x), round2(b.z)] });
    if (s.gone >= GHOST.dashReach) s.stopped = true;
}

/* The charge is over: in phase two a short mist and another one, otherwise the
   recovery - planted and silent, the window to hurt it. */
function afterDash(room, b, players, now, sink) {
    const s = b.dash;
    if (s.left > 0) {
        const t = dashTarget(room, players, b);
        if (t) {
            s.left--;
            s.again = true;
            s.target = t.id;
            s.e = "mist"; s.until = now + GHOST.p2.dashMistMs;
            s.fx = b.x; s.fz = b.z; s.marked = false; s.mx = undefined; s.mz = undefined;
            sink.dashes.push({ e: "mist", p: [round2(b.x), round2(b.z)], tgt: t.id, ms: GHOST.p2.dashMistMs, again: 1 });
            return;
        }
    }
    s.e = "recover"; s.until = now + GHOST.recoverMs;
    sink.dashes.push({ e: "recover", p: [round2(b.x), round2(b.z)], ms: GHOST.recoverMs });
}

function endDash(b, now, sink, off) {
    b.dash = null;
    b.spectralAt = Math.max(b.spectralAt || 0, now + GHOST.gapMs);   // never back to back
    b.graveAt = Math.max(b.graveAt || 0, now + GHOST.gapMs);
    b.lastShot = now + 300;                                          // a breath before the gun
    sink.dashes.push(off ? { e: "done", off: 1 } : { e: "done" });
}

/* mist -> gone (and the mark) -> appear (the aim locks at the end of it) -> dash
   -> another one in phase two -> recover */
function tickDash(room, b, players, now, dt, sink) {
    const s = b.dash;

    if (s.e === "dash") {
        stepDash(room, b, players, now, dt, sink);
        if (!s.stopped && now < s.until) return;
        afterDash(room, b, players, now, sink);
        return;
    }

    /* The whirl of mist on the ground where it is going to come out, markLeadMs
       before it does - by where its target is standing at that moment. They keep
       moving until it opens, which is why the aim only locks after it is out. */
    if (s.e === "gone" && !s.marked && now >= s.until - s.markAt) {
        s.marked = true;
        const t = players[s.target];
        const spot = t && t.room === room.code && t.alive ? spotNear(t, b.radius || BOSS.radius) : null;
        if (spot) { s.mx = spot.x; s.mz = spot.z; }
        sink.dashes.push({
            e: "mark", p: [round2(spot ? spot.x : s.fx), round2(spot ? spot.z : s.fz)],
            tgt: spot ? s.target : "", ms: Math.max(0, Math.round(s.until - now))
        });
    }
    if (now < s.until) return;

    if (s.e === "mist") {
        const ms = s.again ? GHOST.p2.dashGoneMs : GHOST.dashGoneMs;
        s.e = "gone"; s.until = now + ms; s.markAt = Math.min(GHOST.markLeadMs, ms);
        s.fx = b.x; s.fz = b.z; s.marked = false; s.mx = undefined; s.mz = undefined;
        sink.dashes.push({ e: "gone", p: [round2(b.x), round2(b.z)], tgt: s.target, ms: ms });
    } else if (s.e === "gone") {
        // nowhere to come out beside them (they went down, or left): it comes out
        // where it went in, and there is no charge
        if (s.mx !== undefined) {
            b.x = s.mx; b.z = s.mz;
            b.path = null; b.repathAt = 0;
            b.lastX = b.x; b.lastZ = b.z;
        }
        const t = players[s.target];
        if (s.mx !== undefined && t && t.room === room.code && t.alive) b.yaw = Math.atan2(t.x - b.x, t.z - b.z);
        s.e = "appear"; s.until = now + GHOST.appearMs;
        sink.dashes.push({
            e: "appear", p: [round2(b.x), round2(b.z)], y: round2(b.yaw),
            tgt: s.mx !== undefined ? s.target : "", ms: GHOST.appearMs
        });
    } else if (s.e === "appear") {
        const t = players[s.target];
        if (s.mx === undefined || !t || t.room !== room.code || !t.alive) { endDash(b, now, sink, true); return; }
        const dx = t.x - b.x, dz = t.z - b.z, d = Math.hypot(dx, dz) || 1;
        s.dx = dx / d; s.dz = dz / d;
        s.ox = b.x; s.oz = b.z;
        s.gone = 0; s.stopped = false; s.hit = [];
        s.e = "dash"; s.until = now + GHOST.dashMaxMs;
        b.yaw = Math.atan2(s.dx, s.dz);
        sink.dashes.push({ e: "dash", o: [round2(b.x), round2(b.z)], d: [round3(s.dx), round3(s.dz)], ms: GHOST.dashMaxMs });
    } else if (s.e === "recover") {
        endDash(b, now, sink, false);
    }
}

/* EMBER RAIN (step 33b): everybody living within emberRange - a line is not needed. */
function emberTargets(room, players, b) {
    const out = [];
    for (const id in players) {
        const p = players[id];
        if (p.room !== room.code || !p.alive) continue;
        if (Math.hypot(p.x - b.x, p.z - b.z) <= DRAGON.emberRange) out.push(p);
    }
    return out;
}

/* How high it is flying at `now` - 0 on the ground. The clients draw the same curve. */
function liftOf(b, now) {
    const s = b && b.ember;
    if (!s) return 0;
    const t = now === undefined ? Date.now() : now;
    if (s.e === "takeoff") {
        const k = Math.min(1, Math.max(0, 1 - (s.until - t) / DRAGON.takeoffMs));
        return DRAGON.liftTo * k * (2 - k);
    }
    if (s.e === "land") {
        const k = Math.min(1, Math.max(0, 1 - (s.until - t) / DRAGON.landMs));
        return DRAGON.liftTo * (1 - k * k);
    }
    return DRAGON.liftTo;
}

/* A spot an ember can land on: open ground within `r` of (x, z), `min` out at least. */
function emberSpot(x, z, min, r) {
    for (let k = 0; k < 10; k++) {
        const a = Math.random() * Math.PI * 2, d = min + Math.random() * (r - min);
        const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
        if (Math.abs(px) < 98 && Math.abs(pz) < 98 && !nav.collidesAt(px, pz, 0.4)) return { x: px, z: pz };
    }
    return null;
}

function startEmber(b, now, sink) {
    b.ember = { e: "takeoff", until: now + DRAGON.takeoffMs, drops: null, feet: null };
    b.chargeUntil = 0;                                       // no swoop through it
    sink.embers.push({ e: "takeoff", ms: DRAGON.takeoffMs, h: DRAGON.liftTo });
}

/* The mouthful leaves: every landing spot, picked now, and when it lands. */
function throwEmbers(room, b, players, now, sink) {
    const s = b.ember;
    const who = emberTargets(room, players, b);
    const n = Math.min(DRAGON.emberMax, DRAGON.emberCount + DRAGON.emberPerPlayer * Math.max(0, who.length - 1));
    const nNear = who.length ? Math.round(n * DRAGON.emberNear) : 0;
    const spots = [];
    for (let i = 0; i < who.length && spots.length < nNear; i++) spots.push({ x: who[i].x, z: who[i].z });
    for (let k = 0; spots.length < nNear && k < nNear * 4; k++) {
        const p = who[Math.floor(Math.random() * who.length)];
        const q = emberSpot(p.x, p.z, 1.5, DRAGON.aroundR);
        if (q) spots.push(q);
    }
    for (let k = 0; spots.length < n && k < n * 4; k++) {
        const q = emberSpot(b.x, b.z, 3, DRAGON.randomR);
        if (q) spots.push(q);
    }
    s.drops = spots.map((q) => ({ x: q.x, z: q.z, T: now + DRAGON.warnMs + Math.random() * DRAGON.spreadMs, landed: false, judged: false }));
    s.feet = {};
    recordEmberFeet(room, s, players, now);
    sink.embers.push({
        e: "rain", r: DRAGON.emberRadius,
        d: s.drops.map((q) => [round2(q.x), round2(q.z), Math.round(q.T - now)])
    });
}

/* Where every player in the room was for the last second and a half - kept only
   while embers are on their way down. */
function recordEmberFeet(room, s, players, now) {
    for (const id in players) {
        const p = players[id];
        if (p.room !== room.code) continue;
        const hist = s.feet[id] || (s.feet[id] = []);
        hist.push([now, p.x, p.z]);
        while (hist.length && hist[0][0] < now - 1500) hist.shift();
    }
}

/* Down on the ground: the pool now, the verdict dodgeToMs later. */
function landEmbers(room, b, players, now, sink) {
    const s = b.ember;
    for (let i = 0; i < s.drops.length; i++) {
        const q = s.drops[i];
        if (!q.landed && now >= q.T) {
            q.landed = true;
            sink.booms.push({ i: room.nextHazardId++, k: "fire", p: [round2(q.x), 0.12, round2(q.z)], l: DRAGON.emberPoolLife, r: DRAGON.emberPoolRadius, e: 1 });
            room.clouds.push({ x: q.x, z: q.z, life: DRAGON.emberPoolLife, tick: 0, every: DRAGON.emberPoolTick, r: DRAGON.emberPoolRadius, dmg: DRAGON.emberPoolDamage });
        }
        if (q.landed && !q.judged && now >= q.T + SKELETON.dodgeToMs) {
            q.judged = true;
            const hit = [];
            for (const id in players) {
                const p = players[id];
                if (p.room !== room.code || !p.alive) continue;
                const hist = (s.feet[id] || []).filter((f) => f[0] >= q.T + SKELETON.dodgeFromMs && f[0] <= q.T + SKELETON.dodgeToMs);
                if (!hist.length) hist.push([now, p.x, p.z]);
                const dodged = hist.some((f) => Math.hypot(f[1] - q.x, f[2] - q.z) > DRAGON.emberRadius);
                if (dodged) continue;
                hit.push(id);
                sink.hits.push({ playerId: id, damage: DRAGON.emberDamage, from: "boss" });
            }
            if (hit.length) sink.embers.push({ e: "hit", p: [round2(q.x), round2(q.z)], hit: hit });
        }
    }
}

/* takeoff -> spit (the embers leave at spitAtMs) -> hover (until the last one is
   judged) -> land -> back to the fight */
function tickEmber(room, b, players, now, sink) {
    const s = b.ember;
    if (s.feet) recordEmberFeet(room, s, players, now);
    if (s.drops) landEmbers(room, b, players, now, sink);

    if (s.e === "spit" && !s.drops && now >= s.spitAt) throwEmbers(room, b, players, now, sink);
    if (now < s.until) return;

    if (s.e === "takeoff") {
        s.e = "spit"; s.until = now + DRAGON.spitMs; s.spitAt = now + DRAGON.spitAtMs;
        sink.embers.push({ e: "spit", ms: DRAGON.spitMs, lead: DRAGON.spitAtMs });
    } else if (s.e === "spit") {
        if (!s.drops) throwEmbers(room, b, players, now, sink);
        let last = now;
        for (let i = 0; i < s.drops.length; i++) last = Math.max(last, s.drops[i].T + SKELETON.dodgeToMs);
        s.e = "hover"; s.until = last + DRAGON.hoverAfterMs;
        sink.embers.push({ e: "hover", ms: Math.round(s.until - now) });
    } else if (s.e === "hover") {
        s.e = "land"; s.until = now + DRAGON.landMs;
        sink.embers.push({ e: "land", ms: DRAGON.landMs });
    } else if (s.e === "land") {
        endEmber(b, now, sink);
    }
}

function endEmber(b, now, sink) {
    b.ember = null;
    b.abilityAt = Math.max(b.abilityAt || 0, now + DRAGON.emberGapMs);   // no swoop straight after
    b.tailAt = Math.max(b.tailAt || 0, now + DRAGON.tailGapMs);          // step 33c: nor a tail
    b.roarAt = Math.max(b.roarAt || 0, now + DRAGON.roarGapMs);          // step 33d: nor a roar
    b.lastShot = now + 300;                                             // a breath before the breath
    sink.embers.push({ e: "done" });
}

/* TAIL SWEEP (step 33c): the nearest living player, if they are within tailTrigger. */
function tailDue(room, players, b) {
    const n = nearestPlayer(room, players, b.x, b.z);
    return n && n.dist <= DRAGON.tailTrigger ? n : null;
}

function startTail(b, now, sink) {
    const dir = Math.random() < 0.5 ? 1 : -1;
    b.tail = { e: "charge", until: now + DRAGON.tailChargeMs, yaw: b.yaw, dir: dir, T0: 0, judged: {}, feet: {} };
    b.chargeUntil = 0;
    sink.tails.push({ e: "charge", ms: DRAGON.tailChargeMs, y: round2(b.yaw), dir: dir, r: DRAGON.tailRange });
}

/* Where the tail is pointing `ms` into the sweep: it starts straight behind (yaw + PI)
   and goes once round, `dir` one way or the other. When does it cross bearing `a`? */
function tailCrossMs(t, a) {
    const TWO = Math.PI * 2;
    let d = (a - (t.yaw + Math.PI)) * t.dir;
    d = ((d % TWO) + TWO) % TWO;
    return (d / TWO) * DRAGON.tailSweepMs;
}

function recordTailFeet(room, t, players, now) {
    for (const id in players) {
        const p = players[id];
        if (p.room !== room.code) continue;
        const hist = t.feet[id] || (t.feet[id] = []);
        hist.push([now, (typeof p.y === "number" ? p.y : 1.72) - 1.72, p.x, p.z]);
        while (hist.length && hist[0][0] < now - 1500) hist.shift();
    }
}

/* Everybody the tail has gone past and not been judged yet, dodgeToMs after it did.
   Where they were when it crossed decides the moment; the samples after it decide. */
function judgeTail(room, b, players, now, sink) {
    const t = b.tail;
    const hit = [];
    for (const id in players) {
        const p = players[id];
        if (p.room !== room.code || !p.alive || t.judged[id]) continue;
        const hist = t.feet[id] || [];
        // where they were at the start of the sweep decides when it reaches them
        const at = hist.find((f) => f[0] >= t.T0) || [now, 0, p.x, p.z];
        const cross = t.T0 + tailCrossMs(t, Math.atan2(at[2] - b.x, at[3] - b.z));
        if (now < cross + SKELETON.dodgeToMs) continue;
        t.judged[id] = true;
        const win = hist.filter((f) => f[0] >= cross + SKELETON.dodgeFromMs && f[0] <= cross + SKELETON.dodgeToMs);
        if (!win.length) win.push([now, (typeof p.y === "number" ? p.y : 1.72) - 1.72, p.x, p.z]);
        const dodged = win.some((f) => f[1] > SKELETON.lowClear || Math.hypot(f[2] - b.x, f[3] - b.z) > DRAGON.tailRange);
        if (dodged) continue;
        hit.push(id);
        sink.hits.push({ playerId: id, damage: DRAGON.tailDamage, from: "boss" });
    }
    if (hit.length) sink.tails.push({ e: "hit", hit: hit, p: [round2(b.x), round2(b.z)], k: DRAGON.tailKnock });
}

/* charge -> sweep (judged as it goes, and dodgeToMs after it) -> recover -> back to the fight */
function tickTail(room, b, players, now, sink) {
    const t = b.tail;
    recordTailFeet(room, t, players, now);
    if (t.T0) judgeTail(room, b, players, now, sink);
    if (now < t.until) return;
    if (t.e === "charge") {
        t.e = "sweep"; t.T0 = now; t.until = now + DRAGON.tailSweepMs;
        sink.tails.push({ e: "sweep", ms: DRAGON.tailSweepMs });
    } else if (t.e === "sweep") {
        t.e = "recover"; t.until = now + Math.max(DRAGON.tailRecoverMs, SKELETON.dodgeToMs);
        sink.tails.push({ e: "recover", ms: DRAGON.tailRecoverMs });
    } else if (t.e === "recover") {
        judgeTail(room, b, players, now + SKELETON.dodgeToMs, sink);   // anybody still waiting for a verdict
        b.tail = null;
        b.abilityAt = Math.max(b.abilityAt || 0, now + DRAGON.tailGapMs);
        b.emberAt = Math.max(b.emberAt || 0, now + DRAGON.tailGapMs);
        b.roarAt = Math.max(b.roarAt || 0, now + DRAGON.roarGapMs);    // step 33d
        b.tailAt = now + (b.phase === 2 ? DRAGON.p2.tailEveryMs : DRAGON.tailEveryMs);
        b.lastShot = now + 300;
        sink.tails.push({ e: "done" });
    }
}

/* The ROAR (step 33d): is anybody living within roarRange? */
function roarDue(room, players, b) {
    for (const id in players) {
        const p = players[id];
        if (p.room === room.code && p.alive && Math.hypot(p.x - b.x, p.z - b.z) <= DRAGON.roarRange) return true;
    }
    return false;
}

function startRoar(b, now, sink) {
    b.roar = { e: "swell", until: now + DRAGON.roarSwellMs };
    b.chargeUntil = 0;
    sink.roarAttacks.push({ e: "swell", ms: DRAGON.roarSwellMs, r: DRAGON.roarRange });
}

/* swell -> the shout: who it reaches (in range, nothing between) -> lay -> done */
function tickRoar(room, b, players, now, sink) {
    const s = b.roar;
    // step 33d2: the eggs leave it partway into the crouch
    if (s.e === "lay" && s.eggsAt && now >= s.eggsAt) {
        s.eggsAt = 0;
        const eggs = bandits.layEggs(room, players, b.x, b.z, b.yaw, s.n, now);
        if (eggs.length) sink.roarAttacks.push({ e: "eggs", eg: eggs, hatch: bandits.BROOD.hatchMs });
    }
    if (now < s.until) return;
    if (s.e === "swell") {
        const dazed = [], covered = [];
        for (const id in players) {
            const p = players[id];
            if (p.room !== room.code || !p.alive) continue;
            if (Math.hypot(p.x - b.x, p.z - b.z) > DRAGON.roarRange) continue;
            (nav.losClear(b.x, b.z, p.x, p.z) ? dazed : covered).push(id);
        }
        s.e = "roar"; s.until = now + DRAGON.roarAfterMs;
        sink.roarAttacks.push({ e: "roar", ms: DRAGON.roarAfterMs, hit: dazed, safe: covered, daze: DRAGON.roarDazeMs });
    } else if (s.e === "roar" && (s.n = bandits.eggsFor(room, players)) > 0) {
        s.e = "lay"; s.until = now + DRAGON.layMs; s.eggsAt = now + DRAGON.eggsAtMs;     // step 33d2
        sink.roarAttacks.push({ e: "lay", ms: DRAGON.layMs });
    } else {
        b.roar = null;
        b.abilityAt = Math.max(b.abilityAt || 0, now + DRAGON.roarGapMs);
        b.emberAt = Math.max(b.emberAt || 0, now + DRAGON.roarGapMs);
        b.tailAt = Math.max(b.tailAt || 0, now + DRAGON.roarGapMs);
        b.roarAt = now + DRAGON.roarEveryMs;
        b.lastShot = now + 300;
        sink.roarAttacks.push({ e: "done" });
    }
}

/* ---- Abilities ---------------------------------------------------------- */
function tickAbility(room, b, players, near, now, dt, sink) {
    const id = b.type.id;

    if (id === "robot") { tickRobot(room, b, players, near, now, dt, sink); return; }
    if (id === "skeleton") { tickSkeleton(room, b, players, near, now, dt, sink); return; }

    /* The dragon's swoop (step 28): the charge, with its own numbers. It rides
       on chargeUntil so the walking stands aside and the clients see the flag. */
    if (id === "dragon") {
        /* step 33b: EMBER RAIN owns it from takeoff to landing, and starts only
           between swoops - never in the middle of one */
        if (b.ember) { tickEmber(room, b, players, now, sink); return; }
        if (b.tail) { tickTail(room, b, players, now, sink); return; }          // step 33c
        if (b.roar) { tickRoar(room, b, players, now, sink); return; }          // step 33d
        // step 33d: the ROAR, phase two only (roarAt is Infinity until it turns)
        if (!(b.chargeUntil && now < b.chargeUntil) && now >= b.roarAt) {
            if (roarDue(room, players, b)) { startRoar(b, now, sink); return; }
            b.roarAt = now + 1000;                              // nobody near enough - look again in a second
        }
        // step 33c: TAIL SWEEP for whoever comes too close - asked before the rain, which runs on a clock
        if (!(b.chargeUntil && now < b.chargeUntil) && now >= b.tailAt && tailDue(room, players, b)) {
            startTail(b, now, sink);
            return;
        }
        if (!(b.chargeUntil && now < b.chargeUntil) && now >= b.emberAt) {
            if (emberTargets(room, players, b).length) {
                b.emberAt = now + (b.phase === 2 ? DRAGON.p2.emberEveryMs : DRAGON.emberEveryMs);
                startEmber(b, now, sink);
                return;
            }
            b.emberAt = now + 1000;                             // nobody near enough - look again in a second
        }
        if (b.hasLos && near && near.dist < DRAGON.swoopTrigger && now >= b.abilityAt) {
            b.abilityAt = now + (b.phase === 2 ? DRAGON.p2.swoopEveryMs : DRAGON.swoopEveryMs);
            b.chargeUntil = now + DRAGON.swoopForMs;
            b.tailAt = Math.max(b.tailAt || 0, now + DRAGON.swoopForMs + DRAGON.tailGapMs);   // step 33c: not the tail straight after
            b.roarAt = Math.max(b.roarAt || 0, now + DRAGON.swoopForMs + DRAGON.roarGapMs);   // step 33d: nor the roar

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
        /* Three clocks, and never two of them running at once: whichever is due
           first starts, and the others wait gapMs after it is over. The GHOST DASH
           (step 31d) is asked first - it is the one that took VANISH's place. */
        if (b.dash) { tickDash(room, b, players, now, dt, sink); return; }
        if (b.spectral) { tickSpectral(room, b, players, now, sink); return; }
        if (b.grave) { tickGrave(room, b, players, now, sink); return; }       // step 31c: and while the hand is up
        if (now >= b.dashAt) {
            const p = dashTarget(room, players, b);
            if (p) {
                b.dashAt = now + GHOST.dashEveryMs;
                startDash(b, p, now, sink);
                return;
            }
            b.dashAt = now + 1000;                              // nobody near enough - look again in a second
        }
        if (now >= b.spectralAt) {
            const p = spectralTarget(room, players, b);
            if (p) {
                b.spectralAt = now + (b.phase === 2 ? GHOST.p2.spectralEveryMs : GHOST.spectralEveryMs);
                startSpectral(b, p, now, sink);
                return;
            }
            b.spectralAt = now + 1000;                          // nobody near enough - look again in a second
        }
        if (now >= b.graveAt) {
            const p = graveTarget(room, players, b);
            if (p) {
                b.graveAt = now + GHOST.graveEveryMs;
                startGrave(b, p, now, sink);
                return;
            }
            b.graveAt = now + 1000;                             // nobody near enough - look again in a second
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
        b.roarAt = now + DRAGON.roarFirstMs;               // step 33d: and from now on it roars
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
    }
    /* A boss always comes for whoever is nearest (code review 2026-09-25, H2). It used
       to give up past 60 m and patrol random points until it happened to see somebody
       again - and while it lives no wave turns over, so a boss that never found a
       player standing still stalled the room. It patrols only with nobody standing. */
    b.state = near ? "chase" : "patrol";

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
            b.patrolTarget = nav.randomNavPoint(true);
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
    // the robot plants its feet while the barrels spin and fire (step 27), and the
    // skeleton while it counts a duel down or is down on one knee (step 30b), and
    // all through BONE SCATTER (step 30c) - no walking (only its leap, tickScatter) and no revolver -
    // and all through BONE HARVEST (step 30d); the ghost from the moment it raises
    // its gun for a SPECTRAL SHOT until it is down again (step 31b), and its hand for a GRAVE BURST (step 31c),
    // and all through a GHOST DASH (step 31d) - the charge itself is tickDash's, not the walking's;
    // the dragon from takeoff to landing in an EMBER RAIN (step 33b), and all through a TAIL SWEEP (step 33c)
    const dueling = !!b.duel || (b.staggerUntil && now < b.staggerUntil) || !!b.scatter || !!b.harvest || !!b.spectral || !!b.grave || !!b.dash || !!b.ember || !!b.tail || !!b.roar;
    const planted = b.gState === "spin" || b.gState === "fire" || dueling;
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
    if (b.type.id !== "robot" && !dueling && b.hasLos && near && near.dist < range && now - b.lastShot > fireDelay) {
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
    const marked = b.duel && players[b.duel.target];
    const behind = b.scatter && (b.scatter.e === "rise" || b.scatter.e === "strike") && players[b.scatter.target];
    if (marked) { faceX = marked.x; faceZ = marked.z; }                  // eyes on whoever it marked
    else if (behind) { faceX = behind.x; faceZ = behind.z; }             // and on whoever it came back behind
    else if (b.scatter) { /* a heap of bones, or nothing at all: it does not turn */ }
    else if (b.harvest) { /* spinning on the spot (the clip turns it), or bent double: it does not turn */ }
    else if (b.staggerUntil && now < b.staggerUntil) { /* on its knee: it does not turn */ }
    else if (b.spectral) {
        // step 31b: it follows whoever the round is for until the aim locks, and not after
        const aimed = b.spectral.e === "aim" && players[b.spectral.target];
        if (aimed) { faceX = aimed.x; faceZ = aimed.z; }
    }
    else if (b.grave) {
        // step 31c: at whoever it is for while the hand comes up, then at the circle
        const who = b.grave.e === "raise" && players[b.grave.target];
        if (who) { faceX = who.x; faceZ = who.z; }
        else if (b.grave.x !== undefined) { faceX = b.grave.x; faceZ = b.grave.z; }
    }
    else if (b.tail) { /* step 33c: crouched, then spinning (the clients turn it): the yaw stays put */ }
    else if (b.dash) {
        /* step 31d: it turns on its target only while it is coming out. Once the
           charge starts the yaw is the locked direction and nothing moves it, and
           as mist, gone or bent double after it, it does not turn at all. */
        const who = b.dash.e === "appear" && players[b.dash.target];
        if (who) { faceX = who.x; faceZ = who.z; }
    }
    else if (b.state === "chase" && near) { faceX = near.player.x; faceZ = near.player.z; }
    else if (b.path && b.path[b.pathIndex]) { faceX = b.path[b.pathIndex].x; faceZ = b.path[b.pathIndex].z; }
    if (faceX !== undefined) {
        const want = Math.atan2(faceX - b.x, faceZ - b.z);
        let d = want - b.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        if (planted && b.gState) {
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
        // step 31d: nothing fills `blinks` any more - GHOST DASH took VANISH's place
        booms: [], slams: [], blinks: [], roars: [], duels: [],     // duels: step 30b
        scatters: [],                                               // step 30c: BONE SCATTER
        harvests: [],                                               // step 30d: BONE HARVEST
        spectrals: [],                                              // step 31b: the ghost's SPECTRAL SHOT
        graves: [],                                                 // step 31c: its GRAVE BURST
        dashes: [],                                                 // step 31d: its GHOST DASH
        embers: [],                                                 // step 33b: the dragon's EMBER RAIN
        tails: [],                                                  // step 33c: its TAIL SWEEP
        roarAttacks: [],                                            // step 33d: its ROAR (not `roars` - that is the old swoop/phase roar sound)
        bites: [],                                                  // step 33d2: a hatchling leaps
        bossSpawn: null, bossDied: null, bossPhase: null, wave: null,
        missionHits: [], missionEnd: null, missionState: null      // step 24, see missions.js
    };
}

/* What the clients draw: position, facing, health, and whether it is currently
   see-through. Sent at the same rate as the bandit snapshot. */
const SCATTER_CODE = { collapse: 3, gone: 4, rise: 5, strike: 6 };
const HARVEST_CODE = { summon: 7, spin: 8, tired: 9 };
const DASH_CODE = { mist: 14, gone: 15, appear: 16, dash: 17, recover: 18 };
const EMBER_CODE = { takeoff: 21, spit: 22, hover: 23, land: 24 };
const TAIL_CODE = { charge: 25, sweep: 26, recover: 27 };
const ROAR_CODE = { swell: 28, roar: 29, lay: 30 };
function snapshot(room, now) {
    const b = room.boss;
    if (!b || !b.alive) return null;
    const t = now === undefined ? Date.now() : now;
    const snap = [
        Math.round(b.x * 100) / 100,
        Math.round(b.z * 100) / 100,
        Math.round(b.yaw * 100) / 100,
        Math.round(b.health),
        // step 31d: see-through while it is turning to mist (VANISH used to set this)
        (b.dash && b.dash.e === "mist") ? 1 : 0,
        (b.chargeUntil && b.chargeUntil > t) ? 1 : 0,
        b.phase === 2 ? 1 : 0,
        // step 27: the robot's gun - 1 spinning up, 2 firing (0 for everybody else)
        b.gState === "spin" ? 1 : (b.gState === "fire" ? 2 : 0)
    ];
    /* step 30b: the skeleton's duel, only while there is one - 1 counting down (who
       is marked, ms left), 2 down on one knee after a skull shot (ms left) - so a
       latecomer sees the skull, and older clients simply ignore the extra fields */
    if (b.duel) snap.push(1, b.duel.target, Math.max(0, Math.round(b.duel.until - t)));
    else if (b.staggerUntil && b.staggerUntil > t) snap.push(2, "", Math.round(b.staggerUntil - t));
    /* step 30c: BONE SCATTER - 3 collapsing, 4 gone, 5 rising, 6 striking (who it
       came for, ms left in that part) */
    else if (b.scatter) snap.push(SCATTER_CODE[b.scatter.e], b.scatter.target || "", Math.max(0, Math.round(b.scatter.until - t)));
    /* step 30d: BONE HARVEST - 7 summoning, 8 spinning (low / high), 9 exhausted (ms left) */
    else if (b.harvest) snap.push(HARVEST_CODE[b.harvest.e], b.harvest.e === "spin" ? SKELETON.waves[b.harvest.wave] : "", Math.max(0, Math.round(b.harvest.until - t)));
    /* step 31b: the ghost's SPECTRAL SHOT - 11 while the gun is up (who it is for, ms
       until the round leaves). The ghost's codes are 11-19; 1-9 are the skeleton's. */
    else if (b.spectral && b.spectral.e !== "lower") snap.push(11, b.spectral.target, Math.max(0, Math.round(b.spectral.fireAt - t)));
    /* step 31c: GRAVE BURST - 12 while the hand comes up (who it is for, ms until the
       circle opens), 13 while the circle fills (who, ms until the burst, and where the
       circle is: fields 11-12) */
    else if (b.grave && b.grave.e === "raise") snap.push(12, b.grave.target, Math.max(0, Math.round(b.grave.until - t)));
    else if (b.grave && b.grave.e === "fill") snap.push(13, b.grave.target, Math.max(0, Math.round(b.grave.until - t)), round2(b.grave.x), round2(b.grave.z));
    /* step 31d: GHOST DASH - 14 mist, 15 gone (with the mark, fields 11-12, once it is
       open, so a latecomer sees it too), 16 coming out, 17 charging, 18 recovering */
    else if (b.dash && b.dash.e === "gone" && b.dash.mx !== undefined) snap.push(15, b.dash.target || "", Math.max(0, Math.round(b.dash.until - t)), round2(b.dash.mx), round2(b.dash.mz));
    else if (b.dash) snap.push(DASH_CODE[b.dash.e], b.dash.target || "", Math.max(0, Math.round(b.dash.until - t)));
    /* step 33b: the dragon's EMBER RAIN - 21 taking off, 22 spitting, 23 hovering,
       24 landing (ms left in that part). Its codes are 21-29. */
    else if (b.ember) snap.push(EMBER_CODE[b.ember.e], "", Math.max(0, Math.round(b.ember.until - t)));
    /* step 33c: TAIL SWEEP - 25 crouching, 26 sweeping, 27 getting up (ms left in that
       part), and which way it spins (field 11: 1 or -1) */
    else if (b.tail) snap.push(TAIL_CODE[b.tail.e], "", Math.max(0, Math.round(b.tail.until - t)), b.tail.dir);
    /* step 33d: the ROAR - 28 swelling, 29 roaring, 30 laying eggs (step 33d2) (ms left in that part) */
    else if (b.roar) snap.push(ROAR_CODE[b.roar.e], "", Math.max(0, Math.round(b.roar.until - t)));
    return snap;
}

function hurt(room, amount, now) {
    const b = room.boss;
    if (!b || !b.alive) return null;
    const t = now === undefined ? Date.now() : now;
    if (b.scatter && b.scatter.e === "gone") return null;       // step 30c: there is nothing there to hit
    if (b.dash && b.dash.e === "gone") return null;             // step 31d: nor while the ghost is mist
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
    BOSS, BOSS_TYPES, PHASE2, ROBOT, DRAGON, SKELETON, GHOST, GUN, initRoom, stepRoom, snapshot, hurt,
    secondsToBoss, clearBoss, emptySink, duelHeadshot, liftOf
};
