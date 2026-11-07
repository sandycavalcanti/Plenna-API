# Contrato do Cofrinho de Metas

Este documento congela o contrato compartilhado entre a API e o mobile. A
migration do cofrinho foi aplicada ao banco remoto e as rotas transacionais e
de consulta abaixo usam o mesmo contrato monetário.

## Unidade monetária

Todos os valores de metas, reservas e movimentações representam reais, com
duas casas decimais. O PostgreSQL persiste `NUMERIC(10,2)` nessa unidade; a
API serializa respostas monetárias como texto canônico (`"500.00"`). Criação e
edição aceitam número ou texto decimal com ponto, sem conversão implícita por
100. A entrada brasileira é normalizada somente no cliente para o mesmo valor
real (`R$ 500,00` → `500.00`).

## Rotas

As rotas canônicas autenticadas são:

```text
GET    /metas
POST   /metas
PUT    /metas/check
PUT    /metas/:id
DELETE /metas/:id
POST   /metas/:id/movimentacoes
GET    /metas/:id/movimentacoes
```

Não existe rota alternativa para o módulo. Clientes devem usar exclusivamente
`/metas`.

## Movimentação

`POST /metas/:id/movimentacoes` recebe:

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

Em um replay idêntico, a API retorna a movimentação persistida originalmente e
o resumo corrente sem criar outro histórico nem reaplicar o saldo. Reutilizar
a mesma chave com tipo ou valor diferente retorna `409`.

Erros previstos: `400` dados inválidos; `401` autenticação inválida; `404`
meta inexistente ou fora do usuário autenticado; `409` UUID reutilizado com
payload diferente; `422` retirada acima do saldo ou capacidade excedida; `500`
falha interna sanitizada.

## Histórico e progresso

`GET /metas/:id/movimentacoes?limit=20&cursor=...` retorna os movimentos mais
recentes primeiro, com cursor opaco e `limit` entre 1 e 100.

`GET /metas` mantém os campos legados e adiciona
`meta_valor_reservado`, `progresso_percentual`, `valor_restante`,
`ultima_movimentacao` e `ultimo_deposito`. O progresso pode superar 100%; o
valor restante é limitado a zero. `meta_completado` continua explícito e não é
alterado automaticamente por depósitos.

## Análise para a IA

As tools somente leitura `listar_metas` e `analisar_metas` consultam dados do
usuário autenticado. Nenhuma tool de escrita é criada. Valores monetários
seguem a unidade real do contrato da API.

`analisar_metas` informa o fuso `America/Sao_Paulo`, cobertura, limitações,
valores reservados, progresso, períodos mensais, comparações e movimentações.
`saldo_atual_reservado`/`valor_reservado` representam o saldo atual da meta;
`saldo_liquido_no_periodo` representa somente o fluxo do período.

## Compatibilidade

As tabelas `tb_meta` e `tb_meta_movimentacao`, colunas, IDs e migrations não
são renomeados. A chave ativa de operações pendentes do AsyncStorage também
permanece inalterada para preservar retries existentes. Reservas não são
compras, despesas, saldo bancário ou dados de dashboard.
