import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import {
  goalMovementInputSchema,
  goalMovementListQuerySchema,
  type GoalMovementInput,
} from './goal.schemas.js';

const MAX_MONEY = new Prisma.Decimal('99999999.99');
const ZERO = new Prisma.Decimal(0);

export type GoalMovementErrorCode =
  | 'META_NAO_ENCONTRADA'
  | 'SALDO_INSUFICIENTE'
  | 'SALDO_LIMITE_EXCEDIDO'
  | 'OPERACAO_REUTILIZADA'
  | 'DADOS_INVALIDOS';

export class GoalMovementError extends AppError {
  constructor(
    public readonly code: GoalMovementErrorCode,
    message: string,
    statusCode: number,
  ) {
    super(message, statusCode);
  }
}

type GoalMovementDatabase = any;

function decimal(value: unknown) {
  return new Prisma.Decimal(value === null || value === undefined ? 0 : String(value));
}

function money(value: unknown) {
  return decimal(value).toFixed(2);
}

function serializeMovement(row: any) {
  return {
    meta_movimentacao_id: row.meta_movimentacao_id,
    meta_id: row.meta_id,
    meta_movimentacao_operacao_id: row.meta_movimentacao_operacao_id,
    meta_movimentacao_tipo: row.meta_movimentacao_tipo,
    meta_movimentacao_valor: money(row.meta_movimentacao_valor),
    meta_movimentacao_data: new Date(row.meta_movimentacao_data).toISOString(),
  };
}

function buildSavingsSummary(goal: any, latest: any | null, lastDeposit: any | null) {
  const target = decimal(goal.meta_valor);
  const reserved = decimal(goal.meta_valor_reservado);
  const safeReserved = reserved.isNegative() ? ZERO : reserved;
  const remaining = target.minus(safeReserved);
  const progress = target.greaterThan(0)
    ? safeReserved
      .div(target)
      .mul(100)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      .toNumber()
    : 0;

  return {
    meta_id: goal.meta_id,
    meta_valor: money(target),
    meta_valor_reservado: money(safeReserved),
    progresso_percentual: progress,
    valor_restante: money(remaining.isNegative() ? ZERO : remaining),
    ultima_movimentacao: latest ? serializeMovement(latest) : null,
    ultimo_deposito: lastDeposit ? serializeMovement(lastDeposit) : null,
  };
}

async function findLatestMovement(db: GoalMovementDatabase, goalId: number, type?: 'DEPOSITO' | 'RETIRADA') {
  const where = {
    meta_id: goalId,
    ...(type ? { meta_movimentacao_tipo: type } : {}),
  };
  if (typeof db.tb_meta_movimentacao.findFirst === 'function') {
    return db.tb_meta_movimentacao.findFirst({
      where,
      orderBy: [{ meta_movimentacao_data: 'desc' }, { meta_movimentacao_id: 'desc' }],
    });
  }

  // Fallback apenas para doubles de teste antigos que ainda nao implementam findFirst.
  const movements = await db.tb_meta_movimentacao.findMany({
    where: { meta_id: goalId },
    orderBy: [{ meta_movimentacao_data: 'desc' }, { meta_movimentacao_id: 'desc' }],
  });
  return movements.find((movement: any) => !type || movement.meta_movimentacao_tipo === type) ?? null;
}

async function summaryForGoal(db: GoalMovementDatabase, goal: any) {
  const [latest, lastDeposit] = await Promise.all([
    findLatestMovement(db, goal.meta_id),
    findLatestMovement(db, goal.meta_id, 'DEPOSITO'),
  ]);
  return buildSavingsSummary(
    goal,
    latest,
    lastDeposit,
  );
}

