import { z } from 'zod';
import { createHash } from 'node:crypto';
import { utcSchema, timezoneSchema, localDateSchema, intervalSchema } from '../tempo-uso-v2/schemas.js';
// O protocolo atual recusa escritas antigas de recibos e associações.
export const VERSION = 3 as const;
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
} as const;
export const State = {
  AVAILABLE: 1,
  UNAVAILABLE: 2,
  PARTIAL: 3,
  DELETED: 4
} as const;
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
export type Observation = z.infer<typeof observationSchema>;
export type Installation = {
  id: string;
  hash: Uint8Array;
  account: number | null;
  context: string;
  session: string | null;
  start: string | null;
  timezone: string | null;
  collection: string | null;
  until: string | null;
};
export type Access = {
  key: string;
  start: string;
  end: string | null;
  quality: number;
};
export type Daily = {
  id: string;
  account: number;
  installation: string;
  context: string;
  date: string;
  timezone: string;
  packageId: string;
  duration: number | null;
  start: string | null;
  end: string | null;
  quality: number;
  version: number;
  state: number;
  accessState: number;
  accessStart: string | null;
  accessEnd: string | null;
  collector: number;
};
export type Exclusion = {
  account: number;
  hash: string;
  installation: string | null;
  start: string;
  end: string;
  packages: string[] | null;
};
export function stableId(value: unknown) {
  const h = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}
export function accessKey(context: string, packageId: string, origin: string) {
  return stableId([context, packageId, new Date(origin).toISOString()]);
}
export function exclusionHash(e: Omit<Exclusion, 'hash'>) {
  return createHash('sha256').update(JSON.stringify([e.account, e.installation, e.start, e.end, e.packages])).digest('hex');
}
export interface Transaction {
  consent(account: number, detailed?: boolean): Promise<boolean>;
  lockInstallation(id: string): Promise<void>;
  installation(id: string): Promise<Installation | null>;
  saveInstallation(value: Installation): Promise<void>;
  daily(account: number, installation: string, context: string, dates: string[]): Promise<Daily[]>;
  saveDaily(value: Daily): Promise<Daily>;
  accesses(ids: string[]): Promise<Map<string, Access[]>>;
  putAccesses(id: string, values: Access[]): Promise<void>;
  removeAccesses(id: string, keys: string[]): Promise<void>;
  exclusions(account: number, start: string, end: string): Promise<Exclusion[]>;
  exclude(value: Exclusion): Promise<void>;
  ownsInstallation(account: number, id: string): Promise<boolean>;
  accessStats(account: number, startDate: string, endDate: string): Promise<{
    identifiedOpenings: number;
    observedIntervals: number;
    identifiedResumptions: number;
    unknownEntries: number;
    openSegments: number;
    knownDurationMs: number;
  }>;
  month(account: number, month: string): Promise<Daily[]>;
  legacy(account: number, month: string): Promise<import('../tempo-uso-v2/repository.js').LegacyRow[]>;
  page(account: number, date: string, after: {
    id: string;
    start: string;
    key: string;
  } | null, limit: number): Promise<(Access & {
    daily: Daily;
  })[]>;
}
export interface Repository {
  write<T>(account: number, work: (tx: Transaction) => Promise<T>): Promise<T>;
  read<T>(account: number, work: (tx: Transaction) => Promise<T>): Promise<T>;
}
