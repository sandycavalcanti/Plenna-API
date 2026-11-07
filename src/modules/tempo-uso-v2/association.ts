import type { Association, Authorization, CloseReason, Interval } from './contracts.js';
import { associationSchema, authorizationSchema } from './schemas.js';
import { assertTimezone, intersect, localDateAt, localDayInterval, utcMs } from './time.js';

/** Trusted inputs supplied by a future authenticated adapter, not by a wire payload. */
export type OnlineContext = {
  online: boolean; sessionValid: boolean; installationValid: boolean; consentActive: boolean;
  accountId: number; installationId: string; sessionId: string; now: string; timezone: string;
};
export type Validation = {
  associationId: string; accountId: number; installationId: string; sessionId: string;
  at: string; timezone: string;
};
export type AssociationPlan =
  { kind: 'BLOCKED'; reason: string } |
  { kind: 'VALIDATED' | 'CREATED'; association: Association; authorization: Authorization;
    closed: Association | null; validation: Validation };

export function closeAssociation(a: Association, at: string, reason: CloseReason): Association {
  associationSchema.parse(a);
  if (a.state === 'CLOSED') return a;
  if (utcMs(at) < utcMs(a.validatedAt)) throw new Error('CLOCK_REGRESSION');
  return associationSchema.parse({ ...a, state: 'CLOSED', endedAt: at, closeReason: reason });
}
export function revokeAuthorization(a: Authorization, at: string): Authorization {
  authorizationSchema.parse(a);
  if (utcMs(at) < utcMs(a.grantedAt)) throw new Error('CLOCK_REGRESSION');
  return authorizationSchema.parse({ ...a, revokedAt: a.revokedAt ?? at });
}

/** Plans only: the caller must apply close/create atomically and check expectedAssociationId. */
export function planAssociation(input: {
  context: OnlineContext; current: Association | null; authorization: Authorization | null;
  explicitActivation: boolean; newAssociationId: string; newAuthorizationId: string;
  /** No default lifetime: null or an approved explicit expiry supplied by the adapter. */
  expiresAt: string | null;
}): AssociationPlan {
  const { context: c, current, explicitActivation } = input;
  utcMs(c.now); assertTimezone(c.timezone);
  const block = (reason: string): AssociationPlan => ({ kind: 'BLOCKED', reason });
  if (!c.online) return block('ONLINE_VALIDATION_REQUIRED');
  if (!c.sessionValid || !c.sessionId) return block('SESSION_REQUIRED');
  if (!c.installationValid) return block('INSTALLATION_REQUIRED');
  if (!c.consentActive) return block('CONSENT_REQUIRED');
  if (current) {
    associationSchema.parse(current);
    if (current.installationId !== c.installationId) return block('INSTALLATION_MISMATCH');
    if (utcMs(current.validatedAt) > utcMs(c.now) || (current.endedAt && utcMs(current.endedAt) > utcMs(c.now))) return block('CLOCK_REGRESSION');
  }
  let authorization = input.authorization;
  if (authorization) {
    authorizationSchema.parse(authorization);
    if (authorization.accountId !== c.accountId || authorization.installationId !== c.installationId) return block('AUTHORIZATION_SCOPE_MISMATCH');
    if (utcMs(authorization.grantedAt) > utcMs(c.now) || (authorization.revokedAt && utcMs(authorization.revokedAt) > utcMs(c.now))) return block('CLOCK_REGRESSION');
  }
  if (!authorization || authorization.revokedAt) {
    if (!explicitActivation) return block(authorization?.revokedAt ? 'EXPLICIT_REAUTHORIZATION_REQUIRED' : 'FIRST_ACTIVATION_REQUIRED');
    if (authorization?.id === input.newAuthorizationId) return block('NEW_AUTHORIZATION_ID_REQUIRED');
    authorization = authorizationSchema.parse({ id: input.newAuthorizationId, accountId: c.accountId,
      installationId: c.installationId, grantedAt: c.now, revokedAt: null });
  }
  const expired = current?.expiresAt != null && utcMs(current.expiresAt) <= utcMs(c.now);
  const reusable = current?.state === 'ACTIVE' && !expired && current.accountId === c.accountId &&
    current.authorizationId === authorization.id && current.timezone === c.timezone;
  let closed: Association | null = null;
  if (current?.state === 'ACTIVE' && !reusable) {
    const reason: CloseReason = expired ? 'EXPIRED' : current.accountId !== c.accountId ? 'ACCOUNT_SWITCH' :
      current.authorizationId !== authorization.id ? 'CONSENT_REVOKED' : 'TIMEZONE_CHANGE';
    closed = closeAssociation(current, expired ? current.expiresAt! : c.now, reason);
  }
  if (!reusable && current?.id === input.newAssociationId) return block('NEW_EPISODE_ID_REQUIRED');
  const association = associationSchema.parse(reusable
    ? { ...current, validatedAt: c.now, expiresAt: input.expiresAt }
    : { id: input.newAssociationId, accountId: c.accountId, installationId: c.installationId,
      authorizationId: authorization.id, timezone: c.timezone, eligibleFrom: c.now, validatedAt: c.now,
      expiresAt: input.expiresAt, state: 'ACTIVE', endedAt: null, closeReason: null });
  return { kind: reusable ? 'VALIDATED' : 'CREATED', association, authorization, closed,
    validation: { associationId: association.id, accountId: c.accountId, installationId: c.installationId,
      sessionId: c.sessionId, at: c.now, timezone: c.timezone } };
}

