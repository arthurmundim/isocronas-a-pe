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
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

// ==== CAMADAS (sobrevivem à troca de estilo) ====
// setStyle() apaga sources/layers custom; cada overlay registrado é re-adicionado em todo 'style.load'.
const EMPTY = { type: 'FeatureCollection', features: [] };
const sourceData = {};
const overlays = [];
function registerOverlay(addFn) {
  overlays.push(addFn);
  if (map.isStyleLoaded()) addFn();
}
map.on('style.load', () => overlays.forEach((fn) => fn()));
function ensureSource(id) {
  if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: sourceData[id] || EMPTY });
}
function setSourceData(id, fc) {
  sourceData[id] = fc || EMPTY;
  map.getSource(id)?.setData(sourceData[id]);
}

// ==== ESTILO CLARO/ESCURO ====
class StyleToggle {
  onAdd() {
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.el.innerHTML = '<button class="map-btn" type="button" title="Alternar mapa claro/escuro"></button>';
    this.el.firstChild.addEventListener('click', () => setMapStyle(state.style === 'light' ? 'dark' : 'light'));
    this.render();
    return this.el;
  }
  render() { if (this.el) this.el.firstChild.textContent = state.style === 'light' ? '🌙 Escuro' : '☀️ Claro'; }
  onRemove() { this.el.remove(); }
}
const styleToggle = new StyleToggle();
map.addControl(styleToggle, 'top-left');

function setMapStyle(style, { apply = true } = {}) {
  if (!CONFIG.styles[style]) style = 'light';
  const changed = style !== state.style;
  state.style = style;
  document.documentElement.dataset.theme = style;
  styleToggle.render();
  // diff:false força um 'style.load' completo, que re-adiciona os overlays.
  if (changed && apply) map.setStyle(CONFIG.styles[style], { diff: false });
  onStateChanged();
}
function onStateChanged() { writeHash(); }

const pin = new maplibregl.Marker({ color: '#e5484d', draggable: true });
pin.on('dragend', () => { const { lng, lat } = pin.getLngLat(); setPoint(lat, lng, null, { fly: false }); });

// Clique dentro da mancha = rota até lá; fora = novo ponto. Clique direito sempre move o pin.
map.on('click', (e) => {
  const { lat, lng } = e.lngLat;
  const poi = map.getLayer('poi') && map.queryRenderedFeatures(e.point, { layers: ['poi'] })[0];
  if (poi) openPoi(poi.properties.id);
  else if (insideIsochrone(lng, lat)) showRoute(lat, lng);
  else setPoint(lat, lng, null, { fly: false });
});
map.on('contextmenu', (e) => setPoint(e.lngLat.lat, e.lngLat.lng, null, { fly: false }));

// ==== PONTO DE PARTIDA ====
function setPoint(lat, lng, label = null, { fly = true } = {}) {
  state.point = { lat: round(lat), lng: round(lng), label };
  pin.setLngLat([state.point.lng, state.point.lat]).addTo(map);
  if (fly) map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 14) });
  setStatus('search-status', label ? `📍 ${label}` : `📍 ${state.point.lat.toFixed(5)}, ${state.point.lng.toFixed(5)}`);
  onPointChanged();
}
function onPointChanged() {
  clearRoute();
  clearPois();
  poiPopup?.remove();
  computeIsochrones();
  updateLight();
  loadClouds();
  onStateChanged();
}

// No celular o bottom sheet cobre a parte de baixo do mapa.
const isMobile = () => matchMedia('(max-width: 760px)').matches;
const mapPadding = () => (isMobile() ? { top: 50, left: 30, right: 50, bottom: $('#panel').offsetHeight + 20 } : 40);
const firstSymbolLayer = () => map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
