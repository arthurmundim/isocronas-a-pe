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

const isoHigh = (m) => isLowLight(m.phase) || parseInt(m.camera.iso, 10) >= 400;
// Só o que é do próprio lugar (sem o vizinho fundido em "; logo antes, X: …"), para o modelo não misturar.
const mainVer = (m) => m.ver.split('; logo antes')[0];
const composeHint = (m) => COMPOSE[m.kind] || COMPOSE[m.cat] || (isLowLight(m.phase) ? COMPOSE.evento : 'Escolha um primeiro plano e deixe a luz vir de lado para dar volume.');

// ---- Banco de perguntas (ordem = prioridade) ----
// applies: se faz sentido para o bloco; goal: o que a resposta precisa fazer; data: tópicos "Rótulo: valor" que a IA
// pode usar (um "Veredito" calculado pelo app fixa o sim/não); cam: configuração mostrada pelo app (opcional).
const QA_BANK = [
  { id: 'why_cam', applies: () => true, text: () => 'Por que essa configuração de câmera aqui?', cam: (m) => m.camera,
    goal: 'explicar por que essa configuração combina com a luz e a cena deste momento',
    data: (m) => [['Luz no momento', m.phase], ['Motivo técnico', m.camera.why]] },
  { id: 'outside', applies: (m) => ['cafe', 'worship'].includes(m.cat), text: (m) => `Se eu não entrar em ${m.onde} e ficar do lado de fora, essa configuração funciona?`,
    cam: (m, c) => cameraForScene(m.scene || 'street', m.phase, c.blocked),
    goal: 'explicar por que funciona do lado de fora, pensando na luz da rua', polarity: 'sim',
    answer: () => 'Funciona, sim: do lado de fora vale a configuração da rua.',
    data: (m, c, cam) => [['Veredito', 'funciona do lado de fora, com a configuração da rua (mostrada ao lado)'],
      ['Luz do lado de fora', `${m.phase}${c.blocked ? ', céu encoberto' : ''}`], ['Motivo técnico', cam.why]] },
  { id: 'compose', applies: () => true, text: () => 'Como enquadrar essa cena?',
    goal: 'dar uma instrução de onde se posicionar e uma de composição',
    data: (m) => [['O que observar', mainVer(m)], ['Dica de enquadramento', composeHint(m)]] },
  // A pergunta segue o ISO real: alto (pouca luz ou céu fechado) ou baixo (luz farta).
  { id: 'iso_low', applies: () => true, cam: (m) => m.camera,
    text: (m) => (isoHigh(m) ? 'Por que não dá para usar um ISO mais baixo aqui?' : 'Por que o ISO pode ficar baixo aqui?'),
    goal: 'explicar a escolha do ISO pela quantidade de luz', polarity: (m) => (isoHigh(m) ? 'nao' : 'sim'),
    answer: (m) => (isoHigh(m) ? 'Não dá: com essa luz, um ISO mais baixo deixaria a foto tremida ou escura.' : 'Pode, sim: há luz de sobra para um ISO baixo.'),
    data: (m, c) => (isoHigh(m)
      ? [['Veredito', 'um ISO mais baixo não serve aqui'], ['Luz no momento', `${m.phase}${c.blocked ? ', céu encoberto' : ''}`],
        ['Por que esse ISO', 'ISO menor exigiria velocidade mais lenta (foto tremida ou gente borrada) ou mais abertura do que a lente costuma ter'], ['Motivo técnico', m.camera.why]]
      : [['Veredito', 'o ISO pode ficar baixo aqui'], ['Luz no momento', m.phase],
        ['Por que esse ISO', 'há luz suficiente: ISO baixo dá menos ruído e mais detalhe, e ainda sobra velocidade'], ['Motivo técnico', m.camera.why]]) },
  { id: 'inside', applies: (m) => ['cafe', 'worship', 'historic'].includes(m.cat), text: (m) => `E se eu entrar em ${m.onde}?`,
    cam: () => CAMERA.interior, goal: 'explicar por que a configuração muda lá dentro', polarity: 'muda',
    answer: () => 'Muda: lá dentro a luz é bem mais fraca, então use a configuração de interior.',
    data: (m, c, cam) => [['Veredito', 'lá dentro muda a configuração (a de interior, mostrada ao lado)'],
      ['Luz lá dentro', 'artificial e bem mais fraca que a da rua'], ['Motivo técnico', cam.why]] },
  { id: 'light', applies: () => true, text: () => 'De onde vem a luz nesse momento?',
    goal: 'explicar de onde vem a luz e como aproveitá-la', data: (m) => [['De onde vem a luz', lightNow(m)], ['O que observar', mainVer(m)]] },
  { id: 'cloudy', applies: (m, c) => !isLowLight(m.phase) && !c.blocked, text: () => 'E se o céu fechar nessa hora?',
    cam: () => CAMERA.encoberto, goal: 'explicar o que muda na luz e na configuração se o céu fechar', polarity: 'muda',
    answer: () => 'Muda: com o céu fechado, use a configuração de céu encoberto.',
    data: (m, c, cam) => [['Veredito', 'com céu fechado, use a configuração de céu encoberto (mostrada ao lado)'],
      ['O que muda', 'sem sol direto a luz fica difusa: somem contraluz, sombras longas e luz de lado; as cores ficam mais suaves'], ['Motivo técnico', cam.why]] },
  { id: 'phone', applies: () => true, text: () => 'E se eu estiver só com o celular?',
    goal: 'explicar como fotografar este momento só com o celular', data: (m) => [['No celular', isLowLight(m.phase) ? PHONE.low : PHONE.day]] },
  ...PHOTO_STYLES.map((s) => ({ id: `style_${s.id}`, applies: (m, c) => c.styles.has(s.id), text: () => `O que procurar aqui para fotos de ${s.label.toLowerCase()}?`,
    goal: `sugerir o que fotografar aqui pensando em ${s.label.toLowerCase()}`,
    data: (m) => [[`Para ${s.label.toLowerCase()}`, STYLE_HINTS[s.id]], ['Neste momento', mainVer(m)]] })),
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
    const r = await engineRun(() => engine.chat.completions.create({ temperature: 0.3, max_tokens: 160, messages: [
      { role: 'system', content: sys },
      // Exemplo: o modelo pequeno às vezes RESPONDE a pergunta em vez de reescrevê-la.
      { role: 'user', content: 'Momento: 07:10 · Paço Imperial — o que observar: fachada histórica\nPerguntas:\n1) Por que essa configuração de câmera aqui?\n2) Se eu não entrar em Paço Imperial e ficar do lado de fora, essa configuração funciona?\n3) Como enquadrar essa cena?' },
      { role: 'assistant', content: '1) Por que essa configuração faz sentido aqui no Paço Imperial?\n2) Se eu ficar do lado de fora do Paço Imperial, essa configuração ainda serve?\n3) Como eu enquadro essa cena do Paço Imperial?' },
      { role: 'user', content: `Momento: ${momentLine(m)}\nPerguntas:\n${opts.map((o, i) => `${i + 1}) ${o.text}`).join('\n')}` },
    ] }));
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

