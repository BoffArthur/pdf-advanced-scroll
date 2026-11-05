# Análise: como o plugin `pdf-advanced-scroll` chega aos valores do log

> **Nota (formato atual):** o log agora usa horário UTC ISO com milissegundos e `pdf=<id>` por contêiner, e registra só eventos que mudam posição (`JUMP`, `APPLY`, `FREEZE_START`, `FREEZE_END`, `INTENT`, `KEY`, `CONTROL`, `RESTORE`, `DESVIO`, `ANOMALIA`, `APPLY_SKIP`, `SYNC_UNAVAILABLE`). Os nomes antigos (`onScroll:JUMP-DETECTADO`, `apply:timer*`, `scroll(freeze)`, `keydown-raw`, `wrapper:*`) foram removidos, junto com o `[top= left= pg= off= frac=]` automático. Os trechos abaixo que citam esses nomes descrevem o formato anterior.

Fonte analisada: `main.js` do plugin (cópia lida em `%TEMP%\pdfphs-analysis`, removida ao final).
Configuração ativa (`data.json`): `positionMode: "absolute"`, `manualWindowMs: 1`, `debugLog: true`, `syncScrolling: false`.

Constantes relevantes (`main.js`):
- `FREEZE_MS = 450` (linha 6): duração do "congelamento" após um salto.
- `PAGE_TOP_TOLERANCE_PX = 24` (linha 7): tolerância para considerar que o viewport está alinhado ao topo de uma página.
- `USER_INTENT_MS = 500`: janela após interação do usuário em que a rolagem é tratada como manual.
- `applyTimers = [0, 60, 150, 300]` (linha 602): reaplicações da posição após um salto.

### Sincronização de rolagem manual (`syncScrolling`)

Quando `syncScrolling` está ligado, a rolagem feita pelo usuário (wheel, toque, arraste da barra, teclas de rolagem) em um PDF é replicada nos demais:

- `onScroll` (ramo de intenção do usuário) chama `syncScrollPosition(state, prevRatio, prevTop)`. A vertical é replicada como o **mesmo deslocamento em pixels** da origem (`applyUserScroll`, a partir da posição atual do destino), igual ao que o usuário faz na página selecionada. Não usa proporção, para que documentos de alturas diferentes não caiam em outro ponto.
- A horizontal é replicada pela proporção (`scrollLeft / (scrollWidth - clientWidth)`), e só quando X mudou (`RATIO_EPSILON` = 1e-4). Assim, rolar só em Y não mexe no X dos demais, e vice-versa.
- Todas as escritas passam por `writeScroll`, que marca o eco (`markSyncTarget`, `syncEchoUntil`) e limpa expectativa e freeze do destino. Eventos de scroll causados pela sincronização não entram na detecção de salto.
- Escrita sem alcance de rolagem (`maxY`/`maxX` = 0) mantém o eixo atual, em vez de ir para 0.
- **Isso ignora `positionMode` para a rolagem manual**: `applySnap` continua valendo para comandos de página, mas não para o scroll direto.
- **Zoom:** `onScaleChanging` escuta o evento `scalechanging` do PDF.js. O zoom numérico (`currentScale`) é copiado para os demais PDFs e, em seguida, a proporção de rolagem da origem é reaplicada. Predefinições de zoom (ex.: largura da página) não são copiadas, pois cada painel tem largura diferente.
- PDFs ocultos não recebem `scrollTo` nem zoom (o navegador zera a rolagem de elementos ocultos). A proporção e o zoom ficam em `pendingScroll` / `pendingScale` e são aplicados em `onResize` quando o contêiner volta a ficar visível.
- Anti-eco: cada `scrollTo` aplicado registra a posição final com `markSyncTarget`, e o evento de scroll resultante é consumido em `consumeSyncTarget`, sem reenviar a sincronização. Zoom usa a flag `applyingZoom` para não reenviar.
- Rolagens sem intenção do usuário (por exemplo, o ajuste de layout) não são replicadas.
- `syncScrolling` vem desligado por padrão (`DEFAULT_SETTINGS`); o valor salvo em `data.json` tem precedência.

---

## 1. Glossário dos campos do log

A função `log()` (linha 97) calcula `pos` **no momento da escrita**, chamando `captureSnap()`. Nada disso é guardado no log; é uma fotografia do estado.

