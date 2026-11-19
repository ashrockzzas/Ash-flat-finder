"""Build a city from OpenStreetMap alone, for cities no listing portal covers (Abu Dhabi first).

usage: python osm_city.py <city> [--allow-empty]
  -> web/public/data/<city>.json, <city>-shapes.geojson, cities.json

What it writes, all from OpenStreetMap (ODbL):
- residential buildings: building=apartments or residential, plus any building of 4+ levels inside a named
  residential area (towers in Abu Dhabi are often tagged building=yes),
- named places (islands, suburbs, neighbourhoods) and named residential areas, used to say which area a building is in,
- malls, beaches and schools, and each building's straight-line distance to the nearest one.

Nothing is estimated. Rents and sizes are not in OSM: they come from listings you add yourself on the site.
Heights are only for drawing: real height or levels x 3.2 m where mapped, otherwise a flat default marked "h_shown".
--allow-empty: if every Overpass mirror fails, still write an empty city file that says so (used by the deploy workflow).
"""
import datetime
import json
import math
import pathlib
import sys
from collections import Counter, defaultdict

import geo
import osm_fetch

ROOT = pathlib.Path(__file__).parent
WEB = ROOT.parent / "web" / "public" / "data"
CITIES = json.loads((ROOT.parent / "data" / "cities.json").read_text())
DEFAULT_H = 12.0  # drawing height (m) when OSM has neither height nor levels; never shown as data
POI_KINDS = ("mall", "beach", "school")
PLACE_RANK = {"neighbourhood": 0, "quarter": 0, "suburb": 1, "island": 2}  # smaller first

BUILDINGS_Q = """[out:json][timeout:280];(
  way["building"~"^(apartments|residential)$"]{bb};
  relation["building"~"^(apartments|residential)$"]{bb};
  way["building"]["building:levels"](if: number(t["building:levels"]) >= 4){bb};
);out geom;"""
PLACES_Q = """[out:json][timeout:280];(
  node["place"~"^(suburb|neighbourhood|quarter|island)$"]["name"]{bb};
  way["place"~"^(suburb|neighbourhood|quarter|island)$"]["name"]{bb};
  relation["place"~"^(suburb|neighbourhood|quarter|island)$"]["name"]{bb};
  way["landuse"="residential"]["name"]{bb};
  relation["landuse"="residential"]["name"]{bb};
);out geom;"""
POIS_Q = """[out:json][timeout:280];(
  node["shop"="mall"]{bb};way["shop"="mall"]{bb};relation["shop"="mall"]{bb};
  node["natural"="beach"]{bb};way["natural"="beach"]{bb};relation["natural"="beach"]{bb};
  node["amenity"="school"]{bb};way["amenity"="school"]{bb};relation["amenity"="school"]{bb};
);out geom;"""


def name_of(tags):
    return tags.get("name:en") or tags.get("name") or None


def rings_of(el):
    """Closed outer rings of a way or multipolygon relation, [] for nodes."""
    if el["type"] == "way" and el.get("geometry"):
        r = osm_fetch._pts(el["geometry"])
        if r[0] != r[-1]:
            r.append(r[0])
        return [r] if len(r) >= 4 else []
    if el["type"] == "relation":
        return osm_fetch.ring_from_relation(el)
    return []


def lines_of(el):
    """Outlines used for distances, as lists of (lng, lat): a node is a one-point line."""
    if el["type"] == "node":
        return [[(round(el["lon"], 5), round(el["lat"], 5))]]
    lines = [osm_fetch._pts(el["geometry"])] if el.get("geometry") else []
    lines += [osm_fetch._pts(m["geometry"]) for m in el.get("members", []) if m.get("geometry")]
    return [[(round(x, 5), round(y, 5)) for x, y in ln] for ln in lines if ln]


def densify(line, step=0.0004):
    """Points every ~40 m along a line, so a long beach drawn with few corners is measured to its edge, not its corners."""
    out = [line[0]]
    for (x0, y0), (x1, y1) in zip(line, line[1:]):
        n = max(1, math.ceil(max(abs(x1 - x0), abs(y1 - y0)) / step))
        out += [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(1, n + 1)]
    return out


def poi_kind(tags):
    if tags.get("shop") == "mall":
        return "mall"
    if tags.get("natural") == "beach":
        return "beach"
    if tags.get("amenity") == "school":
        return "school"
    return None


def ring_area(ring):
    """Rough area in square degrees, only used to prefer the smallest containing place."""
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:]))) / 2