// ---- Resposta com guardrails ----
// Campos fixos (resposta / porque / dica, ~20 palavras cada), travados por gramática JSON quando o WebLLM permite.
const QA_FIELDS = ['resposta', 'porque', 'dica'];
const QA_SCHEMA = JSON.stringify({ type: 'object', additionalProperties: false, required: QA_FIELDS,
  // Teto de caracteres (~30 palavras) só para o modelo não se estender; o corte fino é pela primeira frase.
  properties: Object.fromEntries(QA_FIELDS.map((k) => [k, { type: 'string', maxLength: 220 }])) });
// Os dados vão para o modelo sem números (ele os copiava, e número é proibido na resposta): a configuração com os
// valores certos aparece formatada ao lado.
const noNums = (s) => String(s)
  .replace(/ISO \d+(?:–\d+)?/g, 'esse ISO').replace(/f\/\d+(?:\.\d+)?(?:–\d+(?:\.\d+)?)?/g, 'essa abertura')
  .replace(/1\/\d+(?:–1\/\d+)?\s*s/g, 'essa velocidade').replace(/\d+(?:–\d+)?\s*s\b/g, 'alguns segundos')
  .replace(/~?\d+(?:[.,]\d+)?\s*m\b/g, 'poucos metros').replace(/[+−-]\d+(?:,\d+)?(?:\s*a\s*[+−-]\d+(?:,\d+)?)?\s*EV/g, 'essa compensação');
