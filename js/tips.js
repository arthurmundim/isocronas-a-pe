'use strict';
// ==== SUGESTÕES (MOTOR DE REGRAS) ====
// Cada regra lê só os fatos de buildFacts() e devolve zero ou mais dicas:
// { icon, title, text, styles: [] = geral (sempre aparece) | ids de PHOTO_STYLES, score, at?: [lng, lat] }.

const listNames = (arr, n = 3) => {
  const names = [...new Set(arr)];
  return names.slice(0, n).join(', ') + (names.length > n ? ` e mais ${names.length - n}` : '');
};
// Um trecho por rua (o primeiro), para não repetir nomes nas dicas.
const byStreet = (trechos) => {
  const named = trechos.filter((t) => !t.rua.startsWith('calçada'));
  const list = named.length ? named : trechos;
  return list.filter((t, i) => list.findIndex((x) => x.rua === t.rua) === i);
};
const ptsOf = (f, cats) => f._pontos.filter((p) => cats.includes(p.cat));
const ptsText = (pts) => listNames(pts.map((p) => `${p.nome} (~${p.hora_aprox})`), 3);
// Céu quase todo coberto: sem sol direto, então regras de direção do sol não se aplicam.
const sunBlocked = (f) => f.nuvens?.total_pct >= 85;

