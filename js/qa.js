'use strict';
// ==== PERGUNTAS POR MOMENTO (IA) ====
// Não é chat aberto: cada bloco do texto da IA oferece 3 perguntas de um banco do app (a IA só reescreve o texto
// delas para o contexto), a resposta aparece embaixo do bloco e traz 3 novas. Nada que mude o horário: isso se faz no
// "Quando?". Os dados de cada resposta (e qualquer configuração de câmera) são calculados pelo app; o modelo só explica.
// Limite de 5 perguntas por texto gerado, para tudo caber no contexto do modelo.
const QA_MAX = 5;
// pending: reescrita de perguntas em andamento (o motor do WebLLM atende uma requisição por vez).
const qaState = { moments: [], facts: null, asked: 0, blocks: {}, busy: false, pending: null };

function qaReset(moments = [], f = null) {
  Object.assign(qaState, { moments, facts: f, asked: 0, blocks: {}, busy: false, pending: null });
}
const qaBlock = (i) => (qaState.blocks[i] ||= { asked: new Set(), thread: [], offered: [] });
const lower1 = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// ---- Dados determinísticos usados nas respostas ----
const COMPOSE = {
  contraluz: 'Deixe o sol fora do quadro ou escondido atrás de um prédio ou poste; recorte as pessoas contra a parte mais clara do céu ou do chão molhado.',
  fachadas: 'Fotografe da calçada oposta, com a câmera nivelada; enquadre o lado iluminado e deixe a sombra do outro lado dar profundidade.',
  corredor: 'Fique no meio do eixo da rua (com segurança) e alinhe o sol entre os prédios no fim da rua; linhas da calçada levam o olhar até ele.',
  evento: 'Inclua um pedaço de céu no quadro: é ele que muda de cor nesse momento; use postes, letreiros ou fachadas como primeiro plano.',
  cafe: 'De fora, use a vitrine como moldura e brinque com os reflexos; fotografe gente em gestos, sem encarar ninguém de perto.',
  worship: 'Mostre a fachada inteira de frente ou feche num detalhe (portal, torre, vitral); recue para não distorcer as verticais.',
  historic: 'Procure o detalhe que conta a idade do lugar (textura, placa, ornamento) ou a fachada inteira de frente, nivelada.',
  artwork: 'Fotografe de frente para a obra, sem sombra cortando a imagem; inclua uma pessoa passando para dar escala.',
  park: 'Use galhos e folhas como moldura na borda do quadro; procure a luz atravessando as árvores.',
  fountain: 'Fique baixo, perto da água, para pegar reflexos; o fundo iluminado vira desfoque bonito.',
  viewpoint: 'Mantenha o horizonte reto e coloque algo próximo no primeiro plano para dar profundidade à vista.',
};
const STYLE_HINTS = {
  street: 'gestos e encontros de quem passa, silhuetas, reflexos em vitrines e poças, cenas que se repetem (espere alguém entrar no quadro)',
  arquitetura: 'linhas, simetria, texturas de fachada e o contraste entre a parte iluminada e a sombra',
  paisagem: 'a cena inteira com céu, camadas de prédios e uma referência de escala',
  retrato: 'luz suave no rosto (sombra aberta ou vitrine iluminada) e um fundo simples, desfocado',
  noturna: 'luzes acesas contra o céu ainda com cor, rastros de faróis e letreiros',
  minimal: 'formas simples, sombras e espaços vazios; menos elementos no quadro',
  natureza: 'folhas, flores e texturas de troncos, com luz atravessando',
  arte: 'a obra inteira e detalhes de traço e cor, sem sombra cortando',
};
const PHONE = {
  low: 'No celular, use o modo noite e apoie o aparelho (num muro, num poste); evite o zoom digital, que piora o ruído. Toque na parte iluminada da cena para medir a luz por ela.',
  day: 'No celular, toque na parte mais clara da cena para medir a luz por ela e arraste o sol da exposição um pouco para baixo se o céu estourar. Se tiver modo pro, a mesma lógica de ISO baixo e velocidade alta vale.',
};
function lightNow(m) {
  const f = qaState.facts, a = state.routeTarget || state.point;
  if (isLowLight(m.phase)) return `Sem sol direto (${m.phase}): a luz vem do céu ${m.phase === 'blue hour' ? 'ainda azul' : 'escuro'}, de postes, vitrines e letreiros.`;
  if (f.nuvens?.total_pct >= 85) return `Céu ${f.nuvens.total_pct}% encoberto: a luz é difusa, vem do céu inteiro, quase sem sombras.`;
  const d = zonedDate(state.date, m.hora, tzName());
  const s = sunAt(d, a.lat, a.lng);
  const t = f.trechos.filter((x) => x.inicio <= m.hora).at(-1);
  return `Sol a ${Math.round(s.alt)}° de altura, vindo de ${cardinal(s.az)}${t ? `; nesse trecho você anda para ${t.rumo}, então a luz fica como ${t.luz}` : ''}.`;
}

