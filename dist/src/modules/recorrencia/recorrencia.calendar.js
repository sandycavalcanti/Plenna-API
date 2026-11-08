export const RECURRENCE_TIMEZONE = 'America/Sao_Paulo';
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export function parseDateOnly(value, fieldName = 'data') {
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
export function formatDateOnly(value) {
    const year = value.getUTCFullYear().toString().padStart(4, '0');
    const month = (value.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = value.getUTCDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function formatPartsInTimeZone(value, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(value);
    return Object.fromEntries(parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]));
}
export function formatDateInTimeZone(value, timeZone = RECURRENCE_TIMEZONE) {
    if (Number.isNaN(value.getTime()))
        throw new Error('Data inválida');
    const parts = formatPartsInTimeZone(value, timeZone);
    return `${parts.year}-${parts.month}-${parts.day}`;
}
/**
 * Converte uma data civil para o instante correspondente à meia-noite no
 * timezone de negócio. O campo legado compra_horario não possui timezone,
 * mas o dashboard interpreta seus limites usando America/Sao_Paulo.
 */
export function dateOnlyAtTimeZoneMidnight(value, timeZone = RECURRENCE_TIMEZONE) {
    const date = parseDateOnly(value, 'data');
    const localTimestamp = date.getTime();
    let candidate = localTimestamp;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const parts = formatPartsInTimeZone(new Date(candidate), timeZone);
        const renderedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
        const offset = renderedAsUtc - candidate;
        const nextCandidate = localTimestamp - offset;
        if (nextCandidate === candidate)
            return new Date(candidate);
        candidate = nextCandidate;
    }
    return new Date(candidate);
}
export function addCivilDays(value, days) {
    const date = parseDateOnly(value, 'data');
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}
function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
export function addOccurrence(anchorValue, frequency, index) {
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
export function buildUpcomingOccurrences(frequency, firstOccurrence, endDate, limit = 5, fromDate = firstOccurrence) {
    const first = parseDateOnly(firstOccurrence, 'primeiraOcorrencia');
    const from = parseDateOnly(fromDate, 'dataInicial');
    const end = endDate ? parseDateOnly(endDate, 'dataFinal') : null;
    const safeLimit = Math.max(0, Math.min(Math.trunc(limit), 50));
    const occurrences = [];
    for (let index = 0; index < 10000 && occurrences.length < safeLimit; index += 1) {
        const candidate = addOccurrence(first, frequency, index);
        if (end && candidate > end)
            break;
        if (candidate >= from)
            occurrences.push(candidate);
    }
    return occurrences;
}
export function nextOccurrenceOnOrAfter(frequency, firstOccurrence, endDate, fromDate) {
    return buildUpcomingOccurrences(frequency, firstOccurrence, endDate, 1, fromDate)[0] ?? null;
}
export function businessDateNow(timeZone = RECURRENCE_TIMEZONE) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return parseDateOnly(`${values.year}-${values.month}-${values.day}`, 'dataAtual');
}
