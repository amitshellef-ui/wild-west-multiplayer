/* =========================================================================
   NAVIGATION - server side

   A deliberate line-by-line port of the collision test and the A* grid that
   already run in the browser. It has to behave identically, because a bandit
   simulated here is drawn there: if the two disagree about where a wall is,
   players watch bandits walk through buildings.

   The numbers that must match the client exactly are the grid origin, the cell
   size and the padding - they live in map-data.js so there is one copy.
   ========================================================================= */
const { COLLIDERS, NAV } = require("./map-data");

/* ---- The collider grid (step 20) -------------------------------------------
   The border rocks took the map from 134 boxes to 909, and every collision
   question used to ask all of them. The map is cut into 8 metre cells and each
   box is filed under every cell it overlaps, so a question only asks the boxes
   near it. Identical to CGRID in the client, and identical answers to the old
   loop - a box that could overlap is never skipped, and the overlap test itself
   is unchanged. Checked against the full scan on 60,000 random questions. */
const CG = { minX: -80, minZ: -95, cell: 8, w: 20, h: 22 };
function cgX(x) { return Math.max(0, Math.min(CG.w - 1, Math.floor((x - CG.minX) / CG.cell))); }
function cgZ(z) { return Math.max(0, Math.min(CG.h - 1, Math.floor((z - CG.minZ) / CG.cell))); }

function buildGrid(list) {
    const cells = new Array(CG.w * CG.h);
    for (let i = 0; i < cells.length; i++) cells[i] = [];
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        for (let gz = cgZ(c[2]); gz <= cgZ(c[5]); gz++) {
            for (let gx = cgX(c[0]); gx <= cgX(c[3]); gx++) cells[gz * CG.w + gx].push(i);
        }
    }
    return { cells: cells, stamp: new Uint32Array(list.length), tick: 0 };
}
const COLLIDER_GRID = buildGrid(COLLIDERS);

/* ---- Collision ----------------------------------------------------------
   The client tests a box from y 0.3 to 1.8 so that a beam overhead does not
   block the floor beneath it. Same here. */
function areaBlocked(minX, minZ, maxX, maxZ) {
    const g = COLLIDER_GRID;
    const t = ++g.tick;
    const x0 = cgX(minX), x1 = cgX(maxX), z0 = cgZ(minZ), z1 = cgZ(maxZ);
    for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) {
            const list = g.cells[gz * CG.w + gx];
            for (let k = 0; k < list.length; k++) {
                const i = list[k];
                if (g.stamp[i] === t) continue;
                g.stamp[i] = t;
                const c = COLLIDERS[i];
                if (maxX < c[0] || minX > c[3]) continue;
                if (maxZ < c[2] || minZ > c[5]) continue;
                if (1.8 < c[1] || 0.3 > c[4]) continue;
                return true;
            }
        }
    }
    return false;
}

function collidesAt(x, z, radius) {
    const r = radius === undefined ? 0.55 : radius;
    return areaBlocked(x - r, z - r, x + r, z + r);
}

/* ---- The walkable grid -------------------------------------------------- */
const blocked = new Uint8Array(NAV.w * NAV.h);

function buildNav() {
    const half = NAV.cell / 2 + NAV.pad;
    for (let cz = 0; cz < NAV.h; cz++) {
        for (let cx = 0; cx < NAV.w; cx++) {
            const wx = NAV.minX + (cx + 0.5) * NAV.cell;
            const wz = NAV.minZ + (cz + 0.5) * NAV.cell;
            blocked[cz * NAV.w + cx] = areaBlocked(wx - half, wz - half, wx + half, wz + half) ? 1 : 0;
        }
    }
}
buildNav();

function navIdx(cx, cz) { return cz * NAV.w + cx; }

/* ---- Regions (step 18) -----------------------------------------------------
   The grid is not one piece. Walls are padded by 1.3 metres a side so a
   bandit's route never scrapes a corner, and that padding seals off two places
   a player can still walk into: the fenced corral north of the plaza, and the
   mine shaft, whose 3.6 metre entrance is left with less than one cell open.

   A* cannot know that. Asked to reach a player standing in the corral, it
   searches every cell it can reach - nine thousand steps, about 8ms - before
   giving up, and the bandit asks again 600ms later. Measured at the hardest
   wave: failed searches were 63% of all searches and 97% of all the time the
   server spent simulating. So the regions are worked out once, here, and a
   search between two of them is answered without searching. */
const region = new Int32Array(NAV.w * NAV.h).fill(-1);
const regionSize = [];

