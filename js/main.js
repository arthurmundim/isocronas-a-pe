'use strict';
// ==== PAINEL MOBILE (BOTTOM SHEET) ====
// Alças: recolhido → normal → expandido → recolhido. O modo "peek" (mapa em destaque) conta como normal.
$('#sheet-handle').addEventListener('click', () => {
  const p = $('#panel');
  if (p.classList.contains('peek')) p.classList.remove('peek');
  else if (p.classList.contains('collapsed')) p.classList.remove('collapsed');
  else if (p.classList.contains('expanded')) { p.classList.remove('expanded'); p.classList.add('collapsed'); }
  else p.classList.add('expanded');
});
// Um toque no painel o traz de volta do "peek". Na fase de captura, para uma ação do próprio clique poder baixá-lo de novo.
$('#panel').addEventListener('click', (e) => {
  if (!e.target.closest('#sheet-handle')) $('#panel').classList.remove('peek');
}, true);

// ==== INICIALIZAÇÃO ====
syncControls();
styleToggle.render();
renderLegend();
renderPois();
updateLight();
if (initialHash.point) {
  map.jumpTo({ center: [initialHash.point.lng, initialHash.point.lat] });
  if (isMobile()) map.panBy(sheetOffset().map((v) => -v), { duration: 0 }); // ponto acima do painel
  setPoint(initialHash.point.lat, initialHash.point.lng, initialHash.point.label, { fly: false, show: false });
  // Link com destino: refaz a rota e o "Quando?" (o horário veio do hash em applyHashToState).
  if (initialHash.to) showRoute(initialHash.to.lat, initialHash.to.lng, null, { restore: true });
} else writeHash();
