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
| Overpass (`overpass-api.de`, fallback `maps.mail.ru`) | Pontos para fotografar dentro do bbox da maior isócrona | Compartilhado e frequentemente lotado; 1 consulta por vez, 3 rodadas com backoff 2/4 s |
| Open-Meteo (`api.open-meteo.com`) | Cobertura de nuvens horária (3 dias) + fuso IANA do ponto | Sem key, uso não comercial |

Todas as chamadas passam por um cache em memória (chave = URL + body). Erros de cada API aparecem como mensagem amigável na UI sem quebrar o resto. CORS validado em 2026-10-21: todas liberam `Access-Control-Allow-Origin: *`, inclusive para `Origin: null` (`file://`).

## Decisões

- **CEP**: o BrasilAPI devolve coordenadas do centro da cidade (ex.: CEP da Av. Paulista → Sé). Quando há rua, geocodificamos `rua + cidade` no Nominatim (busca estruturada); as coordenadas do BrasilAPI só entram como aproximação se o Nominatim falhar.
- **Número da casa**: o Photon só acerta números mapeados e às vezes troca a rua (ex.: "Rua Augusta 1500" → "Rua Cônego Valadão 1500"); reordenamos por número + rua batendo com o texto. Com número, o Enter faz uma busca explícita no Nominatim (permitido; autocomplete não). Se o número não existir, usamos o Photon com a rua sem número (o viés de localização dele acerta a homônima certa) e avisamos para arrastar o pin.
- **Ritmo**: perfis em `CONFIG.paces` (2,5 / 3,5 / 4,5 / 5,5 km/h); `v` na URL encaixa no perfil mais próximo.
- **Ladeiras**: liga/desliga; desligado = `use_hills` 0,5 (padrão equilibrado do Valhalla), ligado = 1. Na URL, `h=1` só quando ligado.
- **Loading**: `cached()` conta requisições pendentes (incluindo fila e retries) para a barra global `#busy`; `setStatus(id, msg, 'loading')` mostra spinner.
- **Overpass**: uma única consulta com as 7 categorias por bbox (arredondado para fora numa grade de 0,005°); os toggles filtram no cliente. Um bbox novo contido num já baixado reaproveita os dados. `overpass-api.de` rejeita (406) User-Agent genérico de curl; o navegador funciona.
- **Clique no mapa**: ponto de interesse → popup + rota; dentro da mancha → rota; fora → novo ponto. Clique direito sempre move o pin.
- **Troca de estilo**: `setStyle(url, { diff: false })` para disparar `style.load` e re-adicionar os overlays registrados com `registerOverlay()`.
- **Luz**: golden hour = sol entre −4° e +6°; blue hour = entre −6° e −4°. Horários no fuso do ponto (do Open-Meteo).
- **Estado na URL**: `#lat&lng&q&t&v&h&cat&d&s`; `cat` e `d` só aparecem quando diferem do padrão.
- **Teste local**: o browser do app Claude abre `file://` como `data:` URL (sem hash); para testar o hash, servir a pasta via HTTP local.

## Convenções de código

- JS moderno (ES2020+), sem frameworks. `const`/`let`, `async/await`.
- `index.html` organizado em seções comentadas: `// ==== SEÇÃO ====`.
- Estado da exploração (lat/lng, tempos, filtros) serializado no hash da URL.
- Commits pequenos em Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`), um por etapa testada.
- `CHANGELOG.md` atualizado a cada versão; versões marcadas com tags `vX.Y.Z`.

## Roadmap

v0.1.0 (ver `CHANGELOG.md`), publicada em https://arthurmundim.github.io/isocronas-a-pe/: busca (CEP/Photon/clique), basemap claro/escuro, isócronas 5/10/15/20 min com velocidade e `use_hills`, rota + perfil de elevação, pontos para fotografar (Overpass), luz para foto (SunCalc + Open-Meteo), estado na URL, layout responsivo (bottom sheet no celular).

Fora do escopo da v1 (Issues com label `roadmap`):
- Modo bike e transporte público.
- Comparar dois pontos lado a lado.
- Valhalla próprio em Docker.
