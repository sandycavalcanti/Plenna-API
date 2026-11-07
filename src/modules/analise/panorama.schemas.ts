import { z } from 'zod';
import { historicoComprasQuerySchema } from '../compra/compra.schemas.js';
import { businessDateKey, businessDayBounds, parseMonth } from '../compra/financeiro.js';
import { AppError } from '../../errors/AppError.js';

// Exactly the list's period grammar; paging, search and status are not aggregate filters.
export const panoramaQuerySchema = historicoComprasQuerySchema.safeExtend({
  status: z.never().optional(), antes: z.never().optional(), busca: z.never().optional(),
  detalhes: z.enum(['0','1']).default('0'),
  comportamento: z.literal('1').optional(),
});
export function periodoPanorama(raw: unknown, now = new Date()) {
  const q = panoramaQuerySchema.parse(raw);
  const hoje = businessDateKey(now);
  if (q.mes && q.mes > hoje.slice(0,7) || q.fim && q.fim > hoje)
    throw new AppError('Escolha um período até a data atual',400);
  const bounds = q.mes ? parseMonth(q.mes) : {
    start: q.inicio ? businessDayBounds(new Date(q.inicio+'T12:00:00Z')).start : null,
    end: businessDayBounds(new Date((q.fim ?? hoje)+'T12:00:00Z')).end,
  };
  return {q, periodo:{modo:q.mes?'MES':q.inicio?'INTERVALO':'TODOS',mes:q.mes??null,
    inicio:bounds.start?.toISOString()??null,fimExclusivo:bounds.end.toISOString(),
    observadoAte:new Date(Math.min(bounds.end.getTime(),now.getTime())).toISOString(),timezone:'America/Sao_Paulo' as const}};
}
const n = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const contagemPanoramaSchema = z.object({codigo:z.string(),validos:n,condicao:n}).strict()
  .refine(v=>v.condicao<=v.validos);
export const agregadoPanoramaSchema = z.object({
  universo:n,comContexto:n,comAutopercepcao:n,
  sinais:z.array(contagemPanoramaSchema).max(12),
  relacoes:z.array(contagemPanoramaSchema).max(4),
  categorias:z.array(z.object({nome:z.string(),compras:n}).strict()).max(5),
  diasSemana:z.array(z.object({dia:z.number().int().min(0).max(6),compras:n}).strict()).max(7),
  categoriasValidas:n, valoresValidos:n,totalCentavos:n,
}).strict().refine(v=>v.comAutopercepcao<=v.comContexto && [v.comContexto,v.comAutopercepcao,v.categoriasValidas,v.valoresValidos,
  ...v.sinais.map(s=>s.validos),...v.relacoes.map(s=>s.validos),...v.categorias.map(c=>c.compras)].every(n=>n<=v.universo));
export type AgregadoPanorama = z.infer<typeof agregadoPanoramaSchema>;
