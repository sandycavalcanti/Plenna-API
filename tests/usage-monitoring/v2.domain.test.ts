import assert from 'node:assert/strict';
import test from 'node:test';
import { planAssociation, closeAssociation, revokeAuthorization, eligibleInterval, assertNoInstallationOverlap, type OnlineContext, type AssociationPlan } from '../../src/modules/tempo-uso-v2/association.js';
import { decideRevision, decideBatchReplay, projectWithTombstones, consolidateSources, assertSnapshotEligible } from '../../src/modules/tempo-uso-v2/snapshot.js';
import { associationRequestSchema, associationCloseRequestSchema, installationSchema, snapshotSchema, snapshotProjectionSchema, snapshotRequestSchema, deletionRequestSchema, associationResponseSchema, snapshotResponseSchema, deletionResponseSchema, errorResponseSchema, descriptiveSummarySchema } from '../../src/modules/tempo-uso-v2/schemas.js';
import { localDayInterval, utcMs, overlaps, intersect } from '../../src/modules/tempo-uso-v2/time.js';
import type { Association, Authorization, Snapshot, Tombstone, Interval } from '../../src/modules/tempo-uso-v2/contracts.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-02T17:00:00Z'; // 14h in São Paulo
const END = '2026-11-02T18:00:00Z';
const context = (patch: Partial<OnlineContext> = {}): OnlineContext => ({ online: true, sessionValid: true,
  installationValid: true, consentActive: true, accountId: 7, installationId: id(1), sessionId: 'session-A',
  now: T, timezone: 'America/Sao_Paulo', ...patch });
function accepted(result: AssociationPlan) {
  if (result.kind === 'BLOCKED') throw new Error(result.reason);
  return result;
}
function activate(c = context(), current: Association | null = null, authorization: Authorization | null = null, n = 10, explicitActivation = true) {
  return accepted(planAssociation({ context: c, current, authorization, explicitActivation,
    newAssociationId: id(n), newAuthorizationId: id(n + 1), expiresAt: null }));
}
function window(plan = activate(), c = context({ now: END }), localDate = '2026-11-02', recoveryPreviousDays = 2) {
  return eligibleInterval({ association: plan.association, authorization: plan.authorization, validation: plan.validation,
    context: c, localDate, sourceAvailableFrom: '2026-10-01T00:00:00Z', recoveryPreviousDays });
}
function snapshot(patch: Partial<Extract<Snapshot, { sourceStatus: 'AVAILABLE' }>> = {}): Extract<Snapshot, { sourceStatus: 'AVAILABLE' }> {
  return { associationId: id(10), localDate: '2026-11-02', timezone: 'America/Sao_Paulo', revision: 1,
    observedAt: END, provenance: { source: 'ANDROID_USAGE_EVENTS', collectorVersion: 'events/2', catalogVersion: 1 },
    sourceStatus: 'AVAILABLE', coverage: { interval: { start: T, end: END }, completeness: 'UNKNOWN', dayExtent: 'PARTIAL_DAY' },
    qualityFlags: [], applications: [{ packageId: 'com.shopee.br', durationSeconds: 420 }, { packageId: 'com.zzkko', durationSeconds: 0 }], ...patch };
}
const interval: Interval = { start: T, end: END };
function tombstone(scope: Tombstone['scope'], patch: Partial<Tombstone> = {}): Tombstone {
  return { id: id(100), accountId: 7, createdAt: END, target: { kind: 'ACCOUNT' }, scope, ...patch };
}

test('first activation requires explicit confirmation and clips first authorization at 14h', () => {
  const c = context();
  assert.deepEqual(planAssociation({ context: c, current: null, authorization: null, explicitActivation: false,
    newAssociationId: id(10), newAuthorizationId: id(11), expiresAt: null }), { kind: 'BLOCKED', reason: 'FIRST_ACTIVATION_REQUIRED' });
  const plan = activate();
  assert.deepEqual(window(plan), { start: new Date(T).toISOString(), end: new Date(END).toISOString() });
  assert.equal(window(plan, context({ now: END }), '2026-11-01'), null);
  assert.throws(() => assertSnapshotEligible(snapshot({ coverage: { interval: { start: '2026-11-02T03:00:00Z', end: END }, completeness: 'PARTIAL', dayExtent: 'PARTIAL_DAY' } }), plan.association, window(plan), END, { version: 1, packages: ['com.shopee.br', 'com.zzkko'] }), /NOT_ELIGIBLE/);
});