function buildRegions() {
    const stack = [];
    for (let cz = 0; cz < NAV.h; cz++) {
        for (let cx = 0; cx < NAV.w; cx++) {
            const start = navIdx(cx, cz);
            if (blocked[start] || region[start] >= 0) continue;
            const id = regionSize.length;
            let size = 0;
            region[start] = id;
            stack.push(start);
            while (stack.length) {
                const cur = stack.pop();
                size++;
                const x = cur % NAV.w, z = (cur / NAV.w) | 0;
                for (let d = 0; d < 8; d++) {
                    const nx = x + DIRS_R[d][0], nz = z + DIRS_R[d][1];
                    if (isBlocked(nx, nz)) continue;
                    // the same no-corner-cutting rule A* follows, or the regions would lie
                    if (d > 3 && (isBlocked(x + DIRS_R[d][0], z) || isBlocked(x, z + DIRS_R[d][1]))) continue;
                    const n = navIdx(nx, nz);
                    if (region[n] < 0) { region[n] = id; stack.push(n); }
                }
            }
            regionSize.push(size);
        }
    }
}
const DIRS_R = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
buildRegions();

function isBlocked(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= NAV.w || cz >= NAV.h) return true;
    return blocked[navIdx(cx, cz)] === 1;
}

function toCellX(x) { return Math.floor((x - NAV.minX) / NAV.cell); }
function toCellZ(z) { return Math.floor((z - NAV.minZ) / NAV.cell); }

function cellCenterX(cx) { return NAV.minX + (cx + 0.5) * NAV.cell; }
function cellCenterZ(cz) { return NAV.minZ + (cz + 0.5) * NAV.cell; }

function nearestFree(cx, cz, maxR) {
    if (!isBlocked(cx, cz)) return [cx, cz];
    const R = maxR || 8;
    for (let r = 1; r <= R; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                if (!isBlocked(cx + dx, cz + dz)) return [cx + dx, cz + dz];
            }
        }
    }
    return null;
}

/* ---- A* ----------------------------------------------------------------- */
function Heap() { this.nodes = []; this.f = []; }
Heap.prototype.push = function (node, f) {
    this.nodes.push(node); this.f.push(f);
    let i = this.nodes.length - 1;
    while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.f[p] <= this.f[i]) break;
        this.swap(i, p); i = p;
    }
};
Heap.prototype.swap = function (a, b) {
    const n = this.nodes[a]; this.nodes[a] = this.nodes[b]; this.nodes[b] = n;
    const f = this.f[a]; this.f[a] = this.f[b]; this.f[b] = f;
};
Heap.prototype.pop = function () {
    const top = this.nodes[0];
    const lastN = this.nodes.pop(), lastF = this.f.pop();
    if (this.nodes.length) {
        this.nodes[0] = lastN; this.f[0] = lastF;
        let i = 0;
        for (;;) {
            const l = i * 2 + 1, r = l + 1;
            let s = i;
            if (l < this.f.length && this.f[l] < this.f[s]) s = l;
            if (r < this.f.length && this.f[r] < this.f[s]) s = r;
            if (s === i) break;
            this.swap(i, s); i = s;
        }
    }
    return top;
};

const DIRS = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]
];

const gScore = new Float32Array(NAV.w * NAV.h);
const cameFrom = new Int32Array(NAV.w * NAV.h);
const seen = new Int32Array(NAV.w * NAV.h);
let stamp = 0;

/* Straight-line walkability, sampled on the grid. */
function lineClear(ax, az, bx, bz) {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(dist / (NAV.cell * 0.5));
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        if (isBlocked(toCellX(ax + (bx - ax) * t), toCellZ(az + (bz - az) * t))) return false;
    }
    return true;
}

/* Drop the waypoints that a straight line already covers, so bandits walk in
   natural lines instead of tracing the grid. */
function smoothPath(pts) {
    if (pts.length < 3) return pts;
    const out = [];
    let i = 0;
    while (i < pts.length - 1) {
        let j = pts.length - 1;
        for (; j > i + 1; j--) {
            if (lineClear(pts[i].x, pts[i].z, pts[j].x, pts[j].z)) break;
        }
        out.push(pts[j]);
        i = j;
    }
    return out.length ? out : [pts[pts.length - 1]];
}

/* The closest cell to (gx, gz) that is in region `want`, looking no further
   than `maxR` cells out. Null if there is none that close. */
