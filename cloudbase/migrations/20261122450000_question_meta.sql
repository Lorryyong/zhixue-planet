-- 题目新增三个维度：出题年份(year) / 年级(grade) / 省市(region)
-- 用户表新增 source_grade_init 记录已按学段初始化过，避免覆盖手动调整、并在升学时自动更新
ALTER TABLE public.zx_questions
  ADD COLUMN IF NOT EXISTS year INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grade TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS region TEXT DEFAULT '';

ALTER TABLE public.zx_users
  ADD COLUMN IF NOT EXISTS source_grade_init TEXT DEFAULT '';

-- 常用筛选索引
CREATE INDEX IF NOT EXISTS idx_q_original ON public.zx_questions (student_id, original);
CREATE INDEX IF NOT EXISTS idx_q_region ON public.zx_questions (student_id, region);
CREATE INDEX IF NOT EXISTS idx_q_grade ON public.zx_questions (student_id, grade);