const dataText = (data) => data.map(([k, v]) => `- ${k}: ${noNums(v)}`).join('\n');
// Fica só a primeira frase de cada campo (o modelo pequeno tende a emendar uma segunda, menos segura).
// Se não há fim de frase e o texto bateu no teto da gramática, corta na última palavra inteira.
const firstSentence = (s) => {
  const one = s.match(/^.+?[.!?](?=\s|$)/)?.[0];
  if (one) return one.trim();
  return s.length >= 215 ? `${s.slice(0, s.lastIndexOf(' ')).trim()}…` : s.trim();
};

// Termos proibidos nesta resposta, calculados pela configuração e pela luz (citados no prompt e checados depois).
function qaForbidden(m, c, cam, tpl) {
  const cfg = cam || m.camera;
  // Lugares dos exemplos (few-shot) nunca podem aparecer numa resposta real.
  const out = ['flash', 'tripé', 'lente', 'filtro', 'rebatedor', 'Confeitaria Colombo', 'Rua do Ouvidor', 'Arcos da Lapa', 'Praça XV', 'Paço Imperial'];
  if (parseFloat(cfg.ap.replace('f/', '')) <= 4) out.push('diafragma fechado', 'fechar o diafragma', 'diafragma apertado');
  if (parseFloat(cfg.ap.replace('f/', '')) >= 8) out.push('diafragma aberto', 'abrir o diafragma');
  // Na pergunta sobre ISO, comparar ISOs é o próprio assunto.
  if (tpl.id !== 'iso_low' && parseInt(cfg.iso, 10) >= 400) out.push('ISO baixo');
  if (tpl.id !== 'iso_low' && parseInt(cfg.iso, 10) <= 200) out.push('ISO alto');
  if (c.blocked) out.push('sol direto', 'contraluz', 'sombras longas', 'céu colorido');
  if (isLowLight(m.phase)) out.push('golden hour', 'sol forte', 'luz do sol');
  // Pergunta que não é de sim/não não pode virar "funciona / não funciona" (o modelo copiava a pergunta anterior).
  if (!tpl.polarity) out.push('não funciona', 'funciona do lado', 'não serve');
  return out;
}

