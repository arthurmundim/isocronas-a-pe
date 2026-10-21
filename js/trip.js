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
  const trechos = routeStretches(t, coords).map((s) => {
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
      return { nome: p.name || CAT[p.cat].one, categoria: CAT[p.cat].one, cat: p.cat, distancia_da_rota_m: Math.round(dist),
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
    origem: { nome: state.point.label?.split(' · ')[0] || null, lat: state.point.lat, lng: state.point.lng },
    destino: { nome: t.dest ? t.dest.name || CAT[t.dest.cat].one : null, categoria: t.dest ? CAT[t.dest.cat].one : null, lat: round(lat), lng: round(lng) },
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
  };
  facts.configuracoes_camera = cameraSettingsFor(facts);
  return facts;
}

// ==== CONFIGURAÇÕES DE CÂMERA (DETERMINÍSTICAS) ====
// Pontos de partida por situação, para regras e IA citarem sem inventar números (câmera ou celular no modo "pro").
const CAMERA = {
  'golden hour': 'ISO 100–400, f/5.6–8, 1/250 s, balanço de branco "luz do dia" para manter o tom quente',
  'blue hour': 'na mão ISO 1600–3200, f/2.8, 1/60 s; com apoio ISO 100, f/8, 2–10 s',
  'noite': 'ISO 3200–6400, f/1.8–2.8, 1/60 s, exposição pelas luzes',
  'sol alto': 'ISO 100, f/8–11, 1/500 s, −0,3 EV para não estourar as altas luzes',
  'sol baixo': 'ISO 100–200, f/8, 1/250–1/500 s',
  'encoberto': 'ISO 400–800, f/5.6, 1/250 s, +0,3 EV',
  'contraluz': 'medição nas altas luzes, −0,7 a −1 EV, f/8, 1/500 s',
  'contraluz retrato': 'f/2–2.8, +0,3 EV para o rosto, com o sol atrás da pessoa',
  'street': '1/250–1/500 s para congelar, f/8 com foco por zona (~3 m)',
  'arquitetura': 'f/8–11, ISO baixo, câmera nivelada para não entortar as verticais',
  'sombras': '−0,7 a −1 EV para sombras pretas, f/8',
  'agua': 'com apoio ISO 100, f/11, 1/2–2 s (água sedosa); na mão 1/1000 s para congelar gotas',
  'retrato sombra': 'f/2–2.8, ISO 200–400, 1/250 s, na sombra aberta',
};
// Configuração para uma fase de luz, considerando céu encoberto (sem sol direto).
function cameraForPhase(phase, blocked) {
  if (blocked && phase !== 'blue hour' && phase !== 'noite') return CAMERA.encoberto;
  return CAMERA[phase === 'sol a pino' ? 'sol alto' : phase] || CAMERA['sol alto'];
}
function cameraSettingsFor(f) {
  const out = [];
  const add = (situacao, quando, config) => out.push({ situacao, quando, config });
  const blocked = f.nuvens?.total_pct >= 85;
  const styles = new Set(f._styles);
  const phases = [['saída', f.luz.na_saida], ['chegada', f.luz.na_chegada]];
  for (const [label, l] of phases) {
    if (label === 'saída' && l.fase === f.luz.na_chegada.fase) continue;
    add(blocked && !['blue hour', 'noite'].includes(l.fase) ? `${l.fase}, céu encoberto` : l.fase, `${label} (${l.hora})`, cameraForPhase(l.fase, blocked));
  }
  if (!blocked && f.trechos.some((t) => t.luz.startsWith('contraluz') && t.altitude_sol > -1 && t.altitude_sol < 25))
    add('contraluz / silhuetas', 'trechos em direção ao sol', CAMERA.contraluz + (styles.has('retrato') ? `; retrato: ${CAMERA['contraluz retrato']}` : ''));
  if (styles.has('street')) add('street', 'cenas em movimento', CAMERA.street);
  if (styles.has('arquitetura') || styles.has('paisagem')) add('arquitetura / paisagem', 'fachadas e vistas', CAMERA.arquitetura);
  if (styles.has('minimal')) add('sombras gráficas', 'sol baixo ou duro', CAMERA.sombras);
  if (f._pontos.some((p) => p.cat === 'fountain')) add('água / reflexos', 'fontes no caminho', CAMERA.agua);
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
  const { _pontos, _styles, ...shown } = f;
  $('#facts').textContent = JSON.stringify(shown, null, 2);
  renderTips(f);
  if (!$("#ai-size").children.length) renderAiControls();
  aiOnFacts(f);
}
