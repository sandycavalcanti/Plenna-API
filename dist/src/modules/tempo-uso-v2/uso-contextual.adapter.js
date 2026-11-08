import { getMonitoringService } from '../monitoramento/runtime.js';
import { encontrarAplicativoCompra } from '../tempo-uso/aplicativos-compra.catalog.js';
export async function descriptiveUsage(account, month, includeAccess = true) {
    const read = await getMonitoringService().summary(account, month);
    const summary = summarizeContextualUsage(read);
    if (!summary || !read.consentActive || !includeAccess)
        return summary;
    return {
        ...summary,
        acessos: await getMonitoringService().descriptiveAccess(account, month)
    };
}
export function summarizeContextualUsage(read) {
    if (!read.migrated)
        return null;
    const empty = {
        dias: [],
        minutosRegistrados: null,
        referencias: [],
        associacaoComCompra: 'INDISPONIVEL'
    };
    if (!read.consentActive)
        return {
            ...empty,
            disponibilidade: 'SEM_AUTORIZACAO'
        };
    if (read.summary.availability === 'AMBIGUOUS')
        return {
            ...empty,
            disponibilidade: 'PARCIAL',
            motivo: 'FONTES_SOBREPOSTAS',
            qualidade: read.summary
        };
    const byDay = new Map(), byApp = new Map();
    for (const o of read.observations) {
        const valid = o.sourceStatus === 'AVAILABLE' ? o : o.lastAvailable;
        if (!valid)
            continue;
        for (const app of valid.applications ?? []) {
            if (app.durationSeconds === null || app.suppression)
                continue;
            // O contexto descritivo conserva a precisão nova sem reclassificar compras.
            const seconds = 'durationMs' in app && typeof app.durationMs === 'number' ? app.durationMs / 1000 : app.durationSeconds;
            byDay.set(o.localDate, (byDay.get(o.localDate) ?? 0) + seconds);
            byApp.set(app.packageId, (byApp.get(app.packageId) ?? 0) + seconds);
        }
    }
    return {
        ...empty,
        disponibilidade: byDay.size ? 'PARCIAL' : 'SEM_DADOS',
        dias: [...byDay.keys()].sort(),
        porDia: [...byDay].map(([data, seconds]) => ({
            data,
            minutos: seconds / 60
        })),
        porAplicativo: [...byApp].map(([packageId, seconds]) => ({
            packageId,
            nome: encontrarAplicativoCompra(packageId)?.nomeApp ?? packageId,
            minutos: seconds / 60
        })),
        minutosRegistrados: byDay.size ? [...byDay.values()].reduce((a, b) => a + b, 0) / 60 : null,
        referencias: read.summary.references.map(r => `rf017-v2:${r.associationId}:${r.localDate}:${r.revision}`),
        qualidade: read.summary,
        motivo: 'SEM_HORARIO_EFETIVO_DA_TRANSACAO'
    };
}
