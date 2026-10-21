'use strict';
// ==== HORÁRIO DA CAMINHADA (SAIR ÀS / CHEGAR ÀS) ====
// Hora atual no fuso do lugar, arredondada para os próximos 5 min.
function nowHHMM() {
  const d = new Date(Math.ceil(Date.now() / 300e3) * 300e3);
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tzName() }).format(d);
}
const hhmm = (d) => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tzName() }).format(d);

function tripTimes() {
  const t = state.trip;
  if (!t || !state.depart.time) return null;
  const base = zonedDate(state.date, state.depart.time, tzName());
  const leave = state.depart.mode === 'leave' ? base : new Date(base.getTime() - t.time * 1000);
  return { leave, arrive: new Date(leave.getTime() + t.time * 1000) };
}

// Atalhos "chegar na golden hour" etc., calculados para o destino e a data escolhida.
function quickTargets() {
  const { lat, lng } = lightAnchor();
  const s = sunTimes(state.date, lat, lng);
  return [
    ['Nascer do sol', s.sunrise], ['Golden manhã', s.blueHourEnd],
    ['Golden tarde', s.goldenHour], ['Pôr do sol', s.sunset], ['Blue hour', s.blueHourStart],
  ].filter(([, d]) => valid(d)).sort((a, b) => a[1] - b[1]);
}

function renderTripControls() {
  $('#trip-mode').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === state.depart.mode)));
  $('#trip-time').value = state.depart.time || '';
  $('#trip-quick').innerHTML = `<button type="button" class="chip" data-now="1">Agora</button>` + quickTargets().map(([label, d]) =>
    `<button type="button" class="chip" data-arrive="${hhmm(d)}" title="Chegar às ${hhmm(d)}">Chegar: ${label}<small>${hhmm(d)}</small></button>`).join('');
  $('#styles').innerHTML = PHOTO_STYLES.map((s) =>
    `<button type="button" class="chip" data-style="${s.id}" aria-pressed="${state.styles.has(s.id)}">${s.emoji} ${s.label}</button>`).join('');
}

$('#trip-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  state.depart.mode = b.dataset.mode;
  renderTrip();
});
$('#trip-time').addEventListener('change', (e) => { if (e.target.value) { state.depart.time = e.target.value; renderTrip(); } });
$('#trip-quick').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.now) { state.depart = { mode: 'leave', time: nowHHMM() }; if (state.date !== todayStr()) { state.date = todayStr(); updateLight(); } }
  else state.depart = { mode: 'arrive', time: b.dataset.arrive };
  renderTrip();
});
$('#styles').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-style]');
  if (!b) return;
  const id = b.dataset.style;
  state.styles.has(id) ? state.styles.delete(id) : state.styles.add(id);
  saveStyles();
  renderTrip();
  onStateChanged();
});
$('#facts-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#facts').textContent); toast('Dados copiados.', 'info', 2500); }
  catch { toast('Não consegui copiar; selecione o texto manualmente.', 'info'); }
});

// ==== FATOS DETERMINÍSTICOS DA ROTA ====
// Tudo o que as regras (e, no futuro, um LLM) usam sai daqui. Nada é inventado: só cálculo sobre dados já obtidos.
function sunAt(date, lat, lng) {
  const p = SunCalc.getPosition(date, lat, lng);
  return { alt: deg(p.altitude), az: (deg(p.azimuth) + 180) % 360 };
}
function lightPhase(alt) {
  if (alt < -6) return 'noite';
  if (alt < -4) return 'blue hour';
  if (alt < 6) return 'golden hour';
  if (alt < 20) return 'sol baixo';
  if (alt < 45) return 'sol alto';
  return 'sol a pino';
}
const cardinal = (b) => `${compass(b)} (${Math.round(b)}°)`;

// Relação entre a direção da caminhada e o sol.
function lightRelation(walkBearing, sun) {
  if (sun.alt < -2) return { luz: 'sem sol direto', lado: null, diff: null };
  const diff = angleDiff(walkBearing, sun.az); // >0: sol à direita
  const abs = Math.abs(diff);
  if (abs <= 45) return { luz: 'contraluz (andando em direção ao sol)', lado: null, diff };
  if (abs >= 135) return { luz: 'sol nas costas (luz frontal no que está à frente)', lado: null, diff };
  // Sol à direita ilumina as fachadas do lado esquerdo (que olham para a direita), e vice-versa.
  return { luz: `luz lateral (sol à ${diff > 0 ? 'direita' : 'esquerda'})`, lado: diff > 0 ? 'esquerdo' : 'direito', diff };
}

