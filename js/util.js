'use strict';
// ==== UTILITÁRIOS ====
const $ = (sel) => document.querySelector(sel);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = (x, d = 5) => Math.round(x * 10 ** d) / 10 ** d;

function toast(msg, type = 'error', ms = 6000) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
// kind: 'loading' (spinner), 'error' (ou true) ou nada.
function setStatus(id, msg, kind = null) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('error', kind === true || kind === 'error');
  el.classList.toggle('loading', kind === 'loading' && !!msg);
}

// ==== REDE: CACHE + RATE LIMIT ====
class ApiError extends Error {
  constructor(api, msg, status) { super(msg); this.api = api; this.status = status; }
}
// Nome do serviço nas mensagens: o que ele faz para a pessoa, não o nome do servidor.
const API_LABEL = { Valhalla: 'Cálculo de caminhos', Overpass: 'Pontos do mapa', Photon: 'Busca de endereços',
  Nominatim: 'Busca de endereços', BrasilAPI: 'Busca de CEP', 'Open-Meteo': 'Previsão do tempo' };

// Cache em memória por chave (URL + body). Guarda a Promise, então chamadas idênticas simultâneas compartilham a mesma requisição.
// Conta também a espera nas filas e os retries, para a barra global refletir tudo que está pendente.
const cache = new Map();
let inFlight = 0;
function cached(key, fn) {
  if (cache.has(key)) return cache.get(key);
  $('#busy').classList.toggle('on', ++inFlight > 0);
  const p = fn()
    .catch((e) => { cache.delete(key); throw e; })
    .finally(() => $('#busy').classList.toggle('on', --inFlight > 0));
  cache.set(key, p);
  return p;
}

// Fila serial com intervalo mínimo entre requisições (APIs compartilhadas: Nominatim, Overpass, Valhalla).
function limiter(minIntervalMs) {
  let chain = Promise.resolve(), last = 0;
  return (fn) => {
    const run = chain.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { return await fn(); } finally { last = Date.now(); }
    });
    chain = run.catch(() => {});
    return run;
  };
}
const limits = {
  nominatim: limiter(1100),
  valhalla: limiter(400),
  overpass: limiter(1000),
  photon: limiter(250),
};

// ==== OPERAÇÕES CANCELÁVEIS ====
// Carregamentos iniciados pelo usuário (busca, mancha, pontos, rota, IA) travam os botões do painel e mostram
// "Cancelar" ao lado do status do passo. Cancelar aborta as requisições daquelas APIs e restaura o passo anterior.
const fetchCtrls = new Map(); // api → Set<AbortController> em andamento
function abortApis(apis) {
  for (const a of apis) for (const c of fetchCtrls.get(a) || []) c.abort('cancel');
}
const ops = new Map(); // nome → { onCancel, btn }
const opBusy = () => ops.size > 0;
function opStart(name, anchor, onCancel) {
  opEnd(name);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn op-cancel';
  btn.textContent = 'Cancelar';
  btn.addEventListener('click', () => opCancel(name));
  (typeof anchor === 'string' ? $(anchor) : anchor)?.after(btn);
  ops.set(name, { onCancel, btn });
  lockPanel();
}
function opEnd(name) {
  const op = ops.get(name);
  if (!op) return;
  op.btn.remove();
  ops.delete(name);
  lockPanel();
}
function opCancel(name) {
  const op = ops.get(name);
  if (!op) return;
  opEnd(name);
  op.onCancel();
}
// Trava: atributo disabled nos controles que existem agora (teclado) + CSS para os que forem desenhados durante a trava.
function lockPanel() {
  const on = ops.size > 0;
  $('#panel').classList.toggle('busy-lock', on);
  for (const el of $('#panel').querySelectorAll('button, input, select')) {
    if (el.classList.contains('op-cancel') || el.id === 'sheet-handle') continue;
    if (on && !el.disabled) { el.disabled = true; el.dataset.lock = '1'; }
    else if (!on && el.dataset.lock) { el.disabled = false; delete el.dataset.lock; }
  }
  if (typeof pin !== 'undefined') pin.setDraggable(!on);
}

