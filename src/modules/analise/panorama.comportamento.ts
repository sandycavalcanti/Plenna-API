import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { comparacaoTemporal } from './politica-temporal.js';
import { resumirValoresHistoricos } from './historico.engine.js';
import type { snapshot } from './historico.service.js';
import type { periodoPanorama } from './panorama.schemas.js';

type Periodo = ReturnType<typeof periodoPanorama>['periodo'];
type Historico = Pick<Awaited<ReturnType<typeof snapshot>>, 'fontes' | 'historico' | 'compras'>;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const signed = z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const janela = z.object({ inicio: z.string().datetime(), fimExclusivo: z.string().datetime() }).strict()
  .refine(j => Date.parse(j.inicio) < Date.parse(j.fimExclusivo));
const par = z.object({ atual: count, anterior: count, diferenca: signed.int() }).strict()
  .refine(v => v.diferenca === v.atual - v.anterior);
// The median of integer-cent amounts can contain half a cent. Never round it
// into a different median; it is a per-purchase statistic, not monthly spending.
const mediana = z.object({ atual: signed.nonnegative().multipleOf(0.5), anterior: signed.nonnegative().multipleOf(0.5), diferenca: signed.multipleOf(0.5) }).strict()
  .refine(v => v.diferenca === v.atual - v.anterior);
export const recorrenciasPanoramaSchema = z.object({
  origem: z.literal('VINCULOS_REGISTRADOS'), comprasVinculadas: count, vinculosDistintos: count,
  cobertura: z.literal('REGISTROS_DISPONIVEIS'),
}).strict().refine(v => v.vinculosDistintos <= v.comprasVinculadas && (v.comprasVinculadas === 0) === (v.vinculosDistintos === 0));
export const comportamentoPanoramaSchema = z.object({
  versaoContrato: z.literal(1), recorrencias: recorrenciasPanoramaSchema,
  comparacao: z.object({ disponibilidade: z.enum(['DISPONIVEL', 'INDISPONIVEL']), motivos: z.array(z.string()).max(8),
    atual: janela.nullable(), anterior: janela.nullable(), frequencia: par.nullable(), medianaCentavos: mediana.nullable(),
  }).strict(), limitacoes: z.array(z.string()).max(8),
}).strict().superRefine((v, ctx) => {
  const c = v.comparacao;
  if ((c.atual === null) !== (c.anterior === null) ||
    c.atual && c.anterior && (Date.parse(c.atual.fimExclusivo) - Date.parse(c.atual.inicio) !== Date.parse(c.anterior.fimExclusivo) - Date.parse(c.anterior.inicio) || Date.parse(c.anterior.fimExclusivo) > Date.parse(c.atual.inicio)) ||
    c.disponibilidade === 'INDISPONIVEL' && (!c.motivos.length || c.frequencia !== null || c.medianaCentavos !== null) ||
    c.disponibilidade === 'DISPONIVEL' && (!c.atual || !c.anterior || !c.frequencia || c.medianaCentavos === null && !c.motivos.length))
    ctx.addIssue({ code: 'custom', message: 'Comparação sem condições equivalentes comprovadas' });
});
export type ComportamentoPanoramaV1 = z.infer<typeof comportamentoPanoramaSchema>;

/** Subquery over the Panorama's already-materialized eligible universe. Uses
 * only the purchase-level link also used by historico.engine; no inference. */
export function recorrenciasPanoramaSql(userId: number) {
  return Prisma.sql`SELECT jsonb_build_object(
    'origem','VINCULOS_REGISTRADOS','comprasVinculadas',count(*)::int,
    'vinculosDistintos',count(DISTINCT r.compra_recorrencia_id)::int,'cobertura','REGISTROS_DISPONIVEIS')
    FROM elegiveis e JOIN public.tb_compra_recorrencia r
      ON r.compra_recorrencia_id=e.compra_recorrencia_id AND r.usuario_id=${userId}`;
}