// ---- Banco de perguntas (ordem = prioridade) ----
// applies: se faz sentido para o bloco; data: o que a IA pode usar; cam: configuração mostrada pelo app (opcional).
const QA_BANK = [
  { id: 'why_cam', applies: () => true, text: () => 'Por que essa configuração de câmera aqui?', cam: (m) => m.camera,
    data: (m) => `Configuração: ${camText(m.camera)}. Motivo técnico: ${m.camera.why} Luz no momento: ${m.phase}.` },
  { id: 'outside', applies: (m) => ['cafe', 'worship'].includes(m.cat), text: (m) => `Se eu não entrar em ${m.onde} e ficar do lado de fora, essa configuração funciona?`,
    cam: (m, c) => cameraForScene(m.scene || 'street', m.phase, c.blocked),
    data: (m, c, cam) => `Do lado de fora vale a luz da rua (${m.phase}${c.blocked ? ', céu encoberto' : ''}). Configuração para a rua: ${camText(cam)}. Motivo técnico: ${cam.why}` },
  { id: 'compose', applies: () => true, text: () => 'Como enquadrar essa cena?',
    data: (m) => `O que observar: ${m.ver}. Dica de enquadramento: ${COMPOSE[m.kind] || COMPOSE[m.cat] || (isLowLight(m.phase) ? COMPOSE.evento : 'Escolha um primeiro plano e deixe a luz vir de lado para dar volume.')}` },
  { id: 'iso_low', applies: () => true, cam: (m) => m.camera, text: (m) => (isLowLight(m.phase) ? 'Por que não dá para usar um ISO mais baixo aqui?' : 'Por que o ISO pode ficar baixo aqui?'),
    data: (m) => (isLowLight(m.phase)
      ? `Pouca luz (${m.phase}). ISO menor exigiria velocidade mais lenta (foto tremida ou gente borrada) ou mais abertura do que a lente costuma ter. Configuração: ${camText(m.camera)}. ${m.camera.why}`
      : `Há luz suficiente (${m.phase}): ISO baixo dá menos ruído e mais detalhe, e ainda sobra velocidade. Configuração: ${camText(m.camera)}. ${m.camera.why}`) },
  { id: 'inside', applies: (m) => ['cafe', 'worship', 'historic'].includes(m.cat), text: (m) => `E se eu entrar em ${m.onde}?`,
    cam: () => CAMERA.interior, data: (m, c, cam) => `Lá dentro a luz é artificial e bem mais fraca que a da rua. Configuração para o interior: ${camText(cam)}. Motivo técnico: ${cam.why}` },
  { id: 'light', applies: () => true, text: () => 'De onde vem a luz nesse momento?', data: (m) => lightNow(m) },
  { id: 'cloudy', applies: (m, c) => !isLowLight(m.phase) && !c.blocked, text: () => 'E se o céu fechar nessa hora?',
    cam: () => CAMERA.encoberto, data: (m, c, cam) => `Sem sol direto, a luz fica difusa: somem contraluz, sombras longas e fachadas com luz de lado; as cores ficam mais suaves e uniformes. Configuração com céu fechado: ${camText(cam)}. Motivo técnico: ${cam.why}` },
  { id: 'phone', applies: () => true, text: () => 'E se eu estiver só com o celular?', data: (m) => (isLowLight(m.phase) ? PHONE.low : PHONE.day) },
  ...PHOTO_STYLES.map((s) => ({ id: `style_${s.id}`, applies: (m, c) => c.styles.has(s.id), text: () => `O que procurar aqui para fotos de ${s.label.toLowerCase()}?`,
    data: (m) => `Para ${s.label.toLowerCase()}: ${STYLE_HINTS[s.id]}. Neste momento: ${m.ver}.` })),
];
function qaOptions(i) {
  const m = qaState.moments[i], b = qaBlock(i);
  const c = { blocked: qaState.facts.nuvens?.total_pct >= 85, styles: new Set(qaState.facts._styles) };
  return QA_BANK.filter((q) => !b.asked.has(q.id) && q.applies(m, c)).slice(0, 3).map((q) => ({ id: q.id, text: q.text(m) }));
}

