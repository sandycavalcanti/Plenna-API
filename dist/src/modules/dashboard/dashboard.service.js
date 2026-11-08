import { segundosDoRegistro } from '../tempo-uso/tempo-uso.duracao.js';
import { itemTotalCents } from '../compra/limite.service.js';
import { legacyReadOverlay } from '../tempo-uso-v2/legacy.runtime.js';
import { classificacoesAgregadoSql } from '../compra/eventos.consulta.js';
import { prisma } from '../../lib/prisma.js';
import { BUSINESS_TIMEZONE, businessPeriod, financialWhere, parseMonth, summarizeValues, cents } from '../compra/financeiro.js';
import { AppError } from '../../errors/AppError.js';
import { resolverOrcamentoMensal } from '../compra/referencias.service.js';
export const ANALYTICS_TIMEZONE = BUSINESS_TIMEZONE;
function formatParts(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: ANALYTICS_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    return Object.fromEntries(parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]));
}
function timeZoneOffsetMs(date) {
    const parts = formatParts(date);
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    return asUtc - date.getTime();
}
function localDateTimeToUtc(year, monthIndex, day) {
    const localTimestamp = Date.UTC(year, monthIndex, day);
    let candidate = localTimestamp;
    // Resolve the local midnight using the offset of the target timezone. The
    // small iteration also keeps the conversion safe if historical DST data is
    // encountered, without changing the stored database timestamp.
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const nextCandidate = localTimestamp - timeZoneOffsetMs(new Date(candidate));
        if (nextCandidate === candidate)
            return new Date(candidate);
        candidate = nextCandidate;
    }
    return new Date(candidate);
}
function currentAnalyticsMonth() {
    const parts = formatParts(new Date());
    return `${parts.year}-${parts.month}`;
}
function parseMonthKey(key) {
    const [yearText, monthText] = key.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    return { year, monthIndex: month - 1, index: year * 12 + month - 1 };
}
function monthKeyFromIndex(index) {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}
function monthPeriod(key) {
    const { year, monthIndex } = parseMonthKey(key);
    return {
        key,
        start: localDateTimeToUtc(year, monthIndex, 1),
        end: localDateTimeToUtc(year, monthIndex + 1, 1),
    };
}
function assertNotFuture(key) {
    if (parseMonthKey(key).index > parseMonthKey(currentAnalyticsMonth()).index) {
        throw new AppError('Não é permitido consultar período futuro', 400);
    }
}
function buildAnalyticsPeriods(query) {
    if (query.mode === 'month') {
        if (!query.month)
            throw new AppError('month é obrigatório', 400);
        assertNotFuture(query.month);
        return [monthPeriod(query.month)];
    }
    if (query.mode === 'evolution') {
        const months = query.months;
        if (months !== 6 && months !== 12) {
            throw new AppError('months é obrigatório para evolução', 400);
        }
        const end = query.end ?? currentAnalyticsMonth();
        assertNotFuture(end);
        const endIndex = parseMonthKey(end).index;
        return Array.from({ length: months }, (_, offset) => monthPeriod(monthKeyFromIndex(endIndex - months + 1 + offset)));
    }
    if (!query.monthA || !query.monthB) {
        throw new AppError('monthA e monthB são obrigatórios para comparação', 400);
    }
    assertNotFuture(query.monthA);
    assertNotFuture(query.monthB);
    if (query.monthA === query.monthB) {
        throw new AppError('Os meses de comparação devem ser diferentes', 400);
    }
    return [monthPeriod(query.monthA), monthPeriod(query.monthB)];
}
function toCents(value) {
    if (value === null || value === undefined)
        return null;
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue))
        return null;
    return Math.round(numberValue * 100);
}
function fromCents(cents) {
    return Number((cents / 100).toFixed(2));
}
function percentageDifference(base, compared) {
    if (base === 0)
        return null;
    return Number((((compared - base) / base) * 100).toFixed(2));
}
function createMutablePeriod(period) {
    return {
        ...period,
        total_centavos: 0,
        desconto_centavos: 0,
        quantidade_compras: 0,
        quantidade_compras_com_valor: 0,
        categorias: new Map(),
        formas_pagamento: new Map(),
        compras_acima_limite: {
            acima_limite: 0,
            dentro_limite: 0,
        },
        impulsividade: new Map(),
    };
}
function findPeriodForDate(periods, date) {
    const timestamp = date.getTime();
    return periods.find((period) => timestamp >= period.start.getTime() && timestamp < period.end.getTime());
}
function serializeCategory(category) {
    return {
        ...category,
        total: fromCents(category.total_centavos),
    };
}
function serializePayment(payment) {
    return {
        ...payment,
        total: fromCents(payment.total_centavos),
    };
}
function serializeImpulsivity(impulsivity) {
    return {
        ...impulsivity,
        valor_total: fromCents(impulsivity.valor_total_centavos),
    };
}
function serializePeriod(period) {
    return {
        periodo: period.key,
        inicio: period.start.toISOString(),
        fim: period.end.toISOString(),
        total_centavos: period.total_centavos,
        total: fromCents(period.total_centavos),
        desconto_centavos: period.desconto_centavos,
        desconto: fromCents(period.desconto_centavos),
        quantidade_compras: period.quantidade_compras,
        quantidade_compras_com_valor: period.quantidade_compras_com_valor,
        categorias: [...period.categorias.values()]
            .sort((left, right) => right.total_centavos - left.total_centavos || left.categoria_nome.localeCompare(right.categoria_nome))
            .map(serializeCategory),
        formas_pagamento: [...period.formas_pagamento.values()]
            .sort((left, right) => right.total_centavos - left.total_centavos || left.forma_pagamento_nome.localeCompare(right.forma_pagamento_nome))
            .map(serializePayment),
        compras_acima_limite: { ...period.compras_acima_limite },
        impulsividade: [...period.impulsividade.values()]
            .sort((left, right) => right.valor_total_centavos - left.valor_total_centavos || left.compra_classificacao.localeCompare(right.compra_classificacao))
            .map(serializeImpulsivity),
    };
}
function buildComparison(base, compared) {
    const categoryIds = new Set([
        ...base.categorias.map((category) => category.categoria_id),
        ...compared.categorias.map((category) => category.categoria_id),
    ]);
    const baseById = new Map(base.categorias.map((category) => [category.categoria_id, category]));
    const comparedById = new Map(compared.categorias.map((category) => [category.categoria_id, category]));
    return {
        periodo_base: base.periodo,
        periodo_comparado: compared.periodo,
        total: {
            base: base.total_centavos,
            comparado: compared.total_centavos,
            diferenca: compared.total_centavos - base.total_centavos,
            variacao_percentual: percentageDifference(base.total_centavos, compared.total_centavos),
        },
        quantidade_compras: {
            base: base.quantidade_compras,
            comparado: compared.quantidade_compras,
            diferenca: compared.quantidade_compras - base.quantidade_compras,
            variacao_percentual: percentageDifference(base.quantidade_compras, compared.quantidade_compras),
        },
        categorias: [...categoryIds].map((categoriaId) => {
            const baseCategory = baseById.get(categoriaId);
            const comparedCategory = comparedById.get(categoriaId);
            const baseTotal = baseCategory?.total_centavos ?? 0;
            const comparedTotal = comparedCategory?.total_centavos ?? 0;
            return {
                categoria_id: categoriaId,
                categoria_nome: comparedCategory?.categoria_nome ?? baseCategory?.categoria_nome ?? 'Categoria',
                base_total_centavos: baseTotal,
                comparado_total_centavos: comparedTotal,
                diferenca_centavos: comparedTotal - baseTotal,
                base_total: fromCents(baseTotal),
                comparado_total: fromCents(comparedTotal),
                diferenca: fromCents(comparedTotal - baseTotal),
                variacao_percentual: percentageDifference(baseTotal, comparedTotal),
            };
        }).sort((left, right) => right.comparado_total_centavos - left.comparado_total_centavos),
    };
}
/**
 * Calcula o intervalo UTC correspondente ao mês de referência.
 *
 * O intervalo é semiaberto (`>= início` e `< início do próximo mês`),
 * evitando problemas com diferentes quantidades de dias e milissegundos
 * no final do mês.
 */
