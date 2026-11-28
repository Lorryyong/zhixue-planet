CREATE TABLE IF NOT EXISTS zx_knowledge_dict (
  code          TEXT PRIMARY KEY,
  subject       TEXT NOT NULL,
  block         TEXT NOT NULL,
  q_types       TEXT,
  name          TEXT NOT NULL,
  ability       TEXT,
  textbook_unit TEXT,
  exam_style    TEXT,
  error_signs   TEXT,
  note          TEXT,
  version       TEXT NOT NULL DEFAULT 'v1.0',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_no       INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_zkd_subject_block ON zx_knowledge_dict (subject, block);