test('logout stops local eligibility immediately; same account resumes automatically in a new episode', () => {
  const p = activate();
  assert.equal(window(p, context({ now: END, sessionValid: false })), null);
  const closed = closeAssociation(p.association, END, 'LOGOUT');
  const next = activate(context({ now: '2026-11-02T19:00:00Z', sessionId: 'session-return' }), closed, p.authorization, 20, false);
  assert.equal(next.kind, 'CREATED'); assert.notEqual(next.association.id, closed.id);
  assert.equal(next.association.eligibleFrom, '2026-11-02T19:00:00Z');
  assert.equal(window(next, context({ now: '2026-11-02T19:30:00Z', sessionId: 'session-return' }))?.start, '2026-11-02T19:00:00.000Z');
  assert.equal(window(p, context({ now: END, sessionId: 'session-return' })), null);
});

test('A -> B -> A has distinct episodes, account-scoped authorization and no transferred interval', () => {
  const a = activate();
  const b = activate(context({ accountId: 8, now: END, sessionId: 'B' }), a.association, null, 20);
  assert.equal(b.closed?.closeReason, 'ACCOUNT_SWITCH');
  const back = activate(context({ now: '2026-11-02T19:00:00Z', sessionId: 'A-return' }), b.association, a.authorization, 30, false);
  assert.equal(back.association.eligibleFrom, '2026-11-02T19:00:00Z');
  assertNoInstallationOverlap([a.closed ?? b.closed!, back.closed!, back.association]);
  assert.equal(window(a, context({ accountId: 8, now: END })), null);
});

test('revocation blocks automatic resume; new explicit activation requires a new authorization', () => {
  const p = activate(); const revoked = revokeAuthorization(p.authorization, END);
  const closed = closeAssociation(p.association, END, 'CONSENT_REVOKED');
  const args = { context: context({ now: '2026-11-02T19:00:00Z' }), current: closed,
    authorization: revoked, explicitActivation: false, newAssociationId: id(20), newAuthorizationId: id(21), expiresAt: null };
  assert.deepEqual(planAssociation(args), { kind: 'BLOCKED', reason: 'EXPLICIT_REAUTHORIZATION_REQUIRED' });
  assert.equal(planAssociation({ ...args, explicitActivation: true, context: context({ consentActive: false }) }).kind, 'BLOCKED');
  const next = accepted(planAssociation({ ...args, explicitActivation: true }));
  assert.equal(next.authorization.grantedAt, args.context.now);
  assert.equal(eligibleInterval({ association: p.association, authorization: revoked, validation: p.validation, context: context({ now: END }), localDate: '2026-11-02', sourceAvailableFrom: T, recoveryPreviousDays: 2 }), null);
});

test('offline never starts collection; online recovery is limited by association and Android availability', () => {
  const p = activate();
  assert.equal(window(p, context({ now: END, online: false })), null);
  assert.equal(planAssociation({ context: context({ online: false }), current: null, authorization: null,
    explicitActivation: true, newAssociationId: id(2), newAuthorizationId: id(3), expiresAt: null }).kind, 'BLOCKED');
  const renewed = activate(context({ now: '2026-11-04T18:00:00Z' }), p.association, p.authorization, 20, false);
  assert.ok(window(renewed, context({ now: '2026-11-04T18:00:00Z' }), '2026-11-02'));
  assert.equal(window(renewed, context({ now: '2026-11-05T18:00:00Z' }), '2026-11-02'), null);
  assert.equal(eligibleInterval({ association: renewed.association, authorization: renewed.authorization, validation: renewed.validation,
    context: context({ now: '2026-11-04T18:00:00Z' }), localDate: '2026-11-02', sourceAvailableFrom: '2026-11-03T03:00:00Z', recoveryPreviousDays: 2 }), null);
});

test('online timezone change closes/creates adjacent episodes; offline timezone mismatch cannot collect', () => {
  const p = activate(); const c = context({ now: END, timezone: 'America/New_York' });
  assert.equal(window(p, { ...c, online: false }), null); assert.equal(window(p, c), null);
  const next = activate(c, p.association, p.authorization, 20, false);
  assert.equal(next.closed?.closeReason, 'TIMEZONE_CHANGE');
  assert.equal(next.closed?.endedAt, next.association.eligibleFrom);
  assert.equal(p.association.timezone, 'America/Sao_Paulo');
  assertNoInstallationOverlap([next.closed!, next.association]);
});

