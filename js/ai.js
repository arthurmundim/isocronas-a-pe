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

  add({ hora: S.hora, onde: f.origem.nome || 'o ponto de partida', prio: 1000, inicio: true,
    ver: `saída com luz de ${S.fase}`, camera: cameraForPhase(S.fase, blocked) });
  const next = f.luz.proximo_evento;
  const sky = !f.nuvens ? '' : blocked ? `; céu ${f.nuvens.total_pct}% encoberto, luz difusa`
    : f.nuvens.altas_pct >= 40 && f.nuvens.baixas_pct < 40 ? '; nuvens altas que podem pegar cor' : '';
  add({ hora: C.hora, onde: f.destino.nome || 'o destino', prio: 1000, fim: true,
    ver: `você chega na ${C.fase}${next ? `; ${next.evento} ${next.minutos_apos_chegada} min depois (${next.hora})` : ''}${sky}`,
    camera: cameraForPhase(C.fase, blocked) });

  for (const e of f.luz.eventos_durante) add({ hora: e.hora, onde: 'no caminho', prio: 88, ver: `${e.evento}: a luz muda`,
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
    if (m.t <= 3 && m.onde !== 'no caminho' && start.onde === (f.origem.nome || 'o ponto de partida')) {
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
const momentsText = (ms) => ms.map((m, i) => `${i + 1}) ${m.hora} — ${m.onde} — o que observar: ${m.ver} — câmera: ${m.camera}`).join('\n');

// ==== PROMPT ====
const AI_SYSTEM = [
  'Você é um amigo fotógrafo. Reescreva cada momento numerado como um parágrafo curto (1 ou 2 frases), falando com "você",',
  'exatamente um parágrafo por momento, na mesma quantidade de momentos recebidos,',
  'em português do Brasil simples, com tom leve e sugestivo.',
  'Regras: mantenha a ordem; comece cada parágrafo pelo horário; copie exatamente os nomes, horários e a configuração de câmera;',
  'não acrescente lugares, pessoas, objetos, cores ou números que não estejam no momento; não use listas, títulos nem markdown.',
].join(' ');
// Exemplo (few-shot) com lugares de outra cidade, para o modelo não copiar nomes reais da rota.
const AI_EXAMPLE_IN = [
  '1) 07:10 — Praça XV — o que observar: saída com luz de golden hour — câmera: ISO 100–400, f/5.6–8, 1/250 s',
  '2) 07:18 — Rua do Ouvidor — o que observar: fachadas do lado esquerdo com luz quente vindo de lado — câmera: f/8–11, ISO baixo, câmera nivelada para não entortar as verticais',
  '3) 07:25 — Paço Imperial — o que observar: você chega na golden hour; fim da golden hour da manhã 12 min depois (07:37) — câmera: ISO 100–400, f/5.6–8, 1/250 s',
].join('\n');
const AI_EXAMPLE_OUT = [
  'Às 07:10, na Praça XV, a luz ainda está baixinha e dourada: aproveite logo na saída. Vá de ISO 100–400, f/5.6–8 e 1/250 s.',
  'Lá pelas 07:18, na Rua do Ouvidor, repare nas fachadas do lado esquerdo pegando luz quente de lado, ótimas para textura. Use f/8–11, ISO baixo e mantenha a câmera nivelada para não entortar as verticais.',
  'Por volta das 07:25 você chega ao Paço Imperial ainda na golden hour, que termina às 07:37: dá tempo, mas sem enrolar. Fique em ISO 100–400, f/5.6–8, 1/250 s.',
].join('\n\n');
function aiMessages(moments) {
  return [
    { role: 'system', content: AI_SYSTEM },
    { role: 'user', content: `Momentos (3):\n${AI_EXAMPLE_IN}` },
    { role: 'assistant', content: AI_EXAMPLE_OUT },
    { role: 'user', content: `Momentos (${moments.length}):\n${momentsText(moments)}` },
  ];
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
function renderAiOut(text, done) {
  const paras = text.trim().split(/\n\s*\n|\n/).filter(Boolean);
  $('#ai-out').innerHTML = paras.map((p) => `<p>${esc(p.replace(/\*\*|__|^#+\s*/g, ''))}</p>`).join('') + (done ? '' : '<span class="ai-caret"></span>');
}
async function renderAiControls() {
  $('#ai-size').innerHTML = Object.entries(AI.sizes).map(([k, s]) =>
    `<button type="button" role="radio" aria-checked="${k === aiState.size}" data-size="${k}">${s.label}<small>${s.read}</small></button>`).join('');
  $('#quick-go').setAttribute('aria-pressed', String(aiState.mode === 'quick'));
  $('#ai-go').setAttribute('aria-pressed', String(aiState.mode === 'ai'));
  const reason = await aiSupport();
  $('#ai-unsupported').hidden = !reason;
  $('#ai-unsupported').textContent = reason ? `IA indisponível: ${reason} A resposta rápida continua disponível.` : '';
  $('#ai-go').hidden = !!reason;
  $('.choice').style.gridTemplateColumns = reason ? '1fr' : '';
  if (reason) return;
  if (aiState.busy) $('#ai-go').innerHTML = '■ Parar<small>interromper o texto</small>';
  else {
    const ready = aiState.engine || aiModelCached();
    $('#ai-go').innerHTML = `✨ Gerar com IA<small>${ready ? 'no seu aparelho' : `baixa ~${(AI.downloadMB / 1000).toFixed(1).replace('.', ',')} GB na 1ª vez`}</small>`;
  }
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
  aiState.busy = true;
  const moments = aiMoments(f, AI.sizes[aiState.size].moments);
  aiState.factsKey = momentsText(moments);
  renderAiControls();
  $('#ai-stale').hidden = true;
  $('#ai-out').innerHTML = '';
  setStatus('ai-status', '');
  reveal(aiState.engine ? '#ai-go' : '#ai-progress');
  try {
    const engine = await aiEngine();
    setStatus('ai-status', 'Escrevendo…', 'loading');
    reveal('#ai-out');
    const t0 = performance.now();
    const stream = await engine.chat.completions.create({
      messages: aiMessages(moments), stream: true, stream_options: { include_usage: true },
      temperature: 0.3, top_p: 0.9, max_tokens: AI.sizes[aiState.size].maxTokens,
    });
    let text = '', usage = null, lastScroll = 0;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content || '';
      if (chunk.usage) usage = chunk.usage;
      renderAiOut(text, false);
      // Acompanha o texto sendo escrito, sem rolar a cada token.
      if (performance.now() - lastScroll > 500) { lastScroll = performance.now(); reveal('#ai-status', 'nearest'); }
    }
    renderAiOut(text, true);
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    const tps = usage?.extra?.decode_tokens_per_s;
    // Checagem barata de alucinação: horários no texto que não estão nos momentos.
    const known = momentsText(moments);
    const invented = [...new Set(text.match(/\b\d{1,2}:\d{2}\b/g) || [])].filter((h) => !known.includes(h.padStart(5, '0')));
    const warn = invented.length ? ` ⚠️ O texto cita ${invented.join(', ')}, que não está nos dados.` : '';
    setStatus('ai-status', `Gerado no seu aparelho em ${secs} s${tps ? ` (${tps.toFixed(0)} tokens/s)` : ''}. Modelo pequeno: confira na resposta rápida abaixo.${warn}`, warn ? 'error' : null);
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
$('#quick-go').addEventListener('click', () => {
  setSuggestMode('quick');
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
