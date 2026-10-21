'use strict';
// ==== ROTA + PERFIL DE ELEVAÇÃO ====
registerOverlay(() => {
  ensureSource('route');
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.8 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2563eb', 'line-width': 4 } });
  map.addLayer({ id: 'route-end', type: 'circle', source: 'route', filter: ['==', '$type', 'Point'],
    paint: { 'circle-radius': 6, 'circle-color': '#2563eb', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
});

let routeSeq = 0;
// dest: ponto de interesse clicado (opcional), usado nas dicas.
async function showRoute(lat, lng, dest = null) {
  if (!state.point) return;
  const seq = ++routeSeq;
  state.routeTarget = { lat, lng };
  state.trip = null;
  $('#sec-route').hidden = false;
  $('#route-summary').textContent = '';
  drawElevation([]);
  renderTrip();
  updateLight(); // linhas do sol e horários passam a partir do destino
  setStatus('route-status', 'Calculando rota…', 'loading');
  setSourceData('route', { type: 'FeatureCollection', features: [turf.point([lng, lat])] });
  try {
    const data = await valhalla('/route', {
      locations: [{ lat: state.point.lat, lon: state.point.lng }, { lat: round(lat), lon: round(lng) }],
      costing: 'pedestrian', costing_options: pedestrianCosting(),
      directions_options: { units: 'kilometers', language: 'pt-BR' },
    });
    if (seq !== routeSeq) return;
    const leg = data.trip.legs[0];
    const line = turf.lineString(decodePolyline6(leg.shape));
    setSourceData('route', { type: 'FeatureCollection', features: [line, turf.point([lng, lat])] });
    const { time, length } = data.trip.summary;
    $('#route-summary').innerHTML = `<b>${fmtDuration(time)}</b> · ${length.toFixed(2)} km`;
    state.trip = { target: { lat, lng }, dest, time, length, line, maneuvers: leg.maneuvers, elev: null };
    renderTrip();
    enrichStreetNames(state.trip);
    setStatus('route-status', 'Carregando elevação…', 'loading');
    const h = await valhalla('/height', { encoded_polyline: leg.shape, shape_format: 'polyline6', range: true, resample_distance: Math.max(10, Math.round(length * 1000 / 200)) });
    if (seq !== routeSeq) return;
    const pts = (h.range_height || []).filter((p) => p[1] != null);
    const { gain, loss } = drawElevation(pts);
    $('#route-summary').innerHTML += ` · ↑${gain} m ↓${loss} m`;
    state.trip.elev = { pts, gain, loss };
    renderTrip();
    setStatus('route-status', '');
  } catch (e) {
    if (seq !== routeSeq) return;
    setStatus('route-status', e.message, true);
  }
}
function clearRoute() {
  routeSeq++;
  const had = !!state.routeTarget;
  state.routeTarget = null;
  state.trip = null;
  setSourceData('route', EMPTY);
  $('#sec-route').hidden = true;
  if (had) updateLight(); // luz volta a ter o pin como referência
}
$('#route-clear').addEventListener('click', clearRoute);

function drawElevation(pts) {
  const cv = $('#elev'), dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  if (pts.length < 2) return { gain: 0, loss: 0 };
  const css = getComputedStyle(document.documentElement);
  const [fg, muted, accent] = ['--fg', '--muted', '--accent'].map((v) => css.getPropertyValue(v).trim());
  const dists = pts.map((p) => p[0]), elevs = pts.map((p) => p[1]);
  const maxD = dists.at(-1) || 1;
  let minE = Math.min(...elevs), maxE = Math.max(...elevs);
  if (maxE - minE < 10) { const mid = (maxE + minE) / 2; minE = mid - 5; maxE = mid + 5; }
  const pad = { l: 34, r: 6, t: 8, b: 18 };
  const x = (d) => pad.l + (d / maxD) * (W - pad.l - pad.r);
  const y = (e) => pad.t + (1 - (e - minE) / (maxE - minE)) * (H - pad.t - pad.b);
  ctx.beginPath();
  pts.forEach(([d, e], i) => (i ? ctx.lineTo(x(d), y(e)) : ctx.moveTo(x(d), y(e))));
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineTo(x(maxD), H - pad.b); ctx.lineTo(x(0), H - pad.b); ctx.closePath();
  ctx.globalAlpha = 0.18; ctx.fillStyle = accent; ctx.fill(); ctx.globalAlpha = 1;
  ctx.fillStyle = muted; ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(maxE)} m`, pad.l - 4, pad.t + 8);
  ctx.fillText(`${Math.round(minE)} m`, pad.l - 4, H - pad.b);
  ctx.textAlign = 'left'; ctx.fillText('0', pad.l, H - 4);
  ctx.textAlign = 'right'; ctx.fillStyle = fg; ctx.fillText(`${(maxD / 1000).toFixed(2)} km`, W - pad.r, H - 4);
  // Ganho/perda acumulados, ignorando ruído < 1 m entre amostras.
  let gain = 0, loss = 0, ref = elevs[0];
  for (const e of elevs) {
    if (e - ref >= 1) { gain += e - ref; ref = e; } else if (ref - e >= 1) { loss += ref - e; ref = e; }
  }
  return { gain: Math.round(gain), loss: Math.round(loss) };
}