test('expiry is explicit, expires exactly at end, and new episode cannot recover expired gap', () => {
  const p = accepted(planAssociation({ context: context(), current: null, authorization: null, explicitActivation: true,
    newAssociationId: id(10), newAuthorizationId: id(11), expiresAt: END }));
  assert.equal(window(p), null);
  const next = activate(context({ now: '2026-11-02T19:00:00Z' }), p.association, p.authorization, 20, false);
  assert.equal(next.closed?.endedAt, END); assert.equal(next.closed?.closeReason, 'EXPIRED');
  assert.equal(next.association.eligibleFrom, '2026-11-02T19:00:00Z');
});

test('reinstallation cannot reuse account authorization from another installation', () => {
  const p = activate();
  assert.equal(planAssociation({ context: context({ installationId: id(2) }), current: null, authorization: p.authorization,
    explicitActivation: false, newAssociationId: id(20), newAuthorizationId: id(21), expiresAt: null }).kind, 'BLOCKED');
  const fresh = activate(context({ installationId: id(2) }), null, null, 20);
  assert.notEqual(fresh.authorization.id, p.authorization.id);
});

test('UTC, midnight and 23/25-hour civil days use half-open bounds', () => {
  for (const [date, hours] of [['2026-03-08', 23], ['2026-11-01', 25]] as const) {
    const d = localDayInterval(date, 'America/New_York');
    assert.equal((utcMs(d.end) - utcMs(d.start)) / 3600000, hours);
    const s = snapshot({ localDate: date, timezone: 'America/New_York', observedAt: d.end,
      coverage: { interval: d, completeness: 'UNKNOWN', dayExtent: 'WHOLE_DAY' } });
    assert.equal(snapshotSchema.safeParse(s).success, true);
  }
  const day = localDayInterval('2026-11-02', 'America/Sao_Paulo');
  assert.equal(day.start, '2026-11-02T03:00:00.000Z');
  assert.equal(overlaps(day, localDayInterval('2026-11-03', 'America/Sao_Paulo')), false);
  assert.equal(intersect(day, localDayInterval('2026-11-03', 'America/Sao_Paulo')), null);
  assert.throws(() => utcMs('2026-02-30T12:00:00Z'));
  assert.throws(() => utcMs('2026-11-02T14:00:00-03:00'));
});

test('ordered revisions replace downward and zero, stale and duplicate do not overwrite', () => {
  let state = decideRevision(null, snapshot()).state;
  const lower = snapshot({ revision: 2, applications: [{ packageId: 'com.shopee.br', durationSeconds: 300 }, { packageId: 'com.zzkko', durationSeconds: 0 }] });
  state = decideRevision(state, lower).state;
  assert.equal(state.lastAvailable!.applications[0].durationSeconds, 300);
  assert.equal(decideRevision(state, snapshot()).status, 'STALE');
  assert.equal(decideRevision(state, { ...lower, applications: [...lower.applications].reverse() }).status, 'DUPLICATE');
  assert.equal(decideRevision(state, { ...lower, observedAt: END.replace('Z', '.000Z'), coverage: {
    ...lower.coverage, interval: { start: T.replace('Z', '.000Z'), end: END.replace('Z', '.000Z') },
  } }).status, 'DUPLICATE');
  assert.throws(() => decideRevision(state, { ...lower, applications: [{ packageId: 'com.shopee.br', durationSeconds: 299 }, { packageId: 'com.zzkko', durationSeconds: 0 }] }), /REVISION_CONFLICT/);
  state = decideRevision(state, { ...lower, revision: 3, applications: lower.applications.map(a => ({ ...a, durationSeconds: 0 })) }).state;
  assert.ok(state.lastAvailable!.applications.every(a => a.durationSeconds === 0));
});

test('unavailable after valid observation preserves last data, not a fabricated zero', () => {
  const first = decideRevision(null, snapshot());
  const unavailable: Snapshot = { associationId: id(10), localDate: '2026-11-02', timezone: 'America/Sao_Paulo', revision: 2,
    observedAt: END, provenance: snapshot().provenance, sourceStatus: 'UNAVAILABLE', attemptedInterval: interval,
    reason: 'QUERY_FAILED', applications: null };
  const next = decideRevision(first.state, unavailable);
  assert.equal(next.status, 'OBSERVATION_RECORDED');
  assert.equal(next.state.lastAvailable!.applications[0].durationSeconds, 420);
  assert.equal(decideRevision(next.state, snapshot()).status, 'STALE');
  assert.equal(decideRevision(null, unavailable).state.lastAvailable, null);
});

