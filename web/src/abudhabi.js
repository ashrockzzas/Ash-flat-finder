// Abu Dhabi page: OpenStreetMap residential buildings plus the rent listings you add yourself.
// No portal is crawled for this city. Rents and sizes are only what you typed; distances are measured from OSM.
import './style.css';
import maplibregl from 'maplibre-gl';
import { addBaseLayers, addSocietyLayers, BASE_MODES, createMap, OVERVIEW, setBaseMode, setSelected, setStates } from './map.js';
import { BEDS, DEFAULT_AD, NEAR_AD, bedsLabel, bedsShort, buildingState, formatAED, listingProblems, listingState, listingsCsv, nearAll, nearestArea, parseAmount, readListingLink, shortAED } from './listings.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BASE = import.meta.env.BASE_URL;
const CITY = 'abudhabi';
const KEY = `ff-${CITY}-listings`;
const mobile = matchMedia('(max-width: 700px)').matches;
const params = new URLSearchParams(location.search);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const metres = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
const ORDER = { match: 0, likely: 1, unknown: 2, no: 3 };

let data, byId, map, crit = structuredClone(DEFAULT_AD), listings = store.get(KEY, []), states = new Map(), selected = null, is3d = false, youMarker = null;
let baseMode = BASE_MODES.includes(params.get('map')) ? params.get('map') : 'streets';
let draft = null, picking = false;

async function boot() {
  const empty = { city: { name: 'Abu Dhabi', center: [54.47, 24.45], zoom: 11 }, counts: { buildings: 0, pois: {} }, areas: [], pois: [], buildings: [], error: 'The Abu Dhabi data file is missing.' };
  const [cities, city, shapes] = await Promise.all([
    fetch(`${BASE}data/cities.json`).then((r) => r.json()).catch(() => ({ [CITY]: { name: 'Abu Dhabi', app: CITY } })),
    fetch(`${BASE}data/${CITY}.json`).then((r) => r.json()).catch(() => empty),
    fetch(`${BASE}data/${CITY}-shapes.geojson`).then((r) => r.json()).catch(() => ({ type: 'FeatureCollection', features: [] })),
  ]);
  data = city;
  byId = new Map(city.buildings.map((b) => [b.id, b]));
  OVERVIEW.center = city.city.center;
  OVERVIEW.zoom = city.city.zoom || 11;
  OVERVIEW.pitch = 0;

  $('city-pick').replaceChildren(...Object.entries(cities).map(([id, c]) => new Option(c.name, id, false, id === CITY)));
  $('city-pick').onchange = () => { const id = $('city-pick').value; location.href = cities[id]?.app ? `${BASE}${cities[id].app}.html` : `${BASE}?city=${id}`; };
  const c = city.counts, p = c.pois || {};
  $('note').textContent = city.error || `${c.buildings.toLocaleString()} residential buildings · ${p.mall || 0} malls, ${p.beach || 0} beaches, ${p.school || 0} schools · from OpenStreetMap`;
  $('about').innerHTML = `Buildings, areas, malls, beaches and schools come from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors${city.source?.built ? ` (built ${esc(city.source.built)})` : ''}. Distances are straight lines to the nearest mapped edge. Rents and sizes are only the ones you typed in: nothing is estimated. Building heights are drawn from OSM where mapped and are otherwise a flat default, for looks only.`;

  buildFilters();
  buildAdd();
  buildSearch();
  buildControls();
  buildMobile();
  try { map = createMap('map', { mobile }); window.__map = map; } catch {
    $('note').textContent = 'Your browser could not start the 3D map. Your listings still work.';
    apply();
    return;
  }
  const points = { type: 'FeatureCollection', features: city.buildings.map((b) => ({ type: 'Feature', properties: { sid: b.id, name: b.name || '', show: b.name ? 1 : 0 }, geometry: { type: 'Point', coordinates: [b.lng, b.lat] } })) };
  map.once('style.load', () => {
    addSocietyLayers(map, shapes, points);
    addBaseLayers(map);
    addListingLayers();
    setBase(baseMode);
    map.jumpTo(OVERVIEW);
    for (const l of ['bld', 'glow']) {
      map.on('click', l, (e) => { if (!picking && !map.queryRenderedFeatures(e.point, { layers: ['mine-dot'] }).length) openBuilding(e.features[0].properties.sid); });
      map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
    }
    map.on('click', 'mine-dot', (e) => { if (!picking) { e.preventDefault(); openListing(e.features[0].properties.lid); } });
    map.on('click', onPick);
    apply();
    if (!listings.length && !store.get('ff-ad-welcomed', false)) { toast('Tap "+ Add a listing" to put your first flat on the map.'); store.set('ff-ad-welcomed', true); }
  });
}

