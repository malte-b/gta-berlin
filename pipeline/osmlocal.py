"""OpenStreetMap for all of Berlin from one download instead of Overpass.

The single-area build asks the public Overpass API four questions - the
buildings, the ground cover, the points of interest and the benches in its
box. Asking them for each of Berlin's ~1,000 tiles would be ~4,000 heavy
queries, far beyond the server's fair-use limits (and it is often at
capacity anyway). Geofabrik's daily Berlin extract (~100 MB) answers them
all locally in seconds.

The answers are written as exactly the cache files the loaders already look
for - OSM XML for osm3d.load_osm, Overpass JSON for groundcover.load,
build_pois and the benches in street_furniture.load - so the rest of the
pipeline neither knows nor cares where they came from. Each query mirrors
the Overpass one it replaces: the same tag filters, ways and relations whose
bounding box touches the query box, `out geom` geometry, `>` recursion.

The extract covers Berlin. Tiles on the city boundary therefore have OSM
data only on the Berlin side, like the tree cadastre and street survey.
"""
import json
import math
import os
import time

import fetch
import osmpbf
from groundcover import GREEN_LANDUSE, GREEN_LEISURE, GREEN_NATURAL

URL = "https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf"
CELL = 0.01                 # degrees per index cell, ~700 x 1100 m in Berlin

NATURAL = {"water"} | GREEN_NATURAL
POI_NODE_KEYS = ("amenity", "shop", "tourism", "historic", "railway", "leisure")
WAY_KEYS = {"building", "building:part", "highway", "natural", "waterway", "landuse",
            "leisure", "amenity", "area:highway", "tourism", "railway", "man_made"}
NODE_KEYS = set(POI_NODE_KEYS) | {"highway"}


def log(m):
    print(m, flush=True)


def download(cache_dir, max_age_days=7):
    """The extract, fetched again once it is more than a week old."""
    path = os.path.join(cache_dir, "berlin-latest.osm.pbf")
    if not os.path.exists(path) or time.time() - os.path.getmtime(path) > max_age_days * 86400:
        log("  downloading %s ..." % URL)
        fetch.download(URL, path, timeout=1800)
    return path


def _rel_wanted(t):
    return ("building" in t or "building:part" in t or t.get("type") == "building"
            or t.get("natural") in NATURAL or t.get("landuse") in GREEN_LANDUSE
            or t.get("leisure") in GREEN_LEISURE)