test('shrinking coverage cannot erase recorded time; future and incomplete catalog are rejected', () => {
  const s = snapshot(); const p = activate(); const state = decideRevision(null, s).state;
  assert.throws(() => decideRevision(state, { ...s, revision: 2, coverage: { ...s.coverage, interval: { start: '2026-11-02T17:30:00Z', end: END } } }), /COVERAGE_REGRESSION/);
  assert.throws(() => assertSnapshotEligible(s, p.association, window(p), T, { version: 1, packages: ['com.shopee.br', 'com.zzkko'] }), /NOT_ELIGIBLE/);
  assert.throws(() => assertSnapshotEligible(s, p.association, window(p), END, { version: 1, packages: ['com.shopee.br'] }), /CATALOG_INCOMPLETE/);
});

test('batch replay is order-independent but reused IDs with different contents conflict', () => {
  const request = { schemaVersion: 2 as const, batchId: id(90), snapshots: [snapshot()] };
  assert.equal(decideBatchReplay(null, request), 'NEW');
  assert.equal(decideBatchReplay(request, { ...request, snapshots: [{ ...snapshot(), applications: [...snapshot().applications].reverse() }] }), 'DUPLICATE');
  assert.throws(() => decideBatchReplay(request, { ...request, snapshots: [snapshot({ revision: 2 })] }), /BATCH_ID_REUSED/);
});

test('app/day deletion suppresses only selected app, and every later revision remains suppressed', () => {
  const p = activate(); const t = tombstone({ kind: 'APP_DAY', packageId: 'com.shopee.br', localDate: '2026-11-02', timezone: 'America/Sao_Paulo' });
  for (const revision of [1, 2, 8]) {
    const result = projectWithTombstones(snapshot({ revision }), p.association, [t]);
    assert.equal(result.applications[0].durationSeconds, null);
    assert.equal(result.applications[0].suppression?.reason, 'DELETED_INTERVAL');
    assert.equal(result.applications[1].durationSeconds, 0); assert.equal(result.coverage, 'PARTIAL');
    assert.equal(snapshotProjectionSchema.safeParse(result).success, true);
  }
});

test('partial period suppresses aggregate without subtracting; other packages and adjacent periods survive', () => {
  const p = activate(); const t = tombstone({ kind: 'PERIOD', interval: { start: '2026-11-02T17:10:00Z', end: '2026-11-02T17:11:00Z' }, packageIds: ['com.shopee.br'] });
  const result = projectWithTombstones(snapshot(), p.association, [t]);
  assert.equal(result.applications[0].durationSeconds, null); assert.equal(result.applications[1].durationSeconds, 0);
  assert.deepEqual(result.applications[0].suppression?.tombstoneIds, [t.id]);
  const adjacent = tombstone({ kind: 'PERIOD', interval: { start: END, end: '2026-11-02T19:00:00Z' }, packageIds: null });
  assert.equal(projectWithTombstones(snapshot(), p.association, [adjacent]).applications[0].durationSeconds, 420);
});

test('tombstone account/installation scopes and timezone prevent cross-account deletion and timezone bypass', () => {
  const p = activate(); const scope: Tombstone['scope'] = { kind: 'APP_DAY', packageId: 'com.shopee.br', localDate: '2026-11-02', timezone: 'UTC' };
  assert.equal(projectWithTombstones(snapshot(), p.association, [tombstone(scope, { accountId: 8 })]).applications[0].durationSeconds, 420);
  assert.equal(projectWithTombstones(snapshot(), p.association, [tombstone(scope, { target: { kind: 'INSTALLATION', installationId: id(2) } })]).applications[0].durationSeconds, 420);
  assert.equal(projectWithTombstones(snapshot(), p.association, [tombstone(scope)]).applications[0].durationSeconds, null);
});

