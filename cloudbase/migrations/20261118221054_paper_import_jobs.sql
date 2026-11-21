-- 试卷识别异步作业：浏览器用 no-cors POST 触发云函数，云函数把结果写这里，浏览器再通过 RPC 轮询
CREATE TABLE IF NOT EXISTS public.paper_import_jobs (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending',
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 hour')
);
CREATE INDEX IF NOT EXISTS paper_import_jobs_exp_idx ON public.paper_import_jobs (expires_at);
ALTER TABLE public.paper_import_jobs ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.admin_get_job(p_token text, p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_row paper_import_jobs;
BEGIN
  IF NOT admin_check_token(p_token) THEN RETURN jsonb_build_object('ok', false, 'error', '登录已失效'); END IF;
  SELECT * INTO v_row FROM paper_import_jobs WHERE id = p_id AND expires_at > now();
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('ok', true, 'status', 'missing'); END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_row.status, 'result', v_row.result, 'error', v_row.error);
END $$;
DO $$
DECLARE o text;
BEGIN
  SELECT pg_get_userbyid(relowner) INTO o FROM pg_class WHERE relname = 'question_bank' AND relnamespace = 'public'::regnamespace;
  IF o IS NOT NULL THEN
    BEGIN EXECUTE format('ALTER FUNCTION public.admin_get_job(text,text) OWNER TO %I', o); EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.admin_get_job(text,text) TO anon, authenticated;