import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { prepareSchema, ingestSchema, closeSchema, State, Q, accessKey, exclusionHash, stableId } from './model.js';
import { APLICATIVOS_COMPRA } from '../tempo-uso/aplicativos-compra.catalog.js';
import { addLocalDays, localDateAt, localDayInterval, contains, overlaps, utcMs } from '../tempo-uso-v2/time.js';
import { deletionRequestSchema } from '../tempo-uso-v2/schemas.js';
import { UsageMonitoringError } from '../tempo-uso-v2/policy.js';
import { redactLegacy } from '../tempo-uso-v2/legacy.js';
import { segundosDoRegistro } from '../tempo-uso/tempo-uso.duracao.js';
import { consolidateSources } from '../tempo-uso-v2/snapshot.js';
const iso = (n) => new Date(n).toISOString();
const fail = (code, status = 409) => {
    throw new UsageMonitoringError(code, status);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export class MonitoringService {
    constructor(repo, clock = () => new Date(), uuid = randomUUID) {
        this.repo = repo;
        this.clock = clock;
        this.uuid = uuid;
    }
    async identity(tx, id, secret, create = false) {
        if (!/^[a-f0-9]{64}$/.test(secret))
            return fail('INSTALLATION_CREDENTIAL_REQUIRED', 403);
        await tx.lockInstallation(id);
        const hash = createHash('sha256').update(secret).digest();
        let row = await tx.installation(id);
        if (!row) {
            if (!create)
                return fail('INSTALLATION_NOT_FOUND', 403);
            row = {
                id,
                hash,
                account: null,
                context: this.uuid(),
                session: null,
                start: null,
                timezone: null,
                collection: null,
                until: null,
                created: true
            };
        }
        else if (row.hash.length !== hash.length || !timingSafeEqual(row.hash, hash))
            return fail('INSTALLATION_CREDENTIAL_INVALID', 403);
        return row;
    }
    active(row, account, session, context) {
        if (row.account !== account || row.session !== session || row.context !== context || !row.start || !row.timezone)
            return fail('ASSOCIATION_CHANGED');
    }
    prepare(account, body, secret) {
        const req = prepareSchema.parse(body);
        return this.repo.write(account, async (tx) => {
            if (!(await tx.consent(account)))
                return fail('CONSENT_REQUIRED', 403);
            const detailed = await tx.consent(account, true);
            let row = await this.identity(tx, req.installationId, secret, req.activate);
            const same = row.account === account && row.session === req.sessionId && row.timezone === req.timezone;
            if (!same) {
                if (!req.activate)
                    return fail('ACTIVATION_REQUIRED', 403);
                // A confirmação pertence ao contexto atual, inclusive quando inativo.
                // Uma ativação atrasada não pode reabrir um contexto revogado ou encerrado.
                const challenge = stableId([row.context, account, req.sessionId, req.timezone]);
                if (req.activationProof !== challenge) {
                    if (row.created)
                        await tx.saveInstallation(row);
                    return {
                        schemaVersion: 3,
                        activationChallenge: challenge
                    };
                }
                row = {
                    ...row,
                    account,
                    session: req.sessionId,
                    context: this.uuid(),
                    start: this.clock().toISOString(),
                    timezone: req.timezone
                };
            }
            else if (req.expectedContextId !== row.context && req.expectedContextId !== null)
                return fail('ASSOCIATION_CHANGED');
            row = {
                ...row,
                collection: this.uuid(),
                until: this.clock().toISOString()
            };
            await tx.saveInstallation(row);
            const today = localDateAt(row.until, row.timezone), windows = [];
            for (let i = 0; i <= 2; i++) {
                const date = addLocalDays(today, -i), civil = localDayInterval(date, row.timezone);
                const start = Math.max(utcMs(civil.start), utcMs(row.start)), end = Math.min(utcMs(civil.end), utcMs(row.until));
                if (start < end)
                    windows.push({
                        localDate: date,
                        start: iso(start),
                        end: iso(end)
                    });
            }
            const previous = await tx.daily(account, row.id, row.context, windows.map(w => w.localDate));
            return {
                schemaVersion: 3,
                contextId: row.context,
                collectionId: row.collection,
                serverTime: row.until,
                eligibleFrom: row.start,
                timezone: row.timezone,
                detailedAccessAllowed: detailed,
                catalog: APLICATIVOS_COMPRA,
                windows,
                previous: previous.map(d => ({
                    localDate: d.date,
                    packageId: d.packageId,
                    version: d.version,
                    durationMs: d.duration,
                    interval: d.start && d.end ? {
                        start: d.start,
                        end: d.end
                    } : null
                })),
                limits: {
                    maxObservations: 90,
                    maxAccesses: 1000,
                    maxBytes: 512000
                }
            };
        });
    }
    close(account, body, secret) {
        const req = closeSchema.parse(body);
        return this.repo.write(account, async (tx) => {
            const row = await this.identity(tx, req.installationId, secret);
            if (row.account === null)
                return {
                    schemaVersion: 3,
                    closed: true
                };
            this.active(row, account, req.sessionId, req.contextId);
            await tx.saveInstallation({
                ...row,
                account: null,
                session: null,
                start: null,
                timezone: null,
                collection: null,
                until: null,
                context: this.uuid()
            });
            return {
                schemaVersion: 3,
                closed: true
            };
        });
    }
    ingest(account, body, secret) {
        const req = ingestSchema.parse(body);
        for (const o of req.observations) {
            o.interval = {
                start: iso(utcMs(o.interval.start)),
                end: iso(utcMs(o.interval.end))
            };
            for (const a of [...o.accesses, ...o.corrections.flatMap(c => c.replacement ? [c.replacement] : [])]) {
                a.origin = iso(utcMs(a.origin));
                a.start = iso(utcMs(a.start));
                a.end = a.end === null ? null : iso(utcMs(a.end));
            }
        }
        if (Buffer.byteLength(JSON.stringify(req)) > 512000)
            return fail('BATCH_TOO_LARGE', 413);
        return this.repo.write(account, async (tx) => {
            if (!(await tx.consent(account)))
                return fail('CONSENT_REQUIRED', 403);
            const detailed = await tx.consent(account, true), row = await this.identity(tx, req.installationId, secret);
            this.active(row, account, req.sessionId, req.contextId);
            if (row.collection !== req.collectionId || !row.until || this.clock().getTime() - utcMs(row.until) > 15 * 60000)
                return fail('STALE_COLLECTION');
            const dates = [...new Set(req.observations.map(o => o.localDate))];
            const existing = await tx.daily(account, row.id, row.context, dates), byKey = new Map(existing.map(d => [`${d.date}/${d.packageId}`, d]));
            const oldAccess = await tx.accesses(existing.map(d => d.id));
            const exclusions = await tx.exclusions(account, iso(Math.min(...req.observations.map(o => utcMs(o.interval.start)))), iso(Math.max(...req.observations.map(o => utcMs(o.interval.end)))));
            const seen = new Set(), results = [];
            for (const o of req.observations) {
                if (o.collectorVersion === 3 && o.quality > 255)
                    return fail('INVALID_COLLECTOR_QUALITY', 400);
                const key = `${o.localDate}/${o.packageId}`;
                if (seen.has(key))
                    return fail('DUPLICATE_OBSERVATION');
                seen.add(key);
                const civil = localDayInterval(o.localDate, row.timezone), today = localDateAt(row.until, row.timezone);
                if (!APLICATIVOS_COMPRA.some(p => p.packageId === o.packageId) || o.localDate > today || o.localDate < addLocalDays(today, -2) || !contains(civil, o.interval) || utcMs(o.interval.start) < utcMs(row.start) || utcMs(o.interval.end) > utcMs(row.until))
                    return fail('SNAPSHOT_NOT_ELIGIBLE');
                if (!detailed && (o.accesses.length || o.corrections.length))
                    return fail('DETAILED_CONSENT_REQUIRED', 403);
                const previous = byKey.get(key), before = previous ? oldAccess.get(previous.id) ?? [] : [];
                if (previous && o.collectorVersion < previous.collector)
                    return fail('COLLECTOR_VERSION_REGRESSION');
                const matching = exclusions.filter(e => (!e.installation || e.installation === row.id) && (!e.packages || e.packages.includes(o.packageId)) && overlaps(e, o.interval));
                let next = previous ? {
                    ...previous
                } : {
                    id: '0',
                    account,
                    installation: row.id,
                    context: row.context,
                    date: o.localDate,
                    timezone: row.timezone,
                    packageId: o.packageId,
                    duration: null,
                    start: null,
                    end: null,
                    quality: 0,
                    version: 0,
                    state: State.UNAVAILABLE,
                    accessState: State.UNAVAILABLE,
                    accessStart: null,
                    accessEnd: null,
                    collector: o.collectorVersion
                };
                let after = [...before], removed = [];
                if (matching.length) {
                    next = {
                        ...next,
                        duration: null,
                        state: State.DELETED,
                        accessState: State.DELETED
                    };
                    removed = before.map(a => a.key);
                    after = [];
                }
                else if (o.status === 'UNAVAILABLE') {
                    if (o.durationMs !== null || o.accesses.length || o.corrections.length)
                        return fail('INVALID_UNAVAILABLE_OBSERVATION', 400);
                    next.state = State.UNAVAILABLE;
                    next.accessState = State.UNAVAILABLE;
                }
                else {
                    if (o.durationMs === null || o.durationMs > utcMs(o.interval.end) - utcMs(o.interval.start))
                        return fail('INVALID_DURATION', 400);
                    if (previous?.start && previous.end && !contains(o.interval, {
                        start: previous.start,
                        end: previous.end
                    }))
                        return fail('COVERAGE_REGRESSION');
                    const incoming = o.accesses.map(a => this.access(a, o, row));
                    if (new Set(incoming.map(a => a.key)).size !== incoming.length)
                        return fail('DUPLICATE_ACCESS');
                    const merged = new Map(before.map(a => [a.key, a]));
                    for (const a of incoming) {
                        const old = merged.get(a.key);
                        if (old?.end && (!a.end || utcMs(a.end) < utcMs(old.end)) && !o.corrections.some(c => c.previousKey === a.key))
                            return fail('ACCESS_REGRESSION');
                        merged.set(a.key, a);
                    }
                    for (const c of o.corrections) {
                        if (!before.some(a => a.key === c.previousKey) && (previous?.version ?? 0) === o.expectedVersion)
                            return fail('CORRECTION_NOT_FOUND');
                        removed.push(c.previousKey);
                        merged.delete(c.previousKey);
                        if (c.replacement) {
                            const a = this.access(c.replacement, o, row);
                            merged.set(a.key, a);
                        }
                    }
                    after = [...merged.values()].sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
                    // Eventos ausentes não são exclusões: reduzir exige correção explícita e versionada.
                    if (previous?.duration !== null && previous?.duration !== undefined && o.durationMs < previous.duration && !o.corrections.length && o.totalCorrection?.previousDurationMs !== previous.duration)
                        return fail('CORRECTION_EVIDENCE_REQUIRED');
                    let knownDuration = 0, knownEnd = 0;
                    for (const a of after) {
                        if (!a.end)
                            continue;
                        const start = utcMs(a.start), end = utcMs(a.end);
                        if (start < knownEnd)
                            return fail('ACCESS_RECONSTRUCTION_CONFLICT');
                        knownDuration += end - start;
                        knownEnd = end;
                    }
                    if (detailed && o.durationMs < knownDuration)
                        return fail('ACCESS_TOTAL_CONFLICT');
                    next = {
                        ...next,
                        duration: o.durationMs,
                        start: o.interval.start,
                        end: o.interval.end,
                        quality: o.quality,
                        collector: o.collectorVersion,
                        state: o.quality ? State.PARTIAL : State.AVAILABLE,
                        accessState: detailed ? o.quality ? State.PARTIAL : State.AVAILABLE : State.UNAVAILABLE,
                        accessStart: detailed ? o.interval.start : next.accessStart,
                        accessEnd: detailed ? o.interval.end : next.accessEnd
                    };
                }
                const changed = !equal({
                    ...next,
                    id: '',
                    version: 0
                }, {
                    ...previous,
                    id: '',
                    version: 0
                }) || !equal(after, [...before].sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key)));
                if ((previous?.version ?? 0) !== o.expectedVersion && changed)
                    return fail('REVISION_CONFLICT');
                if (changed) {
                    next.version = (previous?.version ?? 0) + 1;
                    next = await tx.saveDaily(next);
                    if (removed.length)
                        await tx.removeAccesses(next.id, removed);
                    const updates = after.filter(a => !before.some(b => equal(a, b)));
                    if (updates.length)
                        await tx.putAccesses(next.id, updates);
                }
                results.push({
                    localDate: o.localDate,
                    packageId: o.packageId,
                    version: next.version,
                    status: changed ? 'APPLIED' : 'DUPLICATE'
                });
            }
            return {
                schemaVersion: 3,
                results
            };
        });
    }
    access(a, o, row) {
        const entry = a.quality & (Q.INDEPENDENT | Q.RESUMPTION | Q.ENTRY_UNKNOWN);
        if (o.collectorVersion === 3 && a.quality > 255 || o.collectorVersion === 4 && (a.quality & Q.OPENING ? ![Q.INDEPENDENT, Q.RESUMPTION, Q.ENTRY_UNKNOWN].includes(entry) : entry !== 0))
            return fail('INVALID_ENTRY_CLASSIFICATION', 400);
        if (utcMs(a.origin) < utcMs(row.start) || utcMs(a.origin) > utcMs(a.start) || utcMs(a.start) < utcMs(o.interval.start) || utcMs(a.start) >= utcMs(o.interval.end) || a.end && (utcMs(a.end) <= utcMs(a.start) || utcMs(a.end) > utcMs(o.interval.end)))
            return fail('INVALID_ACCESS_INTERVAL', 400);
        if (a.end === null && !(a.quality & Q.OPEN) || a.end !== null && !(a.quality & (Q.END | Q.BOUNDARY)))
            return fail('INVALID_ACCESS_QUALITY', 400);
        if (a.quality & Q.OPENING && utcMs(a.origin) !== utcMs(a.start))
            return fail('INVALID_ACCESS_OPENING', 400);
        return {
            key: accessKey(row.context, o.packageId, a.origin),
            start: a.start,
            end: a.end,
            quality: a.quality
        };
    }
    delete(account, body) {
        const req = deletionRequestSchema.parse(body);
        return this.repo.write(account, async (tx) => {
            const installation = req.target.kind === 'INSTALLATION' ? req.target.installationId : null;
            if (installation && !(await tx.ownsInstallation(account, installation)))
                return fail('INSTALLATION_NOT_FOUND', 404);
            const interval = req.scope.kind === 'APP_DAY' ? localDayInterval(req.scope.localDate, req.scope.timezone) : req.scope.interval;
            const value = {
                account,
                installation,
                start: iso(utcMs(interval.start)),
                end: iso(utcMs(interval.end)),
                packages: req.scope.kind === 'APP_DAY' ? [req.scope.packageId] : req.scope.packageIds ? [...new Set(req.scope.packageIds)].sort() : null
            };
            const hash = exclusionHash(value);
            await tx.exclude({
                ...value,
                hash
            });
            return {
                schemaVersion: 2,
                operationId: req.operationId,
                tombstone: {
                    id: hash,
                    accountId: account,
                    target: req.target,
                    scope: req.scope,
                    effectiveInterval: interval
                }
            };
        });
    }
    accessPage(account, date, after, limit) {
        return this.repo.read(account, async (tx) => {
            if (!(await tx.consent(account, true)))
                return fail('DETAILED_CONSENT_REQUIRED', 403);
            const rows = await tx.page(account, date, after, limit + 1), items = rows.slice(0, limit), last = items[items.length - 1];
            const stats = await tx.accessStats(account, date, addLocalDays(date, 1));
            return {
                schemaVersion: 3,
                date,
                coverage: 'PARTIAL',
                stats,
                items: items.map(a => ({
                    key: a.key,
                    dailyId: a.daily.id,
                    packageId: a.daily.packageId,
                    installationId: a.daily.installation,
                    timezone: a.daily.timezone,
                    start: a.start,
                    end: a.end,
                    durationMs: a.end ? utcMs(a.end) - utcMs(a.start) : null,
                    quality: a.quality,
                    collectorVersion: a.daily.collector
                })),
                nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({
                    id: last.daily.id,
                    start: last.start,
                    key: last.key
                })).toString('base64url') : null
            };
        });
    }
    descriptiveAccess(account, month) {
        return this.repo.read(account, async (tx) => {
            if (!(await tx.consent(account)) || !(await tx.consent(account, true)))
                return null;
            const next = new Date(month + '-01T00:00:00Z');
            next.setUTCMonth(next.getUTCMonth() + 1);
            return {
                ...(await tx.accessStats(account, month + '-01', next.toISOString().slice(0, 10))),
                coverage: 'PARTIAL',
                semantics: 'OBSERVED_ACCESS_CONTEXT_NOT_CAUSAL'
            };
        });
    }
    async summary(account, month) {
        return this.repo.read(account, async (tx) => {
            const rows = await tx.month(account, month), raw = await tx.legacy(account, month), start = localDayInterval(month + '-01', 'UTC').start;
            const end = new Date(start);
            end.setUTCMonth(end.getUTCMonth() + 1);
            const exclusions = await tx.exclusions(account, iso(utcMs(start) - 26 * 3600000), iso(end.getTime() + 26 * 3600000));
            const tombstones = exclusions.map(e => ({
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
            if (raw.length > 5000)
                return fail('PERIOD_TOO_LARGE', 413);
            const legacy = redactLegacy(raw, tombstones);
            const observations = rows.map(d => {
                const deleted = d.state === State.DELETED || exclusions.some(e => (!e.installation || e.installation === d.installation) && (!e.packages || e.packages.includes(d.packageId)) && d.start && d.end && overlaps(e, {
                    start: d.start,
                    end: d.end
                }));
                const applications = [{
                        packageId: d.packageId,
                        durationMs: deleted ? null : d.duration,
                        durationSeconds: deleted ? null : d.duration === null ? null : Math.floor(d.duration / 1000),
                        suppression: deleted ? {
                            reason: 'DELETED_INTERVAL',
                            tombstoneIds: exclusions.map(e => e.hash)
                        } : null
                    }];
                const valid = d.duration !== null || deleted;
                const base = {
                    associationId: d.context,
                    localDate: d.date,
                    timezone: d.timezone,
                    revision: d.version,
                    observedAt: d.end ?? d.date + 'T00:00:00.000Z',
                    provenance: {
                        source: 'ANDROID_USAGE_EVENTS',
                        collectorVersion: String(d.collector),
                        catalogVersion: 1
                    },
                    qualityFlags: [],
                    coverage: {
                        interval: {
                            start: d.start ?? d.date + 'T00:00:00.000Z',
                            end: d.end ?? d.date + 'T00:00:00.001Z'
                        },
                        completeness: 'PARTIAL',
                        dayExtent: 'PARTIAL_DAY'
                    }
                };
                const available = valid ? {
                    ...base,
                    sourceStatus: 'AVAILABLE',
                    applications
                } : null;
                return d.state === State.UNAVAILABLE || !valid ? {
                    ...base,
                    sourceStatus: 'UNAVAILABLE',
                    applications: null,
                    lastAvailable: available,
                    reason: 'SOURCE_UNAVAILABLE',
                    attemptedInterval: base.coverage.interval,
                    installationId: d.installation
                } : {
                    ...base,
                    sourceStatus: 'AVAILABLE',
                    applications,
                    lastAvailable: available,
                    installationId: d.installation
                };
            });
            // A janela contribui uma vez; os aplicativos somam tempo registrado,
            // sem afirmar que o uso é exclusivo de uma pessoa.
            const groups = new Map();
            for (const o of observations) {
                const valid = o.sourceStatus === 'AVAILABLE' ? o : o.lastAvailable;
                if (!valid)
                    continue;
                const known = valid.applications.filter(a => a.durationSeconds !== null && !a.suppression);
                if (!known.length)
                    continue;
                const key = `${o.installationId}/${o.associationId}/${o.localDate}`, previous = groups.get(key), interval = valid.coverage.interval;
                groups.set(key, {
                    id: key,
                    accountId: account,
                    source: 'V2',
                    installationId: o.installationId,
                    interval: previous?.interval ? {
                        start: previous.interval.start < interval.start ? previous.interval.start : interval.start,
                        end: previous.interval.end > interval.end ? previous.interval.end : interval.end
                    } : interval,
                    registeredSeconds: (previous?.registeredSeconds ?? 0) + known.reduce((n, a) => n + a.durationSeconds, 0)
                });
            }
            const legacyGroups = new Map();
            let unknownLegacy = false;
            for (const r of legacy) {
                const seconds = segundosDoRegistro(r);
                if (seconds === null) {
                    unknownLegacy = true;
                    continue;
                }
                const interval = r.tempo_uso_inicio && r.tempo_uso_fim ? {
                    start: r.tempo_uso_inicio.toISOString(),
                    end: r.tempo_uso_fim.toISOString()
                } : null;
                const key = interval && r.tempo_uso_package_id ? `${interval.start}/${interval.end}` : `row:${r.tempo_uso_id}`, old = legacyGroups.get(key);
                if (old && r.tempo_uso_package_id && !old.packages.has(r.tempo_uso_package_id)) {
                    old.registeredSeconds += seconds;
                    old.packages.add(r.tempo_uso_package_id);
                }
                else
                    legacyGroups.set(old ? `${key}/duplicate:${r.tempo_uso_id}` : key, {
                        id: String(r.tempo_uso_id),
                        accountId: account,
                        source: 'LEGACY',
                        installationId: null,
                        interval,
                        registeredSeconds: seconds,
                        packages: new Set(r.tempo_uso_package_id ? [r.tempo_uso_package_id] : [])
                    });
            }
            const totals = consolidateSources(account, [...groups.values(), ...legacyGroups.values()]);
            if (unknownLegacy) {
                totals.consolidatedSeconds = null;
                totals.availability = 'AMBIGUOUS';
            }
            const v2RegisteredMs = totals.v2RegisteredSeconds === null ? null : observations.reduce((sum, o) => {
                const valid = o.sourceStatus === 'AVAILABLE' ? o : o.lastAvailable;
                return sum + (valid?.applications ?? []).reduce((n, a) => n + (a.suppression ? 0 : a.durationMs ?? 0), 0);
            }, 0);
            const legacyRegisteredMs = totals.legacyRegisteredSeconds === null ? null : totals.legacyRegisteredSeconds * 1000;
            const totalRegisteredMs = totals.consolidatedSeconds === null ? null : (v2RegisteredMs ?? 0) + (legacyRegisteredMs ?? 0);
            const accessStats = (await tx.consent(account, true)) ? {
                ...(await tx.accessStats(account, month + '-01', end.toISOString().slice(0, 10))),
                coverage: 'PARTIAL'
            } : null;
            const summary = {
                schemaVersion: 2,
                localMonth: month,
                totalRegisteredMs,
                totalRegisteredSeconds: totals.consolidatedSeconds,
                installationCount: new Set(rows.map(d => d.installation)).size,
                semantics: totals.semantics,
                coverage: 'PARTIAL',
                sources: [...(rows.length ? ['V2'] : []), ...(legacy.length ? ['LEGACY'] : [])],
                availability: totals.availability,
                sourceTotals: {
                    legacyRegisteredMs,
                    v2RegisteredMs,
                    legacyRegisteredSeconds: totals.legacyRegisteredSeconds,
                    v2RegisteredSeconds: totals.v2RegisteredSeconds
                },
                references: rows.map(d => ({
                    associationId: `${d.context}/${d.id}`,
                    localDate: d.date,
                    revision: d.version
                })),
                limitations: ['ANDROID_DOES_NOT_IDENTIFY_PERSON', 'SOURCE_COVERAGE_NOT_COMPLETE', ...(unknownLegacy ? ['LEGACY_DURATION_UNAVAILABLE'] : []), ...(totals.availability === 'AMBIGUOUS' ? ['LEGACY_OR_WINDOW_OVERLAP'] : [])]
            };
            const installations = [...new Set(rows.map(d => d.installation))].map(installationId => {
                const valid = observations.filter(o => o.installationId === installationId).flatMap(o => (o.sourceStatus === 'AVAILABLE' ? o.applications : o.lastAvailable?.applications) ?? []).filter(a => a.durationSeconds !== null && !a.suppression);
                return {
                    installationId,
                    registeredSeconds: valid.length ? valid.reduce((n, a) => n + a.durationSeconds, 0) : null,
                    suppressed: rows.some(d => d.installation === installationId && d.state === State.DELETED)
                };
            });
            return {
                schemaVersion: 2,
                summary,
                observations,
                legacy,
                installations,
                accessStats,
                consentActive: await tx.consent(account),
                migrated: rows.length > 0,
                serverTime: this.clock().toISOString()
            };
        });
    }
}
