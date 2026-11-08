import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { associationCloseRequestSchema, associationRequestSchema, deletionRequestSchema, snapshotRequestSchema } from './schemas.js';
import { closeAssociation, eligibleInterval, planAssociation } from './association.js';
import { assertSnapshotEligible, canonicalSnapshot, consolidateSources, projectWithTombstones } from './snapshot.js';
import { addLocalDays, contains, localDateAt, localDayInterval, overlaps, utcMs } from './time.js';
import { ASSOCIATION_LIFETIME_MS, RECOVERY_DAYS, UsageMonitoringError } from './policy.js';
import { redactLegacy } from './legacy.js';
import { segundosDoRegistro } from '../tempo-uso/tempo-uso.duracao.js';
export class UsageService {
    constructor(repository, receiptSecret, clock = () => new Date(), uuid = randomUUID) {
        this.repository = repository;
        this.receiptSecret = receiptSecret;
        this.clock = clock;
        this.uuid = uuid;
        if (receiptSecret.length < 16)
            throw new Error('RF017_RECEIPT_SECRET_REQUIRED');
    }
    hash(value) { return createHmac('sha256', this.receiptSecret).update(value).digest('hex'); }
    async identity(tx, id, secret, create = false) {
        if (!/^[a-f0-9]{64}$/.test(secret))
            throw new UsageMonitoringError('INSTALLATION_CREDENTIAL_REQUIRED', 403);
        await tx.lockInstallation(id);
        const row = await tx.installation(id), hash = createHash('sha256').update(secret).digest('hex');
        if (!row) {
            if (!create)
                throw new UsageMonitoringError('INSTALLATION_NOT_FOUND', 403);
            await tx.saveInstallation(id, hash);
        }
        else if (!timingSafeEqual(Buffer.from(row.secretHash, 'hex'), Buffer.from(hash, 'hex')))
            throw new UsageMonitoringError('INSTALLATION_CREDENTIAL_INVALID', 403);
    }
    async receipt(tx, account, key, value, work) {
        const fingerprint = this.hash(value), previous = await tx.receipt(key);
        if (previous) {
            if (previous.accountId !== account || previous.fingerprint !== fingerprint)
                throw new UsageMonitoringError('OPERATION_ID_REUSED');
            return previous.response;
        }
        const response = await work();
        await tx.saveReceipt({ key, accountId: account, fingerprint, response });
        return response;
    }
    associate(account, body, secret) {
        const req = associationRequestSchema.parse(body);
        return this.repository.transaction(account, async (tx) => {
            await this.identity(tx, req.installationId, secret, req.action === 'ACTIVATE');
            if (!await tx.consent(account))
                throw new UsageMonitoringError('CONSENT_REQUIRED', 403);
            const response = await this.receipt(tx, account, `${account}:association:${req.operationId}`, JSON.stringify(req), async () => {
                const current = await tx.current(req.installationId);
                // Never disclose another account's association ID during switching.
                const ownCurrent = current?.accountId === account ? current.id : null;
                if (req.expectedAssociationId !== ownCurrent)
                    throw new UsageMonitoringError('ASSOCIATION_CHANGED');
                const now = this.clock().toISOString();
                const plan = planAssociation({ context: { accountId: account, installationId: req.installationId, timezone: req.timezone, now,
                        online: true, sessionValid: true, installationValid: true, consentActive: true, sessionId: 'authenticated-server' },
                    current, authorization: await tx.authorization(account, req.installationId), explicitActivation: req.action === 'ACTIVATE',
                    newAssociationId: this.uuid(), newAuthorizationId: this.uuid(), expiresAt: new Date(utcMs(now) + ASSOCIATION_LIFETIME_MS).toISOString() });
                if (plan.kind === 'BLOCKED')
                    throw new UsageMonitoringError(plan.reason, 403);
                if (plan.closed)
                    await tx.saveAssociation(plan.closed);
                await tx.saveAuthorization(plan.authorization);
                await tx.saveAssociation(plan.association);
                const today = localDateAt(now, plan.association.timezone), revisions = [];
                for (let i = 0; i <= RECOVERY_DAYS; i++) {
                    const date = addLocalDays(today, -i), s = await tx.snapshot(`${plan.association.id}/${date}`);
                    if (s)
                        revisions.push({ localDate: date, revision: s.revision });
                }
                return { schemaVersion: 2, operationId: req.operationId, serverTime: now, association: plan.association, revisions,
                    limits: { recoveryPreviousDays: RECOVERY_DAYS, maxSnapshotsPerBatch: 200 } };
            });
            const live = await tx.current(req.installationId);
            if (live?.id !== response.association.id || !live.expiresAt || utcMs(live.expiresAt) <= this.clock().getTime())
                throw new UsageMonitoringError('STALE_ASSOCIATION_OPERATION');
            return response;
        });
    }
    close(account, body, secret) {
        const req = associationCloseRequestSchema.parse(body);
        return this.repository.transaction(account, async (tx) => {
            let a = await tx.association(req.associationId);
            if (!a || a.accountId !== account)
                throw new UsageMonitoringError('ASSOCIATION_NOT_FOUND', 404);
            await this.identity(tx, a.installationId, secret);
            a = await tx.association(req.associationId);
            if (!a || a.accountId !== account)
                throw new UsageMonitoringError('ASSOCIATION_NOT_FOUND', 404);
            const current = a;
            return this.receipt(tx, account, `${account}:close:${req.operationId}`, JSON.stringify(req), async () => {
                const closed = closeAssociation(current, this.clock().toISOString(), 'LOGOUT');
                await tx.saveAssociation(closed);
                return { schemaVersion: 2, operationId: req.operationId, association: closed };
            });
        });
    }
    ingest(account, body, secret) {
        const req = snapshotRequestSchema.parse(body);
        return this.repository.transaction(account, async (tx) => {
            if (!await tx.consent(account))
                throw new UsageMonitoringError('CONSENT_REQUIRED', 403);
            let first = await tx.association(req.snapshots[0].associationId);
            if (!first || first.accountId !== account)
                throw new UsageMonitoringError('ASSOCIATION_NOT_FOUND', 404);
            await this.identity(tx, first.installationId, secret);
            first = await tx.association(req.snapshots[0].associationId);
            if (!first || first.accountId !== account || first.state !== 'ACTIVE')
                throw new UsageMonitoringError('ASSOCIATION_NOT_ACTIVE');
            const lockedAssociation = first;
            const grant = await tx.authorization(account, first.installationId);
            if (!grant)
                throw new UsageMonitoringError('AUTHORIZATION_REQUIRED', 403);
            const periods = req.snapshots.map(s => s.sourceStatus === 'AVAILABLE' ? s.coverage.interval : s.attemptedInterval);
            const tombstones = await tx.tombstones(account, new Date(Math.min(...periods.map(p => utcMs(p.start)))).toISOString(), new Date(Math.max(...periods.map(p => utcMs(p.end)))).toISOString());
            const canonical = req.snapshots.map(canonicalSnapshot).sort().join('\n');
            return this.receipt(tx, account, `${account}:batch:${req.batchId}`, canonical, async () => {
                const now = this.clock().toISOString(), results = [];
                const { APLICATIVOS_COMPRA } = await import('../tempo-uso/aplicativos-compra.catalog.js');
                for (const s of req.snapshots) {
                    const a = s.associationId === lockedAssociation.id ? lockedAssociation : await tx.association(s.associationId);
                    if (!a || a.accountId !== account || a.installationId !== lockedAssociation.installationId)
                        throw new UsageMonitoringError('ASSOCIATION_NOT_FOUND', 404);
                    const context = { accountId: account, installationId: a.installationId, timezone: a.timezone, now,
                        online: true, sessionValid: true, installationValid: true, consentActive: true, sessionId: 'authenticated-server' };
                    const eligible = eligibleInterval({ association: a, authorization: grant, context,
                        validation: { associationId: a.id, accountId: account, installationId: a.installationId, timezone: a.timezone, at: a.validatedAt, sessionId: context.sessionId },
                        localDate: s.localDate, sourceAvailableFrom: a.eligibleFrom, recoveryPreviousDays: RECOVERY_DAYS });
                    assertSnapshotEligible(s, a, eligible, now, { version: 1, packages: APLICATIVOS_COMPRA.map(a => a.packageId) });
                    const key = `${a.id}/${s.localDate}`, previous = await tx.snapshot(key), fingerprint = this.hash(canonicalSnapshot(s));
                    let status;
                    if (previous && s.revision < previous.revision)
                        status = 'STALE';
                    else if (previous && s.revision === previous.revision) {
                        if (previous.fingerprint !== fingerprint)
                            throw new UsageMonitoringError('REVISION_CONFLICT');
                        status = 'DUPLICATE';
                    }
                    else {
                        if (previous && utcMs(s.observedAt) < utcMs(previous.latest.observedAt))
                            throw new UsageMonitoringError('OBSERVATION_TIME_REGRESSION');
                        if (s.sourceStatus === 'AVAILABLE' && previous?.available?.sourceStatus === 'AVAILABLE' && !contains(s.coverage.interval, previous.available.coverage.interval))
                            throw new UsageMonitoringError('COVERAGE_REGRESSION');
                        const { applications: ignored, ...metadata } = s;
                        const projected = projectWithTombstones(s, a, tombstones);
                        const stored = { key, accountId: account, associationId: a.id, localDate: s.localDate, revision: s.revision, fingerprint,
                            latest: metadata, available: s.sourceStatus === 'AVAILABLE' ? metadata : previous?.available ?? null,
                            applications: s.sourceStatus === 'AVAILABLE' ? projected.applications : previous?.applications ?? [] };
                        await tx.saveSnapshot(stored);
                        status = s.sourceStatus === 'UNAVAILABLE' ? 'OBSERVATION_RECORDED' : projected.applications.some(a => a.suppression) ? 'APPLIED_WITH_SUPPRESSIONS' : 'APPLIED';
                    }
                    results.push({ associationId: a.id, localDate: s.localDate, revision: s.revision, status });
                }
                return { schemaVersion: 2, batchId: req.batchId, receivedAt: now, results };
            });
        });
    }
    delete(account, body) {
        const req = deletionRequestSchema.parse(body);
        return this.repository.transaction(account, tx => this.receipt(tx, account, `${account}:delete:${req.operationId}`, JSON.stringify(req), async () => {
            if (req.target.kind === 'INSTALLATION' && !await tx.authorization(account, req.target.installationId))
                throw new UsageMonitoringError('INSTALLATION_NOT_FOUND', 404);
            const t = { id: this.uuid(), accountId: account, createdAt: this.clock().toISOString(), target: req.target, scope: req.scope };
            const period = t.scope.kind === 'APP_DAY' ? localDayInterval(t.scope.localDate, t.scope.timezone) : t.scope.interval;
            t.effectiveInterval = period;
            await tx.saveTombstone(t);
            const affected = await tx.affectedSnapshots(account, period.start, period.end);
            if (affected.length > 5000)
                throw new UsageMonitoringError('EXCLUSION_TOO_LARGE', 413);
            const episodes = new Map((await tx.associations([...new Set(affected.map(s => s.associationId))])).map(a => [a.id, a]));
            for (const stored of affected) {
                const a = episodes.get(stored.associationId);
                if (!a || !stored.available)
                    continue;
                if (stored.available.sourceStatus !== 'AVAILABLE')
                    continue;
                const targeted = t.target.kind === 'ACCOUNT' || t.target.installationId === a.installationId;
                const window = stored.available.coverage.interval;
                stored.applications = stored.applications.map(old => targeted && overlaps(period, window) &&
                    (t.scope.kind === 'APP_DAY' ? t.scope.packageId === old.packageId : t.scope.packageIds === null || t.scope.packageIds.includes(old.packageId))
                    ? { ...old, durationSeconds: null, suppression: { reason: 'DELETED_INTERVAL', tombstoneIds: [...new Set([...(old.suppression?.tombstoneIds ?? []), t.id])] } }
                    : old);
                await tx.saveSnapshot(stored);
            }
            return { schemaVersion: 2, operationId: req.operationId, tombstone: t };
        }));
    }
    summary(account, month) {
        if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month))
            throw new UsageMonitoringError('INVALID_MONTH', 400);
        return this.repository.transaction(account, async (tx) => {
            const rows = await tx.snapshots(account, month), rawLegacy = await tx.legacy(account, month);
            const monthStart = localDayInterval(month + '-01', 'UTC').start;
            const nextMonth = new Date(month + '-01T00:00:00Z');
            nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
            const tombstones = await tx.tombstones(account, new Date(Date.parse(monthStart) - 26 * 3600000).toISOString(), new Date(nextMonth.getTime() + 26 * 3600000).toISOString());
            const legacy = redactLegacy(rawLegacy, tombstones);
            if (rows.length > 5000 || legacy.length > 5000)
                throw new UsageMonitoringError('PERIOD_TOO_LARGE', 413);
            const associations = new Map((await tx.associations([...new Set(rows.map(r => r.associationId))])).map(a => [a.id, a]));
            const observations = rows.map(s => ({ ...s.latest, installationId: associations.get(s.associationId)?.installationId, applications: s.latest.sourceStatus === 'AVAILABLE' ? s.applications : null,
                lastAvailable: s.available ? { ...s.available, applications: s.applications } : null }));
            const contributions = [];
            const installations = new Map();
            for (const s of rows) {
                const a = associations.get(s.associationId);
                if (a && !installations.has(a.installationId))
                    installations.set(a.installationId, { installationId: a.installationId, registeredSeconds: null, suppressed: false });
                if (a && s.available?.sourceStatus === 'AVAILABLE') {
                    const known = s.applications.filter(p => p.durationSeconds !== null), seconds = known.reduce((n, p) => n + p.durationSeconds, 0);
                    contributions.push({ id: s.key, accountId: account, source: 'V2', installationId: a.installationId, interval: s.available.coverage.interval, registeredSeconds: seconds });
                    const item = installations.get(a.installationId) ?? { installationId: a.installationId, registeredSeconds: null, suppressed: false };
                    if (known.length)
                        item.registeredSeconds = (item.registeredSeconds ?? 0) + seconds;
                    item.suppressed || (item.suppressed = known.length < s.applications.length);
                    installations.set(a.installationId, item);
                }
            }
            let unknownLegacy = false, knownLegacyCount = 0;
            const legacyGroups = new Map();
            for (const r of legacy) {
                const interval = r.tempo_uso_inicio && r.tempo_uso_fim ? { start: r.tempo_uso_inicio.toISOString(), end: r.tempo_uso_fim.toISOString() } : null;
                const resolved = segundosDoRegistro(r);
                if (resolved === null)
                    unknownLegacy = true;
                else
                    knownLegacyCount++;
                const seconds = resolved ?? 0;
                const key = interval && r.tempo_uso_package_id ? `${interval.start}/${interval.end}` : `row:${r.tempo_uso_id}`;
                const group = legacyGroups.get(key);
                if (group && r.tempo_uso_package_id && !group.packages.has(r.tempo_uso_package_id)) {
                    group.registeredSeconds += seconds;
                    group.packages.add(r.tempo_uso_package_id);
                }
                else
                    legacyGroups.set(group ? `${key}/duplicate:${r.tempo_uso_id}` : key, { id: String(r.tempo_uso_id), accountId: account, source: 'LEGACY', installationId: null, interval, registeredSeconds: seconds, packages: new Set(r.tempo_uso_package_id ? [r.tempo_uso_package_id] : []) });
            }
            contributions.push(...legacyGroups.values());
            const totals = consolidateSources(account, contributions), suppressed = rows.some(r => r.applications.some(a => a.suppression));
            const onlySuppressed = rows.some(r => r.applications.length) && rows.every(r => r.applications.every(a => a.durationSeconds === null));
            if (onlySuppressed) {
                totals.v2RegisteredSeconds = null;
                totals.consolidatedSeconds = null;
            }
            if (unknownLegacy) {
                if (!knownLegacyCount)
                    totals.legacyRegisteredSeconds = null;
                totals.consolidatedSeconds = null;
                totals.availability = 'AMBIGUOUS';
            }
            const summary = { schemaVersion: 2, localMonth: month, totalRegisteredSeconds: totals.consolidatedSeconds,
                installationCount: installations.size, semantics: totals.semantics, coverage: rows.length ? 'PARTIAL' : 'UNKNOWN',
                sources: [...(legacy.length ? ['LEGACY'] : []), ...(rows.length ? ['V2'] : [])], availability: totals.availability,
                sourceTotals: { legacyRegisteredSeconds: totals.legacyRegisteredSeconds, v2RegisteredSeconds: totals.v2RegisteredSeconds },
                references: rows.map(s => ({ associationId: s.associationId, localDate: s.localDate, revision: s.revision })),
                limitations: ['ANDROID_DOES_NOT_IDENTIFY_PERSON', 'SOURCE_COVERAGE_NOT_COMPLETE', ...(suppressed ? ['DELETED_VALUES_SUPPRESSED'] : []), ...(unknownLegacy ? ['LEGACY_DURATION_UNAVAILABLE'] : []), ...(totals.availability === 'AMBIGUOUS' ? ['LEGACY_OR_WINDOW_OVERLAP'] : [])] };
            return { schemaVersion: 2, summary, observations, legacy, installations: [...installations.values()], consentActive: await tx.consent(account), migrated: await tx.migrated(account), serverTime: this.clock().toISOString() };
        });
    }
    state(account, installationId, secret) {
        return this.repository.transaction(account, async (tx) => {
            await this.identity(tx, installationId, secret);
            const a = await tx.current(installationId);
            return { schemaVersion: 2, association: a?.accountId === account ? a : null, authorization: await tx.authorization(account, installationId), consentActive: await tx.consent(account) };
        });
    }
}
