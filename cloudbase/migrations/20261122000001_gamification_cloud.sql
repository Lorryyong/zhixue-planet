-- 养成数据上云：能量 / 等级 / 连续打卡 / 徽章 按用户持久化
-- 之前这些数据只在小程序本地 Storage，换设备即丢，且与云端掌握度割裂。
-- 能量等计算在云函数内完成（服务端权威，前端不可伪造），前端仅用返回的快照刷新展示。

CREATE TABLE IF NOT EXISTS zx_gamification (
  student_id        text PRIMARY KEY,
  energy            integer NOT NULL DEFAULT 1280,
  level             integer NOT NULL DEFAULT 7,
  streak            integer NOT NULL DEFAULT 0,
  checkin_dates     jsonb   NOT NULL DEFAULT '[]'::jsonb,
  badges            jsonb   NOT NULL DEFAULT '["b1","b2","b3"]'::jsonb,
  last_checkin_date date,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gamification_updated ON zx_gamification (updated_at);

COMMENT ON TABLE zx_gamification IS '用户养成数据（能量/等级/连续打卡/徽章），与 openid 一一对应';
