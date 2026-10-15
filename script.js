/* NearbyNow – nearby essentials finder built on OpenStreetMap data.
   Services (all return JSON, no API key):
   - Nominatim, with Photon as backup  -> place name to coordinates
   - Overpass API, with a mirror        -> places around a point */
'use strict';

const DEFAULT_CENTER = [9.8351, 76.3237]; // from the benchmark URL
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const PHOTON = 'https://photon.komoot.io/api/';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const STORAGE_KEY = 'nearbynow:saved';

const CATEGORIES = {
  pharmacy:   { label: 'Pharmacy',  plural: 'pharmacies',       tag: ['amenity', 'pharmacy'] },
  hospital:   { label: 'Hospital',  plural: 'hospitals',        tag: ['amenity', 'hospital'] },
  clinic:     { label: 'Clinic',    plural: 'clinics',          tag: ['amenity', 'clinic'] },
  atm:        { label: 'ATM',       plural: 'ATMs',             tag: ['amenity', 'atm'] },
  fuel:       { label: 'Fuel',      plural: 'fuel stations',    tag: ['amenity', 'fuel'] },
  bus_stop:   { label: 'Bus stop',  plural: 'bus stops',        tag: ['highway', 'bus_stop'] },
  police:     { label: 'Police',    plural: 'police stations',  tag: ['amenity', 'police'] },
  restaurant: { label: 'Food',      plural: 'restaurants',      tag: ['amenity', 'restaurant'] }
};

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  form: $('searchForm'), location: $('location'), locationMsg: $('locationMsg'),
  chips: $('chips'), categoryMsg: $('categoryMsg'),
  radius: $('radius'), radiusLabel: $('radiusLabel'), walkHint: $('walkHint'),
  submit: $('submitBtn'), geo: $('geoBtn'),
  list: $('listArea'), toolbar: $('toolbar'), summary: $('summary'),
  sortBy: $('sortBy'), onlyDetails: $('onlyDetails'),
  tabResults: $('tabResults'), tabSaved: $('tabSaved'),
  resultCount: $('resultCount'), savedCount: $('savedCount'),
  offline: $('offlineBanner'), fileBanner: $('fileBanner'), toast: $('toast')
};

/* ---------- State ---------- */
const state = {
  origin: null,        // { lat, lon, label }
  useGps: false,
  category: '',
  results: [],
  saved: loadSaved(),
  activeId: null,
  tab: 'results',
  markers: new Map(),
  searchId: 0,
  sample: false,
  lastRadius: 2000
};

/* ---------- Small helpers ---------- */
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch (e) { return []; }
}
function persistSaved() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.saved)); } catch (e) { /* storage blocked */ }
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const walkMin = (m) => Math.max(1, Math.round(m / 80)); // about 4.8 km/h
const shortLabel = (label) => String(label || '').split(',').slice(0, 2).join(',').trim();

let toastTimer;
function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 4000);
}
function setMsg(node, text, ok) {
  node.textContent = text;
  node.className = 'text-xs mt-1 min-h-[1rem] ' + (text ? (ok ? 'text-lagoon-600' : 'text-chilli-600') : '');
}
function markInvalid(input, bad) {
  input.classList.toggle('border-chilli-500', bad);
  input.classList.toggle('border-coir-300', !bad);
  input.setAttribute('aria-invalid', String(bad));
}

/* ---------- Map and base layers ---------- */
const map = L.map('map').setView(DEFAULT_CENTER, 12);

const baseLayers = {
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
  }),
  'Esri Streets': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri, data &copy; OpenStreetMap contributors and others'
  }),
  'Carto Light': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19, attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  })
};
// Opened as a file: OpenStreetMap tiles are refused without a web address, so start with Esri.
const openedAsFile = location.protocol === 'file:';
const defaultBase = openedAsFile ? 'Esri Streets' : 'OpenStreetMap';
baseLayers[defaultBase].addTo(map);
L.control.layers(baseLayers, null, { position: 'topright', collapsed: true }).addTo(map);

