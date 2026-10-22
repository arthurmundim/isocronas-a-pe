'use strict';
// ==== GLOSSÁRIO ====
// Os termos técnicos ficam na interface; aqui cada um tem uma explicação curta, sem jargão.
const GLOSSARY = [
  ['Mancha (isócrona)', 'As ruas que você alcança a pé a partir do ponto de partida, coloridas pelo tempo: quanto mais escura a cor, mais longe. "Isócrona" quer dizer "mesmo tempo".'],
  ['Tempos de caminhada', 'Até 4 tempos em minutos, separados por vírgula (ex.: 5, 10, 15, 20). Cada um vira uma faixa de cor na mancha.'],
  ['Ritmo', 'Velocidade da caminhada. "Fotografando" considera paradas frequentes; "Apressado" é passo rápido.'],
  ['Evitar ladeiras', 'Prefere ruas mais planas, mesmo que o caminho fique um pouco mais longo.'],
  ['Perfil de elevação', 'Gráfico de subidas e descidas da rota: ↑ é quanto você sobe no total e ↓ quanto desce.'],
  ['Pontos para fotografar', 'Mirantes, arte urbana, patrimônio, igrejas, fontes, parques e cafés dentro da mancha. Vêm do OpenStreetMap, um mapa colaborativo: alguns lugares podem faltar.'],
  ['Golden hour (hora dourada)', 'Pouco antes do pôr do sol e pouco depois do nascer: sol baixo, luz quente e lateral, sombras longas. É a luz mais procurada para fotos.'],
  ['Blue hour (hora azul)', 'Logo depois do pôr do sol (ou antes do nascer): o céu fica azul profundo e as luzes da cidade já estão acesas.'],
  ['Sol alto / sol a pino', 'Perto do meio-dia: luz dura, de cima, com sombras curtas e contraste forte.'],
  ['Contraluz', 'Fotografar na direção do sol. Gera silhuetas e bordas iluminadas; o rosto ou a fachada ficam escuros se você não compensar.'],
  ['Nuvens baixas / altas', 'Nuvens baixas costumam tapar o sol. Nuvens altas e finas deixam o sol passar e podem deixar o céu colorido no pôr do sol.'],
  ['ISO', 'Sensibilidade da câmera à luz. Número baixo (100) = imagem limpa, pede mais luz. Número alto (3200) = funciona com pouca luz, mas com mais granulado.'],
  ['Aperture (abertura, f/)', 'O tamanho da abertura da lente. f/ com número pequeno (f/2) deixa entrar mais luz e desfoca o fundo; número grande (f/8) deixa mais coisas em foco.'],
  ['Shutter Speed (velocidade do obturador)', 'Por quanto tempo a câmera capta luz. 1/250 s congela quem anda; 1/30 s ou mais lento pede mão firme ou apoio, e borra o que se move.'],
  ['EV (compensação de exposição)', 'Ajuste para deixar a foto mais clara (+) ou mais escura (−) do que a câmera escolheria sozinha.'],
  ['Dicas rápidas x Roteiro com IA', 'As dicas rápidas são calculadas por regras, na hora. O roteiro com IA escreve um texto em ordem de horário, no seu próprio aparelho (nada é enviado a servidor).'],
];
$('#glossary-list').innerHTML = GLOSSARY.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join('');
const glossary = $('#glossary');
glossary.querySelector('[data-close]').addEventListener('click', () => glossary.close());
glossary.addEventListener('click', (e) => { if (e.target === glossary) glossary.close(); }); // clique fora do conteúdo
mapTools.add('Explicação dos termos usados no app', () => glossary.showModal()).textContent = '📖 Glossário';

