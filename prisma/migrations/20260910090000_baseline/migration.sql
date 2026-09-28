-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."compra_classificacao_enum" AS ENUM ('PENDENTE', 'IMPULSIVA', 'NAO IMPULSIVA');

-- CreateEnum
CREATE TYPE "public"."compra_status_enum" AS ENUM ('AGUARDANDO_CONFIRMACAO', 'CONFIRMADA', 'IGNORADA');

-- CreateEnum
CREATE TYPE "public"."email_provedor_enum" AS ENUM ('GMAIL', 'OUTLOOK');

-- CreateEnum
CREATE TYPE "public"."integracao_sincronizacao_status_enum" AS ENUM ('PENDENTE', 'PROCESSANDO', 'FINALIZADA', 'ERRO');

-- CreateTable
CREATE TABLE "public"."tb_ai_anotacao" (
    "ai_anotacao_id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "ai_anotacao_texto" TEXT NOT NULL,
    "ai_anotacao_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_ai_anotacao_pkey" PRIMARY KEY ("ai_anotacao_id")
);

-- CreateTable
CREATE TABLE "public"."tb_categoria" (
    "categoria_id" SERIAL NOT NULL,
    "categoria_nome" VARCHAR(45) NOT NULL,
    "categoria_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_categoria_pkey" PRIMARY KEY ("categoria_id")
);

-- CreateTable
CREATE TABLE "public"."tb_compra" (
    "compra_id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "forma_pagamento_id" INTEGER,
    "compra_valor" DECIMAL(10,2),
    "compra_horario" TIMESTAMP(6) NOT NULL,
    "compra_fonte" VARCHAR(45),
    "compra_pedido_externo_id" VARCHAR(100),
    "compra_email" BOOLEAN NOT NULL DEFAULT true,
    "compra_classificacao" "public"."compra_classificacao_enum" NOT NULL,
    "compra_acima_limite" BOOLEAN,
    "compra_usuario_concorda" BOOLEAN,
    "compra_usuario_anotacao" TEXT,
    "compra_email_mensagem_id" VARCHAR(255),
    "compra_status" "public"."compra_status_enum" NOT NULL DEFAULT 'CONFIRMADA',
    "compra_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_compra_pkey" PRIMARY KEY ("compra_id")
);

-- CreateTable
CREATE TABLE "public"."tb_compra_item" (
    "compra_item_id" SERIAL NOT NULL,
    "compra_id" INTEGER NOT NULL,
    "categoria_id" INTEGER,
    "compra_item_nome" VARCHAR(45) NOT NULL,
    "compra_item_valor" DECIMAL(10,2) NOT NULL,
    "compra_item_quantidade" DECIMAL(12,3),
    "compra_item_unidade_medida" VARCHAR(10),
    "compra_item_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_compra_item_pkey" PRIMARY KEY ("compra_item_id")
);

-- CreateTable
CREATE TABLE "public"."tb_consentimento" (
    "consentimento_id" SERIAL NOT NULL,
    "consentimento_tipo_id" INTEGER NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "consentimento_status" BOOLEAN NOT NULL,
    "consentimento_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_consentimento_pkey" PRIMARY KEY ("consentimento_id")
);

-- CreateTable
CREATE TABLE "public"."tb_consentimento_tipo" (
    "consentimento_tipo_id" SERIAL NOT NULL,
    "consentimento_tipo_nome" VARCHAR(45) NOT NULL,
    "consentimento_tipo_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_consentimento_tipo_pkey" PRIMARY KEY ("consentimento_tipo_id")
);

-- CreateTable
CREATE TABLE "public"."tb_forma_pagamento" (
    "forma_pagamento_id" SERIAL NOT NULL,
    "forma_pagamento_nome" VARCHAR(45) NOT NULL,
    "forma_pagamento_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_forma_pagamento_pkey" PRIMARY KEY ("forma_pagamento_id")
);

-- CreateTable
CREATE TABLE "public"."tb_historico" (
    "historico_id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "historico_nome" VARCHAR(45) NOT NULL,
    "historico_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "historico_data_modificacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_historico_pkey" PRIMARY KEY ("historico_id")
);