// Recorta a geometria da rota em pedaços de ~80 m e junta os consecutivos com a mesma direção (±25°).
// Manobras do Valhalla não servem direto: calçadas do OSM não têm nome e uma manobra pode cobrir quase 1 km com curvas.
function routeStretches(t, coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + turf.distance(coords[i - 1], coords[i], { units: 'meters' }));
  // Nome da manobra em cada vértice; sem nome = calçada/travessia.
  const nameAt = [], manStart = [];
  for (const m of t.maneuvers) {
    for (let i = m.begin_shape_index; i <= (m.end_shape_index ?? m.begin_shape_index); i++) {
      nameAt[i] = m.street_names?.[0] || null;
      manStart[i] = cum[m.begin_shape_index];
    }
  }
  const pieces = [];
  let a = 0;
  for (let i = 1; i < coords.length; i++) {
    if (cum[i] - cum[a] < 80 && i < coords.length - 1) continue;
    if (cum[i] - cum[a] >= 15) pieces.push({ a, b: i, bearing: (turf.bearing(coords[a], coords[i]) + 360) % 360 });
    a = i;
  }
  const out = [];
  for (const p of pieces) {
    const last = out.at(-1);
    if (last && Math.abs(angleDiff(last.bearing, p.bearing)) <= 25 && nameAt[p.a] === last.rawName) { last.b = p.b; continue; }
    out.push({ ...p, rawName: nameAt[p.a] });
  }
  return out.filter((s) => cum[s.b] - cum[s.a] >= 40).map((s) => {
    const startM = cum[s.a], endM = cum[s.b];
    const midM = (startM + endM) / 2;
    const midCoord = turf.along(t.line, midM / 1000, { units: 'kilometers' }).geometry.coordinates;
    // Nome pelo reverse geocoding (enrichStreetNames), senão o da manobra.
    const key = midCoord.map((v) => v.toFixed(4)).join(',');
    const name = t.streetNames?.[key] || (!s.rawName ? 'calçada / travessia sem nome'
      : startM - (manStart[s.a] ?? startM) > 150 ? `após ${s.rawName}` : s.rawName);
    return { name, rawName: s.rawName, key, startM, endM, midM, midCoord, bearing: (turf.bearing(coords[s.a], coords[s.b]) + 360) % 360 };
  });
}

// Calçadas do OSM não têm nome: pergunta ao Photon a rua mais próxima do meio de cada trecho.
// Se o nome da manobra estiver entre os candidatos, ele vence (evita pegar a rua transversal num cruzamento).
async function enrichStreetNames(t) {
  const stretches = routeStretches(t, t.line.geometry.coordinates).slice(0, 12);
  t.streetNames = t.streetNames || {};
  await Promise.all(stretches.map(async (s) => {
    const [lng, lat] = s.midCoord;
    const url = CONFIG.photon.replace(/api\/?$/, 'reverse') + '?' + new URLSearchParams({ lat: lat.toFixed(5), lon: lng.toFixed(5), limit: 5, osm_tag: 'highway' });
    try {
      const data = await cached(url, () => limits.photon(() => fetchJSON('Photon', url)));
      const names = data.features.map((f) => f.properties.name).filter(Boolean);
      const pick = names.find((n) => s.rawName && norm(n) === norm(s.rawName)) || names[0];
      if (pick) t.streetNames[s.key] = pick;
    } catch { /* sem nome melhor: fica o da manobra */ }
  }));
  if (state.trip === t) renderTrip();
}