export function compararHistoricoPanorama(periodo: Periodo, leitura?: Historico): ComportamentoPanoramaV1['comparacao'] {
  const indisponivel = (motivo: string): ComportamentoPanoramaV1['comparacao'] => ({
    disponibilidade: 'INDISPONIVEL', motivos: [motivo], atual: null, anterior: null, frequencia: null, medianaCentavos: null,
  });
  if (periodo.modo !== 'MES') return indisponivel('COMPARACAO_APENAS_PARA_MES');
  // The current purchase adapter explicitly declares DESCONHECIDA. Do not load
  // rows merely to rediscover that fact, or infer coverage from account age.
  if (!leitura) return indisponivel(comparacaoTemporal(Date.parse(periodo.observadoAte) - Date.parse(periodo.inicio!), 'DESCONHECIDA').motivo!);
  const { historico: h, fontes, compras } = leitura;
  const f = h.frequencia.comparacao;
  const duration = Date.parse(f.fimAtualExclusivo) - Date.parse(f.inicioAtual);
  const policy = comparacaoTemporal(duration, fontes.cobertura === 'COMPLETA' ? h.qualidade.cobertura : fontes.cobertura);
  if (!policy.elegivel) return indisponivel(policy.motivo!);
  if (h.periodo !== periodo.mes || f.disponibilidade !== 'DISPONIVEL' || !h.politicaTemporal.comparacaoElegivel ||
    Date.parse(f.inicioAtual) !== Date.parse(periodo.inicio!) || Date.parse(f.fimAtualExclusivo) > Date.parse(periodo.observadoAte) ||
    duration !== Date.parse(f.fimAnteriorExclusivo) - Date.parse(f.inicioAnterior) || Date.parse(f.fimAnteriorExclusivo) > Date.parse(f.inicioAtual))
    return indisponivel('JANELAS_NAO_EQUIVALENTES');
  const between = (inicio: string, fim: string) => compras.filter(p => p.data !== null && Date.parse(p.data) >= Date.parse(inicio) && Date.parse(p.data) < Date.parse(fim));
  const current = between(f.inicioAtual, f.fimAtualExclusivo), previous = between(f.inicioAnterior, f.fimAnteriorExclusivo);
  if (current.length !== f.comprasAtual || previous.length !== f.comprasAnterior) return indisponivel('FONTES_HISTORICAS_INCONSISTENTES');
  const a = resumirValoresHistoricos(current), b = resumirValoresHistoricos(previous);
  const financial = b.amostra >= h.valores.minimoAmostraHistorica && a.amostra > 0 && !a.semValor && !b.semValor;
  return { disponibilidade: 'DISPONIVEL', motivos: financial ? [] : ['HISTORICO_OU_VALORES_INSUFICIENTES'],
    atual: { inicio: f.inicioAtual, fimExclusivo: f.fimAtualExclusivo }, anterior: { inicio: f.inicioAnterior, fimExclusivo: f.fimAnteriorExclusivo },
    frequencia: { atual: f.comprasAtual, anterior: f.comprasAnterior, diferenca: f.comprasAtual - f.comprasAnterior },
    medianaCentavos: financial ? { atual: a.medianaCentavos!, anterior: b.medianaCentavos!, diferenca: a.medianaCentavos! - b.medianaCentavos! } : null,
  };
}

export function apresentarComportamentoPanorama(raw: unknown, periodo: Periodo, universo: number, leitura?: Historico): ComportamentoPanoramaV1 {
  const recorrencias = recorrenciasPanoramaSchema.parse(raw);
  if (recorrencias.comprasVinculadas > universo) throw Error('PANORAMA_RECURRENCE_UNIVERSE_INVALID');
  const comparacao = compararHistoricoPanorama(periodo, leitura);
  if (comparacao.frequencia && comparacao.frequencia.atual > universo) throw Error('PANORAMA_COMPARISON_UNIVERSE_INVALID');
  return comportamentoPanoramaSchema.parse({ versaoContrato: 1, recorrencias, comparacao,
    limitacoes: ['Vínculos registrados na compra; não comprovam assinatura, periodicidade ou recorrência inferida.',
      'Comparações exigem janelas equivalentes e cobertura completa comprovada.',
      'Mediana em centavos do valor registrado por compra, sem transformar eventos posteriores em gasto final.'],
  });
}