-- CreateTable
CREATE TABLE "public"."tb_integracao" (
    "integracao_id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "integracao_email" VARCHAR(45) NOT NULL,
    "integracao_provedor" "public"."email_provedor_enum" NOT NULL,
    "integracao_access_token" VARCHAR(255) NOT NULL,
    "integracao_refresh_token" VARCHAR(255) NOT NULL,
    "integracao_token_expira_em" TIMESTAMP(6) NOT NULL,
    "integracao_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "integracao_ultima_sincronizacao_em" TIMESTAMP(6),
    "integracao_sincronizacao_status" "public"."integracao_sincronizacao_status_enum" NOT NULL DEFAULT 'PENDENTE',
    "integracao_ultimo_erro" VARCHAR(255),

    CONSTRAINT "tb_integracao_pkey" PRIMARY KEY ("integracao_id")
);

-- CreateTable
CREATE TABLE "public"."tb_mensagem" (
    "mensagem_id" SERIAL NOT NULL,
    "historico_id" INTEGER NOT NULL,
    "mensagem_remetente" BOOLEAN NOT NULL,
    "mensagem_texto" TEXT NOT NULL,
    "mensagem_imagem" BYTEA,
    "mensagem_possui_imagem" BOOLEAN NOT NULL DEFAULT false,
    "mensagem_texto_modificado" TEXT NOT NULL,
    "mensagem_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mensagem_data_modificacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_mensagem_pkey" PRIMARY KEY ("mensagem_id")
);

-- CreateTable
CREATE TABLE "public"."tb_meta" (
    "meta_id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "meta_titulo" VARCHAR(45) NOT NULL,
    "meta_descricao" TEXT,
    "meta_valor" DECIMAL(10,2) NOT NULL,
    "meta_data" DATE,
    "meta_completado" BOOLEAN NOT NULL DEFAULT false,
    "meta_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_meta_pkey" PRIMARY KEY ("meta_id")
);

-- CreateTable
CREATE TABLE "public"."tb_metricas" (
    "metricas_id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "metricas_media_gasto" DECIMAL(10,2) NOT NULL,
    "metricas_media_valor_compra" DECIMAL(10,2) NOT NULL,
    "metricas_frequencia_compra" INTEGER NOT NULL,
    "metricas_media_tempo" DECIMAL(10,2) NOT NULL,
    "metricas_acima_limite" BOOLEAN NOT NULL,
    "metricas_periodo_referencia" TIMESTAMP(6) NOT NULL,
    "metricas_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_metricas_pkey" PRIMARY KEY ("metricas_id")
);

-- CreateTable
CREATE TABLE "public"."tb_preferencia" (
    "preferencia_id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "categoria_id" INTEGER NOT NULL,
    "preferencia_meta" DECIMAL(10,2) NOT NULL,
    "preferencia_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_preferencia_pkey" PRIMARY KEY ("preferencia_id")
);

-- CreateTable
CREATE TABLE "public"."tb_propaganda" (
    "propaganda_id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "categoria_id" INTEGER,
    "propaganda_email_mensagem_id" VARCHAR(255) NOT NULL,
    "propaganda_remetente" VARCHAR(255),
    "propaganda_assunto" VARCHAR(255),
    "propaganda_estabelecimento" VARCHAR(100),
    "propaganda_data_recebimento" TIMESTAMP(6) NOT NULL,
    "propaganda_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_propaganda_pkey" PRIMARY KEY ("propaganda_id")
);

-- CreateTable
CREATE TABLE "public"."tb_redefinicao_senha" (
    "redefinicao_senha_id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "redefinicao_senha_codigo_hash" VARCHAR(255) NOT NULL,
    "redefinicao_senha_expira_em" TIMESTAMP(6) NOT NULL,
    "redefinicao_senha_tentativas" INTEGER NOT NULL DEFAULT 0,
    "redefinicao_senha_usado" BOOLEAN NOT NULL DEFAULT false,
    "redefinicao_senha_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_redefinicao_senha_pkey" PRIMARY KEY ("redefinicao_senha_id")
);

-- CreateTable
CREATE TABLE "public"."tb_tempo_uso" (
    "tempo_uso_id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "tempo_uso_nome" VARCHAR(45) NOT NULL,
    "tempo_uso_minutos" DECIMAL(10,2) NOT NULL,
    "tempo_uso_data" TIMESTAMP(6) NOT NULL,
    "tempo_uso_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_tempo_uso_pkey" PRIMARY KEY ("tempo_uso_id")
);

