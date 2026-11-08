import { z } from 'zod';
import { assertInterval, assertLocalDate, assertTimezone, contains, localDayInterval, utcMs } from './time.js';
const valid = (check) => {
    try {
        check();
        return true;
    }
    catch {
        return false;
    }
};
export const utcSchema = z.string().refine(v => valid(() => utcMs(v)), 'Use a real UTC instant ending in Z');
export const timezoneSchema = z.string().refine(v => valid(() => assertTimezone(v)), 'Invalid IANA timezone');
export const localDateSchema = z.string().refine(v => valid(() => assertLocalDate(v)), 'Invalid civil date');
const id = z.string().uuid();
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().positive().max(2147483647);
const seconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const packageId = z.string().min(3).max(255).regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/);
export const installationSchema = z.object({
    id,
    createdAt: utcSchema
}).strict();
export const intervalSchema = z.object({
    start: utcSchema,
    end: utcSchema
}).strict().refine(i => valid(() => assertInterval(i)), 'Empty or inverted interval');
export const authorizationSchema = z.object({
    id,
    accountId: positive,
    installationId: id,
    grantedAt: utcSchema,
    revokedAt: utcSchema.nullable()
}).strict().refine(a => valid(() => {
    if (a.revokedAt && utcMs(a.revokedAt) < utcMs(a.grantedAt))
        throw new Error();
}));
const associationBase = {
    id,
    accountId: positive,
    installationId: id,
    authorizationId: id,
    timezone: timezoneSchema,
    eligibleFrom: utcSchema,
    validatedAt: utcSchema,
    expiresAt: utcSchema.nullable()
};
export const associationSchema = z.discriminatedUnion('state', [z.object({
        ...associationBase,
        state: z.literal('ACTIVE'),
        endedAt: z.null(),
        closeReason: z.null()
    }).strict(), z.object({
        ...associationBase,
        state: z.literal('CLOSED'),
        endedAt: utcSchema,
        closeReason: z.enum(['LOGOUT', 'ACCOUNT_SWITCH', 'CONSENT_REVOKED', 'EXPIRED', 'TIMEZONE_CHANGE'])
    }).strict()]).refine(a => valid(() => {
    const start = utcMs(a.eligibleFrom), validated = utcMs(a.validatedAt);
    if (validated < start || a.expiresAt && utcMs(a.expiresAt) <= validated || a.endedAt && (utcMs(a.endedAt) < start || utcMs(a.endedAt) < validated))
        throw new Error();
}));
export const associationRequestSchema = z.object({
    schemaVersion: z.literal(2),
    operationId: id,
    installationId: id,
    expectedAssociationId: id.nullable(),
    timezone: timezoneSchema,
    action: z.enum(['ACTIVATE', 'RESUME', 'VALIDATE'])
}).strict();
export const associationResponseSchema = z.object({
    schemaVersion: z.literal(2),
    operationId: id,
    serverTime: utcSchema,
    association: associationSchema,
    limits: z.object({
        recoveryPreviousDays: seconds,
        maxSnapshotsPerBatch: positive
    }).strict(),
    revisions: z.array(z.object({
        localDate: localDateSchema,
        revision: positive
    }).strict()).max(3).optional()
}).strict();
export const associationCloseRequestSchema = z.object({
    schemaVersion: z.literal(2),
    operationId: id,
    associationId: id,
    reason: z.literal('LOGOUT')
}).strict();
const provenance = z.object({
    source: z.literal('ANDROID_USAGE_EVENTS'),
    collectorVersion: z.string().trim().min(1).max(64),
    catalogVersion: positive
}).strict();
const snapshotBase = {
    associationId: id,
    localDate: localDateSchema,
    timezone: timezoneSchema,
    revision,
    observedAt: utcSchema,
    provenance
};
export const snapshotSchema = z.discriminatedUnion('sourceStatus', [z.object({
        ...snapshotBase,
        sourceStatus: z.literal('AVAILABLE'),
        coverage: z.object({
            interval: intervalSchema,
            completeness: z.enum(['UNKNOWN', 'PARTIAL']),
            dayExtent: z.enum(['PARTIAL_DAY', 'WHOLE_DAY'])
        }).strict(),
        qualityFlags: z.array(z.enum(['OPEN_INTERVAL_ESTIMATED', 'MISSING_CONTEXT', 'REBOOT_GAP', 'CLOCK_ANOMALY'])).max(4),
        applications: z.array(z.object({
            packageId,
            durationSeconds: seconds
        }).strict()).min(1).max(200)
    }).strict(), z.object({
        ...snapshotBase,
        sourceStatus: z.literal('UNAVAILABLE'),
        attemptedInterval: intervalSchema,
        reason: z.enum(['USAGE_ACCESS_DENIED', 'SOURCE_UNAVAILABLE', 'DEVICE_LOCKED', 'QUERY_FAILED']),
        applications: z.null()
    }).strict()]).superRefine((s, ctx) => {
    if (!valid(() => {
        const interval = s.sourceStatus === 'AVAILABLE' ? s.coverage.interval : s.attemptedInterval;
        const day = localDayInterval(s.localDate, s.timezone);
        if (!contains(day, interval) || utcMs(interval.end) > utcMs(s.observedAt))
            throw new Error();
        if (s.sourceStatus === 'AVAILABLE') {
            if (new Set(s.applications.map(a => a.packageId)).size !== s.applications.length || new Set(s.qualityFlags).size !== s.qualityFlags.length)
                throw new Error();
            const max = Math.floor((utcMs(interval.end) - utcMs(interval.start)) / 1000);
            if (s.applications.some(a => a.durationSeconds > max))
                throw new Error();
            const whole = utcMs(day.start) === utcMs(interval.start) && utcMs(day.end) === utcMs(interval.end);
            if (s.coverage.dayExtent === 'WHOLE_DAY' !== whole)
                throw new Error();
        }
    }))
        ctx.addIssue({
            code: 'custom',
            message: 'Invalid snapshot interval, duration, day extent or duplicate application/flag'
        });
});
export const snapshotRequestSchema = z.object({
    schemaVersion: z.literal(2),
    batchId: id,
    snapshots: z.array(snapshotSchema).min(1).max(200)
}).strict().refine(r => new Set(r.snapshots.map(s => `${s.associationId}/${s.localDate}`)).size === r.snapshots.length, 'Duplicate snapshot key');
export const snapshotResponseSchema = z.object({
    schemaVersion: z.literal(2),
    batchId: id,
    receivedAt: utcSchema,
    results: z.array(z.object({
        associationId: id,
        localDate: localDateSchema,
        revision: positive,
        status: z.enum(['APPLIED', 'DUPLICATE', 'STALE', 'OBSERVATION_RECORDED', 'APPLIED_WITH_SUPPRESSIONS'])
    }).strict()).max(200)
}).strict();
const target = z.discriminatedUnion('kind', [z.object({
        kind: z.literal('ACCOUNT')
    }).strict(), z.object({
        kind: z.literal('INSTALLATION'),
        installationId: id
    }).strict()]);
