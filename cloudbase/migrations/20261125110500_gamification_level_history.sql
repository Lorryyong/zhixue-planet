-- 2.0 宇宙探索：升级历史（JSON 数组文本，元素 {level, name, at, totalEarned, note}）
ALTER TABLE zx_gamification ADD COLUMN IF NOT EXISTS level_history TEXT DEFAULT '[]';
