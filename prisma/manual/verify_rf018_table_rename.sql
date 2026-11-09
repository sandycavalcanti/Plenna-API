-- Read-only post-rename verification. Expected counts are the pre-rename Neon snapshot.
DO $$
DECLARE
  table_names text[] := ARRAY[
    'tb_compra_contexto_revisao',
    'tb_compra_item_contexto',
    'tb_compra_avaliacao'
  ];
  old_names text[] := ARRAY[
    'tb_rf018_contexto_revisao',
    'tb_rf018_item_contexto',
    'tb_rf018_avaliacao'
  ];
  expected_counts bigint[] := ARRAY[40, 37, 32];
  actual_count bigint;
  relation_kind "char";
  i integer;
BEGIN
  IF current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'RF018_VERIFY_WRONG_DATABASE: expected neondb, got %', current_database();
  END IF;

  FOR i IN 1..array_length(table_names, 1) LOOP
    SELECT c.relkind
      INTO relation_kind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = table_names[i];

    IF relation_kind IS NULL OR relation_kind NOT IN ('r', 'p') THEN
      RAISE EXCEPTION 'RF018_VERIFY_TARGET_MISSING_OR_NOT_TABLE: public.%', table_names[i];
    END IF;

    IF to_regclass(format('public.%I', old_names[i])) IS NOT NULL THEN
      RAISE EXCEPTION 'RF018_VERIFY_OLD_TABLE_STILL_EXISTS: public.%', old_names[i];
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I', table_names[i]) INTO actual_count;
    IF actual_count <> expected_counts[i] THEN
      RAISE EXCEPTION 'RF018_VERIFY_UNEXPECTED_COUNT: public.% expected %, got %',
        table_names[i], expected_counts[i], actual_count;
    END IF;
  END LOOP;

  IF (SELECT count(*)
        FROM pg_constraint con
        JOIN pg_class child ON child.oid = con.conrelid
        JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
        JOIN pg_class parent ON parent.oid = con.confrelid
        JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
       WHERE con.contype = 'f'
         AND child_ns.nspname = 'public'
         AND parent_ns.nspname = 'public'
         AND (child.relname = ANY(table_names) OR parent.relname = ANY(table_names))) <> 5 THEN
    RAISE EXCEPTION 'RF018_VERIFY_FOREIGN_KEYS_CHANGED';
  END IF;

  IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY(table_names)) <> 8 THEN
    RAISE EXCEPTION 'RF018_VERIFY_INDEX_COUNT_CHANGED';
  END IF;

  IF pg_get_serial_sequence('public.tb_compra_contexto_revisao', 'contexto_id') IS NULL
     OR pg_get_serial_sequence('public.tb_compra_avaliacao', 'avaliacao_id') IS NULL THEN
    RAISE EXCEPTION 'RF018_VERIFY_SEQUENCE_DEFAULT_MISSING';
  END IF;
END $$;

SELECT current_database() AS database_name, current_schema() AS current_schema;

SELECT table_name, count(*)::bigint AS row_count
  FROM (
    SELECT 'tb_compra_contexto_revisao' AS table_name, contexto_id FROM public.tb_compra_contexto_revisao
    UNION ALL
    SELECT 'tb_compra_item_contexto', contexto_id FROM public.tb_compra_item_contexto
    UNION ALL
    SELECT 'tb_compra_avaliacao', avaliacao_id FROM public.tb_compra_avaliacao
  ) rows_by_table
 GROUP BY table_name
 ORDER BY table_name;

SELECT schemaname, tablename, indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename IN ('tb_compra_contexto_revisao', 'tb_compra_item_contexto', 'tb_compra_avaliacao')
 ORDER BY tablename, indexname;

SELECT child.relname AS table_name,
       con.conname,
       pg_get_constraintdef(con.oid, true) AS definition
  FROM pg_constraint con
  JOIN pg_class child ON child.oid = con.conrelid
  JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
 WHERE child_ns.nspname = 'public'
   AND child.relname IN ('tb_compra_contexto_revisao', 'tb_compra_item_contexto', 'tb_compra_avaliacao')
 ORDER BY child.relname, con.conname;

SELECT table_name,
       column_name,
       pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name) AS sequence_name,
       column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('tb_compra_contexto_revisao', 'tb_compra_avaliacao')
   AND column_name IN ('contexto_id', 'avaliacao_id')
 ORDER BY table_name, column_name;
