import { prisma } from '../../lib/prisma.js';
import { normalizePaymentMethodName, type CanonicalPaymentMethodName } from './payment-method.normalizer.js';

export type PaymentMethodRow = {
  forma_pagamento_id: number;
  forma_pagamento_nome: string;
};

export type PaymentMethodRepository = {
  tb_forma_pagamento: {
    findMany(args: { select: { forma_pagamento_id: true; forma_pagamento_nome: true }; orderBy: { forma_pagamento_nome: 'asc' } }): Promise<PaymentMethodRow[]>;
  };
};

export type ResolvedPaymentMethod = {
  id: number;
  name: string;
};

/**
 * Resolve texto extraido contra registros existentes, sem criar ou alterar
 * formas de pagamento. O ID sempre vem do banco, nunca de uma constante.
 */
export class PaymentMethodResolver {
  static async resolve(
    rawName: string | null | undefined,
    repository: PaymentMethodRepository = prisma,
  ): Promise<ResolvedPaymentMethod | null> {
    const canonicalName = normalizePaymentMethodName(rawName);
    if (!canonicalName) return null;

    const rows = await repository.tb_forma_pagamento.findMany({
      select: { forma_pagamento_id: true, forma_pagamento_nome: true },
      orderBy: { forma_pagamento_nome: 'asc' },
    });
    const matches = rows.filter((row) => normalizePaymentMethodName(row.forma_pagamento_nome) === canonicalName);

    // Registros duplicados para a mesma forma tornam a resolucao ambigua.
    if (matches.length !== 1) return null;

    return {
      id: matches[0].forma_pagamento_id,
      name: matches[0].forma_pagamento_nome,
    };
  }
}

export type { CanonicalPaymentMethodName };