def build_places(elements):
    """-> (areas: named places for areas, compounds: named residential areas). Each has name, kind, lng, lat, rings."""
    areas, compounds = [], []
    for el in elements:
        t = el.get("tags", {})
        nm = name_of(t)
        if not nm:
            continue
        rings = rings_of(el)
        if el["type"] == "node":
            c = (el["lon"], el["lat"])
        elif rings:
            c = geo.centroid(max(rings, key=len))
        else:
            continue
        rec = {"name": nm, "kind": t.get("place") or "residential", "lng": round(c[0], 5), "lat": round(c[1], 5), "rings": rings,
               "osm": f"{el['type']}/{el['id']}"}
        (areas if t.get("place") else compounds).append(rec)
    return areas, compounds


def containing(pt, places):
    """Smallest place whose shape contains pt, else None."""
    best = None
    for p in places:
        for r in p["rings"]:
            x0, y0, x1, y1 = geo.bbox(r)
            if x0 <= pt[0] <= x1 and y0 <= pt[1] <= y1 and geo.point_in_ring(pt, r):
                key = (PLACE_RANK.get(p["kind"], 0), ring_area(r))
                if best is None or key < best[0]:
                    best = (key, p)
    return best[1] if best else None


def area_for(pt, areas, max_m=2500):
    """Which named area a point is in. 'inside' when OSM maps the area's shape, 'nearest' for the closest place point."""
    p = containing(pt, [a for a in areas if a["rings"]])
    if p:
        return p["name"], "inside"
    near = [(geo.dist_m(pt, (a["lng"], a["lat"])), a) for a in areas if not a["rings"]]
    near = [x for x in near if x[0] <= max_m]
    if near:
        return min(near, key=lambda x: x[0])[1]["name"], "nearest"
    return None, None


class PointGrid:
    """Nearest-point lookups in 0.02 degree cells (about 2 km)."""
    CELL = 0.02

    def __init__(self, items):  # items: (lng, lat, payload)
        self.cells = defaultdict(list)
        for x, y, p in items:
            self.cells[(math.floor(x / self.CELL), math.floor(y / self.CELL))].append((x, y, p))
        self.empty = not items

    def nearest(self, pt, max_rings=40):
        if self.empty:
            return None
        cx, cy = math.floor(pt[0] / self.CELL), math.floor(pt[1] / self.CELL)
        best = None
        for k in range(max_rings + 1):
            for i in range(cx - k, cx + k + 1):
                for j in range(cy - k, cy + k + 1):
                    if max(abs(i - cx), abs(j - cy)) != k:
                        continue
                    for x, y, p in self.cells.get((i, j), ()):
                        d = geo.dist_m(pt, (x, y))
                        if best is None or d < best[0]:
                            best = (d, p)
            # every unseen point is at least k cells away
            if best and best[0] <= k * self.CELL * geo.m_per_deg_lng(pt[1]):
                break
        return best


def build_pois(elements):
    pois = []
    for el in elements:
        t = el.get("tags", {})
        k = poi_kind(t)
        lines = lines_of(el)
        if not k or not lines:
            continue
        pts = [q for ln in lines for q in ln]
        c = (el["lon"], el["lat"]) if el["type"] == "node" else (sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts))
        pois.append({"k": k, "name": name_of(t), "lng": round(c[0], 5), "lat": round(c[1], 5), "lines": lines, "osm": f"{el['type']}/{el['id']}"})
    return pois


def poi_grids(pois):
    return {k: PointGrid([(x, y, p) for p in pois if p["k"] == k for ln in p["lines"] for x, y in densify(ln)]) for k in POI_KINDS}


def nearby(pt, grids):
    out = {}
    for k, g in grids.items():
        hit = g.nearest(pt)
        if hit:
            out[k] = {"m": int(round(hit[0] / 10) * 10), "name": hit[1]["name"]}
    return out


