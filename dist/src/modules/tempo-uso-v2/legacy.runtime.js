import { prisma } from '../../lib/prisma.js';
import { redactLegacy } from './legacy.js';
import { hasUsageStorage, usageStorageKind } from './storage.js';
import { transaction } from '../monitoramento/postgres.js';
export async function readUsageTombstones(tx, account, start, end) {
    if ((await usageStorageKind(tx)) === 'current') {
        const values = await transaction(tx).exclusions(account, (start ?? new Date('1900-01-01Z')).toISOString(), (end ?? new Date('9999-01-01Z')).toISOString());
        return values.map(e => ({
            id: e.hash,
            accountId: account,
            createdAt: e.start,
            target: e.installation ? {
                kind: 'INSTALLATION',
                installationId: e.installation
            } : {
                kind: 'ACCOUNT'
            },
            scope: {
                kind: 'PERIOD',
                interval: {
                    start: e.start,
                    end: e.end
                },
                packageIds: e.packages
            },
            effectiveInterval: {
                start: e.start,
                end: e.end
            }
        }));
    }
    return (await tx.$queryRaw `SELECT document FROM public.rf017_tombstone WHERE "accountId"=${account}`).map(r => r.document);
}
export async function legacyReadOverlay(account, rows) {
    return prisma.$transaction(async (tx) => {
        if (!(await hasUsageStorage(tx)))
            return rows;
        await tx.$queryRaw `SELECT usuario_id FROM public.tb_usuario WHERE usuario_id=${account} FOR UPDATE`;
        return redactLegacy(rows, await readUsageTombstones(tx, account));
    });
}
