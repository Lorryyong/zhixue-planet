-- 试卷元数据新增「教材类型」（人教版/部编版/…，取值与学习设置 SUBJECT_BOOKS 对应）
ALTER TABLE zx_questions ADD COLUMN IF NOT EXISTS textbook TEXT;