export const deletionScopeSchema = z.discriminatedUnion('kind', [z.object({
        kind: z.literal('APP_DAY'),
        packageId,
        localDate: localDateSchema,
        timezone: timezoneSchema
    }).strict(), z.object({
        kind: z.literal('PERIOD'),
        interval: intervalSchema,
        packageIds: z.array(packageId).min(1).max(200).refine(p => new Set(p).size === p.length).nullable()
    }).strict()]);
export const deletionRequestSchema = z.object({
    schemaVersion: z.literal(2),
    operationId: id,
    target,
    scope: deletionScopeSchema
}).strict();
export const tombstoneSchema = z.object({
    id,
    accountId: positive,
    createdAt: utcSchema,
    target,
    scope: deletionScopeSchema,
    effectiveInterval: intervalSchema.optional()
}).strict().refine(t => {
    const scope = t.scope;
    return t.effectiveInterval || scope.kind !== 'APP_DAY' || valid(() => localDayInterval(scope.localDate, scope.timezone));
}, 'Nonexistent civil day');
export const deletionResponseSchema = z.object({
    schemaVersion: z.literal(2),
    operationId: id,
    tombstone: tombstoneSchema
}).strict();
export const errorResponseSchema = z.object({
    schemaVersion: z.literal(2),
    error: z.object({
        code: z.string().min(1).max(64),
        correlationId: id,
        message: z.string().max(300)
    }).strict()
}).strict();
export const snapshotProjectionSchema = z.object({
    associationId: id,
    localDate: localDateSchema,
    timezone: timezoneSchema,
    revision: positive,
    observedAt: utcSchema,
    provenance,
    qualityFlags: z.array(z.enum(['OPEN_INTERVAL_ESTIMATED', 'MISSING_CONTEXT', 'REBOOT_GAP', 'CLOCK_ANOMALY'])).max(4),
    observedInterval: intervalSchema.nullable(),
    sourceStatus: z.enum(['AVAILABLE', 'UNAVAILABLE']),
    coverage: z.enum(['UNKNOWN', 'PARTIAL']),
    applications: z.array(z.object({
        packageId,
        durationSeconds: seconds.nullable(),
        suppression: z.object({
            reason: z.literal('DELETED_INTERVAL'),
            tombstoneIds: z.array(id).min(1)
        }).strict().nullable()
    }).strict().refine(a => a.durationSeconds === null === (a.suppression !== null))).max(200)
}).strict().refine(s => s.sourceStatus === 'AVAILABLE' ? s.observedInterval !== null && s.applications.length > 0 && s.coverage === 'PARTIAL' : s.observedInterval === null && s.applications.length === 0 && s.coverage === 'UNKNOWN', 'Unavailable observations have no observed applications/interval');
export const descriptiveSummarySchema = z.object({
    schemaVersion: z.literal(2),
    localMonth: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/),
    totalRegisteredSeconds: seconds.nullable(),
    installationCount: seconds,
    semantics: z.literal('SUM_OF_REGISTERED_APP_TIME_NOT_EXCLUSIVE_PERSON_TIME'),
    coverage: z.enum(['UNKNOWN', 'PARTIAL']),
    sources: z.array(z.enum(['LEGACY', 'V2'])).max(2).refine(s => new Set(s).size === s.length),
    availability: z.enum(['NO_DATA', 'PARTIAL', 'AMBIGUOUS']),
    sourceTotals: z.object({
        legacyRegisteredSeconds: seconds.nullable(),
        v2RegisteredSeconds: seconds.nullable()
    }).strict(),
    references: z.array(z.object({
        associationId: id,
        localDate: localDateSchema,
        revision: positive
    }).strict()),
    limitations: z.array(z.string().max(200))
}).strict().refine(s => s.availability === 'PARTIAL' || s.totalRegisteredSeconds === null, 'No consolidated total for missing/ambiguous data');
