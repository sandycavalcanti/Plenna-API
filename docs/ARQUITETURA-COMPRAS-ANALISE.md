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

- `contexto_compra_revisao` → `tb_rf018_contexto_revisao`
- `contexto_compra_item` → `tb_rf018_item_contexto`
- `avaliacao_compra` → `tb_rf018_avaliacao`

Os nomes físicos são preservados por `@@map` para não alterar dados nem quebrar o histórico de migrations. Os nomes antigos das pastas de migration também permanecem como histórico imutável.

## Datas

Instantes continuam sendo armazenados como `timestamptz`/`Date`. Períodos civis de negócio são calculados em `America/Sao_Paulo` e convertidos para instantes UTC nas consultas. A mesma regra é usada pelo dashboard, histórico e análise automática.

## Implantação da evolução de contexto

1. Aplicar as migrations pendentes, incluindo `20261026100000_consolidate_context_metadata`, em um ambiente controlado.
2. Verificar a existência das tabelas e a conversão de `__rf018_eventos_v1` para `__contexto_eventos_v1` antes de publicar a aplicação.
3. Publicar o backend e o frontend que usam os contratos consolidados.
4. Depois de confirmar que não existem linhas antigas e que não há rollback para uma versão anterior, remover em uma alteração posterior a leitura de `__rf018_eventos_v1` em `contexto-eventos.ts`.

Nenhuma etapa usa `db push`, `db pull` ou alteração física executada por este trabalho. A migration é deliberadamente aditiva e idempotente para permitir execução segura uma única vez no pipeline de banco.
