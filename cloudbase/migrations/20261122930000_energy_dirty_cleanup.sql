-- 能量脏数据清理（v1.9.6）：
-- 老用户建档时曾使用默认 energy=1280/level=7，部分用户的清零标记(zx_cloud_energy_reset_v193)
-- 因清缓存丢失而未重跑，导致账本为空(energy_ledger='[]')却保留虚高能量(>=1280)。
-- 本迁移仅清理「账本为空 且 能量>=1280」的明确脏记录：能量/等级归零，保留徽章/连续天数/签到。
-- 正常用户（能量由答题累积、账本非空，或能量<1280）不受影响。
UPDATE public.zx_gamification
SET energy = 0,
    level = 1,
    energy_ledger = '[]'::jsonb,
    updated_at = now()
WHERE COALESCE(energy_ledger::text, '[]') IN ('[]', '"[]"')
  AND COALESCE(energy, 0) >= 1280;

COMMENT ON TABLE public.zx_gamification IS '养成数据（能量从答题起算，服务端权威；v1.9.6 已清理建档默认值残留脏数据）';
