'use strict';
// ==== MAPA ====
const initialHash = parseHash();
applyHashToState(initialHash);
document.documentElement.dataset.theme = state.style;
const map = new maplibregl.Map({
  container: 'map',
  style: CONFIG.styles[state.style],
  center: initialHash.point ? [initialHash.point.lng, initialHash.point.lat] : CONFIG.defaultCenter,
  zoom: CONFIG.defaultZoom,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
// ◎ define o ponto de partida onde a pessoa está (não só move o mapa).
const geolocate = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } });
geolocate.on('geolocate', (e) => { if (!mapLocked()) setPoint(e.coords.latitude, e.coords.longitude, 'Minha localização', { fly: false }); });
map.addControl(geolocate, 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
// Se a página carregou numa aba oculta, o canvas pode ficar com o tamanho padrão (300 px) até o próximo resize.
for (const ev of ['resize', 'orientationchange']) window.addEventListener(ev, () => map.resize());
document.addEventListener('visibilitychange', () => { if (!document.hidden) map.resize(); });
map.once('load', () => { map.resize(); $('#map-loading').remove(); });

// ==== CAMADAS (sobrevivem à troca de estilo) ====
// setStyle() apaga sources/layers custom; cada overlay registrado é re-adicionado em todo 'style.load'.
const EMPTY = { type: 'FeatureCollection', features: [] };
const sourceData = {};
const overlays = [];
// Os scripts carregam em sequência e o 'style.load' pode disparar entre eles; isStyleLoaded() ainda pode
// ser false logo depois (fontes carregando), então usamos uma flag própria para não perder overlays.
let styleReady = false;
const addOverlay = (fn) => { try { fn(); } catch (e) { console.error('overlay', e); } };
function registerOverlay(addFn) {
  overlays.push(addFn);
  if (styleReady) addOverlay(addFn);
}
map.on('style.load', () => { styleReady = true; overlays.forEach(addOverlay); });
function ensureSource(id) {
  if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: sourceData[id] || EMPTY });
}
function setSourceData(id, fc) {
  sourceData[id] = fc || EMPTY;
  map.getSource(id)?.setData(sourceData[id]);
}

// ==== BOTÕES DO MAPA (UMA COLUNA) ====
// Tema (aqui), foco (flow.js), glossário e tour (help.js) entram na mesma coluna, na ordem em que são adicionados.
class MapTools {
  onAdd() {
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group map-tools';
    return this.el;
  }
  add(title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'map-btn';
    b.title = title;
    b.addEventListener('click', onClick);
    this.el.appendChild(b);
    return b;
  }
  onRemove() { this.el.remove(); }
}
const mapTools = new MapTools();
map.addControl(mapTools, 'top-left');

// ==== ESTILO CLARO/ESCURO ====
const styleToggle = {
  btn: mapTools.add('Alternar mapa claro/escuro', () => setMapStyle(state.style === 'light' ? 'dark' : 'light')),
  render() { this.btn.textContent = state.style === 'light' ? '🌙 Escuro' : '☀️ Claro'; },
};

function setMapStyle(style, { apply = true } = {}) {
  if (!CONFIG.styles[style]) style = 'light';
  const changed = style !== state.style;
  state.style = style;
  document.documentElement.dataset.theme = style;
  styleToggle.render();
  // diff:false força um 'style.load' completo, que re-adiciona os overlays.
  if (changed && apply) { styleReady = false; map.setStyle(CONFIG.styles[style], { diff: false }); }
  onStateChanged();
}
function onStateChanged() {
  writeHash();
  refreshSummaries();
  $('#panel').classList.toggle('started', !!state.point); // cabeçalho fino depois do ponto escolhido
  $('#share').disabled = !state.point;
}

const pin = new maplibregl.Marker({ color: '#e5484d', draggable: true });
pin.on('dragend', () => { const { lng, lat } = pin.getLngLat(); setPoint(lat, lng, null, { fly: false }); });