test('multiple installations sum descriptive registered time; same installation overlap is rejected', () => {
  const p = activate(), q = activate(context({ installationId: id(2) }), null, null, 20);
  assertNoInstallationOverlap([p.association, q.association]);
  assert.throws(() => assertNoInstallationOverlap([p.association, { ...p.association, id: id(30) }]), /OVERLAP/);
  const total = consolidateSources(7, [
    { id: 'one', accountId: 7, source: 'V2', installationId: id(1), interval, registeredSeconds: 420 },
    { id: 'two', accountId: 7, source: 'V2', installationId: id(2), interval, registeredSeconds: 120 },
  ]);
  assert.equal(total.consolidatedSeconds, 540); assert.equal(total.installationCount, 2);
  assert.match(total.semantics, /NOT_EXCLUSIVE_PERSON_TIME/);
});

test('legacy/v2 overlap stays separate without cutoff, ambiguous interval never yields consolidated total', () => {
  const legacy = { id: 'old', accountId: 7, source: 'LEGACY' as const, installationId: null, interval, registeredSeconds: 300 };
  const v2 = { id: 'new', accountId: 7, source: 'V2' as const, installationId: id(1), interval, registeredSeconds: 420 };
  const result = consolidateSources(7, [legacy, v2]);
  assert.equal(result.legacyRegisteredSeconds, 300); assert.equal(result.v2RegisteredSeconds, 420);
  assert.equal(result.consolidatedSeconds, null); assert.equal(result.availability, 'AMBIGUOUS');
  assert.equal(consolidateSources(7, [{ ...legacy, interval: null }, v2]).consolidatedSeconds, null);
  assert.equal(consolidateSources(7, [legacy, { ...v2, interval: { start: END, end: '2026-11-02T19:00:00Z' } }]).consolidatedSeconds, 720);
  assert.equal(consolidateSources(8, [legacy, v2]).availability, 'NO_DATA');
});

test('wire contracts are strict, versioned, reject identity injection and validate responses', () => {
  const request = { schemaVersion: 2, operationId: id(90), installationId: id(1), expectedAssociationId: null, timezone: 'America/Sao_Paulo', action: 'ACTIVATE' };
  assert.equal(associationRequestSchema.safeParse(request).success, true);
  assert.equal(installationSchema.safeParse({ id: id(1), createdAt: T }).success, true);
  assert.equal(associationCloseRequestSchema.safeParse({ schemaVersion: 2, operationId: id(90), associationId: id(10), reason: 'LOGOUT' }).success, true);
  for (const extra of [{ accountId: 8 }, { schemaVersion: 1 }, { timezone: 'Mars/Nowhere' }]) assert.equal(associationRequestSchema.safeParse({ ...request, ...extra }).success, false);
  assert.equal(snapshotRequestSchema.safeParse({ schemaVersion: 2, batchId: id(90), snapshots: [snapshot(), snapshot()] }).success, false);
  assert.equal(deletionRequestSchema.safeParse({ schemaVersion: 2, operationId: id(90), target: { kind: 'ACCOUNT' }, scope: { kind: 'PERIOD', interval, packageIds: [] } }).success, false);
  assert.equal(associationResponseSchema.safeParse({ schemaVersion: 2, operationId: id(90), serverTime: T, association: activate().association, limits: { recoveryPreviousDays: 2, maxSnapshotsPerBatch: 200 } }).success, true);
  assert.equal(snapshotResponseSchema.safeParse({ schemaVersion: 2, batchId: id(90), receivedAt: END, results: [{ associationId: id(10), localDate: '2026-11-02', revision: 1, status: 'APPLIED' }] }).success, true);
  assert.equal(deletionResponseSchema.safeParse({ schemaVersion: 2, operationId: id(90), tombstone: tombstone({ kind: 'PERIOD', interval, packageIds: null }) }).success, true);
  assert.equal(errorResponseSchema.safeParse({ schemaVersion: 2, error: { code: 'CONSENT_REQUIRED', correlationId: id(90), message: 'Consent required' } }).success, true);
  assert.equal(descriptiveSummarySchema.safeParse({ schemaVersion: 2, localMonth: '2026-11', totalRegisteredSeconds: null, installationCount: 1, semantics: 'SUM_OF_REGISTERED_APP_TIME_NOT_EXCLUSIVE_PERSON_TIME', coverage: 'PARTIAL', sources: ['LEGACY', 'V2'], availability: 'AMBIGUOUS', sourceTotals: { legacyRegisteredSeconds: 300, v2RegisteredSeconds: 420 }, references: [], limitations: ['LEGACY_OVERLAP'] }).success, true);
});

