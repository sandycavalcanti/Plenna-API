import { Prisma } from '@prisma/client';
import { isUsageMonitoringEnabled } from '../tempo-uso-v2/policy.js';
import { hasUsageStorage } from '../tempo-uso-v2/storage.js';
import { redactLegacy } from '../tempo-uso-v2/legacy.js';
import { readUsageTombstones } from '../tempo-uso-v2/legacy.runtime.js';
import { prisma } from '../../lib/prisma.js';
import { parseMonth } from '../compra/financeiro.js';
import { criarSyncTempoUsoSchema } from '../tempo-uso/tempo-uso.schemas.js';
import { TEMPO_USO_SCHEMA_VERSION } from '../tempo-uso/tempo-uso.constants.js';
import { encontrarAplicativoCompra } from '../tempo-uso/aplicativos-compra.catalog.js';
export function resumirUsoAutorizado(registros, autorizacao, now) {
    const valid = registros.filter((r) => {
        if (r.tempo_uso_origem !== 'ANDROID_USAGE_STATS' ||
            !encontrarAplicativoCompra(r.tempo_uso_package_id ?? '') ||
            !r.tempo_uso_inicio ||
            !r.tempo_uso_fim ||
            !r.tempo_uso_data_local ||
            r.tempo_uso_inicio < autorizacao ||
            r.tempo_uso_data_criacao < autorizacao ||
            r.tempo_uso_data_criacao > now ||
            r.tempo_uso_data_modificacao < r.tempo_uso_data_criacao ||
            r.tempo_uso_data_modificacao > now)
            return false;
        const validation = criarSyncTempoUsoSchema(r.tempo_uso_data_modificacao).safeParse({
            schemaVersion: TEMPO_USO_SCHEMA_VERSION,
            registros: [
                {
                    packageId: r.tempo_uso_package_id,
                    dataLocal: r.tempo_uso_data_local.toISOString().slice(0, 10),
                    timezone: r.tempo_uso_timezone,
                    inicio: r.tempo_uso_inicio.toISOString(),
                    fim: r.tempo_uso_fim.toISOString(),
                    duracaoSegundos: r.tempo_uso_duracao_segundos,
                },
            ],
        });
        return validation.success;
    });
    // Fotografias sobrepostas do mesmo aplicativo não podem ser somadas como intervalos independentes.
    const safe = valid.filter((r, i) => !valid.some((other, j) => i !== j &&
        r.tempo_uso_package_id === other.tempo_uso_package_id &&
        r.tempo_uso_inicio < other.tempo_uso_fim &&
        other.tempo_uso_inicio < r.tempo_uso_fim));
    const dias = [
        ...new Set(safe.map((r) => r.tempo_uso_data_local.toISOString().slice(0, 10))),
    ].sort();
    const porDia = dias.map((data) => ({
        data,
        minutos: safe
            .filter((r) => r.tempo_uso_data_local.toISOString().slice(0, 10) === data)
            .reduce((sum, r) => sum + r.tempo_uso_duracao_segundos, 0) / 60,
    }));
    const porAplicativo = [...new Set(safe.map((r) => r.tempo_uso_package_id))]
        .sort()
        .map((packageId) => ({
        packageId,
        nome: encontrarAplicativoCompra(packageId).nomeApp,
        minutos: safe
            .filter((r) => r.tempo_uso_package_id === packageId)
            .reduce((sum, r) => sum + r.tempo_uso_duracao_segundos, 0) / 60,
    }));
    return {
        disponibilidade: safe.length
            ? 'PARCIAL'
            : 'SEM_DADOS',
        dias,
        porDia,
        porAplicativo,
        minutosRegistrados: safe.length
            ? safe.reduce((sum, r) => sum + r.tempo_uso_duracao_segundos, 0) / 60
            : null,
        referencias: safe.map((r) => `tempo-uso:${r.tempo_uso_id}`),
        associacaoComCompra: 'INDISPONIVEL',
        motivo: 'SEM_HORARIO_EFETIVO_DA_TRANSACAO',
    };
}
/** A fonte opcional usa leitura separada para que sua falha não invalide a transação financeira. */
export async function consultarUsoAplicativos(userId, periodo, now, incluirAcessos = true) {
    try {
        if (isUsageMonitoringEnabled()) {
            const { descriptiveUsage } = await import('../tempo-uso-v2/uso-contextual.adapter.js');
            const result = await descriptiveUsage(userId, periodo, incluirAcessos);
            if (result)
                return result;
        }
        return await prisma.$transaction(async (tx) => {
            const consent = await tx.tb_consentimento.findFirst({
                where: {
                    usuario_id: userId,
                    consentimento_status: true,
                    tb_consentimento_tipo: {
                        consentimento_tipo_codigo: 'MONITORAMENTO_TEMPO_USO',
                    },
                },
                select: { consentimento_data_criacao: true },
            });
            if (!consent)
                return {
                    disponibilidade: 'SEM_AUTORIZACAO',
                    dias: [],
                    minutosRegistrados: null,
                    referencias: [],
                    associacaoComCompra: 'INDISPONIVEL',
                };
            const { start, end } = parseMonth(periodo);
            const rows = await tx.tb_tempo_uso.findMany({
                where: {
                    usuario_id: userId,
                    tempo_uso_origem: 'ANDROID_USAGE_STATS',
                    tempo_uso_data_local: { gte: start, lt: end },
                    tempo_uso_inicio: { gte: consent.consentimento_data_criacao },
                    tempo_uso_data_modificacao: { lte: now },
                },
                orderBy: [{ tempo_uso_inicio: 'asc' }, { tempo_uso_id: 'asc' }],
            });
            let visible = rows;
            if (await hasUsageStorage(tx)) {
                visible = redactLegacy(rows, await readUsageTombstones(tx, userId, new Date(start.getTime() - 26 * 3600000), new Date(end.getTime() + 26 * 3600000)));
            }
            return resumirUsoAutorizado(visible, consent.consentimento_data_criacao, now);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    }
    catch {
        return {
            disponibilidade: 'INDISPONIVEL',
            dias: [],
            minutosRegistrados: null,
            referencias: [],
            associacaoComCompra: 'INDISPONIVEL',
        };
    }
}
