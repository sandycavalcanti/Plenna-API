# Contrato Fase 1 — Cofrinho de metas

Este documento congela o contrato compartilhado entre a API e o mobile. A
Fase 1 preparou schema, migration e cliente HTTP; a Fase 2 registra as rotas
transacionais e de consulta descritas abaixo. A migration continua pendente de
aplicação controlada no banco remoto.

## Movimentação

`POST /goals/:id/movimentacoes` será autenticado e receberá:

```json
{
  "tipo": "DEPOSITO",
  "valor": "123.45",
  "operacao_id": "00000000-0000-4000-8000-000000000000"
}
```

`tipo` aceita somente `DEPOSITO` ou `RETIRADA`. `valor` é texto decimal
positivo com até duas casas e dentro da capacidade de `NUMERIC(10,2)`. A chave
`operacao_id` é criada uma vez por intenção no mobile e reutilizada em retries.

O retorno previsto contém o movimento confirmado e o resumo atualizado da
meta. Valores monetários novos serão serializados como texto com duas casas.

Erros previstos:

- `400`: body, UUID, tipo ou valor inválido;
- `401`: autenticação ausente ou inválida;
- `404`: meta inexistente ou fora do usuário autenticado;
- `409`: UUID reutilizado com payload diferente;
- `422`: retirada acima do saldo ou saldo acima da capacidade de `NUMERIC(10,2)`;
- `500`: falha interna sanitizada, sem detalhes do banco.

## Histórico

`GET /goals/:id/movimentacoes?limit=20&cursor=...` retornará os movimentos
mais recentes primeiro, ordenados por `meta_movimentacao_data DESC` e
`meta_movimentacao_id DESC`, com `nextCursor` nulo quando não houver próxima
página. `limit` varia de 1 a 100; o cursor é opaco para o mobile.

## Progresso em `GET /goals`

A listagem mantém os campos legados e adiciona `meta_valor_reservado`,
`progresso_percentual`, `valor_restante`, `ultima_movimentacao` e
`ultimo_deposito`. O progresso pode superar 100%; o valor restante é limitado a
zero. `meta_completado` continua explícito e não é alterado automaticamente.

## Compatibilidade

`GET /goals` mantém todos os campos atuais. Campos de progresso serão
adicionados de forma aditiva em etapa posterior. Reservas não são compras,
despesas, saldo bancário ou dados do dashboard de consumo.
