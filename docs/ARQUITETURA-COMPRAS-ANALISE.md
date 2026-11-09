# Arquitetura de compras e análise comportamental

## Responsabilidades

- `src/modules/compra` é o domínio transacional de compras. Ele cria, confirma, altera e exclui compras e mantém o estado atual da classificação.
- `src/modules/compra/eventos.ledger.ts` é o único ponto de escrita do histórico de eventos e das classificações históricas. As operações são executadas na mesma transação da alteração da compra e bloqueiam a linha da compra antes de validar o saldo.
- `src/modules/analise` contém a leitura e a interpretação do comportamento de consumo: regras temporais, histórico, indicadores e análise automática. Ele não altera compras.
- `src/modules/dashboard`, `src/modules/home` e `src/modules/chat` consomem serviços de indicadores, histórico e recomendações; não reimplementam cálculos financeiros.
- `src/modules/referencia` mantém referências financeiras e seu histórico de alterações, usando o mesmo período de negócio de São Paulo adotado pelos indicadores.

## Fonte de verdade

O estado atual da compra permanece em `tb_compra.compra_classificacao`. O ledger `tb_compra_evento` é a fonte do histórico. Ao consultar o histórico, a classificação do evento é usada; o campo materializado da compra é usado apenas como fallback para compras sem evento histórico, preservando dados anteriores à adoção do ledger.

Não há seleção dinâmica entre tabelas nem fallback para uma implementação legada. Novas alterações de compra devem passar pelo serviço transacional de compras e pelo ledger canônico.

## Modelos Prisma

Os modelos de aplicação usam nomes sem referência ao requisito:

- `contexto_compra_revisao` → `tb_compra_contexto_revisao`
- `contexto_compra_item` → `tb_compra_item_contexto`
- `avaliacao_compra` → `tb_compra_avaliacao`

Os nomes físicos representam as entidades de compra; os nomes antigos das pastas de migration permanecem como histórico imutável. A renomeação física é executada exclusivamente pelo script manual documentado em `docs/RF018-RENOMEACAO-TABELAS.md`.

## Datas

Instantes continuam sendo armazenados como `timestamptz`/`Date`. Períodos civis de negócio são calculados em `America/Sao_Paulo` e convertidos para instantes UTC nas consultas. A mesma regra é usada pelo dashboard, histórico e análise automática.

## Implantação da evolução de contexto

1. Confirmar backup, banco de destino, contagens e ausência das tabelas de destino.
2. Publicar o backend compatível com `tb_compra_contexto_revisao`, `tb_compra_item_contexto` e `tb_compra_avaliacao`.
3. Executar o script SQL manual em janela coordenada com a publicação.
4. Executar o script de verificação e manter o rollback disponível até a validação da API.

Nenhuma etapa usa `db push`, `db pull`, `migrate deploy` ou migration histórica. A divergência conhecida do histórico Prisma deve ser reconciliada em trabalho próprio; ela não altera o escopo desta renomeação manual.
