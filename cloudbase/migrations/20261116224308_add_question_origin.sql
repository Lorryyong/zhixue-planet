ALTER TABLE public.question_bank ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT '知识点生成';
UPDATE public.question_bank SET origin = CASE WHEN src = 'verbatim' THEN '中考真题' ELSE '知识点生成' END;