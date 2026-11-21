-- 题库批量导入：管理员白名单表
-- 鉴权优先级：云函数环境变量 ADMIN_OPENIDS（逗号分隔）∪ 本表
-- 两处都为空时，首个调用 importQuestions(whoami) 的人自动自举为管理员
CREATE TABLE IF NOT EXISTS zx_admins (
  openid     TEXT PRIMARY KEY,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
