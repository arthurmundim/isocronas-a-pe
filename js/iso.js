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

// A mancha é desenhada como rede de ruas alcançáveis (Valhalla /expansion). Os polígonos de /isochrone continuam
// sendo a base da lógica (pontos, clique "dentro da mancha") e só aparecem se as ruas falharem.
let streetsShown = false;
registerOverlay(() => {
  ensureSource('iso');
  ensureSource('iso-streets');
  const before = firstSymbolLayer();
  map.addLayer({ id: 'iso-fill', type: 'fill', source: 'iso', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0 } }, before);
  map.addLayer({ id: 'iso-line', type: 'line', source: 'iso', paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0 } }, before);
  map.addLayer({ id: 'iso-streets', type: 'line', source: 'iso-streets', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-opacity': 0, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.2, 15, 2.5, 17, 4.5] } }, before);
  setIsoStale(false);
});

// Ruas alcançáveis, cada uma na cor do menor anel que a alcança (mais longe primeiro, para as próximas ficarem por cima).
async function loadStreets(seq) {
  const { lat, lng } = state.point;
  const max = state.times.at(-1) * 60;
  try {
    const data = await valhalla('/expansion', {
      locations: [{ lat, lon: lng }], costing: 'pedestrian', costing_options: pedestrianCosting(),
      action: 'isochrone', contours: [{ time: state.times.at(-1) }], skip_opposites: true, expansion_properties: ['duration'],
    });
    if (seq !== isoSeq) return;
    const n = state.times.length;
    const features = [];
    for (const f of data.features) {
      const i = state.times.findIndex((t) => f.properties.duration <= t * 60);
      if (i < 0 || f.properties.duration > max) continue;
      features.push({ type: 'Feature', geometry: f.geometry, properties: { ring: i, color: ringColor(i, n) } });
    }
    features.sort((a, b) => b.properties.ring - a.properties.ring);
    setSourceData('iso-streets', { type: 'FeatureCollection', features });
    streetsShown = features.length > 0;
  } catch (e) {
    if (seq !== isoSeq) return;
    console.warn('expansion', e);
    setSourceData('iso-streets', EMPTY);
    streetsShown = false; // sem ruas: volta a mancha de área
  }
  setIsoStale(false);
}

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
    // A mancha de ruas chega logo depois. Até lá não mostramos a área (parecia um "círculo" provisório);
    // ela só aparece se o /expansion falhar.
    streetsShown = true;
    loadStreets(seq);
    setStatus('iso-status', `Em ${state.times.at(-1)} min, ritmo "${paceOf(state.speed).label}" (${state.speed} km/h)${state.hills > 0.5 ? ', evitando ladeiras' : ''}: ~${km2} km². Clique na mancha para ver a rota.`);
    if (features.length) map.fitBounds(turf.bbox(features[0]), { padding: mapPadding(), maxZoom: 16, duration: 600 });
    onIsochronesChanged();
  } catch (e) {
    if (seq !== isoSeq) return;
    state.iso = null;
    setSourceData('iso', EMPTY);
    setSourceData('iso-streets', EMPTY);
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
// Com ruas: só as ruas (claras, para a rota escura destacar). Sem ruas: a área, como fallback.
function setIsoStale(on) {
  if (!map.getLayer('iso-streets')) return;
  map.setPaintProperty('iso-streets', 'line-opacity', streetsShown ? (on ? 0.15 : 0.55) : 0);
  map.setPaintProperty('iso-fill', 'fill-opacity', streetsShown ? 0 : on ? 0.07 : 0.2);
  map.setPaintProperty('iso-line', 'line-opacity', streetsShown ? 0 : on ? 0.35 : 0.9);
}

const debouncedRecompute = debounce(() => {
  computeIsochrones();
  if (state.routeTarget) showRoute(state.routeTarget.lat, state.routeTarget.lng, state.trip?.dest);
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
