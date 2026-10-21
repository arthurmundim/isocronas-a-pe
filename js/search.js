'use strict';
// ==== BUSCA: CEP (BrasilAPI → Nominatim) ====
const isCep = (q) => /^\d{5}-?\d{3}$/.test(q.trim());

// Nominatim: só para geocodificar o endereço de um CEP (nunca autocomplete). 1 req/s via limiter.
function nominatimSearch(params) {
  const url = CONFIG.nominatim + '?' + new URLSearchParams({ format: 'jsonv2', limit: 1, ...params });
  return cached(url, () => limits.nominatim(() => fetchJSON('Nominatim', url)));
}

async function resolveCep(raw) {
  const cep = raw.replace(/\D/g, '');
  const data = await cached('cep:' + cep, () => fetchJSON('BrasilAPI', CONFIG.brasilApiCep + cep)).catch((e) => {
    if (e.status === 404) throw new ApiError('BrasilAPI', `CEP ${cep} não encontrado`);
    throw e;
  });
  const label = [data.street, data.neighborhood, `${data.city}/${data.state}`].filter(Boolean).join(', ');
  const c = data.location?.coordinates || {};
  const apiCoords = c.latitude && c.longitude ? { lat: +c.latitude, lng: +c.longitude } : null;
  // As coordenadas do BrasilAPI costumam ser o centro da cidade; quando há rua, o Nominatim é bem mais preciso.
  if (data.street || !apiCoords) {
    try {
      const params = data.street
        ? { street: data.street, city: data.city, state: data.state, country: 'Brasil' }
        : { postalcode: cep, city: data.city, country: 'Brasil' };
      const [hit] = await nominatimSearch(params);
      if (hit) return { lat: +hit.lat, lng: +hit.lon, label: `${label} (CEP ${cep})` };
    } catch (e) {
      if (!apiCoords) throw e;
    }
  }
  if (apiCoords) return { ...apiCoords, label: `${label} (CEP ${cep}, aproximado)` };
  throw new ApiError('Nominatim', `Não achei coordenadas para o CEP ${cep}`);
}

// ==== BUSCA: NÚMERO DA CASA ====
// Normaliza nomes de rua para comparar ("Av. Paulista" ~ "avenida paulista" ~ "paulista").
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\b(rua|r|avenida|av|alameda|al|travessa|tv|praca|estrada|rodovia|largo|de|da|do|dos|das)\b\.?/g, ' ')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// Último número solto (1–5 dígitos) digitado: "Rua 25 de Março 100" → "100".
const houseNumberOf = (q) => [...q.matchAll(/(?:^|[\s,])(?:n[º°o.]?\s*)?(\d{1,5})(?=$|[\s,\-–])/gi)].at(-1)?.[1] || null;
const bboxAround = (km) => {
  const c = map.getCenter(), d = km / 111;
  return [c.lng - d, c.lat + d, c.lng + d, c.lat - d].map((v) => v.toFixed(3)).join(',');
};

// Nominatim só em busca explícita (Enter / "Endereço exato"), nunca no autocomplete. Tem interpolação de números.
async function searchExact(q) {
  const num = houseNumberOf(q);
  setStatus('search-status', 'Procurando o número exato…', 'loading');
  try {
    const [hit] = await nominatimSearch({ q, addressdetails: 1, viewbox: bboxAround(40) });
    const a = hit?.address || {};
    const road = a.road || a.pedestrian || hit?.name;
    const exact = hit && num && a.house_number && new RegExp(`(^|\\D)${num}(\\D|$)`).test(a.house_number);
    if (exact) {
      const place = [a.suburb || a.neighbourhood, a.city || a.town || a.village].filter(Boolean).join(', ');
      return setPoint(+hit.lat, +hit.lon, [`${road}, ${num}`, place].filter(Boolean).join(' · '));
    }
    // Número não mapeado no OSM: a rua sem número no Photon (que prioriza a região do mapa) erra menos que o palpite do Nominatim.
    const missing = num ? ` · nº ${num} não mapeado; arraste o pin para ajustar` : '';
    const [street] = await photonSearch(q.replace(new RegExp(`(?:n[º°o.]?\\s*)?\\b${num}\\b`, 'i'), ' ')).catch(() => []);
    if (street) return setPoint(street.lat, street.lng, [street.title, street.sub].filter(Boolean).join(' · ') + missing);
    if (hit) return setPoint(+hit.lat, +hit.lon, (hit.name || road) + missing);
    throw new ApiError('Nominatim', 'Endereço não encontrado.');
  } catch (e) {
    setStatus('search-status', e.message, true);
  }
}

