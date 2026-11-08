import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { businessPeriod, parseMonth, BUSINESS_TIMEZONE } from '../compra/financeiro.js';
import { serializeMetaMoney } from './meta.money.js';
import { metaHistoricoResponseSchema } from './meta.schemas.js';
const ZERO = new Prisma.Decimal(0);
function decimal(value) {
    return new Prisma.Decimal(value === null || value === undefined ? 0 : String(value));
}
function dateOf(value) {
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isFinite(date.getTime()) ? date : null;
}
function sumRows(rows) {
    return rows.reduce((total, row) => {
        const value = decimal(row.meta_movimentacao_valor);
        return row.meta_movimentacao_tipo === 'RETIRADA'
            ? total.minus(value)
            : total.plus(value);
    }, ZERO);
}
async function movementRows(database, metaIds, end) {
    if (metaIds.length === 0)
        return [];
    return database.tb_meta_movimentacao.findMany({
        where: {
            meta_id: { in: metaIds },
            ...(end ? { meta_movimentacao_data: { lt: end } } : {}),
        },
        orderBy: [{ meta_id: 'asc' }, { meta_movimentacao_data: 'asc' }, { meta_movimentacao_id: 'asc' }],
    });
}
async function movementTotals(database, metaIds, end) {
    if (metaIds.length === 0)
        return new Map();
    // PostgreSQL aggregates the movements in the production path, avoiding a
    // full transfer to Node.js for goals with long savings histories.
    if (typeof database.tb_meta_movimentacao.groupBy === 'function') {
        const rows = await database.tb_meta_movimentacao.groupBy({
            by: ['meta_id', 'meta_movimentacao_tipo'],
            where: {
                meta_id: { in: metaIds },
                ...(end ? { meta_movimentacao_data: { lt: end } } : {}),
            },
            _sum: { meta_movimentacao_valor: true },
        });
        const result = new Map();
        for (const row of rows) {
            const current = result.get(row.meta_id) ?? ZERO;
            const value = decimal(row._sum.meta_movimentacao_valor);
            result.set(row.meta_id, row.meta_movimentacao_tipo === 'RETIRADA'
                ? current.minus(value)
                : current.plus(value));
        }
        return result;
    }
    // Fallback for service doubles and isolated test adapters.
    const rows = await movementRows(database, metaIds, end);
    const result = new Map();
    for (const metaId of metaIds) {
        result.set(metaId, sumRows(rows.filter((row) => row.meta_id === metaId)));
    }
    return result;
}
function percent(balance, target) {
    if (!target.greaterThan(0))
        return null;
    return balance.div(target).mul(100)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
        .toNumber();
}
function isoOrNull(value) {
    return value ? value.toISOString() : null;
}
export class MetaHistoricoService {
    static async findByMonth(userId, periodo, database = prisma, now = new Date()) {
        const bounds = parseMonth(periodo, now);
        if (periodo > businessPeriod(now)) {
            throw new AppError('Período ainda não observado', 400);
        }
        // The selected current month is observed only up to the instant of the
        // request; previous months use their complete local-month boundary.
        const observedEnd = new Date(Math.min(bounds.end.getTime(), now.getTime()));
        const metas = await database.tb_meta.findMany({
            where: { usuario_id: userId, meta_data_criacao: { lt: observedEnd } },
            orderBy: { meta_data_criacao: 'asc' },
        });
        if (metas.length === 0) {
            return metaHistoricoResponseSchema.parse({
                versaoContrato: 2,
                periodo,
                referenciaTemporal: BUSINESS_TIMEZONE,
                metas: [],
                limitacoes: [],
            });
        }
        const metaIds = metas.map((meta) => meta.meta_id);
        const [periodBalances, allBalances] = await Promise.all([
            movementTotals(database, metaIds, observedEnd),
            movementTotals(database, metaIds),
        ]);
        const limitacoes = new Set();
        const result = [];
        for (const meta of metas) {
            const createdAt = dateOf(meta.meta_data_criacao);
            if (!createdAt)
                continue;
            const completionDate = meta.meta_completado ? dateOf(meta.meta_data_conclusao) : null;
            // A legacy completed goal without a persisted date cannot be assigned
            // safely to any month. Keep it in the general management endpoint only.
            if (meta.meta_completado && !completionDate) {
                limitacoes.add('Metas legadas concluídas sem data de conclusão não entram na lista mensal.');
                continue;
            }
            const completionPeriod = completionDate ? businessPeriod(completionDate) : null;
            if (completionPeriod && periodo > completionPeriod)
                continue;
            const balance = periodBalances.get(meta.meta_id) ?? ZERO;
            const allBalance = allBalances.get(meta.meta_id) ?? ZERO;
            const balanceAvailable = allBalance.eq(decimal(meta.meta_valor_reservado));
            const reasons = [];
            if (!balanceAvailable) {
                reasons.push('saldo_historico_incompleto');
                limitacoes.add('Alguns saldos não podem ser comprovados apenas pelas movimentações persistidas.');
            }
            const target = decimal(meta.meta_valor);
            const completedInPeriod = Boolean(completionPeriod && completionPeriod === periodo);
            result.push({
                meta_id: meta.meta_id,
                meta_titulo: meta.meta_titulo,
                meta_descricao: meta.meta_descricao,
                meta_valor: serializeMetaMoney(target),
                meta_valor_reservado: serializeMetaMoney(balance),
                progresso_percentual: percent(balance, target),
                meta_completado: completedInPeriod,
                meta_data_criacao: createdAt.toISOString(),
                meta_data_conclusao: isoOrNull(completionDate),
                saldo_historico_disponivel: balanceAvailable,
                historico_completo: reasons.length === 0,
                historico_limitacoes: reasons,
            });
        }
        return metaHistoricoResponseSchema.parse({
            versaoContrato: 2,
            periodo,
            referenciaTemporal: BUSINESS_TIMEZONE,
            metas: result,
            limitacoes: [...limitacoes],
        });
    }
}