// If the default layer fails to load tiles repeatedly, switch to the backup automatically.
let tileFailures = 0;
baseLayers['OpenStreetMap'].on('tileerror', () => {
  tileFailures += 1;
  if (tileFailures === 5 && map.hasLayer(baseLayers['OpenStreetMap'])) {
    map.removeLayer(baseLayers['OpenStreetMap']);
    baseLayers['Esri Streets'].addTo(map);
    showToast('Switched to a backup map style.');
  }
});

const markerLayer = L.layerGroup().addTo(map);
let originMarker = null, radiusCircle = null;

const pinIcon = (cls) => L.divIcon({
  className: '', html: `<div class="pin ${cls || ''}"></div>`,
  iconSize: [22, 22], iconAnchor: [11, 22], popupAnchor: [0, -20]
});

/* ---------- Validation ---------- */
function validate() {
  let valid = true;
  const place = el.location.value.trim();

  if (!state.useGps) {
    if (place.length < 3) {
      setMsg(el.locationMsg, 'Enter at least 3 characters, such as a town or landmark.'); markInvalid(el.location, true); valid = false;
    } else if (!/[A-Za-z\u00C0-\u024F\u0D00-\u0D7F\u0900-\u097F]/.test(place)) {
      setMsg(el.locationMsg, 'Use letters in the place name, not only numbers.'); markInvalid(el.location, true); valid = false;
    } else {
      setMsg(el.locationMsg, ''); markInvalid(el.location, false);
    }
  }
  if (!state.category) {
    setMsg(el.categoryMsg, 'Pick one category to search for.'); valid = false;
  } else {
    setMsg(el.categoryMsg, '');
  }
  const r = Number(el.radius.value);
  if (!(r >= 250 && r <= 5000)) valid = false;
  return valid;
}

