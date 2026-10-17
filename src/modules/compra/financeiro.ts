import { Prisma } from '@prisma/client';
import { AppError } from '../../errors/AppError.js';

export function getMonthBounds(referenceDate: Date = new Date()) {
  if (!Number.isFinite(referenceDate.getTime())) throw new AppError('Período inválido', 400);
  return { start: new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1)),
    end: new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + 1, 1)) };
}
export function parseMonth(periodo: unknown, now = new Date()) {
  if (periodo === undefined) return getMonthBounds(now);
  if (typeof periodo !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(periodo)) throw new AppError('Use período AAAA-MM', 400);
  return getMonthBounds(new Date(`${periodo}-01T00:00:00.000Z`));
}
export function financialWhere(userId: number, referenceDate: Date) {
  const { start, end } = getMonthBounds(referenceDate);
  return { usuario_id: userId, compra_ativo: 1, compra_status: 'CONFIRMADA' as const,
    compra_horario: { gte: start, lt: end } };
}
export function cents(value: Prisma.Decimal | number | string) {
  const result = new Prisma.Decimal(value).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
  if (!Number.isSafeInteger(result) || result < 0) throw new AppError('Valor financeiro inválido', 500);
  return result;
}
export function summarizeValues(values: Array<Prisma.Decimal | number | string | null>, budget: Prisma.Decimal | number | string | null) {
  const known = values.filter((v): v is Exclude<typeof v, null> => v !== null);
  const totalCents = known.reduce<number>((sum, v) => sum + cents(v), 0);
  if (!Number.isSafeInteger(totalCents)) throw new AppError('Total financeiro inválido', 500);
  const qualidade = !values.length ? 'SEM_COMPRAS' : !known.length ? 'INSUFICIENTE' : known.length !== values.length ? 'PARCIAL' : 'COMPLETO';
  const budgetCents = budget === null || cents(budget) === 0 ? null : cents(budget);
  const estadoOrcamento = budgetCents === null ? 'SEM_ORCAMENTO' : !known.length && values.length ? 'INDETERMINADO' :
    totalCents > budgetCents ? 'EXCEDIDO' : qualidade === 'PARCIAL' ? 'INDETERMINADO' : totalCents === budgetCents ? 'ATINGIDO' : 'DENTRO';
  return { totalConhecido: totalCents / 100, total: qualidade === 'INSUFICIENTE' ? null : totalCents / 100,
    qualidade, comprasConfirmadas: values.length, comprasComValor: known.length, comprasSemValor: values.length - known.length,
    mediaConhecida: known.length ? Math.round(totalCents / known.length) / 100 : null,
    orcamentoMensal: budgetCents === null ? null : budgetCents / 100, estadoOrcamento };
}
export function metricPeriods(previous: Date, current: Date) {
  const a = getMonthBounds(previous).start, b = getMonthBounds(current).start;
  return a.getTime() === b.getTime() ? [b] : [a,b];
}
