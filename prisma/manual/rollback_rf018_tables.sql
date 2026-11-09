-- Manual rollback. Run only after stopping the backend built for the new names.
-- This is intentionally outside prisma/migrations and never touches _prisma_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  source_names text[] := ARRAY[
    'tb_compra_contexto_revisao',
    'tb_compra_item_contexto',
    'tb_compra_avaliacao'
  ];
  old_names text[] := ARRAY[
    'tb_rf018_contexto_revisao',
    'tb_rf018_item_contexto',
    'tb_rf018_avaliacao'
  ];
  relation_kind "char";
  i integer;
BEGIN
  IF current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'RF018_ROLLBACK_WRONG_DATABASE: expected neondb, got %', current_database();
  END IF;

  FOR i IN 1..array_length(source_names, 1) LOOP
    SELECT c.relkind
      INTO relation_kind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = source_names[i];

    IF relation_kind IS NULL OR relation_kind NOT IN ('r', 'p') THEN
      RAISE EXCEPTION 'RF018_ROLLBACK_SOURCE_MISSING_OR_NOT_TABLE: public.%', source_names[i];
    END IF;

    IF to_regclass(format('public.%I', old_names[i])) IS NOT NULL THEN
      RAISE EXCEPTION 'RF018_ROLLBACK_TARGET_ALREADY_EXISTS: public.%', old_names[i];
    END IF;

  END LOOP;
END $$;

ALTER TABLE public.tb_compra_avaliacao
  RENAME TO tb_rf018_avaliacao;

ALTER TABLE public.tb_compra_item_contexto
  RENAME TO tb_rf018_item_contexto;

ALTER TABLE public.tb_compra_contexto_revisao
  RENAME TO tb_rf018_contexto_revisao;

COMMIT;
