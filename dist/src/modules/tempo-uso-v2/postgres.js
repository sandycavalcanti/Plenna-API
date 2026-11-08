import { Prisma } from '@prisma/client';
import { localDayInterval } from './time.js';
import { UsageMonitoringError } from './policy.js';
export function postgresRepository(database) {
    return { transaction: (accountId, work) => database.$transaction(async (db) => {
            // Shared first lock with consent revocation, exclusion and v1 ingestion.
            const users = await db.$queryRaw `SELECT usuario_id FROM public.tb_usuario WHERE usuario_id=${accountId} AND usuario_status=true FOR UPDATE`;
            if (!users.length)
                throw new UsageMonitoringError('ACCOUNT_NOT_FOUND', 401);
            return work(transaction(db));
        }, { timeout: 15000, isolationLevel: 'ReadCommitted' }) };
}
export function transaction(db) {
    const document = async (sql) => (await db.$queryRaw(sql))[0]?.document ?? null;
    const hydrate = async (rows) => {
        if (!rows.length)
            return [];
        const apps = await db.$queryRaw(Prisma.sql `
      SELECT * FROM public.rf017_application WHERE "snapshotKey" IN (${Prisma.join(rows.map(r => r.key))}) ORDER BY "packageId"`);
        const byKey = new Map();
        for (const app of apps) {
            const list = byKey.get(app.snapshotKey) ?? [];
            list.push({ packageId: app.packageId, durationSeconds: app.durationSeconds, suppression: app.tombstoneIds.length ? { reason: 'DELETED_INTERVAL', tombstoneIds: app.tombstoneIds } : null });
            byKey.set(app.snapshotKey, list);
        }
        return rows.map(r => ({ ...r, applications: byKey.get(r.key) ?? [] }));
    };
    const snapshots = async (sql) => hydrate(await db.$queryRaw(sql));
    return {
        consent: async (accountId) => (await db.$queryRaw `SELECT 1 FROM public.tb_consentimento c JOIN public.tb_consentimento_tipo t USING(consentimento_tipo_id) WHERE c.usuario_id=${accountId} AND c.consentimento_status=true AND t.consentimento_tipo_codigo='MONITORAMENTO_TEMPO_USO'`).length > 0,
        installation: async (id) => (await db.$queryRaw `SELECT id,"secretHash" FROM public.rf017_installation WHERE id=${id}::uuid`)[0] ?? null,
        saveInstallation: async (id, hash) => { await db.$executeRaw `INSERT INTO public.rf017_installation(id,"secretHash") VALUES(${id}::uuid,${hash})`; },
        // Arbitrary UUIDs cannot authorize installation use; a separate secret is checked by service.
        lockInstallation: async (id) => { await db.$queryRaw `SELECT pg_advisory_xact_lock(hashtextextended(${id},17017))::text AS locked`; },
        current: id => document(Prisma.sql `SELECT document FROM public.rf017_association WHERE "installationId"=${id}::uuid AND state='ACTIVE'`),
        association: id => document(Prisma.sql `SELECT document FROM public.rf017_association WHERE id=${id}::uuid`),
        associations: async (ids) => ids.length ? (await db.$queryRaw(Prisma.sql `SELECT document FROM public.rf017_association WHERE id::text IN (${Prisma.join(ids)})`)).map(r => r.document) : [],
        authorization: (account, id) => document(Prisma.sql `SELECT document FROM public.rf017_authorization WHERE "accountId"=${account} AND "installationId"=${id}::uuid ORDER BY (document->>'revokedAt' IS NULL) DESC,"createdAt" DESC,id DESC LIMIT 1`),
        saveAuthorization: async (a) => { await db.$executeRaw `INSERT INTO public.rf017_authorization(id,"accountId","installationId","createdAt",document) VALUES(${a.id}::uuid,${a.accountId},${a.installationId}::uuid,${new Date(a.grantedAt)},${JSON.stringify(a)}::jsonb) ON CONFLICT(id) DO UPDATE SET document=EXCLUDED.document`; },
        saveAssociation: async (a) => {
            if (a.state === 'CLOSED')
                await db.$executeRaw `UPDATE public.rf017_association SET state='CLOSED',document=${JSON.stringify(a)}::jsonb WHERE id=${a.id}::uuid`;
            else
                await db.$executeRaw `INSERT INTO public.rf017_association(id,"accountId","installationId","authorizationId",state,"eligibleFrom",document) VALUES(${a.id}::uuid,${a.accountId},${a.installationId}::uuid,${a.authorizationId}::uuid,${a.state},${new Date(a.eligibleFrom)},${JSON.stringify(a)}::jsonb) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,document=EXCLUDED.document`;
        },
        receipt: async (key) => (await db.$queryRaw `SELECT key,"accountId",fingerprint,response FROM public.rf017_receipt WHERE key=${key}`)[0] ?? null,
        saveReceipt: async (r) => { await db.$executeRaw `INSERT INTO public.rf017_receipt(key,"accountId",fingerprint,response) VALUES(${r.key},${r.accountId},${r.fingerprint},${JSON.stringify(r.response)}::jsonb)`; },
        snapshot: async (key) => (await snapshots(Prisma.sql `SELECT key,"accountId","associationId",to_char("localDate",'YYYY-MM-DD') AS "localDate",revision,fingerprint,latest,available FROM public.rf017_snapshot WHERE key=${key}`))[0] ?? null,
        saveSnapshot: async (s) => {
            await db.$executeRaw `INSERT INTO public.rf017_snapshot(key,"accountId","associationId","localDate",revision,fingerprint,latest,available) VALUES(${s.key},${s.accountId},${s.associationId}::uuid,${s.localDate}::date,${s.revision},${s.fingerprint},${JSON.stringify(s.latest)}::jsonb,${s.available ? JSON.stringify(s.available) : null}::jsonb) ON CONFLICT(key) DO UPDATE SET revision=EXCLUDED.revision,fingerprint=EXCLUDED.fingerprint,latest=EXCLUDED.latest,available=EXCLUDED.available`;
            await db.$executeRaw `DELETE FROM public.rf017_application WHERE "snapshotKey"=${s.key}`;
            if (s.applications.length)
                await db.$executeRaw(Prisma.sql `INSERT INTO public.rf017_application("snapshotKey","packageId","durationSeconds","tombstoneIds") VALUES ${Prisma.join(s.applications.map(app => Prisma.sql `(${s.key},${app.packageId},${app.durationSeconds},${app.suppression?.tombstoneIds ?? []}::uuid[])`))}`);
        },
        snapshots: (account, month) => snapshots(Prisma.sql `SELECT key,"accountId","associationId",to_char("localDate",'YYYY-MM-DD') AS "localDate",revision,fingerprint,latest,available FROM public.rf017_snapshot WHERE "accountId"=${account} AND "localDate">=${month + '-01'}::date AND "localDate"<(${month + '-01'}::date+interval '1 month') ORDER BY "localDate",key LIMIT 5001`),
        affectedSnapshots: (account, start, end) => snapshots(Prisma.sql `SELECT key,"accountId","associationId",to_char("localDate",'YYYY-MM-DD') AS "localDate",revision,fingerprint,latest,available FROM public.rf017_snapshot WHERE "accountId"=${account} AND available IS NOT NULL AND (available->'coverage'->'interval'->>'start')::timestamptz<${new Date(end)} AND (available->'coverage'->'interval'->>'end')::timestamptz>${new Date(start)} LIMIT 5001`),
        tombstones: async (account, start, end) => (await db.$queryRaw `SELECT document FROM public.rf017_tombstone WHERE "accountId"=${account} AND start<${new Date(end)} AND "end">${new Date(start)}`).map(r => r.document),
        saveTombstone: async (t) => { const period = t.effectiveInterval ?? (t.scope.kind === 'APP_DAY' ? localDayInterval(t.scope.localDate, t.scope.timezone) : t.scope.interval); await db.$executeRaw `INSERT INTO public.rf017_tombstone(id,"accountId",start,"end",document) VALUES(${t.id}::uuid,${t.accountId},${new Date(period.start)},${new Date(period.end)},${JSON.stringify(t)}::jsonb)`; },
        migrated: async (account) => (await db.$queryRaw `SELECT 1 FROM public.rf017_authorization WHERE "accountId"=${account} LIMIT 1`).length > 0,
        legacy: async (account, month) => db.$queryRaw `SELECT tempo_uso_id,tempo_uso_nome,tempo_uso_package_id,tempo_uso_inicio,tempo_uso_fim,tempo_uso_data_local,tempo_uso_data,tempo_uso_duracao_segundos,tempo_uso_minutos FROM public.tb_tempo_uso WHERE usuario_id=${account} AND ((tempo_uso_data_local>=${month + '-01'}::date AND tempo_uso_data_local<(${month + '-01'}::date+interval '1 month')) OR (tempo_uso_data_local IS NULL AND tempo_uso_data>=((${month + '-01'}::timestamp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC') AND tempo_uso_data<(((${month + '-01'}::timestamp+interval '1 month') AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC'))) ORDER BY tempo_uso_id LIMIT 5001`,
    };
}
