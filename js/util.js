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
};

async function fetchJSON(api, url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    throw new ApiError(api, e.name === 'AbortError' ? `${api}: tempo esgotado` : `${api}: sem conexão ou bloqueado`);
  } finally { clearTimeout(timer); }
  let body = null;
  try { body = await res.json(); } catch { /* corpo não-JSON */ }
  if (!res.ok) {
    let detail = String(body?.error || body?.message || '');
    if (/edges|location/i.test(detail)) detail = 'nenhuma rua caminhável perto desse ponto';
    else if (detail.length > 90) detail = detail.slice(0, 90) + '…';
    const msg = res.status === 429 ? `${api}: muitas requisições, tente em instantes`
      : res.status >= 500 ? `${api}: servidor indisponível (${res.status})`
      : `${api}: erro ${res.status}${detail ? ' – ' + detail : ''}`;
    throw new ApiError(api, msg, res.status);
  }
  if (body == null) throw new ApiError(api, `${api}: resposta inválida`);
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
