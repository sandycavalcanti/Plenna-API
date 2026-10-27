# RF018 — guia técnico para desenvolvedores

## Objetivo e base

Identificar e explicar sinais nos registros disponíveis, sem diagnosticar impulsividade, atribuir um escore comportamental ou classificar compras automaticamente. A branch parte de `origin/develop` (`e8b885d`). OAuth, recorrências, dashboard financeiro e configurações dessa base são preservados.

## Arquitetura e responsabilidades

Os arquivos abaixo ficam em `src/modules/rf018/`:

| Camada | Arquivos | Responsabilidade |
|---|---|---|
| Análise anterior | `rf018.engine.ts`, `rf018.indicators.ts`, `rf018.service.ts` | Preservar contratos existentes de análise por período/compra |
| Contexto | `contexto.schemas.ts`, `contexto.service.ts`, `perguntas.ts` | Validar declarações opcionais, selecionar perguntas e persistir revisões |
| Interpretação | `interpretacao.engine.ts`, `avaliacao.service.ts` | Produzir reflexões contextualizadas e guardar avaliações versionadas |
| Histórico | `historico.schemas.ts`, `historico.engine.ts`, `historico.service.ts`, `historico.reflexoes.ts` | Consultar fontes e produzir comparações e reflexões descritivas |
| Motor automático | `automatico.engine.ts`, `automatico.service.ts` | Combinar evidências sem depender do questionário |
| Descobertas | `descobertas.engine.ts`, `descobertas.resumo.ts`, `descobertas.service.ts` | Selecionar achados e apresentar resumos agregados |
| Fontes opcionais | `monitoramento.service.ts`, `temporal.policy.ts` | Aplicar consentimento, cobertura e limites temporais |

Os motores recebem snapshots explícitos e não gravam classificações. Os serviços concentram ownership, transações, leitura das fontes e persistência. As rotas ficam em `rf018.routes.ts`, `contexto.routes.ts` e `src/modules/compra/eventos.routes.ts`; o registro dos routers está em `src/app.ts`.

## Indicadores automáticos e combinação de evidências

`automatico.engine.ts` usa o histórico elegível do próprio usuário: compras ativas e confirmadas, valores conhecidos e datas aceitas pela política temporal. Compras de outros usuários, inativas, futuras ou sem precisão adequada não sustentam a comparação.

O motor existente utiliza faixa interquartil para valores e concentração de registros, além de comparação de frequência quando há cobertura e janelas equivalentes. `faixaValores`, em `descobertas.engine.ts`, exige ao menos quatro valores e intervalo interquartil positivo. A faixa superior é `Q3 + 1,5 × (Q3 − Q1)`. Não se alterou o algoritmo nesta organização da branch.

Um recorte por categoria continua na família de valores: não é contado como uma segunda família independente. A combinação de famílias não equivale a diagnóstico. O contrato explicita `classificacaoAutomaticaDefinitiva: false` e `persistido: false`.

Mediana descritiva, referência atual e destaque de faixa são conceitos diferentes. Ausência de valor não se transforma em zero. Ausência de monitoramento também não representa tempo de uso zero.

## Descobertas e reflexões

`descobertas.engine.ts` seleciona até três tópicos fundamentados, evitando repetir a mesma família de observações. Não há obrigação de preencher os três espaços. Declarações, dados registrados e referências financeiras permanecem identificados separadamente.

`interpretacao.engine.ts` seleciona um tema fundamentado nas respostas para a reflexão contextual. Recusas, “não lembro” e respostas ausentes não viram negativas. As declarações completas continuam nas evidências; autopercepção isolada não substitui análise automática.

`descobertas.service.ts` fornece o resumo para Home, Dashboard e chatbot sem expor nomes de itens, estabelecimentos ou identificadores privados no contrato agregado. Não existe histórico persistente de descobertas já vistas entre sessões.

## Respostas contextuais e histórico de revisões

As perguntas são opcionais e adaptativas. Planejamento de itens, influência promocional, necessidade inesperada, momento e autopercepção são declarações do usuário. Não se inferem respostas de um valor financeiro ou do uso de aplicativos.

`ContextoService` bloqueia a linha da compra na escrita, exige revisão esperada e usa UUID/hash para reconhecer reenvios. Operação repetida com conteúdo diferente gera conflito. O PATCH esparso preserva os campos não enviados. A chave interna definida em `eventos.schemas.ts` guarda declarações de eventos posteriores sem apresentá-las como respostas às perguntas.