| Campo | Origem no código |
|---|---|
| `top` | `el.scrollTop` do contêiner (`.pdf-viewer-container` / `#viewerContainer`) |
| `left` | `el.scrollLeft` do mesmo contêiner |
| `pg` | `captureSnap()` (linha 477): primeira `.page[data-page-number]`, em ordem de DOM, cujo `bottom > topo_viewport + 0.5` |
| `off` | `offsetPx = viewportTop(el) − rect.top` da página: distância, em px de tela, do topo da página até o topo visível. Pode ser negativo |
| `frac` | `frac = offsetPx / rect.height`: fração vertical dentro da página (0 = topo, 1 = fim) |
| `FREEZE(pg=X snapPg=Y frac=Z)` | `state.freeze`: `pg` = página-alvo (`freeze.page`), `snapPg`/`frac` = posição de origem salva (`freeze.snap`) |
| `{...}` | dados extras do ponto de log (ex.: `prevPg`, `newPg`, `targetTop`, `pageH`) |
| `W` | aparece quando `state.wrapped` está ativo (salto interceptado na origem) |

`viewportTop(el)` = `el.getBoundingClientRect().top + el.clientTop` (linha ~518), ou seja, coordenada de tela, **não** de scroll. Por isso `off` não depende de `top`.

---

## 2. Fluxo completo: de um evento de scroll até `targetTop`

### 2.1 Captura da posição atual (`captureSnap`, linha 477)
1. Percorre as páginas no DOM e escolhe a que contém o topo da viewport.
2. `frac = (topo_viewport − rect.top) / rect.height`.
3. Se o topo da viewport já passou do fim da última página renderizada, devolve `pageNumber + 1` com `frac = 0` (a próxima página ainda não existe no DOM).
4. Guarda também `left` e `ratioX = scrollLeft / maxX`, onde `maxX = scrollWidth − clientWidth`.

### 2.2 Salvamento (`savePosition`, linha 522; e `state.snap = snap` na linha 750)
Em todo `scroll` que **não** é tratado como salto, `state.snap` é sobrescrito pela posição atual. Esse snapshot é a "memória" que o plugin usará depois.

### 2.3 Detecção de salto (`onScroll`, linhas 626–750)
Um evento de `scroll` cai no caminho de salto quando **todas** as condições são verdadeiras:
- `!state.wrapped`: o salto não foi interceptado em `scrollPageIntoView` (linha ~730).
- `previous` existe (há um `state.snap` anterior).
- `!userScrolling`: sem arraste e fora da janela `manualUntil`. Com `manualWindowMs = 1`, essa janela praticamente nunca está aberta.
- `alignedToPageTop`: `windowMs > 0 || |offsetPx| ≤ 24` (linha 726). **Com `manualWindowMs = 1` esta condição é sempre verdadeira**, então qualquer troca de página sem intenção do usuário conta como salto, mesmo fora do topo da página.
- `snap.pageNumber !== previous.pageNumber`.

Ao detectar, o plugin loga `onScroll:JUMP-DETECTADO` e executa:
1. `startFreeze(state, previous, snap.pageNumber)` (linha 575): guarda a posição **anterior** como alvo.
2. `applyFreeze` → `applySnap` com a posição anterior.
3. `scheduleApply` (linha 598): reaplica nos tempos 0, 60, 150 e 300 ms.

### 2.4 Cálculo da posição de destino (`applySnap`, linha 530)
```
left = snap.left                                  // modo "absolute" (usado aqui)
   // alternativas: snap.ratioX * maxX  (proportional) | maxX/2  (center)
top  = el.scrollTop + rect_destino.top − viewportTop(el) + snap.frac * rect_destino.height
```
Ou seja: o plugin posiciona a página de destino de modo que **a mesma fração `frac`** da página original fique no topo da viewport. `targetTop` é esse `top`, limitado a `≥ 0`. Depois ele chama `el.scrollTo({left, top, behavior:"instant"})` e grava `state.expect` (usado para detectar "anomalias").

### 2.5 Durante o congelamento (`onScroll` com `state.freeze`, linhas ~655–690)
- Se o scroll cai na mesma página e `|frac_atual − frac_alvo| > 0.02` (≈ 165 px nesta página de 8270 px), registra `DESVIO-CORRIGIDO` e reaplica (até 4 vezes).
- Se há freeze, troca de página sem ação do usuário registra `RESTORE` e reaplica a página congelada (sem `RETARGET`). Se cai na mesma página com offset > 0,02, registra `DESVIO` (teto de 4).
- Caso contrário, só registra `scroll(freeze)`.

### 2.6 Fim do congelamento (`extendFreeze` / `endFreeze`, linhas 586–625)
Cada `extendFreeze` reagenda um timer de 450 ms. Quando ele expira, `endFreeze` chama `clearFreeze` (que loga `clearFreeze`) e depois `savePosition`, que grava a posição atual como nova referência.

---

## 3. Análise do log enviado

### 3.1 Ciclo 1 — salto 35 → 36 (t = 12434707)

