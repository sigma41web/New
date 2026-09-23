-- 0021_korean_retrieval.sql — Korean-capable lexical retrieval (ADR-0058).
--
-- WHY. Korean attaches particles and endings to the word (레온은/레온을/레온의), so the `english` text-search
-- configuration indexes every eojeol as its own token and a query for 레온 misses 레온은. The audit also
-- found that no Korean row was ever stored as Korean: projects.output_language, manuscript_versions.language,
-- summaries.language and search_documents.language all kept their 'en' default, and entity tagging ignored
-- every two-syllable name (length >= 3), which covers most Korean given names.
--
-- DECISION. pg_trgm (PostgreSQL contrib, present in every PostgreSQL 16 distribution and the CI image) backs
-- Korean search: a trigram GIN index over Korean documents, queried with particle-stripped stems (the
-- application layer) and ranked by term hits and word similarity. English keeps its tsvector path.
--
-- ROLLBACK. Forward-only (data architecture §15). The index and trigger are derived-state helpers; the
-- backfills only correct the language of derived rows (search documents, summaries) and project metadata.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- A search document's language is its source's: the manuscript version it cites, else its project.
CREATE OR REPLACE FUNCTION canon.search_document_language() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.manuscript_version_id IS NOT NULL THEN
    SELECT CASE WHEN mv.language = 'ko' OR p.output_language = 'ko' THEN 'ko' ELSE 'en' END
      INTO NEW.language
      FROM manuscript_versions mv JOIN projects p ON p.id = mv.project_id
     WHERE mv.id = NEW.manuscript_version_id;
  ELSE
    SELECT p.output_language INTO NEW.language FROM projects p WHERE p.id = NEW.project_id;
  END IF;
  NEW.language := coalesce(NEW.language, 'en');
  RETURN NEW;
END $$;
CREATE TRIGGER search_document_language BEFORE INSERT OR UPDATE ON search_documents
  FOR EACH ROW EXECUTE FUNCTION canon.search_document_language();
-- Least privilege (migration 0014): canon functions execute for the application role only.
GRANT EXECUTE ON FUNCTION canon.search_document_language() TO yeonjae_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA canon FROM PUBLIC;

CREATE INDEX search_documents_text_trgm_idx ON search_documents USING GIN (text gin_trgm_ops)
  WHERE language = 'ko';

-- Two-syllable Hangul names (레온, 이안, 서하) are names; two Latin letters still are not.
CREATE OR REPLACE FUNCTION canon.entities_mentioned(p_project uuid, p_text text) RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(DISTINCT e.id ORDER BY e.id), '{}')
  FROM entities e
  WHERE e.project_id = p_project AND e.status = 'active'
    AND EXISTS (SELECT 1 FROM unnest(ARRAY[e.display_name] || e.short_forms || e.aliases) AS nm
                WHERE (length(nm) >= 3 OR nm ~ '^[가-힣]{2}$') AND position(nm IN p_text) > 0)
$$;

-- Projects whose pinned composed identity is Korean are Korean projects.
UPDATE projects p SET output_language = 'ko'
 WHERE p.output_language = 'en'
   AND EXISTS (SELECT 1 FROM identity_documents d
                WHERE d.project_id = p.id AND d.kind = 'narrative_identity'
                  AND d.payload->>'output_language' LIKE 'lang/ko@%');

UPDATE summaries s SET language = 'ko' FROM projects p
 WHERE p.id = s.project_id AND p.output_language = 'ko' AND s.language <> 'ko';

-- The trigger recomputes the language (and re-tags nothing else).
UPDATE search_documents d SET language = language FROM projects p
 WHERE p.id = d.project_id AND p.output_language = 'ko';
