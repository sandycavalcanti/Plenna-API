import { z } from 'zod';
import { businessPeriod, parseMonth } from '../compra/financeiro.js';
import { AppError } from '../../errors/AppError.js';
import { consultarUsoAplicativos } from './monitoramento.service.js';
export const usoContextualQuery = z.object({ periodo: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/) }).strict();
const fonteSchema = z.object({ disponibilidade: z.enum(['PARCIAL', 'SEM_DADOS', 'SEM_AUTORIZACAO', 'INDISPONIVEL']), dias: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(31), minutosRegistrados: z.number().finite().nonnegative().nullable() });
// A narrow projection: no applications, packages, references, devices or purchases.
export function apresentarUsoContextual(raw, periodo) {
    const parsed = fonteSchema.safeParse(raw);
    if (!parsed.success)
        throw Error('USAGE_CONTEXT_OUTPUT_INVALID');
    const v = parsed.data;
    if (new Set(v.dias).size !== v.dias.length || v.dias.some(d => d.slice(0, 7) !== periodo))
        throw Error('USAGE_CONTEXT_OUTPUT_INVALID');
    const disponivel = v.disponibilidade === 'PARCIAL' && v.minutosRegistrados !== null && v.dias.length > 0;
    return { versaoContrato: 1, periodo, disponibilidade: v.disponibilidade, diasComDados: disponivel ? v.dias.length : 0, minutosRegistrados: disponivel ? v.minutosRegistrados : null,
        cobertura: 'PARCIAL_OU_DESCONHECIDA', referenciaTemporal: 'DIAS_LOCAIS_DA_FONTE_RF017', associacaoComCompra: 'INDISPONIVEL' };
}
export class UsoContextualService {
    static async consultar(userId, raw, now = new Date()) {
        const { periodo } = usoContextualQuery.parse(raw);
        parseMonth(periodo);
        if (periodo > businessPeriod(now))
            throw new AppError('Período ainda não observado', 400);
        return apresentarUsoContextual(await consultarUsoAplicativos(userId, periodo, now, false), periodo);
    }
}
