# Isócronas a pé

App web de exploração urbana a pé. O usuário busca um endereço/CEP (ou clica no mapa), um pin é colocado e o app desenha a área alcançável caminhando (isócronas). Uso principal: achar lugares para fotografar e, em viagens, entender o quão tranquilo é andar a partir de um ponto (hotel, estação etc.).

## Contas

Projeto **pessoal**. Este repositório usa a identidade pessoal:

- Git: `Arthur Mundim Rodrigues <arthurmundim8@gmail.com>`, aplicada via `includeIf` para tudo em `C:\dev\pessoal\` (`~/.gitconfig-pessoal`).
- GitHub: conta `arthurmundim` (`gh auth status`). Repo: `arthurmundim/isocronas-a-pe`.
- **Nunca** alterar configuração global do git ou do gh. Antes de commitar/pushar, conferir `git config user.email` e `gh auth status`.

## Restrições

- Um único `index.html` (HTML + CSS + JS inline), sem build step, sem API keys.
- Libs via CDN com versão fixada (jsDelivr).
- Funciona no GitHub Pages e aberto localmente (`file://`).
- Interface em português; termos técnicos podem ficar em inglês.
- Se `index.html` passar de ~1.500 linhas, propor migração para múltiplos arquivos estáticos (sem build) antes de fazer.

## Libs (CDN, versões fixadas)

- MapLibre GL JS `4.7.1`
- SunCalc `1.9.0`
- turf.js `7.1.0`

## APIs usadas e limites

| API | Uso | Limites / política |
|---|---|---|
| OpenFreeMap (`tiles.openfreemap.org`) | Basemap (estilos `positron` claro / `dark`) | Gratuito, sem key |
| BrasilAPI `/api/cep/v2/{cep}` | Busca por CEP | Sem key; uso razoável |
| Photon (`photon.komoot.io`) | Autocomplete de texto livre | Uso justo; debounce 400 ms |
| Nominatim (`nominatim.openstreetmap.org`) | Só fallback de CEP sem coordenadas | **Máx 1 req/s, proibido para autocomplete** |
| Valhalla (`valhalla1.openstreetmap.de`) | `/isochrone`, `/route`, `/height` (pedestrian) | Servidor público FOSSGIS, compartilhado; evitar rajadas |
| Overpass (`overpass-api.de`) | Pontos para fotografar dentro do bbox da maior isócrona | Compartilhado; 1 consulta por vez, cache |
| Open-Meteo (`api.open-meteo.com`) | Cobertura de nuvens horária (3 dias) | Sem key, uso não comercial |

Todas as chamadas passam por um cache em memória (chave = URL + body). Erros de cada API aparecem como mensagem amigável na UI sem quebrar o resto.

## Convenções de código

- JS moderno (ES2020+), sem frameworks. `const`/`let`, `async/await`.
- `index.html` organizado em seções comentadas: `// ==== SEÇÃO ====`.
- Estado da exploração (lat/lng, tempos, filtros) serializado no hash da URL.
- Commits pequenos em Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`), um por etapa testada.
- `CHANGELOG.md` atualizado a cada versão; versões marcadas com tags `vX.Y.Z`.

## Roadmap

v1 (ver `CHANGELOG.md`): busca (CEP/Photon/clique), basemap claro/escuro, isócronas 5/10/15/20 min com velocidade e `use_hills`, rota + perfil de elevação, pontos para fotografar (Overpass), luz para foto (SunCalc + Open-Meteo), estado na URL, layout responsivo (bottom sheet no celular).

Fora do escopo da v1 (Issues com label `roadmap`):
- Modo bike e transporte público.
- Comparar dois pontos lado a lado.
- Valhalla próprio em Docker.
