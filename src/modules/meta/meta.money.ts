import { Prisma } from '@prisma/client';

export const MAX_META_MONEY = new Prisma.Decimal('99999999.99');

const MONEY_PATTERN = /^\d{1,8}(?:\.\d{1,2})?$/;

/**
 * Contrato monetário das metas: reais decimais, nunca centavos inteiros.
 * A conversão para Decimal acontece antes de qualquer escrita no Prisma.
 */
export function canonicalMetaMoney(value: unknown, allowZero = false): string | null {
  if (value === null || value === undefined || value === '') return null;

  const text = String(value).trim();
  if (!MONEY_PATTERN.test(text)) return null;

  const decimal = new Prisma.Decimal(text);
  if (decimal.greaterThan(MAX_META_MONEY) || (!allowZero && !decimal.greaterThan(0))) return null;

  return decimal.toFixed(2);
}

export function parseMetaMoney(value: unknown): Prisma.Decimal {
  const canonical = canonicalMetaMoney(value);
  if (!canonical) throw new TypeError('Valor monetário de meta inválido');
  return new Prisma.Decimal(canonical);
}

export function serializeMetaMoney(value: unknown): string {
  if (value === null || value === undefined) throw new TypeError('Valor monetário de meta ausente');
  const decimal = new Prisma.Decimal(String(value));
  if (decimal.isNegative() || decimal.greaterThan(MAX_META_MONEY)) {
    throw new TypeError('Valor monetário de meta inválido');
  }
  return decimal.toFixed(2);
}