// ==== BUSCA: AUTOCOMPLETE (Photon) ====
async function photonSearch(q) {
  const c = map.getCenter();
  const url = CONFIG.photon + '?' + new URLSearchParams({ q, limit: 8, lat: c.lat.toFixed(3), lon: c.lng.toFixed(3) });
  const data = await cached(url, () => fetchJSON('Photon', url));
  const num = houseNumberOf(q), nq = norm(q);
  const res = data.features.map((f) => {
    const p = f.properties;
    const streetNum = [p.street, p.housenumber].filter(Boolean).join(', ');
    const title = p.name || streetNum || p.city || '(sem nome)';
    const street = p.name && p.street ? streetNum : '';
    const noNum = num && p.type === 'street' ? ' · sem número' : '';
    const sub = [...new Set([street, p.district, p.city, p.state, p.country])].filter((x) => x && x !== title).join(' · ') + noNum;
    const [lng, lat] = f.geometry.coordinates;
    // Exato = mesmo número e rua contida no texto digitado (evita "Rua Cônego Valadão 1500" para "Rua Augusta 1500").
    const exact = !!num && p.housenumber === num && !!p.street && nq.includes(norm(p.street));
    return { lat, lng, title, sub, exact };
  });
  return res.sort((a, b) => b.exact - a.exact).slice(0, 6);
}

let suggestions = [], activeIdx = -1, searchSeq = 0;
function renderSuggestions() {
  $('#suggestions').innerHTML = suggestions.map((s, i) =>
    `<li role="option" data-i="${i}" class="${i === activeIdx ? 'active' : ''}">${esc(s.title)}<small>${esc(s.sub || '')}</small></li>`).join('');
}
function chooseSuggestion(i) {
  const s = suggestions[i];
  if (!s) return;
  suggestions = []; activeIdx = -1; renderSuggestions();
  if (s.cep) return searchCep(s.cep);
  if (s.nominatim) return searchExact(s.nominatim);
  $('#search').value = s.title;
  setPoint(s.lat, s.lng, [s.title, s.sub].filter(Boolean).join(' · '));
}
// Com número digitado e sem resultado exato do Photon, oferece a busca exata no Nominatim como 1ª opção.
function withExactOption(q, res) {
  if (!houseNumberOf(q) || res.some((s) => s.exact)) return res;
  return [{ nominatim: q, title: `🔎 Endereço exato: ${q}`, sub: 'busca o número no OpenStreetMap (Nominatim)' }, ...res];
}
async function submitSearch(q) {
  searchSeq++;
  $('#search-wrap').classList.remove('loading');
  suggestions = []; renderSuggestions();
  if (isCep(q)) return searchCep(q);
  if (q.length < 3) return;
  if (houseNumberOf(q)) {
    // Se o Photon já tem o número exato, usa; senão vai ao Nominatim.
    const res = await photonSearch(q).catch(() => []);
    const hit = res.find((s) => s.exact);
    if (hit) { $('#search').value = hit.title; return setPoint(hit.lat, hit.lng, [hit.title, hit.sub].filter(Boolean).join(' · ')); }
    return searchExact(q);
  }
  setStatus('search-status', 'Buscando…', 'loading');
  try {
    const [first] = await photonSearch(q);
    if (!first) return setStatus('search-status', 'Nada encontrado.');
    $('#search').value = first.title;
    setPoint(first.lat, first.lng, [first.title, first.sub].filter(Boolean).join(' · '));
  } catch (e) { setStatus('search-status', e.message, true); }
}
async function searchCep(q) {
  setStatus('search-status', 'Buscando CEP…', 'loading');
  try {
    const r = await resolveCep(q);
    setPoint(r.lat, r.lng, r.label);
  } catch (e) {
    setStatus('search-status', e.message, true);
  }
}

const runAutocomplete = debounce(async (q) => {
  const seq = ++searchSeq;
  $('#search-wrap').classList.add('loading');
  try {
    const res = withExactOption(q, await photonSearch(q));
    if (seq !== searchSeq) return;
    suggestions = res; activeIdx = -1; renderSuggestions();
    setStatus('search-status', res.length ? '' : 'Nada encontrado.');
  } catch (e) {
    if (seq === searchSeq) setStatus('search-status', e.message, true);
  } finally {
    if (seq === searchSeq) $('#search-wrap').classList.remove('loading');
  }
}, 400);

$('#search').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  if (isCep(q)) {
    searchSeq++;
    suggestions = [{ cep: q, title: `Buscar CEP ${q}`, sub: 'BrasilAPI' }]; activeIdx = 0; renderSuggestions();
    return;
  }
  if (q.length < 3) { searchSeq++; $('#search-wrap').classList.remove('loading'); suggestions = []; renderSuggestions(); return; }
  $('#search-wrap').classList.add('loading');
  runAutocomplete(q);
});
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!suggestions.length) return;
    e.preventDefault();
    activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    // Enter sem item destacado = busca explícita (inclui número exato via Nominatim).
    if (activeIdx >= 0) chooseSuggestion(activeIdx);
    else submitSearch(e.target.value.trim());
  } else if (e.key === 'Escape') { suggestions = []; renderSuggestions(); }
});
$('#suggestions').addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (li) { e.preventDefault(); chooseSuggestion(+li.dataset.i); }
});
$('#search').addEventListener('blur', () => setTimeout(() => { suggestions = []; renderSuggestions(); }, 150));
