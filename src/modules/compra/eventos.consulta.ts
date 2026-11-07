import { Prisma } from '@prisma/client';
import { criarResumoEventosDesc } from './eventos.engine.js';

/** Bounded batch counterpart for existing in-memory historical engines. */
export async function comprasRestritasNoPeriodo(tx: Prisma.TransactionClient, userId: number, inicio: Date, fim: Date) {
  const events = await tx.tb_compra_evento.findMany({
    where: { usuario_id: userId, tipo: { in: ['OCULTACAO', 'CANCELAMENTO'] },
      compra: { usuario_id: userId, compra_ativo: 1, compra_status: 'CONFIRMADA', compra_horario: { gte: inicio, lt: fim } } },
    orderBy: { revisao: 'desc' },
    select: { compra_id: true, evento_id: true, compra_item_id: true, tipo: true,
      dados: true, corrige_evento_id: true, anulado: true, revisao: true, efetiva_em: true },
  });
  const summaries = new Map<number, ReturnType<typeof criarResumoEventosDesc>>();
  for (const event of events) {
    let summary = summaries.get(event.compra_id);
    if (!summary) { summary = criarResumoEventosDesc(); summaries.set(event.compra_id, summary); }
    summary.adicionar(event);
  }
  return new Set([...summaries].filter(([, value]) => {
    const summary = value.resultado();
    return summary.oculto || summary.itensOcultos.length > 0 || summary.cancelamentos > 0;
  }).map(([id]) => id));
}

/** SQL counterpart of eventosVigentes/resumirEventos. Corrections invalidate the
 * target even when the correction is annulled. Latest OCULTACAO wins per scope.
 * Reused by aggregate reads; no writes or assessment execution. */
export function comprasElegiveisAgregadoSql(usuarioId:number,inicio:Date|null,fim:Date,janelas?:{inicio:Date;fim:Date}[],incluirRecorrencia=false) {
  return Prisma.sql`
    candidatas AS MATERIALIZED (
      SELECT p.compra_id,p.compra_horario,p.compra_valor,
        CASE WHEN p.compra_classificacao::text='NAO IMPULSIVA' THEN 'NAO_IMPULSIVA'
          ELSE p.compra_classificacao::text END AS compra_classificacao${incluirRecorrencia ? Prisma.sql`,p.compra_recorrencia_id` : Prisma.empty}
      FROM public.tb_compra p
      WHERE p.usuario_id=${usuarioId} AND p.compra_ativo=1 AND p.compra_status='CONFIRMADA'
        ${inicio ? Prisma.sql`AND p.compra_horario>=${inicio}` : Prisma.empty}
        AND p.compra_horario<${fim}
        ${janelas ? Prisma.sql`AND (${Prisma.join(janelas.map(j=>Prisma.sql`(p.compra_horario>=${j.inicio} AND p.compra_horario<${j.fim})`),' OR ')})` : Prisma.empty}
    ), eventos_vigentes AS MATERIALIZED (
      SELECT e.compra_id,e.compra_item_id,e.revisao,e.tipo,e.dados FROM public.tb_compra_evento e JOIN candidatas p ON p.compra_id=e.compra_id
      WHERE e.usuario_id=${usuarioId} AND e.tipo IN ('OCULTACAO','CANCELAMENTO') AND NOT e.anulado AND NOT EXISTS (
        SELECT 1 FROM public.tb_compra_evento c WHERE c.compra_id=e.compra_id
          AND c.usuario_id=${usuarioId} AND c.corrige_evento_id=e.evento_id
      )
    ), ocultacoes AS (
      SELECT DISTINCT ON (compra_id,compra_item_id) compra_id,compra_item_id,dados
      FROM eventos_vigentes WHERE tipo='OCULTACAO'
      ORDER BY compra_id,compra_item_id,revisao DESC
    ), elegiveis AS MATERIALIZED (
      SELECT p.* FROM candidatas p WHERE NOT EXISTS (
        SELECT 1 FROM ocultacoes o WHERE o.compra_id=p.compra_id AND o.dados->'oculto'='true'::jsonb
      ) AND NOT EXISTS (
        SELECT 1 FROM eventos_vigentes e WHERE e.compra_id=p.compra_id AND e.tipo='CANCELAMENTO'
      )
    )`;
}

export type ClassificacaoAgregada = {
  periodo:string;compra_classificacao:'PENDENTE'|'IMPULSIVA'|'NAO_IMPULSIVA';
  quantidade:number;quantidade_com_valor:number;valor_total_centavos:number|null;
};
/** Existing Dashboard contract, with the same visibility universe as Panorama. */
export function classificacoesAgregadoSql(userId:number,janelas:{inicio:Date;fim:Date}[]) {
  if(!janelas.length)throw Error('CLASSIFICATION_WINDOW_REQUIRED');
  const inicio=new Date(Math.min(...janelas.map(j=>j.inicio.getTime())));
  const fim=new Date(Math.max(...janelas.map(j=>j.fim.getTime())));
  return Prisma.sql`WITH ${comprasElegiveisAgregadoSql(userId,inicio,fim,janelas)}
    SELECT to_char((compra_horario AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS periodo,
      compra_classificacao::text AS compra_classificacao,count(*)::int AS quantidade,
      count(compra_valor)::int AS quantidade_com_valor,
      (sum(round(compra_valor*100)))::double precision AS valor_total_centavos
    FROM elegiveis GROUP BY periodo,compra_classificacao ORDER BY periodo,compra_classificacao`;
}
