import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import {
  businessDateNow,
  buildUpcomingOccurrences,
  formatDateOnly,
  nextOccurrenceOnOrAfter,
  parseDateOnly,
  RECURRENCE_TIMEZONE,
  type RecurrenceFrequency,
} from './recorrencia.calendar.js';
import type {
  CreateRecurrenceDTO,
  RecurrenceItemDTO,
  RecurrenceStatus,
  UpdateRecurrenceDTO,
} from './recorrencia.schemas.js';

const recurrenceInclude = {
  tb_compra_item: {
    where: { compra_id: null, compra_item_ativo: 1 },
    orderBy: { compra_item_id: 'asc' as const },
  },
  tb_forma_pagamento: {
    select: { forma_pagamento_id: true, forma_pagamento_nome: true },
  },
};

function serializeRecurrence(record: any) {
  return {
    id: record.compra_recorrencia_id,
    status: record.compra_recorrencia_status,
    frequencia: record.compra_recorrencia_frequencia,
    primeiraOcorrencia: formatDateOnly(record.compra_recorrencia_primeira_ocorrencia),
    proximaOcorrencia: record.compra_recorrencia_proxima_ocorrencia
      ? formatDateOnly(record.compra_recorrencia_proxima_ocorrencia)
      : null,
    dataFinal: record.compra_recorrencia_data_final
      ? formatDateOnly(record.compra_recorrencia_data_final)
      : null,
    fusoHorario: record.compra_recorrencia_fuso_horario,
    formaPagamentoId: record.forma_pagamento_id,
    formaPagamento: record.tb_forma_pagamento
      ? {
          id: record.tb_forma_pagamento.forma_pagamento_id,
          nome: record.tb_forma_pagamento.forma_pagamento_nome,
        }
      : null,
    compraFonte: record.compra_recorrencia_fonte,
    itens: (record.tb_compra_item ?? []).map((item: any) => ({
      id: item.compra_item_id,
      categoriaId: item.categoria_id,
      nome: item.compra_item_nome,
      valor: Number(item.compra_item_valor),
    })),
    criadoEm: record.compra_recorrencia_data_criacao,
    modificadoEm: record.compra_recorrencia_data_modificacao,
  };
}

function ensureDateOrder(firstOccurrence: Date, endDate: Date | null) {
  if (endDate && endDate < firstOccurrence) {
    throw new AppError('A data final não pode ser anterior à primeira ocorrência', 400);
  }
}

async function validateReferences(tx: any, userId: number, data: { items: RecurrenceItemDTO[]; formaPagamentoId?: number | null }) {
  const categoryIds = [...new Set(data.items.map((item) => item.categoriaId))];
  const categories = await tx.tb_categoria.count({
    where: { categoria_id: { in: categoryIds } },
  });

  if (categories !== categoryIds.length) {
    throw new AppError('Uma ou mais categorias não foram encontradas', 400);
  }

  if (data.formaPagamentoId === undefined || data.formaPagamentoId === null) {
    throw new AppError('Forma de pagamento é obrigatória', 400);
  }

  {
    const paymentMethod = await tx.tb_forma_pagamento.findUnique({
      where: { forma_pagamento_id: data.formaPagamentoId },
      select: { forma_pagamento_id: true },
    });

    if (!paymentMethod) {
      throw new AppError('Forma de pagamento não encontrada', 400);
    }
  }

  // Mantém o parâmetro explícito para que a validação nunca seja adaptada
  // para aceitar um usuário enviado pelo corpo da requisição.
  void userId;
}

async function findOwnedRecurrence(client: any, userId: number, recurrenceId: number) {
  return client.tb_compra_recorrencia.findFirst({
    where: {
      compra_recorrencia_id: recurrenceId,
      usuario_id: userId,
    },
    include: recurrenceInclude,
  });
}

