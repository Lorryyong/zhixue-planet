-- 每日任务：每天每科各一条打卡任务（原为一天仅一条）
-- 唯一约束 (student_id, task_date) → (student_id, task_date, subject)
-- subject='综合' 表示混科组卷（默认，兼容历史数据）

-- 1) 确保 subject 列存在
ALTER TABLE public.zx_daily_tasks ADD COLUMN IF NOT EXISTS subject TEXT DEFAULT '综合';
UPDATE public.zx_daily_tasks SET subject = '综合' WHERE subject IS NULL OR subject = '';

-- 2) 删除旧的「学生+日期」唯一约束（兼容不同命名）
ALTER TABLE public.zx_daily_tasks DROP CONSTRAINT IF EXISTS zx_daily_tasks_student_id_task_date_key;
DO $$
DECLARE cname text;
BEGIN
  FOR cname IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.zx_daily_tasks'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%student_id%'
      AND pg_get_constraintdef(oid) LIKE '%task_date%'
      AND pg_get_constraintdef(oid) NOT LIKE '%subject%'
  LOOP
    EXECUTE 'ALTER TABLE public.zx_daily_tasks DROP CONSTRAINT ' || quote_ident(cname);
  END LOOP;
END $$;

-- 3) 新增「学生+日期+科目」唯一约束（不存在才加）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.zx_daily_tasks'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%student_id%'
      AND pg_get_constraintdef(oid) LIKE '%task_date%'
      AND pg_get_constraintdef(oid) LIKE '%subject%'
  ) THEN
    ALTER TABLE public.zx_daily_tasks
      ADD CONSTRAINT zx_daily_tasks_student_date_subject_key UNIQUE (student_id, task_date, subject);
  END IF;
END $$;

-- 4) 配套索引
CREATE INDEX IF NOT EXISTS idx_daily_student_date_subject
  ON public.zx_daily_tasks(student_id, task_date, subject);