// ---------- your listings on the map ----------
const PIN = { match: '#ffd9a0', likely: '#c99a5c', unknown: '#c99a5c', no: '#55545c' };
function addListingLayers() {
  map.addSource('mine', { type: 'geojson', data: listingFeatures() });
  map.addLayer({ id: 'mine-dot', type: 'circle', source: 'mine', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 5, 15, 9], 'circle-color': ['match', ['get', 'st'], 'match', PIN.match, 'no', PIN.no, PIN.likely],
    'circle-stroke-color': '#111', 'circle-stroke-width': 2, 'circle-opacity': ['match', ['get', 'st'], 'no', 0.5, 1] } });
  map.addLayer({ id: 'mine-label', type: 'symbol', source: 'mine', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, -1.5], 'text-allow-overlap': false },
    paint: { 'text-color': '#fff', 'text-halo-color': 'rgba(0,0,0,.9)', 'text-halo-width': 1.5, 'text-opacity': ['match', ['get', 'st'], 'no', 0.4, 1] } });
}
function listingFeatures() {
  return { type: 'FeatureCollection', features: listings.map((l) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [l.lng, l.lat] },
    properties: { lid: l.id, st: listingState(l, crit), label: `${bedsShort(l.beds)} · ${shortAED(l.rent)}/yr` } })) };
}

function save() {
  if (!store.set(KEY, listings)) toast('This browser would not save. Download a backup so you do not lose them.');
  apply();
}

// ---------- filters and results ----------
function chip(label, on, onClick, cls = 'chip') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls + (on ? ' on' : '');
  b.innerHTML = label;
  b.onclick = onClick;
  return b;
}
const toggle = (arr, v) => { const i = arr.indexOf(v); i >= 0 ? arr.splice(i, 1) : arr.push(v); };

