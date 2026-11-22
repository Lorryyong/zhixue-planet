-- 行为埋点表（v1.9.4）：支撑激活率/闭环完成率/留存/人均答题量/识别成功率等指标。
-- 只存事件名 + 白名单标量 props，不存题干/答案原文；按 openid 隔离。
CREATE TABLE IF NOT EXISTS public.zx_events (
  id          TEXT PRIMARY KEY,
  student_id  TEXT,
  event       TEXT NOT NULL,
  props       JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_ts   TEXT,
  server_ts   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_student ON public.zx_events (student_id);
CREATE INDEX IF NOT EXISTS idx_events_name ON public.zx_events (event);
CREATE INDEX IF NOT EXISTS idx_events_server ON public.zx_events (server_ts);

COMMENT ON TABLE public.zx_events IS '行为埋点（最小化采集，尊重隐私设置）；仅用于产品指标聚合，不含原文内容';
