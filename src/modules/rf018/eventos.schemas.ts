import { z } from 'zod';

export const eventoPosteriorSchema = z.enum([
  'CANCELAMENTO',
  'DEVOLUCAO',
  'REEMBOLSO',
  'ARREPENDIMENTO',
]);
export const eventosPosterioresSchema = z
  .array(eventoPosteriorSchema)
  .max(4)
  .refine(
    (values) => new Set(values).size === values.length,
    'Eventos repetidos',
  );
export const CHAVE_EVENTOS = '__rf018_eventos_v1';

/** Internal extension of the existing revision JSON; never expose it as an answer. */
export function separarContextoPersistido(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { respostas: raw, eventos: undefined };
  const { [CHAVE_EVENTOS]: metadata, ...respostas } = raw as Record<
    string,
    unknown
  >;
  const eventos =
    metadata === undefined
      ? undefined
      : z
          .object({ versao: z.literal(1), eventos: eventosPosterioresSchema })
          .strict()
          .parse(metadata).eventos;
  return { respostas, eventos };
}