function buildFilters() {
  const redraw = () => {
    $('f-beds').replaceChildren(...BEDS.map((n) => chip(n === 0 ? 'Studio' : String(n), crit.beds.includes(n), () => { toggle(crit.beds, n); redraw(); apply(); })));
    $('f-near').replaceChildren(...Object.entries(NEAR_AD).map(([k, n]) => chip(`${n.label} <small>${metres(n.m)}</small>`, crit.near.includes(k), () => { toggle(crit.near, k); redraw(); apply(); })));
    $('v-rent').textContent = crit.maxRent ? `${formatAED(crit.maxRent)} a year` : 'Any';
    $('v-size').textContent = crit.minSqft ? `${crit.minSqft.toLocaleString()} sq ft` : 'Any';
  };
  $('f-rent').oninput = () => { const v = +$('f-rent').value; crit.maxRent = v >= 500000 ? null : v; redraw(); apply(); };
  $('f-size').oninput = () => { crit.minSqft = +$('f-size').value; redraw(); apply(); };
  const names = [...new Set([...data.areas.map((a) => a.name), ...data.buildings.map((b) => b.area).filter(Boolean)])].sort();
  $('f-area').append(...names.map((n) => new Option(n, n)));
  $('f-area').onchange = () => { crit.area = $('f-area').value; apply(); };
  $('dl-csv').onclick = () => download(`${CITY}-my-listings.csv`, listingsCsv(listings), 'text/csv');
  $('dl-backup').onclick = () => download(`${CITY}-my-listings-backup.json`, JSON.stringify({ city: CITY, listings }, null, 1), 'application/json');
  $('restore-file').onchange = async (e) => {
    try {
      const got = JSON.parse(await e.target.files[0].text());
      const incoming = (Array.isArray(got) ? got : got.listings || []).filter((l) => l && l.id && !listingProblems(l).length);
      const have = new Set(listings.map((l) => l.id));
      const added = incoming.filter((l) => !have.has(l.id));
      listings.push(...added);
      save();
      toast(`Added ${added.length} listing${added.length === 1 ? '' : 's'} from the backup.`);
    } catch { toast('That file is not a Flat Finder backup.'); }
    e.target.value = '';
  };
  redraw();
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function apply() {
  const here = new Map();
  for (const l of listings) if (l.bid) (here.get(l.bid) || here.set(l.bid, []).get(l.bid)).push(l);
  const next = new Map(data.buildings.map((b) => [b.id, buildingState(b, here.get(b.id) || [], crit)]));
  if (map?.getSource?.('shapes')) setStates(map, [...next].filter(([id, st]) => states.get(id) !== st));
  states = next;
  map?.getSource?.('mine')?.setData(listingFeatures());
  renderResults();
  if (selected?.kind === 'b') openBuilding(selected.id, { fly: false, refresh: true });
  if (selected?.kind === 'l') openListing(selected.id, { fly: false, refresh: true });
}

function renderResults() {
  const ranked = listings.map((l) => ({ l, st: listingState(l, crit) })).sort((a, b) => ORDER[a.st] - ORDER[b.st] || a.l.rent - b.l.rent);
  const n = ranked.filter((r) => r.st === 'match').length, unk = ranked.filter((r) => r.st === 'unknown').length;
  $('count').textContent = n;
  $('count-sub').textContent = listings.length ? [`of ${listings.length} saved`, unk && `${unk} need a size to check`].filter(Boolean).join(' · ') : 'Add a listing to start';
  $('v-list').textContent = listings.length ? `${listings.length} saved` : 'none yet';
  const ol = document.createElement('ol');
  ol.className = 'results';
  ol.replaceChildren(...ranked.map(({ l, st }) => {
    const li = document.createElement('li');
    const where = [l.building || l.note, l.area].filter(Boolean).join(' · ');
    li.innerHTML = `<span class="nm">${esc(bedsLabel(l.beds))}${l.sqft ? `, ${l.sqft.toLocaleString()} sq ft` : ''}<small>${esc(where || 'Pinned on the map')}${l.site ? ` · ${esc(l.site)}` : ''}</small></span>
      <span class="tag ${st === 'match' ? 'match' : ''}">${esc(formatAED(l.rent))}<small>a year${st === 'unknown' ? ' · size?' : st === 'no' ? ' · filtered out' : ''}</small></span>`;
    li.onclick = () => openListing(l.id);
    return li;
  }));
  $('results').replaceChildren(ol);
}

// ---------- cards ----------
function nearRows(near) {
  return `<div class="near">${Object.entries(NEAR_AD).map(([k, n]) => {
    const v = near?.[k];
    return `<div><span>${n.label}</span><b>${v ? metres(v.m) : '—'}</b><small>${v ? esc(v.name || `unnamed ${n.label.toLowerCase()}`) : 'none mapped nearby'}</small></div>`;
  }).join('')}</div>`;
}

function showCard(html, { refresh = false } = {}) {
  $('card').innerHTML = html;
  $('card').hidden = false;
  document.body.classList.add('has-card');
  if (mobile && !refresh) showMobile('society');
  $('c-close').onclick = closeCard;
}

function flyTo(lng, lat) {
  map?.flyTo({ center: [lng, lat], zoom: mobile ? 15.4 : 16.2, pitch: is3d ? 55 : 0, bearing: 0, duration: 2000, essential: true, offset: mobile ? [0, -80] : [-180, 0] });
}

function openBuilding(id, { fly = true, refresh = false } = {}) {
  const b = byId.get(id);
  if (!b) return;
  if (map) setSelected(map, id, selected?.kind === 'b' ? selected.id : null);
  selected = { kind: 'b', id };
  if (fly) flyTo(b.lng, b.lat);
  const mine = listings.filter((l) => l.bid === id);
  const st = states.get(id);
  const where = b.area ? `${b.area_how === 'nearest' ? 'Near' : 'In'} ${esc(b.area)}` : 'Area not named in OpenStreetMap';
  const facts = [b.compound && esc(b.compound), b.levels && `${esc(b.levels)} floors`, b.street && esc(b.street)].filter(Boolean).join(' · ');
  showCard(`<div class="card-head"><div><h2>${esc(b.name || 'Unnamed building')}</h2><div class="meta">${where}${facts ? ` · ${facts}` : ''}</div></div><button class="iconbtn" id="c-close" aria-label="Close">×</button></div>
    <div><span class="badge ${st}">${{ match: 'A listing here matches', likely: 'Listing here, size unknown', unknown: mine.length ? '' : 'No listing saved here', no: mine.length ? 'Your listings here do not match' : 'Outside your filters' }[st] || ''}</span></div>
    <h4>Nearby</h4>${nearRows(b.near)}
    <h4>Your listings here</h4>
    ${mine.length ? `<table>${mine.map((l) => `<tr><td>${esc(bedsLabel(l.beds))}${l.sqft ? `<div class="fine">${l.sqft.toLocaleString()} sq ft</div>` : ''}</td><td><b>${esc(formatAED(l.rent))}</b><div class="fine">a year</div></td><td><button class="linkbtn" data-open="${esc(l.id)}">Open</button></td></tr>`).join('')}</table>` : '<p class="fine">None yet.</p>'}
    <div class="links"><button class="btnlink" id="c-add">+ Add a listing here</button>
      <a href="https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lng}" target="_blank" rel="noopener">Google Maps</a>
      <a href="https://www.openstreetmap.org/${esc(b.osm)}" target="_blank" rel="noopener">OpenStreetMap</a></div>`, { refresh });
  $('c-add').onclick = () => openAdd({ lng: b.lng, lat: b.lat, bid: b.id, building: b.name || null, area: b.area || null, near: b.near || {} });
  document.querySelectorAll('#card [data-open]').forEach((x) => (x.onclick = () => openListing(x.dataset.open)));
}

function openListing(id, { fly = true, refresh = false } = {}) {
  const l = listings.find((x) => x.id === id);
  if (!l) return;
  if (map) setSelected(map, l.bid || null, selected?.kind === 'b' ? selected.id : null);
  selected = { kind: 'l', id };
  if (fly) flyTo(l.lng, l.lat);
  const st = listingState(l, crit);
  const link = l.url && readListingLink(l.url).ok ? `<a class="btnlink" href="${esc(readListingLink(l.url).href)}" target="_blank" rel="noopener">Open on ${esc(l.site || 'the website')}</a>` : '';
  showCard(`<div class="card-head"><div><h2>${esc(bedsLabel(l.beds))} · ${esc(formatAED(l.rent))} a year</h2><div class="meta">${esc([l.building, l.area].filter(Boolean).join(' · ') || 'Pinned on the map')}${l.sqft ? ` · ${l.sqft.toLocaleString()} sq ft` : ''}</div></div><button class="iconbtn" id="c-close" aria-label="Close">×</button></div>
    <div><span class="badge ${st}">${{ match: 'Matches your search', unknown: 'Add a size to check it', no: 'Does not match your filters' }[st]}</span></div>
    ${l.note ? `<p>${esc(l.note)}</p>` : ''}
    <h4>Nearby</h4>${nearRows(l.near)}
    <p class="fine">Typed in by you on ${esc((l.added || '').slice(0, 10))}. Monthly equivalent is not shown: Abu Dhabi rents are quoted per year.</p>
    <div class="links">${link}<button class="btnlink" id="c-edit">Edit</button>${l.bid ? '<button class="linkbtn" id="c-bld">See the building</button>' : ''}
      <a href="https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lng}" target="_blank" rel="noopener">Google Maps</a></div>`, { refresh });
  $('c-edit').onclick = () => openAdd(l);
  $('c-bld')?.addEventListener('click', () => openBuilding(l.bid));
}

function closeCard() {
  $('card').hidden = true;
  document.body.classList.remove('has-card');
  if (mobile) showMobile('search');
  if (map && selected?.kind === 'b') setSelected(map, null, selected.id);
  selected = null;
}

// ---------- add or edit a listing ----------
function buildAdd() {
  const areaNames = [...new Set([...data.areas.map((a) => a.name), ...data.buildings.map((b) => b.area).filter(Boolean)])];
  $('btn-add').onclick = () => openAdd(null);
  $('a-cancel').onclick = () => { $('add').hidden = true; draft = null; };
  $('pick-cancel').onclick = () => { picking = false; $('picking').hidden = true; $('add').hidden = false; };
  $('a-pick').onclick = () => {
    readForm();
    picking = true;
    $('add').hidden = true;
    $('picking').hidden = false;
    if (mobile) document.body.classList.add('m-collapsed');
  };
  $('a-url').oninput = () => {
    const v = $('a-url').value.trim();
    const r = v ? readListingLink(v, areaNames) : null;
    $('a-url-hint').textContent = !r ? '' : !r.ok ? 'That does not look like a web link.' : [r.site ? `${r.site} link.` : 'Not a Bayut or Property Finder link, saved anyway.', r.area && `The link mentions ${r.area}.`].filter(Boolean).join(' ');
  };
  $('a-delete').onclick = () => {
    if (!confirm('Delete this listing?')) return;
    listings = listings.filter((l) => l.id !== draft.id);
    $('add').hidden = true;
    draft = null;
    closeCard();
    save();
  };
  $('add-form').onsubmit = (e) => {
    e.preventDefault();
    readForm();
    const probs = listingProblems(draft);
    $('a-problems').innerHTML = probs.map(esc).join('<br>');
    if (probs.length) return;
    const r = draft.url ? readListingLink(draft.url) : null;
    const clean = { ...draft, url: r?.href || '', site: r?.site || null, added: draft.added || new Date().toISOString() };
    const i = listings.findIndex((l) => l.id === clean.id);
    i >= 0 ? (listings[i] = clean) : listings.push(clean);
    $('add').hidden = true;
    draft = null;
    save();
    openListing(clean.id);
    toast('Saved in this browser.');
  };
}

function readForm() {
  draft.url = $('a-url').value.trim();
  draft.rent = parseAmount($('a-rent').value);
  const sq = $('a-sqft').value.trim();
  draft.sqft = sq ? parseAmount(sq) : null;
  draft.note = $('a-note').value.trim() || null;
}

function openAdd(from) {
  const editing = from && from.id;
  draft = editing ? { ...from } : { id: `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, beds: null, ...(from || {}) };
  $('add-title').textContent = editing ? 'Edit listing' : 'Add a listing';
  $('a-url').value = draft.url || '';
  $('a-url').oninput();
  $('a-rent').value = draft.rent ? String(draft.rent) : '';
  $('a-sqft').value = draft.sqft ? String(draft.sqft) : '';
  $('a-note').value = draft.note || '';
  $('a-problems').textContent = '';
  $('a-delete').hidden = !editing;
  drawForm();
  $('add').hidden = false;
}

function drawForm() {
  $('a-beds').replaceChildren(...BEDS.map((n) => chip(n === 0 ? 'Studio' : String(n), draft.beds === n, () => { draft.beds = n; drawForm(); })));
  $('a-where').textContent = Number.isFinite(draft.lng)
    ? draft.bid ? `In ${draft.building || 'a mapped building'}${draft.area ? `, ${draft.area}` : ''}` : `Pinned${draft.area ? ` near ${draft.area}` : ''}`
    : 'Not chosen yet';
  $('a-pick').textContent = Number.isFinite(draft.lng) ? 'Change' : 'Choose on map';
}

function onPick(e) {
  if (!picking) return;
  picking = false;
  $('picking').hidden = true;
  document.body.classList.remove('m-collapsed');
  const hit = map.queryRenderedFeatures(e.point, { layers: ['bld', 'glow'] })[0];
  const b = hit && byId.get(hit.properties.sid);
  if (b) Object.assign(draft, { lng: b.lng, lat: b.lat, bid: b.id, building: b.name || null, area: b.area || null, near: b.near || {} });
  else {
    const pt = [+e.lngLat.lng.toFixed(5), +e.lngLat.lat.toFixed(5)];
    Object.assign(draft, { lng: pt[0], lat: pt[1], bid: null, building: null, area: nearestArea(pt, data.areas), near: nearAll(pt, data.pois) });
  }
  drawForm();
  $('add').hidden = false;
}

// ---------- search buildings and areas ----------
function buildSearch() {
  const input = $('q'), out = $('q-results');
  const norm = (s) => (s || '').toLowerCase();
  input.oninput = () => {
    const q = norm(input.value).trim();
    if (!q) { out.hidden = true; return; }
    const areas = data.areas.filter((a) => norm(a.name).includes(q)).slice(0, 4).map((a) => ({ label: a.name, sub: 'area', go: () => map?.flyTo({ center: [a.lng, a.lat], zoom: 14, duration: 1800 }) }));
    const blds = data.buildings.filter((b) => b.name && `${norm(b.name)} ${norm(b.compound)}`.includes(q)).slice(0, 8).map((b) => ({ label: b.name, sub: b.area || 'building', go: () => openBuilding(b.id) }));
    const items = [...areas, ...blds];
    out.replaceChildren(...(items.length ? items : [{ label: 'No building or area by that name in OpenStreetMap', empty: true }]).map((it) => {
      const li = document.createElement('li');
      li.className = it.empty ? 'empty' : '';
      li.innerHTML = `<span>${esc(it.label)}</span>${it.sub ? `<span class="tag">${esc(it.sub)}</span>` : ''}`;
      if (it.go) li.onclick = () => { out.hidden = true; input.value = ''; it.go(); };
      return li;
    }));
    out.hidden = false;
  };
}

// ---------- map buttons, theme, phone tabs ----------
function setBase(mode) {
  baseMode = mode;
  document.body.dataset.base = mode;
  if (map?.getLayer?.('st-bg')) setBaseMode(map, mode);
  document.querySelectorAll('#layers button[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('btn-theme').textContent = mode === 'light' ? 'Dark' : 'Light';
}

function buildControls() {
  $('ctl-in').onclick = () => map?.zoomIn();
  $('ctl-out').onclick = () => map?.zoomOut();
  $('ctl-tilt').textContent = is3d ? '2D' : '3D';
  $('ctl-tilt').onclick = () => { is3d = !is3d; $('ctl-tilt').textContent = is3d ? '2D' : '3D'; map?.easeTo({ pitch: is3d ? 50 : 0, bearing: 0, duration: 800 }); };
  $('ctl-home').onclick = () => { closeCard(); map?.flyTo({ ...OVERVIEW, pitch: is3d ? 50 : 0, duration: 2000 }); };
  $('ctl-locate').onclick = () => {
    if (!navigator.geolocation) return;
    $('ctl-locate').classList.add('busy');
    navigator.geolocation.getCurrentPosition((p) => {
      $('ctl-locate').classList.remove('busy');
      const at = [p.coords.longitude, p.coords.latitude];
      if (!youMarker) { const el = document.createElement('div'); el.className = 'you'; youMarker = new maplibregl.Marker({ element: el }); }
      youMarker.setLngLat(at).addTo(map);
      map.flyTo({ center: at, zoom: 15, bearing: 0, duration: 2000 });
    }, () => { $('ctl-locate').classList.remove('busy'); toast('Could not get your location.'); }, { enableHighAccuracy: true, timeout: 10000 });
  };
  $('layers-btn').onclick = () => $('layers').classList.toggle('open');
  document.querySelectorAll('#layers button[data-mode]').forEach((b) => (b.onclick = () => { setBase(b.dataset.mode); $('layers').classList.remove('open'); }));
  $('btn-theme').onclick = () => setBase(baseMode === 'light' ? 'streets' : 'light');
  setBase(baseMode);
}

function showMobile(tab) {
  document.body.classList.toggle('m-society', tab === 'society');
  document.body.classList.remove('m-collapsed');
  document.querySelectorAll('#mtabs [data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
  $('mt-society').disabled = !selected && tab !== 'society';
}

function buildMobile() {
  document.querySelectorAll('#mtabs [data-t]').forEach((b) => (b.onclick = () => showMobile(b.dataset.t)));
  const collapse = () => {
    const c = document.body.classList.toggle('m-collapsed');
    $('m-collapse').textContent = c ? '⌃' : '⌄';
    $('btn-mhide').textContent = c ? 'Show panel' : 'Hide panel';
  };
  $('m-collapse').onclick = collapse;
  $('btn-mhide').onclick = collapse;
}

function toast(msg) {
  $('toast').textContent = msg;
  $('toast').hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($('toast').hidden = true), 3200);
}

boot();