function buildFacts() {
  const t = state.trip, times = tripTimes();
  if (!t || !times) return null;
  const { leave, arrive } = times;
  const { lat, lng } = t.target;
  const coords = t.line.geometry.coordinates;
  const at = (d) => {
    const s = sunAt(d, lat, lng);
    return { hora: hhmm(d), fase: lightPhase(s.alt), altitude_sol: Math.round(s.alt), azimute_sol: cardinal(s.az) };
  };

  // Trechos com o sol no meio de cada um (ver routeStretches).
  const stretches = routeStretches(t, coords);
  // Lugares sem nome nunca viram "o café": descrevemos pela rua nomeada mais próxima naquele ponto da rota.
  const named = stretches.filter((s) => !s.name.startsWith('calçada')).map((s) => ({ ...s, name: s.name.replace(/^após /, '') }));
  const streetAt = (m) => (named.filter((s) => s.startM <= m).at(-1) || named[0])?.name || null;
  const masc = (r) => /^(largo|viaduto|parque|beco|túnel|elevado|pátio|calçadão|boulevard|passeio|jardim)\b/i.test(r);
  const atStreet = (m, prep = 'na altura') => { const r = streetAt(m); return r ? `, ${prep === 'na' ? (masc(r) ? 'no' : 'na') : `na altura ${masc(r) ? 'do' : 'da'}`} ${r}` : ''; };
  const routeM = t.length * 1000;
  const trechos = stretches.map((s) => {
    const mid = new Date(leave.getTime() + (s.midM / (t.length * 1000)) * t.time * 1000);
    const sun = sunAt(mid, s.midCoord[1], s.midCoord[0]);
    const rel = lightRelation(s.bearing, sun);
    return {
      rua: s.name, inicio: hhmm(new Date(leave.getTime() + (s.startM / (t.length * 1000)) * t.time * 1000)),
      distancia_m: Math.round(s.endM - s.startM), rumo: cardinal(s.bearing),
      luz: rel.luz, fachadas_iluminadas: rel.lado && sun.alt < 30 ? `lado ${rel.lado}` : null,
      // Rua alinhada com o sol baixo: a luz atravessa a rua inteira ("corredor de luz").
      corredor_de_luz: sun.alt > -1 && sun.alt < 15 && rel.diff != null && (Math.abs(rel.diff) <= 15 || Math.abs(rel.diff) >= 165),
      altitude_sol: Math.round(sun.alt),
    };
  });

  // Pontos de interesse a até 60 m da rota, com o horário aproximado em que você passa por eles.
  // Ignora o destino e o que está colado na origem/destino (o OSM às vezes tem o mesmo lugar duplicado).
  const ends = [[state.point.lng, state.point.lat], [lng, lat]];
  const pontos = state.pois
    .filter((p) => !(t.dest && p.id === t.dest.id) && ends.every((e) => turf.distance(e, [p.lng, p.lat], { units: 'meters' }) > 40))
    .map((p) => {
      const pt = turf.point([p.lng, p.lat]);
      const dist = turf.pointToLineDistance(pt, t.line, { units: 'meters' });
      if (dist > 60) return null;
      const near = turf.nearestPointOnLine(t.line, pt, { units: 'kilometers' }).properties;
      const along = near.location ?? near.lineDistance ?? 0;
      return { nome: p.name || `${CAT[p.cat].one} sem nome no mapa${atStreet(along * 1000)}`, categoria: CAT[p.cat].one, cat: p.cat, distancia_da_rota_m: Math.round(dist),
        hora_aprox: hhmm(new Date(leave.getTime() + (along / t.length) * t.time * 1000)), along, lng: p.lng, lat: p.lat };
    })
    .filter(Boolean).sort((a, b) => a.along - b.along).slice(0, 15);

  // Eventos de luz durante a caminhada e o próximo depois da chegada (até 2 h).
  const s = sunTimes(state.date, lat, lng);
  const events = [['início da blue hour da manhã', s.dawn], ['início da golden hour da manhã', s.blueHourEnd], ['nascer do sol', s.sunrise],
    ['fim da golden hour da manhã', s.goldenHourEnd], ['início da golden hour', s.goldenHour], ['pôr do sol', s.sunset],
    ['início da blue hour', s.blueHourStart], ['fim da blue hour', s.dusk]].filter(([, d]) => valid(d)).sort((a, b) => a[1] - b[1]);
  // Eventos a até 2 min da chegada contam como "na chegada" (o horário exibido é truncado no minuto).
  const arriveEdge = arrive.getTime() + 2 * 60e3;
  const durante = events.filter(([, d]) => d >= leave && d <= arriveEdge).map(([evento, d]) => ({ evento, hora: hhmm(d) }));
  const next = events.find(([, d]) => d > arriveEdge && d - arrive <= 2 * 3600e3);

  const el = t.elev;
  let elevacao = null;
  if (el?.pts.length > 1) {
    const top = el.pts.reduce((a, b) => (b[1] > a[1] ? b : a));
    elevacao = { subida_m: el.gain, descida_m: el.loss, min_m: Math.round(Math.min(...el.pts.map((p) => p[1]))), max_m: Math.round(top[1]),
      ponto_mais_alto: { a_partir_do_inicio_m: Math.round(top[0]), hora_aprox: hhmm(new Date(leave.getTime() + (top[0] / (t.length * 1000)) * t.time * 1000)) } };
  }

  // Nuvens: média da hora da caminhada até 1 h depois da chegada.
  const c = cloudsBetween(leave, new Date(arrive.getTime() + 3600e3));

  const facts = {
    data: state.date, fuso: tzName(),
    origem: { nome: state.point.label?.split(' · ')[0] || `ponto de partida escolhido no mapa${atStreet(0, 'na')}`, lat: state.point.lat, lng: state.point.lng },
    destino: { nome: t.dest?.name || `${t.dest ? `${CAT[t.dest.cat].one} sem nome no mapa` : 'destino escolhido no mapa'}${atStreet(routeM, 'na')}`,
      categoria: t.dest ? CAT[t.dest.cat].one : null, lat: round(lat), lng: round(lng) },
    caminhada: { saida: hhmm(leave), chegada: hhmm(arrive), duracao_min: Math.round(t.time / 60), distancia_km: +t.length.toFixed(2),
      ritmo: paceOf(state.speed).label, velocidade_kmh: state.speed, evitar_ladeiras: state.hills > 0.5 },
    elevacao,
    luz: { na_saida: at(leave), na_chegada: at(arrive), eventos_durante: durante,
      horarios_do_dia: Object.fromEntries([['golden_manha', s.blueHourEnd], ['nascer', s.sunrise], ['golden_tarde', s.goldenHour],
        ['por_do_sol', s.sunset], ['blue_hour', s.blueHourStart]].map(([k, d]) => [k, valid(d) ? hhmm(d) : null])),
      proximo_evento: next ? { evento: next[0], hora: hhmm(next[1]), minutos_apos_chegada: Math.round((next[1] - arrive) / 60e3) } : null },
    nuvens: c ? { total_pct: c.total, baixas_pct: c.low, altas_pct: c.high } : null,
    trechos,
    pontos_no_caminho: pontos.map(({ along, lng: _x, lat: _y, cat, ...rest }) => rest),
    estilos_preferidos: PHOTO_STYLES.filter((x) => state.styles.has(x.id)).map((x) => x.label),
    _pontos: pontos, // uso interno das regras (coordenadas, categoria); não vai no JSON exibido
    _styles: [...state.styles],
    _destCat: t.dest?.cat || null,
  };
  facts.configuracoes_camera = cameraSettingsFor(facts);
  return facts;
}

