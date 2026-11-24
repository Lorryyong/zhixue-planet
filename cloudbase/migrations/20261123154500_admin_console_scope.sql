-- v1.9.12 管理端 + 试卷/题目范围维度
-- 1) 内置管理员账号表（builtin 不可删除；口令已于 2026-11-24 轮换，见 20261124101000_rotate_admin_password.sql）
CREATE TABLE IF NOT EXISTS zx_admin_accounts (
  username      TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  builtin       BOOLEAN DEFAULT false,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 注：此处哈希对应初始口令，已于 2026-11-24 轮换失效（见 20261124101000_rotate_admin_password.sql），新环境初始化后必须紧接着应用轮换迁移。
INSERT INTO zx_admin_accounts (username, password_hash, builtin, note)
VALUES ('admin', '25f43b1486ad95a1398e3eeb3d83bc4010015fcc9bedb35b432e00298d5021f7', true, '系统内置管理员，不可删除')
ON CONFLICT (username) DO NOTHING;

-- 2) 试卷/题目新增范围字段：system=管理员维护、所有用户可见；user=用户自建、仅自己可见
ALTER TABLE zx_papers   ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'user';
ALTER TABLE zx_questions ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'user';
CREATE INDEX IF NOT EXISTS idx_papers_scope   ON zx_papers(scope);
CREATE INDEX IF NOT EXISTS idx_questions_scope ON zx_questions(scope);

-- 3) 存量公共题库（demo_student 名下，含种子题与管理员历史导入）标记为 system
UPDATE zx_papers   SET scope = 'system' WHERE student_id = 'demo_student';
UPDATE zx_questions SET scope = 'system' WHERE student_id = 'demo_student';
