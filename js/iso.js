'use strict';
// ==== VALHALLA ====
function valhalla(path, body) {
  const json = JSON.stringify(body);
  return cached(path + json, () => limits.valhalla(() => fetchJSON('Valhalla', CONFIG.valhalla + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json,
  })));
}
const pedestrianCosting = () => ({ pedestrian: { walking_speed: state.speed, use_hills: state.hills } });

// Decodifica polyline com precisão 6 (formato do Valhalla) → [[lng, lat], ...]
function decodePolyline6(str) {
  const coords = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += d; else lng += d;
    }
    coords.push([lng / 1e6, lat / 1e6]);
  }
  return coords;
}
function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// ==== ISÓCRONAS ====
function ringColor(i, n) {
  const ramp = CONFIG.ringColors;
  return ramp[n === 1 ? 0 : Math.round((i * (ramp.length - 1)) / (n - 1))];
}

registerOverlay(() => {
  ensureSource('iso');
  const before = firstSymbolLayer();
  map.addLayer({ id: 'iso-fill', type: 'fill', source: 'iso', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.2 } }, before);
  map.addLayer({ id: 'iso-line', type: 'line', source: 'iso', paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.9 } }, before);
});

function renderLegend() {
  const n = state.times.length;
  $('#legend').innerHTML = state.times.map((t, i) => `<span><i style="background:${ringColor(i, n)}"></i>até ${t} min</span>`).join('');
}

let isoSeq = 0;
async function computeIsochrones() {
  renderLegend();
  if (!state.point) return;
  const seq = ++isoSeq;
  const { lat, lng } = state.point;
  setStatus('iso-status', 'Calculando área alcançável…', 'loading');
  setIsoStale(true);
  try {
    const data = await valhalla('/isochrone', {
      locations: [{ lat, lon: lng }],
      costing: 'pedestrian',
      costing_options: pedestrianCosting(),
      contours: state.times.map((time) => ({ time })),
      polygons: true, denoise: 0.3, generalize: 15,
    });
    if (seq !== isoSeq) return;
    const n = state.times.length;
    const features = data.features
      .filter((f) => /Polygon/.test(f.geometry?.type))
      .map((f) => ({ ...f, properties: { contour: f.properties.contour, color: ringColor(state.times.indexOf(f.properties.contour), n) } }))
      .sort((a, b) => b.properties.contour - a.properties.contour);
    state.iso = { type: 'FeatureCollection', features };
    setSourceData('iso', state.iso);
    const km2 = features.length ? (turf.area(features[0]) / 1e6).toFixed(2) : 0;
    setIsoStale(false);
    setStatus('iso-status', `Em ${state.times.at(-1)} min, ritmo "${paceOf(state.speed).label}" (${state.speed} km/h)${state.hills > 0.5 ? ', evitando ladeiras' : ''}: ~${km2} km². Clique na mancha para ver a rota.`);
    if (features.length) map.fitBounds(turf.bbox(features[0]), { padding: mapPadding(), maxZoom: 16, duration: 600 });
    onIsochronesChanged();
  } catch (e) {
    if (seq !== isoSeq) return;
    state.iso = null;
    setSourceData('iso', EMPTY);
    setIsoStale(false);
    setStatus('iso-status', e.message, true);
    toast('Isócronas: ' + e.message);
  }
}
function onIsochronesChanged() {
  loadPois();
  drawSunLines();
}

function insideIsochrone(lng, lat) {
  const outer = state.iso?.features[0];
  return !!outer && turf.booleanPointInPolygon([lng, lat], outer);
}
// Menor anel (em minutos) que contém o ponto, ou null.
function ringOf(lng, lat) {
  const fs = state.iso?.features || [];
  for (let i = fs.length - 1; i >= 0; i--) if (turf.booleanPointInPolygon([lng, lat], fs[i])) return fs[i].properties.contour;
  return null;
}

// Mancha esmaecida enquanto recalcula, para não parecer resultado final.
function setIsoStale(on) {
  if (map.getLayer('iso-fill')) map.setPaintProperty('iso-fill', 'fill-opacity', on ? 0.07 : 0.2);
  if (map.getLayer('iso-line')) map.setPaintProperty('iso-line', 'line-opacity', on ? 0.35 : 0.9);
}

const debouncedRecompute = debounce(() => {
  computeIsochrones();
  if (state.routeTarget) showRoute(state.routeTarget.lat, state.routeTarget.lng);
  onStateChanged();
}, 400);
function recomputeIso() {
  if (state.point) { setStatus('iso-status', 'Calculando área alcançável…', 'loading'); setIsoStale(true); }
  debouncedRecompute();
}
$('#times').addEventListener('change', (e) => {
  const t = parseTimes(e.target.value);
  if (t.length) state.times = t;
  e.target.value = state.times.join(', ');
  recomputeIso();
});

function renderPace() {
  $('#pace').innerHTML = CONFIG.paces.map((p) =>
    `<button type="button" role="radio" aria-checked="${p.v === state.speed}" data-v="${p.v}" title="${esc(p.hint)}">${esc(p.label)}<small>${p.v} km/h</small></button>`).join('');
  $('#pace-hint').textContent = paceOf(state.speed).hint;
}
$('#pace').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b || +b.dataset.v === state.speed) return;
  state.speed = +b.dataset.v;
  renderPace();
  recomputeIso();
});
$('#hills').addEventListener('change', (e) => { state.hills = e.target.checked ? 1 : 0.5; recomputeIso(); });
