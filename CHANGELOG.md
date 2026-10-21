# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões seguem [SemVer](https://semver.org/lang/pt-BR/).

## [0.1.0] - 2026-10-21

Primeira versão funcional.

### Adicionado
- Busca por CEP (BrasilAPI + Nominatim para precisão de rua) e autocomplete de texto livre (Photon, debounce 400 ms).
- Clique no mapa, arrastar o pin ou clique direito redefinem o ponto de partida.
- Basemap OpenFreeMap claro/escuro, com a UI acompanhando o tema.
- Isócronas a pé (Valhalla `pedestrian`) com até 4 anéis configuráveis, velocidade de caminhada e "evitar ladeiras" (`use_hills`), com legenda.
- Clique dentro da mancha: rota a pé (`/route`) e mini-gráfico do perfil de elevação (`/height`) com subida/descida acumuladas.
- Pontos para fotografar (Overpass): mirantes, arte urbana, patrimônio, igrejas, fontes, parques e cafés, filtrados pela maior isócrona, com toggles, contagem por anel, lista e popup com rota.
- Luz para foto: golden/blue hour, nascer/pôr do sol com azimute desenhado no mapa (SunCalc) e nuvens previstas nas golden hours dos próximos 3 dias (Open-Meteo), no fuso do lugar.
- Estado da exploração no hash da URL e botão "Copiar link".
- Layout responsivo: painel lateral vira bottom sheet no celular.
- Cache em memória, filas com intervalo mínimo por API e fallback/backoff entre servidores Overpass.

[0.1.0]: https://github.com/arthurmundim/isocronas-a-pe/releases/tag/v0.1.0
