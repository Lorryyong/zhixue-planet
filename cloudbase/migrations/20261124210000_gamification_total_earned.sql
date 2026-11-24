-- 排行榜口径：累计获得能量（只增不减，消费不扣）。
-- 此前系统只有余额 energy 与流水 energy_ledger（仅保留最近 200 条），无法长期统计累计获得，
-- 故新增 total_earned 列由 submitAnswer 在每次发放时累加；存量用户按现有账本正向流水回填（账本未满 200 条时为精确值）。
ALTER TABLE zx_gamification ADD COLUMN IF NOT EXISTS total_earned INTEGER NOT NULL DEFAULT 0;
