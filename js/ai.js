'use strict';
// ==== IA NO NAVEGADOR (WEBLLM + WEBGPU) ====
// O modelo roda no aparelho: nada é enviado a servidor. Ele só reescreve os momentos montados a partir de buildFacts();
// regras e configurações de câmera continuam determinísticas.
const AI = {
  lib: 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm',
  models: { f16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' },
  downloadMB: 900,
  // Tamanho → quantos momentos entram no texto da IA (~2 frases cada), quantas dicas rápidas e teto de tokens.
  sizes: {
    curto: { label: 'Curto', moments: 3, tips: 3, maxTokens: 240 },
    medio: { label: 'Médio', moments: 4, tips: 5, maxTokens: 330 },
    longo: { label: 'Longo', moments: 6, tips: 8, maxTokens: 500 },
  },
};
// mode: null (nada escolhido ainda), 'quick' (resposta rápida) ou 'ai'.
const aiState = { webllm: null, engine: null, modelId: null, loading: null, busy: false, size: 'medio', factsKey: null, unsupported: null, mode: null, gen: 0, cancelled: false };
try { aiState.size = localStorage.getItem('isocronas.aiSize') || 'medio'; } catch { /* sem armazenamento */ }

// Motivo de não suportar, ou null. Checado uma vez, antes de qualquer download.
async function aiSupport() {
  if (aiState.unsupported !== null) return aiState.unsupported;
  let reason = null;
  if (!navigator.gpu) reason = 'este navegador não roda IA no aparelho (falta WebGPU). Use Chrome ou Edge atualizados (no Android, Chrome).';
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
  historic: ['detalhes e textura da fachada histórica', 'arquitetura'], worship: ['fachada e torres da igreja', 'arquitetura'],
  park: ['verde e sombra aberta', 'retrato sombra'], fountain: ['água e reflexos', 'agua'], cafe: ['gente nas mesas e vitrines', 'street'],
};
// "chega na golden hour" / "chega à noite" / "chega com sol baixo".
const phaseAt = (fase) => (/hour$/.test(fase) ? `na ${fase}` : fase === 'noite' ? 'à noite' : `com ${fase}`);
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

  // Fase da luz num horário da caminhada, pelo trecho em andamento (para POIs e trechos).
  const phaseAtTime = (h) => {
    const t = f.trechos.filter((x) => rel(x.inicio) <= rel(h)).at(-1);
    return t ? lightPhase(t.altitude_sol) : C.fase;
  };
  add({ hora: S.hora, onde: f.origem.nome, prio: 1000, inicio: true, phase: S.fase,
    ver: `saída com luz de ${S.fase}`, camera: cameraForPhase(S.fase, blocked) });
  const next = f.luz.proximo_evento;
  const sky = !f.nuvens ? '' : blocked ? `; céu ${f.nuvens.total_pct}% encoberto, luz difusa`
    : f.nuvens.altas_pct >= 40 && f.nuvens.baixas_pct < 40 ? '; nuvens altas que podem pegar cor' : '';
  add({ hora: C.hora, onde: f.destino.nome, prio: 1000, fim: true, phase: C.fase, cat: f._destCat, scene: f._destScene,
    ver: `você chega ${phaseAt(C.fase)}${next ? `; ${next.evento} ${next.minutos_apos_chegada} min depois (${next.hora})` : ''}${sky}`,
    camera: cameraForPhase(C.fase, blocked) });

  // Onde você estará num horário: a rua (nomeada) do trecho em andamento, nunca um vago "no caminho".
  const streetAtTime = (h) => f.trechos.filter((t) => !t.rua.startsWith('calçada') && rel(t.inicio) <= rel(h)).at(-1)?.rua || f.destino.nome;
  for (const e of f.luz.eventos_durante) add({ kind: 'evento', hora: e.hora, onde: streetAtTime(e.hora), prio: 88, ver: `${e.evento}: a luz muda`, phase: /blue/.test(e.evento) ? 'blue hour' : 'golden hour',
    camera: cameraForPhase(/blue/.test(e.evento) ? 'blue hour' : 'golden hour', blocked) });

  if (!blocked) {
    const seen = new Set();
    for (const t of f.trechos) {
      if (seen.has(t.rua) || t.rua.startsWith('calçada') || t.altitude_sol <= -1) continue;
      const ph = lightPhase(t.altitude_sol);
      if (t.corredor_de_luz) add({ kind: 'corredor', hora: t.inicio, onde: t.rua, prio: 92, phase: ph, ver: 'a rua fica alinhada com o sol baixo e a luz atravessa a rua inteira', camera: CAMERA['sol baixo'] });
      else if (t.luz.startsWith('contraluz') && t.altitude_sol < 25) add({ kind: 'contraluz', hora: t.inicio, onde: t.rua, prio: likes(['street', 'retrato', 'minimal']) ? 86 : 72, phase: ph,
        ver: styles.has('retrato') ? 'você anda contra o sol: contorno de luz no cabelo de quem estiver de costas para ele' : 'você anda contra o sol: silhuetas de quem passa e reflexos no chão',
        camera: styles.has('retrato') ? CAMERA['contraluz retrato'] : CAMERA.contraluz });
      else if (t.fachadas_iluminadas && t.altitude_sol > 0 && t.altitude_sol < 25) add({ kind: 'fachadas', hora: t.inicio, onde: t.rua, prio: likes(['arquitetura']) ? 86 : 70, phase: ph, scene: 'arquitetura',
        ver: `fachadas do ${t.fachadas_iluminadas} com luz quente vindo de lado`, camera: cameraForScene('arquitetura', ph, blocked) });
      else continue;
      seen.add(t.rua);
    }
  }
  for (const p of f._pontos) {
    const idea = p.ideia, cam = p.scene; // pelo tipo real do lugar (poiKind): estátua ≠ fachada
    const ph = phaseAtTime(p.hora_aprox);
    // Cena de retrato só para quem marcou retrato; sem isso, o parque segue a luz do momento.
    const scene = cam === 'retrato sombra' && !styles.has('retrato') ? null : cam;
    add({ hora: p.hora_aprox, onde: p.nome, prio: likes(CAT_STYLES[p.cat] || []) ? 84 : 66, ver: idea, phase: ph, scene, cat: p.cat, pid: p.id, camera: cameraForScene(scene, ph, blocked) });
  }
  // Momentos colados na saída ou na chegada (≤ 3 min) viram parte delas, para não repetir horário.
  const start = cand.find((m) => m.inicio), end = cand.find((m) => m.fim);
  const endT = rel(C.hora);
  const merged = cand.filter((m) => {
    if (m === start || m === end) return true;
    if (m.t <= 3 && m.kind === 'evento') { start.ver += `; ${m.ver.replace(/: a luz muda$/, ' bem na saída')}`; return false; }
    if (m.t <= 3 && start.onde === f.origem.nome) {
      Object.assign(start, { kind: m.kind, onde: m.onde, ver: `${start.ver}; ${m.ver}`, camera: m.camera, scene: m.scene, cat: m.cat, pid: m.pid, phase: m.phase || start.phase });
      return false;
    }
    if (endT - m.t <= 3) {
      // Evento de luz vira "bem na chegada"; lugar próximo mantém o nome (senão "igreja" aparecia no bloco do café).
      if (m.pid) (end.extraPids ||= []).push(m.pid); // destacado no mapa junto com o destino
      end.ver += m.kind === 'evento' ? `; ${m.ver.replace(/: a luz muda$/, ' bem na chegada')}` : `; logo antes, ${m.onde}: ${m.ver}`;
      return false;
    }
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
  'Não copie a descrição do momento: diga com suas palavras o que fazer ali.',
  // Testado: sem isso o modelo devolvia o esboço quase igual ("Café X: gente nas mesas e vitrines.") em ~60% das linhas.
  'Comece cada linha, logo depois do número, com um verbo de ação no imperativo: Olhe, Fotografe, Procure, Espere, Aproveite, Enquadre, Comece ou Priorize.',
].join(' ');
// Exemplo (few-shot) com lugares de outra cidade, para o modelo não copiar nomes reais da rota.
const AI_EXAMPLE_IN = [
  '1) Praça XV — o que observar: saída com luz de golden hour',
  '2) Rua do Ouvidor — o que observar: fachadas do lado esquerdo com luz quente vindo de lado',
  '3) Paço Imperial — o que observar: você chega na golden hour; fim da golden hour da manhã 12 min depois',
].join('\n');
const AI_EXAMPLE_OUT = [
  '1) Comece pelas cenas abertas da Praça XV, enquanto a luz ainda está baixa e dourada, antes que ela suba.',
  '2) Olhe para as fachadas do lado esquerdo da Rua do Ouvidor pegando luz de lado: é a hora de mostrar textura de reboco e janelas.',
  '3) Priorize a fachada principal do Paço Imperial enquanto a luz está quente: a golden hour acaba em poucos minutos.',
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
// ---- Checagem por momento ----
// Cada linha do modelo é checada contra o próprio momento. Depois da nova tentativa, os momentos que continuam com
// problema mostram o texto do app (marcado como tal), e não uma frase errada como se fosse da IA.
const normTxt = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// O modelo costuma repetir o lugar no começo ("Avenida X: …"), que já está no cabeçalho do bloco.
const placePrefixRe = (m) => new RegExp(`^${m.onde.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:,—–-]\\s*`, 'i');
// Lugar com nome próprio ("Rio São Francisco", "Rua dos Desejos") e elementos da paisagem que não estão nos dados.
const AI_PLACE = /\b(?:Rua|Avenida|Av\.|Praça|Largo|Rio|Ponte|Parque|Igreja|Museu|Travessa|Alameda|Estação|Mercado|Teatro|Lagoa|Praia|Morro)\s+(?:(?:d[aeo]s?|e)\s+)?[A-ZÀ-Ú][\wÀ-ú]+(?:\s+[A-ZÀ-Ú][\wÀ-ú]+)*/g;
// Paisagem, materiais e cores (testado: "rio", "peça de plástico"): só valem se estiverem nos dados.
const AI_ELEMENTS = /\b(rio|rios|mar|praia|lago|lagoa|ponte|morro|montanha|cachoeira|chuva|neve|lua|estrelas?|pl[áa]stico|bronze|m[áa]rmore|madeira|metal|pedra|vidro|ferro|granito|concreto|vermelh[oa]s?|amarel[oa]s?|verdes?|roxo|rosa|laranja|prateado)\b/gi;
// Palavras comuns a vários momentos (luz, fase, direção): não indicam mistura de um momento com outro.
const AI_SHARED = new Set(['golden', 'fachadas', 'fachada', 'esquerdo', 'direito', 'quente', 'vindo', 'vinda', 'batendo', 'depois', 'antes', 'saida',
  'chega', 'chegada', 'minutos', 'baixo', 'noite', 'historica', 'detalhes', 'textura', 'contra', 'fundo', 'limpo', 'escrito', 'observar', 'momento']);
function aiLineIssues(line, m, f, known, others = []) {
  if (!line) return ['faltou o texto'];
  const out = [];
  const kn = known.toLowerCase();
  // Cópia do esboço: o app já tem essa descrição; a IA precisa escrever com as próprias palavras.
  const body = normTxt(line.replace(placePrefixRe(m), '')), ver = normTxt(m.ver);
  const words = new Set(body.split(' ')), key = ver.split(' ').filter((w) => w.length > 3);
  const overlap = key.filter((w) => words.has(w)).length / Math.max(1, key.length);
  // Cópia parcial: o parêntese do esboço ("a peça (placa)") só aparece quando o modelo copia.
  if (body.includes(ver) || (overlap >= 0.85 && words.size <= key.length + 5) || /\([a-zà-ú ]+\)/.test(line)) out.push('copiou a descrição do app em vez de escrever');
  // Mistura: palavra própria de outro momento (testado: "vitrines e mesas" do café no bloco da praça).
  const mine = new Set(`${ver} ${normTxt(m.onde)}`.split(' '));
  const foreign = [...new Set(others.flatMap((v) => normTxt(v).split(' ')))].filter((w) => w.length >= 5 && !mine.has(w) && !AI_SHARED.has(w) && words.has(w));
  if (foreign.length) out.push(`misturou com outro momento (${foreign.join(', ')})`);
  // Detalhes do exemplo do prompt (testado: "textura de reboco e janelas" num café).
  const leak = (line.match(/reboco|janelas|cenas abertas|fachada principal|antes que ela suba/gi) || []).filter((x) => !`${m.ver} ${m.onde}`.toLowerCase().includes(x.toLowerCase()));
  if (leak.length) out.push(`trouxe detalhes do exemplo (${[...new Set(leak)].join(', ')})`);
  const times = [...new Set(line.match(/\b\d{1,2}:\d{2}\b/g) || [])].filter((h) => !known.includes(h.padStart(5, '0')));
  if (times.length) out.push(`horário fora dos dados (${times.join(', ')})`);
  // Configuração de câmera é sempre montada pelo app; no texto do modelo ela não deve aparecer.
  const cams = [...cameraNumbers(line)];
  if (cams.length) out.push(`escreveu configuração de câmera (${cams.map((c) => c.replace(/^(iso|f|s|ev)/, (k) => ({ iso: 'ISO ', f: 'f/', s: '1/', ev: 'EV ' }[k]))).join(', ')})`);
  const gear = (line.match(/\b(flash|trip[ée]|lentes?|teleobjetiva|grande[- ]angular|filtros?|rebatedor|polarizador)\b/gi) || []).filter((g) => !kn.includes(g.toLowerCase()));
  if (gear.length) out.push(`equipamento não sugerido (${[...new Set(gear.map((g) => g.toLowerCase()))].join(', ')})`);
  const places = (line.match(AI_PLACE) || []).filter((p) => !kn.includes(p.toLowerCase()));
  if (places.length) out.push(`lugar que não está nos dados (${[...new Set(places)].join(', ')})`);
  const els = (line.match(AI_ELEMENTS) || []).filter((e) => !new RegExp(`\\b${e}\\b`, 'i').test(known));
  if (els.length) out.push(`elemento que não está nos dados (${[...new Set(els.map((e) => e.toLowerCase()))].join(', ')})`);
  // Luz coerente com a fase do momento (o modelo trocava golden e blue hour).
  const own = m.ver.toLowerCase();
  if (isLowLight(m.phase) && /dourad|golden|sol (baixo|forte|direto)|luz do sol/i.test(line) && !/dourad|golden|sol/.test(own)) out.push(`fala de sol/luz dourada na ${m.phase}`);
  if (!isLowLight(m.phase) && /c[ée]u (ainda )?azul|luzes (da rua |da cidade )?(est[ãa]o )?acesas|postes acesos|letreiros acesos|blue hour/i.test(line) && !/blue hour|acesa/.test(own))
    out.push(`fala de luz de noite com ${m.phase}`);
  const cl = f.nuvens?.total_pct;
  if (cl >= 85 && /c[ée]u (claro|limpo|aberto)|poucas? nuve|sem nuvens|luz (que chega )?diret|chega diret|contraluz|sombras? longas?|sol direto|c[ée]u colorido/i.test(line))
    out.push(`céu contraditório (${cl}% encoberto)`);
  if (cl != null && cl < 30 && /c[ée]u (encoberto|fechado|nublado)|luz difusa/i.test(line)) out.push(`céu contraditório (só ${cl}% de nuvens)`);
  const w = aiWindow(f);
  for (const [k, re, n] of [['nascer', /nascer do sol/i, 'nascer do sol'], ['por_do_sol', /p[ôo]r do sol/i, 'pôr do sol'], ['blue_hour', /blue hour/i, 'blue hour']])
    if (re.test(line) && !w.has(k) && !re.test(known)) out.push(`cita ${n}, que não acontece nesse período`);
  // Sem \b depois de palavra acentuada ("café"): em regex JS sem a flag u, "é" não conta como letra.
  // Substantivo em minúscula = genérico ("a estação"); com maiúscula é nome ("Estação da Luz").
  const vague = (line.match(/(?:^|[^\wÀ-ú])(?:[oO]|ao|no|do|pelo|[aA]|à|na|da|pela) (?:café|prédio|bar|restaurante|museu|monumento|praça|igreja|loja|estação)(?![\wÀ-ú])(?! sem nome)/g) || [])
    .map((v) => v.replace(/^[^\wÀ-ú]/, ''))
    // Lugar descrito pela rua nos dados ("café, na altura da Rua X") pode ser chamado de "o café".
    .filter((v) => !kn.includes(v.toLowerCase()) && !kn.includes(`${v.split(' ').pop().toLowerCase()},`));
  if (vague.length) out.push(`lugar vago (${[...new Set(vague)].join(', ')})`);
  return out;
}
// Índice do momento → problemas.
function aiLineProblems(text, f, moments) {
  const known = `${momentsText(moments)}\n${aiContext(f)}`;
  const lines = parseAiLines(text);
  const out = new Map();
  moments.forEach((m, i) => {
    const others = moments.filter((_, j) => j !== i).map((x) => x.ver);
    const iss = aiLineIssues(lines[i + 1], m, f, known, others);
    if (iss.length) out.set(i, iss);
  });
  return out;
}
function aiCheck(text, f, moments) {
  return [...aiLineProblems(text, f, moments)].map(([i, iss]) => `momento ${i + 1}: ${iss.join(', ')}`);
}

// ==== UI ====
function aiProgress(p, text = '') {
  if (aiState.cancelled) p = null; // download segue em segundo plano após cancelar, sem mostrar barra
  const box = $('#ai-progress');
  box.hidden = p == null;
  if (p == null) return;
  $('#ai-progress-bar').style.width = `${Math.round(p * 100)}%`;
  // O texto do WebLLM é técnico ("Fetching param cache[3/27]: 412MB fetched..."); mostramos só o essencial.
  const mb = /([\d.]+)\s*MB fetched/.exec(text)?.[1];
  $('#ai-progress-text').textContent = mb ? `Baixando o modelo: ${Math.round(mb)} de ~${AI.downloadMB} MB (só na primeira vez)`
    : /from cache|loaded/i.test(text) ? `Carregando o modelo já baixado: ${Math.round(p * 100)}%`
    : p >= 1 || /Finish|GPU|shader/i.test(text) ? 'Preparando o modelo na GPU…' : 'Carregando…';
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
// Se a IA não escreveu um momento, ou se o texto dela não passou na checagem (appLines), entra a descrição
// determinística, marcada como "texto do app".
// animate: cada momento entra em sequência (fade), uma única vez, depois que o texto inteiro está pronto.
function renderAiOut(text, done, moments, { animate = false, appLines = new Set() } = {}) {
  const lines = parseAiLines(text);
  const last = Math.max(0, ...Object.keys(lines).map(Number));
  const shown = done ? moments : moments.slice(0, Math.max(1, last));
  $('#ai-out').innerHTML = shown.map((m, i) => {
    const said = appLines.has(i) ? null : lines[i + 1]?.replace(placePrefixRe(m), '').replace(/^./, (c) => c.toUpperCase());
    const typing = !done && i + 1 === Math.max(1, last);
    const body = said ? esc(said) : done ? `${esc(m.ver[0].toUpperCase() + m.ver.slice(1))}. <small class="ai-src" title="A IA errou neste momento; este é o texto calculado pelo app">texto do app</small>` : '';
    return `<div class="ai-moment${animate ? ' ai-in' : ''}" style="animation-delay:${(i * 0.4).toFixed(1)}s"><div class="ai-when">${esc(m.hora)} · ${esc(m.onde)}</div>
      <p>${body}${typing ? '<span class="ai-caret"></span>' : ''}</p>
      ${!typing || done ? `<p class="ai-cam">📷 ${esc(camText(m.camera))}</p><p class="ai-why"><b>Por quê:</b> ${esc(m.camera.why)}</p>` : ''}${done ? qaBlockHtml(i) : ''}</div>`;
  }).join('');
}
async function renderAiControls() {
  $('#ai-size').innerHTML = Object.entries(AI.sizes).map(([k, s]) =>
    `<button type="button" role="radio" aria-checked="${k === aiState.size}" data-size="${k}">${s.label}<small>${s.tips} dicas · ${s.moments} momentos</small></button>`).join('');
  $('#quick-go').setAttribute('aria-pressed', String(aiState.mode === 'quick'));
  $('#ai-go').setAttribute('aria-pressed', String(aiState.mode === 'ai'));

  const reason = await aiSupport();
  // Sem suporte, o botão continua visível (desativado) com o motivo, para não parecer que sumiu.
  $('#ai-unsupported').hidden = !reason;
  $('#ai-unsupported').textContent = reason ? `IA indisponível: ${reason} As dicas rápidas continuam disponíveis.` : '';
  $('#ai-go').disabled = !!reason;
  const ready = aiState.engine || aiModelCached();
  $('#ai-go').innerHTML = `✨ Roteiro com IA<small>${reason ? 'indisponível neste navegador'
    : ready ? 'texto por horário, ~1 min' : `texto por horário · baixa ~${(AI.downloadMB / 1000).toFixed(1).replace('.', ',')} GB na 1ª vez`}</small>`;
}

// Na primeira vez, o download do modelo (~0,9 GB) só começa depois de a pessoa confirmar.
function aiConfirmDownload() {
  if (aiState.engine || aiModelCached()) return Promise.resolve(true);
  const box = $('#ai-confirm');
  box.hidden = false;
  reveal(box, 'nearest');
  return new Promise((resolve) => {
    const done = (ok) => { box.hidden = true; $('#ai-confirm-yes').onclick = $('#ai-confirm-no').onclick = null; resolve(ok); };
    $('#ai-confirm-yes').onclick = () => done(true);
    $('#ai-confirm-no').onclick = () => done(false);
  });
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
  $('#facts-wrap').hidden = !mode || !DEBUG;
  renderAiControls();
}
function resetSuggest() {
  if (aiState.busy) aiInterrupt();
  $('#ai-out').innerHTML = '';
  setStatus('ai-status', '');
  qaReset();
  setSuggestMode(null);
  focusReset();
}

// interruptGenerate() com o modelo parado fica "armado" e corta a PRÓXIMA geração (que sai vazia):
// só interrompe quando há uma geração em andamento. Toda chamada ao motor passa por engineRun.
// Além disso, no WebLLM 0.2.85 a chamada sem streaming checa o sinal antes de gerar e nunca o zera: depois de um
// "Cancelar", todas as respostas seguintes sairiam vazias. Zeramos o sinal quando o motor fica livre.
let aiGenerating = 0;
async function engineRun(fn) {
  aiGenerating++;
  try { return await fn(); } finally {
    aiGenerating--;
    if (aiGenerating === 0 && aiState.engine && 'interruptSignal' in aiState.engine) aiState.engine.interruptSignal = false;
  }
}
function aiInterrupt() {
  if (aiGenerating > 0) aiState.engine?.interruptGenerate();
}

// Cancelar a IA: interrompe o modelo e volta à escolha entre resposta rápida e IA. Um download do modelo já
// iniciado continua em segundo plano (o WebLLM não permite abortá-lo), mas o resultado é ignorado.
function cancelAi() {
  aiState.cancelled = true;
  aiState.gen++; // a geração em andamento passa a ser ignorada
  aiState.busy = false;
  aiInterrupt();
  aiProgress(null);
  $('#ai-out').innerHTML = '';
  setStatus('ai-status', '');
  qaReset();
  focusReset();
  setSuggestMode(null);
  openStep('suggest');
  setStatus('ai-status', 'Geração cancelada. Escolha de novo quando quiser.');
  $('#ai-status').hidden = false;
  reveal(stepEl('suggest'));
}

async function aiGenerate() {
  if (qaState.busy || aiState.busy) return; // uma requisição por vez no motor
  if (await aiSupport() || !(await aiConfirmDownload())) return;
  // Geração atual: um "Cancelar" incrementa aiState.gen e a geração antiga, quando terminar, não mexe em nada.
  const gen = ++aiState.gen;
  const stale = () => gen !== aiState.gen;
  const f = buildFacts();
  if (!f) return;
  setSuggestMode('ai');
  focusReset(); // o foco da resposta rápida sai enquanto a IA escreve
  collapseStep('suggest');
  aiState.busy = true;
  aiState.cancelled = false;
  const moments = aiMoments(f, AI.sizes[aiState.size].moments);
  aiState.factsKey = momentsText(moments);
  qaReset(moments, f); // perguntas por bloco recomeçam a cada texto gerado
  renderAiControls();
  $('#ai-stale').hidden = true;
  $('#ai-out').innerHTML = '';
  setStatus('ai-status', aiState.engine ? 'Preparando…' : 'Carregando o modelo…', 'loading');
  opStart('ai', '#ai-status', cancelAi);
  reveal(aiState.engine ? '#ai-status' : '#ai-progress');
  try {
    await qaState.pending; // pré-aquecimento das perguntas ainda rodando: o motor atende um por vez
    const engine = await aiEngine();
    if (stale()) return;
    const t0 = performance.now();
    // Gera tudo antes de mostrar (a nova tentativa, se houver, não aparece como uma 2ª animação).
    const write = (messages, temperature, label) => engineRun(async () => {
      const stream = await engine.chat.completions.create({
        messages, stream: true, temperature, top_p: 0.9, max_tokens: AI.sizes[aiState.size].maxTokens,
      });
      let text = '';
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta?.content || '';
        const done = Math.min(moments.length, Object.keys(parseAiLines(text)).length);
        setStatus('ai-status', `${label} (${done} de ${moments.length} momentos)…`, 'loading');
      }
      return text;
    });
    let text = await write(aiMessages(f, moments), 0.3, 'Escrevendo');
    let bad = aiLineProblems(text, f, moments);
    // Uma nova tentativa, mais conservadora, apontando o que saiu errado em cada momento.
    if (bad.size && !stale()) {
      const fix = `Atenção: na versão anterior você errou (${aiCheck(text, f, moments).join('; ')}). Escreva com suas palavras, usando só o que está em cada momento.`;
      const retry = await write(aiMessages(f, moments, fix), 0.5, 'Revisando'); // temperatura baixa favorecia copiar o esboço
      // Fica, por momento, a linha que passou na checagem (da nova tentativa ou da primeira).
      const bad2 = aiLineProblems(retry, f, moments);
      const l1 = parseAiLines(text), l2 = parseAiLines(retry);
      text = moments.map((_, i) => `${i + 1}) ${(!bad2.has(i) ? l2 : !bad.has(i) ? l1 : l2)[i + 1] || ''}`).join('\n');
      bad = new Map([...bad2].filter(([i]) => bad.has(i)));
    }
    if (stale()) return;
    opEnd('ai');
    renderAiOut(text, true, moments, { animate: true, appLines: new Set(bad.keys()) });
    reveal('#ai-out');
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    const why = [...new Set([...bad.values()].flat().map((s) => s.replace(/ \(.*\)$/, '')))].join('; ');
    const warn = bad.size ? ` ${bad.size} de ${moments.length} momentos ficaram com o texto do app (a IA errou: ${why}).` : ' Modelo pequeno: confira nas dicas rápidas abaixo.';
    setStatus('ai-status', `Gerado no seu aparelho em ${secs} s.${warn}`);
    flowSuggestionShown();
    qaWarmup(); // prepara o formato das respostas das perguntas em segundo plano
  } catch (e) {
    if (stale()) return;
    console.error('IA', e);
    const msg = /device.*lost|out of memory|OOM|allocate/i.test(String(e?.message || e))
      ? 'o aparelho ficou sem memória de vídeo para o modelo. Feche outras abas e tente de novo.'
      : `não consegui rodar o modelo (${String(e?.message || e).slice(0, 120)}).`;
    setStatus('ai-status', `IA indisponível: ${msg} As dicas rápidas continuam disponíveis.`, true);
  } finally {
    if (stale()) return; // cancelada: a tela já voltou para a escolha
    aiState.busy = false;
    opEnd('ai');
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
  $('#ai-confirm').hidden = true;
  setSuggestMode('quick');
  collapseStep('suggest');
  reveal('#quick');
  flowSuggestionShown(); // mapa destaca os pontos citados nas dicas
});
$('#ai-size').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-size]');
  if (!b) return;
  aiState.size = b.dataset.size;
  try { localStorage.setItem('isocronas.aiSize', aiState.size); } catch { /* sem armazenamento */ }
  if (state.trip) renderTrip(); // resposta rápida reflete o novo tamanho; texto da IA fica marcado como desatualizado
  renderAiControls();
});
