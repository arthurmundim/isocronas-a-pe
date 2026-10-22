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
10. `trip.js`: horário sair/chegar, **fatos determinísticos** da rota (`buildFacts`) e configurações de câmera (`CAMERA`). 11. `tips.js`: motor de regras sobre os fatos. 12. `ai.js`: IA no navegador (opcional). 13. `qa.js`: perguntas por momento. 14. `flow.js`: etapas. 15. `main.js`: inicialização.

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
| Photon (`photon.komoot.io`) | Busca de texto livre (só ao clicar "Buscar") e nome das ruas dos trechos (reverse) | Uso justo |
| Nominatim (`nominatim.openstreetmap.org`) | Rua de um CEP e número exato, só em busca explícita (botão "Buscar") | **Máx 1 req/s, nunca enquanto digita** |
| Valhalla (`valhalla1.openstreetmap.de`) | `/isochrone` (polígonos, para a lógica), `/expansion` (ruas alcançáveis, para o desenho; ~700 KB para 20 min), `/route`, `/height` (pedestrian) | Servidor público FOSSGIS, compartilhado; evitar rajadas |
| Overpass (`overpass-api.de`, fallback `maps.mail.ru`) | Pontos para fotografar dentro do bbox da maior isócrona | Compartilhado e frequentemente lotado; 1 consulta por vez, 3 rodadas com backoff 2/4 s |
| Open-Meteo (`api.open-meteo.com`) | Cobertura de nuvens horária (3 dias) + fuso IANA do ponto | Sem key, uso não comercial |
| Hugging Face (`huggingface.co/mlc-ai/...`) + GitHub raw (`binary-mlc-llm-libs`) | Pesos (~0,9 GB) e biblioteca WebGPU do Qwen2.5 1.5B, baixados uma vez pelo WebLLM | CORS liberado inclusive para `Origin: null` (testado em 2026-10-21) |

Todas as chamadas passam por um cache em memória (chave = URL + body). Erros de cada API aparecem como mensagem amigável na UI sem quebrar o resto. CORS validado em 2026-10-21: todas liberam `Access-Control-Allow-Origin: *`, inclusive para `Origin: null` (`file://`).

## Decisões