function nearestInRegion(gx, gz, want, maxR) {
    let best = null, bestD = Infinity;
    for (let r = 0; r <= maxR; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                const cx = gx + dx, cz = gz + dz;
                if (cx < 0 || cz < 0 || cx >= NAV.w || cz >= NAV.h) continue;
                if (region[navIdx(cx, cz)] !== want) continue;
                const d = dx * dx + dz * dz;
                if (d < bestD) { bestD = d; best = [cx, cz]; }
            }
        }
        // a ring further out cannot hold anything closer than what this one found
        if (best && r * r >= bestD) return best;
    }
    return best;
}

/* ---- The search budget (step 18) ------------------------------------------
   With the regions sorted out an ordinary search costs about half a
   millisecond, but they do not arrive evenly. A room that has just filled for a
   new wave asks for a dozen routes in the same 50ms, and every room on the
   server shares that 50ms.

   So each tick has an allowance, counted in cells searched rather than in
   searches - most routes are cheap and a few are not, and counting searches
   would treat them the same. Once it is spent, findPath answers `undefined`
   instead of searching: not "there is no route" (that is null) but "not this
   tick". The bandit keeps walking the route it already has and asks again a
   tick or two later. Nobody can see a route arriving 100ms late; everybody can
   see a server that stopped for 300ms. */
const PATH_BUDGET = 16000;             // cells a tick - about 15ms of searching
let pathWorkLeft = Infinity;           // unlimited until the server starts counting
let pathSteps = 0;
const pathStats = { searches: 0, deferred: 0 };

function beginTick(budget) {
    pathWorkLeft = budget === undefined ? PATH_BUDGET : budget;
}

function findPath(sx, sz, gx, gz) {
    if (pathWorkLeft <= 0) { pathStats.deferred++; return undefined; }
    pathSteps = 0;
    const route = searchPath(sx, sz, gx, gz);
    pathWorkLeft -= Math.max(1, pathSteps);
    pathStats.searches++;
    return route;
}

function searchPath(sx, sz, gx, gz) {
    const s = nearestFree(toCellX(sx), toCellZ(sz), 6);
    let g = nearestFree(toCellX(gx), toCellZ(gz), 8);
    if (!s || !g) return null;

    /* Different regions: the goal cannot be reached, so aim for the nearest
       place that can. A bandit chasing someone into the corral comes up to the
       fence and shoots over it, instead of standing still re-searching the
       whole town. Too far from any such place, and the answer is simply no. */
    const want = region[navIdx(s[0], s[1])];
    if (region[navIdx(g[0], g[1])] !== want) {
        g = nearestInRegion(g[0], g[1], want, 16);
        if (!g) return null;
    }

    const sIdx = navIdx(s[0], s[1]), gIdx = navIdx(g[0], g[1]);
    if (sIdx === gIdx) return [{ x: cellCenterX(g[0]), z: cellCenterZ(g[1]) }];

    stamp++;
    const open = new Heap();
    gScore[sIdx] = 0; cameFrom[sIdx] = -1; seen[sIdx] = stamp;
    open.push(sIdx, 0);
    let steps = 0;

    while (open.nodes.length) {
        pathSteps = steps + 1;
        if (++steps > 9000) break;
        const cur = open.pop();
        if (cur === gIdx) {
            const cells = [];
            let n = cur;
            while (n !== -1) { cells.push(n); n = cameFrom[n]; }
            cells.reverse();
            const pts = cells.map(function (idx) {
                return { x: cellCenterX(idx % NAV.w), z: cellCenterZ(Math.floor(idx / NAV.w)) };
            });
            pts.shift();                       // we are already standing on the first
            return pts.length ? smoothPath(pts) : null;
        }
        const cx = cur % NAV.w, cz = Math.floor(cur / NAV.w);
        for (let d = 0; d < 8; d++) {
            const nx = cx + DIRS[d][0], nz = cz + DIRS[d][1];
            if (isBlocked(nx, nz)) continue;
            if (d > 3 && (isBlocked(cx + DIRS[d][0], cz) || isBlocked(cx, cz + DIRS[d][1]))) continue;
            const nIdx = navIdx(nx, nz);
            const ng = gScore[cur] + DIRS[d][2];
            if (seen[nIdx] === stamp && gScore[nIdx] <= ng) continue;
            seen[nIdx] = stamp;
            gScore[nIdx] = ng;
            cameFrom[nIdx] = cur;
            const dx = Math.abs(nx - g[0]), dz = Math.abs(nz - g[1]);
            open.push(nIdx, ng + ((dx + dz) + (1.4142 - 2) * Math.min(dx, dz)) * 1.05);
        }
    }
    return null;
}