/* ---------- Fetch helpers (JSON) ---------- */
async function fetchJSON(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    if (!res.ok) throw new Error('HTTP_' + res.status);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('TIMEOUT');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function geocode(query) {
  let reached = false, lastErr = null;

  try {
    const d = await fetchJSON(`${NOMINATIM}?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(query)}`);
    reached = true;
    if (Array.isArray(d) && d.length) {
      return { lat: parseFloat(d[0].lat), lon: parseFloat(d[0].lon), label: d[0].display_name };
    }
  } catch (e) { lastErr = e; }

  try {
    const d = await fetchJSON(`${PHOTON}?limit=1&lat=${DEFAULT_CENTER[0]}&lon=${DEFAULT_CENTER[1]}&q=${encodeURIComponent(query)}`);
    reached = true;
    const f = d && d.features && d.features[0];
    if (f) {
      const p = f.properties || {};
      return {
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
        label: [p.name, p.city || p.county, p.state].filter(Boolean).join(', ') || query
      };
    }
  } catch (e) { lastErr = e; }

  if (reached) throw new Error('NOT_FOUND');
  throw lastErr || new Error('NETWORK');
}

async function searchPlaces(origin, category, radius) {
  const [k, v] = CATEGORIES[category].tag;
  const query = `[out:json][timeout:25];nwr["${k}"="${v}"](around:${radius},${origin.lat},${origin.lon});out center tags 100;`;
  let lastErr = null;

  for (const endpoint of OVERPASS) {
    try {
      const data = await fetchJSON(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
      }, 25000);
      return (data.elements || []).map((e) => {
        const lat = e.lat != null ? e.lat : (e.center && e.center.lat);
        const lon = e.lon != null ? e.lon : (e.center && e.center.lon);
        if (lat == null || lon == null) return null;
        const t = e.tags || {};
        const name = t.name || t['name:en'] || '';
        return {
          id: `${e.type}/${e.id}`,
          name: name || `Unnamed ${CATEGORIES[category].label.toLowerCase()}`,
          unnamed: !name, lat, lon, category,
          phone: t.phone || t['contact:phone'] || '',
          hours: t.opening_hours || '',
          distance: haversine(origin.lat, origin.lon, lat, lon)
        };
      }).filter(Boolean);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('NETWORK');
}

/* ---------- Rendering ---------- */
function skeleton() {
  el.list.innerHTML = Array.from({ length: 4 }, () => '<div class="skeleton h-24 rounded-xl mb-3" aria-hidden="true"></div>').join('') +
    '<p class="sr-only">Loading results</p>';
}

function messageCard(title, body, actions) {
  const buttons = (actions || []).map((a) =>
    `<button type="button" id="${a.id}" class="m-1 rounded-lg px-4 py-2 text-sm font-semibold ${a.primary ? 'bg-lagoon-600 text-white hover:bg-lagoon-700' : 'border border-coir-300 hover:bg-lagoon-50'}">${esc(a.label)}</button>`).join('');
  el.list.innerHTML = `
    <div class="text-center py-10 px-4">
      <p class="font-display text-lg font-bold">${esc(title)}</p>
      <p class="text-sm text-lagoon-700 mt-1 leading-relaxed">${esc(body)}</p>
      <div class="mt-4">${buttons}</div>
    </div>`;
}

function visibleResults() {
  let rows = state.results.slice();
  if (el.onlyDetails.checked) rows = rows.filter((r) => r.phone || r.hours);
  rows.sort(el.sortBy.value === 'name'
    ? (a, b) => a.name.localeCompare(b.name)
    : (a, b) => a.distance - b.distance);
  return rows;
}

function card(p) {
  const saved = state.saved.some((s) => s.id === p.id);
  const active = p.id === state.activeId;
  const hasD = typeof p.distance === 'number';
  const cat = CATEGORIES[p.category] || { label: '' };
  const dir = state.origin && !p.sample
    ? `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${state.origin.lat},${state.origin.lon};${p.lat},${p.lon}`
    : `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=18/${p.lat}/${p.lon}`;
  const phoneHtml = p.phone
    ? `<a class="underline" href="tel:${esc(p.phone.split(';')[0].replace(/\s/g, ''))}">${esc(p.phone)}</a>`
    : '<span class="text-lagoon-700/60">not mapped</span>';
  const hoursHtml = p.hours ? esc(p.hours) : '<span class="text-lagoon-700/60">not mapped</span>';

  return `
  <article data-id="${esc(p.id)}" tabindex="0" aria-label="${esc(p.name)}, show on map"
    class="result-card cursor-pointer rounded-xl border p-3 mb-3 focus:outline-none focus:ring-2 focus:ring-lagoon-500 ${active ? 'border-chilli-500 bg-chilli-500/5' : 'border-coir-300 bg-white hover:bg-lagoon-50'}">
    <div class="flex gap-3">
      <div class="w-[72px] shrink-0 text-center rounded-lg bg-lagoon-50 py-2 self-start">
        <div class="font-display font-extrabold text-lagoon-700 leading-none">${hasD ? fmtDist(p.distance) : '–'}</div>
        <div class="text-[11px] text-lagoon-700/80 mt-1">${hasD ? walkMin(p.distance) + ' min walk' : ''}</div>
      </div>
      <div class="min-w-0 flex-1">
        <h3 class="font-display font-bold leading-snug ${p.unnamed ? 'italic text-lagoon-700/70' : ''}">${esc(p.name)}</h3>
        <span class="inline-block text-[11px] rounded bg-coir-100 px-1.5 py-0.5 mt-0.5">${esc(cat.label)}</span>
        <dl class="mt-1.5 text-sm space-y-0.5">
          <div><dt class="inline font-semibold">Phone: </dt><dd class="inline">${phoneHtml}</dd></div>
          <div><dt class="inline font-semibold">Hours: </dt><dd class="inline">${hoursHtml}</dd></div>
        </dl>
        <a href="${dir}" target="_blank" rel="noopener" class="inline-block mt-1.5 text-sm font-semibold text-lagoon-600 underline">${state.origin && !p.sample ? 'Walking directions' : 'Open in OpenStreetMap'}</a>
      </div>
      <button type="button" data-save="${esc(p.id)}" aria-pressed="${saved}" aria-label="${saved ? 'Remove from saved' : 'Save place'}"
        class="shrink-0 self-start rounded-full border px-3 py-1 text-xs font-semibold ${saved ? 'bg-paddy-400 border-paddy-400' : 'border-coir-300 hover:bg-coir-100'}">${saved ? 'Saved' : 'Save'}</button>
    </div>
  </article>`;
}

function renderSummary(rows) {
  if (!state.origin || !state.results.length) { el.summary.textContent = ''; return; }
  const cat = CATEGORIES[state.results[0].category] || { plural: 'places' };
  const nearest = state.results.reduce((a, b) => (a.distance <= b.distance ? a : b));
  el.summary.innerHTML = `<strong>${rows.length}</strong> ${esc(cat.plural)} within ${fmtDist(state.lastRadius)} of ${esc(shortLabel(state.origin.label))}. Nearest: <strong>${fmtDist(nearest.distance)}</strong>${state.sample ? ' <span class="text-chilli-600 font-semibold">(sample data)</span>' : ''}`;
}

function renderList() {
  const scrollTop = el.list.scrollTop;
  const showingSaved = state.tab === 'saved';
  el.toolbar.classList.toggle('hidden', showingSaved || state.results.length === 0);
  el.resultCount.textContent = state.results.length;
  el.savedCount.textContent = state.saved.length;

  if (showingSaved) {
    if (!state.saved.length) { messageCard('Nothing saved yet', 'Tap Save on any result to keep it here, even after you close the page.'); return; }
    el.list.innerHTML = state.saved.map((p) => card(Object.assign({}, p, {
      distance: state.origin ? haversine(state.origin.lat, state.origin.lon, p.lat, p.lon) : null
    }))).join('');
    return;
  }
  if (!state.origin) { messageCard('Start with a place', 'Type a town or landmark, choose a category, then press Find places.'); return; }

  const rows = visibleResults();
  renderSummary(rows);
  if (!rows.length) {
    const filtered = state.results.length > 0;
    messageCard(
      filtered ? 'No results match this filter' : 'No places found in this distance',
      filtered ? 'Untick "Only with phone or hours" to see everything.' : 'Try a larger distance or another category. OpenStreetMap only lists places that mappers have added.',
      filtered ? [] : [{ id: 'widenBtn', label: 'Widen to 5 km', primary: true }]);
    return;
  }
  el.list.innerHTML = rows.map(card).join('');
  el.list.scrollTop = scrollTop;
}

function drawMap() {
  markerLayer.clearLayers(); state.markers.clear();
  if (originMarker) { map.removeLayer(originMarker); originMarker = null; }
  if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
  if (!state.origin) return;

  originMarker = L.marker([state.origin.lat, state.origin.lon], { icon: pinIcon('origin') }).addTo(map).bindPopup('Search centre');
  radiusCircle = L.circle([state.origin.lat, state.origin.lon], {
    radius: state.lastRadius, color: '#0d6f67', weight: 1.5, fillOpacity: 0.06
  }).addTo(map);

  state.results.forEach((p) => {
    const m = L.marker([p.lat, p.lon], { icon: pinIcon() }).addTo(markerLayer)
      .bindPopup(`<strong>${esc(p.name)}</strong><br>${fmtDist(p.distance)} away`);
    m.on('click', () => setActive(p.id, false));
    state.markers.set(p.id, m);
  });
  map.fitBounds(radiusCircle.getBounds(), { padding: [20, 20] });
}

function setActive(id, flyTo) {
  state.activeId = id;
  state.markers.forEach((m, key) => m.setIcon(pinIcon(key === id ? 'active' : '')));
  const p = state.results.find((r) => r.id === id) || state.saved.find((r) => r.id === id);
  if (p && flyTo) {
    map.flyTo([p.lat, p.lon], 17, { duration: 0.6 });
    const m = state.markers.get(id);
    if (m) m.openPopup(); else L.popup().setLatLng([p.lat, p.lon]).setContent(`<strong>${esc(p.name)}</strong>`).openOn(map);
  }
  renderList();
  const node = el.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------- Search flow ---------- */
function setBusy(busy) {
  el.submit.disabled = busy;
  el.submit.textContent = busy ? 'Searching…' : 'Find places';
}

function handleError(err) {
  const sample = { id: 'sampleBtn', label: 'Show sample data' };
  const retry = { id: 'retryBtn', label: 'Try again', primary: true };
  const m = err && err.message ? err.message : '';

  if (m === 'NOT_FOUND') {
    state.origin = null; state.results = []; drawMap();
    setMsg(el.locationMsg, 'We could not find that place. Check the spelling or add the district.');
    markInvalid(el.location, true);
    messageCard('Place not found', 'Try a nearby town or a well-known landmark.');
  } else if (m === 'TIMEOUT') {
    messageCard('The request took too long', 'The map server did not answer in time. Try a smaller distance.', [retry, sample]);
  } else if (/^HTTP_(429|5\d\d)$/.test(m)) {
    messageCard('The server is busy', 'OpenStreetMap services limit heavy use. Wait a few seconds and try again.', [retry, sample]);
  } else {
    messageCard('Could not reach the map services', 'Check your internet connection. If this page is opened as a file, run it with Live Server or deploy it.', [retry, sample]);
  }
}

async function runSearch() {
  if (!validate()) return;
  if (!navigator.onLine) {
    messageCard('You are offline', 'Reconnect to the internet and try again.', [{ id: 'retryBtn', label: 'Try again', primary: true }, { id: 'sampleBtn', label: 'Show sample data' }]);
    return;
  }
  const id = ++state.searchId;
  switchTab('results');
  setBusy(true); skeleton();

  try {
    if (!state.useGps) {
      setMsg(el.locationMsg, 'Locating place…', true);
      state.origin = await geocode(el.location.value.trim());
      if (id !== state.searchId) return;
      setMsg(el.locationMsg, 'Found: ' + shortLabel(state.origin.label), true);
    }
    const radius = Number(el.radius.value);
    const rows = await searchPlaces(state.origin, state.category, radius);
    if (id !== state.searchId) return;
    state.results = rows; state.sample = false; state.activeId = null; state.lastRadius = radius;
    drawMap(); renderList();
  } catch (err) {
    if (id === state.searchId) handleError(err);
  } finally {
    if (id === state.searchId) setBusy(false);
  }
}

// Clearly labelled offline sample so the interface can still be demonstrated when a service is down.
function loadSample() {
  const cat = state.category || 'pharmacy';
  state.category = cat;
  const radio = el.chips.querySelector(`input[value="${cat}"]`); if (radio) radio.checked = true;
  if (!state.origin) state.origin = { lat: DEFAULT_CENTER[0], lon: DEFAULT_CENTER[1], label: 'Sample location' };
  el.radius.value = Math.max(Number(el.radius.value), 2000); updateRadiusUI();
  const offsets = [[0.003, 0.002], [-0.004, 0.001], [0.006, -0.005], [-0.009, 0.007], [0.012, 0.010], [-0.015, -0.012]];
  state.results = offsets.map((o, i) => {
    const lat = state.origin.lat + o[0], lon = state.origin.lon + o[1];
    return {
      id: 'sample/' + i, sample: true, category: cat, unnamed: false,
      name: `Sample ${CATEGORIES[cat].label} ${i + 1}`, lat, lon,
      phone: i % 2 === 0 ? '+91 00000 0000' + i : '', hours: i % 3 === 0 ? 'Mo-Su 08:00-21:00' : '',
      distance: haversine(state.origin.lat, state.origin.lon, lat, lon)
    };
  });
  state.sample = true; state.lastRadius = Number(el.radius.value); state.activeId = null;
  switchTab('results'); drawMap(); renderList();
  showToast('Showing sample data, not real places.');
}

function switchTab(tab) {
  state.tab = tab;
  const on = ['border-lagoon-600', 'text-lagoon-700'], off = ['border-transparent', 'text-lagoon-700/70'];
  [[el.tabResults, 'results'], [el.tabSaved, 'saved']].forEach(([btn, name]) => {
    const active = name === tab;
    btn.setAttribute('aria-selected', String(active));
    btn.classList.remove(...(active ? off : on));
    btn.classList.add(...(active ? on : off));
  });
  renderList();
}

function updateRadiusUI() {
  const r = Number(el.radius.value);
  el.radiusLabel.textContent = fmtDist(r);
  el.walkHint.textContent = `(about ${walkMin(r)} min walk)`;
}

function toggleSave(id) {
  const idx = state.saved.findIndex((s) => s.id === id);
  if (idx >= 0) {
    state.saved.splice(idx, 1);
    showToast('Removed from saved places.');
  } else {
    const p = state.results.find((r) => r.id === id);
    if (p) { const copy = Object.assign({}, p); delete copy.distance; state.saved.push(copy); showToast('Saved. You can find it in the Saved tab.'); }
  }
  persistSaved(); renderList();
}

/* ---------- Events ---------- */
// 1. submit: validated search
el.form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });

// 2. input: live validation, slider label, typing clears GPS mode
el.location.addEventListener('input', () => {
  state.useGps = false;
  const len = el.location.value.trim().length;
  if (len === 0) { setMsg(el.locationMsg, ''); markInvalid(el.location, false); }
  else if (len < 3) { setMsg(el.locationMsg, 'Keep typing, at least 3 characters.'); markInvalid(el.location, true); }
  else { setMsg(el.locationMsg, 'Looks good.', true); markInvalid(el.location, false); }
});
el.radius.addEventListener('input', updateRadiusUI);

// 3. change: category chips, sort and filter
el.chips.addEventListener('change', (e) => {
  if (e.target.name === 'category') { state.category = e.target.value; setMsg(el.categoryMsg, ''); }
});
[el.sortBy, el.onlyDetails].forEach((c) => c.addEventListener('change', renderList));

// 4. click: example places, result list actions, tabs, location button
document.querySelectorAll('.example').forEach((b) => b.addEventListener('click', () => {
  el.location.value = b.dataset.example;
  el.location.dispatchEvent(new Event('input'));
  el.location.focus();
}));
el.list.addEventListener('click', (e) => {
  const saveBtn = e.target.closest('[data-save]');
  if (saveBtn) { e.stopPropagation(); toggleSave(saveBtn.dataset.save); return; }
  if (e.target.closest('a')) return;
  if (e.target.closest('#retryBtn')) { runSearch(); return; }
  if (e.target.closest('#sampleBtn')) { loadSample(); return; }
  if (e.target.closest('#widenBtn')) { el.radius.value = 5000; updateRadiusUI(); runSearch(); return; }
  const c = e.target.closest('.result-card');
  if (c) setActive(c.dataset.id, true);
});
el.tabResults.addEventListener('click', () => switchTab('results'));
el.tabSaved.addEventListener('click', () => switchTab('saved'));
el.geo.addEventListener('click', () => {
  if (!navigator.geolocation) { setMsg(el.locationMsg, 'Your browser does not support location access.'); return; }
  setMsg(el.locationMsg, 'Waiting for your location…', true);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.origin = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'My location' };
      state.useGps = true;
      el.location.value = 'My current location';
      markInvalid(el.location, false);
      setMsg(el.locationMsg, 'Using your device location.', true);
    },
    (err) => setMsg(el.locationMsg, err.code === 1 ? 'Location permission was denied. Type a place instead.' : 'Could not get your location. Type a place instead.'),
    { timeout: 10000 }
  );
});

// 5. keydown: keyboard access for result cards
el.list.addEventListener('keydown', (e) => {
  const c = e.target.closest && e.target.closest('.result-card');
  if (c && e.target === c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setActive(c.dataset.id, true); }
});

// 6. online / offline
window.addEventListener('offline', () => el.offline.classList.remove('hidden'));
window.addEventListener('online', () => el.offline.classList.add('hidden'));
window.addEventListener('resize', () => map.invalidateSize());

/* ---------- Init ---------- */
el.chips.innerHTML = Object.keys(CATEGORIES).map((k) => `
  <label class="cursor-pointer">
    <input type="radio" name="category" value="${k}" class="peer sr-only" />
    <span class="block rounded-full border border-coir-300 bg-white px-3 py-1.5 text-sm font-medium transition hover:border-lagoon-500 peer-checked:bg-lagoon-600 peer-checked:border-lagoon-600 peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-lagoon-500">${CATEGORIES[k].label}</span>
  </label>`).join('');

if (openedAsFile) el.fileBanner.classList.remove('hidden');
if (!navigator.onLine) el.offline.classList.remove('hidden');
updateRadiusUI();
renderList();
setTimeout(() => map.invalidateSize(), 200);