- **CEP**: o BrasilAPI devolve coordenadas do centro da cidade (ex.: CEP da Av. Paulista → Sé). Quando há rua, geocodificamos `rua + cidade` no Nominatim (busca estruturada); as coordenadas do BrasilAPI só entram como aproximação se o Nominatim falhar.
- **Busca**: nada é consultado enquanto se digita. O botão "Buscar" (ou Enter) consulta Photon e, havendo número, o Nominatim (que interpola números) em paralelo; CEP vai ao BrasilAPI. Resultado = lista de opções no painel (número exato marcado no topo); o pin só muda quando a pessoa escolhe. O Photon às vezes troca a rua ("Rua Augusta 1500" → "Rua Cônego Valadão 1500"), por isso o "exato" exige número e rua batendo com o texto. Sem número mapeado, entram opções da rua sem número (viés de localização do Photon), avisando para arrastar o pin.
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
- **Mancha de ruas**: o desenho vem de `/expansion` (`action: isochrone`, `expansion_properties: ["duration"]`; a propriedade `durations` no plural dá erro 168). Cada aresta recebe a cor do menor anel cujo tempo cobre a `duration`; opacidade 0,55 para a rota (azul, por cima) destacar. Os polígonos de `/isochrone` continuam sendo a base de `insideIsochrone`/`ringOf`/Overpass e só aparecem (`iso-fill`) se o `/expansion` falhar.
- **Sugestões por escolha**: nada aparece até escolher "Resposta rápida" ou "Gerar com IA" (`aiState.mode`); a escolha zera a cada destino clicado. O tamanho (`AI.sizes`) controla dicas (3/5/8) e momentos (3/4/6).
- **Rolagem automática**: `reveal()` em `util.js`, chamado só em ações do usuário (`setPoint(..., { show })`, `showRoute(..., { show: true })`, botões de sugestão), nunca no carregamento inicial, em recálculos ou quando o Overpass termina.
- **Painel em etapas** (`flow.js`): ordem search → walk → pois (escolha do destino) → route + when (dia, hora, luz e nuvens; a rota minimiza no "Continuar" do when) → styles → suggest; etapas futuras ficam ocultas. Regra global `[hidden] { display: none !important }`: sem ela, classes com `display` venciam o `hidden` (o "Parar" aparecia sempre). Sem WebGPU, "Gerar com IA" fica visível e desativado, nunca oculto. `.step[data-step]` com `.step-summary` (linha clicável) e `.step-body`; `collapseStep/openStep/hideStep`, resumos em `STEP_SUMMARY` atualizados por `refreshSummaries()` (chamado em `onStateChanged`, `renderTrip`, `renderPois`, nuvens). Eventos: `flowNewPoint` (em `setPoint`), `flowRouteStart` (destino clicado), `flowRouteCleared`, `flowPoisLoaded` (fim do Overpass). A etapa `pois` só abre depois do "Continuar" da Caminhada **e** do fim do Overpass (`awaitingPois`), sem atalho para pular (o usuário pediu para não ter). Ao trocar de ponto, `state.iso` é zerado para não abrir a etapa com dados do ponto anterior. A antiga seção "Luz para foto" vive dentro do "Quando?" (`#date`, `#sun-table`, `#cloud-table`).
- **Lugares sem nome**: `buildFacts` descreve pela rua nomeada mais próxima naquele ponto da rota ("café sem nome no mapa, na altura da Rua X"; "destino escolhido no mapa, na Rua Y"); eventos de luz nos momentos usam a rua do trecho em andamento.
- **IA, regras duras**: `aiRules(f)` monta regras concretas a partir dos fatos (janela da caminhada, números só do momento, sem equipamento, céu encoberto, eventos fora da janela proibidos); `aiContext(f)` dá os horários de luz e nuvens dentro da janela (saída até chegada + 2 h). `aiCheck` valida horários, números de câmera (ISO, f/, 1/x, EV, inclusive faixas), equipamentos, eventos de luz, sol direto com céu encoberto e lugares vagos (substantivo genérico em minúscula; nomes têm maiúscula). Com problemas, refaz 1 vez com temperatura 0,1 citando os erros.
- **Texto da IA estruturado**: o modelo recebe `momentsPrompt` (lugar + o que observar, sem hora e sem câmera) e devolve uma linha numerada por momento. `renderAiOut` monta cada bloco: "hora · lugar", a frase da IA (sem o lugar repetido no início), `camText()` no formato "(ISO: …, Aperture: …, Shutter Speed: …, EV: …)" e "Por quê:" (`CAMERA[x].why`). Configuração e motivo nunca vêm do modelo; número de câmera no texto do modelo conta como erro na checagem, assim como momento faltando (preenchido com a descrição determinística).
- **Câmera x luz**: `cameraForScene(cena, fase, encoberto)`; com blue hour/noite usa `CAMERA_LOW` (street, arquitetura, água, retrato). `CAMERA.interior` para "entrar no lugar". Os momentos guardam `phase` (pela altitude do sol do trecho em andamento), `scene` e `cat`. A cena de retrato no parque só vale com o estilo retrato marcado.
- **Perguntas por momento** (`qa.js`): banco `QA_BANK` (ordem = prioridade) com `applies/text/data/cam`; 3 opções por vez, sem nada que mude horário. A IA reescreve as perguntas (aceita só se continuar uma pergunta, com o lugar, sem números e sem palavra de conteúdo nova além de `QA_NEUTRAL`; senão fica a do banco) e responde em 2–3 frases usando só `data`. `qaCheck`: números (qualquer um, exceto horários dos dados), equipamento e contradições técnicas (diafragma aberto/fechado, ISO alto/baixo). Errou 2 vezes → mostra a resposta calculada (`data` + configuração e motivo). Limite `QA_MAX = 5` perguntas por texto gerado; zera a cada geração. O motor do WebLLM atende uma requisição por vez (`qaState.pending`/`busy`).
- **Respostas com guardrails** (`qa.js`): campos `resposta/porque/dica` com `response_format` JSON schema (gramática do WebLLM; `maxLength` 220 só como teto, o corte fino é `firstSentence`). Testado: com gramática a estrutura é garantida; a 1ª compilação leva ~25 s, por isso `qaWarmup()` roda logo após o texto da IA. Prompt por pergunta: objetivo (`goal`), dados em tópicos via `dataText` com `noNums` (o modelo copiava números do motivo), termos proibidos de `qaForbidden` (inclui nomes dos exemplos do few-shot) e 3 exemplos (Rio). Perguntas de sim/não têm `answer`/`polarity`: a frase de resposta é do app (o modelo já inverteu o veredito) e porquê/dica que contradigam são rejeitados. Sem histórico no prompt (contaminava a pergunta seguinte); só `mainVer` (sem o vizinho fundido). `qaCheck`: tamanho por campo, números, termos proibidos e nomes próprios compostos fora dos dados.
- **Carregamentos canceláveis** (`util.js`): `opStart(nome, âncora, onCancel)` / `opEnd` / `opCancel`; enquanto houver op, `lockPanel()` desabilita botões e campos do painel (e o CSS `.busy-lock` cobre o que for redesenhado), o pin não arrasta e cliques no mapa só mostram aviso (`mapLocked`). `fetchJSON` registra cada requisição por API em `fetchCtrls`; `abortApis([...])` aborta (erro com `cancelled: true`). Ops: `search`, `walk` (até as ruas chegarem; cancelar restaura `lastGood` ou volta à busca), `pois` (espera do Overpass; volta à Caminhada e o "Continuar" refaz a busca), `route` (até a rota; a elevação segue sem travar), `ai` e `qa`.
- **IA cancelável**: `aiState.gen` (cada geração só mexe na tela se ainda for a atual); download do modelo não é abortável no WebLLM, só ignorado. Toda chamada ao motor passa por `engineRun` e a interrupção por `aiInterrupt()` (só interrompe se há geração em andamento) — no WebLLM 0.2.85 `interruptGenerate()` arma um sinal que a chamada sem streaming nunca zera (respostas seguintes vazias), por isso `engineRun` zera `engine.interruptSignal` quando o motor fica livre.
- **Texto da IA**: gerado inteiro (inclusive a nova tentativa) antes de aparecer; progresso no status; `renderAiOut(..., { animate: true })` com fade em sequência (`.ai-in`, respeita "reduzir movimento").
- **Modo foco** (`flow.js`, `mapFocus`): liga em `flowSuggestionShown()` (resposta rápida ou fim da IA), sai em `focusReset()` (rota limpa, nova sugestão, cancelar). Ícones cinza `poi-grey-*`, camada `poi-focus-label` com o nome, `iso-streets` em `#9aa1ad` e opacidade 0,28, e `fitBounds` na rota. IDs citados: `pid`/`extraPids` dos momentos (IA) ou `_pontos` (resposta rápida) + destino. O nome `mapFocus` evita colidir com `window.focus`.