/* Can one point see another? The browser casts a real 3D ray from the bandit's
   eyes to the camera; here we sample the same segment against the collision
   boxes at body height. Slightly coarser, far cheaper, and it agrees with the
   client about every wall that matters. */
function losClear(ax, az, bx, bz) {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(2, Math.ceil(dist / 0.6));
    for (let i = 1; i < steps; i++) {
        const t = i / steps;
        if (collidesAt(ax + (bx - ax) * t, az + (bz - az) * t, 0.05)) return false;
    }
    return true;
}

/* The mine shaft reaches past the normal boundary, so it is allowed explicitly
   - exactly as the client does it. */
const MINE = { x0: 0.6, x1: 15.4 };

/* Only somewhere a bandit can actually get out of (step 20). Collision for the
   border rocks sealed off a few small pockets between the rocks and the
   boundary wall - about 230 cells - and a bandit placed in one stays there for
   good, holding one of the wave's slots while it does. So points are drawn from
   the town's own region. The mine shaft is still allowed on purpose, as before. */
let TOWN_REGION = -1;
function townRegion() {
    if (TOWN_REGION < 0) TOWN_REGION = regionSize.indexOf(Math.max.apply(null, regionSize));
    return TOWN_REGION;
}

function randomNavPoint() {
    for (let k = 0; k < 40; k++) {
        const cx = Math.floor(Math.random() * NAV.w);
        const cz = Math.floor(Math.random() * NAV.h);
        if (isBlocked(cx, cz)) continue;
        const x = cellCenterX(cx), z = cellCenterZ(cz);
        const inShaft = x > MINE.x0 && x < MINE.x1 && z < -52;
        if (!inShaft && (Math.abs(x) > 66 || Math.abs(z) > 66)) continue;
        if (!inShaft && region[navIdx(cx, cz)] !== townRegion()) continue;
        return { x: x, z: z };
    }
    return { x: 0, z: 0 };
}

/* The nearest place a body of this size can stand that is NOT where it is
   standing now. Rings outward on the grid, so something wedged inside a
   building comes out by the shortest way available.

   This exists because the recovery both bots used was to pick a random point
   on the map and take it only if it happened to land within six metres. From
   the middle of a building that is a one-in-five-hundred draw, so in practice
   anything that got properly wedged stayed wedged. */
function freeSpotNear(x, z, minCells, maxCells, radius) {
    const cx = toCellX(x), cz = toCellZ(z);
    const r0 = minCells || 2, r1 = maxCells || 12;
    const rad = radius === undefined ? 0.55 : radius;
    for (let r = r0; r <= r1; r++) {
        const found = [];
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                if (isBlocked(cx + dx, cz + dz)) continue;
                const fx = cellCenterX(cx + dx), fz = cellCenterZ(cz + dz);
                if (collidesAt(fx, fz, rad)) continue;
                found.push({ x: fx, z: fz });
            }
        }
        // a ring, not a fixed corner, so a crowd does not all pop to one place
        if (found.length) return found[Math.floor(Math.random() * found.length)];
    }
    return null;
}

/* ---- Line of fire (step 15) ----------------------------------------------
   Is there a wall between a gun and a body? A true three-dimensional test of
   the segment against each box, not a sampled one, so a shot that clears a
   rooftop by ten centimetres clears it here too.

   Only boxes taller than SHOT_MIN_HEIGHT stop a bullet. That is not laziness,
   it is the measured answer. Every collision box on this map is stretched to
   at least 2.2 metres tall so nobody can hop onto a crate, which means a one
   metre barrel looks like a wall to anything that asks the collision data.
   Checked against the browser's real bullet ray over thousands of random
   shots: counting every box threw away 1.2% of honest hits; counting only the
   tall ones - buildings, walls, the mine - threw away 0.1%.

   What it does not see: the big mesas out at the corners have no collision box
   at all, so a shot through the corner of one is not caught. Nobody fights out
   there, and a wrong "yes" costs far less than a wrong "no". */
const SHOT_MIN_HEIGHT = 2.21;
const SHOT_SKIN = 0.06;               // a shot that grazes an edge is the shooter's
const SHOT_BLOCKERS = COLLIDERS.filter((c) => c[4] - c[1] > SHOT_MIN_HEIGHT);

/* True if the segment passes through tall box c. The slab test from before,
   lifted out so it can be asked of only the boxes near the shot. */
