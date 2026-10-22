'use strict';
// ==== CONFIG ====
const CONFIG = {
  userAgentHint: 'isocronas-a-pe (github.com/arthurmundim/isocronas-a-pe)',
  styles: {
    light: 'https://tiles.openfreemap.org/styles/positron',
    dark: 'https://tiles.openfreemap.org/styles/dark',
  },
  defaultCenter: [-46.6559, -23.5614], // Av. Paulista (lng, lat)
  defaultZoom: 13,
  valhalla: 'https://valhalla1.openstreetmap.de',
  // walking_speed do Valhalla por perfil (o padrão do Valhalla é 5,1 km/h).
  paces: [
    { v: 2.5, label: 'Fotografando', hint: 'Bem devagar, parando a cada esquina para olhar e fotografar.' },
    { v: 3.5, label: 'Passeio', hint: 'Caminhada lenta, sem pressa, olhando em volta.' },
    { v: 4.5, label: 'Normal', hint: 'Caminhada convencional de quem vai a algum lugar.' },
    { v: 5.5, label: 'Apressado', hint: 'Passo rápido, quase atrasado.' },
  ],
  // Do mais perto (ciano claro) ao mais longe (magenta escuro): sem verde x vermelho (daltonismo) e sem "vermelho = ruim".
  // A diferença de claridade entre os anéis também ajuda quem não distingue matizes.
  ringColors: ['#5fd3e6', '#2aa6c4', '#6f6fd0', '#9d4fb8', '#7a1f78'],
  overpass: [ // tentados em ordem, com backoff exponencial entre rodadas (servidores públicos vivem lotados)
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ],
  openMeteo: 'https://api.open-meteo.com/v1/forecast',
  photon: 'https://photon.komoot.io/api/',
  brasilApiCep: 'https://brasilapi.com.br/api/cep/v2/',
  nominatim: 'https://nominatim.openstreetmap.org/search',
};

// "?debug" na URL mostra os dados usados nas sugestões (JSON).
const DEBUG = new URLSearchParams(location.search).has('debug');

// ==== ESTADO ====
const state = {
  point: null,          // { lat, lng, label }
  style: 'light',
  times: [5, 10, 15, 20],
  speed: 4.5,           // km/h, um dos CONFIG.paces
  hills: 0.5,           // use_hills do Valhalla: 0.5 (padrão, equilibrado) ou 1 (evitar ladeiras)
  iso: null,            // FeatureCollection das isócronas (maior primeiro)
  routeTarget: null,    // { lat, lng }
  cats: null,           // Set de categorias visíveis (preenchido com todas na inicialização)
  pois: [],             // pontos dentro da maior isócrona: { id, cat, name, lng, lat, ring, tags, osm }
  date: null,           // 'YYYY-MM-DD' para a luz do dia (padrão: hoje)
  tz: null,             // fuso IANA do ponto (vem do Open-Meteo); null = fuso do navegador
  weather: null,        // resposta do Open-Meteo (nuvens horárias, 3 dias)
  trip: null,           // rota atual: { target, dest, time (s), length (km), line, maneuvers, elev }
  depart: { mode: 'leave', time: null }, // "sair às" / "chegar às" + 'HH:MM' no fuso do lugar
  styles: new Set(),    // estilos de foto preferidos (ids de PHOTO_STYLES)
};

// ==== ESTILOS DE FOTOGRAFIA ====
const PHOTO_STYLES = [
  { id: 'street', label: 'Street', emoji: '🚶' },
  { id: 'arquitetura', label: 'Arquitetura', emoji: '🏛️' },
  { id: 'paisagem', label: 'Paisagem urbana', emoji: '🌆' },
  { id: 'retrato', label: 'Retrato', emoji: '🧑' },
  { id: 'noturna', label: 'Noturna / luzes', emoji: '🌃' },
  { id: 'minimal', label: 'Minimalismo / sombras', emoji: '◼️' },
  { id: 'natureza', label: 'Natureza urbana', emoji: '🌿' },
  { id: 'arte', label: 'Arte urbana', emoji: '🎨' },
];

// ==== CATEGORIAS DE PONTOS ====
// Ordem = prioridade quando um elemento casa com mais de uma (ex.: igreja histórica → patrimônio).
const CATEGORIES = [
  { id: 'viewpoint', label: 'Mirantes', one: 'mirante', many: 'mirantes', emoji: '🔭', color: '#7c3aed', osm: '["tourism"="viewpoint"]', match: (t) => t.tourism === 'viewpoint' },
  { id: 'artwork', label: 'Arte urbana / murais', one: 'obra de arte', many: 'obras de arte', emoji: '🎨', color: '#db2777', osm: '["tourism"="artwork"]', match: (t) => t.tourism === 'artwork' },
  { id: 'historic', label: 'Patrimônio', one: 'patrimônio', many: 'patrimônios', emoji: '🏛️', color: '#b45309', osm: '["historic"]', match: (t) => !!t.historic },
  { id: 'worship', label: 'Igrejas e templos', one: 'templo', many: 'templos', emoji: '⛪', color: '#475569', osm: '["amenity"="place_of_worship"]', match: (t) => t.amenity === 'place_of_worship' },
  { id: 'fountain', label: 'Fontes', one: 'fonte', many: 'fontes', emoji: '⛲', color: '#0284c7', osm: '["amenity"="fountain"]', match: (t) => t.amenity === 'fountain' },
  { id: 'park', label: 'Parques e praças', one: 'parque', many: 'parques', emoji: '🌳', color: '#15803d', osm: '["leisure"="park"]', match: (t) => t.leisure === 'park' },
  { id: 'cafe', label: 'Cafés', one: 'café', many: 'cafés', emoji: '☕', color: '#92400e', osm: '["amenity"="cafe"]', match: (t) => t.amenity === 'cafe' },
];
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
state.cats = new Set(CATEGORIES.map((c) => c.id));
