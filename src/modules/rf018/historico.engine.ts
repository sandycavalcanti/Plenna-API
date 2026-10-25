import {
  baseTemporal,
  comparacaoTemporal,
  dataElegivel,
  VERSAO_POLITICA_TEMPORAL,
} from './temporal.policy.js';
import { cents, parseMonth, summarizeValues } from '../compra/financeiro.js';
import {
  entradaHistoricoSchema,
  coberturaRespostaSchema,
  type CompraHistorico,
} from './historico.schemas.js';

const DAY = 86_400_000;
const iso = (time: number) => new Date(time).toISOString();
const day = (row: CompraHistorico) =>
  new Date(row.data!).toISOString().slice(0, 10);
const fraction = (n: number, denominator: number) =>
  denominator ? n / denominator : null;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
export const resumirValoresHistoricos = (rows: CompraHistorico[]) => {
  const values = rows
    .filter((r) => r.valorLiquido !== null)
    .map((r) => cents(r.valorLiquido!));
  const total = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total)) throw Error('RF018_INVALID_HISTORY_TOTAL');
  return {
    amostra: values.length,
    semValor: rows.length - values.length,
    disponibilidade:
      values.length < 2
        ? ('INDISPONIVEL' as const)
        : values.length < rows.length
          ? ('PARCIAL' as const)
          : ('DISPONIVEL' as const),
    motivo: values.length < 2 ? 'MENOS_DE_DUAS_COMPRAS_COM_VALOR' : null,
    medianaCentavos: median(values),
    mediaCentavos: values.length ? total / values.length : null,
    minimoCentavos: values.length
      ? values.reduce((a, b) => Math.min(a, b))
      : null,
    maximoCentavos: values.length
      ? values.reduce((a, b) => Math.max(a, b))
      : null,
  };
};
function declaration(
  rows: CompraHistorico[],
  field: 'planejamento' | 'influenciaPromocional',
) {
  const counts = { SIM: 0, PARCIALMENTE: 0, NAO: 0 };
  let ausentes = 0,
    recusadas = 0,
    naoLembra = 0;
  for (const row of rows) {
    const value = row.contexto?.respostas[field];
    if (value === undefined) ausentes++;
    else if (value === 'PREFIRO_NAO_RESPONDER') recusadas++;
    else if (value === 'NAO_LEMBRO') naoLembra++;
    else counts[value]++;
  }
  const conhecidas = counts.SIM + counts.PARCIALMENTE + counts.NAO;
  const coverage = coberturaRespostaSchema.parse({
    universo: rows.length,
    conhecidas,
    ausentes,
    recusadas,
    naoLembra,
    cobertura: fraction(conhecidas, rows.length),
    disponibilidade: !conhecidas
      ? 'INDISPONIVEL'
      : conhecidas === rows.length
        ? 'DISPONIVEL'
        : 'PARCIAL',
  });
  return {
    ...coverage,
    contagens: counts,
    proporcoesConhecidas: {
      SIM: fraction(counts.SIM, conhecidas),
      PARCIALMENTE: fraction(counts.PARCIALMENTE, conhecidas),
      NAO: fraction(counts.NAO, conhecidas),
    },
  };
}