| Passo | Log | Verificação numérica |
|---|---|---|
| Salvo antes: pg 35, frac 0,261, X = 2155 | `state.snap` | |
| Scroll detectado com `top=289445.8 left=0 pg=36 off=-0.4` | `onScroll:JUMP-DETECTADO` | X = 0 (reset), pg mudou |
| `startFreeze` com alvo `snapPg=35 frac=0.261` | `startFreeze` | |
| `applySnap` → `targetTop 291603.5` | `apply:onScroll` | topo pg36 ≈ 289446.2; frac real = 2157.3/8270.7 = **0,2608** ✔ |
| Scroll resultante `top=291603.3 left=2155` | `scroll(freeze)` | X restaurado para 2155 ✔ |
| `timer0/60/150/300` reaplicam o mesmo `targetTop` | `apply:timer*` | Nada a corrigir (diferença < 0,3 px) |
| Fim do freeze | `clearFreeze` em 12435164 | ≈ 457 ms após o início (450 ms + latência de timer) |

### 3.2 Ciclo 2 — salto 36 → 37 (t = 12438142, +3,4 s)
- Antes do evento: `top=291603.3 left=2155`.
- Depois do evento: `top=297716.7 left=0.0 pg=37 off=-0.2`. O scroll foi **+6113.4 px** e X voltou para 0.
- Esperado: `(1 − 0,2608) × 8270.7 = 6113.5` ✔. O valor bate exatamente com a distância até o topo da página 37.
- Restauração: `targetTop 299874` = topo pg37 (297716.9) + 0,2608 × 8270.7 (2157.0) ✔.

### 3.3 Ciclo 3 — **sem troca de página** (t = 12440391, +1,1 s após o ciclo 2)
- Antes: `top=308145.0 left=2155 pg=38 off=2157.4 frac=0.261` (posição restaurada).
- Depois: `top=314256.7 left=0.0 pg=38 off=8269.1 frac=1.000`. O passo foi **+6111.7 px**, praticamente o mesmo dos ciclos anteriores.
- Como a página continua 38, **não há `JUMP`**. O código cai no ramo final de `onScroll` (linha 750) e salva `state.snap = {pg 38, frac 1.0, left 0}`.
- **Resultado: a posição horizontal (X = 2155) é perdida e o plugin não a restaura**, porque a restauração só acontece em salto de página.

### 3.4 Padrão observado
- O deslocamento vertical é quase constante (≈ 6112–6114 px) em todos os eventos.
- Em todo evento `left` vai para **0**. A restauração de X só acontece quando há troca de página detectada.
- O plugin restaura `frac = 0,2608` em toda página nova, ou seja, a vista nunca mostra o topo da página de destino.

---

## 4. Hipóteses e pontos ainda não provados

**H1 (provável): o viewer do PDF.js não está vinculado.** A linha 737 só loga `JUMP-DETECTADO` quando `!state.wrapped`. Isso significa que o wrapper de `scrollPageIntoView` não está instalado. Além disso, em nenhum dos três ciclos aparecem `wrapper:before`, `pagechanging` nem `pagerendered`, o que indica que `bindViewer` não encontrou o `pdfViewer` (`getPDFViewer`, linha 210). Nesse caso, o plugin funciona só pelo caminho de fallback baseado em DOM, com `scroll` e timers.
- *Como verificar:* logar em `bindViewer` o resultado de `getPDFViewer(state.leaf.view)` e as chaves disponíveis em `leaf.view`.

**H2 (não identificado): origem do deslocamento.** Não há `intent:wheel`, `intent:pointerdown` nem `KEY` antes dos saltos. `keydown-raw` só aparece com `Control` no fim. Ou seja, nenhum evento de usuário registrado causou o movimento. Algo programático (outro plugin, como PDF++, ou um `scrollTo` / `scrollIntoView`) está rolando o contêiner.
- *Como verificar:* em modo debug, interceptar `Element.prototype.scrollTo`, `scrollIntoView` e a atribuição de `scrollTop` e registrar `new Error().stack` quando não houver intenção do usuário.

**H3: `left = 0` em todo evento.** Algo define `scrollTop` sem preservar `scrollLeft`, o que é típico de `scrollTo({ top })` ou de scroll por página. Confirma-se junto com H2.

**H4 (a confirmar): o passo de ~6113 px é fixo.** Nos ciclos 1–2 ele coincide com "distância até o topo da próxima página". No ciclo 3 ele não cruza página e mesmo assim tem o mesmo tamanho, então a hipótese mais simples é um deslocamento de tamanho fixo (talvez relacionado à altura da viewport ou a um passo de rolagem). Vale medir `clientHeight` do contêiner para comparar.

---

## 5. Problema, em termos do código