const RULES = [
  // ---- Gerais: horário e luz ----
  (f) => {
    const fase = f.luz.na_chegada.fase;
    if (fase === 'golden hour') return { icon: '✨', title: 'Você chega em plena golden hour', score: 100,
      text: sunBlocked(f)
        ? `Mas com ${f.nuvens.total_pct}% de nuvens a luz deve chegar difusa: menos sombras longas, e a cor vem mais do céu do que do sol.`
        : 'Luz quente e baixa, sombras longas: o melhor momento do dia para quase tudo. Não perca tempo procurando, a janela é curta.' };
    if (fase === 'blue hour') return { icon: '💙', title: 'Você chega em plena blue hour', score: 100,
      text: 'Céu azul profundo com as luzes da cidade acesas. Dura poucos minutos: chegue já sabendo o enquadramento.' };
  },
  (f) => {
    const n = f.luz.proximo_evento;
    if (!n || n.minutos_apos_chegada > 60) return;
    return { icon: '⏱️', title: `${n.evento[0].toUpperCase() + n.evento.slice(1)} ${n.minutos_apos_chegada} min depois de chegar (${n.hora})`, score: 95,
      text: n.minutos_apos_chegada >= 15 ? 'Dá tempo de explorar o entorno e escolher o enquadramento antes da luz mudar.' : 'Margem curta: vá direto para o ponto e já se posicione.' };
  },
  (f) => f.luz.eventos_durante.length && { icon: '🔄', title: 'A luz muda durante a caminhada', score: 85,
    text: f.luz.eventos_durante.map((e) => `${e.evento} às ${e.hora}`).join('; ') + '. Os trechos finais vão ter outra cor e outro contraste que os iniciais.' },
  (f) => {
    const c = f.luz.na_chegada;
    if (!['sol alto', 'sol a pino'].includes(c.fase) || (f.nuvens && f.nuvens.total_pct >= 60)) return;
    const g = f.luz.horarios_do_dia.golden_tarde;
    return { icon: '🕶️', title: 'Luz dura na chegada', score: 70,
      text: `Sol a ${c.altitude_sol}°: contraste forte e sombras pretas. Procure sombra aberta, reflexos e interiores${g ? `, ou ajuste para chegar na golden hour (${g})` : ''}.` };
  },
  (f) => f.luz.na_chegada.fase === 'noite' && { icon: '🌃', title: 'Já é noite na chegada', score: 65,
    text: 'Vitrines, letreiros, faróis e poças refletindo luz. Prefira ruas movimentadas e iluminadas; segure a câmera apoiada ou suba o ISO.' },
  (f) => {
    const n = f.nuvens;
    if (!n) return;
    const sunset = ['golden hour', 'blue hour'].includes(f.luz.na_chegada.fase) || /pôr|golden|blue/.test(f.luz.proximo_evento?.evento || '');
    // Nuvens altas pegam cor no pôr; um véu total (> 85%) ou muitas baixas tendem a apagar o sol.
    if (sunset && n.altas_pct >= 40 && n.baixas_pct < 40 && n.total_pct <= 85) return { icon: '🌅', title: 'Chance de céu colorido', score: 82,
      text: `${n.altas_pct}% de nuvens altas e poucas baixas: elas costumam pegar cor no pôr do sol. Deixe céu no quadro.` };
    if (n.total_pct >= 75) return { icon: '☁️', title: 'Céu fechado, luz difusa', score: 60,
      text: `${n.total_pct}% de cobertura: luz suave e sem sombras, ótima para retratos, cores saturadas e murais. Sol direto e pôr do sol provavelmente encobertos.` };
    if (n.total_pct < 20) return { icon: '☀️', title: 'Céu limpo', score: 50,
      text: 'Sombras nítidas e contraste alto. No pôr do sol, pouca nuvem para dar cor ao céu.' };
  },
  (f) => f.elevacao?.subida_m >= 40 && { icon: '⛰️', title: `Subida de ${f.elevacao.subida_m} m no trajeto`, score: 55,
    text: 'O ritmo cai nas ladeiras e a caminhada pode levar mais que o previsto. Saia com folga para não perder a luz.' },

  // ---- Direção do sol × ruas ----
  (f) => {
    if (sunBlocked(f)) return;
    const c = byStreet(f.trechos.filter((t) => t.corredor_de_luz));
    return c.length && { icon: '🔆', title: `Corredor de luz: ${listNames(c.map((t) => t.rua))}`, score: 92, styles: ['street', 'paisagem', 'minimal'],
      text: `Rua alinhada com o sol baixo (a partir de ${c[0].inicio}): a luz atravessa a rua inteira. Fique no eixo da rua para pegar o sol entre os prédios.` };
  },
  (f) => {
    if (sunBlocked(f)) return;
    const c = byStreet(f.trechos.filter((t) => t.luz.startsWith('contraluz') && t.altitude_sol > -1 && t.altitude_sol < 25));
    if (!c.length) return;
    const where = listNames(c.map((t) => `${t.rua} (${t.inicio})`));
    return [
      { icon: '🌇', title: `Contraluz em ${where}`, score: 84, styles: ['street'], text: 'Você anda em direção ao sol baixo: silhuetas de pedestres, reflexos no asfalto e flare. Exponha para as altas luzes.' },
      { icon: '🧑', title: `Contraluz para retrato: ${where}`, score: 80, styles: ['retrato'], text: 'Coloque a pessoa de costas para o sol para um contorno de luz no cabelo e exponha para o rosto (ou use um rebatedor).' },
    ];
  },
  (f) => {
    if (sunBlocked(f)) return;
    const c = byStreet(f.trechos.filter((t) => t.fachadas_iluminadas && t.altitude_sol > 0 && t.altitude_sol < 25));
    return c.length && { icon: '🏢', title: 'Fachadas com luz rasante', score: 86, styles: ['arquitetura'],
      text: `${listNames(c.map((t) => `${t.rua}: ${t.fachadas_iluminadas}`))}. Luz quente e de lado revela textura; fotografe da calçada oposta.` };
  },
  (f) => !sunBlocked(f) && f.trechos.some((t) => t.altitude_sol > 0 && t.altitude_sol < 15) && { icon: '📏', title: 'Sombras longas', score: 75, styles: ['minimal', 'street'],
    text: 'Sol abaixo de 15°: sombras de pessoas e postes se esticam pela calçada. Procure fundos claros e lisos e enquadre de cima.' },
  (f) => ['sol alto', 'sol a pino'].includes(f.luz.na_chegada.fase) && !(f.nuvens?.total_pct >= 60) && { icon: '◼️', title: 'Sombras duras para geometria', score: 60, styles: ['minimal'],
    text: 'Sol alto e céu aberto: sombras curtas e recortadas. Bom para composições gráficas e preto e branco.' },

  // ---- Lugares no caminho (Overpass, a até 60 m da rota) ----
  (f) => {
    const p = ptsOf(f, ['viewpoint']);
    return p.length && { icon: '🔭', title: `Mirante no caminho: ${ptsText(p)}`, score: 88, styles: ['paisagem'], at: [p[0].lng, p[0].lat],
      text: 'Vista aberta da cidade. Com sol baixo, o lado oposto ao sol fica com luz quente; contra o sol, silhuetas do skyline.' };
  },
  (f) => {
    const e = f.elevacao;
    if (!e || e.max_m - e.min_m < 15) return;
    return { icon: '⛰️', title: `Ponto mais alto aos ${e.ponto_mais_alto.a_partir_do_inicio_m} m (~${e.ponto_mais_alto.hora_aprox})`, score: 62, styles: ['paisagem'],
      text: `${e.max_m - e.min_m} m acima do ponto mais baixo do trajeto: costuma ter a vista mais aberta da caminhada.` };
  },
  (f) => {
    const p = ptsOf(f, ['historic', 'worship']).filter((x) => x.scene === 'arquitetura'); // monumentos e placas vão com as obras
    return p.length && { icon: '🏛️', title: `${p.length} ${p.length === 1 ? 'construção histórica' : 'construções históricas'} no caminho`, score: 72, styles: ['arquitetura'],
      at: [p[0].lng, p[0].lat], text: `${ptsText(p)}.` };
  },
  (f) => {
    const p = f._pontos.filter((x) => x.scene === 'obra');
    if (!p.length) return;
    const hard = ['sol alto', 'sol a pino'].includes(f.luz.na_chegada.fase) && !(f.nuvens?.total_pct >= 60);
    return { icon: '🎨', title: `${p.length} ${p.length === 1 ? 'obra ou monumento' : 'obras e monumentos'} no caminho`, score: 80, styles: ['arte', 'street'], at: [p[0].lng, p[0].lat],
      text: `${ptsText(p)}.${hard ? ' Com sol forte, murais rendem melhor na sombra inteira: sol parcial cria manchas.' : ''}` };
  },
  (f) => {
    const p = ptsOf(f, ['park']);
    if (!p.length) return;
    const low = f.trechos.some((t) => t.altitude_sol > 0 && t.altitude_sol < 20);
    return [
      { icon: '🌳', title: `Verde no caminho: ${ptsText(p)}`, score: 70, styles: ['natureza'], at: [p[0].lng, p[0].lat],
        text: low ? 'Sol baixo atravessando folhas: contraluz, poeira e insetos brilhando.' : 'Procure detalhes: texturas de casca, folhas contra o céu, flores.' },
      { icon: '🧑', title: `Fundo verde para retrato: ${p[0].nome}`, score: 60, styles: ['retrato'], at: [p[0].lng, p[0].lat],
        text: 'Sombra de árvore = sombra aberta: luz suave no rosto e fundo desfocado.' },
    ];
  },
  (f) => {
    const p = ptsOf(f, ['fountain']);
    return p.length && { icon: '⛲', title: `Água no caminho: ${ptsText(p)}`, score: 58, styles: ['noturna', 'minimal'], at: [p[0].lng, p[0].lat],
      text: 'Reflexos e, com apoio, longa exposição para a água ficar sedosa.' };
  },
  (f) => {
    const p = ptsOf(f, ['cafe']);
    return p.length >= 2 && { icon: '☕', title: `${p.length} cafés no caminho`, score: 52, styles: ['street'], at: [p[0].lng, p[0].lat],
      text: 'Cenas de gente em mesas e vitrines; à noite, a luz quente de dentro contrasta com a rua.' };
  },

  // ---- Por estilo, a partir da fase de luz ----
  (f) => {
    const fase = f.luz.na_chegada.fase, b = f.luz.horarios_do_dia.blue_hour;
    if (!['blue hour', 'noite'].includes(fase) && !/blue/.test(f.luz.proximo_evento?.evento || '')) return;
    return { icon: '🌃', title: `Blue hour${b ? ` às ${b}` : ''}`, score: 86, styles: ['noturna', 'arquitetura', 'paisagem'],
      text: 'Fachadas e postes acesos contra o céu ainda azul. Use apoio, ISO alto sem medo e exponha para o céu.' };
  },
  (f) => f.luz.na_chegada.fase === 'golden hour' && { icon: '🧑', title: 'Golden hour para retrato', score: 82, styles: ['retrato'],
    text: 'Pele quente e sombras suaves. Luz lateral para volume ou contraluz para contorno.' },
  (f) => f.nuvens?.total_pct >= 75 && { icon: '🧑', title: 'Céu encoberto = softbox gigante', score: 66, styles: ['retrato', 'arte'],
    text: 'Luz uniforme e sem sombra dura em qualquer direção: liberdade total de posição.' },
];