// Exemplos (few-shot) com lugares do Rio, um por tipo de pergunta, já no formato JSON.
const QA_EXAMPLES = [
  ['Momento: 19:05 · Confeitaria Colombo (noite)\nObjetivo: dizer se funciona do lado de fora e por quê, pensando na luz da rua\nDados:\n- Veredito: funciona do lado de fora, com a configuração da rua (mostrada ao lado)\n- Luz do lado de fora: noite\n- Motivo técnico: com pouca luz, ISO alto e diafragma aberto mantêm uma velocidade que não treme\nPergunta: Se eu ficar do lado de fora da Confeitaria Colombo, essa configuração serve?',
    { resposta: 'Serve, sim: do lado de fora vale a configuração da rua.', porque: 'À noite a luz da rua é fraca, então ISO alto e diafragma aberto seguram a velocidade sem tremer.', dica: 'Fotografe pela vitrine e use os reflexos como moldura.' }],
  ['Momento: 17:40 · Rua do Ouvidor (golden hour)\nObjetivo: dar uma instrução de onde se posicionar e uma de composição\nDados:\n- O que observar: fachadas do lado esquerdo com luz quente vindo de lado\n- Dica de enquadramento: fotografe da calçada oposta, com a câmera nivelada\nPergunta: Como enquadrar essa cena?',
    { resposta: 'Atravesse para a calçada oposta e enquadre as fachadas do lado esquerdo.', porque: 'De lá a luz de lado mostra a textura e a sombra do outro lado dá profundidade.', dica: 'Mantenha a câmera nivelada para as linhas verticais não caírem.' }],
  ['Momento: 18:20 · Arcos da Lapa (blue hour)\nObjetivo: explicar de onde vem a luz e como aproveitá-la\nDados:\n- De onde vem a luz: sem sol direto, a luz vem do céu ainda azul, de postes e letreiros\nPergunta: De onde vem a luz nesse momento?',
    { resposta: 'Não vem mais do sol: vem do céu ainda azul e das luzes da rua.', porque: 'Na blue hour o sol já está abaixo do horizonte, então o céu e os postes iluminam a cena.', dica: 'Deixe um pedaço de céu azul no quadro para contrastar com as luzes acesas.' }],
];
// Cada pergunta é independente: mandar a anterior junto fazia o modelo responder a pergunta errada.
function qaMessages(m, q, tpl, data, forbidden, fix) {
  const sys = [
    'Você é um amigo fotógrafo respondendo uma dúvida sobre UM momento de uma caminhada fotográfica, em português do Brasil, falando com "você".',
    'Responda SOMENTE em JSON: {"resposta": "...", "porque": "...", "dica": "..."}.',
    'resposta: 1 frase direta (até 20 palavras) que responde a pergunta; se os dados tiverem "Veredito", siga o veredito.',
    'porque: 1 frase (até 20 palavras) com o motivo, usando o "Motivo técnico" ou os dados.',
    'dica: 1 frase prática (até 20 palavras), só com o que está nos dados.',
    'Use SOMENTE os dados; se eles não respondem a pergunta, diga isso na resposta.',
    'Não escreva números (ISO, f/, velocidade, EV, horários): a configuração aparece ao lado da sua resposta.',
    `Não use estes termos: ${forbidden.join(', ')}.`,
    fix ? `Atenção: na tentativa anterior você errou (${fix}). Corrija.` : '',
  ].filter(Boolean).join(' ');
  return [
    { role: 'system', content: sys },
    ...QA_EXAMPLES.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: JSON.stringify(a) }]),
    { role: 'user', content: `Momento: ${m.hora} · ${m.onde} (${m.phase})\nObjetivo: ${tpl.goal}\nDados:\n${dataText(data)}\nPergunta: ${q}`
      + (tpl.answer ? `\nResposta (já definida pelo app; copie no campo "resposta" e explique no "porque"): ${tpl.answer(m)}` : '') },
  ];
}
// Lê o JSON (ou, sem gramática, os campos no texto).
function qaParse(text) {
  try {
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return Object.fromEntries(QA_FIELDS.map((k) => [k, String(j[k] || '').trim()]));
  } catch {
    const get = (re) => (re.exec(text)?.[1] || '').trim();
    return { resposta: get(/resposta"?\s*:\s*"?([^"\n]+)/i), porque: get(/porque"?\s*:\s*"?([^"\n]+)/i), dica: get(/dica"?\s*:\s*"?([^"\n]+)/i) };
  }
}
function qaCheck(res, known, forbidden) {
  const issues = [];
  for (const k of QA_FIELDS) {
    const n = (res[k].match(/\S+/g) || []).length;
    if (n < 3) issues.push(`campo "${k}" vazio ou curto demais`);
    else if (n > 30) issues.push(`campo "${k}" longo demais`);
  }
  const text = QA_FIELDS.map((k) => res[k]).join(' ');
  // Nenhum número: só horários que já estão nos dados.
  if (/\d/.test(text.replace(/\b\d{1,2}:\d{2}\b/g, (h) => (known.includes(h.padStart(5, '0')) ? '' : h)))) issues.push('escreveu números');
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const used = forbidden.filter((w) => norm(text).includes(norm(w)) && !norm(known).includes(norm(w)));
  if (used.length) issues.push(`usou termos proibidos (${used.join(', ')})`);
  // Nome próprio composto ("Confeitaria Colombo", "Rua X") que não está nos dados = lugar inventado ou vazado do exemplo.
  const names = text.match(/[A-ZÀ-Ú][a-zà-ú]+(?:\s+(?:de|da|do|dos|das|e)?\s*[A-ZÀ-Ú][a-zà-ú]+)+/g) || [];
  const strange = names.filter((n) => !norm(known).includes(norm(n)));
  if (strange.length) issues.push(`citou lugar fora dos dados (${[...new Set(strange)].join(', ')})`);
  return issues;
}
let qaGrammar = true; // cai para JSON "no texto" se o WebLLM recusar response_format
// A 1ª chamada com gramática compila o formato (~25 s); fazemos isso em segundo plano logo depois do texto da IA,
// para a 1ª pergunta não pagar esse custo. Fica em qaState.pending, que as perguntas já esperam.
function qaWarmup() {
  const engine = aiState.engine;
  if (!engine || !qaGrammar) return;
  const job = engineRun(() => engine.chat.completions.create({ max_tokens: 1, temperature: 0, messages: [{ role: 'user', content: 'ok' }],
    response_format: { type: 'json_object', schema: QA_SCHEMA } }))
    .catch(() => { qaGrammar = false; })
    .finally(() => { if (qaState.pending === job) qaState.pending = null; });
  qaState.pending = job;
}
async function qaAnswer(m, q, tpl, data, forbidden, isCancelled = () => false) {
  const engine = await aiEngine();
  const known = `${m.hora} ${m.onde} ${m.ver} ${dataText(data)}`;
  let res = null, issues = [];
  for (const temperature of [0.2, 0.1]) {
    if (isCancelled()) break; // cancelado: não faz a 2ª tentativa
    const req = { temperature, top_p: 0.8, max_tokens: 200, messages: qaMessages(m, q, tpl, data, forbidden, issues.join('; ')) };
    let r;
    try { r = await engineRun(() => engine.chat.completions.create(qaGrammar ? { ...req, response_format: { type: 'json_object', schema: QA_SCHEMA } } : req)); }
    catch (e) {
      if (!qaGrammar) throw e;
      qaGrammar = false; // sem suporte a gramática: segue só com prompt + validação
      r = await engineRun(() => engine.chat.completions.create(req));
    }
    res = qaParse(r.choices[0].message.content || '');
    for (const k of QA_FIELDS) res[k] = firstSentence(res[k]);
    // Em perguntas de sim/não, a frase de resposta é a do app: o modelo já inverteu o veredito ("Não funciona").
    if (tpl.answer) res.resposta = tpl.answer(m);
    issues = qaCheck(res, known, forbidden);
    // O "porquê" e a dica também não podem contradizer o veredito.
    const pol = typeof tpl.polarity === 'function' ? tpl.polarity(m) : tpl.polarity;
    const rest = `${res.porque} ${res.dica}`.toLowerCase();
    const CONTRA_POL = {
      sim: /não (funciona|serve|se aplica|dá|vale|é possível|é adequad)/,
      nao: /(pode|dá para|é possível) usar (um )?iso (mais )?baixo|iso (mais )?baixo (funciona|serve|é melhor)/,
      muda: /não muda|continua (a )?mesma|não precisa (mudar|trocar)/,
    };
    if (pol && CONTRA_POL[pol]?.test(rest)) issues.push('contradiz o veredito do app');
    if (!issues.length) break;
  }
  return { res, issues };
}
// Resposta calculada pelo app (quando a IA erra duas vezes): veredito, motivo técnico e dica, direto dos dados.
function qaFallback(data, cam, tpl, m) {
  const get = (...keys) => data.find(([k]) => keys.includes(k))?.[1];
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  return {
    resposta: tpl.answer?.(m) || cap(get('Veredito')) || 'Resposta calculada pelo app.',
    porque: cap(get('Por que esse ISO', 'Motivo técnico', 'De onde vem a luz', 'O que muda', 'Luz lá dentro')) || cam?.why || '',
    dica: cap(get('Dica de enquadramento', 'No celular') || data.find(([k]) => k.startsWith('Para '))?.[1]) || '',
  };
}

// ---- UI ----
function qaBlockHtml(i) {
  return `<div class="qa" data-i="${i}"><button type="button" class="qa-open">💬 Perguntar sobre este momento</button>
    <div class="qa-thread"></div><div class="qa-chips"></div></div>`;
}
function qaAnswerHtml(h) {
  if (!h.res) return '<span class="ai-caret"></span>';
  const r = h.res;
  return `<p class="qa-r"><b>${esc(r.resposta)}</b></p>${r.porque ? `<p><b>Por quê:</b> ${esc(r.porque)}</p>` : ''}${r.dica ? `<p><b>Dica:</b> ${esc(r.dica)}</p>` : ''}
    ${h.cam ? `<p class="ai-cam">📷 ${esc(camText(h.cam))}</p>` : ''}${h.note ? `<p class="qa-warn">⚠️ ${esc(h.note)}</p>` : ''}`;
}
function renderQa(i, { rephrasing = false } = {}) {
  const box = document.querySelector(`.qa[data-i="${i}"]`);
  if (!box) return;
  const b = qaBlock(i);
  box.querySelector('.qa-thread').innerHTML = b.thread.map((h) => `<div class="qa-q">${esc(h.q)}</div><div class="qa-a">${qaAnswerHtml(h)}</div>`).join('');
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
  const offeredBefore = b.offered;
  qaState.busy = true;
  qaState.asked += 1;
  b.asked.add(id);
  b.offered = [];
  const entry = { q: opt.text, res: null, cam };
  b.thread.push(entry);
  renderQa(i);
  const box = document.querySelector(`.qa[data-i="${i}"]`);
  reveal(box.querySelector('.qa-thread').lastElementChild, 'nearest');
  // Cancelar desfaz a pergunta (não conta no limite) e devolve as mesmas 3 opções.
  let cancelled = false;
  opStart('qa', box.querySelector('.qa-thread'), () => {
    cancelled = true;
    aiInterrupt();
    b.thread.pop();
    b.asked.delete(id);
    qaState.asked -= 1;
    b.offered = offeredBefore;
    qaState.busy = false;
    renderQa(i);
  });
  try {
    await qaState.pending; // espera a reescrita de perguntas liberar o motor
    // Fica em qaState.pending para nada usar o motor ao mesmo tempo (mesmo depois de um Cancelar).
    const job = qaAnswer(m, opt.text, tpl, data, qaForbidden(m, c, cam, tpl), () => cancelled);
    const pend = job.catch(() => {}).finally(() => { if (qaState.pending === pend) qaState.pending = null; });
    qaState.pending = pend;
    const { res, issues } = await job;
    if (cancelled) return;
    if (!issues.length) entry.res = res;
    else {
      // A IA errou duas vezes: não mostramos o texto dela, e sim a resposta calculada pelo app.
      entry.res = qaFallback(data, cam, tpl, m);
      entry.note = `A IA não respondeu com segurança (${issues.join('; ')}); mostrando a resposta calculada pelo app.`;
    }
  } catch (e) {
    if (cancelled) return;
    entry.res = qaFallback(data, cam, tpl, m);
    entry.note = `Não consegui rodar a IA agora (${String(e?.message || e).slice(0, 80)}); mostrando a resposta calculada pelo app.`;
  }
  opEnd('qa');
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
