import { z } from 'zod';
import { saidaPeriodoSchema, saidaCompraSchema } from '../rf018/rf018.schemas.js';

const recommendationSchema = z.object({
  codigo: z.enum(['REVISAR_LIMITE_INDIVIDUAL', 'ACOMPANHAR_ORCAMENTO_EXCEDIDO']),
  titulo: z.string(), mensagem: z.string(), prioridade: z.number().int().positive(),
  referencias: z.array(z.string().min(1)).min(1), limitacoes: z.array(z.string()),
}).strict();
export const resultadoRecomendacoesSchema = z.object({
  versaoContrato: z.literal(1), versaoRegras: z.literal('financeiras-1'),
  estado: z.enum(['COM_RECOMENDACOES', 'SEM_RECOMENDACOES_ELEGIVEIS']),
  recomendacoes: z.array(recommendationSchema).max(3), regrasDesativadas: z.array(z.string()),
}).strict();
type Recommendation = z.infer<typeof recommendationSchema>;
const sorted = (values: string[]) => [...new Set(values)].sort();

/** Pure consumer of RF018 v1. Invalid contracts throw; empty success is explicit.
 * No money calculation, behavioral evaluation, clock, I/O or Android dependency.
 */
export function recomendar(raw: unknown) {
  const input = z.union([saidaPeriodoSchema, saidaCompraSchema]).parse(raw);
  const recommendations: Recommendation[] = [];
  const purchaseEvidence = (id: number) => input.evidencias.find(e => e.codigo === `COMPRA_${id}` && e.natureza !== 'DESCONHECIDO' && e.referencias.includes(`compra:${id}`));
  if (input.escopo === 'PERIODO') {
    const { financeiro, orcamento, limiteIndividual } = input.indicadores;
    const budgetEvidence = input.evidencias.find(e => e.codigo === 'ORCAMENTO_MENSAL' && e.natureza === 'DECLARADO' && e.referencias.some(r => r.length > 0));
    const knownEvidence = input.evidencias.filter(e => /^COMPRA_\d+$/.test(e.codigo) && e.natureza !== 'DESCONHECIDO' && e.referencias.some(r => /^compra:\d+$/.test(r)));
    // A proven lower bound above budget remains true with missing values/coverage.
    // State comes from financeiro.ts; do not recompute the financial result here.
    if (financeiro.estadoOrcamento === 'EXCEDIDO' && orcamento.estadoNoUniversoObservado === 'EXCEDIDO' && orcamento.disponibilidade !== 'INDISPONIVEL' && financeiro.orcamentoMensal !== null && financeiro.orcamentoMensal > 0 && financeiro.comprasComValor > 0 && budgetEvidence && knownEvidence.length > 0) {
      const current = orcamento.vigencia === 'ATUAL_SEM_HISTORICO';
      recommendations.push({
        codigo: 'ACOMPANHAR_ORCAMENTO_EXCEDIDO', prioridade: 1, titulo: 'Acompanhe seu orçamento',
        mensagem: current
          ? 'O total conhecido das compras registradas supera o orçamento mensal atualmente informado. Revise o planejamento; isso não comprova qual orçamento estava vigente nas compras.'
          : 'O total conhecido das compras registradas supera o orçamento informado para o período. Revise o planejamento para os próximos gastos.',
        referencias: sorted([...budgetEvidence.referencias, ...knownEvidence.flatMap(e => e.referencias)]),
        limitacoes: sorted([...input.limitacoes, ...(financeiro.qualidade === 'PARCIAL' || orcamento.disponibilidade === 'PARCIAL' ? ['TOTAL_CONHECIDO_NAO_REPRESENTA_CONSUMO_COMPLETO'] : [])]),
      });
    }
    const limitEvidence = input.evidencias.find(e => e.codigo === 'LIMITE_INDIVIDUAL' && e.natureza === 'DECLARADO' && e.referencias.some(r => r.length > 0));
    const excessEvidence = limiteIndividual.desvios.filter(d => d.excessoCentavos > 0).map(d => purchaseEvidence(d.compraId)).filter(e => e !== undefined);
    if (limiteIndividual.disponibilidade !== 'INDISPONIVEL' && limiteIndividual.limiteCentavos !== null && limiteIndividual.limiteCentavos > 0 && limitEvidence && excessEvidence.length > 0) {
      recommendations.push({
        codigo: 'REVISAR_LIMITE_INDIVIDUAL', prioridade: 2, titulo: 'Revise seu limite por compra',
        mensagem: limiteIndividual.vigencia === 'ATUAL_SEM_HISTORICO'
          ? 'Há compras registradas com valor conhecido acima do limite individual atualmente informado. Confira se esse limite corresponde ao seu planejamento atual.'
          : 'Há compras registradas com valor conhecido acima do limite individual informado para o período. Confira seu planejamento antes de novas compras.',
        referencias: sorted([...limitEvidence.referencias, ...excessEvidence.flatMap(e => e.referencias)]),
        limitacoes: sorted([...input.limitacoes, ...(limiteIndividual.disponibilidade === 'PARCIAL' ? ['COMPARACAO_RESTRITA_A_COMPRAS_COM_EVIDENCIA'] : [])]),
      });
    }
  } else {
    const evidence = purchaseEvidence(input.compraId);
    // Per-purchase v1 embeds the limit reference in purchase evidence, without
    // a structured validity field: wording conservatively always says current.
    if (input.elegivel && input.disponibilidadeValor === 'DISPONIVEL' && input.valorLiquidoCentavos !== null && input.excessoLimiteCentavos !== null && input.excessoLimiteCentavos > 0 && evidence && evidence.referencias.some(r => r !== `compra:${input.compraId}`)) {
      recommendations.push({ codigo: 'REVISAR_LIMITE_INDIVIDUAL', prioridade: 2, titulo: 'Revise seu limite por compra',
        mensagem: 'Esta compra registrada tem valor conhecido acima do limite usado na análise. Confira o limite atualmente informado e seu planejamento atual.',
        referencias: sorted(evidence.referencias), limitacoes: sorted([...input.limitacoes, 'VIGENCIA_DO_LIMITE_NAO_COMPROVADA_NESTE_CONTRATO']) });
    }
  }
  recommendations.sort((a, b) => a.prioridade - b.prioridade || a.codigo.localeCompare(b.codigo));
  return resultadoRecomendacoesSchema.parse({ versaoContrato: 1, versaoRegras: 'financeiras-1', estado: recommendations.length ? 'COM_RECOMENDACOES' : 'SEM_RECOMENDACOES_ELEGIVEIS', recomendacoes: recommendations.slice(0, 3), regrasDesativadas: ['APROXIMACAO_ORCAMENTO_SEM_PARAMETRO_APROVADO', 'CONCENTRACAO_CATEGORIA_SEM_PARAMETROS_APROVADOS'] });
}
