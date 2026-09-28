import { Prisma } from '@prisma/client';
import { AppError } from '../../errors/AppError.js';

// Minutos legados são arredondados ao segundo mais próximo (meio segundo para cima).
// A coluna Decimal(10,2) guarda apenas a aproximação de compatibilidade; leituras
// derivam minutos dos segundos canônicos, sem reconverter essa aproximação.
export function minutosParaSegundos(valor: unknown): number {
  const minutos = valor === null || valor === undefined ? NaN : Number(valor);
  // Decimal evita que 1.025 * 60 vire 61.499999... em ponto flutuante.
  const segundos = Number.isFinite(minutos)
    ? new Prisma.Decimal(String(valor)).mul(60).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber()
    : NaN;
  if (!Number.isFinite(minutos) || minutos <= 0 || !Number.isSafeInteger(segundos) || segundos < 1 || segundos > 2147483647) {
    throw new AppError('Duração deve representar ao menos um segundo e caber em INTEGER', 400);
  }
  return segundos;
}

export function segundosDoRegistro(registro: {
  tempo_uso_duracao_segundos: number | null;
  tempo_uso_minutos: unknown;
}): number | null {
  const segundos = registro.tempo_uso_duracao_segundos;
  if (segundos !== null && segundos !== undefined) {
    return Number.isInteger(segundos) && segundos > 0 && segundos <= 2147483647 ? segundos : null;
  }
  try { return minutosParaSegundos(registro.tempo_uso_minutos); }
  catch { return null; }
}

export function duracaoLegada(segundos: number) {
  return {
    tempo_uso_duracao_segundos: segundos,
    tempo_uso_minutos: Number((segundos / 60).toFixed(2)),
  };
}
