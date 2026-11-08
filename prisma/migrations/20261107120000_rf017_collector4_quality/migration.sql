-- PREPARED ONLY: widen the bit mask for collector 4; no rows or new tables.
-- Keep prior migration checksums unchanged. Requires explicit authorization to apply.
BEGIN;
ALTER TABLE public.tb_monitoramento_tempo_diario
  DROP CONSTRAINT tb_monitoramento_tempo_diario_qualidade_check,
  ADD CONSTRAINT tb_monitoramento_tempo_diario_qualidade_check CHECK (qualidade BETWEEN 0 AND 16383);
ALTER TABLE public.tb_monitoramento_acesso
  DROP CONSTRAINT tb_monitoramento_acesso_qualidade_check,
  ADD CONSTRAINT tb_monitoramento_acesso_qualidade_check CHECK (qualidade BETWEEN 0 AND 16383);
COMMIT;