`GET /v2/compras/:compraId/contexto/historico` oferece até 50 revisões por página, em ordem decrescente, com cursor `antes`/`proximaAntes`. A leitura histórica preserva respostas de itens posteriormente desativados; a leitura atual filtra itens ativos. Compras logicamente excluídas continuam sujeitas ao ownership na consulta histórica.

## Avaliações versionadas

`avaliacao.service.ts` persiste snapshot das fontes, versão do motor, hash e resultado. A deduplicação inclui compra, versão e hash. Uma avaliação antiga continua consultável por ID e não é sobrescrita ao recalcular a atual. A versão contextual atual é `contextual-2`; resultados `contextual-1` continuam legíveis.

Mudança de respostas ou das fontes individuais pode tornar a avaliação anterior desatualizada. As descobertas históricas consultadas ao vivo são um complemento e não reescrevem avaliações persistidas.

## Classificação voluntária e gerenciamento de compras

Os serviços ficam em `src/modules/compra/`:

- `eventos.schemas.ts` e `eventos.engine.ts`: contratos e regras puras.
- `eventos.service.ts`: ownership, revisão, idempotência e escrita transacional.
- `eventos.legado.ts`: integração com atualização/exclusão já existentes em `compra.service.ts`.
- `eventos.resumo.ts`: agregação de eventos com referências temporais explícitas.

Classificação voluntária é um evento versionado e atualiza o campo legado para compatibilidade. “Prefiro não classificar” não vira conclusão automática. A interface Mobile identifica o rótulo como “Sua classificação”.

Ocultar uma compra ou item altera sua apresentação, preservando sua participação nos cálculos. Exclusão por motivo declarado desativa o registro. A exclusão do último item segue a política de exclusão da compra e recalcula os totais dentro da transação.

Cancelamento, devolução e reembolso são eventos distintos. Cancelar ou devolver não comprova restituição. Correções/anulações mantêm os registros anteriores e retiram seu efeito vigente. Os serviços verificam limites de reembolso e compatibilidade com edição/exclusão de itens.

## Referências e impactos financeiros

`referencias.service.ts` e `referencias.legado.ts` registram referências financeiras a partir de mudanças observadas ou declaradas. Os pontos de integração são `src/modules/preferencia/preferencia.service.ts` e `src/modules/user/user.service.ts`.

Uma referência atual não comprova seu valor no passado. Com precisão apenas de dia, uma mudança ocorrida no mesmo dia impede afirmar a ordem temporal. O valor original da compra e o saldo após reembolsos conhecidos são apresentados separadamente. Os totais não constituem extrato bancário conciliado.

## Datas, recorrências e monitoramento

`temporal.policy.ts` evita transformar meses sem registros em meses de consumo zero. Mês parcial só é comparado com janela equivalente quando os dados permitem. Data de e-mail não comprova o instante efetivo da transação.

Recorrência exige vínculo cadastrado real. O RF018 consome o módulo de recorrências já presente na `develop`; repetição de categoria não cria esse vínculo. As migrations e regras de recorrência da base não são substituídas.

`monitoramento.service.ts` consulta registros Android autorizados em leitura separada. Exige consentimento vigente, rejeita fotografias inválidas/sobrepostas e não infere sessões ou associação causal entre uso e compra. Falha dessa fonte opcional não invalida a análise financeira.

## Endpoints principais

Todas as rotas exigem autenticação; consultas por compra verificam ownership.

| Método e caminho | Uso |
|---|---|
| `GET /analises/comportamento` | Contrato anterior de análise por período |
| `GET /analises/historico` | Histórico agregado |
| `GET /analises/descobertas` | Resumo para Home, Dashboard e chatbot |
| `GET /analises/compras/:compraId/automatica` | Análise automática individual |
| `GET /v2/compras/:compraId/perguntas` | Convites contextuais |
| `GET/PATCH /v2/compras/:compraId/contexto` | Consulta e revisão das respostas |
| `GET /v2/compras/:compraId/contexto/historico` | Revisões anteriores paginadas |
| `GET /v2/compras/:compraId/indicadores-historicos` | Complemento histórico individual |
| `POST /v2/compras/:compraId/avaliacoes` | Calcular avaliação contextual |
| `GET /v2/compras/:compraId/avaliacoes/atual` | Avaliação contextual atual |
| `GET /v2/compras/:compraId/avaliacoes/:avaliacaoId` | Avaliação persistida por ID |
| `GET/POST /v2/compras/:compraId/eventos` | Histórico e registro de operações |
| `GET /v2/compras/resumos` | Resumos de até 100 compras por consulta |
| `GET /v2/compras/:compraId/referencias` | Referências atual/histórica |
| `POST /v2/compras/referencias` | Registrar uma referência financeira |

