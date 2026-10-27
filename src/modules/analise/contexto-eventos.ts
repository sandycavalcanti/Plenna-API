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
export const CHAVE_EVENTOS = '__contexto_eventos_v1';
const CHAVE_EVENTOS_ANTIGA = '__rf018_eventos_v1';

/**
 * Reads the canonical context metadata and the pre-consolidation key while
 * existing rows are migrated. New revisions are always written canonically.
 */
export function separarContextoPersistido(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { respostas: raw, eventos: undefined };
  const source = raw as Record<string, unknown>;
  const { [CHAVE_EVENTOS]: canonicalMetadata, [CHAVE_EVENTOS_ANTIGA]: oldMetadata, ...respostas } = source;
  const metadata = canonicalMetadata ?? oldMetadata;
  const eventos =
    metadata === undefined
      ? undefined
      : z
          .object({ versao: z.literal(1), eventos: eventosPosterioresSchema })
          .strict()
          .parse(metadata).eventos;
  return { respostas, eventos };
}
