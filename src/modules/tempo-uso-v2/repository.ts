import type { Association, Authorization, Snapshot, SnapshotProjection, Tombstone } from './contracts.js';

export type Observation = Omit<Extract<Snapshot, {sourceStatus:'AVAILABLE'}>, 'applications'> | Omit<Extract<Snapshot, {sourceStatus:'UNAVAILABLE'}>, 'applications'>;
export type StoredSnapshot = {
  key: string; accountId: number; associationId: string; localDate: string;
  revision: number; fingerprint: string; latest: Observation;
  available: Observation | null; applications: SnapshotProjection['applications'];
};
export type Receipt = { key: string; accountId: number; fingerprint: string; response: unknown };
export interface UsageTransaction {
  consent(accountId: number): Promise<boolean>;
  installation(id: string): Promise<{ id: string; secretHash: string } | null>;
  saveInstallation(id: string, secretHash: string): Promise<void>;
  lockInstallation(id: string): Promise<void>;
  current(installationId: string): Promise<Association | null>;
  association(id: string): Promise<Association | null>;
  associations(ids: string[]): Promise<Association[]>;
  authorization(accountId: number, installationId: string): Promise<Authorization | null>;
  saveAuthorization(value: Authorization): Promise<void>;
  saveAssociation(value: Association): Promise<void>;
  receipt(key: string): Promise<Receipt | null>;
  saveReceipt(value: Receipt): Promise<void>;
  snapshot(key: string): Promise<StoredSnapshot | null>;
  saveSnapshot(value: StoredSnapshot): Promise<void>;
  snapshots(accountId: number, month: string): Promise<StoredSnapshot[]>;
  affectedSnapshots(accountId: number, start: string, end: string): Promise<StoredSnapshot[]>;
  tombstones(accountId: number, start: string, end: string): Promise<Tombstone[]>;
  saveTombstone(value: Tombstone): Promise<void>;
  migrated(accountId: number): Promise<boolean>;
  legacy(accountId: number, month: string): Promise<LegacyRow[]>;
}
export type LegacyRow = {
  tempo_uso_id: number; tempo_uso_nome: string; tempo_uso_package_id: string | null;
  tempo_uso_inicio: Date | null; tempo_uso_fim: Date | null; tempo_uso_data_local: Date | null;
  tempo_uso_data: Date | null; tempo_uso_duracao_segundos: number | null; tempo_uso_minutos: unknown;
};
export interface UsageRepository {
  transaction<T>(accountId: number, work: (tx: UsageTransaction) => Promise<T>): Promise<T>;
}
