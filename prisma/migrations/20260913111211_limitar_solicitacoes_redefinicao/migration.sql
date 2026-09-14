CREATE TABLE "public"."tb_limite_requisicao" (
  "limite_chave" VARCHAR(64) PRIMARY KEY,
  "limite_janela_inicio" TIMESTAMPTZ(3) NOT NULL,
  "limite_contagem" INTEGER NOT NULL CHECK ("limite_contagem" >= 0),
  "limite_expira_em" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "limite_periodo_check" CHECK ("limite_expira_em" > "limite_janela_inicio")
);
CREATE INDEX "tb_limite_requisicao_limite_expira_em_idx" ON "public"."tb_limite_requisicao" ("limite_expira_em");
