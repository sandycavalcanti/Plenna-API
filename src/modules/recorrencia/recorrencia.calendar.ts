export const RECURRENCE_TIMEZONE = 'America/Sao_Paulo' as const;

export type RecurrenceFrequency = 'DIARIA' | 'SEMANAL' | 'MENSAL' | 'ANUAL';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateOnly(value: string | Date, fieldName = 'data'): Date {
  if (typeof value === 'string') {
    if (!DATE_ONLY_PATTERN.test(value)) {
      throw new Error(`${fieldName} deve usar o formato YYYY-MM-DD`);
    }

    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || formatDateOnly(parsed) !== value) {
      throw new Error(`${fieldName} inválida`);
    }

    return parsed;
  }

  if (Number.isNaN(value.getTime())) {
    throw new Error(`${fieldName} inválida`);
  }

  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function formatDateOnly(value: Date): string {
  const year = value.getUTCFullYear().toString().padStart(4, '0');
  const month = (value.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = value.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function addOccurrence(anchorValue: string | Date, frequency: RecurrenceFrequency, index: number): Date {
  const anchor = parseDateOnly(anchorValue, 'primeiraOcorrencia');
  const anchorYear = anchor.getUTCFullYear();
  const anchorMonth = anchor.getUTCMonth();
  const anchorDay = anchor.getUTCDate();

  if (frequency === 'DIARIA') {
    return new Date(Date.UTC(anchorYear, anchorMonth, anchorDay + index));
  }

  if (frequency === 'SEMANAL') {
    return new Date(Date.UTC(anchorYear, anchorMonth, anchorDay + index * 7));
  }

  if (frequency === 'MENSAL') {
    const targetMonth = anchorMonth + index;
    const targetYear = anchorYear + Math.floor(targetMonth / 12);
    const normalizedMonth = ((targetMonth % 12) + 12) % 12;
    const targetDay = Math.min(anchorDay, daysInMonth(targetYear, normalizedMonth));
    return new Date(Date.UTC(targetYear, normalizedMonth, targetDay));
  }

  const targetYear = anchorYear + index;
  const targetDay = Math.min(anchorDay, daysInMonth(targetYear, anchorMonth));
  return new Date(Date.UTC(targetYear, anchorMonth, targetDay));
}

export function buildUpcomingOccurrences(
  frequency: RecurrenceFrequency,
  firstOccurrence: string | Date,
  endDate: string | Date | null | undefined,
  limit = 5,
  fromDate: string | Date = firstOccurrence,
): Date[] {
  const first = parseDateOnly(firstOccurrence, 'primeiraOcorrencia');
  const from = parseDateOnly(fromDate, 'dataInicial');
  const end = endDate ? parseDateOnly(endDate, 'dataFinal') : null;
  const safeLimit = Math.max(0, Math.min(Math.trunc(limit), 50));
  const occurrences: Date[] = [];

  for (let index = 0; index < 10000 && occurrences.length < safeLimit; index += 1) {
    const candidate = addOccurrence(first, frequency, index);
    if (end && candidate > end) break;
    if (candidate >= from) occurrences.push(candidate);
  }

  return occurrences;
}

export function nextOccurrenceOnOrAfter(
  frequency: RecurrenceFrequency,
  firstOccurrence: string | Date,
  endDate: string | Date | null | undefined,
  fromDate: string | Date,
): Date | null {
  return buildUpcomingOccurrences(frequency, firstOccurrence, endDate, 1, fromDate)[0] ?? null;
}

export function businessDateNow(timeZone = RECURRENCE_TIMEZONE): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return parseDateOnly(`${values.year}-${values.month}-${values.day}`, 'dataAtual');
}
