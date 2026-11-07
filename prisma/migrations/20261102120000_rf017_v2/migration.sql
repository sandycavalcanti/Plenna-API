-- PREPARED ONLY. Never applied during implementation/homologation offline.
BEGIN;
CREATE TABLE public.rf017_installation (
  id UUID PRIMARY KEY, "secretHash" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE public.rf017_authorization (
  id UUID PRIMARY KEY, "accountId" INTEGER NOT NULL REFERENCES public.tb_usuario(usuario_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  "installationId" UUID NOT NULL REFERENCES public.rf017_installation(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL, document JSONB NOT NULL
);
CREATE INDEX "rf017_authorization_accountId_installationId_createdAt_idx" ON public.rf017_authorization("accountId","installationId","createdAt");
CREATE TABLE public.rf017_association (
  id UUID PRIMARY KEY, "accountId" INTEGER NOT NULL REFERENCES public.tb_usuario(usuario_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  "installationId" UUID NOT NULL REFERENCES public.rf017_installation(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  "authorizationId" UUID NOT NULL REFERENCES public.rf017_authorization(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  state VARCHAR(8) NOT NULL CHECK (state IN ('ACTIVE','CLOSED')),
  "eligibleFrom" TIMESTAMPTZ(3) NOT NULL, document JSONB NOT NULL
);
CREATE UNIQUE INDEX rf017_one_active_installation ON public.rf017_association("installationId") WHERE state='ACTIVE';
CREATE INDEX "rf017_association_installationId_eligibleFrom_idx" ON public.rf017_association("installationId","eligibleFrom");
CREATE INDEX "rf017_association_accountId_state_idx" ON public.rf017_association("accountId",state);
CREATE TABLE public.rf017_snapshot (
  key VARCHAR(64) PRIMARY KEY, "accountId" INTEGER NOT NULL REFERENCES public.tb_usuario(usuario_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  "associationId" UUID NOT NULL REFERENCES public.rf017_association(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  "localDate" DATE NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  fingerprint VARCHAR(64) NOT NULL, latest JSONB NOT NULL, available JSONB,
  UNIQUE("associationId","localDate")
);
CREATE INDEX "rf017_snapshot_accountId_localDate_idx" ON public.rf017_snapshot("accountId","localDate");
CREATE TABLE public.rf017_application (
  "snapshotKey" VARCHAR(64) NOT NULL REFERENCES public.rf017_snapshot(key) ON DELETE CASCADE ON UPDATE CASCADE,
  "packageId" VARCHAR(255) NOT NULL, "durationSeconds" INTEGER CHECK("durationSeconds">=0),
  "tombstoneIds" UUID[] NOT NULL,
  PRIMARY KEY("snapshotKey","packageId"),
  CHECK (("durationSeconds" IS NULL) = (cardinality("tombstoneIds")>0))
);
CREATE TABLE public.rf017_tombstone (
  id UUID PRIMARY KEY, "accountId" INTEGER NOT NULL REFERENCES public.tb_usuario(usuario_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  start TIMESTAMPTZ(3) NOT NULL, "end" TIMESTAMPTZ(3) NOT NULL, document JSONB NOT NULL,
  CHECK(start<"end")
);
CREATE INDEX "rf017_tombstone_accountId_start_end_idx" ON public.rf017_tombstone("accountId",start,"end");
CREATE TABLE public.rf017_receipt (
  key VARCHAR(100) PRIMARY KEY, "accountId" INTEGER NOT NULL REFERENCES public.tb_usuario(usuario_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  fingerprint VARCHAR(64) NOT NULL, response JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "rf017_receipt_accountId_createdAt_idx" ON public.rf017_receipt("accountId","createdAt");
CREATE INDEX tempo_uso_usuario_dia_v2_idx ON public.tb_tempo_uso(usuario_id,tempo_uso_data_local);
CREATE INDEX tempo_uso_usuario_data_v2_idx ON public.tb_tempo_uso(usuario_id,tempo_uso_data);
COMMIT;
