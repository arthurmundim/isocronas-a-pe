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
    if (!state.routeTarget) showPoisStep();
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
    reveal('#sec-dest');
    return;
  }
  $('#dest-hint').hidden = false;
  openStep('pois');
  reveal(stepEl('pois'));
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
  $('#sec-dest').hidden = true;
  hideStep('pois');
}
function flowRouteStart() {
  collapseStep('walk');
  awaitingPois = false;
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