// ==== CONFIGURAÇÕES DE CÂMERA (DETERMINÍSTICAS) ====
// Pontos de partida por situação (câmera ou celular no modo "pro"), sempre com o motivo da escolha.
// O app monta o texto final no formato padrão; a IA nunca escreve esses números.
const CAMERA = {
  'golden hour': { iso: '100–400', ap: 'f/5.6–8', ss: '1/250 s', why: 'A luz é baixa e quente, mas ainda forte: ISO baixo evita ruído, f/5.6–8 deixa a cena nítida de ponta a ponta e 1/250 s congela quem passa. Use balanço de branco "luz do dia" para não neutralizar o dourado.' },
  'blue hour': { iso: '1600–3200', ap: 'f/2.8', ss: '1/60 s', why: 'Pouca luz: diafragma aberto e ISO alto permitem fotografar na mão sem tremer. Com apoio firme, troque por ISO 100, f/8 e 2–10 s para céu limpo e luzes em estrela.' },
  noite: { iso: '3200–6400', ap: 'f/1.8–2.8', ss: '1/60 s', ev: '−0,3', why: '1/60 s é o limite para não borrar na mão, então a luz vem do ISO alto e do diafragma aberto; expor um pouco para baixo segura letreiros e postes acesos.' },
  'sol alto': { iso: '100', ap: 'f/8–11', ss: '1/500 s', ev: '−0,3', why: 'Luz farta: ISO mínimo e f/8–11 dão a maior nitidez; −0,3 EV protege as altas luzes, que estouram fácil com sol forte.' },
  'sol baixo': { iso: '100–200', ap: 'f/8', ss: '1/250–1/500 s', why: 'Ainda há bastante luz e ela vem de lado: ISO baixo e f/8 mantêm detalhe, e a velocidade alta congela o movimento sem perder as sombras longas.' },
  encoberto: { iso: '400–800', ap: 'f/5.6', ss: '1/250 s', ev: '+0,3', why: 'Céu fechado rouba luz: ISO médio mantém 1/250 s sem tremer; +0,3 EV compensa o fotômetro, que tende a deixar o céu claro cinzento.' },
  contraluz: { iso: '100–200', ap: 'f/8', ss: '1/500 s', ev: '−0,7 a −1', why: 'Contra o sol, medir nas altas luzes e subexpor preserva a cor do céu e transforma quem passa em silhueta; f/8 e 1/500 s seguram a luz forte.' },
  'contraluz retrato': { iso: '100–200', ap: 'f/2–2.8', ss: '1/500 s', ev: '+0,3', why: 'Com o sol atrás da pessoa, o diafragma aberto desfoca o fundo e +0,3 EV clareia o rosto, que fica na sombra; o sol vira um contorno de luz no cabelo.' },
  street: { iso: '200–800', ap: 'f/8', ss: '1/250–1/500 s', why: 'Pelo menos 1/250 s congela pedestres; f/8 com foco fixo em ~3 m (foco por zona) deixa tudo nítido sem esperar o autofoco.' },
  arquitetura: { iso: '100', ap: 'f/8–11', ss: '1/125 s', why: 'f/8–11 é a faixa mais nítida da maioria das lentes e mantém a fachada inteira em foco; nivele a câmera para as linhas verticais não "caírem".' },
  sombras: { iso: '100', ap: 'f/8', ss: '1/500 s', ev: '−0,7 a −1', why: 'Subexpor deixa as sombras pretas e realça formas e linhas; f/8 mantém as bordas nítidas.' },
  agua: { iso: '100', ap: 'f/11', ss: '1/2–2 s', why: 'Exposição longa deixa a água sedosa; ISO 100 e f/11 reduzem a luz para caber segundos de exposição (precisa de apoio). Na mão, 1/1000 s congela as gotas.' },
  'retrato sombra': { iso: '200–400', ap: 'f/2–2.8', ss: '1/250 s', why: 'A sombra aberta dá luz suave no rosto, sem olhos apertados; o diafragma aberto separa a pessoa do fundo.' },
};
// Formato padrão exibido e enviado: "(ISO: 100–400, Aperture: f/5.6–8, Shutter Speed: 1/250 s, EV: −0,3)".
const camText = (c) => `(ISO: ${c.iso}, Aperture: ${c.ap}, Shutter Speed: ${c.ss}${c.ev ? `, EV: ${c.ev}` : ''})`;
// Mesma cena com pouca luz (blue hour / noite): as versões de dia acima sairiam escuras demais.
const CAMERA_LOW = {
  street: { iso: '3200–6400', ap: 'f/2.8', ss: '1/125 s', why: 'Com pouca luz, 1/125 s ainda congela quem anda devagar; o ISO alto e o diafragma aberto compensam a falta de luz. Com f/2.8 o foco por zona fica curto: foque em quem vem na sua direção.' },
  arquitetura: { iso: '1600–3200', ap: 'f/4–5.6', ss: '1/30–1/60 s', why: 'Fachadas acesas têm bem menos luz que de dia: f/4–5.6 ainda mantém boa parte do prédio em foco e 1/30–1/60 s pede mão firme. Com apoio, ISO 100, f/8 e 2–8 s deixam a fachada limpa e nítida.' },
  agua: { iso: '100', ap: 'f/8', ss: '2–10 s', why: 'À noite a água vira espelho das luzes: com apoio, a exposição longa alisa a superfície e deixa os reflexos contínuos.' },
  'retrato sombra': { iso: '1600–3200', ap: 'f/1.8–2.8', ss: '1/125 s', why: 'Pouca luz: diafragma bem aberto e ISO alto; 1/125 s evita borrar pequenos movimentos. Procure uma vitrine ou poste iluminando o rosto.' },
};
// Dentro de um lugar (café, igreja…): luz artificial e bem mais fraca que a da rua.
CAMERA.interior = { iso: '1600–3200', ap: 'f/2–2.8', ss: '1/60–1/125 s', why: 'Ambientes internos têm muito menos luz que a rua, mesmo de dia: diafragma aberto e ISO alto mantêm uma velocidade segura para fotografar na mão. Ajuste o balanço de branco para a luz do lugar (quente, de lâmpada).' };