// ==== TOUR GUIADO ====
// Só quando a pessoa pede (botão no mapa). Cada passo destaca um elemento visível; sem alvo visível, o cartão fica no centro.
const TOUR = [
  { sel: '#panel', text: 'Este painel guia a exploração em etapas. Cada etapa concluída vira uma linha de resumo: toque nela para editar.' },
  { sel: '#sec-search .search-row', text: 'Comece pelo ponto de partida: endereço, lugar ou CEP, e depois "Buscar". Também dá para tocar direto no mapa.' },
  { sel: '.maplibregl-ctrl-geolocate', text: 'Ou use ◎ para partir de onde você está agora.' },
  { sel: '#map', text: 'O mapa mostra a mancha: as ruas que você alcança a pé, coloridas pelo tempo. Depois, toque numa rua colorida ou num ícone para escolher o destino e ver a rota.' },
  { sel: '#sec-iso', text: 'Depois de escolher o ponto aparece a Caminhada: ali você ajusta os tempos, o ritmo e se quer evitar ladeiras.' },
  { sel: '#trip', text: 'Com o destino escolhido: dia e horário, a luz para foto e as nuvens, e os seus estilos de foto. No fim, peça dicas rápidas ou um roteiro com IA.' },
  { sel: '.map-tools', text: 'Aqui ficam o tema claro/escuro, este glossário de termos e o tour.' },
  { sel: '#share', text: 'Copie o link para guardar ou mandar a exploração: ele leva o ponto, o destino e o horário.' },
];
let tourSteps = [], tourIdx = 0;
const visibleRect = (sel) => {
  const el = $(sel);
  if (!el || el.closest('[hidden]')) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? r : null;
};
function tourShow() {
  const step = tourSteps[tourIdx];
  const r = visibleRect(step.sel);
  const hole = $('#tour-hole'), card = $('#tour-card');
  if (r) {
    const pad = 6;
    Object.assign(hole.style, { display: '', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  } else Object.assign(hole.style, { left: '50%', top: '50%', width: '0px', height: '0px' }); // sem alvo: só escurece
  $('#tour-text').textContent = step.text;
  $('#tour-count').textContent = `${tourIdx + 1} de ${tourSteps.length}`;
  $('#tour-prev').disabled = tourIdx === 0;
  $('#tour-next').textContent = tourIdx === tourSteps.length - 1 ? 'Concluir' : 'Próximo';
  // Cartão abaixo do destaque, acima se não couber, ou no centro (destaque grande ou sem alvo).
  const W = innerWidth, H = innerHeight, cw = card.offsetWidth, ch = card.offsetHeight, m = 12;
  let top, left;
  if (!r || (r.bottom + ch + m > H && r.top - ch - m < 0)) { top = (H - ch) / 2; left = (W - cw) / 2; }
  else {
    top = r.bottom + ch + m <= H ? r.bottom + m : r.top - ch - m;
    left = Math.min(Math.max(m, r.left + r.width / 2 - cw / 2), W - cw - m);
  }
  Object.assign(card.style, { top: `${Math.max(m, top)}px`, left: `${Math.max(m, left)}px` });
}
function tourStart() {
  glossary.close();
  // No celular o painel volta ao tamanho normal para os passos dele aparecerem.
  const p = $('#panel'), resized = isMobile() && /peek|collapsed|expanded/.test(p.className);
  p.classList.remove('peek', 'collapsed', 'expanded');
  // Etapas ainda ocultas também entram (cartão no centro, sem destaque), para a pessoa saber o que vem depois.
  tourSteps = TOUR;
  tourIdx = 0;
  $('#tour').hidden = false;
  setTimeout(() => { tourShow(); $('#tour-next').focus(); }, resized ? 230 : 0); // espera a transição do painel
}
function tourEnd() { $('#tour').hidden = true; }
$('#tour-next').addEventListener('click', () => (tourIdx < tourSteps.length - 1 ? (tourIdx++, tourShow()) : tourEnd()));
$('#tour-prev').addEventListener('click', () => { if (tourIdx > 0) { tourIdx--; tourShow(); } });
$('#tour-close').addEventListener('click', tourEnd);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#tour').hidden) tourEnd(); });
window.addEventListener('resize', () => { if (!$('#tour').hidden) tourShow(); });
mapTools.add('Tour guiado pelas partes do app', tourStart).textContent = '🧭 Tour';
