'use strict';
// ==== FLUXO EM ETAPAS ====
// search → walk → pois (aparece só depois que os pontos carregam no mapa; ali se escolhe o destino) → when (data, hora
// e luz/nuvens do dia) → styles → suggest. Concluir uma etapa a minimiza numa linha de resumo clicável (reabre para
// editar) e abre a próxima; etapas futuras ficam ocultas.
const stepEl = (n) => document.querySelector(`.step[data-step="${n}"]`);
const fmtDay = (d) => d.split('-').reverse().slice(0, 2).join('/');
const fmtNum = (x) => String(x).replace('.', ',');

const STEP_SUMMARY = {
  search: () => `📍 ${esc(state.point?.label?.split(' · ')[0] || (state.point ? `${state.point.lat.toFixed(4)}, ${state.point.lng.toFixed(4)}` : 'escolha um ponto'))}`,
  walk: () => `🚶 até ${state.times.join('/')} min · ${paceOf(state.speed).label} (${fmtNum(state.speed)} km/h)${state.hills > 0.5 ? ' · evitando ladeiras' : ''}`,
  when: () => {
    const t = tripTimes();
    return t ? `🕒 ${fmtDay(state.date)} · sai ${hhmm(t.leave)} → chega ${hhmm(t.arrive)}` : '🕒 escolha o horário';
  },
  styles: () => `📷 ${esc(PHOTO_STYLES.filter((s) => state.styles.has(s.id)).map((s) => s.label).join(', ') || 'sem preferência de estilo')}`,
  suggest: () => `${aiState.mode === 'ai' ? '✨ Texto com IA' : '⚡ Resposta rápida'} · ${AI.sizes[aiState.size].label}`,
  pois: () => (poiLoading ? '📸 Pontos para fotografar: carregando…' : `📸 ${state.pois.length} pontos para fotografar na área`),
  route: () => `🗺️ Rota até ${esc((state.trip && buildFacts()?.destino.nome) || 'o destino')} · ${esc($('#route-summary').textContent || 'calculando…')}`,
};

function refreshSummary(n) {
  const el = stepEl(n);
  if (el) el.querySelector('.step-summary .txt').innerHTML = STEP_SUMMARY[n]();
}
function refreshSummaries() {
  document.querySelectorAll('.step.collapsed').forEach((el) => refreshSummary(el.dataset.step));
}
function collapseStep(n) {
  const el = stepEl(n);
  el.hidden = false;
  el.classList.add('collapsed');
  refreshSummary(n);
}
function openStep(n) {
  const el = stepEl(n);
  el.hidden = false;
  el.classList.remove('collapsed');
  // O perfil de elevação é desenhado num canvas: minimizado ele tem largura 0, então redesenha ao reabrir.
  if (n === 'route' && state.trip?.elev) drawElevation(state.trip.elev.pts);
}
function hideStep(n) {
  const el = stepEl(n);
  el.hidden = true;
  el.classList.remove('collapsed');
}

// "Continuar" de cada etapa.
const NEXT_STEP = { when: 'styles', styles: 'suggest' };
let awaitingPois = false; // Caminhada concluída, esperando os pontos carregarem para abrir a etapa de destino
function completeStep(n) {
  collapseStep(n);
  if (n === 'walk') {
    if (!state.routeTarget) {
      // Pontos não carregados (ex.: a espera foi cancelada): busca de novo; dados já baixados vêm do cache.
      if (!poiLoading && !state.pois.length && state.iso) loadPois();
      showPoisStep();
    }
    return;
  }
  if (n === 'when') collapseStep('route'); // a rota fica visível enquanto se escolhe o horário e minimiza depois
  const next = NEXT_STEP[n];
  if (!next) return;
  if (stepEl(next).hidden) openStep(next);
  reveal(stepEl(next));
}
// Abre "Pontos para fotografar" (onde se escolhe o destino) só quando os pontos já estão no mapa.
function showPoisStep() {
  const loading = poiLoading || !state.iso;
  awaitingPois = loading;
  $('#sec-dest').hidden = !loading;
  if (loading) {
    setStatus('dest-wait', 'Carregando os pontos para fotografar no mapa…', 'loading');
    opStart('pois', '#dest-wait', cancelPoisWait);
    reveal('#sec-dest');
    return;
  }
  opEnd('pois');
  $('#dest-hint').hidden = false;
  openStep('pois');
  reveal(stepEl('pois'));
}
// Cancelar a espera: para o Overpass e volta à Caminhada (o "Continuar" tenta de novo).
function cancelPoisWait() {
  poiSeq++;
  poiLoading = false;
  abortApis(['Overpass']);
  awaitingPois = false;
  $('#sec-dest').hidden = true;
  openStep('walk');
  setStatus('iso-status', 'Carregamento dos pontos cancelado. Clique em "Continuar" para tentar de novo.');
  reveal(stepEl('walk'));
}
// Chamado quando o Overpass termina (com ou sem erro).
function flowPoisLoaded() {
  if (awaitingPois && !state.routeTarget) showPoisStep();
}