// Clique dentro da mancha = rota até lá; fora = novo ponto. Clique direito sempre move o pin.
// Durante um carregamento iniciado pelo usuário o mapa não dispara outra ação (o painel mostra "Cancelar").
// Exceção: na espera dos pontos dá para escolher o destino clicando na mancha (os pontos entram depois).
const mapLocked = () => {
  if (!opBusy() || (ops.size === 1 && ops.has('pois'))) return false;
  toast('Aguarde o carregamento terminar ou clique em "Cancelar" no painel.', 'info', 2500);
  return true;
};
// Com rota aberta, um toque fora da mancha (fácil de acontecer no celular) pergunta antes de trocar o ponto.
let movePopup = null;
function confirmMovePoint(lat, lng) {
  movePopup?.remove();
  const el = document.createElement('div');
  el.className = 'popup';
  el.innerHTML = '<p>Mudar o ponto de partida para cá? A rota atual será descartada.</p><div class="row"><button class="btn btn-sm btn-primary" type="button">Mudar ponto</button></div>';
  el.querySelector('button').addEventListener('click', () => { movePopup.remove(); setPoint(lat, lng, null, { fly: false }); });
  movePopup = new maplibregl.Popup({ offset: 6, maxWidth: '240px' }).setLngLat([lng, lat]).setDOMContent(el).addTo(map);
}
map.on('click', (e) => {
  if (mapLocked()) return;
  const { lat, lng } = e.lngLat;
  const poi = map.getLayer('poi') && map.queryRenderedFeatures(e.point, { layers: ['poi'] })[0];
  if (poi) openPoi(poi.properties.id);
  else if (insideIsochrone(lng, lat)) showRoute(lat, lng, null, { show: true });
  else if (state.routeTarget) confirmMovePoint(lat, lng);
  else setPoint(lat, lng, null, { fly: false });
});
map.on('contextmenu', (e) => { if (!mapLocked()) setPoint(e.lngLat.lat, e.lngLat.lng, null, { fly: false }); });

// ==== PONTO DE PARTIDA ====
function setPoint(lat, lng, label = null, { fly = true, show = true } = {}) {
  state.point = { lat: round(lat), lng: round(lng), label };
  pin.setLngLat([state.point.lng, state.point.lat]).addTo(map);
  if (fly) map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 14), offset: sheetOffset() });
  setStatus('search-status', label ? `📍 ${label}` : `📍 ${state.point.lat.toFixed(5)}, ${state.point.lng.toFixed(5)}`);
  flowNewPoint();
  onPointChanged();
  if (show) reveal('#sec-iso'); // mostra a Caminhada sendo calculada
}
function onPointChanged() {
  clearRoute();
  clearPois();
  state.iso = null; // a mancha do ponto anterior não vale mais (evita abrir a etapa de pontos com dados velhos)
  poiPopup?.remove();
  movePopup?.remove();
  computeIsochrones();
  updateLight();
  loadClouds();
  onStateChanged();
}

// No celular o bottom sheet cobre a parte de baixo do mapa.
const isMobile = () => matchMedia('(max-width: 760px)').matches;
const mapPadding = () => (isMobile() ? { top: 50, left: 30, right: 50, bottom: $('#panel').offsetHeight + 20 } : 40);
// Desloca o centro para a parte do mapa que o painel não cobre.
const sheetOffset = () => (isMobile() ? [0, -$('#panel').offsetHeight / 2] : [0, 0]);
// Celular: quando a mancha, a rota ou o foco aparecem, o painel desce para o mapa ficar em destaque.
// Volta ao tamanho normal com um toque no painel (main.js). Resolve depois da transição de altura.
function sheetPeek() {
  const p = $('#panel');
  if (!isMobile() || p.classList.contains('collapsed') || p.classList.contains('peek')) return Promise.resolve();
  p.classList.remove('expanded');
  p.classList.add('peek');
  return new Promise((r) => setTimeout(r, 230));
}
const firstSymbolLayer = () => map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
