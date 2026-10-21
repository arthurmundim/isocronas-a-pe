'use strict';
// ==== IA NO NAVEGADOR (WEBLLM + WEBGPU) ====
// O modelo roda no aparelho: nada é enviado a servidor. Ele só reescreve os momentos montados a partir de buildFacts();
// regras e configurações de câmera continuam determinísticas.
const AI = {
  lib: 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm',
  models: { f16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' },
  downloadMB: 900,
  // Tempo de leitura → quantos momentos entram no texto da IA (~2 frases cada), quantas dicas na resposta rápida e teto de tokens.
  sizes: {
    curto: { label: 'Curto', read: '~20 s de leitura', moments: 3, tips: 3, maxTokens: 240 },
    medio: { label: 'Médio', read: '~40 s', moments: 4, tips: 5, maxTokens: 330 },
    longo: { label: 'Longo', read: '~1 min', moments: 6, tips: 8, maxTokens: 500 },
  },
};
// mode: null (nada escolhido ainda), 'quick' (resposta rápida) ou 'ai'.
const aiState = { webllm: null, engine: null, modelId: null, loading: null, busy: false, size: 'medio', factsKey: null, unsupported: null, mode: null };
try { aiState.size = localStorage.getItem('isocronas.aiSize') || 'medio'; } catch { /* sem armazenamento */ }

// Motivo de não suportar, ou null. Checado uma vez, antes de qualquer download.
async function aiSupport() {
  if (aiState.unsupported !== null) return aiState.unsupported;
  let reason = null;
  if (!navigator.gpu) reason = 'este navegador não tem WebGPU. Use Chrome ou Edge atualizados (no Android, Chrome).';
  else {
    const adapter = await navigator.gpu.requestAdapter().catch(() => null);
    if (!adapter) reason = 'a GPU deste aparelho não está disponível para o navegador.';
    else aiState.modelId = adapter.features.has('shader-f16') ? AI.models.f16 : AI.models.f32;
  }
  aiState.unsupported = reason;
  return reason;
}

async function aiEngine() {
  if (aiState.engine) return aiState.engine;
  if (aiState.loading) return aiState.loading;
  aiState.loading = (async () => {
    aiProgress(0, 'Carregando biblioteca…');
    aiState.webllm = aiState.webllm || await import(AI.lib);
    const engine = await aiState.webllm.CreateMLCEngine(aiState.modelId, {
      initProgressCallback: (r) => aiProgress(r.progress, r.text),
    });
    aiState.engine = engine;
    try { localStorage.setItem(AI_READY_KEY, aiState.modelId); } catch { /* sem armazenamento */ }
    return engine;
  })();
  try { return await aiState.loading; }
  finally { aiState.loading = null; aiProgress(null); }
}

// Marca local de "modelo já baixado" (evita importar a biblioteca de ~6 MB só para checar o cache).
const AI_READY_KEY = 'isocronas.aiReady';
const aiModelCached = () => { try { return localStorage.getItem(AI_READY_KEY) === aiState.modelId; } catch { return false; } };

// ==== MOMENTOS DA CAMINHADA (DETERMINÍSTICOS) ====
// Modelos pequenos inventam quando compõem a partir de um JSON, mas reescrevem bem um esboço pronto.
// Então as regras escolhem os momentos (hora, lugar, o que observar, câmera) e a IA só dá o tom.
const CAT_STYLES = { viewpoint: ['paisagem'], artwork: ['arte', 'street'], historic: ['arquitetura'], worship: ['arquitetura'],
  park: ['natureza', 'retrato'], fountain: ['noturna', 'minimal'], cafe: ['street'] };
const CAT_IDEA = {
  viewpoint: ['vista aberta da cidade', 'arquitetura'], artwork: ['uma obra de arte urbana no caminho', 'arquitetura'],
  historic: ['construção histórica: detalhes e textura da fachada', 'arquitetura'], worship: ['fachada e torres da igreja', 'arquitetura'],
  park: ['verde e sombra aberta', 'retrato sombra'], fountain: ['água e reflexos', 'agua'], cafe: ['gente nas mesas e vitrines', 'street'],
};
function aiMoments(f, n) {
  const toMin = (h) => { const [H, M] = h.split(':').map(Number); return H * 60 + M; };
  const t0 = toMin(f.caminhada.saida);
  const rel = (h) => (toMin(h) - t0 + 1440) % 1440;
  const styles = new Set(f._styles);
  const likes = (list) => list.some((s) => styles.has(s));
  const blocked = f.nuvens?.total_pct >= 85;
  const S = f.luz.na_saida, C = f.luz.na_chegada;
  const cand = [];
  const add = (m) => cand.push({ ...m, t: m.fim ? 99999 : rel(m.hora) });

  add({ hora: S.hora, onde: f.origem.nome, prio: 1000, inicio: true,
    ver: `saída com luz de ${S.fase}`, camera: cameraForPhase(S.fase, blocked) });
  const next = f.luz.proximo_evento;
  const sky = !f.nuvens ? '' : blocked ? `; céu ${f.nuvens.total_pct}% encoberto, luz difusa`
    : f.nuvens.altas_pct >= 40 && f.nuvens.baixas_pct < 40 ? '; nuvens altas que podem pegar cor' : '';
  add({ hora: C.hora, onde: f.destino.nome, prio: 1000, fim: true,
    ver: `você chega na ${C.fase}${next ? `; ${next.evento} ${next.minutos_apos_chegada} min depois (${next.hora})` : ''}${sky}`,
    camera: cameraForPhase(C.fase, blocked) });

  // Onde você estará num horário: a rua (nomeada) do trecho em andamento, nunca um vago "no caminho".
  const streetAtTime = (h) => f.trechos.filter((t) => !t.rua.startsWith('calçada') && rel(t.inicio) <= rel(h)).at(-1)?.rua || f.destino.nome;
  for (const e of f.luz.eventos_durante) add({ kind: 'evento', hora: e.hora, onde: streetAtTime(e.hora), prio: 88, ver: `${e.evento}: a luz muda`,
    camera: cameraForPhase(/blue/.test(e.evento) ? 'blue hour' : 'golden hour', blocked) });

  if (!blocked) {
    const seen = new Set();
    for (const t of f.trechos) {
      if (seen.has(t.rua) || t.rua.startsWith('calçada') || t.altitude_sol <= -1) continue;
      if (t.corredor_de_luz) add({ kind: 'corredor', hora: t.inicio, onde: t.rua, prio: 92, ver: 'a rua fica alinhada com o sol baixo e a luz atravessa a rua inteira', camera: CAMERA['sol baixo'] });
      else if (t.luz.startsWith('contraluz') && t.altitude_sol < 25) add({ kind: 'contraluz', hora: t.inicio, onde: t.rua, prio: likes(['street', 'retrato', 'minimal']) ? 86 : 72,
        ver: styles.has('retrato') ? 'você anda contra o sol: contorno de luz no cabelo de quem estiver de costas para ele' : 'você anda contra o sol: silhuetas de quem passa e reflexos no chão',
        camera: styles.has('retrato') ? CAMERA['contraluz retrato'] : CAMERA.contraluz });
      else if (t.fachadas_iluminadas && t.altitude_sol > 0 && t.altitude_sol < 25) add({ kind: 'fachadas', hora: t.inicio, onde: t.rua, prio: likes(['arquitetura']) ? 86 : 70,
        ver: `fachadas do ${t.fachadas_iluminadas} com luz quente vindo de lado`, camera: CAMERA.arquitetura });
      else continue;
      seen.add(t.rua);
    }
  }
  for (const p of f._pontos) {
    const [idea, cam] = CAT_IDEA[p.cat] || ['um ponto interessante', 'street'];
    add({ hora: p.hora_aprox, onde: p.nome, prio: likes(CAT_STYLES[p.cat] || []) ? 84 : 66, ver: idea, camera: CAMERA[cam] });
  }
  // Momentos colados na saída ou na chegada (≤ 3 min) viram parte delas, para não repetir horário.
  const start = cand.find((m) => m.inicio), end = cand.find((m) => m.fim);
  const endT = rel(C.hora);
  const merged = cand.filter((m) => {
    if (m === start || m === end) return true;
    if (m.t <= 3 && m.kind !== 'evento' && start.onde === f.origem.nome) {
      Object.assign(start, { kind: m.kind, onde: m.onde, ver: `${start.ver}; ${m.ver}`, camera: m.camera });
      return false;
    }
    if (endT - m.t <= 3) { end.ver += `; ${m.ver.replace(/: a luz muda$/, ' bem na chegada')}`; return false; }
    return true;
  });
  // Saída e chegada sempre; o resto por prioridade, sem repetir lugar; depois em ordem de tempo.
  const picked = [], places = new Set(), ideas = new Set();
  for (const m of merged.sort((a, b) => b.prio - a.prio)) {
    // Mesma ideia em dois lugares (ex.: contraluz em duas ruas) só aparece uma vez; o modelo pequeno se confunde.
    if (picked.length >= n || places.has(m.onde) || (m.kind && ideas.has(m.kind))) continue;
    picked.push(m); places.add(m.onde); if (m.kind) ideas.add(m.kind);
  }
  picked.sort((a, b) => a.t - b.t);
  return picked;
}
// Chave/registro completo dos momentos (inclui câmera), usada no aviso de "dados mudaram" e na checagem.
const momentsText = (ms) => ms.map((m, i) => `${i + 1}) ${m.hora} — ${m.onde} — o que observar: ${m.ver} — câmera: ${camText(m.camera)}`).join('\n');
// O que vai para o modelo: sem horário e sem câmera (o app mostra os dois à parte, no formato padrão).
const momentsPrompt = (ms) => ms.map((m, i) => `${i + 1}) ${m.onde} — o que observar: ${m.ver}`).join('\n');

// ==== PROMPT ====
// Estrutura da resposta: o modelo escreve só a frase sugestiva de cada momento; hora, lugar, configuração de câmera
// e o motivo técnico são montados pelo app (renderAiOut), sempre no mesmo formato e com os números certos.
const AI_SYSTEM = [
  'Você é um amigo fotógrafo. Para cada momento numerado, escreva UMA linha começando pelo mesmo número (ex.: "1) ..."),',
  'com 1 ou 2 frases curtas falando com "você", em português do Brasil simples e sugestivo:',
  'o que observar e o que fotografar naquele lugar, naquele momento.',
  'Escreva exatamente uma linha por momento, na mesma ordem e quantidade.',
  'Não escreva horários nem configurações de câmera (ISO, abertura, velocidade, EV): o app mostra isso à parte.',
  'Não acrescente lugares, pessoas, objetos ou cores que não estejam no momento; não use títulos nem markdown.',
].join(' ');
// Exemplo (few-shot) com lugares de outra cidade, para o modelo não copiar nomes reais da rota.
const AI_EXAMPLE_IN = [
  '1) Praça XV — o que observar: saída com luz de golden hour',
  '2) Rua do Ouvidor — o que observar: fachadas do lado esquerdo com luz quente vindo de lado',
  '3) Paço Imperial — o que observar: você chega na golden hour; fim da golden hour da manhã 12 min depois',
].join('\n');
const AI_EXAMPLE_OUT = [
  '1) Logo na saída, na Praça XV, a luz ainda está baixa e dourada: comece pelas cenas abertas da praça antes que ela suba.',
  '2) Na Rua do Ouvidor, olhe para as fachadas do lado esquerdo pegando luz de lado; é a hora de mostrar textura de reboco e janelas.',
  '3) No Paço Imperial você ainda pega a golden hour, mas ela acaba em poucos minutos: priorize a fachada principal enquanto a luz está quente.',
].join('\n');
// Janela pertinente: da saída até 2 h depois da chegada. Só o que cai nela entra no contexto e pode ser citado.
function aiWindow(f) {
  const toMin = (h) => { const [H, M] = h.split(':').map(Number); return H * 60 + M; };
  const t0 = toMin(f.caminhada.saida), t1 = toMin(f.caminhada.chegada);
  const inWin = (h) => { const x = (toMin(h) - t0 + 1440) % 1440; return x >= -30 && x <= ((t1 - t0 + 1440) % 1440) + 120; };
  const names = { golden_manha: 'golden hour da manhã', nascer: 'nascer do sol', golden_tarde: 'golden hour da tarde', por_do_sol: 'pôr do sol', blue_hour: 'blue hour' };
  const events = Object.entries(f.luz.horarios_do_dia).filter(([, h]) => h && inWin(h)).map(([k, h]) => ({ key: k, nome: names[k], hora: h }));
  return { events, has: (k) => events.some((e) => e.key === k) };
}
// Contexto do dia (da seção Luz para foto), só o pertinente à janela; não vira momento novo.
function aiContext(f) {
  const w = aiWindow(f);
  const ev = w.events.length ? w.events.map((e) => `${e.nome} às ${e.hora}`).join(', ') : 'nenhum evento de luz nesse período';
  const n = f.nuvens;
  const sky = n ? `nuvens previstas ${n.total_pct}% (baixas ${n.baixas_pct}%, altas ${n.altas_pct}%)` : 'sem previsão de nuvens para esse horário';
  return `Caminhada das ${f.caminhada.saida} às ${f.caminhada.chegada}. Luz no período: ${ev}; ${sky}.`;
}
// Regras duras, montadas a partir dos fatos (o modelo pequeno respeita melhor regras concretas do que gerais).
function aiRules(f) {
  const w = aiWindow(f);
  const r = [
    `Fale só do período da caminhada (das ${f.caminhada.saida} às ${f.caminhada.chegada}) e do que está no contexto; não comente outros horários do dia.`,
    'Não escreva números de câmera (ISO, f/, velocidade, EV) nem horários: eles já aparecem formatados ao lado do seu texto.',
    'Não cite equipamentos (flash, tripé, lentes, filtros, rebatedor) nem modos de câmera.',
    'Cite cada lugar exatamente como está escrito no momento; nunca use expressões vagas como "o café", "o prédio" ou "a praça".',
  ];
  if (f.nuvens?.total_pct >= 85) r.push(`O céu estará ${f.nuvens.total_pct}% encoberto: não fale de sol direto, contraluz, sombras longas nem céu colorido.`);
  const banned = [['nascer', 'nascer do sol'], ['por_do_sol', 'pôr do sol'], ['blue_hour', 'blue hour']].filter(([k]) => !w.has(k)).map(([, n]) => n);
  if (!w.has('golden_tarde') && !w.has('golden_manha') && !['golden hour'].includes(f.luz.na_saida.fase) && f.luz.na_chegada.fase !== 'golden hour') banned.push('golden hour');
  if (banned.length) r.push(`Não mencione ${banned.join(', ')}: não acontece nesse período.`);
  return r;
}
function aiMessages(f, moments, fix = '') {
  const system = [AI_SYSTEM, 'Regras obrigatórias:', ...aiRules(f).map((x, i) => `(${i + 1}) ${x}`), fix].filter(Boolean).join(' ');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Momentos (3):\n${AI_EXAMPLE_IN}` },
    { role: 'assistant', content: AI_EXAMPLE_OUT },
    { role: 'user', content: `Contexto: ${aiContext(f)}\nMomentos (${moments.length}):\n${momentsPrompt(moments)}` },
  ];
}

// ==== CHECAGEM DO TEXTO GERADO ====
// Tudo que o texto cita (horários, números de câmera, equipamentos, eventos de luz) precisa existir nos dados.
function cameraNumbers(text) {
  const out = new Set();
  const add = (k, v) => v && out.add(`${k}${v.replace(',', '.')}`);
  for (const m of text.matchAll(/ISO\s*(\d+)(?:\s*(?:–|-|a|até)\s*(\d+))?/gi)) { add('iso', m[1]); add('iso', m[2]); }
  for (const m of text.matchAll(/f\/(\d+(?:[.,]\d+)?)(?:\s*(?:–|-|a)\s*(?:f\/)?(\d+(?:[.,]\d+)?))?/gi)) { add('f', m[1]); add('f', m[2]); }
  for (const m of text.matchAll(/\b1\/(\d+)/g)) add('s', m[1]);
  for (const m of text.matchAll(/([+−-]?\d+(?:[.,]\d+)?)(?:\s*a\s*([+−-]?\d+(?:[.,]\d+)?))?\s*EV/g)) {
    add('ev', m[1].replace('-', '−'));
    add('ev', m[2]?.replace('-', '−'));
  }
  return out;
}
function aiCheck(text, f, moments) {
  const known = `${momentsText(moments)}\n${aiContext(f)}`;
  const issues = [];
  const times = [...new Set(text.match(/\b\d{1,2}:\d{2}\b/g) || [])].filter((h) => !known.includes(h.padStart(5, '0')));
  if (times.length) issues.push(`horário fora dos dados (${times.join(', ')})`);
  // Configuração de câmera é sempre montada pelo app; no texto do modelo ela não deve aparecer.
  const cams = [...cameraNumbers(text)];
  if (cams.length) issues.push(`escreveu configuração de câmera no texto (${cams.map((c) => c.replace(/^(iso|f|s|ev)/, (k) => ({ iso: 'ISO ', f: 'f/', s: '1/', ev: 'EV ' }[k]))).join(', ')})`);
  const missing = moments.map((_, i) => i + 1).filter((n) => !parseAiLines(text)[n]);
  if (missing.length) issues.push(`faltou o texto do momento ${missing.join(', ')}`);
  const gear = (text.match(/\b(flash|trip[ée]|lentes?|teleobjetiva|grande[- ]angular|filtros?|rebatedor|polarizador)\b/gi) || []).filter((g) => !new RegExp(g, 'i').test(known));
  if (gear.length) issues.push(`equipamento não sugerido (${[...new Set(gear.map((g) => g.toLowerCase()))].join(', ')})`);
  if (f.nuvens?.total_pct >= 85 && /contraluz|sombras? longas?|sol direto|céu colorido/i.test(text)) issues.push('fala de sol direto com o céu encoberto');
  const w = aiWindow(f);
  for (const [k, re, n] of [['nascer', /nascer do sol/i, 'nascer do sol'], ['por_do_sol', /p[ôo]r do sol/i, 'pôr do sol'], ['blue_hour', /blue hour/i, 'blue hour']])
    if (re.test(text) && !w.has(k) && !re.test(momentsText(moments))) issues.push(`cita ${n}, que não acontece nesse período`);
  // Sem \b depois de palavra acentuada ("café"): em regex JS sem a flag u, "é" não conta como letra.
  // Substantivo em minúscula = genérico ("a estação"); com maiúscula é nome ("Estação da Luz").
  const vague = (text.match(/(?:^|[^\wÀ-ú])(?:[oO]|ao|no|do|pelo|[aA]|à|na|da|pela) (?:café|prédio|bar|restaurante|museu|monumento|praça|igreja|loja|estação)(?![\wÀ-ú])(?! sem nome)/g) || [])
    .map((v) => v.replace(/^[^\wÀ-ú]/, ''))
    .filter((v) => !known.toLowerCase().includes(v.toLowerCase()));
  if (vague.length) issues.push(`lugar vago (${[...new Set(vague)].join(', ')})`);
  return issues;
}

// ==== UI ====
function aiProgress(p, text = '') {
  const box = $('#ai-progress');
  box.hidden = p == null;
  if (p == null) return;
  $('#ai-progress-bar').style.width = `${Math.round(p * 100)}%`;
  // O texto do WebLLM é técnico ("Fetching param cache[3/27]: 412MB fetched..."); mostramos só o essencial.
  const mb = /([\d.]+)\s*MB fetched/.exec(text)?.[1];
  $('#ai-progress-text').textContent = mb ? `Baixando o modelo: ${Math.round(mb)} de ~${AI.downloadMB} MB (só na primeira vez)`
    : p >= 1 || /Finish|GPU|shader/i.test(text) ? 'Preparando o modelo na GPU…' : (text || 'Carregando…').slice(0, 80);
}
// "1) texto…" → { 1: 'texto…' }. Linhas sem número continuam a anterior.
function parseAiLines(text) {
  const out = {};
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\*\*|__|^#+\s*/g, '').trim();
    const m = /^(\d+)[).:-]\s*(.*)$/.exec(line);
    if (m) { cur = +m[1]; out[cur] = m[2]; } else if (cur && line) out[cur] += ` ${line}`;
  }
  return out;
}
// Estrutura fixa por momento: hora · lugar, a frase da IA, a configuração no formato padrão e o motivo técnico.
// Se a IA não escreveu um momento, entra a descrição determinística dele.
function renderAiOut(text, done, moments) {
  const lines = parseAiLines(text);
  const last = Math.max(0, ...Object.keys(lines).map(Number));
  const shown = done ? moments : moments.slice(0, Math.max(1, last));
  $('#ai-out').innerHTML = shown.map((m, i) => {
    // O modelo costuma repetir o lugar no começo ("Avenida X: …"), que já está no cabeçalho.
    const placePrefix = new RegExp(`^${m.onde.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:,—–-]\\s*`, 'i');
    const said = lines[i + 1]?.replace(placePrefix, '').replace(/^./, (c) => c.toUpperCase());
    const typing = !done && i + 1 === Math.max(1, last);
    const body = said ? esc(said) : done ? `${esc(m.ver[0].toUpperCase() + m.ver.slice(1))}.` : '';
    return `<div class="ai-moment"><div class="ai-when">${esc(m.hora)} · ${esc(m.onde)}</div>
      <p>${body}${typing ? '<span class="ai-caret"></span>' : ''}</p>
      ${!typing || done ? `<p class="ai-cam">📷 ${esc(camText(m.camera))}</p><p class="ai-why"><b>Por quê:</b> ${esc(m.camera.why)}</p>` : ''}</div>`;
  }).join('');
}
async function renderAiControls() {
  $('#ai-size').innerHTML = Object.entries(AI.sizes).map(([k, s]) =>
    `<button type="button" role="radio" aria-checked="${k === aiState.size}" data-size="${k}">${s.label}<small>${s.read}</small></button>`).join('');
  $('#quick-go').setAttribute('aria-pressed', String(aiState.mode === 'quick'));
  $('#ai-go').setAttribute('aria-pressed', String(aiState.mode === 'ai'));
  $('#ai-stop').hidden = !aiState.busy;
  const reason = await aiSupport();
  // Sem suporte, o botão continua visível (desativado) com o motivo, para não parecer que sumiu.
  $('#ai-unsupported').hidden = !reason;
  $('#ai-unsupported').textContent = reason ? `IA indisponível: ${reason} A resposta rápida continua disponível.` : '';
  $('#ai-go').disabled = !!reason;
  const ready = aiState.engine || aiModelCached();
  $('#ai-go').innerHTML = `✨ Gerar com IA<small>${reason ? 'indisponível neste navegador'
    : ready ? 'no seu aparelho' : `baixa ~${(AI.downloadMB / 1000).toFixed(1).replace('.', ',')} GB na 1ª vez`}</small>`;
}

// Escolha entre resposta rápida (regras) e IA. Antes da escolha, nenhuma sugestão aparece.
function setSuggestMode(mode) {
  aiState.mode = mode;
  const quick = $('#quick');
  quick.hidden = !mode;
  quick.classList.toggle('plain', mode === 'quick');
  quick.open = mode === 'quick';
  for (const id of ['#ai-out', '#ai-status']) $(id).hidden = mode !== 'ai';
  if (mode !== 'ai') $('#ai-stale').hidden = true;
  $('#facts-wrap').hidden = !mode;
  renderAiControls();
}
function resetSuggest() {
  if (aiState.busy) aiState.engine?.interruptGenerate();
  $('#ai-out').innerHTML = '';
  setStatus('ai-status', '');
  setSuggestMode(null);
}

async function aiGenerate() {
  if (aiState.busy) { aiState.engine?.interruptGenerate(); return; }
  const f = buildFacts();
  if (!f) return;
  setSuggestMode('ai');
  collapseStep('suggest');
  aiState.busy = true;
  const moments = aiMoments(f, AI.sizes[aiState.size].moments);
  aiState.factsKey = momentsText(moments);
  renderAiControls();
  $('#ai-stale').hidden = true;
  $('#ai-out').innerHTML = '';
  setStatus('ai-status', '');
  reveal(aiState.engine ? '#ai-stop' : '#ai-progress');
  try {
    const engine = await aiEngine();
    setStatus('ai-status', 'Escrevendo…', 'loading');
    reveal('#ai-out');
    const t0 = performance.now();
    const write = async (messages, temperature) => {
      const stream = await engine.chat.completions.create({
        messages, stream: true, temperature, top_p: 0.9, max_tokens: AI.sizes[aiState.size].maxTokens,
      });
      let text = '', lastScroll = 0;
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta?.content || '';
        renderAiOut(text, false, moments);
        // Acompanha o texto sendo escrito, sem rolar a cada token.
        if (performance.now() - lastScroll > 500) { lastScroll = performance.now(); reveal('#ai-status', 'nearest'); }
      }
      renderAiOut(text, true, moments);
      return text;
    };
    let text = await write(aiMessages(f, moments), 0.3);
    let issues = aiCheck(text, f, moments);
    // Uma nova tentativa, mais conservadora, apontando o que saiu errado.
    if (issues.length && aiState.busy) {
      setStatus('ai-status', `Revisando: a 1ª versão tinha ${issues.join('; ')}…`, 'loading');
      const fix = `Atenção: na versão anterior você errou (${issues.join('; ')}). Corrija seguindo as regras.`;
      text = await write(aiMessages(f, moments, fix), 0.1);
      issues = aiCheck(text, f, moments);
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    const warn = issues.length ? ` ⚠️ Atenção: ${issues.join('; ')}. Confira na resposta rápida abaixo.` : ' Modelo pequeno: confira na resposta rápida abaixo.';
    setStatus('ai-status', `Gerado no seu aparelho em ${secs} s.${warn}`, issues.length ? 'error' : null);
  } catch (e) {
    console.error('IA', e);
    const msg = /device.*lost|out of memory|OOM|allocate/i.test(String(e?.message || e))
      ? 'o aparelho ficou sem memória de vídeo para o modelo. Feche outras abas e tente de novo.'
      : `não consegui rodar o modelo (${String(e?.message || e).slice(0, 120)}).`;
    setStatus('ai-status', `IA indisponível: ${msg} A resposta rápida continua disponível.`, true);
  } finally {
    aiState.busy = false;
    renderAiControls();
  }
}

// Chamado a cada renderTrip(): avisa quando o texto da IA não corresponde mais aos dados atuais.
function aiOnFacts(f) {
  if (!$('#ai-out').textContent || aiState.busy) return;
  $('#ai-stale').hidden = momentsText(aiMoments(f, AI.sizes[aiState.size].moments)) === aiState.factsKey;
}

$('#ai-go').addEventListener('click', aiGenerate);
$('#ai-stop').addEventListener('click', () => aiState.engine?.interruptGenerate());
$('#quick-go').addEventListener('click', () => {
  setSuggestMode('quick');
  collapseStep('suggest');
  reveal('#quick');
});
$('#ai-size').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-size]');
  if (!b) return;
  aiState.size = b.dataset.size;
  try { localStorage.setItem('isocronas.aiSize', aiState.size); } catch { /* sem armazenamento */ }
  if (state.trip) renderTrip(); // resposta rápida reflete o novo tamanho; texto da IA fica marcado como desatualizado
  renderAiControls();
});
