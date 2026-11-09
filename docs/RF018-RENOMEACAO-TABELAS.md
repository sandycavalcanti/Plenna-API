# Renomeação física das tabelas de compras RF018

Esta alteração renomeia somente as três tabelas existentes no schema `public`. Ela não altera modelos Prisma lógicos, colunas, registros, relacionamentos, índices, constraints ou migrations históricas.

| Antes | Depois | Modelo Prisma |
|---|---|---|
| `tb_rf018_contexto_revisao` | `tb_compra_contexto_revisao` | `contexto_compra_revisao` |
| `tb_rf018_item_contexto` | `tb_compra_item_contexto` | `contexto_compra_item` |
| `tb_rf018_avaliacao` | `tb_compra_avaliacao` | `avaliacao_compra` |

## Aplicação coordenada

1. Confirmar que o banco é `neondb`, que há backup recuperável e que as contagens atuais continuam em `40`, `37` e `32`.
2. Confirmar que as três tabelas novas não existem.
3. Publicar o backend compatível com os novos `@@map` e com o SQL do panorama.
4. Executar `prisma/manual/rename_rf018_tables.sql` na mesma janela coordenada.
5. Executar `prisma/manual/verify_rf018_table_rename.sql`.
6. Manter `prisma/manual/rollback_rf018_tables.sql` disponível até validar os endpoints de contexto, avaliação e panorama.

O backend antigo não deve permanecer ativo após o rename, porque ainda consulta os nomes físicos antigos.

## Preservação

O SQL usa apenas `ALTER TABLE ... RENAME TO`, dentro de transação. Não há `DROP TABLE`, `CREATE TABLE`, cópia de dados ou alteração de `_prisma_migrations`. PostgreSQL mantém as dependências por identidade dos objetos; os nomes internos de índices, constraints e sequences não são padronizados nesta etapa.

## Limitação conhecida

O histórico `_prisma_migrations` do Neon diverge das migrations presentes neste checkout. Essa divergência foi registrada, mas não é alterada por estes scripts. A reconciliação deve ser tratada separadamente antes de qualquer fluxo futuro baseado em Prisma Migrate.
