'use strict';
// ==== LUZ PARA FOTO (SUNCALC) ====
// Blue hour: sol entre -6° e -4°; golden hour: entre -4° e +6°.
SunCalc.addTime(-4, 'blueHourEnd', 'blueHourStart');


// SunCalc escolhe o dia pela data passada; usamos o meio-dia solar aproximado do lugar.
function sunTimes(dateStr, lat, lng) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return SunCalc.getTimes(new Date(Date.UTC(y, m - 1, d, 12) - (lng / 15) * 3600e3), lat, lng);
}
// Azimute do SunCalc é medido a partir do sul, sentido horário; convertemos para rumo a partir do norte.
const sunBearing = (date, lat, lng) => ((SunCalc.getPosition(date, lat, lng).azimuth * 180) / Math.PI + 180) % 360;
const compass = (deg) => ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(deg / 45) % 8];

function updateLight() {
  if (!state.date) state.date = todayStr();
  $('#date').value = state.date;
  if (!state.point) { $('#sun-table').innerHTML = ''; $('#sun-tz').textContent = 'Escolha um ponto.'; return; }
  const { lat, lng } = state.point;
  const t = sunTimes(state.date, lat, lng);
  const rise = valid(t.sunrise) ? sunBearing(t.sunrise, lat, lng) : null;
  const set = valid(t.sunset) ? sunBearing(t.sunset, lat, lng) : null;
  const rows = [
    ['#60a5fa', 'Blue hour (manhã)', fmtRange(t.dawn, t.blueHourEnd)],
    ['#f59e0b', 'Golden hour (manhã)', fmtRange(t.blueHourEnd, t.goldenHourEnd)],
    ['#f59e0b', 'Nascer do sol', `${fmtTime(t.sunrise)}${rise != null ? ` · ${Math.round(rise)}° ${compass(rise)}` : ''}`],
    ['#e11d48', 'Pôr do sol', `${fmtTime(t.sunset)}${set != null ? ` · ${Math.round(set)}° ${compass(set)}` : ''}`],
    ['#e11d48', 'Golden hour (tarde)', fmtRange(t.goldenHour, t.blueHourStart)],
    ['#6366f1', 'Blue hour (noite)', fmtRange(t.blueHourStart, t.dusk)],
  ];
  $('#sun-table').innerHTML = rows.map(([c, k, v]) => `<tr><th><span class="sw" style="background:${c}"></span>${k}</th><td>${v}</td></tr>`).join('');
  $('#sun-tz').textContent = `Horários no fuso ${tzName()}. Linhas no mapa: direção do sol no nascer (laranja) e no pôr (vermelho).`;
  drawSunLines();
}

registerOverlay(() => {
  ensureSource('sun');
  map.addLayer({ id: 'sun-line', type: 'line', source: 'sun', paint: {
    'line-color': ['match', ['get', 'kind'], 'rise', '#f59e0b', '#e11d48'], 'line-width': 3, 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 } });
  map.addLayer({ id: 'sun-label', type: 'symbol', source: 'sun', layout: {
    'symbol-placement': 'line-center', 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, -0.8] },
    paint: { 'text-color': ['match', ['get', 'kind'], 'rise', '#b45309', '#be123c'], 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
});

function drawSunLines() {
  if (!state.point) return setSourceData('sun', EMPTY);
  const { lat, lng } = state.point;
  const t = sunTimes(state.date || todayStr(), lat, lng);
  const origin = [lng, lat];
  // Comprimento: até a borda da maior isócrona (mínimo 800 m).
  const outer = state.iso?.features[0];
  let km = 1.5;
  if (outer) {
    const [w, s, e, n] = turf.bbox(outer);
    km = Math.max(0.8, ...[[w, s], [e, s], [w, n], [e, n]].map((c) => turf.distance(origin, c) * 0.8));
  }
  const features = [['rise', t.sunrise, 'nascer'], ['set', t.sunset, 'pôr']].filter(([, d]) => valid(d)).map(([kind, d, name]) => {
    const b = sunBearing(d, lat, lng);
    const end = turf.destination(origin, km, b > 180 ? b - 360 : b).geometry.coordinates;
    return turf.lineString([origin, end], { kind, label: `${name} ${fmtTime(d)}` });
  });
  setSourceData('sun', { type: 'FeatureCollection', features });
}

$('#date').addEventListener('change', (e) => {
  state.date = e.target.value || todayStr();
  updateLight();
  onStateChanged();
});

// ==== NUVENS NAS GOLDEN HOURS (OPEN-METEO) ====
let cloudSeq = 0;
async function loadClouds() {
  if (!state.point) return;
  const seq = ++cloudSeq;
  const lat = state.point.lat.toFixed(2), lng = state.point.lng.toFixed(2);
  const url = CONFIG.openMeteo + '?' + new URLSearchParams({
    latitude: lat, longitude: lng, hourly: 'cloud_cover,cloud_cover_low,cloud_cover_high', forecast_days: 3, timezone: 'auto' });
  setStatus('cloud-status', 'Carregando previsão…', 'loading');
  try {
    const data = await cached(url, () => fetchJSON('Open-Meteo', url));
    if (seq !== cloudSeq) return;
    const tzChanged = state.tz !== data.timezone;
    state.tz = data.timezone;
    if (tzChanged) updateLight(); // reformatar horários no fuso do lugar
    renderClouds(data);
    setStatus('cloud-status', 'Fonte: Open-Meteo. Nuvens altas podem render um céu colorido; baixas tendem a bloquear o sol.');
  } catch (e) {
    if (seq !== cloudSeq) return;
    $('#cloud-table').innerHTML = '';
    setStatus('cloud-status', e.message, true);
  }
}

function renderClouds(data) {
  const { time, cloud_cover: cc, cloud_cover_low: low, cloud_cover_high: high } = data.hourly;
  const idx = new Map(time.map((t, i) => [t, i]));
  // 'sv-SE' formata como "YYYY-MM-DD HH:MM", igual às chaves horárias do Open-Meteo.
  const hourKey = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: tzName(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .format(d).replace(' ', 'T') + ':00';
  const avgIn = (a, b) => {
    if (!valid(a) || !valid(b)) return null;
    const ids = new Set();
    for (let t = a.getTime(); t <= b.getTime(); t += 15 * 60e3) { const i = idx.get(hourKey(new Date(t))); if (i != null) ids.add(i); }
    if (!ids.size) return null;
    const mean = (arr) => Math.round([...ids].reduce((s, i) => s + (arr[i] ?? 0), 0) / ids.size);
    return { total: mean(cc), low: mean(low), high: mean(high) };
  };
  const cell = (a, b) => {
    const c = avgIn(a, b);
    if (!c) return '<td>—</td>';
    const cls = c.total < 30 ? 'clear' : c.total < 70 ? 'partial' : 'overcast';
    return `<td>${fmtRange(a, b)} <span class="cloud ${cls}" title="baixas ${c.low}% · altas ${c.high}%">${c.total}%</span></td>`;
  };
  const days = [...new Set(time.map((t) => t.slice(0, 10)))].slice(0, 3);
  const { lat, lng } = state.point;
  const dayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  $('#cloud-table').innerHTML = '<tr><th></th><th>Manhã</th><th>Tarde</th></tr>' + days.map((d) => {
    const t = sunTimes(d, lat, lng);
    return `<tr><th>${dayFmt.format(new Date(d + 'T12:00Z'))}</th>${cell(t.blueHourEnd, t.goldenHourEnd)}${cell(t.goldenHour, t.blueHourStart)}</tr>`;
  }).join('');
}
