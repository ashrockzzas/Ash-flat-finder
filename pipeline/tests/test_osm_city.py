"""osm_city: OpenStreetMap-only city build. Synthetic test shapes, not real places."""
import osm_city


def way(i, tags, pts):
    return {"type": "way", "id": i, "tags": tags, "geometry": [{"lon": x, "lat": y} for x, y in pts]}


def square(x, y, d=0.001):
    return [(x, y), (x + d, y), (x + d, y + d), (x, y + d), (x, y)]


PLACES = {"elements": [
    way(1, {"place": "island", "name": "Test Island", "name:en": "Test Island EN"}, square(54.40, 24.40, 0.05)),
    way(2, {"place": "neighbourhood", "name": "Small Bit"}, square(54.40, 24.40, 0.01)),
    {"type": "node", "id": 3, "lon": 54.60, "lat": 24.40, "tags": {"place": "suburb", "name": "Point Suburb"}},
    way(4, {"landuse": "residential", "name": "Tower Compound"}, square(54.43, 24.43, 0.005)),
]}
BUILDINGS = {"elements": [
    way(10, {"building": "apartments", "name": "Tower A", "building:levels": "20"}, square(54.405, 24.405)),  # in Small Bit
    way(11, {"building": "residential"}, square(54.44, 24.44)),                                          # island only
    way(12, {"building": "yes", "building:levels": "8"}, square(54.431, 24.431)),                       # inside compound
    way(13, {"building": "yes", "building:levels": "8"}, square(54.70, 24.30)),                         # office, no compound
    way(14, {"building": "apartments"}, square(54.601, 24.401)),                                         # near suburb node
]}
POIS = {"elements": [
    {"type": "node", "id": 20, "lon": 54.406, "lat": 24.406, "tags": {"shop": "mall", "name": "Mall One"}},
    way(21, {"natural": "beach", "name": "Long Beach"}, [(54.30, 24.405), (54.50, 24.405), (54.50, 24.4051), (54.30, 24.405)]),
    {"type": "node", "id": 22, "lon": 54.60, "lat": 24.40, "tags": {"amenity": "school"}},
    {"type": "node", "id": 23, "lon": 54.0, "lat": 24.0, "tags": {"amenity": "pharmacy"}},
]}


def built():
    doc, shapes = osm_city.build("abudhabi", PLACES, BUILDINGS, POIS)
    return doc, shapes, {b["id"]: b for b in doc["buildings"]}


def test_keeps_residential_and_compound_towers_only():
    _, _, by = built()
    assert set(by) == {"w10", "w11", "w12", "w14"}
    assert by["w12"]["compound"] == "Tower Compound"


def test_area_prefers_smallest_shape_then_nearest_point():
    _, _, by = built()
    assert (by["w10"]["area"], by["w10"]["area_how"]) == ("Small Bit", "inside")
    assert (by["w11"]["area"], by["w11"]["area_how"]) == ("Test Island EN", "inside")  # English name preferred
    assert (by["w14"]["area"], by["w14"]["area_how"]) == ("Point Suburb", "nearest")


def test_distances_use_nearest_mapped_point():
    _, _, by = built()
    near = by["w10"]["near"]
    assert near["mall"]["name"] == "Mall One" and near["mall"]["m"] < 150
    # the beach strip runs right past the building: measured to its outline, not just its corners
    assert near["beach"]["m"] < 300
    assert 200 < by["w14"]["near"]["school"]["m"] < 260  # 150 m east, 167 m north
    assert all(m["m"] % 10 == 0 for b in by.values() for m in b["near"].values())


def test_heights_are_real_or_flagged():
    _, shapes, _ = built()
    props = {f["properties"]["sid"]: f["properties"] for f in shapes["features"]}
    assert props["w10"]["h"] == 64 and "h_shown" not in props["w10"]
    assert props["w11"]["h_shown"] == 1


def test_counts_and_empty_build():
    doc, _, _ = built()
    assert doc["counts"]["buildings"] == 4 and doc["counts"]["pois"] == {"mall": 1, "beach": 1, "school": 1}
    empty, shapes = osm_city.build("abudhabi", {}, {}, {}, error="offline")
    assert empty["buildings"] == [] and shapes["features"] == [] and empty["error"] == "offline"
    assert empty["city"]["currency"] == "AED" and empty["city"]["rent_period"] == "year"


def test_point_grid_finds_far_points():
    g = osm_city.PointGrid([(54.0, 24.0, "a"), (54.3, 24.3, "b")])
    d, p = g.nearest((54.29, 24.29))
    assert p == "b" and d < 2000
    assert osm_city.PointGrid([]).nearest((54, 24)) is None
