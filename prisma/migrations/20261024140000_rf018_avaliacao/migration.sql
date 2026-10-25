-- Additive; no classification/financial changes. Requires the context migration.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE "public"."tb_rf018_avaliacao" (
  "avaliacao_id" SERIAL PRIMARY KEY,
  "compra_id" INTEGER NOT NULL,
  "usuario_id" INTEGER NOT NULL,
  "contexto_id" INTEGER,
  "contexto_revisao" INTEGER NOT NULL CHECK ("contexto_revisao" >= 0),
  "versao_contrato" INTEGER NOT NULL DEFAULT 1 CHECK ("versao_contrato" = 1),
  "versao_motor" VARCHAR(40) NOT NULL,
  "fontes_hash" VARCHAR(64) NOT NULL,
  "dados_utilizados" JSONB NOT NULL CHECK (jsonb_typeof("dados_utilizados") = 'object'),
  "resultado" JSONB NOT NULL CHECK (jsonb_typeof("resultado") = 'object'),
  "criada_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rf018_avaliacao_contexto_check" CHECK (("contexto_id" IS NULL AND "contexto_revisao" = 0) OR ("contexto_id" IS NOT NULL AND "contexto_revisao" > 0)),
  CONSTRAINT "tb_rf018_avaliacao_compra_id_usuario_id_fkey" FOREIGN KEY ("compra_id", "usuario_id") REFERENCES "public"."tb_compra"("compra_id", "usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "tb_rf018_avaliacao_contexto_id_compra_id_fkey" FOREIGN KEY ("contexto_id", "compra_id") REFERENCES "public"."tb_rf018_contexto_revisao"("contexto_id", "compra_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "tb_rf018_avaliacao_compra_id_versao_motor_fontes_hash_key" ON "public"."tb_rf018_avaliacao"("compra_id", "versao_motor", "fontes_hash");
CREATE INDEX "tb_rf018_avaliacao_compra_id_avaliacao_id_idx" ON "public"."tb_rf018_avaliacao"("compra_id", "avaliacao_id");
COMMIT;
