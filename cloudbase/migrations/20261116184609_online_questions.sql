CREATE TABLE IF NOT EXISTS public.online_questions (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  type TEXT NOT NULL,
  q TEXT NOT NULL,
  options JSONB NOT NULL,
  answer INTEGER NOT NULL,
  explain TEXT,
  src TEXT DEFAULT 'net',
  source TEXT,
  context TEXT,
  source_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.online_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY online_questions_read ON public.online_questions FOR SELECT TO anon, authenticated USING (true);