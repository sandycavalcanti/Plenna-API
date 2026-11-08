import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { serializeMetaMoney } from './meta.money.js';
export const META_ANALISE_TIMEZONE = 'America/Sao_Paulo';
const monthSchema = z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/, 'Use o periodo AAAA-MM');
const moneySchema = z.string().regex(/^\d{1,8}\.\d{2}$/);
const signedMoneySchema = z.string().regex(/^-?\d{1,8}\.\d{2}$/);
export const metaAnaliseInputSchema = z.object({
    periodo: monthSchema.optional(),
    meses: z.coerce.number().int().min(1).max(12).default(6),
    limite_metas: z.coerce.number().int().min(1).max(10).default(10),
    limite_movimentacoes_recentes: z.coerce.number().int().min(1).max(10).default(10),
}).strict();
const metaAnaliseMovimentacaoSchema = z.object({
    id: z.number().int().positive(),
    tipo: z.enum(['DEPOSITO', 'RETIRADA']),
    valor: moneySchema,
    data: z.string().datetime({ offset: true }),
}).strict();
const metaAnaliseComparacaoSchema = z.object({
    periodo_anterior: monthSchema,
    periodo_atual: monthSchema,
    depositado_variacao: signedMoneySchema,
    retirado_variacao: signedMoneySchema,
    liquido_variacao: signedMoneySchema,
    envolve_periodo_parcial: z.boolean(),
    dados_anterior_disponiveis: z.boolean(),
}).strict();
const metaAnaliseMesSchema = z.object({
    periodo: monthSchema,
    inicio: z.string().datetime({ offset: true }),
    fim_exclusivo: z.string().datetime({ offset: true }),
    parcial: z.boolean(),
    motivo_parcial: z.enum([
        'MES_ATUAL_INCOMPLETO',
        'META_CRIADA_NO_PERIODO',
        'MES_ATUAL_E_META_CRIADA',
    ]).nullable(),
    status: z.enum(['COM_DEPOSITOS', 'SEM_DEPOSITOS', 'SEM_MOVIMENTACOES']),
    total_depositado: moneySchema,
    total_retirado: moneySchema,
    saldo_liquido: signedMoneySchema,
    quantidade_depositos: z.number().int().nonnegative(),
    quantidade_retiradas: z.number().int().nonnegative(),
    comparacao_com_mes_anterior: metaAnaliseComparacaoSchema.nullable(),
}).strict();
const contributionFrequencySchema = z.object({
    meses_com_deposito: z.number().int().nonnegative(),
    meses_aplicaveis: z.number().int().nonnegative(),
    total_depositos: z.number().int().nonnegative(),
    media_depositos_por_mes: z.number().nonnegative(),
}).strict();
const metaAnalisadaSchema = z.object({
    id: z.number().int().positive(),
    titulo: z.string(),
    valor_objetivo: moneySchema,
    saldo_atual_reservado: moneySchema,
    valor_reservado: moneySchema,
    valor_restante: moneySchema,
    progresso_percentual: z.number().finite().nonnegative(),
    meta_completado: z.boolean(),
    ultima_movimentacao: metaAnaliseMovimentacaoSchema.nullable(),
    ultimo_deposito: metaAnaliseMovimentacaoSchema.nullable(),
    movimentacoes_recentes: z.array(metaAnaliseMovimentacaoSchema).max(10),
    indicadores: z.object({
        periodos_mensais: z.array(metaAnaliseMesSchema).max(12),
        total_depositado_no_periodo: moneySchema,
        total_retirado_no_periodo: moneySchema,
        saldo_liquido_no_periodo: signedMoneySchema,
        quantidade_depositos: z.number().int().nonnegative(),
        quantidade_retiradas: z.number().int().nonnegative(),
        meses_consecutivos_com_depositos: z.number().int().nonnegative(),
        frequencia_contribuicoes: contributionFrequencySchema,
        periodos_sem_movimentacoes: z.array(monthSchema).max(12),
        meses_com_movimentacoes_sem_deposito: z.array(monthSchema).max(12),
        proxima_do_objetivo: z.boolean(),
        atingiu_100_porcento: z.boolean(),
    }).strict(),
}).strict();
export const metaAnaliseResultSchema = z.object({
    periodo_referencia: monthSchema,
    meses_solicitados: z.number().int().min(1).max(12),
    timezone: z.literal(META_ANALISE_TIMEZONE),
    cobertura: z.object({
        inicio: z.string().datetime({ offset: true }),
        fim_exclusivo: z.string().datetime({ offset: true }),
        metas_retornadas: z.number().int().nonnegative(),
        metas_limitadas: z.boolean(),
        dados_suficientes: z.boolean(),
        saldo_historico_disponivel: z.literal(false),
        movimentos_considerados: z.number().int().nonnegative(),
        sem_movimentacoes: z.boolean(),
        periodo_referencia_parcial: z.boolean(),
        qualidade: z.enum(['COMPLETA_NO_PERIODO', 'PARCIAL', 'SEM_METAS']),
    }).strict(),
    limitacoes: z.array(z.string().max(240)).max(10),
    metas: z.array(metaAnalisadaSchema).max(10),
}).strict();
const ZERO = new Prisma.Decimal(0);
function decimal(value) {
    return new Prisma.Decimal(value === null || value === undefined ? 0 : String(value));
}
function money(value) {
    return serializeMetaMoney(value);
}
function signedMoney(value) {
    return decimal(value).toFixed(2);
}
function localParts(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: META_ANALISE_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
        year: Number(values.year),
        month: Number(values.month),
        day: Number(values.day),
        hour: Number(values.hour),
        minute: Number(values.minute),
        second: Number(values.second),
    };
}
function monthKey(date) {
    const parts = localParts(date);
    return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}`;
}
function monthNumber(value) {
    const [year, month] = value.split('-').map(Number);
    return year * 12 + month - 1;
}
function monthFromNumber(value) {
    const year = Math.floor(value / 12);
    const month = (value % 12) + 1;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}
function shiftMonth(value, amount) {
    return monthFromNumber(monthNumber(value) + amount);
}
/** Converte meia-noite no fuso local para o instante UTC correspondente. */
function zonedMidnight(year, month, day) {
    const desiredAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
    let guess = desiredAsUtc;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const actual = localParts(new Date(guess));
        const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
        guess += desiredAsUtc - actualAsUtc;
    }
    return new Date(guess);
}
function monthBounds(period) {
    const [year, month] = period.split('-').map(Number);
    const [nextYear, nextMonth] = shiftMonth(period, 1).split('-').map(Number);
    return {
        start: zonedMidnight(year, month, 1),
        end: zonedMidnight(nextYear, nextMonth, 1),
    };
}
function periodKeys(reference, count) {
    return Array.from({ length: count }, (_, index) => shiftMonth(reference, index - count + 1));
}
function serializeMovement(row) {
    return {
        id: row.meta_movimentacao_id,
        tipo: row.meta_movimentacao_tipo,
        valor: money(row.meta_movimentacao_valor),
        data: new Date(row.meta_movimentacao_data).toISOString(),
    };
}
function addLimitation(limitacoes, message) {
    if (limitacoes.includes(message) || limitacoes.length >= 10)
        return;
    limitacoes.push(message);
}
function serializedResultSize(result) {
    return JSON.stringify({ ok: true, result }).length;
}
/**
 * O orchestrator serializa { ok, result } e aplica AI_TOOL_RESULT_MAX_CHARS.
 * A tool conserva o resultado estruturado, reduzindo apenas detalhes
 * opcionais quando o limite configurado for menor que a resposta solicitada.
 */
export function ajustarResultadoMeta(source, maxChars = env.aiToolResultMaxChars) {
    if (serializedResultSize(source) <= maxChars)
        return source;
    const result = JSON.parse(JSON.stringify(source));
    for (const meta of result.metas)
        meta.movimentacoes_recentes = [];
    addLimitation(result.limitacoes, 'Movimentacoes recentes foram omitidas para respeitar o limite de resposta da IA.');
    while (serializedResultSize(result) > maxChars && result.metas.length > 1) {
        result.metas.pop();
        result.cobertura.metas_limitadas = true;
        result.cobertura.dados_suficientes = false;
    }
    if (result.cobertura.metas_limitadas) {
        addLimitation(result.limitacoes, 'A resposta foi limitada ao numero de metas que cabe no contexto da IA.');
    }
    while (serializedResultSize(result) > maxChars && result.metas.some((meta) => meta.indicadores.periodos_mensais.length > 1)) {
        for (const meta of result.metas) {
            if (meta.indicadores.periodos_mensais.length <= 1)
                continue;
            meta.indicadores.periodos_mensais.shift();
            meta.indicadores.periodos_mensais[0].comparacao_com_mes_anterior = null;
            if (meta.indicadores.periodos_sem_movimentacoes.length > 0)
                meta.indicadores.periodos_sem_movimentacoes.shift();
            if (meta.indicadores.meses_com_movimentacoes_sem_deposito.length > 0)
                meta.indicadores.meses_com_movimentacoes_sem_deposito.shift();
        }
        result.cobertura.dados_suficientes = false;
        addLimitation(result.limitacoes, 'Periodos mensais antigos foram omitidos para respeitar o limite de resposta da IA.');
    }
    if (serializedResultSize(result) > maxChars) {
        result.metas = [];
        result.cobertura.metas_limitadas = true;
        result.cobertura.dados_suficientes = false;
        addLimitation(result.limitacoes, 'A analise nao coube no limite de resposta configurado para a IA.');
    }
    return result;
}
function emptyAggregate(partial, partialReason) {
    return {
        totalDeposit: ZERO,
        totalWithdrawal: ZERO,
        depositCount: 0,
        withdrawalCount: 0,
        partial,
        partialReason,
    };
}
function aggregateMovements(movements, keys, creationDate, now) {
    const creationPeriod = creationDate ? monthKey(creationDate) : null;
    const currentPeriod = monthKey(now);
    const aggregates = new Map();
    for (const period of keys) {
        if (creationPeriod && monthNumber(period) < monthNumber(creationPeriod))
            continue;
        const creationInPeriod = Boolean(creationDate && period === creationPeriod && creationDate >= monthBounds(period).start);
        const currentIncomplete = period === currentPeriod && now < monthBounds(period).end;
        const partial = creationInPeriod || currentIncomplete;
        const partialReason = creationInPeriod && currentIncomplete
            ? 'MES_ATUAL_E_META_CRIADA'
            : creationInPeriod
                ? 'META_CRIADA_NO_PERIODO'
                : currentIncomplete
                    ? 'MES_ATUAL_INCOMPLETO'
                    : null;
        aggregates.set(period, emptyAggregate(partial, partialReason));
    }
    for (const row of movements) {
        const period = monthKey(new Date(row.meta_movimentacao_data));
        const aggregate = aggregates.get(period);
        if (!aggregate)
            continue;
        const value = decimal(row.meta_movimentacao_valor);
        if (row.meta_movimentacao_tipo === 'DEPOSITO') {
            aggregate.totalDeposit = aggregate.totalDeposit.plus(value);
            aggregate.depositCount += 1;
        }
        else if (row.meta_movimentacao_tipo === 'RETIRADA') {
            aggregate.totalWithdrawal = aggregate.totalWithdrawal.plus(value);
            aggregate.withdrawalCount += 1;
        }
    }
    return { aggregates };
}
function buildComparison(period, aggregate, previous) {
    if (!previous)
        return null;
    const previousPeriod = shiftMonth(period, -1);
    return {
        periodo_anterior: previousPeriod,
        periodo_atual: period,
        depositado_variacao: signedMoney(aggregate.totalDeposit.minus(previous.totalDeposit)),
        retirado_variacao: signedMoney(aggregate.totalWithdrawal.minus(previous.totalWithdrawal)),
        liquido_variacao: signedMoney(aggregate.totalDeposit.minus(aggregate.totalWithdrawal)
            .minus(previous.totalDeposit.minus(previous.totalWithdrawal))),
        envolve_periodo_parcial: aggregate.partial || previous.partial,
        dados_anterior_disponiveis: true,
    };
}
function buildMonthlyResult(period, aggregate, previous) {
    const bounds = monthBounds(period);
    const hasMovements = aggregate.depositCount + aggregate.withdrawalCount > 0;
    return {
        periodo: period,
        inicio: bounds.start.toISOString(),
        fim_exclusivo: bounds.end.toISOString(),
        parcial: aggregate.partial,
        motivo_parcial: aggregate.partialReason,
        status: aggregate.depositCount > 0 ? 'COM_DEPOSITOS' : hasMovements ? 'SEM_DEPOSITOS' : 'SEM_MOVIMENTACOES',
        total_depositado: money(aggregate.totalDeposit),
        total_retirado: money(aggregate.totalWithdrawal),
        saldo_liquido: signedMoney(aggregate.totalDeposit.minus(aggregate.totalWithdrawal)),
        quantidade_depositos: aggregate.depositCount,
        quantidade_retiradas: aggregate.withdrawalCount,
        comparacao_com_mes_anterior: buildComparison(period, aggregate, previous),
    };
}
async function findLatestPerMeta(database, metaIds, before, type) {
    if (metaIds.length === 0)
        return new Map();
    if (typeof database.$queryRaw === 'function') {
        const typeFilter = type
            ? Prisma.sql `AND m.meta_movimentacao_tipo = ${type}`
            : Prisma.empty;
        const rows = await database.$queryRaw(Prisma.sql `
      SELECT DISTINCT ON (m.meta_id)
        m.meta_movimentacao_id,
        m.meta_id,
        m.meta_movimentacao_tipo,
        m.meta_movimentacao_valor,
        m.meta_movimentacao_data
      FROM public.tb_meta_movimentacao AS m
      WHERE m.meta_id IN (${Prisma.join(metaIds)})
        AND m.meta_movimentacao_data < ${before}
        ${typeFilter}
      ORDER BY m.meta_id ASC, m.meta_movimentacao_data DESC, m.meta_movimentacao_id DESC
    `);
        return new Map(rows.map((row) => [row.meta_id, row]));
    }
    // Fallback para doubles de teste que nao expõem queryRaw.
    if (typeof database.tb_meta_movimentacao.findFirst === 'function') {
        const rows = await Promise.all(metaIds.map((metaId) => database.tb_meta_movimentacao.findFirst({
            where: {
                meta_id: metaId,
                meta_movimentacao_data: { lt: before },
                ...(type ? { meta_movimentacao_tipo: type } : {}),
            },
            orderBy: [{ meta_movimentacao_data: 'desc' }, { meta_movimentacao_id: 'desc' }],
        })));
        return new Map(rows.filter(Boolean).map((row) => [row.meta_id, row]));
    }
    const rows = await database.tb_meta_movimentacao.findMany({
        where: {
            meta_id: { in: metaIds },
            meta_movimentacao_data: { lt: before },
        },
        orderBy: [{ meta_movimentacao_data: 'desc' }, { meta_movimentacao_id: 'desc' }],
    });
    const latest = new Map();
    for (const row of rows) {
        if (type && row.meta_movimentacao_tipo !== type)
            continue;
        if (!latest.has(row.meta_id))
            latest.set(row.meta_id, row);
    }
    return latest;
}
function buildMetaResult(meta, monthlyMovements, latestMovement, lastDeposit, keys, input, now) {
    if (meta.meta_valor === null || meta.meta_valor === undefined || meta.meta_valor_reservado === null || meta.meta_valor_reservado === undefined) {
        throw new TypeError('Valor monetário obrigatório de meta ausente');
    }
    const target = decimal(meta.meta_valor);
    const reserved = decimal(meta.meta_valor_reservado);
    const safeReserved = reserved.isNegative() ? ZERO : reserved;
    const remaining = target.minus(safeReserved);
    const progress = target.greaterThan(0)
        ? safeReserved.div(target).mul(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber()
        : 0;
    const { aggregates } = aggregateMovements(monthlyMovements, keys, meta.meta_data_criacao ? new Date(meta.meta_data_criacao) : null, now);
    const applicablePeriods = keys.filter((period) => aggregates.has(period));
    const monthly = applicablePeriods.map((period) => buildMonthlyResult(period, aggregates.get(period), aggregates.get(shiftMonth(period, -1))));
    const totalDeposit = monthly.reduce((sum, item) => sum.plus(item.total_depositado), ZERO);
    const totalWithdrawal = monthly.reduce((sum, item) => sum.plus(item.total_retirado), ZERO);
    const depositMonths = monthly.filter((item) => item.quantidade_depositos > 0).length;
    const depositCount = monthly.reduce((sum, item) => sum + item.quantidade_depositos, 0);
    const withdrawalCount = monthly.reduce((sum, item) => sum + item.quantidade_retiradas, 0);
    let consecutive = 0;
    for (const period of [...applicablePeriods].reverse()) {
        if ((aggregates.get(period)?.depositCount ?? 0) === 0)
            break;
        consecutive += 1;
    }
    const noMovementPeriods = monthly.filter((item) => item.status === 'SEM_MOVIMENTACOES').map((item) => item.periodo);
    const movementWithoutDeposit = monthly.filter((item) => item.status === 'SEM_DEPOSITOS').map((item) => item.periodo);
    const periodCount = monthly.length;
    return {
        id: meta.meta_id,
        titulo: meta.meta_titulo,
        valor_objetivo: money(target),
        saldo_atual_reservado: money(safeReserved),
        valor_reservado: money(safeReserved),
        valor_restante: money(remaining.isNegative() ? ZERO : remaining),
        progresso_percentual: progress,
        meta_completado: Boolean(meta.meta_completado),
        ultima_movimentacao: latestMovement ? serializeMovement(latestMovement) : null,
        ultimo_deposito: lastDeposit ? serializeMovement(lastDeposit) : null,
        movimentacoes_recentes: monthlyMovements.slice(0, input.limite_movimentacoes_recentes).map(serializeMovement),
        indicadores: {
            periodos_mensais: monthly,
            total_depositado_no_periodo: money(totalDeposit),
            total_retirado_no_periodo: money(totalWithdrawal),
            saldo_liquido_no_periodo: signedMoney(totalDeposit.minus(totalWithdrawal)),
            quantidade_depositos: depositCount,
            quantidade_retiradas: withdrawalCount,
            meses_consecutivos_com_depositos: consecutive,
            frequencia_contribuicoes: {
                meses_com_deposito: depositMonths,
                meses_aplicaveis: periodCount,
                total_depositos: depositCount,
                media_depositos_por_mes: periodCount === 0 ? 0 : Number((depositCount / periodCount).toFixed(2)),
            },
            periodos_sem_movimentacoes: noMovementPeriods,
            meses_com_movimentacoes_sem_deposito: movementWithoutDeposit,
            proxima_do_objetivo: target.greaterThan(0) && progress >= 80 && progress < 100,
            atingiu_100_porcento: target.greaterThan(0) && safeReserved.greaterThanOrEqualTo(target),
        },
    };
}
export function periodoAtualAnaliseMetas(now = new Date()) {
    return monthKey(now);
}
export class MetaAnaliseService {
    static async analyze(userId, rawInput = {}, database = prisma, now = new Date()) {
        if (!Number.isInteger(userId) || userId <= 0)
            throw new Error('INVALID_AUTHENTICATED_USER');
        const parsed = metaAnaliseInputSchema.parse(rawInput);
        const referencePeriod = parsed.periodo ?? periodoAtualAnaliseMetas(now);
        const currentPeriod = periodoAtualAnaliseMetas(now);
        const futureReference = monthNumber(referencePeriod) > monthNumber(currentPeriod);
        const effectiveReferencePeriod = futureReference ? currentPeriod : referencePeriod;
        const input = {
            ...parsed,
            periodo: referencePeriod,
        };
        const referenceBounds = monthBounds(effectiveReferencePeriod);
        const keys = periodKeys(effectiveReferencePeriod, input.meses);
        const analysisStart = monthBounds(keys[0]).start;
        const rawMetas = await database.tb_meta.findMany({
            where: { usuario_id: userId },
            orderBy: [{ meta_data_criacao: 'desc' }, { meta_id: 'desc' }],
            take: input.limite_metas + 1,
        });
        const metasLimitadas = rawMetas.length > input.limite_metas;
        const metas = rawMetas.slice(0, input.limite_metas);
        const ids = metas.map((meta) => meta.meta_id);
        const monthlyMovements = ids.length === 0
            ? []
            : await database.tb_meta_movimentacao.findMany({
                where: {
                    meta_id: { in: ids },
                    meta_movimentacao_data: { gte: analysisStart, lt: referenceBounds.end },
                },
                select: {
                    meta_movimentacao_id: true,
                    meta_id: true,
                    meta_movimentacao_tipo: true,
                    meta_movimentacao_valor: true,
                    meta_movimentacao_data: true,
                },
                orderBy: [{ meta_movimentacao_data: 'desc' }, { meta_movimentacao_id: 'desc' }],
            });
        const [latestByMeta, depositByMeta] = await Promise.all([
            findLatestPerMeta(database, ids, referenceBounds.end),
            findLatestPerMeta(database, ids, referenceBounds.end, 'DEPOSITO'),
        ]);
        const byMeta = new Map();
        for (const movement of monthlyMovements) {
            const list = byMeta.get(movement.meta_id) ?? [];
            list.push(movement);
            byMeta.set(movement.meta_id, list);
        }
        const metasAnalisadas = metas.map((meta) => buildMetaResult(meta, byMeta.get(meta.meta_id) ?? [], latestByMeta.get(meta.meta_id) ?? null, depositByMeta.get(meta.meta_id) ?? null, keys, input, now));
        const limitacoes = [];
        if (metasLimitadas)
            addLimitation(limitacoes, `A analise foi limitada a ${input.limite_metas} metas.`);
        if (futureReference)
            addLimitation(limitacoes, `O periodo solicitado (${referencePeriod}) e futuro; a analise foi limitada ao mes observado (${effectiveReferencePeriod}).`);
        if (monthKey(now) === effectiveReferencePeriod)
            addLimitation(limitacoes, 'O mes de referencia observado ainda esta incompleto.');
        if (metas.length === 0)
            addLimitation(limitacoes, 'Nao existem metas disponiveis para o usuario autenticado.');
        addLimitation(limitacoes, 'Saldo atual reservado nao e saldo historico: os indicadores mensais mostram movimentacoes e nao reconstituem saldos de meses anteriores.');
        const qualidade = metas.length === 0
            ? 'SEM_METAS'
            : metasLimitadas || futureReference || monthKey(now) === effectiveReferencePeriod
                ? 'PARCIAL'
                : 'COMPLETA_NO_PERIODO';
        const result = {
            periodo_referencia: referencePeriod,
            meses_solicitados: input.meses,
            timezone: META_ANALISE_TIMEZONE,
            cobertura: {
                inicio: monthBounds(keys[0]).start.toISOString(),
                fim_exclusivo: referenceBounds.end.toISOString(),
                metas_retornadas: metasAnalisadas.length,
                metas_limitadas: metasLimitadas,
                dados_suficientes: !metasLimitadas && !futureReference,
                saldo_historico_disponivel: false,
                movimentos_considerados: monthlyMovements.length,
                sem_movimentacoes: monthlyMovements.length === 0,
                periodo_referencia_parcial: monthKey(now) === effectiveReferencePeriod,
                qualidade,
            },
            limitacoes,
            metas: metasAnalisadas,
        };
        return ajustarResultadoMeta(result);
    }
}
