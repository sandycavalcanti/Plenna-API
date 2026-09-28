CREATE TYPE "public"."oauth_status_enum" AS ENUM ('PENDENTE', 'PROCESSANDO', 'CONCLUIDA', 'CANCELADA', 'FALHOU');
CREATE TABLE "public"."tb_oauth_tentativa" (
  "oauth_tentativa_id" UUID PRIMARY KEY,
  "usuario_id" INTEGER NOT NULL,
  "oauth_provedor" "public"."email_provedor_enum" NOT NULL,
  "oauth_state_hash" VARCHAR(64) NOT NULL,
  "oauth_finalizacao_hash" VARCHAR(64) NOT NULL,
  "oauth_status" "public"."oauth_status_enum" NOT NULL DEFAULT 'PENDENTE',
  "oauth_criada_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "oauth_expira_em" TIMESTAMPTZ(3) NOT NULL,
  "oauth_finalizada_em" TIMESTAMPTZ(3),
  CONSTRAINT "tb_oauth_tentativa_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."tb_usuario" ("usuario_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "oauth_periodo_check" CHECK ("oauth_expira_em" > "oauth_criada_em")
);
CREATE UNIQUE INDEX "tb_oauth_tentativa_oauth_state_hash_key" ON "public"."tb_oauth_tentativa" ("oauth_state_hash");
CREATE INDEX "tb_oauth_tentativa_usuario_id_oauth_provedor_oauth_status_idx" ON "public"."tb_oauth_tentativa" ("usuario_id", "oauth_provedor", "oauth_status");
CREATE INDEX "tb_oauth_tentativa_oauth_expira_em_idx" ON "public"."tb_oauth_tentativa" ("oauth_expira_em");
