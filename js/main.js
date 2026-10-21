'use strict';
// ==== PAINEL MOBILE (BOTTOM SHEET) ====
$('#sheet-handle').addEventListener('click', () => {
  const p = $('#panel');
  if (p.classList.contains('collapsed')) p.classList.remove('collapsed');
  else if (p.classList.contains('expanded')) { p.classList.remove('expanded'); p.classList.add('collapsed'); }
  else p.classList.add('expanded');
});

// ==== INICIALIZAÇÃO ====
syncControls();
styleToggle.render();
renderLegend();
renderPois();
updateLight();
if (initialHash.point) setPoint(initialHash.point.lat, initialHash.point.lng, initialHash.point.label, { fly: false });
else writeHash();
