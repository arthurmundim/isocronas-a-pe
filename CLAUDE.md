# Isócronas a pé

App web de exploração urbana a pé. O usuário busca um endereço/CEP (ou clica no mapa), um pin é colocado e o app desenha a área alcançável caminhando (isócronas). Uso principal: achar lugares para fotografar e, em viagens, entender o quão tranquilo é andar a partir de um ponto (hotel, estação etc.).

## Contas

Projeto **pessoal**. Este repositório usa a identidade pessoal:

- Git: `Arthur Mundim Rodrigues <arthurmundim8@gmail.com>`, aplicada via `includeIf` para tudo em `C:\dev\pessoal\` (`~/.gitconfig-pessoal`).
- GitHub: conta `arthurmundim` (`gh auth status`). Repo: `arthurmundim/isocronas-a-pe`.
- **Nunca** alterar configuração global do git ou do gh. Antes de commitar/pushar, conferir `git config user.email` e `gh auth status`.

## Restrições

- Arquivos estáticos sem build step e sem API keys: `index.html` + `css/app.css` + `js/*.js` (dividido em 2026-10-21, quando o arquivo único chegou a ~1.300 linhas).
- Scripts **clássicos** (`<script src>`), não ES modules: módulos são bloqueados em `file://`. Eles compartilham as `const`/`function` globais, mas o hoisting não atravessa arquivos, então a ordem de carga importa (ver "Estrutura").
- Libs via CDN com versão fixada (jsDelivr).
- Funciona no GitHub Pages e aberto localmente (`file://`).
- Interface em português; termos técnicos podem ficar em inglês.

## Estrutura (ordem de carga)

1. `config.js`: `CONFIG`, `state`, `PHOTO_STYLES`, `CATEGORIES`.
2. `util.js`: DOM, status/toast, cache + filas (`cached`, `limits`), `fetchJSON`, parsers e formatos usados já no carregamento (`parseTimes`, `paceOf`, `todayStr`, fuso, `zonedDate`, estilos salvos).
3. `url.js`: hash da URL. 4. `map.js`: mapa, overlays, pin, `setPoint`. 5. `search.js`. 6. `iso.js`. 7. `route.js`. 8. `pois.js`. 9. `light.js`.
10. `trip.js`: horário sair/chegar, **fatos determinísticos** da rota (`buildFacts`) e configurações de câmera (`CAMERA`). 11. `tips.js`: motor de regras sobre os fatos. 12. `ai.js`: IA no navegador (opcional). 13. `main.js`: inicialização.

Código executado no carregamento só pode usar o que foi definido em arquivos anteriores; handlers e callbacks podem usar qualquer coisa.

## Libs (CDN, versões fixadas)

- MapLibre GL JS `4.7.1`
- SunCalc `1.9.0`
- turf.js `7.1.0`
- WebLLM `0.2.85` (`@mlc-ai/web-llm`, ES module via `import()` dinâmico, só quando a IA é usada; a 0.2.86 tinha menos de 2 semanas)

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
| Hugging Face (`huggingface.co/mlc-ai/...`) + GitHub raw (`binary-mlc-llm-libs`) | Pesos (~0,9 GB) e biblioteca WebGPU do Qwen2.5 1.5B, baixados uma vez pelo WebLLM | CORS liberado inclusive para `Origin: null` (testado em 2026-10-21) |

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
- **Overlays x carregamento**: o `style.load` pode disparar entre um `<script src>` e outro, e `isStyleLoaded()` ainda pode ser false logo depois; `registerOverlay` usa a flag própria `styleReady` (senão camadas registradas depois sumiam de forma intermitente).
- **Referência da luz**: com rota ativa, horários e linhas do sol usam o destino (`lightAnchor()`); sem rota, o pin.
- **Sugestões**: `buildFacts()` monta um objeto só com dados calculados (horários, sol por trecho, nuvens, elevação, pontos a ≤ 60 m da rota, estilos). As regras de `tips.js` leem **só** esse objeto, e ele é exibido/copiável como JSON: é o mesmo que será enviado ao LLM no navegador (fase 2). Trechos vêm da geometria da rota (pedaços de ~80 m unidos por direção ±25°), não das manobras do Valhalla (calçadas sem nome, manobras de ~1 km). Nomes de rua via reverse do Photon (`osm_tag=highway`) no meio de cada trecho. Com nuvens ≥ 85%, regras que dependem de sol direto não disparam.
- **Estilos de foto**: salvos no `localStorage` (`isocronas.styles`) e no hash (`f=`); o hash tem prioridade.
- **IA no navegador**: Qwen2.5-1.5B-Instruct (q4f16 se a GPU tem `shader-f16`, senão q4f32), motor na thread principal (`CreateMLCEngine`, sem Web Worker, que não carregaria via `file://`). Só por botão, com tamanho Curto/Médio/Longo = 3/4/6 momentos. O 1,5B **inventava muito** ao compor a partir do JSON (testado: "luzes de emergência", "casa número 147"); por isso `aiMoments()` monta de forma determinística os momentos em ordem cronológica (hora, lugar, o que observar, câmera) e o modelo só reescreve no tom de "amigo fotógrafo", com um exemplo few-shot (lugares do Rio, para não vazar nomes) e temperatura 0,3. Depois da geração, horários citados que não estão nos momentos geram aviso. Marca `isocronas.aiReady` no `localStorage` evita importar a lib (~6 MB) só para saber se o modelo já foi baixado. Notebook Intel Xe2: ~30 s de download, ~20 tokens/s, 16–25 s por texto.

## Convenções de código

- JS moderno (ES2020+), sem frameworks. `const`/`let`, `async/await`.
- Um arquivo por área, organizado em seções comentadas: `// ==== SEÇÃO ====`.
- Estado da exploração (lat/lng, tempos, filtros) serializado no hash da URL.
- Commits pequenos em Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`), um por etapa testada.
- `CHANGELOG.md` atualizado a cada versão; versões marcadas com tags `vX.Y.Z`.

## Roadmap

v0.1.0 (ver `CHANGELOG.md`), publicada em https://arthurmundim.github.io/isocronas-a-pe/: busca (CEP/Photon/clique), basemap claro/escuro, isócronas 5/10/15/20 min com velocidade e `use_hills`, rota + perfil de elevação, pontos para fotografar (Overpass), luz para foto (SunCalc + Open-Meteo), estado na URL, layout responsivo (bottom sheet no celular).

Fase 2 (IA no navegador) entregue em v0.4.0. Próximas ideias: avaliar Qwen2.5 3B como opção "qualidade" em notebooks; testar `file://` (Cache Storage pode não funcionar em origem `null`).

Fora do escopo da v1 (Issues com label `roadmap`):
- Modo bike e transporte público.
- Comparar dois pontos lado a lado.
- Valhalla próprio em Docker.
