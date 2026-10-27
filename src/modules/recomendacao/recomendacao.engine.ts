import { z } from 'zod';
import { saidaPeriodoSchema, saidaCompraSchema } from '../analise/analise.schemas.js';

const recommendationSchema = z.object({
  codigo: z.enum([
    'REVISAR_LIMITE_INDIVIDUAL', 'ACOMPANHAR_ORCAMENTO_EXCEDIDO',
    'CONCENTRACAO_CATEGORIA', 'FREQUENCIA_ELEVADA', 'COMPARACAO_POSITIVA',
    'REVISAR_COMPRAS_IMPULSIVAS', 'ATENCAO_META', 'COMPROMISSO_RECORRENTE',
  ]),
  titulo: z.string(), mensagem: z.string(), prioridade: z.number().int().positive(),
  referencias: z.array(z.string().min(1)).min(1), limitacoes: z.array(z.string()),
}).strict();
export const resultadoRecomendacoesSchema = z.object({
  versaoContrato: z.literal(1), versaoRegras: z.literal('financeiras-1'),
  estado: z.enum(['COM_RECOMENDACOES', 'SEM_RECOMENDACOES_ELEGIVEIS']),
  acao: z.enum(['RECOMENDAR', 'NENHUMA_ACAO']),
  recomendacoes: z.array(recommendationSchema).max(10), regrasDesativadas: z.array(z.string()),
}).strict();
type Recommendation = z.infer<typeof recommendationSchema>;
export type RecommendationContext = {
  comprasImpulsivas?: { quantidade: number; valorConhecido: number | null };
  metas?: Array<{ id: number; titulo: string; valor: number; concluida: boolean; data: Date | null }>;
  recorrencias?: Array<{ id: number; proximaOcorrencia: string | null; valorMensalConhecido: number | null }>;
  enableExpandedRules?: boolean;
  maxCandidates?: number;
};
const sorted = (values: string[]) => [...new Set(values)].sort();

/** Pure consumer of ANALISE v1. Invalid contracts throw; empty success is explicit.
 * No money calculation, behavioral evaluation, clock, I/O or Android dependency.
 */