-- CreateTable
CREATE TABLE "public"."tb_usuario" (
    "usuario_id" SERIAL NOT NULL,
    "usuario_email" VARCHAR(64) NOT NULL,
    "usuario_senha" VARCHAR(255) NOT NULL,
    "usuario_nome" VARCHAR(45) NOT NULL,
    "usuario_telefone" VARCHAR(20),
    "usuario_data_nascimento" DATE,
    "usuario_status" BOOLEAN NOT NULL DEFAULT true,
    "usuario_limite_compra" INTEGER,
    "usuario_meta_valor_mensal" DECIMAL(10,2),
    "usuario_meta_valor_compra" DECIMAL(10,2),
    "usuario_meta_tempo" INTEGER,
    "usuario_gatilho_consumo" VARCHAR(45),
    "usuario_tempo_tela" VARCHAR(20),
    "usuario_incomodo_consumo" VARCHAR(45),
    "usuario_data_criacao" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_usuario_pkey" PRIMARY KEY ("usuario_id")
);

-- CreateIndex
CREATE INDEX "idx_compra_usuario_pedido_externo" ON "public"."tb_compra"("usuario_id" ASC, "compra_pedido_externo_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "tb_compra_usuario_id_compra_email_mensagem_id_key" ON "public"."tb_compra"("usuario_id" ASC, "compra_email_mensagem_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "tb_propaganda_usuario_id_propaganda_email_mensagem_id_key" ON "public"."tb_propaganda"("usuario_id" ASC, "propaganda_email_mensagem_id" ASC);

-- CreateIndex
CREATE INDEX "idx_redefinicao_senha_usuario" ON "public"."tb_redefinicao_senha"("usuario_id" ASC, "redefinicao_senha_usado" ASC, "redefinicao_senha_data_criacao" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tb_usuario_usuario_email_key" ON "public"."tb_usuario"("usuario_email" ASC);

-- AddForeignKey
ALTER TABLE "public"."tb_ai_anotacao" ADD CONSTRAINT "tb_ai_anotacao_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."tb_usuario"("usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_compra" ADD CONSTRAINT "tb_compra_forma_pagamento_id_fkey" FOREIGN KEY ("forma_pagamento_id") REFERENCES "public"."tb_forma_pagamento"("forma_pagamento_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_compra" ADD CONSTRAINT "tb_compra_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."tb_usuario"("usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_compra_item" ADD CONSTRAINT "tb_compra_item_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "public"."tb_categoria"("categoria_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_compra_item" ADD CONSTRAINT "tb_compra_item_compra_id_fkey" FOREIGN KEY ("compra_id") REFERENCES "public"."tb_compra"("compra_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_consentimento" ADD CONSTRAINT "tb_consentimento_consentimento_tipo_id_fkey" FOREIGN KEY ("consentimento_tipo_id") REFERENCES "public"."tb_consentimento_tipo"("consentimento_tipo_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_consentimento" ADD CONSTRAINT "tb_consentimento_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."tb_usuario"("usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_historico" ADD CONSTRAINT "tb_historico_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."tb_usuario"("usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_integracao" ADD CONSTRAINT "tb_integracao_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."tb_usuario"("usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_mensagem" ADD CONSTRAINT "tb_mensagem_historico_id_fkey" FOREIGN KEY ("historico_id") REFERENCES "public"."tb_historico"("historico_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_meta" ADD CONSTRAINT "tb_meta_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."tb_usuario"("usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_metricas" ADD CONSTRAINT "tb_metricas_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."tb_usuario"("usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_preferencia" ADD CONSTRAINT "tb_preferencia_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "public"."tb_categoria"("categoria_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_preferencia" ADD CONSTRAINT "tb_preferencia_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."tb_usuario"("usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_propaganda" ADD CONSTRAINT "tb_propaganda_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "public"."tb_categoria"("categoria_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_propaganda" ADD CONSTRAINT "tb_propaganda_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."tb_usuario"("usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_redefinicao_senha" ADD CONSTRAINT "fk_redefinicao_senha_usuario" FOREIGN KEY ("usuario_id") REFERENCES "public"."tb_usuario"("usuario_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."tb_tempo_uso" ADD CONSTRAINT "tb_tempo_uso_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."tb_usuario"("usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION;