test('midnight has no current-day eligible duration; preceding day remains recoverable', () => {
  const p = activate();
  const midnight = context({ now: '2026-11-03T03:00:00Z' });
  assert.equal(window(p, midnight, '2026-11-03'), null);
  assert.equal(window(p, midnight, '2026-11-02')?.end, midnight.now.replace('Z', '.000Z'));
});

test('civil-day boundaries handle midnight DST and skip nonexistent dates without reinterpreting history', () => {
  const shortened = localDayInterval('2018-11-04', 'America/Sao_Paulo');
  assert.equal((utcMs(shortened.end) - utcMs(shortened.start)) / 3600000, 23);
  assert.throws(() => localDayInterval('2011-12-30', 'Pacific/Apia'), /NONEXISTENT/);
  const preceding = localDayInterval('2011-12-29', 'Pacific/Apia');
  const following = localDayInterval('2011-12-31', 'Pacific/Apia');
  assert.equal(preceding.end, following.start);
});

test('zero observed, missing data and deletion-suppressed values are distinct wire states', () => {
  const s = snapshot();
  for (const invalid of [
    { ...s, applications: [] },
    { ...s, applications: [{ packageId: 'com.shopee.br', durationSeconds: -1 }] },
    { ...s, applications: [{ packageId: 'com.shopee.br', durationSeconds: 3601 }] },
    { ...s, applications: [{ packageId: 'com.shopee.br', durationSeconds: 0.5 }] },
    { ...s, applications: [...s.applications, s.applications[0]] },
    { ...s, sourceStatus: 'UNAVAILABLE' },
    { ...s, coverage: { ...s.coverage, completeness: 'COMPLETE' } },
    { ...s, coverage: { ...s.coverage, dayExtent: 'WHOLE_DAY' } },
    { ...s, observedAt: T },
    { ...s, accountId: 8 },
  ]) assert.equal(snapshotSchema.safeParse(invalid).success, false);
  const projected = projectWithTombstones(s, activate().association, []);
  assert.equal(snapshotProjectionSchema.safeParse({ ...projected, sourceStatus: 'UNAVAILABLE' }).success, false);
  assert.equal(snapshotProjectionSchema.safeParse({ ...projected, applications: [{ packageId: 'com.shopee.br', durationSeconds: null, suppression: null }] }).success, false);
  assert.equal(consolidateSources(7, []).consolidatedSeconds, null);
  assert.equal(consolidateSources(7, []).v2RegisteredSeconds, null);
});

test('account tombstones survive replacement episodes, while installation target preserves other installations', () => {
  const a = activate();
  const second = activate(context({ installationId: id(2), now: END }), null, null, 20);
  const t = tombstone({ kind: 'APP_DAY', packageId: 'com.shopee.br', localDate: '2026-11-02', timezone: 'America/Sao_Paulo' });
  const s = snapshot({ associationId: second.association.id,
    coverage: { interval: { start: END, end: '2026-11-02T19:00:00Z' }, completeness: 'UNKNOWN', dayExtent: 'PARTIAL_DAY' },
    observedAt: '2026-11-02T19:00:00Z' });
  assert.equal(projectWithTombstones(s, second.association, [t]).applications[0].durationSeconds, null);
  assert.equal(projectWithTombstones(s, second.association, [{ ...t, target: { kind: 'INSTALLATION', installationId: a.association.installationId } }]).applications[0].durationSeconds, 420);
});

test('tombstones and canonical revision comparisons do not mutate valid input data', () => {
  const s = snapshot(); const original = JSON.stringify(s);
  const t = tombstone({ kind: 'PERIOD', interval, packageIds: null });
  const result = projectWithTombstones(s, activate().association, [t]);
  assert.ok(result.applications.every(a => a.durationSeconds === null));
  decideRevision(decideRevision(null, s).state, { ...s, applications: [...s.applications].reverse() });
  assert.equal(JSON.stringify(s), original);
  assert.throws(() => decideRevision({ latest: s, lastAvailable: null }, { ...s, revision: 2 }), /INVALID_SNAPSHOT_STATE/);
});
test('persisted deletion UTC bounds are authoritative, without reinterpreting the original civil-day label',()=>{
  const t=tombstone({kind:'APP_DAY',packageId:'com.shopee.br',localDate:'2026-11-01',timezone:'UTC'},
    {effectiveInterval:{start:T,end:END}});
  const result=projectWithTombstones(snapshot(),activate().association,[t]);
  assert.equal(result.applications[0].durationSeconds,null);
});
