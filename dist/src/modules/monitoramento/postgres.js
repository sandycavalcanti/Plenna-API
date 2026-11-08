import { Prisma } from '@prisma/client';
import { State } from './model.js';
import { UsageMonitoringError } from '../tempo-uso-v2/policy.js';
const instant = (value) => value == null ? null : new Date(value).toISOString();
const daily = (r) => ({
    id: String(r.diario_id),
    account: Number(r.usuario_id),
    installation: String(r.instalacao_id),
    context: String(r.contexto_id),
    date: instant(r.data_local).slice(0, 10),
    timezone: String(r.fuso_horario),
    packageId: String(r.pacote),
    duration: r.duracao_ms == null ? null : Number(r.duracao_ms),
    start: instant(r.cobertura_inicio),
    end: instant(r.cobertura_fim),
    quality: Number(r.qualidade),
    version: Number(r.versao),
    state: Number(r.estado_coleta),
    accessState: Number(r.estado_acessos),
    accessStart: instant(r.acessos_cobertura_inicio),
    accessEnd: instant(r.acessos_cobertura_fim),
    collector: Number(r.versao_coletor)
});
const access = (r) => ({
    key: String(r.chave_acesso),
    start: instant(r.inicio_utc),
    end: instant(r.fim_utc),
    quality: Number(r.qualidade)
});
export function monitoringRepository(runner) {
    const run = (account, write, work) => runner.$transaction(async (db) => {
        if (write) {
            const found = await db.$queryRaw `SELECT usuario_id FROM public.tb_usuario WHERE usuario_id=${account} AND usuario_status=true FOR UPDATE`;
            if (!found.length)
                throw new UsageMonitoringError('ACCOUNT_NOT_FOUND', 401);
        }
        return work(transaction(db));
    }, {
        timeout: 15000,
        isolationLevel: write ? 'ReadCommitted' : 'RepeatableRead'
    });
    return {
        write: (a, w) => run(a, true, w),
        read: (a, w) => run(a, false, w)
    };
}
export function transaction(db) {
    const rows = async (sql) => (await db.$queryRaw(sql)).map(daily);
    return {
        consent: async (account, detailed = false) => (await db.$queryRaw `SELECT 1 FROM public.tb_consentimento c JOIN public.tb_consentimento_tipo t USING(consentimento_tipo_id) WHERE c.usuario_id=${account} AND c.consentimento_status=true AND t.consentimento_tipo_codigo=${detailed ? 'MONITORAMENTO_ACESSOS' : 'MONITORAMENTO_TEMPO_USO'}`).length > 0,
        lockInstallation: async (id) => {
            await db.$queryRaw `SELECT pg_advisory_xact_lock(hashtextextended(${id},17017))::text`;
        },
        installation: async (id) => {
            const [r] = await db.$queryRaw `SELECT * FROM public.tb_monitoramento_instalacao WHERE instalacao_id=${id}::uuid`;
            return r ? {
                id: String(r.instalacao_id),
                hash: r.chave_hash,
                account: r.usuario_ativo_id == null ? null : Number(r.usuario_ativo_id),
                context: String(r.contexto_id),
                session: r.sessao_cliente,
                start: instant(r.inicio_contexto),
                timezone: r.fuso_contexto,
                collection: r.coleta_id,
                until: instant(r.coleta_ate)
            } : null;
        },
        saveInstallation: async (r) => {
            await db.$executeRaw `INSERT INTO public.tb_monitoramento_instalacao(instalacao_id,chave_hash,usuario_ativo_id,contexto_id,sessao_cliente,inicio_contexto,fuso_contexto,coleta_id,coleta_ate) VALUES(${r.id}::uuid,${Buffer.from(r.hash)},${r.account},${r.context}::uuid,${r.session}::uuid,${r.start ? new Date(r.start) : null},${r.timezone},${r.collection}::uuid,${r.until ? new Date(r.until) : null}) ON CONFLICT(instalacao_id) DO UPDATE SET usuario_ativo_id=EXCLUDED.usuario_ativo_id,contexto_id=EXCLUDED.contexto_id,sessao_cliente=EXCLUDED.sessao_cliente,inicio_contexto=EXCLUDED.inicio_contexto,fuso_contexto=EXCLUDED.fuso_contexto,coleta_id=EXCLUDED.coleta_id,coleta_ate=EXCLUDED.coleta_ate`;
        },
        daily: async (account, installation, context, dates) => dates.length ? rows(Prisma.sql `SELECT * FROM public.tb_monitoramento_tempo_diario WHERE usuario_id=${account} AND instalacao_id=${installation}::uuid AND contexto_id=${context}::uuid AND data_local IN (${Prisma.join(dates.map(d => Prisma.sql `${d}::date`))}) ORDER BY data_local,pacote`) : [],
        saveDaily: async (d) => {
            const result = await rows(Prisma.sql `INSERT INTO public.tb_monitoramento_tempo_diario(usuario_id,instalacao_id,contexto_id,data_local,fuso_horario,pacote,duracao_ms,cobertura_inicio,cobertura_fim,qualidade,versao,estado_coleta,estado_acessos,acessos_cobertura_inicio,acessos_cobertura_fim,versao_coletor) VALUES(${d.account},${d.installation}::uuid,${d.context}::uuid,${d.date}::date,${d.timezone},${d.packageId},${d.duration},${d.start ? new Date(d.start) : null},${d.end ? new Date(d.end) : null},${d.quality},${d.version},${d.state},${d.accessState},${d.accessStart ? new Date(d.accessStart) : null},${d.accessEnd ? new Date(d.accessEnd) : null},${d.collector}) ON CONFLICT(instalacao_id,contexto_id,data_local,pacote) DO UPDATE SET duracao_ms=EXCLUDED.duracao_ms,cobertura_inicio=EXCLUDED.cobertura_inicio,cobertura_fim=EXCLUDED.cobertura_fim,qualidade=EXCLUDED.qualidade,versao=EXCLUDED.versao,estado_coleta=EXCLUDED.estado_coleta,estado_acessos=EXCLUDED.estado_acessos,acessos_cobertura_inicio=EXCLUDED.acessos_cobertura_inicio,acessos_cobertura_fim=EXCLUDED.acessos_cobertura_fim,versao_coletor=EXCLUDED.versao_coletor RETURNING *`);
            return result[0];
        },
        accesses: async (ids) => {
            const result = new Map();
            if (!ids.length)
                return result;
            const values = await db.$queryRaw(Prisma.sql `SELECT * FROM public.tb_monitoramento_acesso WHERE diario_id IN (${Prisma.join(ids.map(id => Prisma.sql `${id}::bigint`))}) ORDER BY diario_id,inicio_utc,chave_acesso LIMIT 3001`);
            if (values.length > 3000)
                throw new UsageMonitoringError('RECONCILIATION_TOO_LARGE', 413);
            for (const r of values) {
                const id = String(r.diario_id);
                const list = result.get(id) ?? [];
                list.push(access(r));
                result.set(id, list);
            }
            return result;
        },
        putAccesses: async (id, values) => {
            if (values.length)
                await db.$executeRaw(Prisma.sql `INSERT INTO public.tb_monitoramento_acesso(diario_id,chave_acesso,inicio_utc,fim_utc,qualidade) VALUES ${Prisma.join(values.map(a => Prisma.sql `(${id}::bigint,${a.key}::uuid,${new Date(a.start)},${a.end ? new Date(a.end) : null},${a.quality})`))} ON CONFLICT(diario_id,chave_acesso) DO UPDATE SET inicio_utc=EXCLUDED.inicio_utc,fim_utc=EXCLUDED.fim_utc,qualidade=EXCLUDED.qualidade WHERE (tb_monitoramento_acesso.inicio_utc,tb_monitoramento_acesso.fim_utc,tb_monitoramento_acesso.qualidade) IS DISTINCT FROM (EXCLUDED.inicio_utc,EXCLUDED.fim_utc,EXCLUDED.qualidade)`);
        },
        removeAccesses: async (id, keys) => {
            if (keys.length)
                await db.$executeRaw(Prisma.sql `DELETE FROM public.tb_monitoramento_acesso WHERE diario_id=${id}::bigint AND chave_acesso IN (${Prisma.join(keys.map(k => Prisma.sql `${k}::uuid`))})`);
        },
        exclusions: async (account, start, end) => {
            const values = await db.$queryRaw `SELECT * FROM public.tb_monitoramento_exclusao WHERE usuario_id=${account} AND inicio_utc<${new Date(end)} AND fim_utc>${new Date(start)} LIMIT 5001`;
            if (values.length > 5000)
                throw new UsageMonitoringError('EXCLUSION_SET_TOO_LARGE', 413);
            return values.map(r => ({
                account,
                hash: Buffer.from(r.escopo_hash).toString('hex'),
                installation: r.instalacao_id,
                start: instant(r.inicio_utc),
                end: instant(r.fim_utc),
                packages: r.pacotes
            }));
        },
        exclude: async (e) => {
            await db.$executeRaw `INSERT INTO public.tb_monitoramento_exclusao(usuario_id,escopo_hash,instalacao_id,inicio_utc,fim_utc,pacotes) VALUES(${e.account},${Buffer.from(e.hash, 'hex')},${e.installation}::uuid,${new Date(e.start)},${new Date(e.end)},${e.packages}::text[]) ON CONFLICT(usuario_id,escopo_hash) DO NOTHING`;
            const [saved] = await db.$queryRaw `SELECT instalacao_id,inicio_utc,fim_utc,pacotes FROM public.tb_monitoramento_exclusao WHERE usuario_id=${e.account} AND escopo_hash=${Buffer.from(e.hash, 'hex')}`;
            if (!saved || saved.instalacao_id !== e.installation || instant(saved.inicio_utc) !== e.start || instant(saved.fim_utc) !== e.end || JSON.stringify(saved.pacotes) !== JSON.stringify(e.packages))
                throw new UsageMonitoringError('EXCLUSION_SCOPE_CONFLICT');
            // Null coverage (failed attempt) is conservatively selected by local day as well.
            const affected = Prisma.sql `SELECT diario_id FROM public.tb_monitoramento_tempo_diario WHERE usuario_id=${e.account} AND (${e.installation}::uuid IS NULL OR instalacao_id=${e.installation}::uuid) AND (${e.packages}::text[] IS NULL OR pacote=ANY(${e.packages}::text[])) AND ((cobertura_inicio<${new Date(e.end)} AND cobertura_fim>${new Date(e.start)}) OR (cobertura_inicio IS NULL AND data_local BETWEEN (${new Date(e.start)}::timestamptz AT TIME ZONE fuso_horario)::date AND (${new Date(e.end)}::timestamptz AT TIME ZONE fuso_horario)::date))`;
            await db.$executeRaw(Prisma.sql `DELETE FROM public.tb_monitoramento_acesso WHERE diario_id IN (${affected})`);
            await db.$executeRaw(Prisma.sql `UPDATE public.tb_monitoramento_tempo_diario SET duracao_ms=NULL,estado_coleta=${State.DELETED},estado_acessos=${State.DELETED},versao=versao+1 WHERE diario_id IN (${affected}) AND estado_coleta<>${State.DELETED}`);
        },
        ownsInstallation: async (account, id) => (await db.$queryRaw `SELECT 1 FROM public.tb_monitoramento_instalacao WHERE instalacao_id=${id}::uuid AND usuario_ativo_id=${account} UNION ALL SELECT 1 FROM public.tb_monitoramento_tempo_diario WHERE instalacao_id=${id}::uuid AND usuario_id=${account} LIMIT 1`).length > 0,
        accessStats: async (account, startDate, endDate) => {
            const [r] = await db.$queryRaw(Prisma.sql `SELECT count(*) FILTER(WHERE d.versao_coletor>=4 AND (a.qualidade & 257)=257) AS openings,
                count(*) AS intervals,
                count(*) FILTER(WHERE d.versao_coletor>=4 AND (a.qualidade & 513)=513) AS resumptions,
                count(*) FILTER(WHERE (a.qualidade & 1)=1 AND (d.versao_coletor<4 OR (a.qualidade & 768)=0)) AS unknown,count(*) FILTER(WHERE a.fim_utc IS NULL) AS open,COALESCE(sum(extract(epoch FROM a.fim_utc-a.inicio_utc)*1000),0)::double precision AS duration FROM public.tb_monitoramento_tempo_diario d JOIN public.tb_monitoramento_acesso a USING(diario_id) WHERE d.usuario_id=${account} AND d.data_local>=${startDate}::date AND d.data_local<${endDate}::date AND d.estado_coleta<>4 AND NOT EXISTS(SELECT 1 FROM public.tb_monitoramento_exclusao e WHERE e.usuario_id=d.usuario_id AND (e.instalacao_id IS NULL OR e.instalacao_id=d.instalacao_id) AND (e.pacotes IS NULL OR d.pacote=ANY(e.pacotes)) AND e.inicio_utc<COALESCE(a.fim_utc,d.acessos_cobertura_fim) AND e.fim_utc>a.inicio_utc)`);
            return {
                identifiedOpenings: Number(r?.openings ?? 0),
                observedIntervals: Number(r?.intervals ?? 0),
                identifiedResumptions: Number(r?.resumptions ?? 0),
                unknownEntries: Number(r?.unknown ?? 0),
                openSegments: Number(r?.open ?? 0),
                knownDurationMs: Number(r?.duration ?? 0)
            };
        },
        month: async (account, month) => {
            const result = await rows(Prisma.sql `SELECT * FROM public.tb_monitoramento_tempo_diario WHERE usuario_id=${account} AND data_local>=${month + '-01'}::date AND data_local<(${month + '-01'}::date+interval '1 month') ORDER BY data_local,diario_id LIMIT 5001`);
            if (result.length > 5000)
                throw new UsageMonitoringError('PERIOD_TOO_LARGE', 413);
            return result;
        },
        legacy: (account, month) => db.$queryRaw `SELECT tempo_uso_id,tempo_uso_nome,tempo_uso_package_id,tempo_uso_inicio,tempo_uso_fim,tempo_uso_data_local,tempo_uso_data,tempo_uso_duracao_segundos,tempo_uso_minutos FROM public.tb_tempo_uso WHERE usuario_id=${account} AND ((tempo_uso_data_local>=${month + '-01'}::date AND tempo_uso_data_local<(${month + '-01'}::date+interval '1 month')) OR (tempo_uso_data_local IS NULL AND tempo_uso_data>= ((${month + '-01'}::timestamp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC') AND tempo_uso_data< (((${month + '-01'}::timestamp+interval '1 month') AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC'))) ORDER BY tempo_uso_id LIMIT 5001`,
        page: async (account, date, after, limit) => {
            const values = await db.$queryRaw(Prisma.sql `SELECT d.*,a.chave_acesso,a.inicio_utc,a.fim_utc,a.qualidade AS acesso_qualidade FROM public.tb_monitoramento_tempo_diario d JOIN public.tb_monitoramento_acesso a USING(diario_id) WHERE d.usuario_id=${account} AND d.data_local=${date}::date AND d.estado_coleta<>4 ${after ? Prisma.sql `AND (d.diario_id,a.inicio_utc,a.chave_acesso)>(${after.id}::bigint,${new Date(after.start)},${after.key}::uuid)` : Prisma.empty} AND NOT EXISTS(SELECT 1 FROM public.tb_monitoramento_exclusao e WHERE e.usuario_id=d.usuario_id AND (e.instalacao_id IS NULL OR e.instalacao_id=d.instalacao_id) AND (e.pacotes IS NULL OR d.pacote=ANY(e.pacotes)) AND e.inicio_utc<COALESCE(a.fim_utc,d.acessos_cobertura_fim) AND e.fim_utc>a.inicio_utc) ORDER BY d.diario_id,a.inicio_utc,a.chave_acesso LIMIT ${limit}`);
            return values.map(r => ({
                ...access({
                    ...r,
                    qualidade: r.acesso_qualidade
                }),
                daily: daily(r)
            }));
        }
    };
}
