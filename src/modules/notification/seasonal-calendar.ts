export const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';
export const SEASONAL_LEAD_DAYS = 3;

export type SeasonalEventCode =
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
    code: 'BLACK_FRIDAY',
    resolveDate: (year) => lastWeekdayOfMonth(year, 11, 5),
    title: 'Planeje antes da Black Friday',
    message: 'A Black Friday se aproxima. Compare ofertas, reflita sobre a necessidade e confira seu planejamento antes de comprar.',
  },
  {
    code: 'NATAL',
    resolveDate: (year) => civilDate(year, 12, 25),
    title: 'Planeje seu Natal',
    message: 'O Natal se aproxima. Organize suas prioridades e reflita sobre suas compras para celebrar com mais tranquilidade.',
  },
  {
    code: 'ANO_NOVO',
    resolveDate: (year) => civilDate(year, 1, 1),
    title: 'Comece o ano com planejamento',
    message: 'O Ano Novo se aproxima. Aproveite para revisar prioridades e começar o próximo ciclo com escolhas conscientes.',
  },
  {
    code: 'DIA_DAS_MAES',
    resolveDate: (year) => nthWeekdayOfMonth(year, 5, 0, 2),
    title: 'Planeje o Dia das Mães',
    message: 'O Dia das Mães se aproxima. Antecipe suas decisões e escolha uma forma de celebrar que faça sentido para você.',
  },
  {
    code: 'DIA_DOS_NAMORADOS',
    resolveDate: (year) => civilDate(year, 6, 12),
    title: 'Planeje o Dia dos Namorados',
    message: 'O Dia dos Namorados se aproxima. Reflita sobre seus planos e compare alternativas antes de comprar.',
  },
  {
    code: 'DIA_DOS_PAIS',
    resolveDate: (year) => nthWeekdayOfMonth(year, 8, 0, 2),
    title: 'Planeje o Dia dos Pais',
    message: 'O Dia dos Pais se aproxima. Organize suas prioridades e planeje sua celebração com consumo consciente.',
  },
  {
    code: 'DIA_DAS_CRIANCAS',
    resolveDate: (year) => civilDate(year, 10, 12),
    title: 'Planeje o Dia das Crianças',
    message: 'O Dia das Crianças se aproxima. Pense nas prioridades da família e compare opções antes de comprar.',
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
