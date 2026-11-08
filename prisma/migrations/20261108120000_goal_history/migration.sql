-- Historical monthly goal queries use the current goal row and persisted
-- movements. No event or value-history tables are required.

ALTER TABLE public.tb_meta
  ADD COLUMN IF NOT EXISTS meta_data_conclusao TIMESTAMPTZ(6);