def build_buildings(elements, areas, compounds, grids):
    buildings, shapes = [], []
    compound_grid = [c for c in compounds if c["rings"]]
    for el in elements:
        t = el.get("tags", {})
        rings = rings_of(el)
        if not rings:
            continue
        ring = max(rings, key=len)
        c = geo.centroid(ring)
        comp = containing(c, compound_grid)
        if t.get("building") not in ("apartments", "residential") and not comp:
            continue  # a 4+ level building=yes counts only inside a named residential area
        area, how = area_for(c, areas)
        h = osm_fetch.height_of(t)
        bid = f"{el['type'][0]}{el['id']}"
        b = {"id": bid, "name": name_of(t), "lng": round(c[0], 5), "lat": round(c[1], 5), "osm": f"{el['type']}/{el['id']}",
             "area": area, "area_how": how, "compound": comp["name"] if comp else None,
             "levels": t.get("building:levels"), "type": t.get("building"),
             "street": " ".join(x for x in (t.get("addr:housenumber"), t.get("addr:street")) if x) or None,
             "near": nearby(c, grids)}
        buildings.append({k: v for k, v in b.items() if v not in (None, "", {})})
        for r in rings:
            shapes.append({"type": "Feature", "properties": {"sid": bid, "role": "bld", "h": round(h or DEFAULT_H), **({} if h else {"h_shown": 1})},
                           "geometry": {"type": "Polygon", "coordinates": [[[round(x, 5), round(y, 5)] for x, y in r]]}})
    return buildings, shapes


def write_cities_index():
    """web/public/data/cities.json: every built city, with the page that shows it."""
    built = {p.stem for p in WEB.glob("*.json")} - {"cities"}
    out = {}
    for cid, cfg in CITIES.items():
        if cid in built:
            out[cid] = {"name": cfg["name"], **({"app": cid} if cfg.get("source") == "osm" else {})}
    (WEB / "cities.json").write_text(json.dumps(out))


def build(city, places_raw, buildings_raw, pois_raw, error=None):
    cfg = CITIES[city]
    areas, compounds = build_places(places_raw.get("elements", []))
    pois = build_pois(pois_raw.get("elements", []))
    grids = poi_grids(pois)
    buildings, shapes = build_buildings(buildings_raw.get("elements", []), areas, compounds, grids)
    doc = {
        "city": {"id": city, "name": cfg["name"], "center": cfg["center"], "zoom": cfg.get("zoom", 11), "bbox": cfg["bbox"],
                 "currency": cfg.get("currency", "AED"), "rent_period": cfg.get("rent_period", "year")},
        "source": {"name": "OpenStreetMap contributors", "license": "ODbL", "url": "https://www.openstreetmap.org/copyright",
                   "built": datetime.date.today().isoformat()},
        "error": error,
        "counts": {"buildings": len(buildings), "named": sum(1 for b in buildings if b.get("name")),
                   "areas": len(areas), "compounds": len(compounds), "pois": dict(Counter(p["k"] for p in pois))},
        "areas": [{k: a[k] for k in ("name", "kind", "lng", "lat", "osm")} for a in sorted(areas, key=lambda a: a["name"])],
        "pois": [{**p, "lines": [[list(q) for q in ln] for ln in p["lines"]]} for p in pois],
        "buildings": buildings,
    }
    return doc, {"type": "FeatureCollection", "features": shapes}


def main():
    args = sys.argv[1:]
    city = next((a for a in args if a in CITIES), None)
    if not city or CITIES[city].get("source") != "osm":
        raise SystemExit("usage: python osm_city.py <city with \"source\": \"osm\" in data/cities.json> [--allow-empty]")
    s, w, n, e = CITIES[city]["bbox"]
    bb = f"({s},{w},{n},{e})"
    osm_fetch.CACHE = ROOT / "cache" / "osm" / city  # cached: a rerun does not hit Overpass again
    raw, error = {}, None
    try:
        for name, q in (("places", PLACES_Q), ("buildings", BUILDINGS_Q), ("pois", POIS_Q)):
            raw[name] = osm_fetch.overpass(q.replace("{bb}", bb), name)
            print(name, len(raw[name].get("elements", [])), "elements", flush=True)
    except SystemExit as ex:
        if "--allow-empty" not in args:
            raise
        error = f"OpenStreetMap could not be reached when this was built ({ex}). Your own listings still work."
        print("WARNING:", error)
    doc, shapes = build(city, raw.get("places", {}), raw.get("buildings", {}), raw.get("pois", {}), error)
    WEB.mkdir(parents=True, exist_ok=True)
    (WEB / f"{city}.json").write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    (WEB / f"{city}-shapes.geojson").write_text(json.dumps(shapes, separators=(",", ":")))
    write_cities_index()
    print(doc["counts"])
    without_area = sum(1 for b in doc["buildings"] if not b.get("area"))
    print("buildings without a named area:", without_area)


if __name__ == "__main__":
    main()