/** Análise descritiva pura: não infere respostas, grava dados ou classifica compras. */
export function analisarHistorico(raw: unknown) {
  const input = entradaHistoricoSchema.parse(raw);
  const { start, end } = parseMonth(input.periodo);
  const cutoff = new Date(input.observadoAte).getTime();
  if (cutoff < start.getTime() || cutoff > end.getTime())
    throw Error('RF018_INVALID_HISTORY_WINDOW');
  const historyStart = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth() - input.mesesHistorico,
    1,
  );
  const ids = new Set<number>();
  for (const row of input.compras) {
    if (row.usuarioId !== input.usuarioId) throw Error('RF018_USER_MISMATCH');
    if (ids.has(row.id)) throw Error('RF018_DUPLICATE_CANONICAL_PURCHASE');
    ids.add(row.id);
  }
  const confirmed = input.compras.filter(
    (r) => r.ativa && r.status === 'CONFIRMADA',
  );
  const dated = confirmed.filter(dataElegivel);
  const impreciseDays = new Set(
    dated.filter((r) => r.precisao !== 'INSTANTE').map(day),
  );
  const unknownDates = confirmed.length - dated.length;
  const coverage =
    input.cobertura === 'COMPLETA' && unknownDates
      ? 'PARCIAL'
      : input.cobertura;
  const between = (from: number, until: number) =>
    dated
      .filter((r) => {
        const time = new Date(r.data!).getTime();
        return time >= from && time < until;
      })
      .sort(
        (a, b) =>
          day(a).localeCompare(day(b)) ||
          (impreciseDays.has(day(a))
            ? a.id - b.id
            : Date.parse(a.data!) - Date.parse(b.data!) || a.id - b.id),
      );
  const current = between(start.getTime(), cutoff),
    history = between(historyStart, start.getTime());
  const observedDays = (cutoff - start.getTime()) / DAY;
  const periods = Array.from({ length: input.mesesHistorico + 1 }, (_, i) => {
    const from = Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth() - input.mesesHistorico + i,
      1,
    );
    const until = Math.min(
      Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth() - input.mesesHistorico + i + 1,
        1,
      ),
      cutoff,
    );
    const rows = between(from, until);
    return {
      periodo: iso(from).slice(0, 7),
      inicio: iso(from),
      fimExclusivo: iso(until),
      compras: rows.length,
      diasObservados: (until - from) / DAY,
      cobertura: coverage,
      temRegistros: rows.length > 0,
      comprasPorDia:
        coverage === 'COMPLETA'
          ? fraction(rows.length, (until - from) / DAY)
          : null,
    };
  });
  // As janelas precisam ter a mesma duração observada para não comparar um mês parcial com um completo.
  const previousStart = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth() - 1,
    1,
  );
  const duration = Math.min(
    cutoff - start.getTime(),
    start.getTime() - previousStart,
  );
  const comparableCurrent = between(
    start.getTime(),
    start.getTime() + duration,
  );
  const comparablePrevious = between(previousStart, previousStart + duration);
  const { elegivel: comparable, motivo: comparisonReason } = comparacaoTemporal(
    duration,
    coverage,
  );
  const byDay = new Map<string, number>();
  for (const row of current)
    byDay.set(day(row), (byDay.get(day(row)) ?? 0) + 1);
  const distribution = [...byDay]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([data, compras]) => ({ data, compras }));
  const peak = Math.max(0, ...distribution.map((d) => d.compras));
  const sequence = [...history, ...current];
  const intervals = sequence.slice(1).map((row, i) => {
    const previous = sequence[i]!;
    const sameDay = day(row) === day(previous);
    const exact =
      row.precisao === 'INSTANTE' &&
      previous.precisao === 'INSTANTE' &&
      row.origem !== 'EMAIL' &&
      previous.origem !== 'EMAIL' &&
      !(sameDay && impreciseDays.has(day(row)));
    return {
      compraAnteriorId: previous.id,
      compraId: row.id,
      precisao: exact ? ('INSTANTE' as const) : ('DIA' as const),
      ordemNoMesmoDiaComprovada: !sameDay ? null : exact,
      segundosExatos: exact
        ? (new Date(row.data!).getTime() - new Date(previous.data!).getTime()) /
          1000
        : null,
      diasEntreDatas: (Date.parse(day(row)) - Date.parse(day(previous))) / DAY,
    };
  });
  const historicalStats = resumirValoresHistoricos(history),
    currentStats = resumirValoresHistoricos(current);
  const comparableValues =
    historicalStats.amostra >= 2 && currentStats.amostra > 0;
  const baseline = historicalStats.medianaCentavos;
  const categories = [
    ...new Set([...current, ...history].flatMap((r) => r.categorias)),
  ]
    .sort((a, b) => a - b)
    .map((categoriaId) => {
      const count = (rows: CompraHistorico[]) =>
        rows.filter((r) => new Set(r.categorias).has(categoriaId)).length;
      const atual = count(comparableCurrent),
        anterior = count(comparablePrevious),
        historico = count(history);
      const attributable = [...history, ...current].filter(
        (r) =>
          r.valorLiquido !== null &&
          r.categoriasCompletas &&
          new Set(r.categorias).size === 1 &&
          r.categorias[0] === categoriaId,
      );
      const totalAtribuido = attributable.reduce(
        (sum, r) => sum + cents(r.valorLiquido!),
        0,
      );
      if (!Number.isSafeInteger(totalAtribuido))
        throw Error('RF018_INVALID_HISTORY_TOTAL');
      return {
        categoriaId,
        comprasAtual: count(current),
        comprasHistorico: historico,
        nome:
          [...history, ...current]
            .flatMap((r) => r.nomesCategorias ?? [])
            .find((c) => c.id === categoriaId)?.nome ?? null,
        valores: {
          comprasAtribuidas: attributable.length,
          totalLiquidoCentavos: totalAtribuido,
          comprasMulticategoriaSemRateio: [...history, ...current].filter(
            (r) =>
              r.categorias.includes(categoriaId) &&
              new Set(r.categorias).size > 1,
          ).length,
          comprasSemCategorizacaoCompleta: [...history, ...current].filter(
            (r) => r.categorias.includes(categoriaId) && !r.categoriasCompletas,
          ).length,
          escopo: 'COMPRAS_COM_UMA_CATEGORIA_SEM_RATEIO_DE_DESCONTO' as const,
        },
        repeticaoObservada: count(current) + historico >= 2,
        comparacao: {
          atual,
          anterior,
          disponibilidade:
            !comparable || !anterior
              ? ('INDISPONIVEL' as const)
              : ('PARCIAL' as const),
          motivo: !comparable
            ? comparisonReason
            : !anterior
              ? 'SEM_REGISTROS_ANTERIORES_DA_CATEGORIA'
              : 'COMPARACAO_RESTRITA_AOS_REGISTROS',
          diferenca: comparable && anterior ? atual - anterior : null,
          variacaoRelativa:
            comparable && anterior ? (atual - anterior) / anterior : null,
        },
      };
    });
  const historical =
    input.periodo !==
      (input.referenciaAtual ?? input.observadoAte).slice(0, 7) ||
    cutoff === end.getTime();
  // O orçamento atual não comprova qual referência estava vigente em um período encerrado.
  const financial = summarizeValues(
    current.map((r) => r.valorLiquido),
    historical ? null : input.orcamentoAtual,
  );
  const planejamento = declaration(current, 'planejamento');
  const promocao = declaration(current, 'influenciaPromocional');
  const declarationsByPeriod = (
    field: 'planejamento' | 'influenciaPromocional',
  ) =>
    periods.map((period) => ({
      periodo: period.periodo,
      ...declaration(
        between(Date.parse(period.inicio), Date.parse(period.fimExclusivo)),
        field,
      ),
    }));
  const observations = [
    {
      codigo: 'FREQUENCIA_REGISTRADA',
      mensagem: `${current.length} compra(s) confirmada(s) no período observado.`,
      referencias: current.map((r) => `compra:${r.id}`),
    },
    {
      codigo: 'COBERTURA_PLANEJAMENTO',
      mensagem: `${planejamento.conhecidas} de ${current.length} compra(s) têm planejamento conhecido declarado.`,
      referencias: current
        .filter((r) => r.contexto)
        .map((r) => `contexto:${r.id}:revisao:${r.contexto!.revisao}`),
    },
  ];
  return {
    versaoContrato: 1 as const,
    versaoIndicadores: 'historicos-1' as const,
    periodo: input.periodo,
    timezone: 'UTC' as const,
    observadoAte: input.observadoAte,
    janelaHistorico: {
      inicio: iso(historyStart),
      fimExclusivo: start.toISOString(),
      meses: input.mesesHistorico,
    },
    politicaTemporal: {
      versao: VERSAO_POLITICA_TEMPORAL,
      solicitado: { inicio: iso(historyStart), fimExclusivo: iso(cutoff) },
      contaCriadaEm: input.inicioObservacao,
      compras: baseTemporal(sequence),
      valores: baseTemporal(sequence.filter((r) => r.valorLiquido !== null)),
      categorias: baseTemporal(sequence.filter((r) => r.categorias.length > 0)),
      planejamento: baseTemporal(
        sequence.filter((r) =>
          ['SIM', 'NAO', 'PARCIALMENTE'].includes(
            r.contexto?.respostas.planejamento ?? '',
          ),
        ),
        true,
      ),
      influenciaPromocional: baseTemporal(
        sequence.filter((r) =>
          ['SIM', 'NAO', 'PARCIALMENTE'].includes(
            r.contexto?.respostas.influenciaPromocional ?? '',
          ),
        ),
        true,
      ),
      intervalos: baseTemporal(sequence),
      recorrenciasVinculadas: baseTemporal(
        sequence.filter((r) => r.recorrenciaId !== null),
      ),
      monitoramentoAndroid: 'NAO_UTILIZADO',
      associacaoAplicativosCompras: 'INDISPONIVEL',
      comparacaoElegivel: comparable,
      limitacoes: [
        'REGISTROS_NAO_COMPROVAM_CONTINUIDADE',
        'CADASTRO_NAO_LIMITA_COMPRAS_ANTERIORES',
        'EMAIL_NAO_COMPROVA_DATA_DA_TRANSACAO',
        'RF017_NAO_UTILIZADO',
      ],
    },
    qualidade: {
      cobertura: coverage,
      universo: 'COMPRAS_ATIVAS_CONFIRMADAS_REGISTRADAS' as const,
      comprasAtual: current.length,
      comprasHistorico: history.length,
      semDataOuPrecisao: unknownDates,
      excluidasLogicamente: input.compras.filter((r) => !r.ativa).length,
      naoConfirmadas: input.compras.filter(
        (r) => r.ativa && r.status !== 'CONFIRMADA',
      ).length,
      importadasEmailAtual: current.filter((r) => r.origem === 'EMAIL').length,
      contextoAusenteAtual: current.filter((r) => !r.contexto).length,
      revisoesUtilizadas: [...history, ...current]
        .filter((r) => r.contexto)
        .map((r) => ({ compraId: r.id, revisao: r.contexto!.revisao })),
      precisaoTemporal:
        current.every(
          (r) => r.precisao === 'INSTANTE' && r.origem !== 'EMAIL',
        ) && current.length
          ? ('INSTANTE' as const)
          : ('DIA_OU_INSUFICIENTE' as const),
    },
    frequencia: {
      compras: current.length,
      diasObservados: observedDays,
      comprasPorDia:
        coverage === 'COMPLETA' ? fraction(current.length, observedDays) : null,
      periodos: periods,
      distribuicaoDiaria: distribution,
      maiorConcentracao: {
        comprasPorDia: peak,
        datas: distribution
          .filter((d) => d.compras === peak)
          .map((d) => d.data),
      },
      comparacao: {
        disponibilidade: !comparable
          ? ('INDISPONIVEL' as const)
          : coverage === 'COMPLETA'
            ? ('DISPONIVEL' as const)
            : ('PARCIAL' as const),
        motivo: comparisonReason,
        diasComparados: duration / DAY,
        inicioAtual: start.toISOString(),
        fimAtualExclusivo: iso(start.getTime() + duration),
        inicioAnterior: iso(previousStart),
        fimAnteriorExclusivo: iso(previousStart + duration),
        comprasAtual: comparableCurrent.length,
        comprasAnterior: comparablePrevious.length,
        diferenca: comparable
          ? comparableCurrent.length - comparablePrevious.length
          : null,
        variacaoRelativa: comparable
          ? fraction(
              comparableCurrent.length - comparablePrevious.length,
              comparablePrevious.length,
            )
          : null,
      },
    },
    intervalos: {
      disponibilidade: intervals.length
        ? ('PARCIAL' as const)
        : ('INDISPONIVEL' as const),
      escopo: 'HISTORICO_E_PERIODO_ATUAL' as const,
      motivo: intervals.length
        ? 'INTERVALOS_ENTRE_REGISTROS_NAO_COMPROVAM_MOMENTO_EFETIVO'
        : 'MENOS_DE_DUAS_COMPRAS_DATADAS',
      medianaDiasEntreDatas: median(intervals.map((i) => i.diasEntreDatas)),
      pares: intervals,
    },
    valores: {
      atual: currentStats,
      historico: historicalStats,
      referencia: 'MEDIANA_DAS_COMPRAS_ANTERIORES' as const,
      minimoAmostraHistorica: 2,
      disponibilidade: comparableValues
        ? ('PARCIAL' as const)
        : ('INDISPONIVEL' as const),
      motivo: comparableValues
        ? 'COMPARACAO_DESCRITIVA_SEM_LIMIAR_COMPORTAMENTAL'
        : 'HISTORICO_OU_VALORES_INSUFICIENTES',
      diferencaMedianasCentavos: comparableValues
        ? currentStats.medianaCentavos! - baseline!
        : null,
      variacaoRelativaMediana:
        comparableValues && baseline !== 0
          ? (currentStats.medianaCentavos! - baseline!) / baseline!
          : null,
    },
    categorias: categories,
    planejamento: {
      ...planejamento,
      historico: declaration(history, 'planejamento'),
      periodos: declarationsByPeriod('planejamento'),
      porItem: {
        ...declaration(
          current.flatMap((row) =>
            row.itensAtivos.map((itemId) => {
              const planejamento = row.contexto?.itens.find(
                (item) => item.itemId === itemId,
              )?.planejamento;
              return {
                ...row,
                contexto: planejamento
                  ? {
                      revisao: row.contexto!.revisao,
                      respostas: { planejamento },
                      itens: [],
                    }
                  : null,
              };
            }),
          ),
          'planejamento',
        ),
        escopo: 'ITENS_ATIVOS_DAS_COMPRAS_ELEGIVEIS' as const,
      },
    },
    influenciaPromocional: {
      ...promocao,
      historico: declaration(history, 'influenciaPromocional'),
      periodos: declarationsByPeriod('influenciaPromocional'),
      influenciaDeclarada: promocao.contagens.SIM,
      proporcaoConhecidas: promocao.proporcoesConhecidas.SIM,
    },
    recorrencias: {
      cadastradas: input.recorrencias.length,
      referenciaCadastro:
        'CONFIGURACAO_ATUAL_NAO_HISTORICO_DE_ESTADOS' as const,
      porStatus: Object.fromEntries(
        ['ATIVA', 'PAUSADA', 'CANCELADA', 'FINALIZADA'].map((status) => [
          status,
          input.recorrencias.filter((r) => r.status === status).length,
        ]),
      ),
      comprasVinculadasAtual: current.filter((r) => r.recorrenciaId !== null)
        .length,
      comprasVinculadasHistorico: history.filter(
        (r) => r.recorrenciaId !== null,
      ).length,
      repeticaoEstatisticaNaoComprovaRecorrencia: true as const,
    },
    eventosPosteriores: {
      universo: sequence.length,
      comprasComDeclaracao: sequence.filter(
        (r) => (r.contexto?.eventosPosteriores?.length ?? 0) > 0,
      ).length,
      contagens: Object.fromEntries(
        ['CANCELAMENTO', 'DEVOLUCAO', 'REEMBOLSO', 'ARREPENDIMENTO'].map(
          (tipo) => [
            tipo,
            sequence.filter((r) =>
              r.contexto?.eventosPosteriores?.some((evento) => evento === tipo),
            ).length,
          ],
        ),
      ),
      escopo: 'ULTIMA_DECLARACAO_DISPONIVEL_SEM_AJUSTE_FINANCEIRO' as const,
    },
    financeiro: {
      ...financial,
      cobertura: coverage,
      orcamentoHistoricoComprovado: false as const,
    },
    complementoContextual: {
      observacoes: observations,
      alteraClassificacao: false as const,
    },
    limitacoes: [
      'INDICADORES_DESCRITIVOS_NAO_DIAGNOSTICAM_IMPULSIVIDADE',
      'DATAS_REGISTRADAS_NAO_COMPROVAM_MOMENTO_EFETIVO',
      'AUSENCIA_DE_REGISTROS_NAO_COMPROVA_AUSENCIA_DE_CONSUMO',
      'DESCONTOS_NAO_SUBTRAIDOS_NOVAMENTE',
      'DECLARACOES_USAM_ULTIMA_REVISAO_DISPONIVEL_NAO_CONTEXTO_INFERIDO',
      'RECORRENCIA_CADASTRADA_NAO_CLASSIFICA_COMPORTAMENTO',
      ...(coverage !== 'COMPLETA' ? ['COBERTURA_NAO_COMPLETA'] : []),
      ...(historical
        ? ['ORCAMENTO_HISTORICO_NAO_COMPROVADO']
        : ['ORCAMENTO_ATUAL_SEM_HISTORICO_DE_VIGENCIA']),
      ...(!history.length ? ['HISTORICO_INSUFICIENTE'] : []),
    ],
  };
}
export type ResultadoHistorico = ReturnType<typeof analisarHistorico>;