// ---- Eventos do fluxo ----
function flowNewPoint() {
  collapseStep('search');
  openStep('walk');
  awaitingPois = false;
  opEnd('pois');
  $('#sec-dest').hidden = true;
  hideStep('pois');
}
function flowRouteStart() {
  collapseStep('walk');
  awaitingPois = false;
  opEnd('pois');
  $('#sec-dest').hidden = true;
  $('#dest-hint').hidden = true;
  collapseStep('pois');
  openStep('route');
  openStep('when');
  hideStep('styles');
  hideStep('suggest');
}
function flowRouteCleared() {
  if (stepEl('walk').classList.contains('collapsed')) showPoisStep();
}

document.querySelectorAll('.step-summary').forEach((b) => b.addEventListener('click', () => openStep(b.closest('.step').dataset.step)));
document.querySelectorAll('.step-next').forEach((b) => b.addEventListener('click', () => completeStep(b.dataset.next)));

// ==== MODO FOCO NO MAPA ====
// Quando a sugestão aparece (rápida ou IA): os pontos citados ficam coloridos e com nome, o resto vira cinza,
// a mancha fica acinzentada e o mapa enquadra a rota. O botão no mapa alterna "Ver tudo" / "Focar no trajeto".
const mapFocus = { available: false, on: false, ids: [] };
function focusIds() {
  const ids = new Set();
  if (aiState.mode === 'ai') qaState.moments.forEach((m) => { if (m.pid) ids.add(m.pid); (m.extraPids || []).forEach((p) => ids.add(p)); });
  else buildFacts()?._pontos.forEach((p) => ids.add(p.id));
  if (state.trip?.dest?.id) ids.add(state.trip.dest.id);
  return [...ids];
}
function applyFocus() {
  if (!map.getLayer('poi')) return;
  const on = mapFocus.on && mapFocus.available;
  const inFocus = ['in', ['get', 'id'], ['literal', on ? mapFocus.ids : []]];
  map.setLayoutProperty('poi', 'icon-image', on
    ? ['case', inFocus, ['concat', 'poi-', ['get', 'cat']], ['concat', 'poi-grey-', ['get', 'cat']]] : ['concat', 'poi-', ['get', 'cat']]);
  map.setLayoutProperty('poi', 'icon-size', on
    ? ['case', inFocus, 1.15, ['interpolate', ['linear'], ['zoom'], 12, 0.55, 16, 0.75]] : ['interpolate', ['linear'], ['zoom'], 12, 0.7, 16, 1]);
  map.setLayoutProperty('poi', 'symbol-sort-key', on ? ['case', inFocus, 0, 100] : ['get', 'prio']);
  map.setPaintProperty('poi', 'icon-opacity', on ? ['case', inFocus, 1, 0.55] : 1);
  map.setFilter('poi-focus-label', inFocus);
  // Mancha: cinza e mais discreta, para a rota (azul) e os pontos citados aparecerem.
  if (map.getLayer('iso-streets')) {
    map.setPaintProperty('iso-streets', 'line-color', on ? '#9aa1ad' : ['get', 'color']);
    setIsoStale(false);
    if (on && !streetsShown) map.setPaintProperty('iso-fill', 'fill-color', '#9aa1ad');
    if (!on) map.setPaintProperty('iso-fill', 'fill-color', ['get', 'color']);
  }
  focusToggle.render();
}
function setFocus(on, { fit = true } = {}) {
  mapFocus.on = on;
  if (on) mapFocus.ids = focusIds();
  applyFocus();
  if (on && fit && state.trip?.line) map.fitBounds(turf.bbox(state.trip.line), { padding: mapPadding(), maxZoom: 17, duration: 700 });
}
// Sugestão na tela: liga o foco. Sai ao trocar de ponto, de destino ou de sugestão.
function flowSuggestionShown() {
  mapFocus.available = true;
  setFocus(true);
}
function focusReset() {
  mapFocus.available = false;
  setFocus(false, { fit: false });
}

class FocusToggle {
  onAdd() {
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.el.innerHTML = '<button class="map-btn" type="button"></button>';
    this.el.firstChild.addEventListener('click', () => setFocus(!mapFocus.on));
    this.render();
    return this.el;
  }
  render() {
    if (!this.el) return;
    this.el.hidden = !mapFocus.available;
    this.el.firstChild.textContent = mapFocus.on ? '👁 Ver tudo' : '🎯 Focar no trajeto';
    this.el.firstChild.title = mapFocus.on ? 'Mostrar todos os pontos e a mancha colorida' : 'Destacar só o trajeto e os pontos citados';
  }
  onRemove() { this.el.remove(); }
}
const focusToggle = new FocusToggle();
map.addControl(focusToggle, 'top-left');
