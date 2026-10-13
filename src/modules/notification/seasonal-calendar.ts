export const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';
export const SEASONAL_LEAD_DAYS = 3;

export type SeasonalEventCode =
  | 'SEMANA_CONSUMIDOR'
  | 'BLACK_FRIDAY'
  | 'NATAL'
  | 'ANO_NOVO'
  | 'DIA_DAS_MAES'
  | 'DIA_DOS_NAMORADOS'
  | 'DIA_DOS_PAIS'
  | 'DIA_DAS_CRIANCAS';

export type CivilDate = {
  year: number;
  month: number;
  day: number;
};

export type SeasonalEventDefinition = {
  code: SeasonalEventCode;
  resolveDate: (year: number) => CivilDate;
  title: string;
  message: string;
};

export type ResolvedSeasonalEvent = {
  definition: SeasonalEventDefinition;
  eventDate: CivilDate;
};

const CIVIL_DAY_MS = 24 * 60 * 60 * 1000;

export function civilDate(year: number, month: number, day: number): CivilDate {
  return { year, month, day };
}

export function getBusinessCivilDate(referenceDate: Date): CivilDate {
  if (Number.isNaN(referenceDate.getTime())) {
    throw new Error('referenceDate inválida');
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(referenceDate);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return civilDate(Number(values.year), Number(values.month), Number(values.day));
}

function toCivilUtc(date: CivilDate) {
  return Date.UTC(date.year, date.month - 1, date.day);
}

export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(toCivilUtc(date) + days * CIVIL_DAY_MS);
  return civilDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

export function differenceInCivilDays(later: CivilDate, earlier: CivilDate) {
  return Math.round((toCivilUtc(later) - toCivilUtc(earlier)) / CIVIL_DAY_MS);
}

export function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  occurrence: number,
): CivilDate {
  if (month < 1 || month > 12) throw new Error('month inválido');
  if (weekday < 0 || weekday > 6) throw new Error('weekday inválido');
  if (occurrence < 1) throw new Error('occurrence inválida');

  const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (weekday - firstDay + 7) % 7;
  const day = 1 + offset + (occurrence - 1) * 7;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCMonth() !== month - 1) throw new Error('weekday não existe no mês');

  return civilDate(year, month, day);
}

export function lastWeekdayOfMonth(year: number, month: number, weekday: number): CivilDate {
  if (month < 1 || month > 12) throw new Error('month inválido');
  if (weekday < 0 || weekday > 6) throw new Error('weekday inválido');

  const lastDay = new Date(Date.UTC(year, month, 0));
  const offset = (lastDay.getUTCDay() - weekday + 7) % 7;
  return civilDate(year, month, lastDay.getUTCDate() - offset);
}

export const SEASONAL_EVENTS: readonly SeasonalEventDefinition[] = [
  {
    code: 'SEMANA_CONSUMIDOR',
    resolveDate: (year) => civilDate(year, 3, 15),
    title: 'Compre com intenção',
    message: 'Aproveite as ofertas sem sair das suas metas. Desconto só vale a pena quando a compra realmente faz sentido.',
  },
  {
    code: 'BLACK_FRIDAY',
    resolveDate: (year) => lastWeekdayOfMonth(year, 11, 5),
    title: 'Cuidado com a urgência da Black Friday',
    message: 'Revise suas metas antes de comprar. Uma oferta só é boa se fizer sentido e couber no seu planejamento.',
  },
  {
    code: 'NATAL',
    resolveDate: (year) => civilDate(year, 12, 25),
    title: 'Presenteie sem sair do plano',
    message: 'Evite compras por pressão. Carinho e significado podem valer mais do que um presente caro.',
  },
  {
    code: 'ANO_NOVO',
    resolveDate: (year) => civilDate(year, 1, 1),
    title: 'Comece o ano com equilíbrio',
    message: 'Antes das compras de fim de ano, confira suas metas e evite começar o próximo ciclo fora do planejamento.',
  },
  {
    code: 'DIA_DAS_MAES',
    resolveDate: (year) => nthWeekdayOfMonth(year, 5, 0, 2),
    title: 'Presenteie com consciência',
    message: 'Carinho não se mede pelo preço. Escolha algo especial sem ultrapassar seus limites.',
  },
  {
    code: 'DIA_DOS_NAMORADOS',
    resolveDate: (year) => civilDate(year, 6, 12),
    title: 'Amor não precisa custar mais',
    message: 'Respeite suas metas e escolha com intenção. O melhor presente nem sempre é o mais caro.',
  },
  {
    code: 'DIA_DOS_PAIS',
    resolveDate: (year) => nthWeekdayOfMonth(year, 8, 0, 2),
    title: 'Planeje antes de presentear',
    message: 'Defina um limite antes das compras e escolha algo especial sem comprometer seus objetivos.',
  },
  {
    code: 'DIA_DAS_CRIANCAS',
    resolveDate: (year) => civilDate(year, 10, 12),
    title: 'Presente também é escolha consciente',
    message: 'Nem sempre mais ou mais caro é melhor. Respeite seu limite e escolha com significado.',
  },
];

export function resolveEligibleSeasonalEvents(
  referenceDate: Date,
  catalog: readonly SeasonalEventDefinition[] = SEASONAL_EVENTS,
): ResolvedSeasonalEvent[] {
  const today = getBusinessCivilDate(referenceDate);
  const yearsToCheck = [today.year, today.year + 1];
  const eligible: ResolvedSeasonalEvent[] = [];

  for (const definition of catalog) {
    for (const year of yearsToCheck) {
      const eventDate = definition.resolveDate(year);
      if (differenceInCivilDays(eventDate, today) === SEASONAL_LEAD_DAYS) {
        eligible.push({ definition, eventDate });
      }
    }
  }

  return eligible;
}
