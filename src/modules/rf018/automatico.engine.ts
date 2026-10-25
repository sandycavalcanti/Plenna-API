import { createHash } from 'node:crypto';
import {
  entradaHistoricoSchema,
  type EntradaHistorico,
  type CompraHistorico,
} from './historico.schemas.js';
import { analisarHistorico } from './historico.engine.js';
import { faixaValores } from './descobertas.engine.js';
import { dataElegivel } from './temporal.policy.js';
import { cents } from '../compra/financeiro.js';

export type ComplementosAutomaticos = {
  limiteHistoricoCentavos?: number | null;
  limiteAtualCentavos?: number | null;
  eventos?: {
    disponivel: boolean;
    reembolsadoCentavos?: number;
    cancelamentos?: number;
    devolucoes?: number;
  };
  contexto?: {
    disponibilidade: 'DISPONIVEL' | 'INDISPONIVEL';
    revisao: number;
    respostas: Record<string, unknown>;
  };
};
type Evidencia = {
  indicador: string;
  familia: 'VALORES' | 'FREQUENCIA';
  regra: string;
  sinal: boolean;
  amostra: number;
  observado: number | null;
  referencia: number | null;
  unidade: 'CENTAVOS' | 'COMPRAS';
  periodo: { inicio: string; fimExclusivo: string };
  limitacoes: string[];
};
/** Combina evidências sem gravar dados. Cada família conta uma vez, sem gerar escore comportamental. */
export function avaliarAutomaticamente(
  raw: EntradaHistorico,
  alvo?: CompraHistorico,
  complementos: ComplementosAutomaticos = {},
) {
  const input = entradaHistoricoSchema.parse(raw),
    h = analisarHistorico(input);
  input.observadoAte = new Date(input.observadoAte).toISOString();
  input.compras = input.compras.map((r) => ({
    ...r,
    data: r.data ? new Date(r.data).toISOString() : null,
  }));
  if (alvo) {
    alvo = entradaHistoricoSchema.parse({ ...input, compras: [alvo] })
      .compras[0]!;
    if (alvo.data) alvo.data = new Date(alvo.data).toISOString();
    if (
      alvo.usuarioId !== input.usuarioId ||
      !dataElegivel(alvo) ||
      (alvo.origem === 'EMAIL' && alvo.precisao === 'INSTANTE')
    )
      throw Error('RF018_AUTOMATIC_TARGET_INVALID');
    if (
      !alvo.data ||
      alvo.data.slice(0, 10) !== input.observadoAte.slice(0, 10)
    )
      throw Error('RF018_AUTOMATIC_TARGET_WINDOW');
  }
  const inicio = h.janelaHistorico.inicio,
    fim = input.observadoAte;
  const eligible = input.compras
    .filter(dataElegivel)
    .filter((r) => r.data! >= inicio && r.data! < fim && r.id !== alvo?.id);
  // Excluímos o dia inteiro da compra: o timestamp legado não comprova a ordem entre compras do mesmo dia.
  const boundary = alvo
    ? alvo.data!.slice(0, 10) + 'T00:00:00.000Z'
    : h.janelaHistorico.fimExclusivo;
  const baseline = eligible.filter(
    (r) => Date.parse(r.data!) < Date.parse(boundary),
  );
  const current = alvo
    ? [alvo]
    : eligible.filter((r) => Date.parse(r.data!) >= Date.parse(boundary));
  const evidencias: Evidencia[] = [],
    indisponiveis: string[] = [],
    limitacoes = [
      'NAO_CLASSIFICA_IMPULSIVIDADE',
      'REGISTROS_NAO_COMPROVAM_TODO_CONSUMO',
      'VALORES_DA_DECISAO_NAO_SAO_GASTO_FINAL_APOS_EVENTOS',
      'SEM_ASSOCIACAO_CAUSAL_COM_APLICATIVOS',
    ];
  const periodo = { inicio, fimExclusivo: boundary };
  const valueEvidence = (
    rows: CompraHistorico[],
    observed: CompraHistorico[],
    indicador: string,
  ) => {
    const values = rows
        .filter((r) => r.valorLiquido !== null)
        .map((r) => cents(r.valorLiquido!)),
      range = faixaValores(values);
    const amounts = observed
      .filter((r) => r.valorLiquido !== null)
      .map((r) => cents(r.valorLiquido!));
    if (!range || !amounts.length) {
      indisponiveis.push(
        indicador +
          (!amounts.length
            ? ':VALOR_AUSENTE'
            : values.length < 4
              ? ':AMOSTRA_MENOR_QUE_QUATRO'
              : ':FAIXA_SEM_DISPERSAO'),
      );
      return;
    }
    const max = Math.max(...amounts);
    evidencias.push({
      indicador,
      familia: 'VALORES',
      regra: 'CERCA_SUPERIOR_TUKEY_Q3_MAIS_1_5_IQR',
      sinal: max > range.limiteSuperior,
      amostra: values.length,
      observado: max,
      referencia: range.limiteSuperior,
      unidade: 'CENTAVOS',
      periodo,
      limitacoes: ['COMPARACAO_ENTRE_REGISTROS_NAO_DIAGNOSTICO'],
    });
  };
  valueEvidence(baseline, current, 'V01');
  if (alvo?.categoriasCompletas && new Set(alvo.categorias).size === 1) {
    const category = alvo.categorias[0]!;
    // O recorte por categoria reutiliza a evidência de valor; não constitui uma família independente.
    valueEvidence(
      baseline.filter(
        (r) =>
          r.categoriasCompletas &&
          new Set(r.categorias).size === 1 &&
          r.categorias[0] === category,
      ),
      [alvo],
      'V01_CATEGORIA',
    );
  } else if (alvo)
    indisponiveis.push('V01_CATEGORIA:CATEGORIA_INCOMPLETA_OU_MULTIPLA');
  const f = h.frequencia.comparacao;
  if (f.disponibilidade === 'DISPONIVEL' && f.diferenca !== null) {
    evidencias.push({
      indicador: 'F05',
      familia: 'FREQUENCIA',
      regra: 'CONTAGENS_EM_JANELAS_DE_IGUAL_DURACAO_COM_COBERTURA_COMPLETA',
      sinal: f.diferenca > 0,
      amostra: f.comprasAnterior,
      observado: f.comprasAtual,
      referencia: f.comprasAnterior,
      unidade: 'COMPRAS',
      periodo: {
        inicio: f.inicioAnterior,
        fimExclusivo: f.fimAnteriorExclusivo,
      },
      limitacoes: ['DIFERENCA_DESCRITIVA_NAO_COMPROVA_TENDENCIA_PERSISTENTE'],
    });
  } else indisponiveis.push('F05:COBERTURA_OU_JANELA_INSUFICIENTE');
  // Sem cobertura comprovada, dias sem registros permanecem desconhecidos e não viram consumo zero.
  const daily = new Map<string, number>();
  for (const r of baseline.filter(
    (r) => r.data! < h.janelaHistorico.fimExclusivo,
  )) {
    const day = r.data!.slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + 1);
  }
  const dailyRange = faixaValores([...daily.values()]);
  if (dailyRange && h.frequencia.distribuicaoDiaria.length) {
    const peak = h.frequencia.maiorConcentracao.comprasPorDia;
    evidencias.push({
      indicador: 'F04',
      familia: 'FREQUENCIA',
      regra: 'TUKEY_CONTAGENS_POR_DIA_COM_REGISTROS',
      sinal: peak > dailyRange.limiteSuperior,
      amostra: daily.size,
      observado: peak,
      referencia: dailyRange.limiteSuperior,
      unidade: 'COMPRAS',
      periodo: { inicio, fimExclusivo: h.janelaHistorico.fimExclusivo },
      limitacoes: [
        'SOMENTE_DIAS_COM_REGISTROS',
        'NAO_COMPROVA_AUMENTO_DO_CONSUMO',
        'SEM_ORDEM_INTRADIARIA_COMPROVADA',
      ],
    });
  } else indisponiveis.push('F04:DIAS_HISTORICOS_OU_DISPERSAO_INSUFICIENTES');
  if (
    alvo &&
    alvo.origem !== 'EMAIL' &&
    complementos.limiteHistoricoCentavos != null &&
    complementos.limiteHistoricoCentavos > 0 &&
    alvo.valorLiquido !== null
  ) {
    evidencias.push({
      indicador: 'V03',
      familia: 'VALORES',
      regra: 'LIMITE_VIGENTE_COMPROVADO_NA_DATA',
      sinal: cents(alvo.valorLiquido) > complementos.limiteHistoricoCentavos,
      amostra: 1,
      observado: cents(alvo.valorLiquido),
      referencia: complementos.limiteHistoricoCentavos,
      unidade: 'CENTAVOS',
      periodo: {
        inicio: boundary,
        fimExclusivo: new Date(Date.parse(boundary) + 86400000).toISOString(),
      },
      limitacoes: ['LIMITE_NAO_COMPROVA_IMPULSIVIDADE'],
    });
  } else if (alvo) indisponiveis.push('V03:VIGENCIA_HISTORICA_NAO_COMPROVADA');
  const sinais = evidencias.filter((e) => e.sinal),
    familias = [...new Set(sinais.map((e) => e.familia))];
  const estado =
    !evidencias.length || !current.length
      ? 'DADOS_INSUFICIENTES'
      : !sinais.length
        ? 'SEM_SINAIS_RELEVANTES'
        : familias.length > 1
          ? 'COMBINACAO_SINAIS_RELEVANTES'
          : 'SINAIS_RELEVANTES';
  const descobertas = sinais.length
    ? [
        {
          id:
            familias.length > 1
              ? 'MUDANCAS_NOS_REGISTROS'
              : 'DIFERENCA_NOS_REGISTROS',
          tipo: 'OBSERVACAO_AUTOMATICA' as const,
          titulo:
            familias.length > 1
              ? 'Diferenças em valores e frequência nos registros'
              : familias[0] === 'VALORES'
                ? 'Valor diferente das referências disponíveis'
                : 'Frequência diferente das referências disponíveis',
          mensagem:
            familias.length > 1
              ? 'Os registros apresentam diferenças de valor e de distribuição ou frequência. Esses sinais não determinam impulsividade.'
              : familias[0] === 'VALORES'
                ? 'O valor ultrapassa uma referência demonstrada nos dados. Isso não determina impulsividade.'
                : 'Há diferença na frequência ou concentração dos registros. Isso não demonstra perda de controle.',
          indicadores: sinais.map((e) => e.indicador),
          familias,
          referencias: sinais.map((e) => ({
            indicador: e.indicador,
            regra: e.regra,
            observado: e.observado,
            referencia: e.referencia,
            amostra: e.amostra,
            periodo: e.periodo,
          })),
        },
      ]
    : [];
  if (input.cobertura !== 'COMPLETA')
    limitacoes.push('COBERTURA_TEMPORAL_NAO_COMPROVADA');
  if (eligible.some((r) => r.origem === 'EMAIL') || alvo?.origem === 'EMAIL')
    limitacoes.push('EMAIL_NAO_COMPROVA_DATA_DA_TRANSACAO');
  if (!complementos.eventos?.disponivel)
    limitacoes.push('EVENTOS_FINANCEIROS_INDISPONIVEIS');
  const resultado = {
    versaoContrato: 1 as const,
    versaoMotor: 'automatico-1' as const,
    estado,
    classificacaoAutomaticaDefinitiva: false as const,
    persistido: false as const,
    escopo: alvo ? 'COMPRA' : 'PERIODO',
    compraId: alvo?.id ?? null,
    periodo: input.periodo,
    janela: { inicio, fimExclusivo: fim },
    qualidadeDados: {
      registrosElegiveis: eligible.length,
      registrosComparados: current.length,
      cobertura: input.cobertura,
      criteriosDisponiveis: evidencias.length,
      criteriosIndisponiveis: indisponiveis,
    },
    evidencias,
    descobertas,
    familiasDeSinais: familias,
    contextoDeclarado: complementos.contexto ?? {
      disponibilidade: 'INDISPONIVEL',
      revisao: 0,
      respostas: {},
    },
    contextualizacao:
      complementos.contexto?.respostas.planejamento === 'SIM'
        ? 'Você informou que a compra foi planejada. Isso contextualiza a decisão e não apaga as observações automáticas.'
        : complementos.contexto?.respostas.planejamento === 'PARCIALMENTE'
          ? 'Você informou planejamento parcial. As observações automáticas permanecem separadas dessa declaração.'
          : complementos.contexto?.respostas.planejamento === 'NAO'
            ? 'Você informou que a compra não estava planejada. Isso não determina impulsividade.'
            : null,
    referenciasFinanceiras: {
      limiteHistoricoCentavos: complementos.limiteHistoricoCentavos ?? null,
      limiteAtualCentavos: complementos.limiteAtualCentavos ?? null,
      referenciaAtualParticipaDosSinais: false,
    },
    eventos: complementos.eventos ?? { disponivel: false },
    limitacoes,
  };
  return {
    ...resultado,
    dependencias: {
      versaoIndicadores: h.versaoIndicadores,
      versaoPoliticaTemporal: h.politicaTemporal.versao,
      fontesHash: createHash('sha256')
        .update(
          JSON.stringify({
            input: {
              ...input,
              referenciaAtual: input.referenciaAtual?.slice(0, 7),
            },
            alvo,
            complementos,
          }),
        )
        .digest('hex'),
    },
  };
}
