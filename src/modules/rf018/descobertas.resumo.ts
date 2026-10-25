import type { ResultadoHistorico } from './historico.engine.js';

export type DescobertaResumo = {
  id: string;
  tipo: 'REGISTRADO' | 'DECLARADO';
  origem: 'RF018';
  titulo: string;
  informacao: string;
  evidencias: string[];
  relevancia: number;
  periodo: string;
  compraId: null;
  acao: { destino: 'COMPRAS' | 'DASHBOARD'; filtro?: string };
  limitacoes: string[];
};

/** Presentation only: all calculations and eligibility decisions come from the existing engine. */
export function apresentarDescobertas(
  h: ResultadoHistorico,
): DescobertaResumo[] {
  const items: DescobertaResumo[] = [];
  const add = (
    id: string,
    tipo: DescobertaResumo['tipo'],
    titulo: string,
    informacao: string,
    evidencias: string[],
    relevancia: number,
  ) =>
    items.push({
      id,
      tipo,
      origem: 'RF018',
      titulo,
      informacao,
      evidencias,
      relevancia,
      periodo: h.periodo,
      compraId: null,
      acao: { destino: 'DASHBOARD' },
      limitacoes: [
        'SOMENTE_REGISTROS_DISPONIVEIS',
        ...(h.qualidade.cobertura === 'COMPLETA'
          ? []
          : ['COBERTURA_PARCIAL_OU_DESCONHECIDA']),
      ],
    });
  const f = h.frequencia.comparacao;
  if (
    f.disponibilidade !== 'INDISPONIVEL' &&
    f.diferenca !== null &&
    f.diferenca !== 0
  )
    add(
      'FREQUENCIA',
      'REGISTRADO',
      'Compras em períodos comparáveis',
      `${f.comprasAtual} agora · ${f.comprasAnterior} antes, em ${f.diasComparados.toLocaleString('pt-BR')} dias.`,
      ['frequencia.comparacao'],
      1,
    );
  if (h.recorrencias.comprasVinculadasAtual > 0)
    add(
      'RECORRENCIAS',
      'REGISTRADO',
      'Recorrências registradas',
      `${h.recorrencias.comprasVinculadasAtual} compra(s) vinculada(s) a recorrências neste mês.`,
      ['recorrencias.comprasVinculadasAtual'],
      2,
    );
  const repetidas = h.categorias.filter(
    (c) => c.repeticaoObservada && c.comprasAtual > 0 && c.comprasHistorico > 0,
  );
  if (repetidas.length)
    add(
      'CATEGORIAS',
      'REGISTRADO',
      'Categorias que voltaram a aparecer',
      `${repetidas.length} categoria(s) deste mês também aparecem nos registros anteriores.`,
      ['categorias.repeticaoObservada'],
      3,
    );
  if (h.planejamento.conhecidas > 0)
    add(
      'PLANEJAMENTO',
      'DECLARADO',
      'Você contou sobre seus planos',
      `${h.planejamento.contagens.SIM} planejada(s) entre ${h.planejamento.conhecidas} respostas conhecidas.`,
      ['planejamento.contagens', 'planejamento.conhecidas'],
      3,
    );
  if (
    h.influenciaPromocional.conhecidas > 0 &&
    h.influenciaPromocional.influenciaDeclarada > 0
  )
    add(
      'PROMOCAO',
      'DECLARADO',
      'Influência que você informou',
      `Promoções influenciaram ${h.influenciaPromocional.influenciaDeclarada} de ${h.influenciaPromocional.conhecidas} respostas conhecidas.`,
      ['influenciaPromocional'],
      4,
    );
  return items.sort((a, b) => a.relevancia - b.relevancia).slice(0, 2);
}