## Convenções de código

- JS moderno (ES2020+), sem frameworks. `const`/`let`, `async/await`.
- Um arquivo por área, organizado em seções comentadas: `// ==== SEÇÃO ====`.
- Estado da exploração (lat/lng, tempos, filtros) serializado no hash da URL.
- Commits pequenos em Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`), um por etapa testada.
- `CHANGELOG.md` atualizado a cada versão; versões marcadas com tags `vX.Y.Z`.
- **A cada versão, atualizar o `?v=X.Y.Z` de `css/app.css` e de todos os `js/*.js` no `index.html`.** O GitHub Pages serve com `Cache-Control: max-age=600`; sem isso o navegador mistura HTML novo com CSS/JS antigos (aconteceu na v0.5.0: etapas sem estilo).

## Roadmap

v0.1.0 (ver `CHANGELOG.md`), publicada em https://arthurmundim.github.io/isocronas-a-pe/: busca (CEP/Photon/clique), basemap claro/escuro, isócronas 5/10/15/20 min com velocidade e `use_hills`, rota + perfil de elevação, pontos para fotografar (Overpass), luz para foto (SunCalc + Open-Meteo), estado na URL, layout responsivo (bottom sheet no celular).

Fase 2 (IA no navegador) entregue em v0.4.0. Próximas ideias: avaliar Qwen2.5 3B como opção "qualidade" em notebooks; testar `file://` (Cache Storage pode não funcionar em origem `null`).

Fora do escopo da v1 (Issues com label `roadmap`):
- Modo bike e transporte público.
- Comparar dois pontos lado a lado.
- Valhalla próprio em Docker.
