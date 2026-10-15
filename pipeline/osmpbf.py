"""A minimal reader for OpenStreetMap .osm.pbf files, standard library only.

The format is a sequence of zlib-compressed blocks of protocol buffers
(https://wiki.openstreetmap.org/wiki/PBF_Format). Only what an extract like
Geofabrik's needs is decoded: dense nodes, plain nodes, ways and relations
with their tags. Metadata (versions, users, timestamps) is skipped.

    for kind, elems in blocks(path, want={"way"}):
        for osm_id, tags, refs in elems: ...

Each pass decompresses the whole file, but groups of an unwanted kind are
skipped without being decoded, so reading only the relations or only the
ways of Berlin takes a fraction of a full decode.
"""
import struct
import zlib


def _varint(buf, i):
    shift = result = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if b < 0x80:
            return result, i
        shift += 7


def fields(buf):
    """(field number, value) for every field of a message; length-delimited
    values come back as bytes, varints as ints."""
    i, n = 0, len(buf)
    while i < n:
        key, i = _varint(buf, i)
        num, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(buf, i)
        elif wt == 2:
            ln, i = _varint(buf, i)
            v = buf[i:i + ln]
            i += ln
        elif wt == 1:
            v = buf[i:i + 8]
            i += 8
        elif wt == 5:
            v = buf[i:i + 4]
            i += 4
        else:
            raise ValueError("unsupported wire type %d" % wt)
        yield num, v


def packed(buf):
    """Packed unsigned varints."""
    out = []
    i, n = 0, len(buf)
    while i < n:
        b = buf[i]
        if b < 0x80:                 # the common one-byte case, inline
            out.append(b)
            i += 1
        else:
            v, i = _varint(buf, i)
            out.append(v)
    return out


def _zz(v):
    return (v >> 1) ^ -(v & 1)


def packed_delta(buf):
    """Packed zigzag varints, delta coded - ids, coordinates, refs."""
    out = []
    acc = 0
    for v in packed(buf):
        acc += (v >> 1) ^ -(v & 1)
        out.append(acc)
    return out


def _blobs(path):
    with open(path, "rb") as fh:
        while True:
            head = fh.read(4)
            if len(head) < 4:
                return
            hlen, = struct.unpack(">I", head)
            htype, size = None, 0
            for num, v in fields(fh.read(hlen)):
                if num == 1:
                    htype = bytes(v).decode()
                elif num == 3:
                    size = v
            blob = fh.read(size)
            yield htype, blob


def _inflate(blob):
    raw = zdata = None
    for num, v in fields(blob):
        if num == 1:
            raw = v
        elif num == 3:
            zdata = v
    if raw is not None:
        return bytes(raw)
    if zdata is not None:
        return zlib.decompress(zdata)
    raise ValueError("unsupported blob compression (only raw and zlib are)")


def _tags(keys, vals, st):
    return {st[k]: st[v] for k, v in zip(keys, vals)}


def blocks(path, want=("node", "way", "relation")):
    """Yield (kind, [elements]) per group of the wanted kinds.

    node:     (id, tags, (lon, lat))
    way:      (id, tags, [node ids])
    relation: (id, tags, [(type, ref, role)])
    """
    want = set(want)
    group_kind = {1: "node", 2: "node", 3: "way", 4: "relation"}
    for htype, blob in _blobs(path):
        if htype != "OSMData":
            continue
        data = _inflate(blob)
        st, groups = [], []
        gran, lat_off, lon_off = 100, 0, 0
        for num, v in fields(data):
            if num == 1:
                st = [bytes(s).decode("utf-8", "replace") for n_, s in fields(v) if n_ == 1]
            elif num == 2:
                groups.append(v)
            elif num == 17:
                gran = v
            elif num == 19:
                lat_off = v
            elif num == 20:
                lon_off = v
        for g in groups:
            for num, v in fields(g):
                kind = group_kind.get(num)
                if kind not in want:
                    continue
                if num == 2:
                    yield "node", _dense(v, st, gran, lat_off, lon_off)
                elif num == 1:
                    yield "node", [_node(v, st, gran, lat_off, lon_off)]
                elif num == 3:
                    yield "way", [_way(v, st)]
                elif num == 4:
                    yield "relation", [_relation(v, st)]


def _coord(v, off, gran):
    return (off + gran * v) * 1e-9


def _dense(buf, st, gran, lat_off, lon_off):
    ids = lats = lons = kv = ()
    for num, v in fields(buf):
        if num == 1:
            ids = packed_delta(v)
        elif num == 8:
            lats = packed_delta(v)
        elif num == 9:
            lons = packed_delta(v)
        elif num == 10:
            kv = packed(v)
    out = []
    k = 0
    nkv = len(kv)
    for i, nid in enumerate(ids):
        tags = None
        if k < nkv:
            # keys_vals: k v k v ... 0 per node
            while kv[k] != 0:
                if tags is None:
                    tags = {}
                tags[st[kv[k]]] = st[kv[k + 1]]
                k += 2
            k += 1
        out.append((nid, tags or {}, (_coord(lons[i], lon_off, gran),
                                      _coord(lats[i], lat_off, gran))))
    return out


def _node(buf, st, gran, lat_off, lon_off):
    nid = lat = lon = 0
    keys = vals = ()
    for num, v in fields(buf):
        if num == 1:
            nid = _zz(v)
        elif num == 2:
            keys = packed(v)
        elif num == 3:
            vals = packed(v)
        elif num == 8:
            lat = _zz(v)
        elif num == 9:
            lon = _zz(v)
    return nid, _tags(keys, vals, st), (_coord(lon, lon_off, gran), _coord(lat, lat_off, gran))


def _way(buf, st):
    wid = 0
    keys = vals = refs = ()
    for num, v in fields(buf):
        if num == 1:
            wid = v
        elif num == 2:
            keys = packed(v)
        elif num == 3:
            vals = packed(v)
        elif num == 8:
            refs = packed_delta(v)
    return wid, _tags(keys, vals, st), refs


_MEMBER = ("node", "way", "relation")


def _relation(buf, st):
    rid = 0
    keys = vals = roles = mids = types = ()
    for num, v in fields(buf):
        if num == 1:
            rid = v
        elif num == 2:
            keys = packed(v)
        elif num == 3:
            vals = packed(v)
        elif num == 8:
            roles = packed(v)
        elif num == 9:
            mids = packed_delta(v)
        elif num == 10:
            types = packed(v)
    members = [(_MEMBER[t], m, st[r]) for t, m, r in zip(types, mids, roles)]
    return rid, _tags(keys, vals, st), members