function segmentHitsBox(c, ax, ay, az, dx, dy, dz) {
    let t0 = 0, t1 = 1;

    // x
    if (Math.abs(dx) < 1e-9) {
        if (ax <= c[0] + SHOT_SKIN || ax >= c[3] - SHOT_SKIN) return false;
    } else {
        let ta = (c[0] + SHOT_SKIN - ax) / dx, tb = (c[3] - SHOT_SKIN - ax) / dx;
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 >= t1) return false;
    }
    // y - the floor of a box is the floor, only its top is skinned
    if (Math.abs(dy) < 1e-9) {
        if (ay <= c[1] || ay >= c[4] - SHOT_SKIN) return false;
    } else {
        let ta = (c[1] - ay) / dy, tb = (c[4] - SHOT_SKIN - ay) / dy;
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 >= t1) return false;
    }
    // z
    if (Math.abs(dz) < 1e-9) {
        if (az <= c[2] + SHOT_SKIN || az >= c[5] - SHOT_SKIN) return false;
    } else {
        let ta = (c[2] + SHOT_SKIN - az) / dz, tb = (c[5] - SHOT_SKIN - az) / dz;
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 >= t1) return false;
    }
    return true;
}

const SHOT_GRID = buildGrid(SHOT_BLOCKERS);

function shotClear(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const g = SHOT_GRID;
    const t = ++g.tick;
    const x0 = cgX(Math.min(ax, bx)), x1 = cgX(Math.max(ax, bx));
    const z0 = cgZ(Math.min(az, bz)), z1 = cgZ(Math.max(az, bz));
    for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) {
            const list = g.cells[gz * CG.w + gx];
            for (let k = 0; k < list.length; k++) {
                const i = list[k];
                if (g.stamp[i] === t) continue;
                g.stamp[i] = t;
                if (segmentHitsBox(SHOT_BLOCKERS[i], ax, ay, az, dx, dy, dz)) return false;
            }
        }
    }
    return true;
}

/* Can a gun at (ax, ay, az) see any part of a body standing at (tx, tz)?
   Head, chest and both shoulders across the line of fire, because a player who
   can see only a shoulder round a corner can still hit that shoulder. `scale`
   is 1 for a bandit or a player, 1.75 for the boss. */
function bodyVisible(ax, ay, az, tx, tz, scale, headY) {
    const s = scale || 1;
    const head = headY !== undefined ? headY : 1.62 * s;
    const chest = head - 0.52 * s;
    if (shotClear(ax, ay, az, tx, head, tz)) return true;
    if (shotClear(ax, ay, az, tx, chest, tz)) return true;
    const lx = tx - ax, lz = tz - az, len = Math.hypot(lx, lz) || 1;
    const px = (-lz / len) * 0.35 * s, pz = (lx / len) * 0.35 * s;
    if (shotClear(ax, ay, az, tx + px, chest, tz + pz)) return true;
    if (shotClear(ax, ay, az, tx - px, chest, tz - pz)) return true;
    return false;
}

/* V8 compiles a function properly only after it has run a while, and until
   then A* is several times slower than the budget above was measured on. On a
   fresh server that meant the first room's opening burst - every bandit asking
   for a route in the same tick - took 150ms, cold. Running a few hundred
   searches before anybody can connect costs under half a second at boot, and
   brought that tick down to 48. Counted work is reset afterwards so the stats
   describe real play. */
function warmUp(count) {
    const n = count || 400;
    const saved = pathWorkLeft;
    pathWorkLeft = Infinity;
    const t = Date.now();
    for (let i = 0; i < n; i++) {
        const a = randomNavPoint(), b = randomNavPoint();
        findPath(a.x, a.z, b.x, b.z);
    }
    pathWorkLeft = saved;
    pathStats.searches = 0;
    pathStats.deferred = 0;
    return Date.now() - t;
}

function regionReport() {
    const main = regionSize.indexOf(Math.max.apply(null, regionSize));
    return { regions: regionSize.length, town: regionSize[main], others: regionSize.filter((n, i) => i !== main) };
}

function blockedCount() {
    let n = 0;
    for (let i = 0; i < blocked.length; i++) n += blocked[i];
    return n;
}

module.exports = {
    collidesAt, isBlocked, toCellX, toCellZ,
    cellCenterX, cellCenterZ, nearestFree,
    findPath, lineClear, losClear, randomNavPoint, freeSpotNear, blockedCount, NAV,
    shotClear, bodyVisible, SHOT_MIN_HEIGHT, SHOT_BLOCKERS, regionReport,
    beginTick, pathStats, PATH_BUDGET, warmUp
};