async function lockOwnedRecurrence(client: any, userId: number, recurrenceId: number) {
  const locked = await client.$queryRaw<Array<{ compra_recorrencia_id: number }>>`
    SELECT compra_recorrencia_id
    FROM public.tb_compra_recorrencia
    WHERE compra_recorrencia_id = ${recurrenceId}
      AND usuario_id = ${userId}
    FOR UPDATE
  `;
  if (locked.length === 0) return null;
  return findOwnedRecurrence(client, userId, recurrenceId);
}

function itemCreateData(recurrenceId: number, items: RecurrenceItemDTO[]) {
  return items.map((item) => ({
    compra_id: null,
    compra_recorrencia_id: recurrenceId,
    categoria_id: item.categoriaId,
    compra_item_nome: item.nome,
    compra_item_valor: item.valor,
  }));
}

export class RecorrenciaService {
  static async create(userId: number, data: CreateRecurrenceDTO) {
    const firstOccurrence = parseDateOnly(data.primeiraOcorrencia, 'primeiraOcorrencia');
    const endDate = data.dataFinal ? parseDateOnly(data.dataFinal, 'dataFinal') : null;
    ensureDateOrder(firstOccurrence, endDate);

    const record = await prisma.$transaction(async (tx) => {
      const user = await tx.tb_usuario.findFirst({
        where: { usuario_id: userId, usuario_status: true },
        select: { usuario_id: true },
      });

      if (!user) throw new AppError('Usuário não encontrado', 404);
      await validateReferences(tx, userId, data);

      const recurrence = await tx.tb_compra_recorrencia.create({
        data: {
          usuario_id: userId,
          forma_pagamento_id: data.formaPagamentoId,
          compra_recorrencia_fonte: data.compraFonte ?? null,
          compra_recorrencia_frequencia: data.frequencia as RecurrenceFrequency,
          compra_recorrencia_status: 'ATIVA',
          compra_recorrencia_primeira_ocorrencia: firstOccurrence,
          compra_recorrencia_proxima_ocorrencia: firstOccurrence,
          compra_recorrencia_data_final: endDate,
          compra_recorrencia_fuso_horario: RECURRENCE_TIMEZONE,
          compra_recorrencia_data_modificacao: new Date(),
        },
      });

      await tx.tb_compra_item.createMany({
        data: itemCreateData(recurrence.compra_recorrencia_id, data.items),
      });

      return findOwnedRecurrence(tx, userId, recurrence.compra_recorrencia_id);
    });

    return serializeRecurrence(record);
  }

  static async findAll(userId: number, status?: RecurrenceStatus) {
    const records = await prisma.tb_compra_recorrencia.findMany({
      where: {
        usuario_id: userId,
        ...(status ? { compra_recorrencia_status: status } : {}),
      },
      include: recurrenceInclude,
      orderBy: { compra_recorrencia_data_criacao: 'desc' },
    });

    return records.map(serializeRecurrence);
  }

  static async findById(userId: number, recurrenceId: number) {
    const record = await findOwnedRecurrence(prisma, userId, recurrenceId);
    if (!record) throw new AppError('Recorrência não encontrada', 404);
    return serializeRecurrence(record);
  }

