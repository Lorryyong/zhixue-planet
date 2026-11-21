-- 每日任务支持分科目：一天仍只打卡一次，但任务记录所练科目
-- subject='综合' 表示混科组卷（默认，兼容老数据）
ALTER TABLE zx_daily_tasks ADD COLUMN IF NOT EXISTS subject TEXT DEFAULT '综合';
UPDATE zx_daily_tasks SET subject = '综合' WHERE subject IS NULL;
