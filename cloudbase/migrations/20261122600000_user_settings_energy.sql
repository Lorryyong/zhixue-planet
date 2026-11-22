-- 我的栏目功能扩展（2026-11-22）
-- 1) zx_users.settings：统一存放 家长绑定/周报订阅、学科与教材版本、补签卡、隐私设置
--    JSONB 结构：
--    {
--      parent:   {bound, guardian, relation, phone, weekly, weeklyDay, boundAt},
--      subjects: [{name, textbook, enabled}],
--      makeup:   {cards, used:[{date, at}]},
--      privacy:  {minorMode, allowAnalytics, allowPersonalization, updatedAt}
--    }
-- 2) zx_gamification.energy_ledger：能量明细账本 [{id, delta, reason, at}]
-- 全部幂等，可重复执行。

ALTER TABLE public.zx_users
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.zx_users.settings IS '用户设置：家长绑定/周报、学科教材、补签卡、隐私设置';

ALTER TABLE public.zx_gamification
  ADD COLUMN IF NOT EXISTS energy_ledger JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.zx_gamification.energy_ledger IS '能量明细账本：{id,delta,reason,at}，最多保留200条';
