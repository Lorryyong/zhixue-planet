-- 题目启用开关（enabled）：按「来源(original) + 学科(subject)」维度控制哪些试卷参与每日组卷
-- 默认 true 保证存量题目行为不变；用户取消勾选后该来源+学科下的题 enabled=false，不再进入组卷池
-- 幂等：可重复执行。2026-11-22
ALTER TABLE public.zx_questions
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.zx_questions.enabled IS '是否参与每日打卡组卷（来源+学科维度批量控制）';

CREATE INDEX IF NOT EXISTS idx_questions_enabled ON public.zx_questions(student_id, enabled);