async function findLatestPerGoal(
  db: GoalMovementDatabase,
  goalIds: number[],
  type?: 'DEPOSITO' | 'RETIRADA',
) {
  // DISTINCT ON consulta somente uma linha por meta no PostgreSQL, evitando
  // carregar o historico completo na listagem de metas.
  if (typeof db.tb_meta_movimentacao.findFirst === 'function' && typeof db.$queryRaw === 'function') {
    const typeFilter = type
      ? Prisma.sql`AND m.meta_movimentacao_tipo = ${type}`
      : Prisma.empty;
    return db.$queryRaw(Prisma.sql`
      SELECT DISTINCT ON (m.meta_id)
        m.meta_movimentacao_id,
        m.meta_id,
        m.meta_movimentacao_operacao_id,
        m.meta_movimentacao_tipo,
        m.meta_movimentacao_valor,
        m.meta_movimentacao_data
      FROM public.tb_meta_movimentacao AS m
      WHERE m.meta_id IN (${Prisma.join(goalIds)})
        ${typeFilter}
      ORDER BY m.meta_id ASC, m.meta_movimentacao_data DESC, m.meta_movimentacao_id DESC
    `);
  }

  // Fallback para doubles de teste sem suporte a queryRaw/first.
  const movements = await db.tb_meta_movimentacao.findMany({
    where: { meta_id: { in: goalIds } },
    orderBy: [{ meta_id: 'asc' }, { meta_movimentacao_data: 'desc' }, { meta_movimentacao_id: 'desc' }],
  });
  const result = new Map<number, any>();
  for (const movement of movements) {
    if (type && movement.meta_movimentacao_tipo !== type) continue;
    if (!result.has(movement.meta_id)) result.set(movement.meta_id, movement);
  }
  return [...result.values()];
}

function encodeCursor(metaId: number, movement: any) {
  return Buffer.from(JSON.stringify({
    meta_id: metaId,
    data: new Date(movement.meta_movimentacao_data).toISOString(),
    id: movement.meta_movimentacao_id,
  })).toString('base64url');
}

function decodeCursor(raw: string, metaId: number) {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      meta_id?: unknown;
      data?: unknown;
      id?: unknown;
    };
    const parsed = {
      meta_id: Number(value.meta_id),
      data: new Date(String(value.data)),
      id: Number(value.id),
    };
    if (
      !Number.isInteger(parsed.meta_id)
      || parsed.meta_id !== metaId
      || !Number.isInteger(parsed.id)
      || parsed.id <= 0
      || !Number.isFinite(parsed.data.getTime())
    ) {
      throw new Error('INVALID_CURSOR');
    }
    return parsed;
  } catch {
    throw new GoalMovementError('DADOS_INVALIDOS', 'Cursor de movimentações inválido', 400);
  }
}

function assertUserId(userId: number) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AppError('Usuário autenticado inválido', 401);
  }
}

function notFound() {
  return new GoalMovementError('META_NAO_ENCONTRADA', 'Meta não encontrada', 404);
}

function operationConflict() {
  return new GoalMovementError(
    'OPERACAO_REUTILIZADA',
    'Operação já utilizada com outros dados',
    409,
  );
}

function sameOperation(existing: any, input: GoalMovementInput) {
  return (
    existing.meta_movimentacao_tipo === input.tipo
    && decimal(existing.meta_movimentacao_valor).eq(decimal(input.valor))
  );
}

