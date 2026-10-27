import { z } from 'zod';
import type { ResultadoHistorico } from './historico.engine.js';
import type { CompraHistorico } from './historico.schemas.js';

export const reflexoesHistoricasSchema = z
  .object({
    versaoRegras: z.literal('reflexoes-historicas-1'),
    estado: z.enum(['COM_REFLEXOES', 'DADOS_INSUFICIENTES']),
    itens: z.array(
      z
        .object({
          codigo: z.enum([
            'FREQUENCIA',
            'DISTRIBUICAO',
            'VALORES',
            'CATEGORIAS',
            'PLANEJAMENTO',
            'PROMOCAO',
            'RECORRENCIAS',
          ]),
          natureza: z.enum(['REGISTRADO', 'DECLARADO', 'CONFIGURACAO_ATUAL']),
          observacao: z.string(),
          reflexao: z.string(),
          referencias: z.array(z.string()).min(1),
          indicadores: z.array(z.string()).min(1),
        })
        .strict(),
    ),
    limitacoes: z.array(z.string()),
  })
  .strict();
export type ReflexoesHistoricas = z.infer<typeof reflexoesHistoricasSchema>;
type ValueComparison = {
  compraId?: number;
  amostra: number;
  valorLiquidoCentavos: number | null;
  medianaHistoricaCentavos: number | null;
  disponibilidade: string;
};
const money = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Evidence-bound prompts, never trends, scores or automatic assessments. */
export function refletirHistorico(
  h: ResultadoHistorico,
  compras: CompraHistorico[],
  valor: ValueComparison,
): ReflexoesHistoricas {
  const items: ReflexoesHistoricas['itens'] = [];
  const refs = compras.map((c) => `compra:${c.id}`);
  const limitations = [
    'SOMENTE_REGISTROS_DISPONIVEIS',
    'NAO_DEMONSTRA_TENDENCIA_NEM_CAUSA',
    'NAO_CLASSIFICA_IMPULSIVIDADE',
    ...(h.qualidade.cobertura !== 'COMPLETA' ? ['COBERTURA_NAO_COMPLETA'] : []),
  ];
  if (compras.length < 2)
    return reflexoesHistoricasSchema.parse({
      versaoRegras: 'reflexoes-historicas-1',
      estado: 'DADOS_INSUFICIENTES',
      itens: [],
      limitacoes: [...limitations, 'MENOS_DE_DUAS_COMPRAS_ANTERIORES'],
    });
  const add = (item: ReflexoesHistoricas['itens'][number]) => items.push(item);
  const frequency = h.frequencia.comparacao;
  if (
    frequency.disponibilidade !== 'INDISPONIVEL' &&
    frequency.comprasAnterior > 0 &&
    frequency.comprasAtual > 0
  )
    add({
      codigo: 'FREQUENCIA',
      natureza: 'REGISTRADO',
      observacao: `Em janelas de ${frequency.diasComparados.toLocaleString('pt-BR')} dias, há ${frequency.comprasAtual} compra(s) registrada(s) no trecho atual e ${frequency.comprasAnterior} no anterior. Isso não demonstra uma tendência.`,
      reflexao:
        'Que circunstâncias ajudam a entender as compras nesses dois trechos?',
      referencias: refs,
      indicadores: ['frequencia.comparacao'],
    });
  if (h.frequencia.maiorConcentracao.comprasPorDia > 1)
    add({
      codigo: 'DISTRIBUICAO',
      natureza: 'REGISTRADO',
      observacao: `No trecho observado do mês desta compra, há dia(s) com ${h.frequencia.maiorConcentracao.comprasPorDia} compras registradas. As datas não comprovam horários exatos.`,
      reflexao:
        'Essas compras estavam relacionadas a alguma ocasião ou necessidade?',
      referencias: refs,
      indicadores: [
        'frequencia.distribuicaoDiaria',
        'frequencia.maiorConcentracao',
      ],
    });
  if (
    valor.disponibilidade !== 'INDISPONIVEL' &&
    valor.amostra >= 2 &&
    valor.valorLiquidoCentavos !== null &&
    valor.medianaHistoricaCentavos !== null
  )
    add({
      codigo: 'VALORES',
      natureza: 'REGISTRADO',
      observacao: `Esta compra tem valor registrado de ${money(valor.valorLiquidoCentavos)}. A mediana de ${valor.amostra} compras anteriores com valor conhecido é ${money(valor.medianaHistoricaCentavos)}. A diferença, por si só, não determina comportamento.`,
      reflexao:
        'O valor desta compra corresponde ao que você pretendia gastar?',
      referencias: [
        ...refs,
        ...(valor.compraId ? [`compra:${valor.compraId}`] : []),
      ],
      indicadores: ['comparacaoValorCompra'],
    });
  const repeated = h.categorias.filter((c) => c.repeticaoObservada);
  if (repeated.length)
    add({
      codigo: 'CATEGORIAS',
      natureza: 'REGISTRADO',
      observacao: `${repeated.length} categoria(s) aparecem em mais de uma compra anterior registrada. Repetição de categoria não comprova recorrência cadastrada.`,
      reflexao:
        'Essa repetição se relaciona com necessidades ou planos que continuam presentes?',
      referencias: refs,
      indicadores: ['categorias'],
    });
  const planning = { SIM: 0, PARCIALMENTE: 0, NAO: 0 };
  const promotion = { SIM: 0, NAO: 0 };
  const planningRefs: string[] = [],
    promotionRefs: string[] = [];
  for (const c of compras) {
    const p = c.contexto?.respostas.planejamento,
      promo = c.contexto?.respostas.influenciaPromocional;
    if (p === 'SIM' || p === 'PARCIALMENTE' || p === 'NAO') {
      planning[p]++;
      planningRefs.push(
        `contexto:${c.id}:revisao:${c.contexto!.revisao}:planejamento`,
      );
    }
    if (promo === 'SIM' || promo === 'NAO') {
      promotion[promo]++;
      promotionRefs.push(
        `contexto:${c.id}:revisao:${c.contexto!.revisao}:influenciaPromocional`,
      );
    }
  }
  if (planningRefs.length)
    add({
      codigo: 'PLANEJAMENTO',
      natureza: 'DECLARADO',
      observacao: `Entre ${planningRefs.length} respostas conhecidas de planejamento: ${planning.SIM} planejada(s), ${planning.PARCIALMENTE} parcialmente planejada(s) e ${planning.NAO} não planejada(s). Respostas ausentes, recusadas ou incertas não entram nessa contagem.`,
      reflexao:
        'O que facilitou ou dificultou seguir seus planos nessas compras?',
      referencias: planningRefs,
      indicadores: ['planejamento', 'planejamento.historico'],
    });
  if (promotionRefs.length)
    add({
      codigo: 'PROMOCAO',
      natureza: 'DECLARADO',
      observacao: `Influência promocional foi informada em ${promotion.SIM} de ${promotionRefs.length} respostas conhecidas. Essa informação vem das declarações, não dos descontos registrados.`,
      reflexao:
        'Como você gostaria de considerar promoções em suas próximas decisões?',
      referencias: promotionRefs,
      indicadores: ['influenciaPromocional', 'influenciaPromocional.historico'],
    });
  if (h.recorrencias.cadastradas > 0)
    add({
      codigo: 'RECORRENCIAS',
      natureza: 'CONFIGURACAO_ATUAL',
      observacao: `Há ${h.recorrencias.cadastradas} recorrência(s) cadastrada(s) na configuração atual. Isso não reconstrói os estados anteriores nem determina impulsividade.`,
      reflexao:
        'As recorrências cadastradas ainda correspondem às suas necessidades?',
      referencias: ['recorrencias:configuracao-atual'],
      indicadores: ['recorrencias'],
    });
  return reflexoesHistoricasSchema.parse({
    versaoRegras: 'reflexoes-historicas-1',
    estado: items.length ? 'COM_REFLEXOES' : 'DADOS_INSUFICIENTES',
    itens: items,
    limitacoes: limitations,
  });
}