class OsmIndex:
    """Everything the four queries can return, with a coarse spatial index."""

    def __init__(self, pbf):
        t0 = time.time()
        self.rels = {}
        member_ways, member_nodes = set(), set()
        for _k, els in osmpbf.blocks(pbf, want={"relation"}):
            for rid, tags, members in els:
                if _rel_wanted(tags):
                    self.rels[rid] = (tags, members)
                    for typ, ref, _role in members:
                        if typ == "way":
                            member_ways.add(ref)
                        elif typ == "node":
                            member_nodes.add(ref)
        self.ways = {}
        need = member_nodes
        for _k, els in osmpbf.blocks(pbf, want={"way"}):
            for wid, tags, refs in els:
                if wid in member_ways or not WAY_KEYS.isdisjoint(tags):
                    self.ways[wid] = (tags, refs)
                    need.update(refs)
        self.nodes = {}           # id -> (lon, lat)
        self.node_tags = {}       # id -> tags, for nodes that have any
        for _k, els in osmpbf.blocks(pbf, want={"node"}):
            for nid, tags, ll in els:
                if nid in need or (tags and not NODE_KEYS.isdisjoint(tags)):
                    self.nodes[nid] = ll
                    if tags:
                        self.node_tags[nid] = tags
        self._index()
        log("  OSM index: %d nodes, %d ways, %d relations (%.0fs)"
            % (len(self.nodes), len(self.ways), len(self.rels), time.time() - t0))

    # --- spatial index -----------------------------------------------------

    def _index(self):
        self.way_box = {}
        for wid, (_tags, refs) in self.ways.items():
            pts = [self.nodes[r] for r in refs if r in self.nodes]
            if pts:
                self.way_box[wid] = (min(p[0] for p in pts), min(p[1] for p in pts),
                                     max(p[0] for p in pts), max(p[1] for p in pts))
        self.rel_box = {}
        for rid, (_tags, members) in self.rels.items():
            boxes = []
            for typ, ref, _role in members:
                if typ == "way" and ref in self.way_box:
                    boxes.append(self.way_box[ref])
                elif typ == "node" and ref in self.nodes:
                    x, y = self.nodes[ref]
                    boxes.append((x, y, x, y))
            if boxes:
                self.rel_box[rid] = (min(b[0] for b in boxes), min(b[1] for b in boxes),
                                     max(b[2] for b in boxes), max(b[3] for b in boxes))
        self.grid = {}
        for kind, boxes in (("way", self.way_box), ("relation", self.rel_box)):
            for eid, b in boxes.items():
                for cell in self._cells(b):
                    self.grid.setdefault(cell, []).append((kind, eid))
        for nid in self.node_tags:
            x, y = self.nodes[nid]
            self.grid.setdefault(self._cell(x, y), []).append(("node", nid))

    @staticmethod
    def _cell(x, y):
        return int(math.floor(x / CELL)), int(math.floor(y / CELL))

    def _cells(self, b):
        c0, r0 = self._cell(b[0], b[1])
        c1, r1 = self._cell(b[2], b[3])
        return [(c, r) for c in range(c0, c1 + 1) for r in range(r0, r1 + 1)]

    def _in(self, bbox):
        """(kind, id) of every indexed element touching bbox = (s, w, n, e)."""
        s, w, n, e = bbox
        seen = set()
        for cell in self._cells((w, s, e, n)):
            for item in self.grid.get(cell, ()):
                if item in seen:
                    continue
                seen.add(item)
                kind, eid = item
                if kind == "node":
                    x, y = self.nodes[eid]
                    if w <= x <= e and s <= y <= n:
                        yield item
                else:
                    b = (self.way_box if kind == "way" else self.rel_box)[eid]
                    if b[0] <= e and b[2] >= w and b[1] <= n and b[3] >= s:
                        yield item

    def _geom(self, refs):
        return [{"lat": self.nodes[r][1], "lon": self.nodes[r][0]} if r in self.nodes else None
                for r in refs]

    # --- the queries ----------------------------------------------------------

    def buildings_osm(self, bbox):
        """osm3d.load_osm: building ways and relations, `(._;>;); out meta`."""
        ways, rels, nodes = set(), set(), set()
        for kind, eid in self._in(bbox):
            if kind == "way":
                t = self.ways[eid][0]
                if "building" in t or "building:part" in t:
                    ways.add(eid)
            elif kind == "relation":
                t = self.rels[eid][0]
                if "building" in t or "building:part" in t or t.get("type") == "building":
                    rels.add(eid)
        # recurse down: member nodes and ways, and the nodes of every way
        for rid in rels:
            for typ, ref, _role in self.rels[rid][1]:
                if typ == "way" and ref in self.ways:
                    ways.add(ref)
                elif typ == "node":
                    nodes.add(ref)
        for wid in ways:
            nodes.update(self.ways[wid][1])
        out = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<osm version="0.6" generator="gta-berlin osmlocal">']

        def tags(t):
            return "".join('<tag k="%s" v="%s"/>' % (_esc(k), _esc(v)) for k, v in t.items())
        for nid in sorted(nodes):
            if nid not in self.nodes:
                continue
            lon, lat = self.nodes[nid]
            t = self.node_tags.get(nid)
            head = '<node id="%d" version="1" lat="%.7f" lon="%.7f"' % (nid, lat, lon)
            out.append(head + (">%s</node>" % tags(t) if t else "/>"))
        for wid in sorted(ways):
            t, refs = self.ways[wid]
            out.append('<way id="%d" version="1">%s%s</way>' % (
                wid, "".join('<nd ref="%d"/>' % r for r in refs if r in self.nodes), tags(t)))
        for rid in sorted(rels):
            t, members = self.rels[rid]
            out.append('<relation id="%d" version="1">%s%s</relation>' % (
                rid, "".join('<member type="%s" ref="%d" role="%s"/>' % (typ, ref, _esc(role))
                             for typ, ref, role in members), tags(t)))
        out.append("</osm>")
        return "\n".join(out)

    def ground_json(self, bbox):
        """groundcover.load: streets, water, green space, parking - `out geom`."""
        els = []
        for kind, eid in self._in(bbox):
            if kind == "way":
                t, refs = self.ways[eid]
                if ("highway" in t or "area:highway" in t
                        or t.get("natural") in NATURAL or t.get("waterway") == "riverbank"
                        or t.get("landuse") in GREEN_LANDUSE
                        or t.get("leisure") in GREEN_LEISURE | {"pitch"}
                        or t.get("amenity") == "parking"):
                    els.append({"type": "way", "id": eid, "nodes": refs,
                                "geometry": self._geom(refs), "tags": t})
            elif kind == "relation":
                t, members = self.rels[eid]
                if (t.get("natural") in NATURAL or t.get("landuse") in GREEN_LANDUSE
                        or t.get("leisure") in GREEN_LEISURE):
                    els.append({"type": "relation", "id": eid, "tags": t,
                                "members": [self._member(m) for m in members]})
        return {"version": 0.6, "generator": "gta-berlin osmlocal", "elements": els}

    def bridges_json(self, bbox):
        """bridges.load: road, path and railway bridges and bridge outlines - `out geom`."""
        els = []
        for kind, eid in self._in(bbox):
            if kind == "way":
                t, refs = self.ways[eid]
                if ((t.get("bridge") not in (None, "no") and ("highway" in t or "railway" in t))
                        or t.get("man_made") == "bridge"):
                    els.append({"type": "way", "id": eid, "nodes": refs,
                                "geometry": self._geom(refs), "tags": t})
        return {"version": 0.6, "generator": "gta-berlin osmlocal", "elements": els}

    def _member(self, m):
        typ, ref, role = m
        out = {"type": typ, "ref": ref, "role": role}
        if typ == "way" and ref in self.ways:
            out["geometry"] = self._geom(self.ways[ref][1])
        elif typ == "node" and ref in self.nodes:
            out["lon"], out["lat"] = self.nodes[ref]
        return out

    def pois_json(self, bbox):
        """build_pois: named streets and points of interest - `out center tags geom`."""
        els = []
        for kind, eid in self._in(bbox):
            if kind == "node":
                t = self.node_tags[eid]
                if (any(k in t for k in POI_NODE_KEYS) or t.get("highway") == "bus_stop"):
                    lon, lat = self.nodes[eid]
                    els.append({"type": "node", "id": eid, "lat": lat, "lon": lon, "tags": t})
            elif kind == "way":
                t, refs = self.ways[eid]
                if ("highway" in t and "name" in t) or "leisure" in t or "amenity" in t \
                        or "tourism" in t:
                    b = self.way_box[eid]
                    els.append({"type": "way", "id": eid, "tags": t,
                                "center": {"lat": (b[1] + b[3]) / 2, "lon": (b[0] + b[2]) / 2},
                                "geometry": self._geom(refs)})
        return {"version": 0.6, "generator": "gta-berlin osmlocal", "elements": els}

    def benches(self, bbox):
        """street_furniture._osm_benches."""
        out = []
        for kind, eid in self._in(bbox):
            if kind == "node" and self.node_tags[eid].get("amenity") == "bench":
                lon, lat = self.nodes[eid]
                out.append({"lat": lat, "lon": lon, "tags": self.node_tags[eid]})
        return out


def _esc(s):
    return (s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")
            .replace(">", "&gt;").replace("\n", "&#10;"))