export class GoalMovementService {
  static async create(
    userId: number,
    goalId: number,
    rawInput: unknown,
    database: GoalMovementDatabase = prisma,
  ) {
    assertUserId(userId);
    if (!Number.isInteger(goalId) || goalId <= 0) throw notFound();
    const input = goalMovementInputSchema.parse(rawInput);
    const value = decimal(input.valor);

    try {
      return await database.$transaction(async (tx: GoalMovementDatabase) => {
        const locked = await tx.$queryRaw<Array<{ meta_id: number }>>`
          SELECT meta_id
          FROM public.tb_meta
          WHERE meta_id = ${goalId}
            AND usuario_id = ${userId}
          FOR UPDATE
        `;
        if (!locked.length) throw notFound();

        const goal = await tx.tb_meta.findUnique({ where: { meta_id: goalId } });
        if (!goal || goal.usuario_id !== userId) throw notFound();

        const existing = await tx.tb_meta_movimentacao.findUnique({
          where: {
            meta_id_meta_movimentacao_operacao_id: {
              meta_id: goalId,
              meta_movimentacao_operacao_id: input.operacao_id,
            },
          },
        });
        if (existing) {
          if (!sameOperation(existing, input)) throw operationConflict();
          return {
            movimentacao: serializeMovement(existing),
            meta: await summaryForGoal(tx, goal),
          };
        }

        const current = decimal(goal.meta_valor_reservado);
        const next = input.tipo === 'DEPOSITO'
          ? current.plus(value)
          : current.minus(value);

        if (next.isNegative()) {
          throw new GoalMovementError(
            'SALDO_INSUFICIENTE',
            'O valor da retirada supera o saldo reservado',
            422,
          );
        }
        if (next.greaterThan(MAX_MONEY)) {
          throw new GoalMovementError(
            'SALDO_LIMITE_EXCEDIDO',
            'O saldo reservado supera a capacidade monetária permitida',
            422,
          );
        }

        const updatedGoal = await tx.tb_meta.update({
          where: { meta_id: goalId },
          data: { meta_valor_reservado: next },
        });
        const movement = await tx.tb_meta_movimentacao.create({
          data: {
            meta_id: goalId,
            meta_movimentacao_operacao_id: input.operacao_id,
            meta_movimentacao_tipo: input.tipo,
            meta_movimentacao_valor: value,
          },
        });

        return {
          movimentacao: serializeMovement(movement),
          meta: await summaryForGoal(tx, updatedGoal),
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw operationConflict();
      }
      throw error;
    }
  }

  static async list(
    userId: number,
    goalId: number,
    rawQuery: unknown,
    database: GoalMovementDatabase = prisma,
  ) {
    assertUserId(userId);
    if (!Number.isInteger(goalId) || goalId <= 0) throw notFound();
    const query = goalMovementListQuerySchema.parse(rawQuery);
    const goal = await database.tb_meta.findFirst({
      where: { meta_id: goalId, usuario_id: userId },
      select: { meta_id: true },
    });
    if (!goal) throw notFound();

    const cursor = query.cursor ? decodeCursor(query.cursor, goalId) : null;
    const movements = await database.tb_meta_movimentacao.findMany({
      where: {
        meta_id: goalId,
        ...(cursor
          ? {
              OR: [
                { meta_movimentacao_data: { lt: cursor.data } },
                {
                  meta_movimentacao_data: cursor.data,
                  meta_movimentacao_id: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ meta_movimentacao_data: 'desc' }, { meta_movimentacao_id: 'desc' }],
      take: query.limit + 1,
    });
    const hasNext = movements.length > query.limit;
    const items = movements.slice(0, query.limit);

    return {
      itens: items.map(serializeMovement),
      nextCursor: hasNext && items.length > 0
        ? encodeCursor(goalId, items[items.length - 1])
        : null,
    };
  }

  static async enrichGoals(goals: any[], database: GoalMovementDatabase = prisma) {
    if (goals.length === 0) return goals;
    const ids = goals.map((goal) => goal.meta_id);
    const [latest, deposits] = await Promise.all([
      findLatestPerGoal(database, ids),
      findLatestPerGoal(database, ids, 'DEPOSITO'),
    ]);
    const latestByGoal = new Map(latest.map((movement: any) => [movement.meta_id, movement]));
    const depositByGoal = new Map(deposits.map((movement: any) => [movement.meta_id, movement]));
    return goals.map((goal) => {
      return {
        ...goal,
        ...buildSavingsSummary(
          goal,
          latestByGoal.get(goal.meta_id) ?? null,
          depositByGoal.get(goal.meta_id) ?? null,
        ),
      };
    });
  }
}
