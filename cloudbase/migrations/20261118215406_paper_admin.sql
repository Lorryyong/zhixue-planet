-- 试题管理：试卷表、试卷-题目关联、管理员会话与安全函数
-- 说明：写操作全部经 SECURITY DEFINER 函数完成，前端只持有短期 token。

ALTER TABLE public.question_bank ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.question_bank ADD COLUMN IF NOT EXISTS paper_id text;
CREATE TABLE IF NOT EXISTS public.exam_papers (
  id text PRIMARY KEY,
  title text NOT NULL,
  subject text NOT NULL,
  stage text NOT NULL,
  source text NOT NULL DEFAULT '',
  recorder text NOT NULL DEFAULT '',
  recorded_at date NOT NULL DEFAULT CURRENT_DATE,
  enabled boolean NOT NULL DEFAULT true,
  question_count integer NOT NULL DEFAULT 0,
  file_name text NOT NULL DEFAULT '',
  raw_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.exam_paper_questions (
  paper_id text NOT NULL REFERENCES public.exam_papers(id) ON DELETE CASCADE,
  question_id text NOT NULL REFERENCES public.question_bank(id) ON DELETE CASCADE,
  ord integer NOT NULL DEFAULT 0,
  PRIMARY KEY (paper_id, question_id)
);
CREATE INDEX IF NOT EXISTS exam_paper_questions_paper_idx ON public.exam_paper_questions (paper_id);
CREATE INDEX IF NOT EXISTS question_bank_paper_idx ON public.question_bank (paper_id);
CREATE TABLE IF NOT EXISTS public.admin_config (
  id integer PRIMARY KEY CHECK (id = 1),
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.admin_sessions (
  token text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_exp_idx ON public.admin_sessions (expires_at);
-- 初始管理员密码：FarmAdmin@2026（登录后可在「试题管理」里修改）
INSERT INTO public.admin_config (id, password_salt, password_hash)
SELECT 1, s.salt, encode(sha256((s.salt || 'FarmAdmin@2026')::bytea), 'hex')
FROM (SELECT substr(md5(random()::text || clock_timestamp()::text), 1, 32) AS salt) s
ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.exam_papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_paper_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_sessions ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.admin_login(p_password text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_salt text;
  v_hash text;
  v_token text;
  v_exp timestamptz;
BEGIN
  SELECT password_salt, password_hash INTO v_salt, v_hash FROM admin_config WHERE id = 1;
  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', '管理员账号未初始化');
  END IF;
  IF encode(sha256((v_salt || COALESCE(p_password, ''))::bytea), 'hex') <> v_hash THEN
    RETURN jsonb_build_object('ok', false, 'error', '管理员密码不正确');
  END IF;
  DELETE FROM admin_sessions WHERE expires_at < now();
  v_token := md5(random()::text || clock_timestamp()::text) || substr(md5(random()::text), 1, 16);
  v_exp := now() + interval '12 hours';
  INSERT INTO admin_sessions (token, expires_at) VALUES (v_token, v_exp);
  RETURN jsonb_build_object('ok', true, 'token', v_token, 'expiresAt', v_exp);
END $$;
CREATE OR REPLACE FUNCTION public.admin_check_token(p_token text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM admin_sessions WHERE token = p_token AND expires_at > now());
$$;
CREATE OR REPLACE FUNCTION public.admin_change_password(p_token text, p_old text, p_new text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_salt text;
  v_hash text;
  v_new_salt text;
BEGIN
  IF NOT admin_check_token(p_token) THEN RETURN jsonb_build_object('ok', false, 'error', '登录已失效'); END IF;
  IF length(COALESCE(p_new, '')) < 8 THEN RETURN jsonb_build_object('ok', false, 'error', '新密码至少 8 位'); END IF;
  SELECT password_salt, password_hash INTO v_salt, v_hash FROM admin_config WHERE id = 1;
  IF encode(sha256((v_salt || COALESCE(p_old, ''))::bytea), 'hex') <> v_hash THEN
    RETURN jsonb_build_object('ok', false, 'error', '原密码不正确');
  END IF;
  v_new_salt := substr(md5(random()::text || clock_timestamp()::text), 1, 32);
  UPDATE admin_config
     SET password_salt = v_new_salt,
         password_hash = encode(sha256((v_new_salt || p_new)::bytea), 'hex'),
         updated_at = now()
   WHERE id = 1;
  DELETE FROM admin_sessions;
  RETURN jsonb_build_object('ok', true);
END $$;
CREATE OR REPLACE FUNCTION public.admin_list_papers(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT admin_check_token(p_token) THEN RETURN jsonb_build_object('ok', false, 'error', '登录已失效'); END IF;
  RETURN jsonb_build_object('ok', true, 'papers', COALESCE((
    SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC)
    FROM (
      SELECT p.*, (SELECT count(*) FROM exam_paper_questions l WHERE l.paper_id = p.id)::int AS linked_count
      FROM exam_papers p
    ) x
  ), '[]'::jsonb));
END $$;
CREATE OR REPLACE FUNCTION public.admin_get_paper(p_token text, p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_paper jsonb;
  v_qs jsonb;
BEGIN
  IF NOT admin_check_token(p_token) THEN RETURN jsonb_build_object('ok', false, 'error', '登录已失效'); END IF;
  SELECT to_jsonb(p) INTO v_paper FROM exam_papers p WHERE p.id = p_id;
  IF v_paper IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', '试卷不存在'); END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(qb) || jsonb_build_object('ord', l.ord) ORDER BY l.ord), '[]'::jsonb)
    INTO v_qs
    FROM exam_paper_questions l
    JOIN question_bank qb ON qb.id = l.question_id
   WHERE l.paper_id = p_id;
  RETURN jsonb_build_object('ok', true, 'paper', v_paper, 'questions', v_qs);
END $$;
CREATE OR REPLACE FUNCTION public.admin_toggle_paper(p_token text, p_id text, p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT admin_check_token(p_token) THEN RETURN jsonb_build_object('ok', false, 'error', '登录已失效'); END IF;
  UPDATE exam_papers SET enabled = p_enabled WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '试卷不存在'); END IF;
  UPDATE question_bank SET enabled = p_enabled WHERE paper_id = p_id;
  RETURN jsonb_build_object('ok', true, 'enabled', p_enabled);
END $$;
CREATE OR REPLACE FUNCTION public.admin_import_paper(p_token text, p_meta jsonb, p_questions jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_paper_id text;
  v_title text := trim(COALESCE(p_meta->>'title', ''));
  v_subject text := COALESCE(p_meta->>'subject', '');
  v_stage text := COALESCE(p_meta->>'stage', '');
  v_grade text;
  v_count int := 0;
  v_ord record;
BEGIN
  IF NOT admin_check_token(p_token) THEN RETURN jsonb_build_object('ok', false, 'error', '登录已失效'); END IF;
  IF v_title = '' THEN RETURN jsonb_build_object('ok', false, 'error', '缺少试卷标题'); END IF;
  IF v_subject NOT IN ('law','history','geo','bio') THEN RETURN jsonb_build_object('ok', false, 'error', '学科不合法'); END IF;
  IF v_stage NOT IN ('七年级上册','七年级下册','八年级上册','八年级下册','九年级上册','九年级下册') THEN
    RETURN jsonb_build_object('ok', false, 'error', '年级册不合法');
  END IF;
  IF jsonb_typeof(p_questions) <> 'array' OR jsonb_array_length(p_questions) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', '没有可入库的题目');
  END IF;

  v_grade := CASE left(v_stage, 3) WHEN '七年级' THEN '7' WHEN '八年级' THEN '8' ELSE '9' END;
  v_paper_id := COALESCE(NULLIF(p_meta->>'id',''),
    'paper_' || to_char(now(), 'YYYYMMDDHH24MISS') || '_' || substr(md5(random()::text), 1, 6));

  INSERT INTO exam_papers (id, title, subject, stage, source, recorder, recorded_at, enabled, file_name, raw_text)
  VALUES (
    v_paper_id, v_title, v_subject, v_stage,
    COALESCE(p_meta->>'source',''), COALESCE(p_meta->>'recorder',''),
    COALESCE(NULLIF(p_meta->>'recordedAt','')::date, CURRENT_DATE),
    COALESCE((p_meta->>'enabled')::boolean, true),
    COALESCE(p_meta->>'fileName',''), left(COALESCE(p_meta->>'rawText',''), 200000)
  );

  INSERT INTO question_bank
    (id, subject, grade, stage, difficulty, knowledge, type, q, options, answer, explain,
     src, origin, source, context, enabled, paper_id)
  SELECT
    COALESCE(NULLIF(e.q->>'id',''), v_paper_id || '_' || lpad(e.ord::text, 3, '0')),
    v_subject,
    v_grade,
    v_stage,
    LEAST(3, GREATEST(1, COALESCE((e.q->>'difficulty')::int, 2)))::smallint,
    COALESCE(NULLIF(e.q->>'knowledge',''), '试卷导入'),
    COALESCE(NULLIF(e.q->>'type',''), 'single'),
    COALESCE(e.q->>'q',''),
    CASE WHEN e.q ? 'options' THEN e.q->'options' ELSE NULL END,
    CASE WHEN e.q ? 'answer' THEN e.q->'answer' ELSE NULL END,
    COALESCE(e.q->>'explain',''),
    'paper', '试卷导入', v_title, '',
    true, v_paper_id
  FROM jsonb_array_elements(p_questions) WITH ORDINALITY AS e(q, ord)
  ON CONFLICT (id) DO UPDATE SET
    difficulty = EXCLUDED.difficulty,
    knowledge = EXCLUDED.knowledge,
    type = EXCLUDED.type,
    q = EXCLUDED.q,
    options = EXCLUDED.options,
    answer = EXCLUDED.answer,
    explain = EXCLUDED.explain,
    source = EXCLUDED.source,
    stage = EXCLUDED.stage,
    grade = EXCLUDED.grade,
    paper_id = EXCLUDED.paper_id,
    enabled = true;

  INSERT INTO exam_paper_questions (paper_id, question_id, ord)
  SELECT v_paper_id,
         COALESCE(NULLIF(e.q->>'id',''), v_paper_id || '_' || lpad(e.ord::text, 3, '0')),
         e.ord
  FROM jsonb_array_elements(p_questions) WITH ORDINALITY AS e(q, ord)
  ON CONFLICT DO NOTHING;

  SELECT count(*) INTO v_count FROM exam_paper_questions WHERE paper_id = v_paper_id;
  UPDATE exam_papers SET question_count = v_count WHERE id = v_paper_id;

  RETURN jsonb_build_object('ok', true, 'paperId', v_paper_id, 'count', v_count);
END $$;
CREATE OR REPLACE FUNCTION public.admin_update_question(p_token text, p_id text, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_row jsonb;
BEGIN
  IF NOT admin_check_token(p_token) THEN RETURN jsonb_build_object('ok', false, 'error', '登录已失效'); END IF;
  UPDATE question_bank SET
    q = COALESCE(p_patch->>'q', q),
    options = CASE WHEN p_patch ? 'options' THEN p_patch->'options' ELSE options END,
    answer = CASE WHEN p_patch ? 'answer' THEN p_patch->'answer' ELSE answer END,
    explain = COALESCE(p_patch->>'explain', explain),
    knowledge = COALESCE(NULLIF(p_patch->>'knowledge',''), knowledge),
    difficulty = LEAST(3, GREATEST(1, COALESCE((p_patch->>'difficulty')::int, difficulty)))::smallint,
    type = COALESCE(NULLIF(p_patch->>'type',''), type)
  WHERE id = p_id
  RETURNING to_jsonb(question_bank) INTO v_row;
  IF v_row IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', '题目不存在'); END IF;
  RETURN jsonb_build_object('ok', true, 'question', v_row);
END $$;
CREATE OR REPLACE FUNCTION public.admin_delete_question(p_token text, p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT admin_check_token(p_token) THEN RETURN jsonb_build_object('ok', false, 'error', '登录已失效'); END IF;
  DELETE FROM question_bank WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '题目不存在'); END IF;
  UPDATE exam_papers p SET question_count = (SELECT count(*) FROM exam_paper_questions l WHERE l.paper_id = p.id);
  RETURN jsonb_build_object('ok', true);
END $$;
-- 让安全函数归属表所有者，确保能写入启用了 RLS 的题库表
DO $$
DECLARE o text;
BEGIN
  SELECT pg_get_userbyid(relowner) INTO o FROM pg_class WHERE relname = 'question_bank' AND relnamespace = 'public'::regnamespace;
  IF o IS NOT NULL THEN
    BEGIN EXECUTE format('ALTER FUNCTION public.admin_login(text) OWNER TO %I', o); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('ALTER FUNCTION public.admin_check_token(text) OWNER TO %I', o); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('ALTER FUNCTION public.admin_change_password(text,text,text) OWNER TO %I', o); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('ALTER FUNCTION public.admin_list_papers(text) OWNER TO %I', o); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('ALTER FUNCTION public.admin_get_paper(text,text) OWNER TO %I', o); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('ALTER FUNCTION public.admin_toggle_paper(text,text,boolean) OWNER TO %I', o); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('ALTER FUNCTION public.admin_import_paper(text,jsonb,jsonb) OWNER TO %I', o); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('ALTER FUNCTION public.admin_update_question(text,text,jsonb) OWNER TO %I', o); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('ALTER FUNCTION public.admin_delete_question(text,text) OWNER TO %I', o); EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.admin_login(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_check_token(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_change_password(text,text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_papers(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_paper(text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_toggle_paper(text,text,boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_import_paper(text,jsonb,jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_question(text,text,jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_question(text,text) TO anon, authenticated;