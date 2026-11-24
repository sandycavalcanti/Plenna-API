-- Reconcile columns already declared in Prisma with databases built from migrations.
ALTER TABLE public.tb_integracao
  ADD COLUMN IF NOT EXISTS integracao_google_subject VARCHAR(255),
  ADD COLUMN IF NOT EXISTS integracao_geracao UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS integracao_execucao_id UUID,
  ADD COLUMN IF NOT EXISTS integracao_lease_expira_em TIMESTAMPTZ(3);

ALTER TABLE public.tb_oauth_tentativa
  ADD COLUMN IF NOT EXISTS oauth_pkce_challenge VARCHAR(43);

CREATE TABLE IF NOT EXISTS public.tb_dispositivo (
  dispositivo_id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES public.tb_usuario(usuario_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  dispositivo_push_token VARCHAR(255) NOT NULL UNIQUE,
  dispositivo_plataforma VARCHAR(20) NOT NULL,
  dispositivo_ativo SMALLINT NOT NULL DEFAULT 1,
  dispositivo_ultimo_erro VARCHAR(255),
  dispositivo_ultima_tentativa_em TIMESTAMP(6),
  dispositivo_ultima_utilizacao_em TIMESTAMP(6),
  dispositivo_data_criacao TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispositivo_data_modificacao TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dispositivo_usuario_ativo
  ON public.tb_dispositivo (usuario_id, dispositivo_ativo);
