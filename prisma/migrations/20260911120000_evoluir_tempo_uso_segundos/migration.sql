-- RF017 Etapa 2A: evolução aditiva de tempo de uso.
-- As colunas legadas permanecem para compatibilidade e não há exclusão de dados.

ALTER TABLE "public"."tb_tempo_uso"
  ALTER COLUMN "tempo_uso_nome" TYPE VARCHAR(100),
  ALTER COLUMN "tempo_uso_minutos" DROP NOT NULL,
  ALTER COLUMN "tempo_uso_data" DROP NOT NULL,
  ADD COLUMN "tempo_uso_package_id" VARCHAR(255),
  ADD COLUMN "tempo_uso_inicio" TIMESTAMPTZ(3),
  ADD COLUMN "tempo_uso_fim" TIMESTAMPTZ(3),
  ADD COLUMN "tempo_uso_duracao_segundos" INTEGER,
  ADD COLUMN "tempo_uso_data_local" DATE,
  ADD COLUMN "tempo_uso_timezone" VARCHAR(64),
  ADD COLUMN "tempo_uso_origem" VARCHAR(30) NOT NULL DEFAULT 'LEGADO',
  ADD COLUMN "tempo_uso_data_modificacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Converte somente minutos legados positivos que cabem em INTEGER.
-- Não são inventados package ID, início, fim, data local ou timezone.
UPDATE "public"."tb_tempo_uso"
SET "tempo_uso_duracao_segundos" = ROUND("tempo_uso_minutos" * 60)::INTEGER
WHERE "tempo_uso_minutos" > 0
  AND "tempo_uso_minutos" * 60 <= 2147483647;

ALTER TABLE "public"."tb_tempo_uso"
  ADD CONSTRAINT "tempo_uso_origem_check"
    CHECK ("tempo_uso_origem" IN ('LEGADO', 'ANDROID_USAGE_STATS')),
  ADD CONSTRAINT "tempo_uso_duracao_segundos_check"
    CHECK ("tempo_uso_duracao_segundos" IS NULL OR "tempo_uso_duracao_segundos" > 0),
  ADD CONSTRAINT "tempo_uso_periodo_check"
    CHECK (
      "tempo_uso_inicio" IS NULL
      OR "tempo_uso_fim" IS NULL
      OR (
        "tempo_uso_fim" > "tempo_uso_inicio"
        AND "tempo_uso_fim" - "tempo_uso_inicio" <= INTERVAL '25 hours'
      )
    ),
  ADD CONSTRAINT "tempo_uso_duracao_periodo_check"
    CHECK (
      "tempo_uso_duracao_segundos" IS NULL
      OR "tempo_uso_inicio" IS NULL
      OR "tempo_uso_fim" IS NULL
      OR "tempo_uso_duracao_segundos" <= EXTRACT(EPOCH FROM ("tempo_uso_fim" - "tempo_uso_inicio"))
    ),
  ADD CONSTRAINT "tempo_uso_android_campos_check"
    CHECK (
      "tempo_uso_origem" <> 'ANDROID_USAGE_STATS'
      OR (
        "tempo_uso_package_id" IS NOT NULL
        AND "tempo_uso_inicio" IS NOT NULL
        AND "tempo_uso_fim" IS NOT NULL
        AND "tempo_uso_duracao_segundos" IS NOT NULL
        AND "tempo_uso_data_local" IS NOT NULL
        AND "tempo_uso_timezone" IS NOT NULL
      )
    );

CREATE UNIQUE INDEX "tempo_uso_usuario_package_periodo_unique"
  ON "public"."tb_tempo_uso" ("usuario_id", "tempo_uso_package_id", "tempo_uso_inicio", "tempo_uso_fim");

CREATE INDEX "tempo_uso_usuario_inicio_idx"
  ON "public"."tb_tempo_uso" ("usuario_id", "tempo_uso_inicio");