function toNumber(value) {
    return Number(value);
}
// Somente contagens agregadas; nunca dados de compras ou identidade do usuário.
// Expor cobertura dos indicadores no Mobile exige uma evolução futura do contrato.
function registrarIgnorados(indicador, quantidade) {
    if (quantidade > 0) {
        console.info('dashboard_dados_insuficientes', { indicador, quantidade });
    }
}
/**
 * Calcula os indicadores financeiros utilizados pelo dashboard.
 *
 * Apenas compras confirmadas participam das métricas de gasto, evitando
 * que compras pendentes ou ignoradas alterem os indicadores do usuário.
 */
export class DashboardService {
    static async analytics(userId, query) {
        const observedAt = new Date();
        const periodDefinitions = buildAnalyticsPeriods(query);
        const periods = periodDefinitions.map(createMutablePeriod);
        const rangeStart = new Date(Math.min(...periods.map((period) => period.start.getTime())));
        const rangeEnd = new Date(Math.max(...periods.map((period) => period.end.getTime())));
        const periodFilter = query.mode === 'compare'
            ? {
                OR: periodDefinitions.map((period) => ({
                    compra_horario: {
                        gte: period.start,
                        lt: new Date(Math.min(period.end.getTime(), observedAt.getTime())),
                    },
                })),
            }
            : {
                compra_horario: {
                    gte: rangeStart,
                    lt: new Date(Math.min(rangeEnd.getTime(), observedAt.getTime())),
                },
            };
        const purchases = await prisma.tb_compra.findMany({
            where: {
                usuario_id: userId,
                compra_ativo: 1,
                compra_status: 'CONFIRMADA',
                ...periodFilter,
            },
            select: {
                compra_horario: true,
                compra_email: true,
                compra_valor: true,
                compra_desconto: true,
                compra_acima_limite: true,
                compra_classificacao: true,
                tb_forma_pagamento: {
                    select: {
                        forma_pagamento_nome: true,
                    },
                },
                tb_compra_item: {
                    where: { compra_item_ativo: 1 },
                    select: {
                        categoria_id: true,
                        compra_item_valor: true,
                        compra_item_quantidade: true,
                        tb_categoria: { select: { categoria_nome: true } },
                    },
                },
            },
        });
        for (const purchase of purchases) {
            const period = findPeriodForDate(periods, purchase.compra_horario);
            if (!period)
                continue;
            period.quantidade_compras += 1;
            const purchaseCents = toCents(purchase.compra_valor);
            if (purchaseCents !== null) {
                period.quantidade_compras_com_valor += 1;
                period.total_centavos += purchaseCents;
                const formaPagamentoNome = purchase.tb_forma_pagamento?.forma_pagamento_nome ?? 'Sem forma de pagamento';
                const payment = period.formas_pagamento.get(formaPagamentoNome);
                if (payment) {
                    payment.total_centavos += purchaseCents;
                    payment.quantidade_compras += 1;
                }
                else {
                    period.formas_pagamento.set(formaPagamentoNome, {
                        forma_pagamento_nome: formaPagamentoNome,
                        total_centavos: purchaseCents,
                        quantidade_compras: 1,
                    });
                }
            }
            if (purchase.compra_acima_limite === true) {
                period.compras_acima_limite.acima_limite += 1;
            }
            else if (purchase.compra_acima_limite === false) {
                period.compras_acima_limite.dentro_limite += 1;
            }
            const discountCents = toCents(purchase.compra_desconto);
            if (discountCents !== null && discountCents > 0) {
                period.desconto_centavos += discountCents;
            }
            for (const item of purchase.tb_compra_item) {
                if (item.categoria_id === null || !item.tb_categoria)
                    continue;
                if (purchase.compra_email && item.compra_item_quantidade === null)
                    continue;
                const itemCents = itemTotalCents(item.compra_item_valor, item.compra_item_quantidade ?? null);
                if (itemCents === null)
                    continue;
                const existing = period.categorias.get(item.categoria_id);
                if (existing) {
                    existing.total_centavos += itemCents;
                    existing.quantidade_itens += 1;
                    continue;
                }
                period.categorias.set(item.categoria_id, {
                    categoria_id: item.categoria_id,
                    categoria_nome: item.tb_categoria.categoria_nome,
                    total_centavos: itemCents,
                    quantidade_itens: 1,
                });
            }
        }
        // Only classification counts use this extra set-based read; financial cards
        // keep their existing contracts. One query for all requested windows.
        const classificacoes = await prisma.$queryRaw(classificacoesAgregadoSql(userId, periodDefinitions.map(p => ({ inicio: p.start, fim: new Date(Math.min(p.end.getTime(), observedAt.getTime())) }))));
        for (const group of classificacoes) {
            const period = periods.find(p => p.key === group.periodo);
            if (period)
                period.impulsividade.set(group.compra_classificacao, { compra_classificacao: group.compra_classificacao,
                    quantidade: group.quantidade, valor_total_centavos: group.valor_total_centavos ?? 0 });
        }
        const serializedPeriods = periods.map(serializePeriod);
        const comparacao = query.mode === 'compare'
            ? buildComparison(serializedPeriods[0], serializedPeriods[1])
            : null;
        return {
            mode: query.mode,
            timezone: ANALYTICS_TIMEZONE,
            periodos: serializedPeriods,
            comparacao,
        };
    }
    static async resumoMensal(userId, periodo) {
        const { start, end } = parseMonth(periodo);
        return prisma.$transaction(async (tx) => {
            const user = await tx.tb_usuario.findFirst({ where: { usuario_id: userId, usuario_status: true },
                select: { usuario_meta_valor_mensal: true, usuario_meta_valor_compra: true } });
            if (!user)
                throw new AppError('Usuário não encontrado', 404);
            const compras = await tx.tb_compra.findMany({ where: financialWhere(userId, start), select: { compra_valor: true } });
            const selectedPeriod = businessPeriod(start);
            const reference = await resolverOrcamentoMensal(tx, userId, selectedPeriod);
            const summary = summarizeValues(compras.map(c => c.compra_valor), reference.valor ?? (selectedPeriod === businessPeriod(new Date()) && reference.motivo !== 'ORCAMENTO_DESATIVADO' ? user.usuario_meta_valor_mensal : null));
            const limiteCentavos = user.usuario_meta_valor_compra == null
                ? null
                : cents(user.usuario_meta_valor_compra);
            const limite = limiteCentavos !== null && limiteCentavos > 0 ? limiteCentavos : null;
            return { periodo: start.toISOString().slice(0, 7), timezone: BUSINESS_TIMEZONE, inicio: start.toISOString(), fimExclusivo: end.toISOString(),
                ...summary, limitePorCompra: limite === null ? null : limite / 100,
                comprasAcimaLimiteIndividual: limite === null ? null : compras.filter(c => c.compra_valor !== null && cents(c.compra_valor) > limite).length };
        }, { isolationLevel: 'RepeatableRead' });
    }
    static async findGastosPorCategoria(userId, periodo) {
        const { start } = parseMonth(periodo);
        const end = financialWhere(userId, start).compra_horario.lt;
        const compras = await prisma.tb_compra.findMany({
            where: {
                // O filtro de propriedade fica diretamente na compra, porque
                // `tb_compra` é o model consultado e não uma relação dele mesmo.
                usuario_id: userId,
                // O dashboard considera somente compras ainda ativas.
                compra_ativo: 1,
                compra_status: 'CONFIRMADA',
                compra_horario: {
                    gte: start,
                    lt: end,
                },
            },
            select: {
                compra_valor: true,
                compra_email: true,
                tb_compra_item: {
                    // Itens excluídos logicamente não entram na soma por categoria.
                    where: { compra_item_ativo: 1 },
                    select: {
                        compra_item_valor: true,
                        compra_item_quantidade: true,
                        tb_categoria: { select: { categoria_nome: true } },
                    },
                },
            },
        });
        const totalsByCategory = new Map();
        let ignorados = 0;
        // A consulta traz as compras do usuário e, dentro de cada compra, seus
        // itens. O loop abaixo precisa trabalhar com os itens achatados; antes,
        // `items` não existia neste escopo e causava ReferenceError/erro 500.
        const eligible = compras.filter(compra => {
            if (compra.compra_valor === null || compra.tb_compra_item.some(item => !item.tb_categoria)) {
                ignorados += 1;
                return false;
            }
            return true;
        });
        const items = eligible.flatMap(compra => compra.tb_compra_item.filter(item => {
            if (compra.compra_email && item.compra_item_quantidade === null) {
                ignorados += 1;
                return false;
            }
            return true;
        }));
        for (const item of items) {
            // Itens sem categoria não entram nesta visão, pois o contrato do
            // dashboard exige um nome real e não devemos inventar uma categoria.
            if (!item.tb_categoria) {
                ignorados += 1;
                continue;
            }
            // Cada item contribui com seu próprio valor; itens da mesma categoria
            // acumulam no mesmo grupo e categorias diferentes ficam separadas.
            const categoriaNome = item.tb_categoria.categoria_nome;
            const totalAtual = totalsByCategory.get(categoriaNome) ?? 0;
            const itemCents = itemTotalCents(item.compra_item_valor, item.compra_item_quantidade ?? null);
            if (itemCents === null) {
                ignorados += 1;
                continue;
            }
            totalsByCategory.set(categoriaNome, totalAtual + itemCents / 100);
        }
        registrarIgnorados('gastos_categoria', ignorados);
        return [...totalsByCategory.entries()].map(([categoria_nome, total]) => ({ categoria_nome, total })).sort((left, right) => right.total - left.total);
    }
    static async findGastosPorFormaPagamento(userId, periodo) {
        const { start } = parseMonth(periodo);
        const end = financialWhere(userId, start).compra_horario.lt;
        const compras = await prisma.tb_compra.findMany({
            where: {
                usuario_id: userId,
                compra_ativo: 1,
                compra_status: 'CONFIRMADA',
                compra_horario: {
                    gte: start,
                    lt: end,
                },
            },
            select: {
                compra_valor: true,
                tb_forma_pagamento: {
                    select: {
                        forma_pagamento_nome: true,
                    },
                },
            },
        });
        const totalsByFormaPagamento = new Map();
        let ignorados = 0;
        for (const compra of compras) {
            if (compra.compra_valor === null || !compra.tb_forma_pagamento) {
                ignorados += 1;
                continue;
            }
            const formaPagamentoNome = compra.tb_forma_pagamento.forma_pagamento_nome;
            const totalAtual = totalsByFormaPagamento.get(formaPagamentoNome) ?? 0;
            totalsByFormaPagamento.set(formaPagamentoNome, totalAtual + toNumber(compra.compra_valor));
        }
        registrarIgnorados('gastos_forma_pagamento', ignorados);
        return [...totalsByFormaPagamento.entries()].map(([forma_pagamento_nome, total]) => ({ forma_pagamento_nome, total })).sort((left, right) => right.total - left.total);
    }
    static async findImpulsividade(userId, periodo) {
        const { start } = parseMonth(periodo);
        const end = financialWhere(userId, start).compra_horario.lt;
        const grupos = await prisma.$queryRaw(classificacoesAgregadoSql(userId, [{ inicio: start, fim: end }]));
        registrarIgnorados('impulsividade', grupos.reduce((total, grupo) => total + grupo.quantidade - grupo.quantidade_com_valor, 0));
        return grupos.map((grupo) => ({
            compra_classificacao: grupo.compra_classificacao,
            quantidade: grupo.quantidade_com_valor, // Compatibility: known-value count.
            quantidade_total: grupo.quantidade,
            quantidade_sem_valor: grupo.quantidade - grupo.quantidade_com_valor,
            valor_total: grupo.valor_total_centavos === null ? null : grupo.valor_total_centavos / 100,
        })).sort((a, b) => a.compra_classificacao.localeCompare(b.compra_classificacao));
    }
    static async findComprasAcimaLimite(userId, periodo) {
        const { start } = parseMonth(periodo);
        const end = financialWhere(userId, start).compra_horario.lt;
        const grupos = await prisma.tb_compra.groupBy({
            where: {
                usuario_id: userId,
                // Indicadores de limite também ignoram compras excluídas.
                compra_ativo: 1,
                compra_status: 'CONFIRMADA',
                compra_horario: {
                    gte: start,
                    lt: end,
                },
            },
            by: ['compra_acima_limite'],
            _count: {
                _all: true,
            },
        });
        const resultado = {
            acima_limite: 0,
            dentro_limite: 0,
        };
        for (const grupo of grupos) {
            if (grupo.compra_acima_limite === true) {
                resultado.acima_limite = grupo._count._all;
            }
            else if (grupo.compra_acima_limite === false) {
                resultado.dentro_limite = grupo._count._all;
            }
            else {
                registrarIgnorados('compras_acima_limite', grupo._count._all);
            }
        }
        return resultado;
    }
    static async findTempoVsGasto(userId, periodo) {
        const { start } = parseMonth(periodo);
        const end = financialWhere(userId, start).compra_horario.lt;
        // As consultas são independentes e executadas em paralelo para reduzir
        // o tempo total necessário para montar o indicador.
        const [temposUso, gastosPorApp] = await Promise.all([
            prisma.tb_tempo_uso.findMany({
                where: {
                    usuario_id: userId,
                    OR: [
                        { tempo_uso_inicio: { gte: start, lt: end } },
                        { tempo_uso_inicio: null, tempo_uso_data: { gte: start, lt: end } },
                    ],
                },
                select: {
                    tempo_uso_nome: true,
                    tempo_uso_minutos: true,
                    tempo_uso_duracao_segundos: true,
                    tempo_uso_package_id: true,
                    tempo_uso_inicio: true,
                    tempo_uso_fim: true,
                    tempo_uso_data_local: true,
                    tempo_uso_data: true,
                },
            }).then(rows => legacyReadOverlay(userId, rows)),
            prisma.tb_compra.groupBy({
                where: {
                    usuario_id: userId,
                    compra_ativo: 1,
                    compra_status: 'CONFIRMADA',
                    compra_horario: {
                        gte: start,
                        lt: end,
                    },
                },
                by: ['compra_fonte'],
                _sum: {
                    compra_valor: true,
                },
                _count: { _all: true, compra_valor: true },
            }),
        ]);
        const tempoTotalPorApp = new Map();
        let temposIgnorados = 0;
        for (const tempo of temposUso) {
            const totalAtual = tempoTotalPorApp.get(tempo.tempo_uso_nome) ?? 0;
            const segundos = segundosDoRegistro(tempo);
            const minutos = segundos === null ? null : segundos / 60;
            if (minutos === null) {
                temposIgnorados += 1;
                continue;
            }
            tempoTotalPorApp.set(tempo.tempo_uso_nome, totalAtual + minutos);
        }
        const gastoTotalPorApp = new Map();
        let comprasIgnoradas = 0;
        for (const gasto of gastosPorApp) {
            if (!gasto.compra_fonte)
                continue;
            if (gasto.compra_fonte === null || gasto._sum.compra_valor === null) {
                comprasIgnoradas += gasto._count._all;
                continue;
            }
            comprasIgnoradas += gasto._count._all - gasto._count.compra_valor;
            gastoTotalPorApp.set(gasto.compra_fonte, toNumber(gasto._sum.compra_valor));
        }
        registrarIgnorados('gastos_fonte', comprasIgnoradas);
        registrarIgnorados('tempo_uso', temposIgnorados);
        registrarIgnorados('tempo_sem_gasto_conhecido', [...tempoTotalPorApp.keys()].filter((app) => !gastoTotalPorApp.has(app)).length);
        return [...tempoTotalPorApp.entries()]
            .flatMap(([app, tempo_total]) => {
            const gasto_total = gastoTotalPorApp.get(app);
            return gasto_total === undefined ? [] : [{ app, tempo_total, gasto_total }];
        })
            .sort((left, right) => right.gasto_total - left.gasto_total);
    }
}
