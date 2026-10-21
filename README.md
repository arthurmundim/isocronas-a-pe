# Isócronas a pé

Exploração urbana a pé: busque um endereço, CEP ou lugar (ou clique no mapa) e veja até onde dá para ir caminhando em 5/10/15/20 min, o que há para fotografar nessa área e como estará a luz.

**App:** https://arthurmundim.github.io/isocronas-a-pe/

## Como abrir

- Online: a URL acima (GitHub Pages).
- Local: baixe o repositório e abra `index.html` no navegador (funciona via `file://`, sem build e sem API keys).

Dicas de uso:
- Clique **dentro** da mancha para ver a rota a pé e o perfil de elevação; clique **fora** (ou arraste o pin, ou use o clique direito) para mudar o ponto.
- Para um número exato, digite "Rua X 123" e tecle Enter. Se o número não estiver no OpenStreetMap, o pin fica na rua e dá para arrastar.
- Escolha o ritmo (Fotografando, Passeio, Normal, Apressado) e ligue "Evitar ladeiras" se quiser priorizar ruas planas.
- O link da página guarda a exploração (ponto, anéis, velocidade, filtros, data e tema). Use "Copiar link" para compartilhar.

## APIs usadas

| Serviço | Para quê |
|---|---|
| [OpenFreeMap](https://openfreemap.org) | Basemap claro/escuro |
| [BrasilAPI](https://brasilapi.com.br) | Busca por CEP |
| [Photon](https://photon.komoot.io) | Autocomplete de endereços/lugares |
| [Nominatim](https://nominatim.org) | Geocodificar a rua de um CEP (nunca autocomplete) |
| [Valhalla (FOSSGIS)](https://valhalla1.openstreetmap.de) | Isócronas, rota e elevação a pé |
| [Overpass API](https://overpass-api.de) | Pontos para fotografar (dados OpenStreetMap) |
| [Open-Meteo](https://open-meteo.com) | Previsão de cobertura de nuvens |

Libs via CDN (versões fixadas): MapLibre GL JS 4.7.1, SunCalc 1.9.0, turf.js 7.1.0.

## Limites conhecidos

- **Overpass** público vive sobrecarregado: os pontos podem levar 15–40 s ou falhar. O app tenta dois servidores com backoff e mostra um botão "Tentar de novo"; o resto continua funcionando.
- **Valhalla** público é compartilhado: sem SLA, pode ficar lento ou fora do ar. Máximo de 4 anéis de até 60 min.
- **CEP**: as coordenadas do BrasilAPI costumam ser o centro da cidade; por isso o app geocodifica a rua no Nominatim (1 req/s) e só usa as do BrasilAPI como aproximação.
- Pontos de área grande (ex.: parques) são representados pelo centro; um parque que encosta na mancha mas tem o centro fora não aparece.
- Previsão de nuvens cobre só os próximos 3 dias; os horários de luz valem para qualquer data.
- Cache é só em memória (some ao recarregar).

Dados © colaboradores do [OpenStreetMap](https://www.openstreetmap.org/copyright).
