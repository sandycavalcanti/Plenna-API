import { Prisma } from '@prisma/client';
import { AppError } from '../../errors/AppError.js';
import type { EventoCompraDTO } from './eventos.schemas.js';
export type EventoRegistro = {
  evento_id: number;
  compra_item_id: number | null;
  tipo: string;
  dados: unknown;
  corrige_evento_id: number | null;
  anulado: boolean;
  revisao: number;
  efetiva_em: Date | null;
};
export function eventosVigentes(rows: EventoRegistro[]) {
  const corrected = new Set(
    rows.flatMap((e) =>
      e.corrige_evento_id === null ? [] : [e.corrige_evento_id],
    ),
  );
  return rows.filter((e) => !corrected.has(e.evento_id) && !e.anulado);
}
export function resumirEventos(rows: EventoRegistro[]) {
  const atuais = eventosVigentes(rows),
    refunds = atuais.filter((e) => e.tipo === 'REEMBOLSO');
  const total = refunds.reduce(
    (n, e) => n + Number((e.dados as { valorCentavos: number }).valorCentavos),
    0,
  );
  const last = (tipo: string, itemId: number | null) =>
    atuais
      .filter((e) => e.tipo === tipo && e.compra_item_id === itemId)
      .sort((a, b) => b.revisao - a.revisao)[0];
  const hidden = last('OCULTACAO', null);
  const classification = last('CLASSIFICACAO', null);
  return {
    revisao: rows.reduce((n, e) => Math.max(n, e.revisao), 0),
    reembolsadoCentavos: total,
    reembolsosSemData: refunds.filter((e) => !e.efetiva_em).length,
    oculto: hidden ? (hidden.dados as { oculto: boolean }).oculto : false,
    itensOcultos: [
      ...new Set(
        atuais.flatMap((e) =>
          e.compra_item_id === null ? [] : [e.compra_item_id],
        ),
      ),
    ].filter((id) => {
      const e = last('OCULTACAO', id);
      return e && (e.dados as { oculto: boolean }).oculto;
    }),
    classificacao: classification
      ? (classification.dados as { classificacao: string }).classificacao
      : null,
    cancelamentos: atuais.filter((e) => e.tipo === 'CANCELAMENTO').length,
    devolucoes: atuais.filter((e) => e.tipo === 'DEVOLUCAO').length,
  };
}
export function validarEventoFinanceiro(
  data: EventoCompraDTO,
  rows: EventoRegistro[],
  compra: {
    valorCentavos: number | null;
    itens: {
      id: number;
      quantidade: number | null;
      valorUnitarioCentavos: number;
    }[];
  },
  now: Date,
) {
  if (data.dataEfetiva && data.dataEfetiva > now.toISOString().slice(0, 10))
    throw new AppError('A data do evento não pode estar no futuro', 400);
  if (data.anulado && !data.corrigeEventoId)
    throw new AppError('Selecione o evento que deseja corrigir', 400);
  const target = data.corrigeEventoId
    ? rows.find((e) => e.evento_id === data.corrigeEventoId)
    : null;
  if (
    data.corrigeEventoId &&
    (!target ||
      target.tipo !== data.tipo ||
      target.compra_item_id !== (data.itemId ?? null) ||
      rows.some((e) => e.corrige_evento_id === target.evento_id) ||
      ['EXCLUSAO_REGISTRO', 'CLASSIFICACAO', 'OCULTACAO'].includes(target.tipo))
  )
    throw new AppError('Evento indisponível para esta correção', 409);
  const current = eventosVigentes(rows).filter(
    (e) => e.evento_id !== target?.evento_id,
  );
  if (data.itemId && !compra.itens.some((i) => i.id === data.itemId))
    throw new AppError('Item não encontrado nesta compra', 404);
  if (data.tipo === 'CLASSIFICACAO' && data.itemId)
    throw new AppError('A classificação é da compra inteira', 400);
  if (data.tipo === 'REEMBOLSO' && !data.anulado) {
    const previous = current
      .filter((e) => e.tipo === 'REEMBOLSO')
      .reduce(
        (n, e) =>
          n + Number((e.dados as { valorCentavos: number }).valorCentavos),
        0,
      );
    if (compra.valorCentavos === null)
      throw new AppError(
        'Informe o valor da compra antes de registrar reembolso',
        422,
      );
    if (previous + data.valorCentavos > compra.valorCentavos)
      throw new AppError(
        'Os reembolsos ultrapassam o valor registrado da compra',
        422,
      );
  }
  if (
    (data.tipo === 'DEVOLUCAO' || data.tipo === 'CANCELAMENTO') &&
    !data.anulado
  ) {
    if (
      current.some(
        (e) =>
          e.tipo === data.tipo &&
          (e.compra_item_id === null || data.itemId === undefined),
      )
    )
      throw new AppError(
        'Já existe um evento deste tipo. Corrija o registro anterior ou informe a quantidade restante por item',
        409,
      );
    if (data.itemId) {
      const item = compra.itens.find((i) => i.id === data.itemId)!;
      if (data.quantidade !== undefined) {
        if (item.quantidade === null)
          throw new AppError(
            'A quantidade original deste item não foi informada',
            422,
          );
        const previous = current.filter(
          (e) => e.tipo === data.tipo && e.compra_item_id === data.itemId,
        );
        if (
          previous.some(
            (e) =>
              (e.dados as { quantidade?: number }).quantidade === undefined,
          )
        )
          throw new AppError('O item já tem um evento total deste tipo', 409);
        const quantity = previous
          .reduce(
            (n, e) => n.add((e.dados as { quantidade: number }).quantidade),
            new Prisma.Decimal(0),
          )
          .add(data.quantidade);
        if (quantity.gt(item.quantidade))
          throw new AppError('A quantidade supera os itens registrados', 422);
      } else if (
        current.some(
          (e) => e.tipo === data.tipo && e.compra_item_id === data.itemId,
        )
      )
        throw new AppError(
          'Corrija o evento existente antes de informar o total',
          409,
        );
    } else if (data.quantidade !== undefined)
      throw new AppError(
        'Selecione um item para informar quantidade parcial',
        400,
      );
  }
}
