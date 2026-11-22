-- 用户年级字段：设置一次后，每年9月自动升级（按学年差计算）。
-- grade_index  ：设置时年级序号 1-12（小一~高三）
-- grade_base_year：设置时所在学年（如 2026 = 2026年9月~2027年8月）
-- 幂等：可重复执行。2026-11-22

ALTER TABLE public.zx_users
  ADD COLUMN IF NOT EXISTS grade_index INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grade_base_year INTEGER DEFAULT 0;

COMMENT ON COLUMN public.zx_users.grade_index IS '设置时年级序号1-12(小一~高三)';
COMMENT ON COLUMN public.zx_users.grade_base_year IS '设置时学年，用于每年9月自动升级';
