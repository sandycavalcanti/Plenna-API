-- Cria uma identificacao estavel para os tipos de consentimento existentes.
ALTER TABLE "public"."tb_consentimento_tipo"
ADD COLUMN "consentimento_tipo_codigo" VARCHAR(45);

UPDATE "public"."tb_consentimento_tipo"
SET "consentimento_tipo_codigo" = CASE
  WHEN LOWER(TRIM("consentimento_tipo_nome")) = 'termos de uso' THEN 'TERMOS_USO'
  WHEN LOWER(TRIM("consentimento_tipo_nome")) IN ('autorização de e-mail', 'autorizacao de e-mail') THEN 'EMAIL'
  WHEN LOWER(TRIM("consentimento_tipo_nome")) IN ('monitoramento de tempo de uso', 'monitoramento do celular') THEN 'MONITORAMENTO_TEMPO_USO'
  ELSE 'LEGADO_' || "consentimento_tipo_id"::TEXT
END;

CREATE UNIQUE INDEX "tb_consentimento_tipo_consentimento_tipo_codigo_key"
ON "public"."tb_consentimento_tipo"("consentimento_tipo_codigo");

INSERT INTO "public"."tb_consentimento_tipo" ("consentimento_tipo_codigo", "consentimento_tipo_nome", "consentimento_tipo_data_criacao")
VALUES
  ('TERMOS_USO', 'Termos de Uso', CURRENT_TIMESTAMP),
  ('EMAIL', 'Autorização de E-mail', CURRENT_TIMESTAMP),
  ('MONITORAMENTO_TEMPO_USO', 'Monitoramento de Tempo de Uso', CURRENT_TIMESTAMP)
ON CONFLICT ("consentimento_tipo_codigo") DO NOTHING;

ALTER TABLE "public"."tb_consentimento_tipo"
ALTER COLUMN "consentimento_tipo_codigo" SET NOT NULL;

CREATE UNIQUE INDEX "usuario_tipo_unique"
ON "public"."tb_consentimento"("usuario_id", "consentimento_tipo_id");
