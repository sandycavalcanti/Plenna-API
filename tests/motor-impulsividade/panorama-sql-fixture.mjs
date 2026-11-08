import { PGlite } from '@electric-sql/pglite';

// Existing transitive test tooling. Read-only VALUES/recordset sources; no DDL,
// migrations, persistent database, network or production application startup.
const sources = {
  tb_compra: ['compras','compra_id int,usuario_id int,compra_ativo int,compra_status text,compra_horario timestamp,compra_valor numeric,compra_classificacao text,compra_recorrencia_id int'],
  tb_compra_evento: ['eventos','evento_id int,compra_id int,usuario_id int,compra_item_id int,revisao int,tipo text,dados jsonb,corrige_evento_id int,anulado boolean'],
  tb_rf018_contexto_revisao: ['contextos','contexto_id int,compra_id int,usuario_id int,revisao int,respostas jsonb'],
  tb_rf018_item_contexto: ['contextoItens','contexto_id int,compra_id int,compra_item_id int,planejamento text'],
  tb_compra_item: ['itens','compra_item_id int,compra_id int,compra_item_ativo int,categoria_id int'],
  tb_categoria: ['categorias','categoria_id int,categoria_nome text'],
  tb_compra_recorrencia: ['recorrencias','compra_recorrencia_id int,usuario_id int'],
};
export function criarFixturePanoramaSql() {
  const pg = new PGlite();
  return {
    async executar(query, fixtures) {
      const values = query.values.map(v => v instanceof Date ? v.toISOString() : v);
      let sql = query.text;
      const ctes = Object.entries(sources).filter(([table]) => sql.includes(`public.${table} `)).map(([table,[key,columns]]) => {
        sql = sql.replaceAll(`public.${table} `, `fixture_${key} `);
        values.push(JSON.stringify(fixtures[key] ?? []));
        return `fixture_${key} AS (SELECT * FROM jsonb_to_recordset($${values.length}::jsonb) AS f(${columns}))`;
      });
      return (await pg.query(`WITH ${ctes.join(',')}, ${sql.replace(/^WITH /,'')}`, values)).rows;
    },
    close: () => pg.close(),
  };
}
