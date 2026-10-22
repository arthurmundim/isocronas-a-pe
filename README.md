# Caminhada fotográfica

Exploração urbana a pé: busque um endereço, CEP ou lugar (ou clique no mapa) e veja até onde dá para ir caminhando em 5/10/15/20 min, o que há para fotografar nessa área e como estará a luz.

**App:** https://arthurmundim.github.io/isocronas-a-pe/

## Como abrir

- Online: a URL acima (GitHub Pages).
- Local: baixe o repositório e abra `index.html` no navegador (funciona via `file://`, sem build e sem API keys). Mantenha as pastas `css/` e `js/` ao lado.

Dicas de uso:
- A mancha mostra as ruas alcançáveis, coloridas pelo tempo (do ciano, mais perto, ao magenta, mais longe). Clique **dentro** dela para ver a rota a pé e o perfil de elevação; clique **fora** (ou arraste o pin, ou use o clique direito) para mudar o ponto; com uma rota aberta, o app pergunta antes. O ◎ do mapa parte de onde você está.
- Digite o endereço, lugar ou CEP e clique em **Buscar** (ou Enter): aparecem as opções e você escolhe uma. Com número ("Rua X 123"), o número exato vem marcado no topo; se ele não estiver no OpenStreetMap, escolha a rua e arraste o pin.
- Escolha o ritmo (Fotografando, Passeio, Normal, Apressado) e ligue "Evitar ladeiras" se quiser priorizar ruas planas.
- O painel avança em etapas: cada uma concluída vira uma linha de resumo (clique para editar). Depois da Caminhada, clique um destino no mapa (os pontos para fotografar aparecem em seguida). Com a rota aberta, o "Quando?" mostra os horários de luz e as nuvens do dia; escolha o dia e "Sair às" ou "Chegar às" (ou um atalho como "Chegar: Golden tarde") e marque os estilos de foto que você gosta: o app sugere o que observar no caminho (contraluz, fachadas iluminadas, corredores de luz, lugares perto da rota). As linhas do sol passam a sair do destino.
- Em "Sugestões para o caminho", escolha o tamanho e depois "⚡ Dicas rápidas" (lista por regras, na hora) ou "✨ Roteiro com IA", que escreve um texto de amigo fotógrafo sobre a caminhada, com as configurações de câmera de cada momento; se a IA errar num momento, ele aparece com o texto do app, marcado como "texto do app". Em cada momento, "💬 Perguntar sobre este momento" oferece 3 perguntas prontas (até 5 por texto). Roda no seu aparelho, sem enviar dados; na primeira vez pede confirmação e baixa o modelo (~0,9 GB).
- Enquanto algo carrega, os botões ficam travados e aparece "Cancelar", que volta ao passo anterior. Quando a sugestão aparece, o mapa destaca só os pontos citados e a rota; "👁 Ver tudo" volta ao mapa completo.
- O link da página guarda a exploração (ponto, anéis, ritmo, filtros, estilos, tema e, com rota aberta, destino, dia e horário). Use "🔗 Copiar link", no topo do painel, para compartilhar.
- Termos como golden hour, ISO ou Aperture estão explicados no **📖 Glossário** do mapa; o **🧭 Tour** apresenta cada parte da tela. Com `?debug` na URL aparecem os dados (JSON) usados nas sugestões.

## APIs usadas

| Serviço | Para quê |
|---|---|
| [OpenFreeMap](https://openfreemap.org) | Basemap claro/escuro |
| [BrasilAPI](https://brasilapi.com.br) | Busca por CEP |
| [Photon](https://photon.komoot.io) | Autocomplete de endereços/lugares e nome das ruas de cada trecho da rota (reverse) |
| [Nominatim](https://nominatim.org) | Geocodificar a rua de um CEP (nunca autocomplete) |
| [Valhalla (FOSSGIS)](https://valhalla1.openstreetmap.de) | Isócronas, rota e elevação a pé |
| [Overpass API](https://overpass-api.de) | Pontos para fotografar (dados OpenStreetMap) |
| [Open-Meteo](https://open-meteo.com) | Previsão de cobertura de nuvens |

Libs via CDN (versões fixadas): MapLibre GL JS 4.7.1, SunCalc 1.9.0, turf.js 7.1.0 e, só se você usar a IA, WebLLM 0.2.85 com o modelo Qwen2.5 1.5B (pesos no Hugging Face).

## Limites conhecidos

- **Overpass** público vive sobrecarregado: os pontos podem levar 15–40 s ou falhar. O app tenta dois servidores com backoff e mostra um botão "Tentar de novo"; o resto continua funcionando.
- **Valhalla** público é compartilhado: sem SLA, pode ficar lento ou fora do ar. Máximo de 4 anéis de até 60 min.
- **CEP**: as coordenadas do BrasilAPI costumam ser o centro da cidade; por isso o app geocodifica a rua no Nominatim (1 req/s) e só usa as do BrasilAPI como aproximação.
- Pontos de área grande (ex.: parques) são representados pelo centro; um parque que encosta na mancha mas tem o centro fora não aparece.
- Previsão de nuvens cobre só os próximos 3 dias; os horários de luz valem para qualquer data.
- Cache das APIs é só em memória (some ao recarregar).
- **IA**: precisa de WebGPU (Chrome/Edge no desktop, Chrome no Android) e baixa ~0,9 GB na primeira vez. É um modelo pequeno: o texto pode sair com português truncado ou misturar detalhes; as dicas por regras e os dados ficam sempre visíveis para conferência. Aberto via `file://`, o cache do modelo pode não funcionar (não testado).

Dados © colaboradores do [OpenStreetMap](https://www.openstreetmap.org/copyright).
