"""Navigation grid: where you can actually walk and drive.

The heightfield straight off the mesh is a *surface* model - it includes
parked cars, kiosks, bollards, tree canopies and photogrammetric noise. Testing
movement against it directly treats every one of those as a wall, which is why
open pavement ends up full of invisible barriers.

So the surface is first separated into terrain and objects using a grey-scale
morphological opening. An opening removes any raised feature narrower than its
structuring element while leaving wider ones intact: at a 21 m element, cars,
trees and street furniture disappear and building blocks survive. What is left
is the ground you walk on; what was removed is what blocks you.

Afterwards the walkable mask is cleaned up morphologically and flood filled, so
isolated pockets can be reported rather than silently stranding the player.

Output "BTN1", one grid for the whole world:
    f32 minX, minZ   f32 cell   u32 nx, nz   f32 hmin, hscale
    u16[n] terrain            ground height to stand on
    u8[n]  flags              bit0 walkable, bit1 drivable
"""
import struct
from collections import deque

WALKABLE = 1
DRIVABLE = 2
OPEN_SKY = 4      # 7 m of headroom all round, i.e. not under a tree
SKY_RAW  = 8      # headroom directly overhead, un-eroded


def _running(vals, radius, want_max):
    """Sliding-window min or max over a 1D list, O(n) via a monotonic deque."""
    n = len(vals)
    out = [0.0] * n
    dq = deque()
    for i in range(n + radius):
        if i < n:
            v = vals[i]
            if want_max:
                while dq and vals[dq[-1]] <= v:
                    dq.pop()
            else:
                while dq and vals[dq[-1]] >= v:
                    dq.pop()
            dq.append(i)
        j = i - radius
        if j >= 0:
            while dq[0] < j - radius:
                dq.popleft()
            out[j] = vals[dq[0]]
    return out


def _filter2d(grid, nx, nz, radius, want_max):
    """Separable min/max filter with a square structuring element."""
    tmp = [0.0] * (nx * nz)
    for r in range(nz):
        row = grid[r * nx:(r + 1) * nx]
        res = _running(row, radius, want_max)
        tmp[r * nx:(r + 1) * nx] = res
    out = [0.0] * (nx * nz)
    col = [0.0] * nz
    for c in range(nx):
        for r in range(nz):
            col[r] = tmp[r * nx + c]
        res = _running(col, radius, want_max)
        for r in range(nz):
            out[r * nx + c] = res[r]
    return out


def opening(grid, nx, nz, radius):
    """Erode then dilate: strips raised features narrower than 2*radius."""
    eroded = _filter2d(grid, nx, nz, radius, want_max=False)
    return _filter2d(eroded, nx, nz, radius, want_max=True)


def _mask_filter(mask, nx, nz, radius, want_max):
    """Binary dilate (want_max) or erode over a square element."""
    g = [1.0 if m else 0.0 for m in mask]
    out = _filter2d(g, nx, nz, radius, want_max)
    return [v > 0.5 for v in out]


def components(mask, nx, nz):
    """4-connected components of a boolean mask, largest first."""
    seen = [0] * (nx * nz)
    comps = []
    for start in range(nx * nz):
        if not mask[start] or seen[start]:
            continue
        cid = len(comps) + 1
        stack = [start]
        seen[start] = cid
        cells = 0
        while stack:
            k = stack.pop()
            cells += 1
            c, r = k % nx, k // nx
            if c > 0 and mask[k - 1] and not seen[k - 1]:
                seen[k - 1] = cid; stack.append(k - 1)
            if c < nx - 1 and mask[k + 1] and not seen[k + 1]:
                seen[k + 1] = cid; stack.append(k + 1)
            if r > 0 and mask[k - nx] and not seen[k - nx]:
                seen[k - nx] = cid; stack.append(k - nx)
            if r < nz - 1 and mask[k + nx] and not seen[k + nx]:
                seen[k + nx] = cid; stack.append(k + nx)
        comps.append((cells, cid))
    comps.sort(reverse=True)
    return seen, comps


def to_bytes(min_x, min_z, cell, nx, nz, terrain, flags):
    hmin = min(terrain)
    hmax = max(terrain)
    span = hmax - hmin
    scale = span / 65535 if span > 1e-9 else 1.0
    inv = 1.0 / scale
    out = bytearray(b"BTN1")
    out += struct.pack("<2f", min_x, min_z)
    out += struct.pack("<f", cell)
    out += struct.pack("<2I", nx, nz)
    out += struct.pack("<2f", hmin, scale)
    buf = bytearray(len(terrain) * 2)
    for k, v in enumerate(terrain):
        q = int((v - hmin) * inv + 0.5)
        q = 0 if q < 0 else (65535 if q > 65535 else q)
        buf[k * 2] = q & 255
        buf[k * 2 + 1] = q >> 8
    out += buf
    out += bytes(flags)
    return bytes(out), {"hmin": round(hmin, 2), "hmax": round(hmax, 2)}