async function fetchJSON(api, url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
  if (!fetchCtrls.has(api)) fetchCtrls.set(api, new Set());
  fetchCtrls.get(api).add(ctrl);
  const label = API_LABEL[api] || api;
  let res;
  try {
    res = await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.reason === 'cancel') throw Object.assign(new ApiError(api, `${label}: cancelado`), { cancelled: true });
    throw new ApiError(api, e.name === 'AbortError' ? `${label}: demorou demais para responder` : `${label}: sem conexão com a internet ou serviço fora do ar`);
  } finally { clearTimeout(timer); fetchCtrls.get(api).delete(ctrl); }
  let body = null;
  try { body = await res.json(); } catch { /* corpo não-JSON */ }
  if (!res.ok) {
    let detail = String(body?.error || body?.message || '');
    if (/edges|location/i.test(detail)) detail = 'nenhuma rua caminhável perto desse ponto';
    else if (detail.length > 90) detail = detail.slice(0, 90) + '…';
    const msg = res.status === 429 ? `${label}: muitos pedidos agora, tente em instantes`
      : res.status >= 500 ? `${label}: serviço fora do ar no momento`
      : `${label}: não funcionou${detail ? ' – ' + detail : ''}`;
    throw new ApiError(api, msg, res.status);
  }
  if (body == null) throw new ApiError(api, `${label}: resposta inesperada`);
  return body;
}

// ==== FORMATOS E PARSERS COMPARTILHADOS ====
function parseTimes(text) {
  const vals = [...new Set(String(text).split(/[^\d]+/).map(Number).filter((n) => n >= 1 && n <= 60))].sort((a, b) => a - b);
  return vals.slice(0, 4);
}
// Ritmo de caminhada: perfis em vez de km/h soltos.
function paceOf(v) { return CONFIG.paces.reduce((a, b) => (Math.abs(b.v - v) < Math.abs(a.v - v) ? b : a)); }
const tzName = () => state.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
const valid = (d) => d instanceof Date && !isNaN(d);
const fmtTime = (d) => (valid(d) ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: tzName() }).format(d) : '—');
const fmtRange = (a, b) => `${fmtTime(a)}–${fmtTime(b)}`;
function todayStr() { return new Date().toLocaleDateString('sv-SE'); } // YYYY-MM-DD no fuso do navegador

// Converte data 'YYYY-MM-DD' + hora 'HH:MM' no fuso IANA dado para um Date (instante absoluto).
function tzOffsetMs(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}
function zonedDate(dateStr, hhmm, tz) {
  const [y, m, d] = dateStr.split('-').map(Number), [H, M] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, H, M);
  const first = guess - tzOffsetMs(new Date(guess), tz);
  return new Date(guess - tzOffsetMs(new Date(first), tz)); // 2ª passada acerta transições de horário de verão
}
const deg = (rad) => (rad * 180) / Math.PI;
// Diferença angular assinada b - a, em [-180, 180).
const angleDiff = (a, b) => ((b - a + 540) % 360) - 180;

// Estilos de foto ficam salvos no navegador (preferência pessoal) e também vão no link.
const STYLES_KEY = 'isocronas.styles';
function loadStoredStyles() {
  try { return new Set(JSON.parse(localStorage.getItem(STYLES_KEY) || '[]').filter((id) => PHOTO_STYLES.some((s) => s.id === id))); }
  catch { return new Set(); }
}
function saveStyles() {
  try { localStorage.setItem(STYLES_KEY, JSON.stringify([...state.styles])); } catch { /* armazenamento indisponível */ }
}

// Rola o painel até a parte que está em execução ou que pede input (respeita "reduzir movimento").
function reveal(target, block = 'start') {
  const el = typeof target === 'string' ? $(target) : target;
  if (!el || el.closest('[hidden]')) return;
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block });
}
