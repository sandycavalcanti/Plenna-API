-- CreateTable
CREATE TABLE "tb_compra_evento" (
    "evento_id" SERIAL NOT NULL,
    "compra_id" INTEGER NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "compra_item_id" INTEGER,
    "revisao" INTEGER NOT NULL,
    "operacao_id" UUID NOT NULL,
    "requisicao_hash" VARCHAR(64) NOT NULL,
    "tipo" VARCHAR(32) NOT NULL,
    "dados" JSONB NOT NULL,
    "efetiva_em" DATE,
    "registrada_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "origem" VARCHAR(32) NOT NULL DEFAULT 'DECLARADO',
    "corrige_evento_id" INTEGER,
    "anulado" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tb_compra_evento_pkey" PRIMARY KEY ("evento_id")
);

-- CreateTable
CREATE TABLE "tb_referencia_financeira" (
    "referencia_id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "categoria_id" INTEGER,
    "tipo" VARCHAR(32) NOT NULL,
    "valor" DECIMAL(12,2),
    "vigente_desde" TIMESTAMPTZ(3) NOT NULL,
    "registrada_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodo" VARCHAR(7),
    "aplicacao" VARCHAR(32) NOT NULL,
    "origem" VARCHAR(32) NOT NULL,
    "operacao_id" UUID NOT NULL,

    CONSTRAINT "tb_referencia_financeira_pkey" PRIMARY KEY ("referencia_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tb_compra_evento_corrige_evento_id_key" ON "tb_compra_evento"("corrige_evento_id");

-- CreateIndex
CREATE INDEX "tb_compra_evento_usuario_id_efetiva_em_idx" ON "tb_compra_evento"("usuario_id", "efetiva_em");

-- CreateIndex
CREATE UNIQUE INDEX "tb_compra_evento_evento_id_compra_id_key" ON "tb_compra_evento"("evento_id", "compra_id");

-- CreateIndex
CREATE UNIQUE INDEX "tb_compra_evento_compra_id_revisao_key" ON "tb_compra_evento"("compra_id", "revisao");

-- CreateIndex
CREATE UNIQUE INDEX "tb_compra_evento_compra_id_operacao_id_key" ON "tb_compra_evento"("compra_id", "operacao_id");

-- CreateIndex
CREATE INDEX "tb_referencia_financeira_usuario_id_tipo_vigente_desde_idx" ON "tb_referencia_financeira"("usuario_id", "tipo", "vigente_desde");

-- CreateIndex
CREATE UNIQUE INDEX "tb_referencia_financeira_usuario_id_operacao_id_key" ON "tb_referencia_financeira"("usuario_id", "operacao_id");

-- AddForeignKey
ALTER TABLE "tb_compra_evento" ADD CONSTRAINT "tb_compra_evento_compra_id_usuario_id_fkey" FOREIGN KEY ("compra_id", "usuario_id") REFERENCES "tb_compra"("compra_id", "usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tb_compra_evento" ADD CONSTRAINT "tb_compra_evento_compra_item_id_compra_id_fkey" FOREIGN KEY ("compra_item_id", "compra_id") REFERENCES "tb_compra_item"("compra_item_id", "compra_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tb_compra_evento" ADD CONSTRAINT "tb_compra_evento_corrige_evento_id_compra_id_fkey" FOREIGN KEY ("corrige_evento_id", "compra_id") REFERENCES "tb_compra_evento"("evento_id", "compra_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tb_referencia_financeira" ADD CONSTRAINT "tb_referencia_financeira_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "tb_usuario"("usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tb_referencia_financeira" ADD CONSTRAINT "tb_referencia_financeira_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "tb_categoria"("categoria_id") ON DELETE NO ACTION ON UPDATE NO ACTION;