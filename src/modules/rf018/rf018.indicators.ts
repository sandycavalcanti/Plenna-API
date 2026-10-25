import { cents, financialWhere, parseMonth, summarizeValues } from '../compra/financeiro.js';
import type { EntradaPeriodo, CompraRF018 } from './rf018.schemas.js';
import { comparacaoTemporal } from './temporal.policy.js';

export function observedWindow(window: EntradaPeriodo['janela']) {
  const { start, end } = parseMonth(window.periodo);
  const cutoff = new Date(window.observadoAte);
  if (cutoff <= start || cutoff > end) throw new Error('RF018_INVALID_OBSERVATION_WINDOW');
  return { start, end, cutoff, days: (cutoff.getTime() - start.getTime()) / 86400000 };
}

export function eligible(purchase: CompraRF018, userId: number, window: ReturnType<typeof observedWindow>) {
  const criteria = financialWhere(userId, window.start);
  if (purchase.usuarioId !== criteria.usuario_id || !purchase.ativa || purchase.status !== criteria.compra_status || purchase.horario === null) return false;
  const date = new Date(purchase.horario);
  return date >= criteria.compra_horario.gte && date < criteria.compra_horario.lt && date < window.cutoff;
}

export function descriptiveIndicators(input: EntradaPeriodo) {
  const window = observedWindow(input.janela);
  const rows = input.compras.filter(row => eligible(row, input.usuarioId, window));
  const counts = new Map<number, number>();
  let categorized = 0;
  for (const row of rows) {
    const categories = new Set(row.categorias);
    if (categories.size) categorized++;
    for (const category of categories) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const financial = summarizeValues(rows.map(row => row.valorLiquido), input.orcamentoMensal.valor);
  const rawLimit = input.limiteIndividual.valor;
  const limit = rawLimit === null || cents(rawLimit) === 0 ? null : cents(rawLimit);
  const unknown = rows.filter(row => row.valorLiquido === null).length;
  const partial = input.janela.cobertura !== 'COMPLETA' || input.compras.some(row => row.ativa && row.status === 'CONFIRMADA' && row.horario === null);
  let comparison: { disponibilidade: 'DISPONIVEL' | 'INDISPONIVEL'; motivo: string | null; periodoAnterior: string | null; comprasAnterior: number | null; diferenca: number | null; variacaoRelativa: number | null } = {
    disponibilidade: 'INDISPONIVEL', motivo: 'HISTORICO_NAO_FORNECIDO', periodoAnterior: null, comprasAnterior: null, diferenca: null, variacaoRelativa: null,
  };
  if (input.anterior) {
    const previous = observedWindow(input.anterior.janela);
    if (previous.cutoff > window.start) throw new Error('RF018_OVERLAPPING_PERIODS');
    const sameDuration = previous.cutoff.getTime() - previous.start.getTime() === window.cutoff.getTime() - window.start.getTime();
    const missingDates = input.anterior.compras.some(row => row.ativa && row.status === 'CONFIRMADA' && row.horario === null);
    comparison.periodoAnterior = input.anterior.janela.periodo;
    const coverage = !partial && !missingDates && input.anterior.janela.cobertura === 'COMPLETA' && input.anterior.coberturaComparavel ? 'COMPLETA' : 'DESCONHECIDA';
    const temporal = comparacaoTemporal(window.cutoff.getTime() - window.start.getTime(), coverage);
    comparison.motivo = !sameDuration ? 'JANELAS_NAO_EQUIVALENTES' : !temporal.elegivel ? 'COBERTURA_NAO_COMPARAVEL' : null;
    if (!comparison.motivo) {
      const count = input.anterior.compras.filter(row => eligible(row, input.usuarioId, previous)).length;
      comparison = { disponibilidade: 'DISPONIVEL', motivo: null, periodoAnterior: input.anterior.janela.periodo, comprasAnterior: count, diferenca: rows.length - count, variacaoRelativa: count === 0 ? null : (rows.length - count) / count };
    }
  }
  return {
    frequencia: { disponibilidade: partial ? 'PARCIAL' as const : 'DISPONIVEL' as const, compras: rows.length, diasObservados: window.days, comprasPorDia: rows.length / window.days },
    comparacao: comparison,
    categorias: { disponibilidade: !categorized ? 'INDISPONIVEL' as const : partial || categorized !== rows.length ? 'PARCIAL' as const : 'DISPONIVEL' as const, comprasCategorizadas: categorized, comprasSemCategoria: rows.length - categorized, grupos: [...counts].sort(([a], [b]) => a - b).map(([categoriaId, compras]) => ({ categoriaId, compras, participacao: compras / categorized })) },
    limiteIndividual: { disponibilidade: limit === null || !rows.length ? 'INDISPONIVEL' as const : partial || unknown > 0 ? 'PARCIAL' as const : 'DISPONIVEL' as const, limiteCentavos: limit, vigencia: input.limiteIndividual.vigencia, comprasSemValor: unknown, desvios: limit === null ? [] : rows.filter(row => row.valorLiquido !== null).map(row => ({ compraId: row.id, excessoCentavos: Math.max(0, cents(row.valorLiquido!) - limit) })) },
    financeiro: financial,
    orcamento: { disponibilidade: financial.orcamentoMensal === null || financial.qualidade === 'INSUFICIENTE' ? 'INDISPONIVEL' as const : partial || financial.qualidade === 'PARCIAL' ? 'PARCIAL' as const : 'DISPONIVEL' as const, vigencia: input.orcamentoMensal.vigencia, estadoNoUniversoObservado: financial.estadoOrcamento },
  };
}
