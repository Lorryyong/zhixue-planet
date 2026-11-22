-- 试卷来源字段（original）：标识试卷/题目的来源（如"2024北京中考真题""人教版九上"）
-- 幂等：可重复执行。2026-11-22

-- 1) 题目级来源：每一道题可标注自己的出处
ALTER TABLE public.zx_questions
  ADD COLUMN IF NOT EXISTS original TEXT DEFAULT '';

-- 2) 试卷级来源：整份试卷的来源（导入时取首行 original 或文件名）
ALTER TABLE public.zx_papers
  ADD COLUMN IF NOT EXISTS original TEXT DEFAULT '';

COMMENT ON COLUMN public.zx_questions.original IS '试卷来源（题目级），如 2024北京中考真题';
COMMENT ON COLUMN public.zx_papers.original IS '试卷来源（试卷级），如 2024北京中考真题';

-- 3) Excel 容错导入：标记信息不全（缺选项/答案）待人工校对补全
ALTER TABLE public.zx_questions
  ADD COLUMN IF NOT EXISTS need_fix BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS issues JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.zx_questions.need_fix IS 'Excel 导入的题目是否信息不全、需人工补全';
COMMENT ON COLUMN public.zx_questions.issues IS '信息不全的具体问题列表';
