'use strict';
// ==== FLUXO EM ETAPAS ====
// search → walk → (destino no mapa) → when → styles → suggest. Concluir uma etapa a minimiza numa linha de resumo
// clicável (reabre para editar) e abre a próxima. "pois" e "light" ficam fora do fluxo: aparecem com o ponto,
// minimizam quando há rota (os dados deles seguem nas sugestões/prompt) e reabrem quando a rota é limpa.
const stepEl = (n) => document.querySelector(`.step[data-step="${n}"]`);
const fmtDay = (d) => d.split('-').reverse().slice(0, 2).join('/');
const fmtNum = (x) => String(x).replace('.', ',');

function lightSummary() {
  const a = lightAnchor();
  if (!a) return '☀️ Luz para foto';
  const s = sunTimes(state.date, a.lat, a.lng);
  const c = cloudsBetween(s.goldenHour, s.sunset);
  return `☀️ ${fmtDay(state.date)} · golden ${fmtTime(s.goldenHour)} · pôr do sol ${fmtTime(s.sunset)}${c ? ` · nuvens ${c.total}%` : ''}`;
}
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
  light: lightSummary,
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
}
function hideStep(n) {
  const el = stepEl(n);
  el.hidden = true;
  el.classList.remove('collapsed');
}

// "Continuar" de cada etapa.
const NEXT_STEP = { when: 'styles', styles: 'suggest' };
function completeStep(n) {
  collapseStep(n);
  if (n === 'walk') {
    if (!state.routeTarget) { $('#sec-dest').hidden = false; reveal('#sec-dest'); }
    return;
  }
  const next = NEXT_STEP[n];
  if (!next) return;
  if (stepEl(next).hidden) openStep(next);
  reveal(stepEl(next));
}

// ---- Eventos do fluxo ----
function flowNewPoint() {
  collapseStep('search');
  openStep('walk');
  $('#sec-dest').hidden = true;
  openStep('pois');
  openStep('light');
}
function flowRouteStart() {
  collapseStep('walk');
  $('#sec-dest').hidden = true;
  collapseStep('pois');
  collapseStep('light');
  openStep('when');
  hideStep('styles');
  hideStep('suggest');
}
function flowRouteCleared() {
  openStep('pois');
  openStep('light');
  if (stepEl('walk').classList.contains('collapsed')) $('#sec-dest').hidden = false;
}

document.querySelectorAll('.step-summary').forEach((b) => b.addEventListener('click', () => openStep(b.closest('.step').dataset.step)));
document.querySelectorAll('.step-next').forEach((b) => b.addEventListener('click', () => completeStep(b.dataset.next)));
