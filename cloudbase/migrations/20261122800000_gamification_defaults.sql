-- 养成默认值对齐（v1.9.4）：
-- 原 20261122000001 建表默认 energy=1280/level=7，与 login 建档及前端（0/1）不一致。
-- 若任何路径绕过 login 直接 insert 不带能量字段，会得到虚高的 1280。此迁移把默认值对齐为 0/1。
-- 只改 DEFAULT，不影响任何存量用户数据（存量能量以库内实际值为准）。
ALTER TABLE public.zx_gamification
  ALTER COLUMN energy SET DEFAULT 0,
  ALTER COLUMN level  SET DEFAULT 1;

COMMENT ON COLUMN public.zx_gamification.energy IS '当前能量值（默认 0，从答题起累计；服务端权威计算）';