/** Intersects recovery/day/episode. Never manufactures zeros for an absent interval. */
export function eligibleInterval(input: {
  association: Association; authorization: Authorization; validation: Validation;
  context: OnlineContext; localDate: string; sourceAvailableFrom: string;
  recoveryPreviousDays: number;
}): Interval | null {
  const { association: a, authorization: grant, context: c, validation: v } = input;
  associationSchema.parse(a); authorizationSchema.parse(grant);
  utcMs(c.now); utcMs(v.at); utcMs(input.sourceAvailableFrom); assertTimezone(c.timezone);
  if (!Number.isSafeInteger(input.recoveryPreviousDays) || input.recoveryPreviousDays < 0) throw new Error('INVALID_RECOVERY_LIMIT');
  if (!c.online || !c.sessionValid || !c.installationValid || !c.consentActive || !c.sessionId ||
      a.state !== 'ACTIVE' || grant.revokedAt || a.authorizationId !== grant.id ||
      grant.accountId !== c.accountId || grant.installationId !== c.installationId ||
      a.accountId !== c.accountId || a.installationId !== c.installationId || a.timezone !== c.timezone ||
      v.associationId !== a.id || v.accountId !== c.accountId || v.installationId !== c.installationId ||
      v.sessionId !== c.sessionId || v.timezone !== c.timezone || utcMs(v.at) !== utcMs(a.validatedAt) ||
      utcMs(v.at) > utcMs(c.now) || (a.expiresAt && utcMs(c.now) >= utcMs(a.expiresAt))) return null;
  const day = localDayInterval(input.localDate, a.timezone);
  const today = localDateAt(c.now, a.timezone);
  const age = (Date.parse(today) - Date.parse(input.localDate)) / 86400000;
  if (age < 0 || age > input.recoveryPreviousDays) return null;
  const start = Math.max(utcMs(a.eligibleFrom), utcMs(grant.grantedAt), utcMs(input.sourceAvailableFrom));
  const end = utcMs(c.now);
  if (start >= end) return null;
  return intersect(day, { start: new Date(start).toISOString(), end: c.now });
}

export function assertNoInstallationOverlap(associations: Association[]): void {
  const byInstallation = new Map<string, Association[]>();
  for (const a of associations) {
    associationSchema.parse(a);
    const group = byInstallation.get(a.installationId) ?? [];
    group.push(a); byInstallation.set(a.installationId, group);
  }
  for (const group of byInstallation.values()) {
    group.sort((a, b) => utcMs(a.eligibleFrom) - utcMs(b.eligibleFrom));
    for (let i = 1; i < group.length; i++) {
      const previous = group[i - 1];
      const end = Math.min(previous.endedAt ? utcMs(previous.endedAt) : Infinity,
        previous.expiresAt ? utcMs(previous.expiresAt) : Infinity);
      if (end > utcMs(group[i].eligibleFrom)) throw new Error('INSTALLATION_EPISODES_OVERLAP');
    }
  }
}
