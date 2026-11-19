// Abu Dhabi: your own rent listings, saved in this browser, plus OpenStreetMap buildings.
// Pure logic only (no DOM), so it can be tested. Nothing here estimates a number: every rent and size is what you typed.

export const BEDS = [0, 1, 2, 3, 4]; // 0 = studio
export const NEAR_AD = {
  mall: { label: 'Mall', m: 2000 },
  beach: { label: 'Beach', m: 2000 },
  school: { label: 'School', m: 1500 },
};
export const DEFAULT_AD = { beds: [], minRent: null, maxRent: null, minSqft: 0, near: [], area: '' };

export const bedsLabel = (n) => (n === 0 ? 'Studio' : `${n} bedroom${n > 1 ? 's' : ''}`);
export const bedsShort = (n) => (n === 0 ? 'Studio' : `${n} BR`);

// Exact amount, as typed: AED 85,500.
export function formatAED(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return `AED ${Math.round(v).toLocaleString('en-US')}`;
}
// Short form for slider ends and map pins: AED 85.5k, AED 1.2M.
export function shortAED(v) {
  if (v == null || !Number.isFinite(v)) return '';
  if (v >= 1e6) return `AED ${(v / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (v >= 1000) return `AED ${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `AED ${Math.round(v)}`;
}

// "85,000", "AED 85000", "85k" -> 85000. Anything else -> null.
export function parseAmount(text) {
  const t = String(text ?? '').toLowerCase().replace(/aed|dhs?|,|\s/g, '');
  const m = t.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1));
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Which site a pasted link is from, and an area name if the link's own words mention one we know.
// We never open the link: Bayut and Property Finder pages are not fetched by this site.
export function readListingLink(url, areaNames = []) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return { ok: false, site: null, area: null }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, site: null, area: null };
  const host = u.hostname.replace(/^www\./, '');
  const site = /(^|\.)bayut\.com$/.test(host) ? 'Bayut' : /(^|\.)propertyfinder\.ae$/.test(host) ? 'Property Finder' : null;
  const words = ` ${norm(decodeURIComponent(u.pathname))} `;
  let area = null;
  for (const a of areaNames) {
    const n = norm(a);
    if (n.length > 2 && words.includes(` ${n} `) && (!area || n.length > norm(area).length)) area = a;
  }
  return { ok: true, site, area, href: u.href };
}

// Checks a listing before saving. Returns a list of plain-English problems (empty = fine).
export function listingProblems(l) {
  const out = [];
  if (l.url && !readListingLink(l.url).ok) out.push('The link does not look like a web address (it should start with https://).');
  if (!(l.rent > 0)) out.push('Type the yearly rent in AED, for example 85000.');
  else if (l.rent < 12000) out.push('That looks like a monthly rent. Type the rent per year (monthly x 12), for example 85000.');
  else if (l.rent > 5e6) out.push('That yearly rent looks too high. Type the full amount per year in AED, for example 85000.');
  if (!BEDS.includes(l.beds)) out.push('Choose studio or 1 to 4 bedrooms.');
  if (l.sqft != null && !(l.sqft >= 100 && l.sqft <= 20000)) out.push('Size should be in square feet, for example 1200.');
  if (!(Number.isFinite(l.lng) && Number.isFinite(l.lat))) out.push('Choose where it is on the map.');
  return out;
}

// Straight-line metres between [lng, lat] points (good to a few metres at city scale).
export function metresBetween(a, b) {
  const k = Math.PI / 180, lat = ((a[1] + b[1]) / 2) * k;
  return Math.hypot((a[0] - b[0]) * k * Math.cos(lat), (a[1] - b[1]) * k) * 6371000;
}

function toSegment(p, a, b) {
  const k = Math.cos(((p[1] + a[1]) / 2) * Math.PI / 180);
  const [ax, ay, bx, by, px, py] = [a[0] * k, a[1], b[0] * k, b[1], p[0] * k, p[1]];
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return metresBetween(p, [(ax + t * dx) / k, ay + t * dy]);
}

// Nearest mapped mall, beach or school: distance to its outline (a beach is a long strip), rounded to 10 m.
export function nearestPoi(pt, pois, kind) {
  let best = null;
  for (const p of pois) {
    if (p.k !== kind) continue;
    for (const line of p.lines || [[[p.lng, p.lat]]]) {
      for (let i = 0; i < line.length; i++) {
        const d = line.length === 1 ? metresBetween(pt, line[0]) : i ? toSegment(pt, line[i - 1], line[i]) : Infinity;
        if (!best || d < best.m) best = { m: d, name: p.name || null };
      }
    }
  }
  return best && { m: Math.round(best.m / 10) * 10, name: best.name };
}

export function nearAll(pt, pois) {
  const out = {};
  for (const k of Object.keys(NEAR_AD)) { const n = nearestPoi(pt, pois, k); if (n) out[k] = n; }
  return out;
}

// Closest named area to a point (for listings placed away from a mapped building).
export function nearestArea(pt, areas, maxM = 2500) {
  let best = null;
  for (const a of areas) { const d = metresBetween(pt, [a.lng, a.lat]); if (d <= maxM && (!best || d < best.d)) best = { d, name: a.name }; }
  return best?.name ?? null;
}

function placePasses(place, c) {
  if (c.area && place.area !== c.area) return false;
  return c.near.every((k) => (place.near?.[k]?.m ?? Infinity) <= NEAR_AD[k].m);
}

// One listing: 'match' passes everything, 'unknown' when a filter needs a size you did not type, 'no' otherwise.
export function listingState(l, c) {
  if (!placePasses(l, c)) return 'no';
  if (c.beds.length && !c.beds.includes(l.beds)) return 'no';
  if (c.maxRent && l.rent > c.maxRent) return 'no';
  if (c.minRent && l.rent < c.minRent) return 'no';
  if (c.minSqft > 0) {
    if (l.sqft == null) return 'unknown';
    if (l.sqft < c.minSqft) return 'no';
  }
  return 'match';
}

// A building lights up when one of your listings in it matches. With no listing yet it stays a faint outline
// ("not checked yet") if its area and distances pass, and goes dark if they do not.
export function buildingState(b, listingsHere, c) {
  if (listingsHere.length) {
    const st = listingsHere.map((l) => listingState(l, c));
    return st.includes('match') ? 'match' : st.includes('unknown') ? 'likely' : 'no';
  }
  return placePasses(b, c) ? 'unknown' : 'no';
}

export function listingsCsv(listings) {
  const cols = ['added', 'site', 'link', 'rent_aed_per_year', 'bedrooms', 'size_sqft', 'building', 'area', 'lat', 'lng', 'note'];
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = listings.map((l) => [l.added, l.site, l.url, l.rent, l.beds === 0 ? 'studio' : l.beds, l.sqft, l.building, l.area, l.lat, l.lng, l.note].map(q).join(','));
  return [cols.join(','), ...rows].join('\n');
}
