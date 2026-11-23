-- 科目农场（v1.9.8）：每门科目一个农场，每个农场绑定一种小动物。
-- 用户用能量购买动物（animal_owned）、购买食物喂养提升成长值（growth）、
-- 购买装饰装扮农场（decor_ids）。能量收支由 farm 云函数权威扣减并写入 zx_gamification.energy_ledger。

CREATE TABLE IF NOT EXISTS zx_farms (
  id            text PRIMARY KEY,
  student_id    text NOT NULL,
  subject       text NOT NULL,
  animal_owned  boolean NOT NULL DEFAULT false,
  growth        integer NOT NULL DEFAULT 0,
  feed_count    integer NOT NULL DEFAULT 0,
  decor_ids     jsonb   NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, subject)
);

CREATE INDEX IF NOT EXISTS idx_farms_student ON zx_farms (student_id);

COMMENT ON TABLE zx_farms IS '科目农场：每科一个农场，记录小动物拥有/成长/装饰状态';
COMMENT ON COLUMN zx_farms.growth IS '小动物成长值，由喂食累加，对应 farmData.STAGES 阶段';
COMMENT ON COLUMN zx_farms.decor_ids IS '已购买装饰 id 数组（jsonb）';