1. **X é perdido e não é protegido.** O snapshot de X é gravado a cada scroll não tratado como salto (linha 750). Quando o viewer zera `scrollLeft`, esse zero passa a ser a "memória" do plugin. A restauração de X só existe dentro do fluxo de salto.
2. **Y é reescrito pelo plugin em cada troca de página.** A restauração usa a fração antiga (`frac 0,2608`) na página nova. Isso faz o viewer "pular" para dentro da página em vez de mostrar o topo, e junto com a rolagem externa gera um avanço de uma página por ciclo.
3. **Com `manualWindowMs > 0` a detecção fica permissiva demais.** Qualquer troca de página sem intenção do usuário é tratada como salto, mesmo fora do topo (linha 726).

---

## 6. Diagnóstico do ciclo em modo Wrapped (log enviado com PDF++)

- Em InPage o problema não ocorre; em Wrapped ocorre por volta da página 47.
- Padrão no log: após `JUMP`/`FREEZE_START`, há cascata de `RETARGET` e `APPLY` entre páginas vizinhas (42→41→40→…→36→37→…), seguida de `DESVIO` com `frac=1, left=0`.
- Causa provável: `applySnap` define `scrollTop`; o PDF++ em Wrapped reage trocando de página; `onScroll` lê essa troca como nova página-alvo e chama `RETARGET`, que reaplica o freeze e dispara a próxima troca. Nada limitava esse ciclo (o `DESVIO` já tinha teto de 4).
- Tentativa revertida: limitar `RETARGET` a 3 por freeze. O log de teste mostrou que isso encerra o freeze no meio da cascata (ex.: 45→41) e deixa a página num estado inconsistente; o InPage também quebrou depois dessa mudança. Removidos o limite e o teste correspondente.
- Evidência do log de 2026-11-05 (17:11–17:12 UTC): `APPLY` com `top` calculado para a página N cai no topo da página N-1 (`ANOMALIA got page 43 frac 0` quando esperado `44 frac 0.096`). Ou seja, a posição aplicada não bate com o layout que o PDF++ de fato usa, então cada aplicação gera outra troca de página.
- Ainda não confirmado: causa dessa diferença entre `targetTop` e o layout real (candidatos: altura de página/gap usados no cálculo, ou layout virtualizado do wrapped aplicado depois do `scrollTop`). Precisa de log de `pageH`/gap real e de `getBoundingClientRect` da página alvo logo após o `APPLY`.
- Ainda não confirmado: por que `state.wrapped` fica nulo em Wrapped, o que permite o `JUMP`.
- Log de 2026-11-05 17:15–17:18 UTC (após a decisão "restore"): a cascata de `RETARGET` sem nenhum `INTENT` apareceu na sequência `45→44→43→42→41` e `39→38→37→36→35`, com `top=456` e `left` fixo. Ou seja, o PDF++ troca de página sozinho ao receber o `scrollTop` e o plugin seguia essa troca.

## 7. Decisão de comportamento durante o freeze

- Escolhida pelo usuário: **restore**. Se o PDF++ troca de página durante o freeze sem ação do usuário, o plugin registra `RESTORE` e reaplica a página congelada, sem mudar `freeze.page` e sem estender o freeze. O ciclo termina pelo timer `FREEZE_MS`.
- Teste correspondente: "troca de página sem ação do usuário durante o freeze restaura a página congelada" em `.tests/log.test.js`.

## 8. Próximos passos sugeridos

1. Pedir um novo log em Wrapped com esta versão e verificar se a cascata de `RETARGET` sumiu e se `RESTORE` aparece no ponto do salto para a borda.
2. Confirmar H1: verificar se `pagechanging` aparece em um salto explícito pelo menu "ir para página" e por que `state.wrapped` fica nulo.
3. Medir `clientHeight` e `scrollWidth`/`clientWidth` no momento do ciclo para verificar H4, e comparar `targetTop` com o `getBoundingClientRect` real logo após o `APPLY`.
4. Se o `RESTORE` deixar a página presa em trocas legítimas feitas pelo PDF++, reavaliar a regra.

## 9. Correção do ciclo de realimentação (log 17:31–17:34 UTC)

Causa observada: `captureSnap` fabricava `página+1, frac 0` quando a página não estava no DOM, e o scroll causado por `applySnap` era lido como novo `JUMP`, o que realimentava a cascata.

Mudanças:
- `captureSnap` retorna `null` nesse caso, em vez de inventar a página seguinte; quem chama mantém o snap anterior.
- `applySnap` marca `state.selfScrollUntil` (janela `SELF_SCROLL_MS = 250`). Durante essa janela, troca de página sem `INTENT` não gera `JUMP`.

Pendente: validar em Obsidian com um novo log; os testes do harness não reproduzem a reação real do PDF++.
