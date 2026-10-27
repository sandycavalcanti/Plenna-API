-- Consolidates the contextual event metadata key without changing answers.
-- This migration is intentionally data-preserving and must run before the
-- application version that writes only __contexto_eventos_v1.
UPDATE "public"."tb_rf018_contexto_revisao"
SET "respostas" =
  ("respostas" - '__rf018_eventos_v1') ||
  jsonb_build_object('__contexto_eventos_v1', "respostas" -> '__rf018_eventos_v1')
WHERE "respostas" ? '__rf018_eventos_v1'
  AND NOT ("respostas" ? '__contexto_eventos_v1');
