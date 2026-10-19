import { z } from 'zod';
import { CONSENTIMENTO_CODIGOS } from './consentimento.constants.js';
export const consentimentoCodigoSchema = z.enum([
    CONSENTIMENTO_CODIGOS.TERMOS_USO,
    CONSENTIMENTO_CODIGOS.EMAIL,
    CONSENTIMENTO_CODIGOS.MONITORAMENTO_TEMPO_USO,
]);
export const registrarConsentimentoSchema = z.object({
    consentimentoTipoCodigo: consentimentoCodigoSchema,
    status: z.boolean(),
}).strict();
export const registrarConsentimentosBulkSchema = z.array(registrarConsentimentoSchema).min(1);
