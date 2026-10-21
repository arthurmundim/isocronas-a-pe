'use strict';
// ==== PONTOS PARA FOTOGRAFAR (OVERPASS) ====
// Resultados já baixados, por bbox [w, s, e, n]. Um bbox novo contido num antigo reaproveita os dados.
const overpassResults = [];
const bboxContains = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];

async function overpassQuery(query, { onRetry, isStale }) {
  let lastErr, wait = 2000;
  for (let round = 0; round < 3; round++) {
    for (const url of CONFIG.overpass) {
      if (isStale()) throw new ApiError('Overpass', 'cancelado');
      try {
        const data = await limits.overpass(() => fetchJSON('Overpass', url, {
          method: 'POST', body: new URLSearchParams({ data: query }), // form-urlencoded = sem preflight CORS
        }, 45000));
        if (!data.elements?.length && data.remark) throw new ApiError('Overpass', 'Overpass: ' + data.remark.slice(0, 90), 500);
        return data;
      } catch (e) {
        lastErr = e;
        if (e.status && e.status < 429 && e.status !== 408) throw e; // erro na consulta: não adianta trocar de servidor
      }
    }
    if (round < 2) {
      onRetry(`Servidores do Overpass ocupados; tentando de novo em ${wait / 1000} s…`);
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
  throw new ApiError('Overpass', 'Overpass: servidores públicos ocupados agora (' + lastErr.message.replace(/^Overpass: /, '') + ')');
}

async function fetchPoiElements(bbox, opts) {
  const hit = overpassResults.find((r) => bboxContains(r.bbox, bbox));
  if (hit) return hit.elements;
  // Arredonda para fora (grade de ~500 m) para aumentar o reaproveitamento.
  const g = 0.005, bb = [Math.floor(bbox[0] / g) * g, Math.floor(bbox[1] / g) * g, Math.ceil(bbox[2] / g) * g, Math.ceil(bbox[3] / g) * g].map((v) => +v.toFixed(3));
  const [w, s, e, n] = bb;
  const query = `[out:json][timeout:40][bbox:${s},${w},${n},${e}];(${CATEGORIES.map((c) => `nwr${c.osm};`).join('')});out center tags qt;`;
  const data = await cached('overpass:' + query, () => overpassQuery(query, opts));
  overpassResults.push({ bbox: bb, elements: data.elements });
  return data.elements;
}

function toPoi(el) {
  const t = el.tags || {};
  const cat = CATEGORIES.find((c) => c.match(t));
  const lng = el.lon ?? el.center?.lon, lat = el.lat ?? el.center?.lat;
  if (!cat || lng == null) return null;
  const name = t.name || t['name:pt'] || t.description || t.inscription?.slice(0, 50) || '';
  return { id: `${el.type}/${el.id}`, cat: cat.id, name, lng, lat, tags: t };
}

let poiSeq = 0;
async function loadPois() {
  const outer = state.iso?.features[0];
  if (!outer) return;
  const seq = ++poiSeq;
  setStatus('poi-status', 'Buscando pontos no OpenStreetMap… (o Overpass pode levar até ~30 s)', 'loading');
  poiError = false;
  poiLoading = true;
  renderPois();
  try {
    const elements = await fetchPoiElements(turf.bbox(outer), {
      isStale: () => seq !== poiSeq,
      onRetry: (msg) => { if (seq === poiSeq) { setStatus('poi-status', msg, 'loading'); setStatus('dest-wait', msg, 'loading'); } },
    });
    if (seq !== poiSeq) return;
    const seen = new Set();
    state.pois = elements.map(toPoi).filter((p) => {
      if (!p || seen.has(p.id) || !turf.booleanPointInPolygon([p.lng, p.lat], outer)) return false;
      seen.add(p.id);
      p.ring = ringOf(p.lng, p.lat);
      return true;
    }).sort((a, b) => a.ring - b.ring || a.name.localeCompare(b.name));
    setStatus('poi-status', '');
  } catch (e) {
    if (seq !== poiSeq) return;
    state.pois = [];
    poiError = true;
    setStatus('poi-status', e.message + '. O resto do app segue funcionando.', true);
  }
  poiLoading = false;
  if (state.trip) renderTrip(); // pontos no caminho entram nas dicas
  renderPois();
  flowPoisLoaded(); // a etapa de destino só abre com os pontos no mapa
}
let poiError = false, poiLoading = false;
function clearPois() {
  poiSeq++;
  state.pois = [];
  renderPois();
}

// Ícone de cada categoria: círculo colorido + emoji, desenhado em canvas.
function categoryIcon(c) {
  const s = 64, cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2 - 3, 0, Math.PI * 2);
  ctx.fillStyle = c.color; ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.font = '32px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(c.emoji, s / 2, s / 2 + 2);
  return ctx.getImageData(0, 0, s, s);
}
const poiFilter = () => ['in', ['get', 'cat'], ['literal', [...state.cats]]];
registerOverlay(() => {
  for (const c of CATEGORIES) if (!map.hasImage('poi-' + c.id)) map.addImage('poi-' + c.id, categoryIcon(c), { pixelRatio: 2 });
  ensureSource('pois');
  map.addLayer({ id: 'poi', type: 'symbol', source: 'pois', filter: poiFilter(), layout: {
    'icon-image': ['concat', 'poi-', ['get', 'cat']], 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.7, 16, 1],
    'symbol-sort-key': ['get', 'prio'],
  } });
});
map.on('mouseenter', 'poi', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'poi', () => { map.getCanvas().style.cursor = ''; });

