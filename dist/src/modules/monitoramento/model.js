import { z } from 'zod';
import { createHash } from 'node:crypto';
import { utcSchema, timezoneSchema, localDateSchema, intervalSchema } from '../tempo-uso-v2/schemas.js';
// O protocolo atual recusa escritas antigas de recibos e associações.
export const VERSION = 3;
export const Q = {
    OPENING: 1,
    END: 2,
    OPEN: 4,
    CONTINUATION: 8,
    BOUNDARY: 16,
    GAP: 32,
    PARTIAL: 64,
    CLOCK: 128,
    INDEPENDENT: 256,
    RESUMPTION: 512,
    ENTRY_UNKNOWN: 1024,
    SCREEN_OFF: 2048,
    LOCKED: 4096,
    SOURCE_UNVERIFIED: 8192
};
export const State = {
    AVAILABLE: 1,
    UNAVAILABLE: 2,
    PARTIAL: 3,
    DELETED: 4
};
const uuid = z.string().uuid();
const flags = z.number().int().min(0).max(16383);
export const prepareSchema = z.object({
    schemaVersion: z.literal(3),
    installationId: uuid,
    sessionId: uuid,
    expectedContextId: uuid.nullable(),
    timezone: timezoneSchema,
    activate: z.boolean(),
    activationProof: uuid.optional()
}).strict();
export const accessSchema = z.object({
    origin: utcSchema,
    start: utcSchema,
    end: utcSchema.nullable(),
    quality: flags
}).strict();
export const observationSchema = z.object({
    localDate: localDateSchema,
    packageId: z.string().min(3).max(16383),
    expectedVersion: z.number().int().min(0).max(2147483646),
    interval: intervalSchema,
    status: z.enum(['AVAILABLE', 'UNAVAILABLE']),
    durationMs: z.number().int().min(0).max(90000000).nullable(),
    quality: flags,
    accesses: z.array(accessSchema).max(1000),
    collectorVersion: z.union([z.literal(3), z.literal(4)]),
    corrections: z.array(z.object({
        previousKey: uuid,
        replacement: accessSchema.nullable(),
        reason: z.enum(['EVENT_RECONSTRUCTION', 'DUPLICATE_EVENT'])
    }).strict()).max(100).default([]),
    totalCorrection: z.object({
        previousDurationMs: z.number().int().nonnegative(),
        reason: z.literal('EVENT_RECONSTRUCTION')
    }).strict().optional()
}).strict();
export const ingestSchema = z.object({
    schemaVersion: z.literal(3),
    installationId: uuid,
    sessionId: uuid,
    contextId: uuid,
    collectionId: uuid,
    observations: z.array(observationSchema).min(1).max(90)
}).strict();
export const closeSchema = z.object({
    schemaVersion: z.literal(3),
    installationId: uuid,
    sessionId: uuid,
    contextId: uuid
}).strict();
export function stableId(value) {
    const h = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}
export function accessKey(context, packageId, origin) {
    return stableId([context, packageId, new Date(origin).toISOString()]);
}
export function exclusionHash(e) {
    return createHash('sha256').update(JSON.stringify([e.account, e.installation, e.start, e.end, e.packages])).digest('hex');
}
