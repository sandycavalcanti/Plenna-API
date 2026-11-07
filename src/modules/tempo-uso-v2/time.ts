import type { Interval } from './contracts.js';
export function utcMs(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error('UTC_REQUIRED');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) throw new Error('INVALID_INSTANT');
  return ms;
}
export function assertLocalDate(value: string): void {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) throw new Error('INVALID_LOCAL_DATE');
}
export function assertTimezone(value: string): void {
  if (!value || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) throw new Error('INVALID_TIMEZONE');
  new Intl.DateTimeFormat('en-CA', {
    timeZone: value
  }).format(0);
}
function formatter(timezone: string) {
  assertTimezone(timezone);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}
function dateAt(ms: number, fmt: Intl.DateTimeFormat): string {
  const p = Object.fromEntries(fmt.formatToParts(ms).map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function localDateAt(instant: string, timezone: string): string {
  return dateAt(utcMs(instant), formatter(timezone));
}
export function addLocalDays(date: string, days: number): string {
  assertLocalDate(date);
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
/** Primeiro instante representável do dia civil, inclusive na mudança de horário à meia-noite. */
export function localDayInterval(date: string, timezone: string): Interval {
  assertLocalDate(date);
  const fmt = formatter(timezone);
  const boundary = (target: string, requireExistingDate: boolean) => {
    const nominal = Date.parse(target + 'T00:00:00Z');
    let lo = nominal - 36 * 3600000,
      hi = nominal + 36 * 3600000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (dateAt(mid, fmt) < target) lo = mid + 1;else hi = mid;
    }
    if (requireExistingDate && dateAt(lo, fmt) !== target) throw new Error('NONEXISTENT_LOCAL_DAY');
    return lo;
  };
  return {
    start: new Date(boundary(date, true)).toISOString(),
    end: new Date(boundary(addLocalDays(date, 1), false)).toISOString()
  };
}
export function assertInterval(interval: Interval): void {
  if (utcMs(interval.start) >= utcMs(interval.end)) throw new Error('INVALID_INTERVAL');
}
export function overlaps(a: Interval, b: Interval): boolean {
  assertInterval(a);
  assertInterval(b);
  return utcMs(a.start) < utcMs(b.end) && utcMs(b.start) < utcMs(a.end);
}
export function contains(outer: Interval, inner: Interval): boolean {
  assertInterval(outer);
  assertInterval(inner);
  return utcMs(outer.start) <= utcMs(inner.start) && utcMs(inner.end) <= utcMs(outer.end);
}
export function intersect(...intervals: Interval[]): Interval | null {
  intervals.forEach(assertInterval);
  const start = Math.max(...intervals.map(i => utcMs(i.start)));
  const end = Math.min(...intervals.map(i => utcMs(i.end)));
  return start < end ? {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString()
  } : null;
}