function renderPois() {
  const fc = { type: 'FeatureCollection', features: state.pois.map((p) =>
    turf.point([p.lng, p.lat], { id: p.id, cat: p.cat, prio: CATEGORIES.indexOf(CAT[p.cat]) })) };
  setSourceData('pois', fc);
  if (map.getLayer('poi')) map.setFilter('poi', poiFilter());

  const byCat = Object.fromEntries(CATEGORIES.map((c) => [c.id, state.pois.filter((p) => p.cat === c.id)]));
  $('#poi-list').innerHTML = CATEGORIES.map((c) => {
    const list = byCat[c.id], on = state.cats.has(c.id);
    // Contagem acumulada por anel: "3 em até 10 min".
    const rings = state.iso ? state.times.map((t) => [t, list.filter((p) => p.ring <= t).length]) : [];
    const ringsTxt = rings.filter(([, n], i) => n > 0 && (i === 0 || n !== rings[i - 1][1])).map(([t, n]) => `${n} em até ${t} min`).join(' · ');
    const items = list.slice(0, 40).map((p) =>
      `<li data-id="${esc(p.id)}">${esc(p.name || c.one)} <small>· ${p.ring} min</small></li>`).join('');
    return `<div class="cat ${on ? '' : 'off'}">
      <label class="cat-head"><input type="checkbox" data-cat="${c.id}" ${on ? 'checked' : ''}>
        <span class="dot" style="background:${c.color}">${c.emoji}</span><span class="name">${c.label}</span><span class="count">${poiLoading ? "…" : list.length}</span></label>
      ${ringsTxt ? `<div class="rings">${ringsTxt}</div>` : ''}
      ${list.length ? `<details><summary>ver lista</summary><ul>${items}</ul>${list.length > 40 ? `<small>+${list.length - 40} no mapa</small>` : ''}</details>` : ''}
    </div>`;
  }).join('');

  const visible = state.pois.filter((p) => state.cats.has(p.cat));
  const highlight = CATEGORIES.filter((c) => state.cats.has(c.id) && byCat[c.id].length).slice(0, 3)
    .map((c) => { const n = byCat[c.id].length; return `${n} ${n === 1 ? c.one : c.many}`; });
  $('#poi-retry').hidden = !poiError;
  setStatus('poi-summary', poiError || poiLoading ? '' : state.iso
    ? (visible.length ? `${visible.length} pontos em até ${state.times.at(-1)} min (${highlight.join(', ')}).` : 'Nenhum ponto nas categorias ativas.')
    : 'Escolha um ponto para ver o que há por perto.');
  refreshSummaries();
}
$('#poi-retry').addEventListener('click', loadPois);
$('#poi-list').addEventListener('change', (e) => {
  const cat = e.target.dataset.cat;
  if (!cat) return;
  e.target.checked ? state.cats.add(cat) : state.cats.delete(cat);
  renderPois();
  onStateChanged();
});
$('#poi-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openPoi(li.dataset.id, { fly: true });
});

let poiPopup = null;
function openPoi(id, { fly = false } = {}) {
  const p = state.pois.find((x) => x.id === id);
  if (!p) return;
  const c = CAT[p.cat], t = p.tags;
  const extra = [t.artist_name && `Artista: ${t.artist_name}`, t.historic && t.historic !== 'yes' && `historic=${t.historic}`,
    t.religion && `Religião: ${t.religion}`, t.opening_hours && `Horário: ${t.opening_hours}`].filter(Boolean);
  const wiki = t.wikipedia ? `https://${t.wikipedia.split(':')[0]}.wikipedia.org/wiki/${encodeURIComponent(t.wikipedia.split(':').slice(1).join(':'))}` : null;
  const html = `<div class="popup"><h3>${c.emoji} ${esc(p.name || c.one)}</h3>
    <p>${esc(c.label)} · até ${p.ring} min a pé</p>${extra.map((x) => `<p>${esc(x)}</p>`).join('')}
    <p><a href="https://www.openstreetmap.org/${esc(p.id)}" target="_blank" rel="noopener">OSM</a>${wiki ? ` · <a href="${esc(wiki)}" target="_blank" rel="noopener">Wikipedia</a>` : ''}</p></div>`;
  poiPopup?.remove();
  poiPopup = new maplibregl.Popup({ offset: 14, maxWidth: '260px' }).setLngLat([p.lng, p.lat]).setHTML(html).addTo(map);
  if (fly) map.easeTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 16), padding: mapPadding() });
  showRoute(p.lat, p.lng, p, { show: true });
}
