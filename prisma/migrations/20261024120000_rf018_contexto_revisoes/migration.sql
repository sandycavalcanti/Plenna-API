-- Additive only. Does not change purchase classification or financial data.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE UNIQUE INDEX "tb_compra_compra_id_usuario_id_key" ON "public"."tb_compra"("compra_id", "usuario_id");
CREATE UNIQUE INDEX "tb_compra_item_compra_item_id_compra_id_key" ON "public"."tb_compra_item"("compra_item_id", "compra_id");

CREATE TABLE "public"."tb_rf018_contexto_revisao" (
  "contexto_id" SERIAL PRIMARY KEY,
  "compra_id" INTEGER NOT NULL,
  "usuario_id" INTEGER NOT NULL,
  "revisao" INTEGER NOT NULL CHECK ("revisao" > 0),
  "versao_schema" INTEGER NOT NULL DEFAULT 1 CHECK ("versao_schema" = 1),
  "operacao_id" UUID NOT NULL,
  "requisicao_hash" VARCHAR(64) NOT NULL,
  "respostas" JSONB NOT NULL CHECK (jsonb_typeof("respostas") = 'object'),
  "criada_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tb_rf018_contexto_revisao_compra_id_usuario_id_fkey"
    FOREIGN KEY ("compra_id", "usuario_id") REFERENCES "public"."tb_compra"("compra_id", "usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "tb_rf018_contexto_revisao_compra_id_revisao_key" ON "public"."tb_rf018_contexto_revisao"("compra_id", "revisao");
CREATE UNIQUE INDEX "tb_rf018_contexto_revisao_compra_id_operacao_id_key" ON "public"."tb_rf018_contexto_revisao"("compra_id", "operacao_id");
CREATE UNIQUE INDEX "tb_rf018_contexto_revisao_contexto_id_compra_id_key" ON "public"."tb_rf018_contexto_revisao"("contexto_id", "compra_id");

CREATE TABLE "public"."tb_rf018_item_contexto" (
  "contexto_id" INTEGER NOT NULL,
  "compra_id" INTEGER NOT NULL,
  "compra_item_id" INTEGER NOT NULL,
  "planejamento" VARCHAR(32) NOT NULL CHECK ("planejamento" IN ('SIM', 'PARCIALMENTE', 'NAO', 'NAO_LEMBRO', 'PREFIRO_NAO_RESPONDER')),
  CONSTRAINT "tb_rf018_item_contexto_pkey" PRIMARY KEY ("contexto_id", "compra_item_id"),
  CONSTRAINT "tb_rf018_item_contexto_contexto_id_compra_id_fkey"
    FOREIGN KEY ("contexto_id", "compra_id") REFERENCES "public"."tb_rf018_contexto_revisao"("contexto_id", "compra_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "tb_rf018_item_contexto_compra_item_id_compra_id_fkey"
    FOREIGN KEY ("compra_item_id", "compra_id") REFERENCES "public"."tb_compra_item"("compra_item_id", "compra_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
COMMIT;