  static async update(userId: number, recurrenceId: number, data: UpdateRecurrenceDTO) {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await lockOwnedRecurrence(tx, userId, recurrenceId);
      if (!existing) throw new AppError('Recorrência não encontrada', 404);

      if (existing.compra_recorrencia_status === 'CANCELADA' || existing.compra_recorrencia_status === 'FINALIZADA') {
        throw new AppError('Recorrência não pode mais ser editada', 409);
      }

      const firstOccurrence = data.primeiraOcorrencia
        ? parseDateOnly(data.primeiraOcorrencia, 'primeiraOcorrencia')
        : parseDateOnly(existing.compra_recorrencia_primeira_ocorrencia, 'primeiraOcorrencia');
      const endDate = Object.prototype.hasOwnProperty.call(data, 'dataFinal')
        ? (data.dataFinal ? parseDateOnly(data.dataFinal, 'dataFinal') : null)
        : (existing.compra_recorrencia_data_final
          ? parseDateOnly(existing.compra_recorrencia_data_final, 'dataFinal')
          : null);
      const frequency = (data.frequencia ?? existing.compra_recorrencia_frequencia) as RecurrenceFrequency;
      ensureDateOrder(firstOccurrence, endDate);

      const scheduleChanged = data.frequencia !== undefined
        || data.primeiraOcorrencia !== undefined;

      if (scheduleChanged) {
        const generatedPurchases = await tx.tb_compra.count({
          where: { usuario_id: userId, compra_recorrencia_id: recurrenceId },
        });

        if (generatedPurchases > 0) {
          throw new AppError('Frequência e primeira ocorrência não podem ser alteradas após uma compra gerada', 409);
        }
      }

      if (data.items) {
        await validateReferences(tx, userId, {
          items: data.items,
          formaPagamentoId: data.formaPagamentoId ?? existing.forma_pagamento_id,
        });
        await tx.tb_compra_item.updateMany({
          where: {
            compra_recorrencia_id: recurrenceId,
            compra_id: null,
            compra_item_ativo: 1,
          },
          data: {
            compra_item_ativo: 0,
            compra_item_excluido_em: new Date(),
          },
        });
        await tx.tb_compra_item.createMany({
          data: itemCreateData(recurrenceId, data.items),
        });
      } else if (data.formaPagamentoId !== undefined) {
        await validateReferences(tx, userId, {
          items: existing.tb_compra_item.map((item: any) => ({
            categoriaId: item.categoria_id,
            nome: item.compra_item_nome,
            valor: Number(item.compra_item_valor),
          })),
          formaPagamentoId: data.formaPagamentoId ?? existing.forma_pagamento_id,
        });
      }

      let nextOccurrence = existing.compra_recorrencia_proxima_ocorrencia
        ? parseDateOnly(existing.compra_recorrencia_proxima_ocorrencia, 'proximaOcorrencia')
        : null;
      let nextStatus = existing.compra_recorrencia_status;

      if (existing.compra_recorrencia_status === 'ATIVA') {
        if (scheduleChanged) {
          nextOccurrence = nextOccurrenceOnOrAfter(frequency, firstOccurrence, endDate, businessDateNow());
        } else if (!nextOccurrence || (endDate && nextOccurrence > endDate)) {
          nextOccurrence = nextOccurrenceOnOrAfter(frequency, firstOccurrence, endDate, businessDateNow());
        }

        if (!nextOccurrence) nextStatus = 'FINALIZADA';
      } else {
        nextOccurrence = null;
      }

      const updated = await tx.tb_compra_recorrencia.update({
        where: { compra_recorrencia_id: recurrenceId },
        data: {
          ...(data.formaPagamentoId !== undefined ? { forma_pagamento_id: data.formaPagamentoId } : {}),
          ...(data.compraFonte !== undefined ? { compra_recorrencia_fonte: data.compraFonte } : {}),
          ...(scheduleChanged ? {
            compra_recorrencia_frequencia: frequency,
            compra_recorrencia_primeira_ocorrencia: firstOccurrence,
          } : {}),
          compra_recorrencia_proxima_ocorrencia: nextOccurrence,
          compra_recorrencia_data_final: endDate,
          compra_recorrencia_status: nextStatus,
          compra_recorrencia_data_modificacao: new Date(),
        },
        include: recurrenceInclude,
      });

      return updated;
    });

    return serializeRecurrence(result);
  }

  static async pause(userId: number, recurrenceId: number) {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await lockOwnedRecurrence(tx, userId, recurrenceId);
      if (!existing) throw new AppError('Recorrência não encontrada', 404);
      if (existing.compra_recorrencia_status === 'PAUSADA') return existing;
      if (existing.compra_recorrencia_status !== 'ATIVA') {
        throw new AppError('Apenas recorrências ativas podem ser pausadas', 409);
      }

      return tx.tb_compra_recorrencia.update({
        where: { compra_recorrencia_id: recurrenceId },
        data: {
          compra_recorrencia_status: 'PAUSADA',
          compra_recorrencia_proxima_ocorrencia: null,
          compra_recorrencia_data_modificacao: new Date(),
        },
        include: recurrenceInclude,
      });
    });

    return serializeRecurrence(result);
  }

  static async resume(userId: number, recurrenceId: number) {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await lockOwnedRecurrence(tx, userId, recurrenceId);
      if (!existing) throw new AppError('Recorrência não encontrada', 404);
      if (existing.compra_recorrencia_status === 'ATIVA') return existing;
      if (existing.compra_recorrencia_status !== 'PAUSADA') {
        throw new AppError('Apenas recorrências pausadas podem ser retomadas', 409);
      }

      const firstOccurrence = parseDateOnly(existing.compra_recorrencia_primeira_ocorrencia, 'primeiraOcorrencia');
      const endDate = existing.compra_recorrencia_data_final
        ? parseDateOnly(existing.compra_recorrencia_data_final, 'dataFinal')
        : null;
      const nextOccurrence = nextOccurrenceOnOrAfter(
        existing.compra_recorrencia_frequencia as RecurrenceFrequency,
        firstOccurrence,
        endDate,
        businessDateNow(),
      );

      return tx.tb_compra_recorrencia.update({
        where: { compra_recorrencia_id: recurrenceId },
        data: {
          compra_recorrencia_status: nextOccurrence ? 'ATIVA' : 'FINALIZADA',
          compra_recorrencia_proxima_ocorrencia: nextOccurrence,
          compra_recorrencia_data_modificacao: new Date(),
        },
        include: recurrenceInclude,
      });
    });

    return serializeRecurrence(result);
  }

  static async cancel(userId: number, recurrenceId: number) {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await lockOwnedRecurrence(tx, userId, recurrenceId);
      if (!existing) throw new AppError('Recorrência não encontrada', 404);
      if (existing.compra_recorrencia_status === 'CANCELADA') return existing;
      if (existing.compra_recorrencia_status === 'FINALIZADA') {
        throw new AppError('Recorrência já foi finalizada', 409);
      }

      return tx.tb_compra_recorrencia.update({
        where: { compra_recorrencia_id: recurrenceId },
        data: {
          compra_recorrencia_status: 'CANCELADA',
          compra_recorrencia_proxima_ocorrencia: null,
          compra_recorrencia_data_modificacao: new Date(),
        },
        include: recurrenceInclude,
      });
    });

    return serializeRecurrence(result);
  }

  static async upcoming(userId: number, recurrenceId: number, limit: number) {
    const record = await findOwnedRecurrence(prisma, userId, recurrenceId);
    if (!record) throw new AppError('Recorrência não encontrada', 404);

    if (record.compra_recorrencia_status !== 'ATIVA') {
      return { recorrenciaId: recurrenceId, ocorrencias: [] };
    }

    const firstOccurrence = parseDateOnly(record.compra_recorrencia_primeira_ocorrencia, 'primeiraOcorrencia');
    const endDate = record.compra_recorrencia_data_final
      ? parseDateOnly(record.compra_recorrencia_data_final, 'dataFinal')
      : null;
    const fromDate = record.compra_recorrencia_proxima_ocorrencia
      ? parseDateOnly(record.compra_recorrencia_proxima_ocorrencia, 'proximaOcorrencia')
      : firstOccurrence;
    const dates = buildUpcomingOccurrences(
      record.compra_recorrencia_frequencia as RecurrenceFrequency,
      firstOccurrence,
      endDate,
      limit,
      fromDate,
    );

    return {
      recorrenciaId: recurrenceId,
      ocorrencias: dates.map((date) => ({
        dataPrevista: formatDateOnly(date),
        status: 'PROGRAMADA',
      })),
    };
  }
}

