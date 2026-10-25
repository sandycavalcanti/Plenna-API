import { z } from 'zod';
import { cents } from '../compra/financeiro.js';
import { SEASONAL_EVENTS } from '../notification/seasonal-calendar.js';
import type { ResultadoHistorico } from './historico.engine.js';
import type { CompraHistorico } from './historico.schemas.js';
import type { ResultadoInterpretacao } from './interpretacao.engine.js';
import { dataElegivel } from './temporal.policy.js';

export const descobertasSchema = z
  .object({
    versao: z.literal('automaticas-1'),
    itens: z
      .array(
        z
          .object({
            codigo: z.string(),
            natureza: z.enum(['REGISTRADO', 'DECLARADO', 'REFERENCIA_ATUAL']),
            titulo: z.string(),
            detalhe: z.string(),
            referencias: z.array(z.string()).min(1),
            grafico: z
              .object({
                unidade: z.enum(['CENTAVOS', 'COMPRAS', 'MINUTOS']),
                pontos: z
                  .array(
                    z.object({
                      rotulo: z.string(),
                      valor: z.number().finite().nonnegative(),
                    }),
                  )
                  .min(2),
              })
              .optional(),
          })
          .strict(),
      )
      .max(3),
    reflexao: z.string().nullable(),
    perguntasSugeridas: z.array(
      z.enum([
        'planejamento',
        'influenciaPromocional',
        'necessidadeInesperada',
      ]),
    ),
    eventosPosteriores: z.array(z.string()),
    limitacoes: z.array(z.string()),
  })
  .strict();
