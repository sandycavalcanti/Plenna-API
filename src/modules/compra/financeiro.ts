import { Prisma } from '@prisma/client';
import { AppError } from '../../errors/AppError.js';

export const BUSINESS_TIMEZONE = 'America/Sao_Paulo' as const;

function zonedParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
}

function timezoneOffsetMs(date: Date) {
  const parts = zonedParts(date);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return localAsUtc - date.getTime();
}

function localMidnightUtc(year: number, monthIndex: number, day: number) {
  const localTimestamp = Date.UTC(year, monthIndex, day);
  let candidate = localTimestamp;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = localTimestamp - timezoneOffsetMs(new Date(candidate));
    if (next === candidate) return new Date(candidate);
    candidate = next;
  }
  return new Date(candidate);
}

export function businessMonthBounds(year: number, monthIndex: number) {
  return {
    start: localMidnightUtc(year, monthIndex, 1),
    end: localMidnightUtc(year, monthIndex + 1, 1),
  };
}

export function businessDayBounds(date: Date) {
  if (!Number.isFinite(date.getTime())) throw new AppError('Data inválida', 400);
  const parts = zonedParts(date);
  return {
    start: localMidnightUtc(parts.year, parts.month - 1, parts.day),
    end: localMidnightUtc(parts.year, parts.month - 1, parts.day + 1),
  };
}

export function businessDayStart(date: Date) {
  return businessDayBounds(date).start;
}

export function businessDateKey(date: Date) {
  const parts = zonedParts(date);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function businessPeriod(date: Date) {
  const parts = zonedParts(date);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}`;
}

export function getMonthBounds(referenceDate: Date = new Date()) {
  if (!Number.isFinite(referenceDate.getTime())) throw new AppError('Período inválido', 400);
  const parts = zonedParts(referenceDate);
  return businessMonthBounds(parts.year, parts.month - 1);
}
export function parseMonth(periodo: unknown, now = new Date()) {
  if (periodo === undefined) return getMonthBounds(now);
  if (typeof periodo !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(periodo)) throw new AppError('Use período AAAA-MM', 400);
  const [year, month] = periodo.split('-').map(Number);
  return businessMonthBounds(year!, month! - 1);
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
