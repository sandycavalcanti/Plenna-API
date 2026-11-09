-- Manual, data-preserving PostgreSQL rename. Do not run before coordinated API publication.
-- This is intentionally outside prisma/migrations and never touches _prisma_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  source_names text[] := ARRAY[
    'tb_rf018_contexto_revisao',
    'tb_rf018_item_contexto',
    'tb_rf018_avaliacao'
  ];
  target_names text[] := ARRAY[
    'tb_compra_contexto_revisao',
    'tb_compra_item_contexto',
    'tb_compra_avaliacao'
  ];
  expected_counts bigint[] := ARRAY[40, 37, 32];
  actual_count bigint;
  relation_kind "char";
  i integer;
BEGIN
  IF current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'RF018_RENAME_WRONG_DATABASE: expected neondb, got %', current_database();
  END IF;

  FOR i IN 1..array_length(source_names, 1) LOOP
    SELECT c.relkind
      INTO relation_kind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = source_names[i];

    IF relation_kind IS NULL OR relation_kind NOT IN ('r', 'p') THEN
      RAISE EXCEPTION 'RF018_RENAME_SOURCE_MISSING_OR_NOT_TABLE: public.%', source_names[i];
    END IF;

    IF to_regclass(format('public.%I', target_names[i])) IS NOT NULL THEN
      RAISE EXCEPTION 'RF018_RENAME_TARGET_ALREADY_EXISTS: public.%', target_names[i];
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I', source_names[i]) INTO actual_count;
    IF actual_count <> expected_counts[i] THEN
      RAISE EXCEPTION 'RF018_RENAME_UNEXPECTED_COUNT: public.% expected %, got %',
        source_names[i], expected_counts[i], actual_count;
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.tb_rf018_contexto_revisao
  RENAME TO tb_compra_contexto_revisao;

ALTER TABLE public.tb_rf018_item_contexto
  RENAME TO tb_compra_item_contexto;

ALTER TABLE public.tb_rf018_avaliacao
  RENAME TO tb_compra_avaliacao;

COMMIT;