function generateTips(f) {
  const tips = [];
  for (const rule of RULES) {
    const r = rule(f);
    if (r) tips.push(...[].concat(r));
  }
  return tips.map((t) => ({ styles: [], ...t }));
}

function renderTips(f) {
  const all = generateTips(f);
  const chosen = state.styles;
  // Gerais sempre; específicas só para os estilos marcados. Uma dica de vários estilos aparece uma vez.
  const tips = all.filter((t) => !t.styles.length || t.styles.some((s) => chosen.has(s)))
    .sort((a, b) => b.score - a.score).slice(0, AI.sizes[aiState.size].tips);
  const label = (id) => PHOTO_STYLES.find((s) => s.id === id)?.label;
  $('#tips').innerHTML = (tips.length ? tips.map((t) => `<li ${t.at ? `data-lng="${t.at[0]}" data-lat="${t.at[1]}" title="Ver no mapa"` : ''}>
      <span class="ic">${t.icon}</span><div><b>${esc(t.title)}</b><p>${esc(t.text)}</p>
      ${t.styles.length ? `<span class="tag">${esc(t.styles.filter((s) => chosen.has(s)).map(label).join(' · '))}</span>` : ''}</div></li>`).join('')
    : '<li><span class="ic">🤷</span><div><p>Nada de especial nesse horário. Teste outro horário nos atalhos acima.</p></div></li>')
    + (chosen.size ? '' : '<li><span class="ic">👆</span><div><p>Marque seus estilos de foto acima para receber dicas específicas.</p></div></li>');
}
$('#tips').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-lng]');
  if (li) map.easeTo({ center: [+li.dataset.lng, +li.dataset.lat], zoom: Math.max(map.getZoom(), 17), padding: mapPadding() });
});