const isLowLight = (phase) => phase === 'blue hour' || phase === 'noite';
// Configuração para uma fase de luz, considerando céu encoberto (sem sol direto).
function cameraForPhase(phase, blocked) {
  if (blocked && phase !== 'blue hour' && phase !== 'noite') return CAMERA.encoberto;
  return CAMERA[phase === 'sol a pino' ? 'sol alto' : phase] || CAMERA['sol alto'];
}
// Configuração para um tipo de cena naquela luz: com pouca luz usa a variante noturna; sem cena, a da fase.
function cameraForScene(scene, phase, blocked) {
  if (!scene) return cameraForPhase(phase, blocked);
  if (isLowLight(phase)) return CAMERA_LOW[scene] || cameraForPhase(phase, blocked);
  return CAMERA[scene] || cameraForPhase(phase, blocked);
}
function cameraSettingsFor(f) {
  const out = [];
  const add = (situacao, quando, c) => out.push({ situacao, quando, config: camText(c), motivo: c.why });
  const blocked = f.nuvens?.total_pct >= 85;
  const styles = new Set(f._styles);
  const phases = [['saída', f.luz.na_saida], ['chegada', f.luz.na_chegada]];
  for (const [label, l] of phases) {
    if (label === 'saída' && l.fase === f.luz.na_chegada.fase) continue;
    add(blocked && !['blue hour', 'noite'].includes(l.fase) ? `${l.fase}, céu encoberto` : l.fase, `${label} (${l.hora})`, cameraForPhase(l.fase, blocked));
  }
  if (!blocked && f.trechos.some((t) => t.luz.startsWith('contraluz') && t.altitude_sol > -1 && t.altitude_sol < 25))
    add('contraluz / silhuetas', 'trechos em direção ao sol', styles.has('retrato') ? CAMERA['contraluz retrato'] : CAMERA.contraluz);
  const fase = f.luz.na_chegada.fase; // cenas por estilo seguem a luz da chegada
  if (styles.has('street')) add('street', 'cenas em movimento', cameraForScene('street', fase, blocked));
  if (styles.has('arquitetura') || styles.has('paisagem')) add('arquitetura / paisagem', 'fachadas e vistas', cameraForScene('arquitetura', fase, blocked));
  if (styles.has('minimal') && !isLowLight(fase)) add('sombras gráficas', 'sol baixo ou duro', CAMERA.sombras);
  if (f._pontos.some((p) => p.cat === 'fountain')) add('água / reflexos', 'fontes no caminho', cameraForScene('agua', fase, blocked));
  return out.slice(0, 6);
}

