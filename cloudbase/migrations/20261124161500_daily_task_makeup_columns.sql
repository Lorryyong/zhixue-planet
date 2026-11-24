-- 2026-11-24 修复：补齐 zx_daily_tasks 缺失的补签标记列
-- 背景：2026-11-23 22:52 部署的 composeTask/submitAnswer 新版已按补签功能
-- 读写 is_makeup / makeup_date 两列，但建表迁移从未给 zx_daily_tasks 加过这两列，
-- 导致 composeTask 每次 insert/update 都在 PostgREST 层失败、错误又被忽略，
-- 任务只存在于返回值中（幻影任务），submitAnswer 随即报 -403「打卡任务不存在」，
-- 前端整场降级本地模式：打卡不落库、错题不进错题本、首页可重复打卡。
ALTER TABLE public.zx_daily_tasks ADD COLUMN IF NOT EXISTS is_makeup BOOLEAN DEFAULT false;
ALTER TABLE public.zx_daily_tasks ADD COLUMN IF NOT EXISTS makeup_date TEXT DEFAULT '';