export function recomendar(raw: unknown, context: RecommendationContext = {}) {
  const input = z.union([saidaPeriodoSchema, saidaCompraSchema]).parse(raw);
  const recommendations: Recommendation[] = [];
  const expanded = context.enableExpandedRules === true;
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
        codigo: 'ACOMPANHAR_ORCAMENTO_EXCEDIDO', prioridade: 1, titulo: 'Observe seu orçamento',
        mensagem: current
          ? 'O total conhecido dos gastos registrados já ultrapassou o orçamento mensal atualmente informado. Talvez seja um bom momento para olhar as despesas recentes e identificar onde economizar nas próximas compras. Quer analisar isso comigo?'
          : 'O total conhecido dos gastos do período ultrapassou o orçamento informado para essa janela. Vale olhar as despesas recentes e pensar em prioridades para as próximas compras. Quer analisar isso comigo?',
        referencias: sorted([...budgetEvidence.referencias, ...knownEvidence.flatMap(e => e.referencias)]),
        limitacoes: sorted([...input.limitacoes, ...(financeiro.qualidade === 'PARCIAL' || orcamento.disponibilidade === 'PARCIAL' ? ['TOTAL_CONHECIDO_NAO_REPRESENTA_CONSUMO_COMPLETO'] : [])]),
      });
    }
    const limitEvidence = input.evidencias.find(e => e.codigo === 'LIMITE_INDIVIDUAL' && e.natureza === 'DECLARADO' && e.referencias.some(r => r.length > 0));
    const excessEvidence = limiteIndividual.desvios.filter(d => d.excessoCentavos > 0).map(d => purchaseEvidence(d.compraId)).filter(e => e !== undefined);
    if (limiteIndividual.disponibilidade !== 'INDISPONIVEL' && limiteIndividual.limiteCentavos !== null && limiteIndividual.limiteCentavos > 0 && limitEvidence && excessEvidence.length > 0) {
      recommendations.push({
        codigo: 'REVISAR_LIMITE_INDIVIDUAL', prioridade: 2, titulo: 'Observe gastos acima do limite',
        mensagem: limiteIndividual.vigencia === 'ATUAL_SEM_HISTORICO'
          ? 'Há compras registradas com valor conhecido acima do limite por compra atualmente informado. Que tal analisarmos esses gastos e pensarmos em maneiras de evitar novos excessos? Pequenas decisões podem ajudar a manter seu planejamento.'
          : 'Há compras registradas com valor conhecido acima do limite por compra informado para o período. Vale analisar esses gastos e pensar em alternativas para as próximas compras.',
        referencias: sorted([...limitEvidence.referencias, ...excessEvidence.flatMap(e => e.referencias)]),
        limitacoes: sorted([...input.limitacoes, ...(limiteIndividual.disponibilidade === 'PARCIAL' ? ['COMPARACAO_RESTRITA_A_COMPRAS_COM_EVIDENCIA'] : [])]),
      });
    }
    const category = [...input.indicadores.categorias.grupos]
      .sort((a, b) => b.participacao - a.participacao || a.categoriaId - b.categoriaId)[0];
    if (expanded && category && input.indicadores.categorias.disponibilidade !== 'INDISPONIVEL' && category.compras >= 3 && category.participacao >= 0.6) {
      recommendations.push({
        codigo: 'CONCENTRACAO_CATEGORIA', prioridade: 3, titulo: 'Observe a categoria mais frequente',
        mensagem: 'Uma categoria concentra boa parte das compras registradas no período. Vale observar se essas despesas estão alinhadas às prioridades do momento e pensar em alternativas para as próximas compras.',
        referencias: [`categoria:${category.categoriaId}`, `compras:${category.compras}`],
        limitacoes: sorted([...input.limitacoes, ...(input.indicadores.categorias.disponibilidade === 'PARCIAL' ? ['CATEGORIAS_COM_COBERTURA_PARCIAL'] : [])]),
      });
    }
    if (expanded && input.indicadores.frequencia.disponibilidade !== 'INDISPONIVEL' && input.indicadores.frequencia.compras >= 10 && input.indicadores.frequencia.comprasPorDia >= 0.5) {
      recommendations.push({
        codigo: 'FREQUENCIA_ELEVADA', prioridade: 4, titulo: 'Observe a frequência das compras',
        mensagem: 'Foram registradas compras em frequência elevada neste período. Uma revisão semanal pode ajudar a manter o planejamento visível.',
        referencias: [`compras:${input.indicadores.frequencia.compras}`], limitacoes: sorted(input.limitacoes),
      });
    }
    if (expanded && input.indicadores.comparacao.disponibilidade === 'DISPONIVEL' && input.indicadores.comparacao.diferenca !== null && input.indicadores.comparacao.diferenca < 0) {
      recommendations.push({
        codigo: 'COMPARACAO_POSITIVA', prioridade: 5, titulo: 'Você reduziu compras registradas',
        mensagem: 'O período tem menos compras registradas que a janela anterior comparável. Use esse dado como referência para continuar acompanhando seus planos.',
        referencias: [`periodo:${input.periodo}`, `periodo-anterior:${input.indicadores.comparacao.periodoAnterior}`], limitacoes: sorted(input.limitacoes),
      });
    }
    if (expanded && context.comprasImpulsivas && context.comprasImpulsivas.quantidade > 0) {
      recommendations.push({
        codigo: 'REVISAR_COMPRAS_IMPULSIVAS', prioridade: 2, titulo: 'Reflita sobre compras marcadas como impulsivas',
        mensagem: 'Há compras classificadas como impulsivas no período. Antes de novas compras, uma pausa e a revisão das prioridades podem ajudar a decidir com mais calma.',
        referencias: [`compras-impulsivas:${context.comprasImpulsivas.quantidade}`], limitacoes: sorted([...input.limitacoes, 'CLASSIFICACAO_FORNECIDA_PELO_USUARIO_OU_FLUXO_EXISTENTE']),
      });
    }
    const openGoal = context.metas?.find((goal) => !goal.concluida && goal.valor > 0);
    if (expanded && openGoal) {
      recommendations.push({
        codigo: 'ATENCAO_META', prioridade: 4, titulo: 'Mantenha sua meta no radar',
        mensagem: `A meta "${openGoal.titulo.slice(0, 60)}" continua em andamento. Que tal vermos como os próximos gastos podem se encaixar melhor no seu planejamento para ajudar você a avançar?`,
        referencias: [`meta:${openGoal.id}`], limitacoes: sorted([...input.limitacoes, 'PROGRESSO_MONETARIO_DA_META_NAO_DISPONIVEL_NESTE_CONTRATO']),
      });
    }
    const recurring = context.recorrencias?.find((item) => item.valorMensalConhecido !== null && item.valorMensalConhecido > 0);
    if (expanded && recurring) {
      recommendations.push({
        codigo: 'COMPROMISSO_RECORRENTE', prioridade: 4, titulo: 'Confira seus compromissos recorrentes',
        mensagem: 'Há um compromisso recorrente com próxima ocorrência registrada. Vale reservar esse valor no planejamento do período e pensar em como encaixá-lo nos próximos gastos.',
        referencias: [`recorrencia:${recurring.id}`], limitacoes: sorted([...input.limitacoes, 'VALOR_RECORRENTE_ESTIMADO_PELOS_ITENS_ATIVOS']),
      });
    }
  } else {
    const evidence = purchaseEvidence(input.compraId);
    // Per-purchase v1 embeds the limit reference in purchase evidence, without
    // a structured validity field: wording conservatively always says current.
    if (input.elegivel && input.disponibilidadeValor === 'DISPONIVEL' && input.valorLiquidoCentavos !== null && input.excessoLimiteCentavos !== null && input.excessoLimiteCentavos > 0 && evidence && evidence.referencias.some(r => r !== `compra:${input.compraId}`)) {
      recommendations.push({ codigo: 'REVISAR_LIMITE_INDIVIDUAL', prioridade: 2, titulo: 'Observe este gasto acima do limite',
        mensagem: 'Esta compra registrada ficou acima do limite usado na análise. Vale analisar esse gasto e pensar em alternativas para evitar novos excessos, sem presumir qual limite estava vigente na data.',
        referencias: sorted(evidence.referencias), limitacoes: sorted([...input.limitacoes, 'VIGENCIA_DO_LIMITE_NAO_COMPROVADA_NESTE_CONTRATO']) });
    }
  }
  recommendations.sort((a, b) => a.prioridade - b.prioridade || a.codigo.localeCompare(b.codigo));
  return resultadoRecomendacoesSchema.parse({
    versaoContrato: 1, versaoRegras: 'financeiras-1', estado: recommendations.length ? 'COM_RECOMENDACOES' : 'SEM_RECOMENDACOES_ELEGIVEIS', acao: recommendations.length ? 'RECOMENDAR' : 'NENHUMA_ACAO',
    recomendacoes: recommendations.slice(0, context.maxCandidates ?? 3),
    regrasDesativadas: ['DIAGNOSTICO_PSICOLOGICO', 'CAUSALIDADE_NAO_COMPROVADA', ...(expanded ? [] : ['CONCENTRACAO_CATEGORIA_SEM_PARAMETROS_APROVADOS'])],
  });
}
