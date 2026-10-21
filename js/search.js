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

// Nominatim só em busca explícita (botão Buscar), nunca enquanto digita. Tem interpolação de números.
// Devolve a opção com o número exato, ou null se o número não estiver mapeado.
async function nominatimExact(q) {
  const num = houseNumberOf(q);
  const [hit] = await nominatimSearch({ q, addressdetails: 1, viewbox: bboxAround(40) });
  const a = hit?.address || {};
  if (!hit || !num || !a.house_number || !new RegExp(`(^|\D)${num}(\D|$)`).test(a.house_number)) return null;
  const road = a.road || a.pedestrian || hit.name;
  const place = [a.suburb || a.neighbourhood, a.city || a.town || a.village].filter(Boolean).join(' · ');
  return { lat: +hit.lat, lng: +hit.lon, title: `${road}, ${num}`, sub: place, exact: true };
}

// ==== BUSCA: PHOTON ====
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
    `<li role="option" data-i="${i}" class="${i === activeIdx ? 'active' : ''}">${esc(s.title)}${s.exact ? '<span class="tag">· número exato</span>' : ''}<small>${esc(s.sub || '')}</small></li>`).join('');
}
function chooseSuggestion(i) {
  const s = suggestions[i];
  if (!s) return;
  suggestions = []; activeIdx = -1; renderSuggestions();
  $('#search').value = s.title;
  setPoint(s.lat, s.lng, [s.title, s.sub].filter(Boolean).join(' · '));
}

// Busca explícita (botão "Buscar" ou Enter): junta as fontes e mostra opções; o pin só muda quando a pessoa escolhe.
async function runSearch() {
  const q = $('#search').value.trim();
  if (!isCep(q) && q.length < 3) return setStatus('search-status', 'Digite pelo menos 3 letras, ou um CEP.');
  const seq = ++searchSeq;
  suggestions = []; activeIdx = -1; renderSuggestions();
  $('#search-wrap').classList.add('loading');
  setStatus('search-status', isCep(q) ? 'Buscando CEP…' : 'Buscando…', 'loading');
  try {
    let opts;
    if (isCep(q)) {
      const r = await resolveCep(q);
      opts = [{ lat: r.lat, lng: r.lng, title: r.label.replace(/\s*\(CEP.*$/, ''), sub: r.label.match(/\(CEP.*\)$/)?.[0] || '' }];
    } else {
      const num = houseNumberOf(q);
      const [photon, exact] = await Promise.all([photonSearch(q), num ? nominatimExact(q).catch(() => null) : null]);
      opts = photon;
      if (exact && !photon.some((p) => p.exact)) opts = [exact, ...photon];
      // Número não mapeado em nenhuma fonte: oferece a rua sem número (o Photon prioriza a região do mapa).
      if (num && !opts.some((p) => p.exact)) {
        const street = await photonSearch(q.replace(new RegExp(`(?:n[º°o.]?\s*)?\b${num}\b`, 'i'), ' ')).catch(() => []);
        const extra = street.slice(0, 3).map((s) => ({ ...s, sub: `${s.sub} · nº ${num} não mapeado; depois arraste o pin para ajustar` }));
        opts = [...extra, ...opts.filter((o) => !extra.some((e) => Math.abs(e.lat - o.lat) < 1e-4 && Math.abs(e.lng - o.lng) < 1e-4))];
      }
    }
    if (seq !== searchSeq) return;
    suggestions = opts.slice(0, 8);
    renderSuggestions();
    setStatus('search-status', suggestions.length ? `${suggestions.length} ${suggestions.length === 1 ? 'opção' : 'opções'}: escolha uma.` : 'Nada encontrado. Tente com cidade ou bairro.');
    if (suggestions.length) reveal('#suggestions', 'nearest');
  } catch (e) {
    if (seq === searchSeq) setStatus('search-status', e.message, true);
  } finally {
    if (seq === searchSeq) $('#search-wrap').classList.remove('loading');
  }
}

$('#search-go').addEventListener('click', runSearch);
$('#search').addEventListener('input', () => {
  // Digitar invalida a lista anterior; nada é buscado até clicar em "Buscar".
  searchSeq++;
  $('#search-wrap').classList.remove('loading');
  if (suggestions.length) { suggestions = []; renderSuggestions(); setStatus('search-status', ''); }
});
$('#search').addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestions.length) {
    e.preventDefault();
    activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeIdx >= 0) chooseSuggestion(activeIdx); else runSearch(); // Enter = atalho do botão "Buscar"
  } else if (e.key === 'Escape') { suggestions = []; renderSuggestions(); }
});
$('#suggestions').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) chooseSuggestion(+li.dataset.i);
});
