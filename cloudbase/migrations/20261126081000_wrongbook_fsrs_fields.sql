-- P0-2 简化 FSRS：错题记忆稳定性（天）与难度（1-10），并按现有复习阶段回填稳定性初值
ALTER TABLE zx_wrongbook ADD COLUMN IF NOT EXISTS stability REAL;
ALTER TABLE zx_wrongbook ADD COLUMN IF NOT EXISTS difficulty REAL DEFAULT 5;
UPDATE zx_wrongbook SET stability = CASE WHEN review_stage IS NULL OR review_stage <= 0 THEN 1 WHEN review_stage = 1 THEN 3 WHEN review_stage = 2 THEN 7 WHEN review_stage = 3 THEN 15 ELSE 30 END WHERE stability IS NULL;
UPDATE zx_wrongbook SET difficulty = 5 WHERE difficulty IS NULL;
