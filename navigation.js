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

/* ---- Collision ----------------------------------------------------------
   The client tests a box from y 0.3 to 1.8 so that a beam overhead does not
   block the floor beneath it. Same here. */
function collidesAt(x, z, radius) {
    const r = radius === undefined ? 0.55 : radius;
    const minX = x - r, maxX = x + r;
    const minZ = z - r, maxZ = z + r;
    for (let i = 0; i < COLLIDERS.length; i++) {
        const c = COLLIDERS[i];
        if (maxX < c[0] || minX > c[3]) continue;
        if (maxZ < c[2] || minZ > c[5]) continue;
        if (1.8 < c[1] || 0.3 > c[4]) continue;
        return true;
    }
    return false;
}

/* ---- The walkable grid -------------------------------------------------- */
const blocked = new Uint8Array(NAV.w * NAV.h);

function buildNav() {
    const half = NAV.cell / 2 + NAV.pad;
    for (let cz = 0; cz < NAV.h; cz++) {
        for (let cx = 0; cx < NAV.w; cx++) {
            const wx = NAV.minX + (cx + 0.5) * NAV.cell;
            const wz = NAV.minZ + (cz + 0.5) * NAV.cell;
            const minX = wx - half, maxX = wx + half;
            const minZ = wz - half, maxZ = wz + half;
            let hit = 0;
            for (let i = 0; i < COLLIDERS.length; i++) {
                const c = COLLIDERS[i];
                if (maxX < c[0] || minX > c[3]) continue;
                if (maxZ < c[2] || minZ > c[5]) continue;
                if (1.8 < c[1] || 0.3 > c[4]) continue;
                hit = 1; break;
            }
            blocked[cz * NAV.w + cx] = hit;
        }
    }
}
buildNav();

function navIdx(cx, cz) { return cz * NAV.w + cx; }

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

function findPath(sx, sz, gx, gz) {
    const s = nearestFree(toCellX(sx), toCellZ(sz), 6);
    const g = nearestFree(toCellX(gx), toCellZ(gz), 8);
    if (!s || !g) return null;

    const sIdx = navIdx(s[0], s[1]), gIdx = navIdx(g[0], g[1]);
    if (sIdx === gIdx) return [{ x: cellCenterX(g[0]), z: cellCenterZ(g[1]) }];

    stamp++;
    const open = new Heap();
    gScore[sIdx] = 0; cameFrom[sIdx] = -1; seen[sIdx] = stamp;
    open.push(sIdx, 0);
    let steps = 0;

    while (open.nodes.length) {
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

function randomNavPoint() {
    for (let k = 0; k < 40; k++) {
        const cx = Math.floor(Math.random() * NAV.w);
        const cz = Math.floor(Math.random() * NAV.h);
        if (isBlocked(cx, cz)) continue;
        const x = cellCenterX(cx), z = cellCenterZ(cz);
        const inShaft = x > MINE.x0 && x < MINE.x1 && z < -52;
        if (!inShaft && (Math.abs(x) > 66 || Math.abs(z) > 66)) continue;
        return { x: x, z: z };
    }
    return { x: 0, z: 0 };
}

function blockedCount() {
    let n = 0;
    for (let i = 0; i < blocked.length; i++) n += blocked[i];
    return n;
}

module.exports = {
    collidesAt, isBlocked, toCellX, toCellZ,
    cellCenterX, cellCenterZ, nearestFree,
    findPath, lineClear, losClear, randomNavPoint, blockedCount, NAV
};