// ---- IA: reescrever perguntas e responder ----
// Palavras que a reescrita pode acrescentar sem mudar o sentido (sem acento, ≥ 4 letras).
const QA_NEUTRAL = ['aqui', 'agora', 'ainda', 'essa', 'esse', 'isso', 'serve', 'sentido', 'enquadro', 'enquadrar', 'configuracao', 'funciona',
  'fico', 'ficar', 'lado', 'fora', 'dentro', 'cena', 'momento', 'foto', 'fotos', 'fotografar', 'fotografo', 'camera', 'melhor', 'posso',
  'devo', 'como', 'qual', 'quais', 'porque', 'motivo', 'nesse', 'neste', 'nessa', 'nesta', 'onde', 'quando', 'entao', 'mesmo', 'mesma',
  'usar', 'usando', 'vale', 'vem', 'vindo', 'procurar', 'buscar', 'observar'];
const momentLine = (m) => `${m.hora} · ${m.onde} — o que observar: ${m.ver}`;
async function qaRephrase(m, opts) {
  const engine = aiState.engine;
  if (!engine || !opts.length) return opts;
  const sys = 'Reescreva cada pergunta de um fotógrafo para soar natural e curta, em português do Brasil, em primeira pessoa (eu). '
    + 'Mantenha exatamente o sentido e o lugar citado; não acrescente horários, números nem lugares. '
    + 'Responda com uma linha por pergunta, numeradas "1)", "2)", "3)", e nada mais.';
  try {
    const r = await engine.chat.completions.create({ temperature: 0.3, max_tokens: 160, messages: [
      { role: 'system', content: sys },
      // Exemplo: o modelo pequeno às vezes RESPONDE a pergunta em vez de reescrevê-la.
      { role: 'user', content: 'Momento: 07:10 · Paço Imperial — o que observar: fachada histórica\nPerguntas:\n1) Por que essa configuração de câmera aqui?\n2) Se eu não entrar em Paço Imperial e ficar do lado de fora, essa configuração funciona?\n3) Como enquadrar essa cena?' },
      { role: 'assistant', content: '1) Por que essa configuração faz sentido aqui no Paço Imperial?\n2) Se eu ficar do lado de fora do Paço Imperial, essa configuração ainda serve?\n3) Como eu enquadro essa cena do Paço Imperial?' },
      { role: 'user', content: `Momento: ${momentLine(m)}\nPerguntas:\n${opts.map((o, i) => `${i + 1}) ${o.text}`).join('\n')}` },
    ] });
    const lines = parseAiLines(r.choices[0].message.content || '');
    const place = m.onde.split(/[,(]/)[0].trim().toLowerCase();
    const words = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]{4,}/g) || [];
    return opts.map((o, i) => {
      const t = (lines[i + 1] || '').trim().replace(/^["“]|["”]$/g, '');
      // Só aceita se continuar sendo UMA pergunta curta, sem números novos, com o lugar quando o original citava
      // e sem palavra de conteúdo nova (ex.: "igreja" num bloco de café).
      const known = new Set([...words(`${o.text} ${momentLine(m)}`), ...QA_NEUTRAL]);
      const ok = /^[A-ZÀ-Ú]/.test(t) && t.endsWith('?') && !/[.!?]\s/.test(t) && t.length >= 8 && t.length <= 140
        && !(/^por que /i.test(o.text) && /^porque /i.test(t)) // "Porque" no lugar de "Por que" é erro de português
        && !/\d/.test(t.replace(/\d/g, (d) => (o.text.includes(d) ? '' : d)))
        && (!o.text.toLowerCase().includes(place) || t.toLowerCase().includes(place))
        && words(t).every((w) => known.has(w));
      return ok ? { ...o, text: t } : o;
    });
  } catch { return opts; }
}
function qaCheck(text, known) {
  const issues = [];
  if (cameraNumbers(text).size) issues.push('escreveu números de câmera (eles são mostrados à parte)');
  // Qualquer outro número (ex.: "um ISO mais baixo, como 3200") também não pode: só horários que estão nos dados.
  else if (/\d/.test(text.replace(/\b\d{1,2}:\d{2}\b/g, (h) => (known.includes(h.padStart(5, '0')) ? '' : h)))) issues.push('escreveu números');
  const times = (text.match(/\b\d{1,2}:\d{2}\b/g) || []).filter((h) => !known.includes(h.padStart(5, '0')));
  if (times.length) issues.push(`citou horário fora dos dados (${times.join(', ')})`);
  const gear = (text.match(/\b(flash|trip[ée]|lentes?|teleobjetiva|grande[- ]angular|filtros?|rebatedor|polarizador)\b/gi) || []).filter((g) => !new RegExp(g, 'i').test(known));
  if (gear.length) issues.push(`citou equipamento (${[...new Set(gear.map((g) => g.toLowerCase()))].join(', ')})`);
  // Contradições técnicas simples (o 1,5B já trocou "diafragma aberto" por "apertado").
  const k = known.toLowerCase(), t = text.toLowerCase();
  const CONTRA = [
    ['diafragma aberto', /diafragma (bem |mais )?aberto|abrir o diafragma/, /diafragma (bem |mais )?(fechado|apertado)|(fechar|apertar) o diafragma|apertado diafragma/],
    ['diafragma fechado', /diafragma (bem |mais )?fechado|f\/(8|11)/, /diafragma (bem |mais )?aberto|abrir o diafragma/],
    ['ISO alto', /iso alto/, /iso (mais )?baixo/],
    ['ISO baixo', /iso (baixo|mínimo)/, /iso (mais )?alto/],
  ];
  for (const [label, inData, wrong] of CONTRA) {
    if (inData.test(k) && !wrong.test(k) && wrong.test(t)) issues.push(`contradiz os dados (${label})`);
  }
  return issues;
}
async function qaAnswer(m, q, data, history) {
  const engine = await aiEngine();
  const sys = [
    'Você é um amigo fotógrafo respondendo uma dúvida sobre um momento de uma caminhada fotográfica.',
    'Responda em 2 ou 3 frases curtas, em português do Brasil, falando com "você", sempre explicando o motivo.',
    'Use SOMENTE as informações de "Dados para responder"; se elas não respondem a pergunta, diga isso com honestidade.',
    'Não escreva números de câmera (ISO, f/, velocidade, EV) nem horários: a configuração aparece ao lado da sua resposta.',
    'Não cite equipamentos (flash, tripé, lentes, filtros). Não use títulos nem markdown.',
  ].join(' ');
  const hist = history.slice(-2).map((h) => `Pergunta anterior: ${h.q}\nResposta anterior: ${h.a}`).join('\n');
  const user = `Momento: ${momentLine(m)}\nDados para responder: ${data}\n${hist ? `${hist}\n` : ''}Pergunta: ${q}`;
  const known = `${momentLine(m)} ${data}`;
  let text = '', issues = [];
  for (const [temperature, fix] of [[0.3, ''], [0.1, 'x']]) {
    const extra = fix && issues.length ? ` Atenção: na resposta anterior você errou (${issues.join('; ')}). Corrija.` : '';
    const r = await engine.chat.completions.create({ temperature, max_tokens: 170, messages: [
      { role: 'system', content: sys + extra }, { role: 'user', content: user },
    ] });
    text = (r.choices[0].message.content || '').replace(/\*\*|__|^#+\s*/gm, '').trim();
    issues = qaCheck(text, known);
    if (!issues.length) break;
  }
  return { text, issues };
}

// ---- UI ----
function qaBlockHtml(i) {
  return `<div class="qa" data-i="${i}"><button type="button" class="qa-open">💬 Perguntar sobre este momento</button>
    <div class="qa-thread"></div><div class="qa-chips"></div></div>`;
}
function renderQa(i, { rephrasing = false } = {}) {
  const box = document.querySelector(`.qa[data-i="${i}"]`);
  if (!box) return;
  const b = qaBlock(i);
  box.querySelector('.qa-thread').innerHTML = b.thread.map((h) => `<div class="qa-q">${esc(h.q)}</div>
    <div class="qa-a">${h.a ? esc(h.a) : '<span class="ai-caret"></span>'}${h.cam ? `<p class="ai-cam">📷 ${esc(camText(h.cam))}</p><p class="ai-why"><b>Por quê:</b> ${esc(h.cam.why)}</p>` : ''}
    ${h.note ? `<p class="qa-warn">⚠️ ${esc(h.note)}</p>` : ''}</div>`).join('');
  const left = QA_MAX - qaState.asked;
  const chips = left > 0 ? b.offered.map((o) => `<button type="button" class="chip qa-chip" data-q="${o.id}" ${qaState.busy ? 'disabled' : ''}>${esc(o.text)}</button>`).join('') : '';
  box.querySelector('.qa-chips').innerHTML = (chips ? `${chips}${rephrasing ? '<small class="qa-note">ajustando as perguntas…</small>' : ''}` : '')
    + (b.offered.length || left <= 0 ? `<small class="qa-note">${left > 0 ? `${left} de ${QA_MAX} perguntas restantes neste roteiro` : `Você usou as ${QA_MAX} perguntas deste roteiro (limite para a IA não perder o contexto). Gere o texto de novo para recomeçar.`}</small>` : '');
  box.querySelector('.qa-open').hidden = b.offered.length > 0 || b.thread.length > 0 || left <= 0;
}
async function qaOffer(i) {
  const b = qaBlock(i);
  b.offered = QA_MAX - qaState.asked > 0 ? qaOptions(i) : [];
  renderQa(i, { rephrasing: true });
  const m = qaState.moments[i];
  const offered = b.offered;
  const job = qaRephrase(m, offered);
  qaState.pending = job;
  const better = await job;
  if (qaState.pending === job) qaState.pending = null;
  if (b.offered === offered) { b.offered = better; renderQa(i); }
}
async function qaAsk(i, id) {
  if (qaState.busy || aiState.busy || qaState.asked >= QA_MAX) return;
  const b = qaBlock(i), m = qaState.moments[i];
  const opt = b.offered.find((o) => o.id === id), tpl = QA_BANK.find((q) => q.id === id);
  if (!opt || !tpl) return;
  const c = { blocked: qaState.facts.nuvens?.total_pct >= 85, styles: new Set(qaState.facts._styles) };
  const cam = tpl.cam ? tpl.cam(m, c) : null;
  const data = tpl.data(m, c, cam);
  qaState.busy = true;
  qaState.asked += 1;
  b.asked.add(id);
  b.offered = [];
  const entry = { q: opt.text, a: '', cam };
  b.thread.push(entry);
  renderQa(i);
  reveal(document.querySelector(`.qa[data-i="${i}"] .qa-thread`).lastElementChild, 'nearest');
  try {
    await qaState.pending; // espera a reescrita de perguntas liberar o motor
    const { text, issues } = await qaAnswer(m, opt.text, data, b.thread.slice(0, -1));
    if (text && !issues.length) entry.a = text;
    else {
      // A IA errou duas vezes: não mostramos o texto dela, e sim a resposta calculada pelo app.
      // Os dados sem a configuração e o motivo (que já aparecem formatados logo abaixo).
      const plain = data.replace(/Configuração[^:]*: \([^)]*\)\.\s*/g, '').replace(cam?.why || '\u0000', '').replace(/Motivo técnico:\s*/g, '').trim();
      entry.a = `Resposta calculada pelo app: ${plain || 'veja a configuração e o motivo abaixo.'}`;
      entry.note = `A IA não respondeu com segurança (${issues.join('; ') || 'sem texto'}); mostrando os dados do app.`;
    }
  } catch (e) {
    entry.a = `Não consegui rodar a IA agora (${String(e?.message || e).slice(0, 80)}).`;
  }
  qaState.busy = false;
  renderQa(i);
  // Cada resposta traz 3 novas perguntas sobre o mesmo bloco, até o limite.
  if (qaState.asked < QA_MAX) await qaOffer(i);
  // Os outros blocos com perguntas abertas atualizam o contador.
  Object.keys(qaState.blocks).forEach((k) => { if (+k !== i) renderQa(+k); });
}
$('#ai-out').addEventListener('click', (e) => {
  const box = e.target.closest('.qa');
  if (!box) return;
  const i = +box.dataset.i;
  if (e.target.closest('.qa-open')) qaOffer(i);
  const chip = e.target.closest('.qa-chip');
  if (chip && !chip.disabled) qaAsk(i, chip.dataset.q);
});