// ==== RENDER ====
function renderTrip() {
  const t = state.trip;
  $('#trip').hidden = !t;
  if (!t) return;
  if (!state.depart.time) state.depart.time = state.date === todayStr() ? nowHHMM() : '17:00';
  renderTripControls();
  const f = buildFacts();
  if (!f) return;
  const L = f.luz;
  const next = L.proximo_evento ? ` · ${L.proximo_evento.evento} ${L.proximo_evento.minutos_apos_chegada} min depois (${L.proximo_evento.hora})` : '';
  $('#trip-result').innerHTML = `Saindo <b>${f.caminhada.saida}</b> → chegando <b>${f.caminhada.chegada}</b>` +
    ` (${f.caminhada.duracao_min} min)<br>Na chegada: <b>${L.na_chegada.fase}</b>, sol a ${L.na_chegada.altitude_sol}°${esc(next)}` +
    (f.nuvens ? `<br>Nuvens previstas: ${f.nuvens.total_pct}% (baixas ${f.nuvens.baixas_pct}%, altas ${f.nuvens.altas_pct}%)` : '<br><small>Sem previsão de nuvens para esse horário (só 3 dias).</small>');
  const { _pontos, _styles, _destCat, ...shown } = f;
  $('#facts').textContent = JSON.stringify(shown, null, 2);
  renderTips(f);
  if (!$("#ai-size").children.length) renderAiControls();
  aiOnFacts(f);
  refreshSummaries();
}