export type Descobertas = z.infer<typeof descobertasSchema>;
type Card = Descobertas['itens'][number];
const money = (n: number) =>
  (n / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const median = (values: number[]) => {
  const a = [...values].sort((a, b) => a - b),
    m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};

/** Usa a faixa interquartil já adotada pelo motor; amostras pequenas ou constantes não sustentam destaque. */
export function faixaValores(values: number[]) {
  if (values.length < 4) return null;
  const a = [...values].sort((a, b) => a - b),
    middle = Math.floor(a.length / 2);
  const q1 = median(a.slice(0, middle)),
    q3 = median(a.slice(Math.ceil(a.length / 2))),
    iqr = q3 - q1;
  return iqr > 0 ? { q1, q3, limiteSuperior: q3 + 1.5 * iqr } : null;
}

export function descobrirCompra({
  historico: h,
  compras: fontes,
  contextual,
  compra,
  eventos = [],
}: {
  historico: ResultadoHistorico;
  compras: CompraHistorico[];
  contextual: ResultadoInterpretacao;
  compra: {
    id: number;
    data: string;
    valorCentavos: number | null;
    limiteAtualCentavos: number | null;
    recorrenciaId: number | null;
    email: boolean;
  };
  eventos?: string[];
}): Descobertas {
  const compras = fontes
    .filter(dataElegivel)
    .filter(
      (r) =>
        Date.parse(r.data!) >= Date.parse(h.janelaHistorico.inicio) &&
        Date.parse(r.data!) < Date.parse(h.observadoAte),
    );
  const cards: Card[] = [],
    groups = new Set<string>(),
    questions: Descobertas['perguntasSugeridas'] = [];
  const add = (group: string, card: Card) => {
    if (!groups.has(group)) {
      groups.add(group);
      cards.push(card);
    }
  };
  const refs = compras.map((r) => `compra:${r.id}`),
    own = `compra:${compra.id}`;
  const knownPlanning = contextual.declaracoes.find(
    (d) => d.campo === 'planejamento',
  );
  const labels: Record<string, string> = {
    CANCELAMENTO: 'Cancelamento informado',
    DEVOLUCAO: 'Devolução informada',
    REEMBOLSO: 'Reembolso informado',
    ARREPENDIMENTO: 'Arrependimento informado',
  };
  if (eventos.length)
    add('EVENTOS', {
      codigo: 'EVENTO_DECLARADO',
      natureza: 'DECLARADO',
      titulo: labels[eventos[eventos.length - 1]!]!,
      detalhe: 'Você atualizou a situação desta compra.',
      referencias: [
        `contexto:${compra.id}:revisao:${contextual.contextoRevisao}`,
      ],
    });
  const values = compras
      .filter((r) => r.valorLiquido !== null)
      .map((r) => cents(r.valorLiquido!)),
    range = faixaValores(values);
  const unusual =
    compra.valorCentavos !== null &&
    range !== null &&
    compra.valorCentavos > range.limiteSuperior;
  if (compra.valorCentavos !== null && values.length >= 2) {
    add('VALORES', {
      codigo: unusual ? 'VALOR_FORA_FAIXA' : 'VALOR_COMPARADO',
      natureza: 'REGISTRADO',
      titulo: money(compra.valorCentavos),
      detalhe: unusual
        ? 'Acima da faixa dos seus registros anteriores.'
        : `Mediana de ${values.length} registros: ${money(median(values))}.`,
      referencias: [own, ...refs],
      grafico: {
        unidade: 'CENTAVOS',
        pontos: [
          { rotulo: 'Esta compra', valor: compra.valorCentavos },
          { rotulo: 'Mediana anterior', valor: median(values) },
          ...(unusual && range
            ? [
                {
                  rotulo: 'Topo da faixa anterior',
                  valor: range.limiteSuperior,
                },
              ]
            : []),
        ],
      },
    });
    if (unusual && !knownPlanning) questions.push('planejamento');
  }
  if (
    compra.valorCentavos !== null &&
    compra.limiteAtualCentavos !== null &&
    compra.limiteAtualCentavos > 0 &&
    compra.valorCentavos > compra.limiteAtualCentavos
  ) {
    // Prefer the concrete user reference over another card about the same amount.
    if (!unusual) {
      const index = cards.findIndex((c) => c.codigo === 'VALOR_COMPARADO');
      if (index >= 0) cards.splice(index, 1);
      groups.delete('VALORES');
    }
    add('VALORES', {
      codigo: 'LIMITE_ATUAL',
      natureza: 'REFERENCIA_ATUAL',
      titulo: money(compra.valorCentavos),
      detalhe: `Sua referência individual atual é ${money(compra.limiteAtualCentavos)}.`,
      referencias: [own, 'perfil:limite-atual'],
      grafico: {
        unidade: 'CENTAVOS',
        pontos: [
          { rotulo: 'Esta compra', valor: compra.valorCentavos },
          { rotulo: 'Referência atual', valor: compra.limiteAtualCentavos },
        ],
      },
    });
    if (!knownPlanning && !questions.includes('planejamento'))
      questions.push('planejamento');
  }
  if (compra.recorrenciaId !== null) {
    const linked = compras.filter(
      (r) => r.recorrenciaId === compra.recorrenciaId,
    );
    const linkedValues = linked
      .filter((r) => r.valorLiquido !== null)
      .map((r) => cents(r.valorLiquido!));
    add('RECORRENCIA', {
      codigo: 'RECORRENCIA_VINCULADA',
      natureza: 'REGISTRADO',
      titulo: 'Vinculada a uma recorrência',
      detalhe: `${linked.length} compra(s) anterior(es) com o mesmo vínculo.`,
      referencias: [own, `recorrencia:${compra.recorrenciaId}`],
      ...(linkedValues.length >= 2 && compra.valorCentavos !== null
        ? {
            grafico: {
              unidade: 'CENTAVOS' as const,
              pontos: [
                { rotulo: 'Esta compra', valor: compra.valorCentavos },
                {
                  rotulo: 'Mediana do mesmo vínculo',
                  valor: median(linkedValues),
                },
              ],
            },
          }
        : {}),
    });
  }
  const day = compra.data.slice(0, 10),
    [year, month, date] = day.split('-').map(Number);
  const seasonal = SEASONAL_EVENTS.find((e) => {
    const d = e.resolveDate(year!);
    return d.month === month && d.day === date;
  });
  // Match an exact registered civil date, not an invented commercial window or cause.
  if (seasonal) {
    const name =
      seasonal.code === 'BLACK_FRIDAY'
        ? 'Black Friday'
        : seasonal.code === 'NATAL'
          ? 'Natal'
          : seasonal.code === 'DIA_DAS_CRIANCAS'
            ? 'Dia das Crianças'
            : 'uma data do calendário comercial';
    add('SAZONALIDADE', {
      codigo: 'DATA_COMERCIAL',
      natureza: 'REGISTRADO',
      titulo: `Data registrada coincide com ${name}`,
      detalhe: compra.email
        ? 'A data do e-mail pode ser da mensagem.'
        : 'A coincidência não indica influência na decisão.',
      referencias: [own, `calendario:${seasonal.code}:${year}`],
    });
    if (
      !contextual.declaracoes.some((d) => d.campo === 'influenciaPromocional')
    )
      questions.push('influenciaPromocional');
  }
  const comp = h.frequencia.comparacao;
  if (comp.disponibilidade === 'DISPONIVEL' && comp.diferenca !== null)
    add('FREQUENCIA', {
      codigo: 'FREQUENCIA_COMPARAVEL',
      natureza: 'REGISTRADO',
      titulo: `${comp.comprasAtual} compras registradas`,
      detalhe: `${comp.diferenca > 0 ? '+' : ''}${comp.diferenca} em janelas equivalentes.`,
      referencias: refs,
      grafico: {
        unidade: 'COMPRAS',
        pontos: [
          { rotulo: 'Trecho anterior', valor: comp.comprasAnterior },
          { rotulo: 'Trecho atual', valor: comp.comprasAtual },
        ],
      },
    });
  if (h.frequencia.maiorConcentracao.comprasPorDia > 1)
    add('FREQUENCIA', {
      codigo: 'CONCENTRACAO_DATAS',
      natureza: 'REGISTRADO',
      titulo: `${h.frequencia.maiorConcentracao.comprasPorDia} compras na mesma data`,
      detalhe: 'Entre os registros anteriores deste mês.',
      referencias: refs,
    });
  if (h.frequencia.compras > 0)
    add('FREQUENCIA', {
      codigo: 'COMPRAS_ANTERIORES_MES',
      natureza: 'REGISTRADO',
      titulo: `${h.frequencia.compras} compra(s) anterior(es) neste mês`,
      detalhe: 'Sem incluir esta compra ou outras do mesmo dia.',
      referencias: refs,
    });
  const categories = h.categorias
    .filter((c) => c.nome && c.comprasAtual + c.comprasHistorico >= 2)
    .sort(
      (a, b) =>
        b.comprasAtual +
          b.comprasHistorico -
          (a.comprasAtual + a.comprasHistorico) ||
        a.categoriaId - b.categoriaId,
    );
  if (categories.length) {
    const top = categories[0]!;
    add('CATEGORIAS', {
      codigo: 'CATEGORIA_REPETIDA',
      natureza: 'REGISTRADO',
      titulo: top.nome!,
      detalhe: `Em ${top.comprasAtual + top.comprasHistorico} compras anteriores registradas.`,
      referencias: refs,
      ...(categories.length >= 2
        ? {
            grafico: {
              unidade: 'COMPRAS' as const,
              pontos: categories
                .slice(0, 5)
                .map((c) => ({
                  rotulo: c.nome!,
                  valor: c.comprasAtual + c.comprasHistorico,
                })),
            },
          }
        : {}),
    });
  }
  if (!cards.length && compra.valorCentavos !== null)
    add('VALORES', {
      codigo: 'VALOR_REGISTRADO',
      natureza: 'REGISTRADO',
      titulo: money(compra.valorCentavos),
      detalhe: 'Valor líquido registrado nesta compra.',
      referencias: [own],
    });
  return descobertasSchema.parse({
    versao: 'automaticas-1',
    itens: cards.slice(0, 3),
    reflexao: unusual ? 'O que ajuda a entender o valor desta compra?' : null,
    perguntasSugeridas: questions,
    eventosPosteriores: eventos,
    limitacoes: [
      'REGISTROS_NAO_COMPROVAM_TODO_CONSUMO',
      'NAO_CLASSIFICA_IMPULSIVIDADE',
      'LIMITES_ATUAIS_SEM_VIGENCIA_HISTORICA',
    ],
  });
}
