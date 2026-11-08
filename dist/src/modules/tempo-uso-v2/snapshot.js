import { associationSchema, snapshotRequestSchema, snapshotSchema, tombstoneSchema } from './schemas.js';
import { contains, localDayInterval, utcMs } from './time.js';
/** A ordem de aplicativos e flags não muda a representação usada na idempotência. */
export function canonicalSnapshot(value) {
    const s = snapshotSchema.parse(value);
    s.observedAt = new Date(utcMs(s.observedAt)).toISOString();
    const interval = s.sourceStatus === 'AVAILABLE' ? s.coverage.interval : s.attemptedInterval;
    interval.start = new Date(utcMs(interval.start)).toISOString();
    interval.end = new Date(utcMs(interval.end)).toISOString();
    if (s.sourceStatus === 'AVAILABLE') {
        s.applications.sort((a, b) => a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0);
        s.qualityFlags.sort();
    }
    return JSON.stringify(s);
}
export function decideBatchReplay(previous, incoming) {
    const next = snapshotRequestSchema.parse(incoming);
    if (!previous || previous.batchId !== next.batchId)
        return 'NEW';
    const normalized = (r) => JSON.stringify(snapshotRequestSchema.parse(r).snapshots.map(canonicalSnapshot).sort());
    if (normalized(previous) !== normalized(next))
        throw new Error('BATCH_ID_REUSED');
    return 'DUPLICATE';
}
export function decideRevision(state, incoming) {
    const next = snapshotSchema.parse(incoming);
    if (state) {
        const previous = snapshotSchema.parse(state.latest);
        const available = state.lastAvailable ? snapshotSchema.parse(state.lastAvailable) : null;
        if (available && (available.sourceStatus !== 'AVAILABLE' || available.associationId !== previous.associationId || available.localDate !== previous.localDate || available.timezone !== previous.timezone || available.revision > previous.revision || utcMs(available.observedAt) > utcMs(previous.observedAt)) || previous.sourceStatus === 'AVAILABLE' && (!available || canonicalSnapshot(previous) !== canonicalSnapshot(available))) {
            throw new Error('INVALID_SNAPSHOT_STATE');
        }
        if (previous.associationId !== next.associationId || previous.localDate !== next.localDate || previous.timezone !== next.timezone)
            throw new Error('SNAPSHOT_KEY_MISMATCH');
        if (next.revision < previous.revision)
            return {
                status: 'STALE',
                state
            };
        if (next.revision === previous.revision) {
            if (canonicalSnapshot(previous) !== canonicalSnapshot(next))
                throw new Error('REVISION_CONFLICT');
            return {
                status: 'DUPLICATE',
                state
            };
        }
        if (utcMs(next.observedAt) < utcMs(previous.observedAt))
            throw new Error('OBSERVATION_TIME_REGRESSION');
        if (state.lastAvailable && next.sourceStatus === 'AVAILABLE') {
            if (!contains(next.coverage.interval, state.lastAvailable.coverage.interval))
                throw new Error('COVERAGE_REGRESSION');
            if (next.provenance.catalogVersion === state.lastAvailable.provenance.catalogVersion && [...next.applications.map(a => a.packageId)].sort().join('\0') !== [...state.lastAvailable.applications.map(a => a.packageId)].sort().join('\0'))
                throw new Error('CATALOG_CONTENT_CHANGED');
        }
    }
    return {
        status: next.sourceStatus === 'AVAILABLE' ? 'APPLIED' : 'OBSERVATION_RECORDED',
        state: {
            latest: next,
            lastAvailable: next.sourceStatus === 'AVAILABLE' ? next : state?.lastAvailable ?? null
        }
    };
}
/** Valida após resolver a elegibilidade autenticada; a conta não vem do payload. */
export function assertSnapshotEligible(s, a, eligible, now, catalog) {
    snapshotSchema.parse(s);
    associationSchema.parse(a);
    const interval = s.sourceStatus === 'AVAILABLE' ? s.coverage.interval : s.attemptedInterval;
    if (!eligible || a.state !== 'ACTIVE' || a.expiresAt && utcMs(now) >= utcMs(a.expiresAt) || utcMs(interval.start) < utcMs(a.eligibleFrom) || s.associationId !== a.id || s.timezone !== a.timezone || !contains(eligible, interval) || utcMs(s.observedAt) > utcMs(now))
        throw new Error('SNAPSHOT_NOT_ELIGIBLE');
    if (s.provenance.catalogVersion !== catalog.version)
        throw new Error('CATALOG_VERSION_UNSUPPORTED');
    if (new Set(catalog.packages).size !== catalog.packages.length || !catalog.packages.length)
        throw new Error('INVALID_CATALOG');
    if (s.sourceStatus === 'AVAILABLE' && [...s.applications.map(a => a.packageId)].sort().join('\0') !== [...catalog.packages].sort().join('\0'))
        throw new Error('CATALOG_INCOMPLETE');
}
/** Aplica exclusões na gravação e na leitura, sem subtrair durações estimadas. */
export function projectWithTombstones(s, a, tombstones) {
    snapshotSchema.parse(s);
    associationSchema.parse(a);
    if (s.associationId !== a.id || s.timezone !== a.timezone)
        throw new Error('SNAPSHOT_KEY_MISMATCH');
    tombstones.forEach(t => tombstoneSchema.parse(t));
    const applicable = tombstones.filter(t => t.accountId === a.accountId && (t.target.kind === 'ACCOUNT' || t.target.installationId === a.installationId)).map(t => {
        const interval = t.effectiveInterval ?? (t.scope.kind === 'APP_DAY' ? localDayInterval(t.scope.localDate, t.scope.timezone) : t.scope.interval);
        return {
            id: t.id,
            start: utcMs(interval.start),
            end: utcMs(interval.end),
            packages: t.scope.kind === 'APP_DAY' ? new Set([t.scope.packageId]) : t.scope.packageIds ? new Set(t.scope.packageIds) : null
        };
    });
    const start = s.sourceStatus === 'AVAILABLE' ? utcMs(s.coverage.interval.start) : 0;
    const end = s.sourceStatus === 'AVAILABLE' ? utcMs(s.coverage.interval.end) : 0;
    const applications = s.sourceStatus === 'AVAILABLE' ? s.applications.map(app => {
        const matching = applicable.filter(t => (t.packages === null || t.packages.has(app.packageId)) && t.start < end && start < t.end);
        return {
            packageId: app.packageId,
            durationSeconds: matching.length ? null : app.durationSeconds,
            suppression: matching.length ? {
                reason: 'DELETED_INTERVAL',
                tombstoneIds: [...new Set(matching.map(t => t.id))].sort()
            } : null
        };
    }) : [];
    return {
        associationId: a.id,
        localDate: s.localDate,
        timezone: s.timezone,
        revision: s.revision,
        observedAt: s.observedAt,
        provenance: s.provenance,
        qualityFlags: s.sourceStatus === 'AVAILABLE' ? [...s.qualityFlags] : [],
        observedInterval: s.sourceStatus === 'AVAILABLE' ? s.coverage.interval : null,
        sourceStatus: s.sourceStatus,
        coverage: s.sourceStatus === 'AVAILABLE' ? 'PARTIAL' : 'UNKNOWN',
        applications
    };
}
export function consolidateSources(accountId, rows) {
    if (!Number.isSafeInteger(accountId) || accountId <= 0)
        throw new Error('INVALID_ACCOUNT');
    const selected = rows.filter(r => r.accountId === accountId);
    const ids = new Set();
    for (const r of selected) {
        if (!Number.isSafeInteger(r.registeredSeconds) || r.registeredSeconds < 0)
            throw new Error('INVALID_DURATION');
        if (r.interval)
            contains(r.interval, r.interval);
        if (r.source === 'V2' && (!r.installationId || !r.interval))
            throw new Error('V2_PROVENANCE_REQUIRED');
        const key = `${r.source}/${r.id}`;
        if (ids.has(key))
            throw new Error('DUPLICATE_CONTRIBUTION');
        ids.add(key);
    }
    const legacy = selected.filter(r => r.source === 'LEGACY'), v2 = selected.filter(r => r.source === 'V2');
    const bounds = (r) => ({
        start: r.interval ? utcMs(r.interval.start) : -Infinity,
        end: r.interval ? utcMs(r.interval.end) : Infinity
    });
    const sorted = (group) => group.map(bounds).sort((a, b) => a.start - b.start);
    const crossOverlap = (left, right) => {
        const a = sorted(left), b = sorted(right);
        let i = 0, j = 0;
        while (i < a.length && j < b.length) {
            if (a[i].start < b[j].end && b[j].start < a[i].end)
                return true;
            if (a[i].end <= b[j].end)
                i++;
            else
                j++;
        }
        return false;
    };
    const legacyOverlap = crossOverlap(legacy, v2);
    const sourceOverlap = (group) => {
        const groups = new Map();
        for (const row of group) {
            const key = row.source === 'LEGACY' ? 'LEGACY' : row.installationId;
            const list = groups.get(key) ?? [];
            list.push(row);
            groups.set(key, list);
        }
        for (const rows of groups.values()) {
            const values = sorted(rows);
            let lastEnd = -Infinity;
            for (const value of values) {
                if (value.start < lastEnd)
                    return true;
                lastEnd = Math.max(lastEnd, value.end);
            }
        }
        return false;
    };
    // Cada contribuição representa uma janela; seus aplicativos já foram somados.
    const ambiguous = legacyOverlap || sourceOverlap(legacy) || sourceOverlap(v2);
    const sum = (group) => {
        const total = group.reduce((n, r) => n + r.registeredSeconds, 0);
        if (!Number.isSafeInteger(total))
            throw new Error('TOTAL_OVERFLOW');
        return total;
    };
    return {
        legacyRegisteredSeconds: !legacy.length || sourceOverlap(legacy) ? null : sum(legacy),
        v2RegisteredSeconds: !v2.length || sourceOverlap(v2) ? null : sum(v2),
        consolidatedSeconds: !selected.length || ambiguous ? null : sum(selected),
        availability: !selected.length ? 'NO_DATA' : ambiguous ? 'AMBIGUOUS' : 'PARTIAL',
        installationCount: new Set(v2.map(r => r.installationId)).size,
        semantics: 'SUM_OF_REGISTERED_APP_TIME_NOT_EXCLUSIVE_PERSON_TIME'
    };
}
