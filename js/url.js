'use strict';
// ==== ESTADO NA URL ====
// #lat=..&lng=..&q=rótulo&t=5,10,15,20&v=5&h=0.5&cat=viewpoint,cafe&d=2026-10-21&s=dark
function parseHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const num = (k) => (p.has(k) ? parseFloat(p.get(k)) : NaN);
  const out = {};
  const lat = num('lat'), lng = num('lng');
  if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) out.point = { lat, lng, label: p.get('q') || null };
  const times = parseTimes(p.get('t') || '');
  if (times.length) out.times = times;
  if (!isNaN(num('v'))) out.speed = paceOf(num('v')).v;
  if (!isNaN(num('h'))) out.hills = num('h') >= 0.75 ? 1 : 0.5;
  if (p.has('cat')) out.cats = new Set(p.get('cat').split(',').filter((c) => CATEGORIES.some((x) => x.id === c)));
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.get('d') || '')) out.date = p.get('d');
  out.style = p.get('s') === 'dark' ? 'dark' : 'light';
  return out;
}
function applyHashToState(h) {
  state.times = h.times || [5, 10, 15, 20];
  state.speed = h.speed ?? 4.5;
  state.hills = h.hills ?? 0.5;
  state.cats = h.cats || new Set(CATEGORIES.map((c) => c.id));
  state.date = h.date || todayStr();
  state.style = h.style;
}
function syncControls() {
  $('#times').value = state.times.join(', ');
  renderPace();
  $('#hills').checked = state.hills > 0.5;
  $('#date').value = state.date;
}

let lastHash = location.hash.slice(1), hashTimer;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = new URLSearchParams();
    if (state.point) {
      p.set('lat', state.point.lat.toFixed(5)); p.set('lng', state.point.lng.toFixed(5));
      if (state.point.label) p.set('q', state.point.label.split(' · ')[0]); // só o nome, para o link ficar curto
    }
    p.set('t', state.times.join(','));
    p.set('v', state.speed);
    if (state.hills > 0.5) p.set('h', 1);
    if (state.cats.size !== CATEGORIES.length) p.set('cat', [...state.cats].join(','));
    if (state.date !== todayStr()) p.set('d', state.date);
    if (state.style !== 'light') p.set('s', state.style);
    lastHash = p.toString().replace(/%2C/g, ',');
    try { history.replaceState(null, '', '#' + lastHash); } catch { location.hash = lastHash; }
  }, 300);
}

// Editar o hash à mão (ou voltar no histórico) reaplica a exploração.
window.addEventListener('hashchange', () => {
  const raw = location.hash.slice(1);
  if (raw === lastHash) return;
  lastHash = raw;
  const h = parseHash();
  const prevStyle = state.style;
  applyHashToState(h);
  state.style = prevStyle;
  syncControls();
  setMapStyle(h.style);
  renderLegend();
  if (h.point && (h.point.lat !== state.point?.lat || h.point.lng !== state.point?.lng)) {
    setPoint(h.point.lat, h.point.lng, h.point.label, { fly: false });
  } else {
    computeIsochrones();
    updateLight();
  }
});

$('#share').addEventListener('click', async () => {
  writeHash();
  await new Promise((r) => setTimeout(r, 350));
  try { await navigator.clipboard.writeText(location.href); toast('Link copiado.', 'info', 2500); }
  catch { toast('Não consegui copiar; o link está na barra de endereço.', 'info'); }
});

