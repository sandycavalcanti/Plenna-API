-- PREPARED LOCALLY ONLY. Do not run without environment-specific preflight.
-- Preserve the preceding migration/checksum. Automatic transition is permitted
-- only for EMPTY prototype tables. Any existing data requires a reviewed copy plan.
BEGIN;
DO $$
DECLARE relation_name text; has_rows boolean;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['rf017_installation','rf017_authorization','rf017_association','rf017_snapshot','rf017_application','rf017_tombstone','rf017_receipt'] LOOP
    IF to_regclass('public.'||relation_name) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE',relation_name);
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I LIMIT 1)',relation_name) INTO has_rows;
      IF has_rows THEN RAISE EXCEPTION 'RF017_PROTOTYPE_HAS_DATA: explicit migration plan required (%)',relation_name; END IF;
    END IF;
  END LOOP;
END $$;

CREATE TABLE public.tb_monitoramento_instalacao (
  instalacao_id uuid PRIMARY KEY,
  chave_hash bytea NOT NULL CHECK(octet_length(chave_hash)=32),
  usuario_ativo_id integer REFERENCES public.tb_usuario(usuario_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  contexto_id uuid NOT NULL,
  sessao_cliente uuid,
  inicio_contexto timestamptz(3),
  fuso_contexto varchar(64),
  coleta_id uuid,
  coleta_ate timestamptz(3),
  CHECK ((usuario_ativo_id IS NULL AND sessao_cliente IS NULL AND inicio_contexto IS NULL AND fuso_contexto IS NULL AND coleta_id IS NULL AND coleta_ate IS NULL)
    OR (usuario_ativo_id IS NOT NULL AND sessao_cliente IS NOT NULL AND inicio_contexto IS NOT NULL AND fuso_contexto IS NOT NULL AND coleta_id IS NOT NULL AND coleta_ate IS NOT NULL AND coleta_ate>=inicio_contexto))
);
CREATE INDEX monitoramento_instalacao_usuario_idx ON public.tb_monitoramento_instalacao(usuario_ativo_id) WHERE usuario_ativo_id IS NOT NULL;

CREATE TABLE public.tb_monitoramento_tempo_diario (
  diario_id bigserial PRIMARY KEY,
  usuario_id integer NOT NULL REFERENCES public.tb_usuario(usuario_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  instalacao_id uuid NOT NULL REFERENCES public.tb_monitoramento_instalacao(instalacao_id) ON DELETE RESTRICT,
  contexto_id uuid NOT NULL,
  data_local date NOT NULL,
  fuso_horario varchar(64) NOT NULL,
  pacote varchar(255) NOT NULL,
  duracao_ms integer CHECK(duracao_ms>=0 AND duracao_ms<=90000000),
  cobertura_inicio timestamptz(3),
  cobertura_fim timestamptz(3),
  qualidade smallint NOT NULL CHECK(qualidade BETWEEN 0 AND 255),
  versao integer NOT NULL CHECK(versao>0),
  estado_coleta smallint NOT NULL CHECK(estado_coleta BETWEEN 1 AND 4),
  estado_acessos smallint NOT NULL CHECK(estado_acessos BETWEEN 1 AND 4),
  acessos_cobertura_inicio timestamptz(3),
  acessos_cobertura_fim timestamptz(3),
  versao_coletor smallint NOT NULL CHECK(versao_coletor>0),
  CONSTRAINT monitoramento_diario_origem_unique UNIQUE(instalacao_id,contexto_id,data_local,pacote),
  CHECK((cobertura_inicio IS NULL AND cobertura_fim IS NULL AND duracao_ms IS NULL) OR (cobertura_inicio IS NOT NULL AND cobertura_fim IS NOT NULL AND cobertura_inicio<cobertura_fim)),
  CHECK(duracao_ms IS NULL OR duracao_ms<=extract(epoch FROM cobertura_fim-cobertura_inicio)*1000),
  CHECK((acessos_cobertura_inicio IS NULL AND acessos_cobertura_fim IS NULL) OR (acessos_cobertura_inicio IS NOT NULL AND acessos_cobertura_fim IS NOT NULL AND acessos_cobertura_inicio<acessos_cobertura_fim)),
  CHECK(estado_coleta<>4 OR (duracao_ms IS NULL AND estado_acessos=4))
);
CREATE INDEX monitoramento_diario_usuario_periodo_idx ON public.tb_monitoramento_tempo_diario(usuario_id,data_local,pacote,diario_id);

CREATE TABLE public.tb_monitoramento_acesso (
  diario_id bigint NOT NULL REFERENCES public.tb_monitoramento_tempo_diario(diario_id) ON DELETE CASCADE,
  chave_acesso uuid NOT NULL,
  inicio_utc timestamptz(3) NOT NULL,
  fim_utc timestamptz(3),
  qualidade smallint NOT NULL CHECK(qualidade BETWEEN 0 AND 255),
  PRIMARY KEY(diario_id,chave_acesso),
  CHECK(fim_utc IS NULL OR fim_utc>inicio_utc),
  CHECK((fim_utc IS NULL AND (qualidade & 4)=4) OR (fim_utc IS NOT NULL AND (qualidade & 18)>0))
);
CREATE INDEX monitoramento_acesso_ordem_idx ON public.tb_monitoramento_acesso(diario_id,inicio_utc,chave_acesso);

CREATE TABLE public.tb_monitoramento_exclusao (
  usuario_id integer NOT NULL REFERENCES public.tb_usuario(usuario_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  escopo_hash bytea NOT NULL CHECK(octet_length(escopo_hash)=32),
  instalacao_id uuid REFERENCES public.tb_monitoramento_instalacao(instalacao_id) ON DELETE RESTRICT,
  inicio_utc timestamptz(3) NOT NULL,
  fim_utc timestamptz(3) NOT NULL CHECK(fim_utc>inicio_utc),
  pacotes text[],
  PRIMARY KEY(usuario_id,escopo_hash),
  CHECK(pacotes IS NULL OR cardinality(pacotes)>0)
);
CREATE INDEX monitoramento_exclusao_periodo_idx ON public.tb_monitoramento_exclusao(usuario_id,inicio_utc,fim_utc);

-- Register a NEW granular purpose. Existing users are not opted in.
INSERT INTO public.tb_consentimento_tipo(consentimento_tipo_nome,consentimento_tipo_codigo)
VALUES('Acessos em aplicativos de compra','MONITORAMENTO_ACESSOS')
ON CONFLICT(consentimento_tipo_codigo) DO NOTHING;

-- Still empty, under DDL locks. No CASCADE: unexpected dependencies must fail.
DROP TABLE IF EXISTS public.rf017_application;
DROP TABLE IF EXISTS public.rf017_snapshot;
DROP TABLE IF EXISTS public.rf017_receipt;
DROP TABLE IF EXISTS public.rf017_tombstone;
DROP TABLE IF EXISTS public.rf017_association;
DROP TABLE IF EXISTS public.rf017_authorization;
DROP TABLE IF EXISTS public.rf017_installation;
COMMIT;
