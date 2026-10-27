import { cents } from '../compra/financeiro.js';
import { entradaPeriodoSchema, entradaCompraSchema, saidaPeriodoSchema, saidaCompraSchema, type EntradaPeriodo } from './analise.schemas.js';
import { descriptiveIndicators, eligible, observedWindow } from './indicadores.engine.js';

function validateIdentity(input: EntradaPeriodo) {
  for (const rows of [input.compras, input.anterior?.compras ?? []]) {
    const ids = new Set<number>();
    for (const row of rows) {
      if (row.usuarioId !== input.usuarioId) throw new Error('ANALISE_USER_MISMATCH');

      if (ids.has(row.id)) throw new Error('ANALISE_DUPLICATE_CANONICAL_PURCHASE');
      ids.add(row.id);
    }
    rows.sort((a, b) => a.id - b.id);
  }
}
function limitations(input: EntradaPeriodo) {
  return [
    'INDICADORES_DESCRITIVOS_NAO_DIAGNOSTICAM_IMPULSIVIDADE',
    'FREQUENCIA_REPRESENTA_COMPRAS_REGISTRADAS_NAO_TODAS_AS_COMPRAS',
    'PARTICIPACOES_MULTICATEGORIA_PODEM_SOMAR_MAIS_DE_100_POR_CENTO',
    ...(input.janela.cobertura !== 'COMPLETA' ? ['COBERTURA_NAO_COMPLETA'] : []),
    ...(!input.anterior ? ['HISTORICO_NAO_FORNECIDO'] : []),
    ...(input.compras.some(row => row.precisaoHorario !== 'INSTANTE') ? ['HORARIOS_NAO_COMPROVADOS'] : []),
    ...(input.limiteIndividual.vigencia === 'ATUAL_SEM_HISTORICO' || input.orcamentoMensal.vigencia === 'ATUAL_SEM_HISTORICO' ? ['LIMITES_ATUAIS_SEM_VIGENCIA_HISTORICA'] : []),
  ];
}
const assessment = (eligible: boolean) => ({ estado: eligible ? 'DADOS_INSUFICIENTES' as const : 'NAO_AVALIAVEL' as const, regrasAplicadas: [], justificativas: ['REGRAS_COMPORTAMENTAIS_NAO_APROVADAS'] });

export function analisarPeriodo(raw: unknown) {
  const input = entradaPeriodoSchema.parse(raw);
  validateIdentity(input);
  const indicators = descriptiveIndicators(input);
  const window = observedWindow(input.janela);
  return saidaPeriodoSchema.parse({
    versaoContrato: 1, versaoIndicadores: 'descritivos-1', escopo: 'PERIODO', periodo: input.janela.periodo, timezone: 'America/Sao_Paulo', observadoAte: input.janela.observadoAte,
    avaliacao: assessment(indicators.frequencia.compras > 0 || input.compras.some(row => row.ativa && row.status === 'CONFIRMADA' && row.horario === null)),
    qualidade: { cobertura: input.janela.cobertura, comprasSemHorario: input.compras.filter(row => row.ativa && row.status === 'CONFIRMADA' && row.horario === null).length, horariosImprecisos: input.compras.filter(row => eligible(row, input.usuarioId, window) && row.precisaoHorario !== 'INSTANTE').length },
    indicadores: indicators,
    evidencias: [
      ...input.compras.filter(row => eligible(row, input.usuarioId, window)).map(row => ({ codigo: `COMPRA_${row.id}`, natureza: row.origem === 'MANUAL' ? 'DECLARADO' : row.origem === 'DESCONHECIDA' ? 'DESCONHECIDO' : 'OBSERVADO', referencias: [`compra:${row.id}`, ...row.referencias] })),
      ...(input.anterior ? input.anterior.compras.filter(row => eligible(row, input.usuarioId, observedWindow(input.anterior!.janela))).map(row => ({ codigo: `COMPRA_ANTERIOR_${row.id}`, natureza: row.origem === 'MANUAL' ? 'DECLARADO' : row.origem === 'DESCONHECIDA' ? 'DESCONHECIDO' : 'OBSERVADO', referencias: [`compra:${row.id}`, ...row.referencias] })) : []),
      { codigo: 'LIMITE_INDIVIDUAL', natureza: 'DECLARADO', referencias: [input.limiteIndividual.referencia] },
      { codigo: 'ORCAMENTO_MENSAL', natureza: 'DECLARADO', referencias: [input.orcamentoMensal.referencia] },
    ], limitacoes: limitations(input),
  });
}

export function analisarCompra(raw: unknown) {
  const input = entradaCompraSchema.parse(raw);
  validateIdentity(input);
  const row = input.compras.find(row => row.id === input.compraId);
  if (!row) throw new Error('ANALISE_PURCHASE_NOT_IN_SNAPSHOT');
  const isEligible = eligible(row, input.usuarioId, observedWindow(input.janela));
  const value = row.valorLiquido === null ? null : cents(row.valorLiquido);
  const limit = input.limiteIndividual.valor === null ? null : cents(input.limiteIndividual.valor);
  return saidaCompraSchema.parse({
    versaoContrato: 1, versaoIndicadores: 'descritivos-1', escopo: 'COMPRA', compraId: row.id, elegivel: isEligible, origem: row.origem, precisaoHorario: row.precisaoHorario,
    disponibilidadeValor: !isEligible || value === null ? 'INDISPONIVEL' : 'DISPONIVEL', valorLiquidoCentavos: value,
    excessoLimiteCentavos: !isEligible || value === null || limit === null || limit === 0 ? null : Math.max(0, value - limit),
    avaliacao: assessment(isEligible || row.ativa && row.status === 'CONFIRMADA' && row.horario === null), evidencias: [{ codigo: `COMPRA_${row.id}`, natureza: row.origem === 'MANUAL' ? 'DECLARADO' : row.origem === 'DESCONHECIDA' ? 'DESCONHECIDO' : 'OBSERVADO', referencias: [`compra:${row.id}`, ...row.referencias, input.limiteIndividual.referencia] }], limitacoes: limitations(input),
  });
}
