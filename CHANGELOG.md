# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões seguem [SemVer](https://semver.org/lang/pt-BR/).

## [0.5.1] - 2026-10-21

### Corrigido
- Etapas do painel apareciam sem estilo (botões "editar"/"abrir" crus) quando o navegador usava o `app.css` antigo do cache junto com o HTML novo. CSS e JS agora são carregados com versão no endereço (`?v=0.5.1`), trocada a cada release.

## [0.5.0] - 2026-10-21

### Alterado
- A mancha no mapa agora é a rede de ruas alcançáveis (Valhalla `/expansion`), cada rua na cor do anel de tempo, mais clara, com a rota selecionada por cima. Se as ruas falharem, volta a área de antes.
- As sugestões não aparecem mais de cara: depois do horário e dos estilos, você escolhe "⚡ Resposta rápida" (regras) ou "✨ Gerar com IA". O tamanho (Curto / Médio / Longo) vale para as duas: 3 / 5 / 8 dicas ou 3 / 4 / 6 momentos. Com IA, a resposta rápida fica recolhida abaixo do texto.

- Painel em etapas: ponto de partida → Caminhada → destino no mapa → Quando? → informações + estilos de foto → resposta rápida ou IA. Cada etapa concluída vira uma linha de resumo clicável (reabre para editar), com botão "Continuar". Pontos para fotografar e Luz para foto minimizam quando há rota (os dados seguem nas sugestões) e reabrem ao limpar a rota.
- "Anéis (min)" passou a se chamar "Tempos de caminhada (min)". O dia também pode ser escolhido no "Quando?".
- Lugares sem nome são descritos pela rua (ex.: "café sem nome no mapa, na altura da Rua X"), inclusive origem, destino e eventos de luz, nunca "o café" ou "no caminho".

### Adicionado
- Rolagem automática do painel até a parte em execução ou que pede input: Caminhada ao escolher um ponto, Rota e "Quando?" ao clicar um destino, cada etapa seguinte ao clicar "Continuar", progresso e texto da IA enquanto ela escreve.
- IA com regras duras no prompt (só o período da caminhada, só os números de câmera de cada momento, sem equipamento inventado, coerência com nuvens e eventos de luz, sem lugares vagos) e contexto do dia (golden/blue hour, pôr do sol e nuvens dentro da janela da caminhada).
- Checagem do texto gerado: horários, ISO/abertura/velocidade/EV, equipamentos, eventos de luz fora do período, sol direto com céu encoberto e lugares vagos. Se algo falhar, a IA refaz uma vez com temperatura menor; se persistir, o aviso lista o que conferir.

## [0.4.0] - 2026-10-21

### Adicionado
- "✨ Sugestão com IA": texto de amigo fotógrafo sobre a caminhada, em ordem cronológica, citando a configuração de câmera de cada momento. Roda no aparelho (WebLLM + WebGPU, Qwen2.5 1.5B, ~0,9 GB baixado uma vez), só por botão, com tamanho Curto / Médio / Longo.
- Configurações de câmera determinísticas por situação (golden/blue hour, noite, sol alto, encoberto, contraluz, street, arquitetura, sombras, água) nos dados da rota.
- Aviso quando o aparelho não suporta (sem WebGPU/GPU), quando os dados mudaram depois do texto e quando o texto cita horários que não estão nos dados.

## [0.3.0] - 2026-10-21

### Adicionado
- Horário da caminhada na rota: "Sair às" ou "Chegar às", com atalhos para chegar no nascer, golden hour da manhã/tarde, pôr do sol e blue hour. Mostra saída, chegada, fase da luz e nuvens previstas.
- Estilos de foto preferidos (street, arquitetura, paisagem urbana, retrato, noturna, minimalismo, natureza urbana, arte urbana), salvos no navegador e no link.
- Sugestões do que observar no caminho, geradas por regras: fase da luz na chegada e eventos durante a caminhada, contraluz e fachadas iluminadas por trecho, corredores de luz, sombras longas, nuvens, subidas, ponto mais alto e lugares a até 60 m da rota.
- "Dados usados nas sugestões": os fatos calculados em JSON, copiáveis (base para a futura camada de LLM).

### Alterado
- Com uma rota ativa, horários de luz e linhas de nascer/pôr do sol passam a partir do destino clicado.
- Código dividido em `index.html` + `css/app.css` + `js/*.js` (sem build, ainda funciona via `file://`).

### Corrigido
- Camadas do mapa (pontos, linhas do sol) que às vezes não apareciam por uma corrida entre o carregamento do estilo e dos scripts.

## [0.2.0] - 2026-10-21

### Adicionado
- Indicadores de carregamento: barra global no topo enquanto houver requisição pendente, spinner em cada seção e no campo de busca, mancha esmaecida durante o recálculo e "…" nas contagens de pontos.
- Busca por número exato: Enter (ou o item "🔎 Endereço exato") consulta o Nominatim, que tem interpolação de números; resultados do Photon com o número certo vão para o topo.

### Alterado
- Velocidade virou ritmo com 4 perfis: Fotografando (2,5 km/h), Passeio (3,5), Normal (4,5, padrão) e Apressado (5,5).
- "Evitar ladeiras" virou liga/desliga (`use_hills` 1 ligado, 0,5 desligado).
- Quando o número não está mapeado no OSM, o pin vai para a rua certa perto do mapa (Photon sem o número) com aviso para arrastar.

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

[0.5.1]: https://github.com/arthurmundim/isocronas-a-pe/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/arthurmundim/isocronas-a-pe/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/arthurmundim/isocronas-a-pe/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/arthurmundim/isocronas-a-pe/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/arthurmundim/isocronas-a-pe/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/arthurmundim/isocronas-a-pe/releases/tag/v0.1.0