Consultas privadas usam `Cache-Control: no-store`. Revisões divergentes, operação idempotente reutilizada com outro conteúdo e inconsistências financeiras são recusadas. IDs das novas rotas respeitam o limite INTEGER do banco antes da consulta de compras/eventos.

## Banco e migrations

O schema acrescenta `tb_rf018_contexto_revisao`, `tb_rf018_item_contexto`, `tb_rf018_avaliacao`, `tb_compra_evento` e `tb_referencia_financeira`, além de relações e índices compostos para o vínculo entre compra, usuário e item.

Migrations transportadas:

1. `prisma/migrations/20261024120000_rf018_contexto_revisoes/migration.sql`.
2. `prisma/migrations/20261024140000_rf018_avaliacao/migration.sql`.
3. `prisma/migrations/20261025120000_gestao_eventos_referencias/migration.sql`.

As migrations antigas da `develop`, incluindo OAuth e recorrências, permanecem intactas. Esta publicação de código não aplica migrations no Neon e não realiza deploy. Antes de um futuro deploy, o responsável deverá reconciliar o histórico de migrations do ambiente; a existência das tabelas, isoladamente, não comprova que uma migration pode ser reaplicada.

## Integração Mobile e chatbot

No repositório Mobile, os clientes ficam em `src/services/`: `contextoCompraService.js`, `avaliacaoCompraService.js`, `historicoCompraService.js`, `analiseAutomaticaService.js`, `gestaoCompraService.js` e `resumosCompras.js`. Eles verificam sessão, contrato e identidade da compra, rejeitam respostas atrasadas e mantêm as operações incertas apenas em memória.

Os componentes ficam em `src/components/PurchaseComponents/`; a entrada protegida está em `src/pages/PurchasesScreen/index.js`. Home e Dashboard recebem somente os acréscimos específicos das descobertas. Configuração de conexão, OAuth, telas de recorrência e coleta Android permanecem na versão da base.

`src/modules/chat/chat.indicadores.ts` reconhece consultas sobre os indicadores e usa `DescobertasService`. O trecho aditivo em `chat.service.ts` mantém persistência de mensagens e ownership já existentes. Outras mensagens continuam no fluxo de provider da base.

## Testes e ferramentas

- `npm run typecheck`: verificação TypeScript.
- `npm run prisma:validate:offline` e `npm run prisma:generate:offline`: validação/geração sem datasource real.
- `npm run test:rf018`: testes específicos com ambiente fictício e bloqueio de rede.
- `npm run test:offline`: regressão completa; continua executando as suítes posteriores após uma falha e retorna código de erro se qualquer suíte falhar.
- `node scripts/gerar-schema-teste-rf018.mjs`: gera SQL sintético sem alterar migrations.
- Com `RF018_MOBILE_ROOT` apontando para a worktree Mobile: `node --import tsx scripts/test-gestao-postgres-local.mjs --motor-automatico` executa o ensaio integrado em cluster novo de loopback e o encerra ao final. Requer os binários locais PostgreSQL 18 no caminho definido no script.

Testes específicos ficam em `tests/rf018/`. Os resultados e as falhas herdadas da base estão em [RF018-VALIDACAO-DA-BRANCH.md](RF018-VALIDACAO-DA-BRANCH.md). Nenhum número de uma execução anterior foi reutilizado como evidência desta branch.

## Limitações conhecidas

Não há KNN, diagnóstico, prova de cobertura integral dos registros, associação de sessões Android a compras ou histórico persistente de achados vistos. Não são reconstruídos classificação inicial, nomes antigos de itens ou orçamento passado sem evidência. TalkBack, biometria física e fluxo completo no dispositivo com backend desta branch continuam exigindo validação manual. A geração TypeScript do Mobile não habilita `checkJs` para toda a aplicação.

A suíte completa da `develop` já contém falhas de OAuth, finanças e testes de interface. Elas são comparadas separadamente no relatório; a aprovação dos testes RF018 não significa aprovação integral da aplicação nem homologação de produção.
